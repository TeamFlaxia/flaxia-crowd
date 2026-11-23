use serde::Deserialize;
use url::Url;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub orchestrator_url: String,
    pub site_id: String,
    #[serde(default)]
    pub participate: bool,
    #[serde(default)]
    pub execution: ExecutionConfig,
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ExecutionConfig {
    pub image_process: bool,
    pub memory_limit_mb: u64,
    pub max_timeout_ms: u64,
}

impl Default for ExecutionConfig {
    fn default() -> Self {
        Self {
            image_process: false,
            memory_limit_mb: 512,
            max_timeout_ms: 120_000,
        }
    }
}

impl ExecutionConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(256..=2048).contains(&self.memory_limit_mb)
            || !(1..=600_000).contains(&self.max_timeout_ms)
        {
            return Err(
                "execution limits: memory_limit_mb must be 256..2048 and max_timeout_ms 1..600000",
            );
        }
        Ok(())
    }
}

pub struct Endpoints {
    pub register: Url,
    pub signal: Url,
}

impl Config {
    pub fn endpoints(&self) -> Result<Endpoints, &'static str> {
        self.execution.validate()?;
        if !self.participate {
            return Err("Set participate = true to explicitly enable this node");
        }
        if self.site_id.is_empty() || self.site_id.encode_utf16().count() > 128 {
            return Err("site_id must contain 1 to 128 UTF-16 code units");
        }
        let base = Url::parse(&self.orchestrator_url).map_err(|_| "Invalid orchestrator_url")?;
        let loopback = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(base.scheme() == "https" || base.scheme() == "http" && loopback)
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(
                "Use HTTPS (HTTP only on loopback), without credentials, query or fragment",
            );
        }
        let mut register = base.clone();
        register.set_path(&format!(
            "{}/crowd/nodes/register",
            base.path().trim_end_matches('/')
        ));
        let mut signal = base.clone();
        signal.set_path(&format!(
            "{}/crowd/signal",
            base.path().trim_end_matches('/')
        ));
        signal
            .set_scheme(if base.scheme() == "https" {
                "wss"
            } else {
                "ws"
            })
            .unwrap();
        Ok(Endpoints { register, signal })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(url: &str) -> Config {
        Config {
            orchestrator_url: url.into(),
            site_id: "native-dev".into(),
            participate: true,
            execution: ExecutionConfig::default(),
        }
    }

    #[test]
    fn requires_explicit_participation() {
        let parsed: Config =
            toml::from_str("orchestrator_url = 'https://example.com'\nsite_id = 'dev'").unwrap();
        assert!(parsed.endpoints().is_err());
    }

    #[test]
    fn builds_prefixed_urls_and_allows_loopback_development() {
        let endpoints = config("https://example.com/prefix/").endpoints().unwrap();
        assert_eq!(
            endpoints.register.as_str(),
            "https://example.com/prefix/crowd/nodes/register"
        );
        assert_eq!(
            endpoints.signal.as_str(),
            "wss://example.com/prefix/crowd/signal"
        );
        for url in [
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            assert!(config(url).endpoints().is_ok());
        }
    }

    #[test]
    fn rejects_insecure_or_credential_bearing_urls_and_invalid_sites() {
        for url in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com?token=secret",
            "https://example.com#fragment",
            "file:///tmp/node",
            "wss://example.com",
        ] {
            assert!(config(url).endpoints().is_err(), "{url}");
        }
        let mut cfg = config("https://example.com");
        cfg.site_id = "🦀".repeat(65);
        assert!(cfg.endpoints().is_err());
        assert!(
            toml::from_str::<Config>(
                "orchestrator_url = 'https://example.com'\nsite_id = 'dev'\nparticipte = true"
            )
            .is_err()
        );
    }
}
