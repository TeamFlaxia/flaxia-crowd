pub mod config;
pub mod executor;
pub mod image_process;
pub mod swarm;
mod task_session;

use config::{Config, Endpoints};
use futures_util::SinkExt;
use serde::Deserialize;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpStream,
    time::{Instant, sleep, timeout},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;

// Generated from packages/sdk/src/handshake.ts by build.rs.
include!(concat!(env!("OUT_DIR"), "/protocol.rs"));

const IO_TIMEOUT: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REGISTER_BYTES: usize = 16 * 1024;
const MAX_SIGNAL_BYTES: usize = 64 * 1024;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

// Never derive Debug for this type: tokens must not appear in logs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    token: String,
    node_id: String,
    expires_at: u64,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn backoff_ceiling(attempt: u32) -> u64 {
    (1_000_u64 << attempt.min(5)).min(30_000)
}

async fn register(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    site_id: &str,
    runner: Option<&executor::Runner>,
    swarm: Option<&swarm::SwarmRunner>,
) -> Result<Registration, &'static str> {
    let mut body = json!({ "siteId": site_id, "capabilities": [], "fileSources": false });
    if let Some(runner) = runner {
        body["capabilities"] = json!(["image-process"]);
        body["deviceMemory"] = json!(runner.device_memory_gib);
    }
    if let Some(swarm) = swarm {
        let mut capabilities = if runner.is_some() {
            vec!["image-process"]
        } else {
            vec![]
        };
        capabilities.push("swarm-inference");
        body["capabilities"] = json!(capabilities);
        body["swarm"] = swarm.capabilities.clone();
        body["deviceMemory"] = json!(swarm.device_memory_gib);
    }
    let mut response = client
        .post(endpoints.register.clone())
        .json(&body)
        .send()
        .await
        .map_err(|_| "registration transport failed")?;
    if !response.status().is_success() {
        return Err("registration rejected");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "registration body failed")?
    {
        if body.len() + chunk.len() > MAX_REGISTER_BYTES {
            return Err("registration response too large");
        }
        body.extend_from_slice(&chunk);
    }
    let registration: Registration =
        serde_json::from_slice(&body).map_err(|_| "invalid registration response")?;
    let now = unix_ms();
    if registration.node_id.is_empty()
        || registration.node_id.len() > 128
        || registration.token.is_empty()
        || registration.token.len() > MAX_BEARER_TOKEN_CHARS
        || !registration
            .token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || registration.expires_at <= now
        || registration.expires_at - now > 24 * 60 * 60 * 1000
    {
        return Err("invalid registration credentials");
    }
    Ok(registration)
}

async fn connect(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    site_id: &str,
    runner: Option<&executor::Runner>,
    swarm: Option<&swarm::SwarmRunner>,
) -> Result<(Socket, Instant), &'static str> {
    let registration = register(client, endpoints, site_id, runner, swarm).await?;
    let expires =
        Instant::now() + Duration::from_millis(registration.expires_at.saturating_sub(unix_ms()));
    let mut request = endpoints
        .signal
        .as_str()
        .into_client_request()
        .map_err(|_| "invalid signal URL")?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!(
            "{NODE_SIGNAL_PROTOCOL}, {BEARER_SUBPROTOCOL_PREFIX}{}",
            registration.token
        )
        .parse()
        .map_err(|_| "invalid signal credentials")?,
    );
    let socket_config = WebSocketConfig::default()
        .max_message_size(Some(if runner.is_some() || swarm.is_some() {
            image_process::MAX_TASK_BYTES.max(swarm::FRAME_LIMIT)
        } else {
            MAX_SIGNAL_BYTES
        }))
        .max_frame_size(Some(if runner.is_some() || swarm.is_some() {
            image_process::MAX_TASK_BYTES.max(swarm::FRAME_LIMIT)
        } else {
            MAX_SIGNAL_BYTES
        }));
    let (socket, response) = timeout(
        IO_TIMEOUT,
        connect_async_with_config(request, Some(socket_config), false),
    )
    .await
    .map_err(|_| "signal handshake timed out")?
    .map_err(|_| "signal handshake failed")?;
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|v| v.to_str().ok())
        != Some(NODE_SIGNAL_PROTOCOL)
    {
        return Err("server did not negotiate node protocol");
    }
    // Don't log server-supplied fields or errors: these can contain credentials.
    tracing::info!(
        image_process = runner.is_some(),
        swarm = swarm.is_some(),
        "node connected"
    );
    Ok((socket, expires))
}

async fn send(socket: &mut Socket, message: Message) -> Result<(), &'static str> {
    timeout(IO_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| "signal write timed out")?
        .map_err(|_| "signal write failed")
}

fn pong() -> Message {
    // Unknown CPU usage stays unknown; don't claim idle load without a sample.
    Message::Text(
        json!({ "type": "pong", "cpuLoad": null })
            .to_string()
            .into(),
    )
}

/// Register and maintain a node until cancellation. Execution is opt-in.
pub async fn run(config: Config, stop: CancellationToken) -> Result<(), &'static str> {
    config.endpoints()?;
    let executable = if config.execution.image_process {
        Some(
            std::env::current_exe()
                // Minimal Linux containers may not mount /proc/self/exe. Only an
                // absolute invocation path can be used as a fallback in that case.
                .or_else(|_| {
                    std::env::args_os()
                        .next()
                        .filter(|arg| PathBuf::from(arg).is_absolute())
                        .ok_or_else(|| std::io::Error::other("absolute executable path required"))
                        .and_then(std::fs::canonicalize)
                })
                .map_err(|_| "cannot locate native executor binary")?,
        )
    } else {
        None
    };
    run_with_executable(config, stop, executable).await
}

/// Library embedders must supply the trusted flaxia-node-native executable
/// when enabling image processing; it is launched with the internal child CLI.
pub async fn run_with_executable(
    config: Config,
    stop: CancellationToken,
    executable: Option<PathBuf>,
) -> Result<(), &'static str> {
    let endpoints = config.endpoints()?;
    if stop.is_cancelled() {
        return Ok(());
    }
    let runner = if config.execution.image_process {
        let path = executable.ok_or("native executor path required")?;
        let prepared = tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(()),
            prepared = executor::Runner::prepare(path, config.execution.clone()) => prepared?,
        };
        Some(Arc::new(prepared))
    } else {
        None
    };
    let swarm_runner = if config.execution.swarm.enabled {
        let prepared = tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(()),
            prepared = swarm::SwarmRunner::prepare(config.execution.swarm.clone(), config.execution.max_timeout_ms) => prepared?,
        };
        Some(Arc::new(prepared))
    } else {
        None
    };
    let client = reqwest::Client::builder()
        .timeout(IO_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "cannot create HTTP client")?;
    let mut attempt = 0_u32;
    loop {
        let started = Instant::now();
        let connection = tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            connection = connect(&client, &endpoints, &config.site_id, runner.as_deref(), swarm_runner.as_deref()) => connection,
        };
        let result = match connection {
            Ok((socket, expires)) => {
                task_session::session(socket, expires, &stop, runner.clone(), swarm_runner.clone())
                    .await
            }
            Err(error) => Err(error),
        };
        if stop.is_cancelled() {
            break;
        }
        if started.elapsed() >= HEARTBEAT_TIMEOUT {
            attempt = 0;
        }
        let ceiling = backoff_ceiling(attempt);
        let delay = Duration::from_millis(fastrand::u64(ceiling / 2..=ceiling));
        attempt = attempt.saturating_add(1);
        tracing::warn!(
            reason = result.err().unwrap_or("signal ended"),
            retry_ms = delay.as_millis() as u64,
            "node disconnected"
        );
        tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            _ = sleep(delay) => {},
        }
    }
    tracing::info!("node stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn reconnect_delay_is_bounded_even_after_many_failures() {
        assert_eq!(
            (0..7).map(backoff_ceiling).collect::<Vec<_>>(),
            vec![1000, 2000, 4000, 8000, 16000, 30000, 30000]
        );
        assert_eq!(backoff_ceiling(u32::MAX), 30_000);
    }

    #[tokio::test]
    async fn cancellation_before_start_does_not_contact_server() {
        let stop = CancellationToken::new();
        stop.cancel();
        run(
            Config {
                orchestrator_url: "http://127.0.0.1:1".into(),
                site_id: "dev".into(),
                participate: true,
                execution: Default::default(),
            },
            stop,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn missing_json_heartbeat_expires_even_if_peer_is_still_connected() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let accepting = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let mut peer = accepting.await.unwrap();
        let stop = CancellationToken::new();
        let task = tokio::spawn(async move {
            task_session::session(
                socket,
                Instant::now() + Duration::from_secs(3600),
                &stop,
                None,
                None,
            )
            .await
        });
        assert_eq!(peer.next().await.unwrap().unwrap(), pong());
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(40)).await;
        peer.send(Message::Text(r#"{"type":"ping"}"#.into()))
            .await
            .unwrap();
        assert_eq!(peer.next().await.unwrap().unwrap(), pong());
        tokio::time::advance(Duration::from_secs(40)).await;
        tokio::task::yield_now().await;
        assert!(
            !task.is_finished(),
            "ping must reset the heartbeat deadline"
        );
        tokio::time::advance(Duration::from_secs(21)).await;
        assert_eq!(task.await.unwrap(), Err("server heartbeat timed out"));
    }
}
