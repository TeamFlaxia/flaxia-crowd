use crate::{
    config::ExecutionConfig,
    image_process::{MAX_RESULT_BYTES, MAX_TASK_BYTES},
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

pub struct Runner {
    executable: PathBuf,
    pub settings: ExecutionConfig,
    pub device_memory_gib: f64,
}

// Physical RAM is the existing deviceMemory hint, not a claim about WASM
// allocation. Never substitute this value for wasmMemoryBytes.
#[cfg(target_os = "linux")]
pub(crate) fn physical_memory_gib() -> Option<f64> {
    // SAFETY: sysconf takes no pointers; nonpositive results are rejected.
    let (pages, size) = unsafe {
        (
            libc::sysconf(libc::_SC_PHYS_PAGES),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    if pages <= 0 || size <= 0 {
        return None;
    }
    Some((pages as f64 * size as f64) / (1024.0 * 1024.0 * 1024.0))
}
#[cfg(not(target_os = "linux"))]
pub(crate) fn physical_memory_gib() -> Option<f64> {
    None
}

impl Runner {
    pub async fn prepare(
        executable: PathBuf,
        settings: ExecutionConfig,
    ) -> Result<Self, &'static str> {
        settings.validate()?;
        let device_memory_gib =
            physical_memory_gib().ok_or("native execution requires Linux memory measurement")?;
        if device_memory_gib < 4.0 {
            return Err(
                "native image execution requires at least 4 GiB RAM under current worker scheduling",
            );
        }
        let runner = Self {
            executable,
            settings,
            device_memory_gib,
        };
        let mut command = runner.command(1);
        command.arg("--executor-probe");
        let output = timeout(Duration::from_secs(5), command.output())
            .await
            .map_err(|_| "native executor probe timed out")?
            .map_err(|_| "cannot start native executor")?;
        if !output.status.success() || output.stdout != b"ready" {
            return Err("native executor limits unavailable");
        }
        Ok(runner)
    }

    fn command(&self, cpu_seconds: u64) -> Command {
        let mut command = Command::new(&self.executable);
        command
            .arg("--execute-image")
            .arg("--memory-limit-mb")
            .arg(self.settings.memory_limit_mb.to_string())
            .arg("--cpu-limit-seconds")
            .arg(cpu_seconds.to_string())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        command
    }

    pub async fn execute(
        &self,
        payload: Value,
        timeout_ms: u64,
        cancel: CancellationToken,
    ) -> Result<Value, String> {
        let duration = Duration::from_millis(timeout_ms.min(self.settings.max_timeout_ms));
        let mut child = self
            .command(duration.as_secs().saturating_add(1))
            .spawn()
            .map_err(|_| "EXECUTOR_START_FAILED".to_string())?;
        let input =
            serde_json::to_vec(&payload).map_err(|_| "INVALID_IMAGE_PAYLOAD".to_string())?;
        if input.len() > MAX_TASK_BYTES {
            terminate(&mut child).await;
            return Err("TASK_TOO_LARGE".into());
        }
        let mut stdin = child.stdin.take().ok_or("EXECUTOR_STDIN_UNAVAILABLE")?;
        let stdout = child.stdout.take().ok_or("EXECUTOR_STDOUT_UNAVAILABLE")?;
        let work = async {
            let write = async {
                stdin
                    .write_all(&input)
                    .await
                    .map_err(|_| "EXECUTOR_WRITE_FAILED")?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|_| "EXECUTOR_WRITE_FAILED")?;
                drop(stdin);
                Ok::<(), &'static str>(())
            };
            let read = async {
                let mut output = Vec::new();
                stdout
                    .take(MAX_RESULT_BYTES as u64 + 1)
                    .read_to_end(&mut output)
                    .await
                    .map_err(|_| "EXECUTOR_READ_FAILED")?;
                if output.len() > MAX_RESULT_BYTES {
                    return Err("RESULT_TOO_LARGE");
                }
                Ok(output)
            };
            let (_, output) = tokio::try_join!(write, read)?;
            let status = child.wait().await.map_err(|_| "EXECUTOR_WAIT_FAILED")?;
            if !status.success() {
                return Err("EXECUTOR_EXITED");
            }
            Ok::<Vec<u8>, &'static str>(output)
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED"),
            result = timeout(duration, work) => result.unwrap_or(Err("TIMEOUT")),
        };
        terminate(&mut child).await;
        let output = result.map_err(str::to_string)?;
        let response: Value =
            serde_json::from_slice(&output).map_err(|_| "INVALID_EXECUTOR_RESPONSE")?;
        if let Some(error) = response.get("error").and_then(Value::as_str) {
            if error.len() <= 96 && error.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') {
                return Err(error.to_owned());
            }
            return Err("INVALID_EXECUTOR_RESPONSE".into());
        }
        response
            .get("ok")
            .cloned()
            .ok_or_else(|| "INVALID_EXECUTOR_RESPONSE".to_string())
    }
}

async fn terminate(child: &mut Child) {
    // kill() also waits, so no next task starts while the old process is alive.
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
}

#[cfg(target_os = "linux")]
fn apply_limits(memory_mb: u64, cpu_seconds: u64) -> Result<(), &'static str> {
    if !(256..=2048).contains(&memory_mb) || !(1..=601).contains(&cpu_seconds) {
        return Err("INVALID_EXECUTOR_LIMITS");
    }
    for (resource, value) in [
        (libc::RLIMIT_AS, memory_mb * 1024 * 1024),
        (libc::RLIMIT_CPU, cpu_seconds),
        (libc::RLIMIT_CORE, 0),
    ] {
        let limit = libc::rlimit {
            rlim_cur: value as libc::rlim_t,
            rlim_max: value as libc::rlim_t,
        };
        // SAFETY: a valid pointer to a fully initialized rlimit is supplied.
        if unsafe { libc::setrlimit(resource, &limit) } != 0 {
            return Err("EXECUTOR_LIMITS_FAILED");
        }
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
fn apply_limits(_: u64, _: u64) -> Result<(), &'static str> {
    Err("NATIVE_EXECUTION_REQUIRES_LINUX")
}

/// Internal child entry point. Runs before constructing a Tokio runtime.
pub fn child_main(memory_mb: u64, cpu_seconds: u64, probe: bool) -> Result<(), &'static str> {
    apply_limits(memory_mb, cpu_seconds)?;
    if probe {
        std::io::stdout()
            .write_all(b"ready")
            .map_err(|_| "EXECUTOR_WRITE_FAILED")?;
        return Ok(());
    }
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_TASK_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|_| "EXECUTOR_READ_FAILED")?;
    let result = if input.len() > MAX_TASK_BYTES {
        Err("TASK_TOO_LARGE")
    } else {
        serde_json::from_slice(&input)
            .map_err(|_| "INVALID_IMAGE_PAYLOAD")
            .and_then(crate::image_process::process)
    };
    let response = match result {
        Ok(value) => json!({"ok":value}),
        Err(error) => json!({"error":error}),
    };
    let output = serde_json::to_vec(&response).map_err(|_| "EXECUTOR_WRITE_FAILED")?;
    if output.len() > MAX_RESULT_BYTES {
        return Err("RESULT_TOO_LARGE");
    }
    std::io::stdout()
        .write_all(&output)
        .map_err(|_| "EXECUTOR_WRITE_FAILED")
}
