use axum::{
    Json, Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, Uri},
    response::Response,
    routing::{get, post},
};
use flaxia_node_native::{config::Config, run};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpListener, sync::mpsc, task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum Behavior {
    Stay,
    CloseFirst,
    ExpireFirst,
    NoProtocol,
    InvalidCredentials,
}

#[derive(Clone)]
struct Mock {
    registrations: Arc<AtomicUsize>,
    events: mpsc::UnboundedSender<&'static str>,
    behavior: Behavior,
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/signaling.json")).unwrap()
}

async fn register(State(state): State<Mock>, Json(body): Json<Value>) -> Json<Value> {
    assert_eq!(body, fixture()["registrationRequest"]);
    let index = state.registrations.fetch_add(1, Ordering::SeqCst);
    state.events.send("register").unwrap();
    let ttl = if matches!(state.behavior, Behavior::ExpireFirst) && index == 0 {
        2_000
    } else {
        7_200_000
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    Json(json!({
        "token": if matches!(state.behavior, Behavior::InvalidCredentials) { "secret,invalid".into() } else { token(index) },
        "nodeId": format!("server-issued-{index}"),
        "expiresAt": now + ttl,
        "lowMemory": true
    }))
}

fn token(index: usize) -> String {
    if index == 0 {
        "test-token".into()
    } else {
        format!("test-token-{index}")
    }
}

async fn upgrade(
    State(state): State<Mock>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Response {
    assert!(uri.query().is_none(), "token must never travel in URL");
    let index = state.registrations.load(Ordering::SeqCst) - 1;
    assert_eq!(
        headers["Sec-WebSocket-Protocol"],
        format!("flaxia-node-v1, bearer.{}", token(index))
    );
    let protocol = if matches!(state.behavior, Behavior::NoProtocol) {
        "other"
    } else {
        "flaxia-node-v1"
    };
    ws.protocols([protocol])
        .on_upgrade(move |socket| serve(socket, state, index))
}

async fn expect_pong(socket: &mut WebSocket) {
    let message = socket.recv().await.unwrap().unwrap();
    let Message::Text(text) = message else {
        panic!("expected text pong")
    };
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        fixture()["pong"]
    );
}

async fn serve(mut socket: WebSocket, state: Mock, index: usize) {
    if matches!(state.behavior, Behavior::NoProtocol) {
        return;
    }
    expect_pong(&mut socket).await;
    socket
        .send(Message::Text(r#"{"type":"ping"}"#.into()))
        .await
        .unwrap();
    expect_pong(&mut socket).await;
    state.events.send("heartbeat").unwrap();
    if matches!(state.behavior, Behavior::CloseFirst) && index == 0 {
        socket.send(Message::Close(None)).await.unwrap();
        return;
    }
    while let Some(message) = socket.recv().await {
        if matches!(message, Ok(Message::Close(_))) {
            let _ = state.events.send("closed");
            return;
        }
    }
}

struct Harness {
    url: String,
    events: mpsc::UnboundedReceiver<&'static str>,
    registrations: Arc<AtomicUsize>,
    server: JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Harness {
    async fn start(behavior: Behavior) -> Self {
        let (tx, events) = mpsc::unbounded_channel();
        let registrations = Arc::new(AtomicUsize::new(0));
        let state = Mock {
            registrations: registrations.clone(),
            events: tx,
            behavior,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/crowd/nodes/register", post(register))
            .route("/crowd/signal", get(upgrade))
            .with_state(state);
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            url,
            events,
            registrations,
            server,
        }
    }

    fn spawn_node(&self, stop: CancellationToken) -> JoinHandle<Result<(), &'static str>> {
        let cfg = Config {
            orchestrator_url: self.url.clone(),
            site_id: "native-test".into(),
            participate: true,
        };
        tokio::spawn(run(cfg, stop))
    }

    async fn event(&mut self, expected: &str) {
        timeout(Duration::from_secs(8), async {
            loop {
                if self.events.recv().await.expect("server alive") == expected {
                    break;
                }
            }
        })
        .await
        .unwrap();
    }
}

async fn stop_node(stop: CancellationToken, node: JoinHandle<Result<(), &'static str>>) {
    stop.cancel();
    timeout(Duration::from_secs(3), node)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn registers_authenticates_responds_to_ping_and_closes_on_shutdown() {
    let mut harness = Harness::start(Behavior::Stay).await;
    let stop = CancellationToken::new();
    let node = harness.spawn_node(stop.clone());
    harness.event("heartbeat").await;
    stop_node(stop, node).await;
    harness.event("closed").await;
    assert_eq!(harness.registrations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn disconnect_obtains_fresh_registration_and_token() {
    let mut harness = Harness::start(Behavior::CloseFirst).await;
    let stop = CancellationToken::new();
    let node = harness.spawn_node(stop.clone());
    harness.event("heartbeat").await;
    harness.event("heartbeat").await;
    assert_eq!(harness.registrations.load(Ordering::SeqCst), 2);
    stop_node(stop, node).await;
}

#[tokio::test]
async fn rotates_expired_token_without_waiting_for_server_disconnect() {
    let mut harness = Harness::start(Behavior::ExpireFirst).await;
    let stop = CancellationToken::new();
    let node = harness.spawn_node(stop.clone());
    harness.event("heartbeat").await;
    harness.event("heartbeat").await;
    assert_eq!(harness.registrations.load(Ordering::SeqCst), 2);
    stop_node(stop, node).await;
}

#[tokio::test]
async fn rejected_protocol_and_malformed_credentials_are_retried_and_stoppable() {
    for behavior in [Behavior::NoProtocol, Behavior::InvalidCredentials] {
        let mut harness = Harness::start(behavior).await;
        let stop = CancellationToken::new();
        let node = harness.spawn_node(stop.clone());
        harness.event("register").await;
        harness.event("register").await;
        stop_node(stop, node).await;
        while let Ok(event) = harness.events.try_recv() {
            assert_ne!(event, "heartbeat");
        }
    }
}
