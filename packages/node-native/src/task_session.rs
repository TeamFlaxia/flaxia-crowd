use crate::{
    HEARTBEAT_TIMEOUT, Socket,
    executor::Runner,
    image_process::{MAX_RESULT_BYTES, MAX_TASK_BYTES},
    pong, send,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::VecDeque, future::pending, sync::Arc};
use tokio::{
    task::JoinHandle,
    time::{Instant, sleep_until, timeout},
};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    task_id: String,
    attempt_id: String,
    workload: String,
    payload: Value,
    timeout_ms: Option<f64>,
}

struct Active {
    task_id: String,
    attempt_id: String,
    cancel: CancellationToken,
    join: JoinHandle<Result<Value, String>>,
}

async fn cancel_active(active: &mut Option<Active>) {
    if let Some(task) = active.take() {
        task.cancel.cancel();
        // Runner cancels, kills and reaps the child before returning.
        let _ = task.join.await;
    }
}

fn retire(retired: &mut VecDeque<(String, String)>, task_id: String, attempt_id: String) {
    if retired.len() == 256 {
        retired.pop_front();
    }
    retired.push_back((task_id, attempt_id));
}

pub(crate) async fn session(
    mut socket: Socket,
    expires: Instant,
    stop: &CancellationToken,
    runner: Option<Arc<Runner>>,
) -> Result<(), &'static str> {
    let mut active = None;
    let result = tokio::select! {
        biased;
        _ = stop.cancelled() => Ok(()),
        result = session_loop(&mut socket, expires, runner, &mut active) => result,
    };
    cancel_active(&mut active).await;
    let _ = timeout(std::time::Duration::from_secs(2), socket.close(None)).await;
    result
}

async fn session_loop(
    socket: &mut Socket,
    expires: Instant,
    runner: Option<Arc<Runner>>,
    active: &mut Option<Active>,
) -> Result<(), &'static str> {
    send(socket, pong()).await?;
    let mut deadline = Instant::now() + HEARTBEAT_TIMEOUT;
    let mut retired = VecDeque::new();
    loop {
        tokio::select! {
            // Read queued abort/disconnect messages before publishing a finished result.
            biased;
            _ = sleep_until(expires) => return Err("node token expired; rotating registration"),
            _ = sleep_until(deadline) => return Err("server heartbeat timed out"),
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > MAX_TASK_BYTES { return Err("task message too large"); }
                        let value: Value = serde_json::from_str(&text).map_err(|_| "invalid signal JSON")?;
                        match value.get("type").and_then(Value::as_str) {
                            Some("ping") => {
                                deadline = Instant::now() + HEARTBEAT_TIMEOUT;
                                send(socket, pong()).await?;
                            }
                            Some("task") => {
                                let runner = runner.as_ref().ok_or("unexpected task on signaling-only node")?;
                                let task: Task = serde_json::from_value(value).map_err(|_| "invalid task envelope")?;
                                if task.task_id.is_empty() || task.attempt_id.is_empty() || task.task_id.len() > 128 || task.attempt_id.len() > 128 {
                                    return Err("invalid task identity");
                                }
                                if retired.iter().any(|(id, attempt)| id == &task.task_id && attempt == &task.attempt_id) { continue; }
                                if let Some(current) = active.as_ref() {
                                    if current.task_id == task.task_id && current.attempt_id == task.attempt_id { continue; }
                                    return Err("overlapping task assignment");
                                }
                                let timeout_ms = task.timeout_ms.unwrap_or(runner.settings.max_timeout_ms as f64);
                                if task.workload != "image-process" || !timeout_ms.is_finite() || timeout_ms <= 0.0 {
                                    let error = if !timeout_ms.is_finite() || timeout_ms <= 0.0 { "INVALID_TASK_TIMEOUT" } else { "UNSUPPORTED_WORKLOAD" };
                                    send(socket, Message::Text(json!({"type":"error", "taskId":task.task_id, "attemptId":task.attempt_id, "error":error}).to_string().into())).await?;
                                    retire(&mut retired, task.task_id, task.attempt_id);
                                    continue;
                                }
                                let timeout_ms = timeout_ms.min(runner.settings.max_timeout_ms as f64).ceil() as u64;
                                let cancel = CancellationToken::new();
                                let execution_cancel = cancel.clone();
                                let runner = Arc::clone(runner);
                                let join = tokio::spawn(async move { runner.execute(task.payload, timeout_ms, execution_cancel).await });
                                *active = Some(Active { task_id:task.task_id, attempt_id:task.attempt_id, cancel, join });
                            }
                            Some("abort") => {
                                let matches = active.as_ref().is_some_and(|task| {
                                    value.get("taskId").and_then(Value::as_str) == Some(task.task_id.as_str()) &&
                                        value.get("attemptId").is_none_or(|attempt| attempt.as_str() == Some(task.attempt_id.as_str()))
                                });
                                if matches {
                                    let task = active.as_ref().unwrap();
                                    retire(&mut retired, task.task_id.clone(), task.attempt_id.clone());
                                    cancel_active(active).await;
                                }
                                // Coordinator aborts must never produce an error echo.
                            }
                            Some("swarm-init" | "swarm-slice" | "swarm-start") => return Err("unexpected swarm assignment"),
                            _ => {},
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => send(socket, Message::Pong(payload)).await?,
                    Some(Ok(Message::Close(_))) | None => return Err("signal closed"),
                    Some(Ok(Message::Binary(_))) => return Err("unexpected binary signal"),
                    Some(Err(_)) => return Err("signal read failed"),
                    _ => {},
                }
            }
            completed = async {
                match active.as_mut() {
                    Some(task) => (&mut task.join).await,
                    None => pending().await,
                }
            } => {
                let task = active.take().ok_or("missing active task")?;
                let result = completed.unwrap_or_else(|_| Err("EXECUTOR_FAILED".into()));
                let message = match result {
                    Ok(payload) => json!({"type":"result", "taskId":task.task_id, "attemptId":task.attempt_id, "payload":payload}),
                    Err(error) => json!({"type":"error", "taskId":task.task_id, "attemptId":task.attempt_id, "error":error}),
                };
                let text = message.to_string();
                if text.len() > MAX_RESULT_BYTES { return Err("result message too large"); }
                send(socket, Message::Text(text.into())).await?;
                retire(&mut retired, task.task_id, task.attempt_id);
            }
        }
    }
}
