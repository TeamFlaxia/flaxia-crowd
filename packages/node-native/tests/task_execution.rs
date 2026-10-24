#![cfg(target_os = "linux")]
use axum::{
    Json, Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use flaxia_node_native::{
    config::{Config, ExecutionConfig},
    run_with_executable,
    swarm::SwarmConfig,
};
use serde_json::{Value, json};
use std::{
    io::Cursor,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, mpsc},
    task::JoinHandle,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

type Commands = Arc<Mutex<Option<mpsc::UnboundedReceiver<Option<Value>>>>>;
#[derive(Clone)]
struct Server {
    frames: mpsc::UnboundedSender<Value>,
    commands: Commands,
}
async fn register(State(state): State<Server>, Json(value): Json<Value>) -> Json<Value> {
    assert_eq!(
        value["capabilities"],
        if value.get("swarm").is_some() {
            json!(["swarm-inference"])
        } else {
            json!(["image-process"])
        }
    );
    assert!(value["deviceMemory"].as_f64().unwrap() >= 4.0);
    assert!(value.get("wasmMemoryBytes").is_none());
    state.frames.send(json!({"type":"_registered"})).unwrap();
    Json(
        json!({"nodeId":"issued-by-server", "token":"test-token", "expiresAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 7_200_000}),
    )
}
async fn upgrade(State(state): State<Server>, ws: WebSocketUpgrade) -> Response {
    ws.protocols(["flaxia-node-v1"])
        .on_upgrade(move |socket| serve(socket, state))
}
async fn serve(mut socket: WebSocket, state: Server) {
    let Some(mut commands) = state.commands.lock().await.take() else {
        return;
    };
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Some(value)) => { if socket.send(Message::Text(value.to_string().into())).await.is_err() { break; } },
                _ => { let _ = socket.send(Message::Close(None)).await; break; }
            },
            frame = socket.recv() => match frame {
                Some(Ok(Message::Text(text))) => { let _ = state.frames.send(serde_json::from_str(&text).unwrap()); },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {},
            }
        }
    }
    let _ = state.frames.send(json!({"type":"_closed"}));
}
struct Harness {
    commands: mpsc::UnboundedSender<Option<Value>>,
    frames: mpsc::UnboundedReceiver<Value>,
    server: JoinHandle<()>,
    node: JoinHandle<Result<(), &'static str>>,
    stop: CancellationToken,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.stop.cancel();
        self.server.abort();
    }
}
impl Harness {
    async fn start(executable: PathBuf, max_timeout_ms: u64) -> Self {
        Self::start_config(executable, max_timeout_ms, SwarmConfig::default()).await
    }
    async fn start_config(executable: PathBuf, max_timeout_ms: u64, swarm: SwarmConfig) -> Self {
        let (commands, rx) = mpsc::unbounded_channel();
        let (tx, frames) = mpsc::unbounded_channel();
        let state = Server {
            frames: tx,
            commands: Arc::new(Mutex::new(Some(rx))),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cfg = Config {
            orchestrator_url: format!("http://{}", listener.local_addr().unwrap()),
            site_id: "native-test".into(),
            participate: true,
            execution: ExecutionConfig {
                image_process: !swarm.enabled,
                swarm,
                memory_limit_mb: 512,
                max_timeout_ms,
            },
        };
        let router = Router::new()
            .route("/crowd/nodes/register", post(register))
            .route("/crowd/signal", get(upgrade))
            .with_state(state);
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let stop = CancellationToken::new();
        let node = tokio::spawn(run_with_executable(cfg, stop.clone(), Some(executable)));
        let mut harness = Self {
            commands,
            frames,
            server,
            node,
            stop,
        };
        assert_eq!(harness.next().await["type"], "_registered");
        assert_eq!(harness.next().await, json!({"type":"pong","cpuLoad":null}));
        harness
    }
    fn send(&self, value: Value) {
        self.commands.send(Some(value)).unwrap();
    }
    async fn next(&mut self) -> Value {
        timeout(Duration::from_secs(8), self.frames.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn finish(&mut self) {
        self.stop.cancel();
        timeout(Duration::from_secs(4), &mut self.node)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
fn task(attempt: &str, payload: Value) -> Value {
    json!({"type":"task","taskId":"task-1","attemptId":attempt,"workload":"image-process","timeoutMs":5000,"payload":payload})
}
fn image_payload() -> Value {
    let mut seed = 9_u32;
    let image = image::RgbaImage::from_fn(256, 256, |_, _| {
        let mut pixel = [0; 4];
        for v in &mut pixel {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *v = seed as u8;
        }
        image::Rgba(pixel)
    });
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    json!({"operation":"resize","mimeType":"image/png","imageBase64":STANDARD.encode(bytes.into_inner()),"options":{"width":64,"height":48}})
}
#[tokio::test]
async fn real_executor_completes_large_task_preserves_attempt_and_suppresses_duplicate() {
    let mut harness = Harness::start(env!("CARGO_BIN_EXE_flaxia-node-native").into(), 5000).await;
    let delivery = task("attempt-1", image_payload());
    assert!(delivery.to_string().len() > 64 * 1024);
    harness.send(delivery.clone());
    harness.send(delivery.clone());
    let result = harness.next().await;
    assert_eq!(result["type"], "result");
    assert_eq!(result["attemptId"], "attempt-1");
    let bytes = STANDARD
        .decode(result["payload"]["imageBase64"].as_str().unwrap())
        .unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (64, 48));
    harness.send(delivery); // duplicate after completion must not launch another process
    harness.send(json!({"type":"ping"}));
    assert_eq!(harness.next().await["type"], "pong");
    let mut bad = task("invalid", json!({}));
    bad["attemptId"] = json!("attempt-2");
    harness.send(bad);
    let error = harness.next().await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["attemptId"], "attempt-2");
    harness.finish().await;
}
struct SlowExecutor {
    directory: PathBuf,
    executable: PathBuf,
    pid: PathBuf,
}
impl SlowExecutor {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("flaxia-executor-{}", fastrand::u64(..)));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("executor.sh");
        let pid = directory.join("pid");
        let marker = directory.join("started");
        let script = format!(
            "#!/bin/sh\ncase \"$*\" in *--executor-probe*) printf ready; exit 0;; esac\nif [ -e '{}' ]; then /bin/cat > /dev/null; printf '%s' '{{\"ok\":{{\"confirmed\":true}}}}'; exit 0; fi\n: > '{}'\nprintf '%s' \"$$\" > '{}'\nexec /bin/sleep 30\n",
            marker.display(),
            marker.display(),
            pid.display()
        );
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            directory,
            executable,
            pid,
        }
    }
    async fn started(&self) -> i32 {
        timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&self.pid)
                    && let Ok(pid) = text.parse()
                {
                    return pid;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
    fn assert_reaped(&self, pid: i32) {
        // SAFETY: signal 0 checks existence and sends no signal.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "executor still running");
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
}
impl Drop for SlowExecutor {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[tokio::test]
async fn heartbeat_continues_abort_reaps_child_and_next_attempt_can_run() {
    let executor = SlowExecutor::new();
    let mut harness = Harness::start(executor.executable.clone(), 5000).await;
    harness.send(task("old", json!({})));
    let pid = executor.started().await;
    harness.send(json!({"type":"abort","taskId":"task-1","attemptId":"stale"}));
    harness.send(json!({"type":"ping"}));
    assert_eq!(harness.next().await["type"], "pong");
    // Matching abort has no error/result echo and the process is reaped before pong.
    harness.send(json!({"type":"abort","taskId":"task-1","attemptId":"old"}));
    harness.send(json!({"type":"ping"}));
    assert_eq!(harness.next().await["type"], "pong");
    executor.assert_reaped(pid);
    harness.send(task("new", json!({})));
    let result = harness.next().await;
    assert_eq!(result["attemptId"], "new");
    assert_eq!(result["payload"], json!({"confirmed":true}));
    harness.finish().await;
}

#[tokio::test]
async fn local_timeout_kills_child_and_returns_attempt_scoped_error() {
    let executor = SlowExecutor::new();
    let mut harness = Harness::start(executor.executable.clone(), 300).await;
    harness.send(task("timed", json!({})));
    let pid = executor.started().await;
    let error = harness.next().await;
    assert_eq!(error["error"], "TIMEOUT");
    assert_eq!(error["attemptId"], "timed");
    executor.assert_reaped(pid);
    harness.finish().await;
}

#[tokio::test]
async fn disconnect_and_shutdown_reap_running_child() {
    for disconnect in [true, false] {
        let executor = SlowExecutor::new();
        let mut harness = Harness::start(executor.executable.clone(), 5000).await;
        harness.send(task("running", json!({})));
        let pid = executor.started().await;
        if disconnect {
            harness.commands.send(None).unwrap();
            assert_eq!(harness.next().await["type"], "_closed");
            assert_eq!(harness.next().await["type"], "_registered");
        }
        harness.finish().await;
        executor.assert_reaped(pid);
    }
}

#[tokio::test]
async fn missing_attempt_is_rejected_before_starting_a_child() {
    let executor = SlowExecutor::new();
    let mut harness = Harness::start(executor.executable.clone(), 5000).await;
    let mut delivery = task("missing", json!({}));
    delivery.as_object_mut().unwrap().remove("attemptId");
    harness.send(delivery);
    assert_eq!(harness.next().await["type"], "_closed");
    harness.finish().await;
    assert!(!executor.pid.exists());
}

#[tokio::test]
async fn overlapping_assignment_closes_connection_and_reaps_first_child() {
    let executor = SlowExecutor::new();
    let mut harness = Harness::start(executor.executable.clone(), 5000).await;
    harness.send(task("first", json!({})));
    let pid = executor.started().await;
    harness.send(task("overlapping", json!({})));
    assert_eq!(harness.next().await["type"], "_closed");
    harness.finish().await;
    executor.assert_reaped(pid);
}

fn swarm_task(attempt: &str) -> Value {
    json!({"type":"swarm-init","taskId":"task-1","attemptId":attempt,"sessionId":attempt,"model":"qwen3.5-2b","timeoutMs":5000,"members":[{"nodeId":"host","capacity":1},{"nodeId":"peer","capacity":1}],"prompt":"hi","maxNewTokens":4})
}

impl SlowExecutor {
    fn swarm_config(&self) -> SwarmConfig {
        let marker = self.directory.join("started");
        let script = format!(
            "#!/bin/sh\n[ \"$DENO_WEBGPU_BACKEND\" = vulkan ] || exit 1\ncase \"$*\" in *--probe*) printf '%s' '{{\"kind\":\"probe\",\"backend\":\"vulkan\",\"capabilities\":{{\"webgpu\":true,\"maxStorageBufferBindingSize\":134217728}}}}'; exit 0;; esac\nIFS= read -r initial\nif [ -e '{}' ]; then printf '%s\\n' '{{\"kind\":\"control\",\"message\":{{\"type\":\"result\",\"taskId\":\"task-1\",\"attemptId\":\"new\",\"sessionId\":\"new\",\"payload\":{{\"confirmed\":true}}}}}}' '{{\"kind\":\"done\"}}'; exit 0; fi\n: > '{}'\nprintf '%s' \"$$\" > '{}'\nexec /bin/sleep 30\n",
            marker.display(),
            marker.display(),
            self.pid.display()
        );
        std::fs::write(&self.executable, script).unwrap();
        SwarmConfig {
            enabled: true,
            allow_model_download: true,
            runtime: self.executable.clone(),
            helper: self.directory.join("trusted-helper.js"),
            heap_limit_mb: None,
        }
    }
}

#[tokio::test]
async fn swarm_abort_fences_attempt_reaps_child_and_accepts_next_assignment() {
    let executor = SlowExecutor::new();
    let settings = executor.swarm_config();
    let mut harness = Harness::start_config(executor.executable.clone(), 5000, settings).await;
    harness.send(swarm_task("old"));
    let pid = executor.started().await;
    harness.send(json!({"type":"abort","taskId":"task-1","attemptId":"stale"}));
    harness.send(json!({"type":"ping"}));
    assert_eq!(harness.next().await["type"], "pong");
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    harness.send(json!({"type":"abort","taskId":"task-1","attemptId":"old"}));
    harness.send(json!({"type":"ping"}));
    assert_eq!(harness.next().await["type"], "pong");
    executor.assert_reaped(pid);
    harness.send(swarm_task("new"));
    let result = harness.next().await;
    assert_eq!(result["type"], "result");
    assert_eq!(result["sessionId"], "new");
    assert_eq!(result["payload"], json!({"confirmed":true}));
    harness.finish().await;
}

#[tokio::test]
async fn swarm_timeout_disconnect_and_shutdown_reap_executor() {
    for mode in ["timeout", "disconnect", "shutdown"] {
        let executor = SlowExecutor::new();
        let settings = executor.swarm_config();
        let mut harness = Harness::start_config(
            executor.executable.clone(),
            if mode == "timeout" { 300 } else { 5000 },
            settings,
        )
        .await;
        harness.send(swarm_task("old"));
        let pid = executor.started().await;
        if mode == "disconnect" {
            harness.commands.send(None).unwrap();
        }
        if mode != "shutdown" {
            assert_eq!(harness.next().await["type"], "_closed");
        }
        harness.finish().await;
        executor.assert_reaped(pid);
    }
}

#[tokio::test]
async fn swarm_rejects_probe_without_vulkan_backend_confirmation() {
    let executor = SlowExecutor::new();
    let settings = executor.swarm_config();
    let original = std::fs::read_to_string(&executor.executable).unwrap();
    for report in ["", "opengl"] {
        let script = original.replace(
            "\"backend\":\"vulkan\"",
            &format!("\"backend\":\"{report}\""),
        );
        std::fs::write(&executor.executable, script).unwrap();
        assert!(
            flaxia_node_native::swarm::SwarmRunner::prepare(settings.clone(), 5000)
                .await
                .is_err()
        );
    }
    assert!(!executor.pid.exists());
}
