//! OpenSSH config 格式解析器（对齐 SPEC IMP-001）。

use openshell_core_domain::{AuthMethod, HostKeyPolicy, Protocol, SessionInput};

#[derive(Debug, Clone, Default)]
pub struct OpenSshHostBlock {
    pub pattern: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub server_alive_interval: Option<i64>,
    pub local_forwards: Vec<String>,
    pub remote_forwards: Vec<String>,
    pub dynamic_forwards: Vec<String>,
    pub warnings: Vec<String>,
}

pub struct OpenSshParser;

impl OpenSshParser {
    /// 解析 OpenSSH config 文本内容。
    pub fn parse_config(content: &str) -> (Vec<OpenSshHostBlock>, Vec<String>) {
        let mut blocks: Vec<OpenSshHostBlock> = Vec::new();
        let mut global_warnings: Vec<String> = Vec::new();
        let mut current_block: Option<OpenSshHostBlock> = None;

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let mut tokens = trimmed.split_whitespace();
            let key = match tokens.next() {
                Some(k) => k,
                None => continue,
            };
            let value = tokens.collect::<Vec<&str>>().join(" ");

            if key.eq_ignore_ascii_case("Host") {
                if let Some(prev) = current_block.take() {
                    if prev.pattern != "*" {
                        blocks.push(prev);
                    }
                }
                current_block = Some(OpenSshHostBlock {
                    pattern: value,
                    ..Default::default()
                });
            } else if key.eq_ignore_ascii_case("Match") {
                global_warnings.push(format!("'Match' directive is not supported: {}", trimmed));
            } else if let Some(ref mut block) = current_block {
                match key.to_lowercase().as_str() {
                    "hostname" => block.hostname = Some(value),
                    "user" => block.user = Some(value),
                    "port" => {
                        if let Ok(p) = value.parse::<u16>() {
                            block.port = Some(p);
                        }
                    }
                    "identityfile" => block.identity_file = Some(value),
                    "proxyjump" => block.proxy_jump = Some(value),
                    "proxycommand" => {
                        block
                            .warnings
                            .push(format!("'ProxyCommand' is not supported: {}", value));
                    }
                    "serveraliveinterval" => {
                        if let Ok(sec) = value.parse::<i64>() {
                            block.server_alive_interval = Some(sec);
                        }
                    }
                    "localforward" => block.local_forwards.push(value),
                    "remoteforward" => block.remote_forwards.push(value),
                    "dynamicforward" => block.dynamic_forwards.push(value),
                    _ => {}
                }
            }
        }

        if let Some(last) = current_block {
            if last.pattern != "*" {
                blocks.push(last);
            }
        }

        (blocks, global_warnings)
    }

    /// 将解析后的 Host 块转换为 SessionInput 候选列表。
    pub fn to_session_inputs(blocks: &[OpenSshHostBlock]) -> Vec<SessionInput> {
        let mut sessions = Vec::new();

        for block in blocks {
            let host = block
                .hostname
                .clone()
                .unwrap_or_else(|| block.pattern.clone());
            let name = block.pattern.clone();
            let port = block.port.unwrap_or(22);
            let user = block.user.clone().unwrap_or_else(|| "root".to_string());
            let keepalive_sec = block.server_alive_interval.unwrap_or(30);

            let auth_method = if block.identity_file.is_some() {
                AuthMethod::PublicKey
            } else {
                AuthMethod::Password
            };

            let notes = if !block.warnings.is_empty() {
                Some(format!("Import warnings:\n{}", block.warnings.join("\n")))
            } else {
                None
            };

            sessions.push(SessionInput {
                name: Some(name),
                protocol: Some(Protocol::Ssh),
                host: Some(host),
                port: Some(port),
                username: Some(user),
                auth_method: Some(auth_method),
                host_key_policy: Some(HostKeyPolicy::AcceptNew),
                keepalive_sec: Some(keepalive_sec),
                notes,
                ..Default::default()
            });
        }

        sessions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_typical_openssh_config() {
        let sample = r#"
# Global comment
Host bastion
    HostName jump.example.com
    User admin
    Port 2222
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60

Host web-prod
    HostName 10.0.1.50
    User deploy
    ProxyJump bastion
    LocalForward 8080 127.0.0.1:80

Host legacy
    HostName old.example.com
    ProxyCommand connect -S socks:1080 %h %p
"#;

        let (blocks, warnings) = OpenSshParser::parse_config(sample);
        assert_eq!(blocks.len(), 3);
        assert_eq!(warnings.len(), 0);

        let bastion = &blocks[0];
        assert_eq!(bastion.pattern, "bastion");
        assert_eq!(bastion.hostname.as_deref(), Some("jump.example.com"));
        assert_eq!(bastion.user.as_deref(), Some("admin"));
        assert_eq!(bastion.port, Some(2222));
        assert_eq!(bastion.server_alive_interval, Some(60));

        let web = &blocks[1];
        assert_eq!(web.hostname.as_deref(), Some("10.0.1.50"));
        assert_eq!(web.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(web.local_forwards.len(), 1);

        let legacy = &blocks[2];
        assert_eq!(legacy.warnings.len(), 1);

        let inputs = OpenSshParser::to_session_inputs(&blocks);
        assert_eq!(inputs.len(), 3);
        assert_eq!(inputs[0].name.as_deref(), Some("bastion"));
        assert_eq!(inputs[0].port, Some(2222));
    }
}
