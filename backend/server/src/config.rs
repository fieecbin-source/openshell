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

    #[arg(long, env = "PORT", default_value_t = 8085)]
    pub port: u16,

    #[arg(long, env = "DATA_DIR", default_value = "./data")]
    pub data_dir: PathBuf,

    #[arg(long, env = "DATABASE_URL", default_value = "")]
    pub database_url: String,

    #[arg(long, env = "SYNC_USERNAME")]
    pub sync_username: Option<String>,

    #[arg(long, env = "SYNC_PASSWORD")]
    pub sync_password: Option<String>,

    #[arg(long, env = "BOOTSTRAP_TOKEN")]
    pub bootstrap_token: Option<String>,

    #[arg(long, env = "ALLOW_MULTI_USER", default_value_t = false)]
    pub allow_multi_user: bool,

    #[arg(long, env = "REQUIRE_INVITE", default_value_t = false)]
    pub require_invite: bool,

    #[arg(long, env = "INVITE_CODE")]
    pub invite_code: Option<String>,

    #[arg(long, env = "JWT_SECRET", default_value = "")]
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

impl Config {
    pub fn validate_and_bootstrap(&mut self) -> Result<(), String> {
        // 单用户参数必须成对配置
        if self.sync_username.is_some() ^ self.sync_password.is_some() {
            return Err("Both SYNC_USERNAME and SYNC_PASSWORD must be configured together for single-user mode".to_string());
        }

        // 确保 DATA_DIR 存在
        if let Err(e) = std::fs::create_dir_all(&self.data_dir) {
            return Err(format!("Failed to create DATA_DIR {:?}: {}", self.data_dir, e));
        }

        // 解析数据库路径
        if self.database_url.trim().is_empty() {
            self.database_url = self.data_dir.join("openshell-server.db").to_string_lossy().to_string();
        }

        // JWT Secret 自动生成并持久化
        if self.jwt_secret.trim().is_empty() {
            let secret_file = self.data_dir.join(".jwt_secret");
            if secret_file.exists() {
                if let Ok(content) = std::fs::read_to_string(&secret_file) {
                    let trimmed = content.trim().to_string();
                    if trimmed.len() >= 32 {
                        self.jwt_secret = trimmed;
                    }
                }
            }
            if self.jwt_secret.trim().is_empty() {
                use rand::distributions::Alphanumeric;
                use rand::Rng;
                let generated: String = rand::thread_rng()
                    .sample_iter(&Alphanumeric)
                    .take(48)
                    .map(char::from)
                    .collect();
                let _ = std::fs::write(&secret_file, &generated);
                self.jwt_secret = generated;
            }
        }

        Ok(())
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 8085,
            data_dir: PathBuf::from("./data"),
            database_url: "openshell-server.db".to_string(),
            sync_username: None,
            sync_password: None,
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
