use clap::Parser;
use flaxia_node_native::{config::Config, run};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    version,
    about = "Flaxia Crowd native node (signaling only; no task execution)"
)]
struct Cli {
    #[arg(long, default_value = "node.toml")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> Result<(), &'static str> {
    tracing_subscriber::fmt().with_target(false).init();
    let cli = Cli::parse();
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
