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
        } else if let Some(arr) = val.get("connections").and_then(|v| v.as_array()) {
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

                let protocol = match obj
                    .get("conection_type")
                    .or_else(|| obj.get("connection_type"))
                {
                    None => Protocol::Ssh,
                    Some(Value::Number(n)) if n.as_u64() == Some(100) => Protocol::Ssh,
                    Some(Value::String(kind)) if kind == "100" => Protocol::Ssh,
                    Some(Value::String(kind)) => match kind.to_ascii_lowercase().as_str() {
                        "ssh" => Protocol::Ssh,
                        "rdp" | "mstsc" | "windows" => Protocol::Rdp,
                        _ => return Err(format!("unsupported FinalShell connection type: {kind}")),
                    },
                    Some(kind) => {
                        return Err(format!("unsupported FinalShell connection type: {kind}"))
                    }
                };

                let port = obj
                    .get("port")
                    .and_then(|v| {
                        v.as_u64()
                            .and_then(|p| u16::try_from(p).ok())
                            .or_else(|| v.as_str()?.parse().ok())
                    })
                    .filter(|p| *p > 0)
                    .or_else(|| protocol.default_port());

                let username = obj
                    .get("user_name")
                    .or_else(|| obj.get("username"))
                    .or_else(|| obj.get("user"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| (protocol == Protocol::Ssh).then(|| "root".to_string()));

                let auth_type_val = obj
                    .get("auth_type")
                    .or_else(|| obj.get("auth_method"))
                    .and_then(|v| v.as_str().or_else(|| v.as_u64().map(|_| "password")));

                let auth_method = match auth_type_val {
                    Some("publickey") | Some("key") | Some("1") => AuthMethod::PublicKey,
                    _ => AuthMethod::Password,
                };

                let notes = obj
                    .get("description")
                    .or_else(|| obj.get("memo"))
                    .or_else(|| obj.get("notes"))
                    .and_then(|v| v.as_str())
                    .map(String::from);

                let proxy_id = obj
                    .get("proxy_id")
                    .and_then(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .or_else(|| v.as_i64().map(|id| id.to_string()))
                    })
                    .filter(|id| !id.trim().is_empty());
                let mut options = serde_json::Map::new();
                for key in [
                    "fullscreen",
                    "custom_size",
                    "width",
                    "height",
                    "drivestoredirect",
                    "redirect_clipboard",
                    "redirect_printers",
                    "redirect_audio",
                    "domain",
                    "admin_session",
                    "accelerate",
                    "exec_channel_enable",
                    "backspace_key_sequence",
                    "delete_key_sequence",
                    "port_forwarding_list",
                ] {
                    if let Some(value) = obj.get(key) {
                        options.insert(key.to_string(), value.clone());
                    }
                }

                sessions.push(SessionInput {
                    name: name.or_else(|| host.clone()),
                    protocol: Some(protocol),
                    host,
                    port,
                    username,
                    auth_method: Some(auth_method),
                    host_key_policy: Some(HostKeyPolicy::AcceptNew),
                    notes,
                    proxy_id,
                    startup_command: obj
                        .get("startup_command")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    working_dir: obj
                        .get("working_dir")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    compression: obj.get("compression").and_then(Value::as_bool),
                    agent_forwarding: obj.get("agent_forwarding").and_then(Value::as_bool),
                    x11_forwarding: obj.get("x11_forwarding").and_then(Value::as_bool),
                    auto_reconnect: obj.get("auto_reconnect").and_then(Value::as_bool),
                    reconnect_max: obj.get("reconnect_max").and_then(Value::as_i64),
                    protocol_options_json: (!options.is_empty()).then_some(Value::Object(options)),
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

    #[test]
    fn imports_rdp_and_advanced_ssh_fields() {
        let parsed = FinalShellParser::parse_json(
            r#"{ "connections": [
            {"host":"win.test", "conection_type":"windows", "description":"Desktop",
             "proxy_id":"proxy-1", "fullscreen":true, "custom_size":true,
             "width":1600, "height":900, "drivestoredirect":true},
            {"host":"ssh.test", "connection_type":100, "exec_channel_enable":false,
             "accelerate":true, "backspace_key_sequence":"ctrl_h",
             "delete_key_sequence":"vt220", "startup_command":"pwd",
             "port_forwarding_list":[{"type":"L", "local_port":8080}]}
        ]}"#,
        )
        .unwrap();
        assert_eq!(parsed[0].protocol, Some(Protocol::Rdp));
        assert_eq!(parsed[0].port, Some(3389));
        assert_eq!(parsed[0].username, None);
        assert_eq!(parsed[0].notes.as_deref(), Some("Desktop"));
        assert_eq!(parsed[0].proxy_id.as_deref(), Some("proxy-1"));
        let opts = parsed[0].protocol_options_json.as_ref().unwrap();
        assert_eq!(opts["fullscreen"], true);
        assert_eq!(opts["custom_size"], true);
        assert_eq!(opts["width"], 1600);
        assert_eq!(opts["height"], 900);
        assert_eq!(opts["drivestoredirect"], true);
        assert_eq!(parsed[1].protocol, Some(Protocol::Ssh));
        assert_eq!(parsed[1].port, Some(22));
        assert_eq!(parsed[1].startup_command.as_deref(), Some("pwd"));
        let opts = parsed[1].protocol_options_json.as_ref().unwrap();
        assert_eq!(opts["exec_channel_enable"], false);
        assert_eq!(opts["accelerate"], true);
        assert_eq!(opts["backspace_key_sequence"], "ctrl_h");
        assert_eq!(opts["delete_key_sequence"], "vt220");
        assert_eq!(opts["port_forwarding_list"][0]["local_port"], 8080);
    }

    #[test]
    fn rejects_unknown_connection_type() {
        assert!(
            FinalShellParser::parse_json(r#"{"host":"host.test", "conection_type":999}"#).is_err()
        );
    }
}
