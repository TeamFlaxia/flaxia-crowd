//! Native WebGPU execution uses the same Pooled slice engine and wire contract
//! as browser nodes, hosted by Deno's native Rust/wgpu runtime. No browser starts.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
    task::JoinHandle,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

const IPC_LIMIT: usize = 12 * 1024 * 1024;
pub const FRAME_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SwarmConfig {
    pub enabled: bool,
    pub allow_model_download: bool,
    pub runtime: PathBuf,
    pub helper: PathBuf,
    /// V8 heap cap; does not cap GPU/driver memory or Deno's native allocations.
    pub heap_limit_mb: Option<u32>,
}
impl SwarmConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !self.enabled {
            return Ok(());
        }
        if !self.allow_model_download {
            return Err("swarm execution requires allow_model_download = true");
        }
        if !self.runtime.is_absolute() || !self.helper.is_absolute() {
            return Err("swarm runtime and helper must be absolute trusted paths");
        }
        if self
            .heap_limit_mb
            .is_some_and(|v| !(256..=4096).contains(&v))
        {
            return Err("swarm heap_limit_mb must be 256..4096");
        }
        Ok(())
    }
}

pub struct SwarmRunner {
    settings: SwarmConfig,
    pub capabilities: Value,
    pub device_memory_gib: f64,
    pub max_timeout_ms: u64,
}

pub struct SwarmTask {
    pub task_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub input: mpsc::Sender<Value>,
    pub output: mpsc::Receiver<Value>,
    cancel: CancellationToken,
    join: JoinHandle<Result<(), &'static str>>,
}
impl SwarmTask {
    pub async fn stop(self) {
        self.cancel.cancel();
        let _ = self.join.await;
    }
    pub fn matches(&self, message: &Value) -> bool {
        message["taskId"] == self.task_id
            && message["attemptId"] == self.attempt_id
            && message["sessionId"] == self.session_id
    }
    pub fn send(&self, message: Value) -> Result<(), &'static str> {
        // Never stall heartbeat or abort handling behind a GPU/IPC consumer.
        self.input
            .try_send(message)
            .map_err(|_| "swarm input backpressure limit reached")
    }
}

impl SwarmRunner {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.settings.runtime);
        command.args([
            "run", "--no-config", "--no-lock", "--no-npm", "--cached-only",
            "--no-prompt", "--quiet", "--unstable-webgpu",
            "--allow-env=DENO_WEBGPU_BACKEND",
            // Only the hardcoded production model registry may initiate fetches;
            // OS permissions additionally confine redirects to model hosting.
            "--allow-net=huggingface.co,cdn-lfs.huggingface.co,cdn-lfs-us-1.hf.co,cdn-lfs-eu-1.hf.co,cas-bridge.xethub.hf.co,transfer.xethub.hf.co",
        ]).arg(format!("--v8-flags=--max-old-space-size={}", self.settings.heap_limit_mb.unwrap_or(512)))
            .arg(&self.settings.helper)
            .env_clear()
            .env("DENO_NO_UPDATE_CHECK", "1")
            // Fixed native Vulkan backend: never fall back to OpenGL/another API.
            .env("DENO_WEBGPU_BACKEND", "vulkan")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(target_os = "linux")]
        {
            // SAFETY: only async-signal-safe libc calls run between fork/exec.
            unsafe {
                command.pre_exec(|| {
                    let core = libc::rlimit {
                        rlim_cur: 0,
                        rlim_max: 0,
                    };
                    if libc::setrlimit(libc::RLIMIT_CORE, &core) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        command
    }

    pub async fn prepare(settings: SwarmConfig, max_timeout_ms: u64) -> Result<Self, &'static str> {
        settings.validate()?;
        let memory = crate::executor::physical_memory_gib().ok_or("native swarm requires Linux")?;
        if memory < 4.0 {
            return Err("native swarm requires at least 4 GiB RAM");
        }
        let mut runner = Self {
            settings,
            capabilities: Value::Null,
            device_memory_gib: memory,
            max_timeout_ms,
        };
        let mut child = runner
            .command()
            .arg("--probe")
            .spawn()
            .map_err(|_| "cannot start native WebGPU runtime")?;
        let mut stdout = child.stdout.take().ok_or("missing WebGPU probe output")?;
        let work = async {
            let mut bytes = Vec::new();
            (&mut stdout)
                .take(4097)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "WebGPU probe read failed")?;
            let status = child.wait().await.map_err(|_| "WebGPU probe wait failed")?;
            if bytes.len() > 4096 || !status.success() {
                return Err("native WebGPU probe failed");
            }
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "invalid native WebGPU probe")?;
            let caps = &value["capabilities"];
            if value["kind"] != "probe" || value["backend"] != "vulkan" || caps["webgpu"] != true {
                return Err("native Vulkan compute unavailable");
            }
            let maximum = caps["maxStorageBufferBindingSize"]
                .as_u64()
                .ok_or("native GPU memory limit unknown")?;
            if maximum == 0 || maximum > 16 * 1024 * 1024 * 1024 {
                return Err("invalid native GPU memory limit");
            }
            Ok(caps.clone())
        };
        let result = timeout(Duration::from_secs(20), work)
            .await
            .unwrap_or(Err("native WebGPU probe timed out"));
        terminate(&mut child).await;
        runner.capabilities = result?;
        tracing::info!(gpu_backend = "vulkan", "native swarm executor ready");
        Ok(runner)
    }

    pub fn start(&self, initial: &Value) -> Result<SwarmTask, &'static str> {
        let id = |key| {
            initial
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty() && v.len() <= 128)
                .map(str::to_owned)
                .ok_or("invalid swarm identity")
        };
        let task_id = id("taskId")?;
        let attempt_id = id("attemptId")?;
        let session_id = id("sessionId")?;
        let requested = initial
            .get("timeoutMs")
            .and_then(Value::as_f64)
            .unwrap_or(self.max_timeout_ms as f64);
        if !requested.is_finite() || requested <= 0.0 {
            return Err("invalid swarm timeout");
        }
        let duration = Duration::from_millis((requested.ceil() as u64).min(self.max_timeout_ms));
        let mut child = self
            .command()
            .spawn()
            .map_err(|_| "cannot start swarm executor")?;
        let mut stdin = child.stdin.take().ok_or("missing swarm input")?;
        let stdout = child.stdout.take().ok_or("missing swarm output")?;
        let (tx, mut rx) = mpsc::channel::<Value>(4);
        let (out, output) = mpsc::channel(4);
        tx.try_send(json!({"kind":"control","message":initial}))
            .map_err(|_| "cannot initialize swarm")?;
        let cancel = CancellationToken::new();
        let cancelled = cancel.clone();
        let join = tokio::spawn(async move {
            let writer = async {
                while let Some(value) = rx.recv().await {
                    let mut bytes =
                        serde_json::to_vec(&value).map_err(|_| "invalid swarm IPC input")?;
                    if bytes.len() > IPC_LIMIT {
                        return Err("swarm IPC input too large");
                    }
                    bytes.push(b'\n');
                    stdin
                        .write_all(&bytes)
                        .await
                        .map_err(|_| "swarm IPC write failed")?;
                }
                Ok::<(), &'static str>(())
            };
            let reader = async {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut line = Vec::new();
                    let read = (&mut reader)
                        .take(IPC_LIMIT as u64 + 1)
                        .read_until(b'\n', &mut line)
                        .await
                        .map_err(|_| "swarm IPC read failed")?;
                    if read == 0 {
                        return Err("swarm executor exited");
                    }
                    if line.len() > IPC_LIMIT {
                        return Err("swarm IPC output too large");
                    }
                    let value: Value =
                        serde_json::from_slice(&line).map_err(|_| "invalid swarm IPC output")?;
                    let done = value["kind"] == "done";
                    out.send(value).await.map_err(|_| "swarm consumer closed")?;
                    if done {
                        return Ok(());
                    }
                }
            };
            let work = async {
                tokio::select! { result = writer => result, result = reader => result }
            };
            let result = tokio::select! {
                biased;
                _ = cancelled.cancelled() => Ok(()),
                result = timeout(duration, work) => result.unwrap_or(Err("SWARM_TIMEOUT")),
            };
            terminate(&mut child).await;
            result
        });
        Ok(SwarmTask {
            task_id,
            attempt_id,
            session_id,
            input: tx,
            output,
            cancel,
            join,
        })
    }
}
async fn terminate(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
}

pub fn frame(message: &Value) -> Result<Vec<u8>, &'static str> {
    let data = message["data"]
        .as_str()
        .ok_or("invalid swarm frame output")?;
    if data.len() > FRAME_LIMIT.div_ceil(3) * 4 {
        return Err("swarm frame output too large");
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "invalid swarm frame encoding")?;
    if bytes.len() > FRAME_LIMIT {
        return Err("swarm frame output too large");
    }
    Ok(bytes)
}
