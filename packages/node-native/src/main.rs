use clap::Parser;
use flaxia_node_native::{config::Config, run};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(version, about = "Flaxia Crowd native node")]
struct Cli {
    #[arg(long, default_value = "node.toml")]
    config: PathBuf,
    #[arg(long, hide = true)]
    execute_image: bool,
    #[arg(long, hide = true)]
    executor_probe: bool,
    #[arg(long, hide = true, default_value_t = 512)]
    memory_limit_mb: u64,
    #[arg(long, hide = true, default_value_t = 120)]
    cpu_limit_seconds: u64,
}

fn main() -> Result<(), &'static str> {
    let cli = Cli::parse();
    if cli.execute_image {
        return flaxia_node_native::executor::child_main(
            cli.memory_limit_mb,
            cli.cpu_limit_seconds,
            cli.executor_probe,
        );
    }
    tracing_subscriber::fmt().with_target(false).init();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|_| "Cannot start node runtime")?
        .block_on(start(cli))
}

async fn start(cli: Cli) -> Result<(), &'static str> {
    let text = std::fs::read_to_string(cli.config).map_err(|_| "Cannot read node config")?;
    let config: Config =
        toml::from_str(&text).map_err(|_| "Invalid node config; see node.example.toml")?;
    // Validate before installing signals or making any network request.
    config.endpoints()?;
    let stop = CancellationToken::new();
    let signals = async {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .map_err(|_| "Cannot install SIGTERM handler")?;
            tokio::select! {
                result = tokio::signal::ctrl_c() => result.map_err(|_| "Cannot install Ctrl-C handler")?,
                _ = term.recv() => {},
            }
        }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c()
            .await
            .map_err(|_| "Cannot install Ctrl-C handler")?;
        Ok::<(), &'static str>(())
    };
    let node = run(config, stop.clone());
    tokio::pin!(signals, node);
    tokio::select! {
        result = &mut node => result,
        result = &mut signals => {
            stop.cancel();
            let stopped = node.await;
            result?;
            stopped
        }
    }
}
