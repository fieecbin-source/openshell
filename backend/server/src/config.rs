use clap::Parser;
use std::path::PathBuf;

#[derive(Debug, Clone, Parser)]
#[command(
    name = "openshell-server",
    about = "OpenShell self-hosted sync and update server"
)]
pub struct Config {
    #[arg(long, env = "HOST", default_value = "0.0.0.0")]
    pub host: String,

    #[arg(long, env = "PORT", default_value_t = 8080)]
    pub port: u16,

    #[arg(long, env = "DATABASE_URL", default_value = "openshell-server.db")]
    pub database_url: String,

    #[arg(long, env = "BOOTSTRAP_TOKEN")]
    pub bootstrap_token: Option<String>,

    #[arg(long, env = "ALLOW_MULTI_USER", default_value_t = false)]
    pub allow_multi_user: bool,

    #[arg(long, env = "REQUIRE_INVITE", default_value_t = false)]
    pub require_invite: bool,

    #[arg(long, env = "INVITE_CODE")]
    pub invite_code: Option<String>,

    #[arg(
        long,
        env = "JWT_SECRET",
        default_value = "openshell-secret-key-change-in-production-min-32-chars-long"
    )]
    pub jwt_secret: String,

    #[arg(long, env = "RELAY_ENABLED", default_value_t = false)]
    pub relay_enabled: bool,

    #[arg(
        long,
        env = "RELAY_ALLOWED_NETS",
        default_value = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1/32"
    )]
    pub relay_allowed_nets: String,

    #[arg(long, env = "ARTIFACTS_DIR", default_value = "./artifacts")]
    pub artifacts_dir: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 8080,
            database_url: "openshell-server.db".to_string(),
            bootstrap_token: None,
            allow_multi_user: false,
            require_invite: false,
            invite_code: None,
            jwt_secret: "openshell-secret-key-change-in-production-min-32-chars-long".to_string(),
            relay_enabled: false,
            relay_allowed_nets: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1/32".to_string(),
            artifacts_dir: PathBuf::from("./artifacts"),
        }
    }
}
