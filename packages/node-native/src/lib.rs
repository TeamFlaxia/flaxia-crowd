pub mod config;

use config::{Config, Endpoints};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::{
    net::TcpStream,
    time::{Instant, sleep, sleep_until, timeout},
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
) -> Result<Registration, &'static str> {
    let mut response = client
        .post(endpoints.register.clone())
        .json(&json!({ "siteId": site_id, "capabilities": [], "fileSources": false }))
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
) -> Result<(Socket, Instant), &'static str> {
    let registration = register(client, endpoints, site_id).await?;
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
        .max_message_size(Some(MAX_SIGNAL_BYTES))
        .max_frame_size(Some(MAX_SIGNAL_BYTES));
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
    tracing::info!("node connected (capabilities empty; task execution disabled)");
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

async fn session(
    mut socket: Socket,
    expires: Instant,
    stop: &CancellationToken,
) -> Result<(), &'static str> {
    // Enclose all session I/O so cancellation can also interrupt a blocked send.
    let result = tokio::select! {
        biased;
        _ = stop.cancelled() => Ok(()),
        result = async {
            send(&mut socket, pong()).await?;
            let mut deadline = Instant::now() + HEARTBEAT_TIMEOUT;
            loop {
                tokio::select! {
                    _ = sleep_until(expires) => return Err("node token expired; rotating registration"),
                    _ = sleep_until(deadline) => return Err("server heartbeat timed out"),
                    message = socket.next() => {
                        match message {
                            Some(Ok(Message::Text(text))) => {
                                let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "invalid signal JSON")?;
                                match value.get("type").and_then(|t| t.as_str()) {
                                    Some("ping") => {
                                        deadline = Instant::now() + HEARTBEAT_TIMEOUT;
                                        send(&mut socket, pong()).await?;
                                    }
                                    // No task can be executed by this phase. Close and let
                                    // the coordinator release any erroneous assignment.
                                    Some("task" | "swarm-init" | "swarm-slice" | "swarm-start") => return Err("unexpected task on signaling-only node"),
                                    _ => {},
                                }
                            }
                            Some(Ok(Message::Ping(payload))) => send(&mut socket, Message::Pong(payload)).await?,
                            Some(Ok(Message::Close(_))) | None => return Err("signal closed"),
                            Some(Ok(Message::Binary(_))) => return Err("unexpected binary signal"),
                            Some(Err(_)) => return Err("signal read failed"),
                            _ => {},
                        }
                    }
                }
            }
        } => result,
    };
    // Bound close even if the peer has stopped reading. Token lives only in
    // the registration/handshake and is discarded when this connection ends.
    let _ = timeout(Duration::from_secs(2), socket.close(None)).await;
    result
}

/// Register and maintain a signaling-only node until cancellation.
/// Every reconnect obtains a fresh server-issued identity and token.
pub async fn run(config: Config, stop: CancellationToken) -> Result<(), &'static str> {
    let endpoints = config.endpoints()?;
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
            connection = connect(&client, &endpoints, &config.site_id) => connection,
        };
        let result = match connection {
            Ok((socket, expires)) => session(socket, expires, &stop).await,
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
            session(socket, Instant::now() + Duration::from_secs(3600), &stop).await
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
