//! FinalShell 格式导入解析器（洁净室自研解析）。

use openshell_core_domain::{AuthMethod, HostKeyPolicy, Protocol, SessionInput};
use serde_json::Value;

pub struct FinalShellParser;

impl FinalShellParser {
    /// 解析 FinalShell JSON 导出格式。
    pub fn parse_json(json_str: &str) -> Result<Vec<SessionInput>, String> {
        let val: Value =
            serde_json::from_str(json_str).map_err(|e| format!("invalid JSON: {e}"))?;
        let mut sessions = Vec::new();

        // 支持顶层是数组，或顶层是对象含 "items" / "list" / "connections"
        let items = if let Some(arr) = val.as_array() {
            arr.clone()
        } else if let Some(arr) = val.get("items").and_then(|v| v.as_array()) {
            arr.clone()
        } else if let Some(arr) = val.get("list").and_then(|v| v.as_array()) {
            arr.clone()
        } else {
            vec![val]
        };

        for item in items {
            if let Some(obj) = item.as_object() {
                let name = obj
                    .get("name")
                    .or_else(|| obj.get("host_name"))
                    .or_else(|| obj.get("title"))
                    .and_then(|v| v.as_str())
                    .map(String::from);

                let host = obj
                    .get("host")
                    .or_else(|| obj.get("ip"))
                    .or_else(|| obj.get("hostname"))
                    .and_then(|v| v.as_str())
                    .map(String::from);

                if host.is_none() {
                    continue;
                }

                let port = obj
                    .get("port")
                    .and_then(|v| {
                        v.as_u64()
                            .map(|p| p as u16)
                            .or_else(|| v.as_str()?.parse().ok())
                    })
                    .unwrap_or(22);

                let username = obj
                    .get("user_name")
                    .or_else(|| obj.get("username"))
                    .or_else(|| obj.get("user"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| "root".to_string());

                let auth_type_val = obj
                    .get("auth_type")
                    .or_else(|| obj.get("auth_method"))
                    .and_then(|v| v.as_str().or_else(|| v.as_u64().map(|_| "password")));

                let auth_method = match auth_type_val {
                    Some("publickey") | Some("key") | Some("1") => AuthMethod::PublicKey,
                    _ => AuthMethod::Password,
                };

                let notes = obj
                    .get("memo")
                    .or_else(|| obj.get("notes"))
                    .and_then(|v| v.as_str())
                    .map(String::from);

                sessions.push(SessionInput {
                    name: name.or_else(|| host.clone()),
                    protocol: Some(Protocol::Ssh),
                    host,
                    port: Some(port),
                    username: Some(username),
                    auth_method: Some(auth_method),
                    host_key_policy: Some(HostKeyPolicy::Strict),
                    notes,
                    ..Default::default()
                });
            }
        }

        Ok(sessions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_finalshell_format() {
        let sample = r#"[
            {
                "name": "Production Node",
                "host": "192.168.1.100",
                "port": 22,
                "user_name": "admin",
                "auth_type": "password",
                "memo": "Main prod server"
            },
            {
                "title": "Staging DB",
                "ip": "10.0.0.12",
                "port": 2200,
                "user": "postgres",
                "auth_method": "publickey"
            }
        ]"#;

        let res = FinalShellParser::parse_json(sample).expect("parse json");
        assert_eq!(res.len(), 2);
        assert_eq!(res[0].name.as_deref(), Some("Production Node"));
        assert_eq!(res[0].host.as_deref(), Some("192.168.1.100"));
        assert_eq!(res[0].port, Some(22));
        assert_eq!(res[0].username.as_deref(), Some("admin"));
        assert_eq!(res[0].auth_method, Some(AuthMethod::Password));

        assert_eq!(res[1].name.as_deref(), Some("Staging DB"));
        assert_eq!(res[1].host.as_deref(), Some("10.0.0.12"));
        assert_eq!(res[1].port, Some(2200));
        assert_eq!(res[1].auth_method, Some(AuthMethod::PublicKey));
    }
}
