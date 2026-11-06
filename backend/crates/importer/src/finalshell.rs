//! FinalShell 格式导入解析器（洁净室自研解析）。

use openshell_core_domain::{
    AuthMethod, GroupId, HostKeyPolicy, PortForwardRuleInput, PortForwardType, Protocol, SessionId,
    SessionInput,
};
use serde_json::{Map, Value};

/// FinalShell `lv.C` / `lv.F`：连接类型常量。
const CONNECTION_TYPE_SSH: u64 = 100;
const CONNECTION_TYPE_RDP: u64 = 101;

/// FinalShell `lv.K` / `lv.n` / `lv.v`：认证方式常量。
const AUTH_TYPE_PASSWORD: u64 = 1;
const AUTH_TYPE_PUBLIC_KEY: u64 = 2;
const AUTH_TYPE_KEYBOARD_INTERACTIVE: u64 = 3;

/// FinalShell `YE.A` / `YE.H` / `YE.e`：端口转发类型常量。
const FORWARD_TYPE_LOCAL: u64 = 100;
const FORWARD_TYPE_REMOTE: u64 = 200;
const FORWARD_TYPE_DYNAMIC: u64 = 300;

/// `port_forwarding_list` 条目里可能携带认证信息的字段名。
///
/// 解析器只声明**输入安全边界**：这些字段的值一律不落库、不生成规则、不进入导出/备份；
/// 对应隧道条目标记为 `import_blocked`，由预览提示用户手动补录认证后重建。
/// 未确证 FinalShell 真实导出字段前，不声称能安全提取认证。
const FORWARD_AUTH_KEYS: [&str; 8] = [
    "socks_auth",
    "socks_username",
    "socks_password",
    "socks_password_ref",
    "password",
    "passwd",
    "auth_type",
    "authentication_type",
];

/// 判断字段值是否“携带了内容”（null 与空串视为没有）。
fn carries_value(value: &Value) -> bool {
    !value.is_null() && value.as_str().is_none_or(|text| !text.trim().is_empty())
}

/// 条目是否带认证信息（净化前的输入，或调用方绕过 [`FinalShellParser::parse_json`] 传入的原始列表）。
fn carries_auth(entry: &Map<String, Value>) -> bool {
    FORWARD_AUTH_KEYS
        .iter()
        .any(|key| entry.get(*key).is_some_and(carries_value))
}

/// 逐条净化 `port_forwarding_list`：剥除认证字段，并给该条目写 `import_blocked` 原因。
///
/// 返回面向预览的警告文本。被阻断的条目会保留绑定/目标等非秘密字段，
/// 但 [`FinalShellParser::extract_embedded_forwards`] 不会再把它变成规则，
/// 从根上避免「带认证的隧道被降级成无认证规则」。
fn sanitize_embedded_forwards(options: &mut Map<String, Value>) -> Vec<String> {
    let Some(items) = options
        .get_mut("port_forwarding_list")
        .and_then(Value::as_array_mut)
    else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    for (index, item) in items.iter_mut().enumerate() {
        let Some(entry) = item.as_object_mut() else {
            continue;
        };
        if !carries_auth(entry) {
            continue;
        }
        // 先记录字段名再删除，保证任何口令/引用文本都不会进入会话 JSON。
        let names: Vec<&str> = FORWARD_AUTH_KEYS
            .iter()
            .copied()
            .filter(|key| entry.get(*key).is_some_and(carries_value))
            .collect();
        for key in &names {
            entry.remove(*key);
        }
        entry.insert(
            "import_blocked".to_string(),
            Value::String(
                "该端口转发使用了暂不支持的认证配置，导入时已跳过；请手动重建隧道并重新填写认证"
                    .to_string(),
            ),
        );
        warnings.push(format!(
            "port_forwarding_list 第 {} 条使用了暂不支持的认证字段（{}），已跳过该隧道且未保存凭据",
            index + 1,
            names.join("、")
        ));
    }
    warnings
}

pub struct FinalShellParser;

/// 从 JSON 值中按候选键名取第一个非空字符串。
fn text_field(obj: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| obj.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 从 JSON 值中按候选键名取第一个可用端口（数字或数字字符串）。
fn port_field(obj: &Map<String, Value>, keys: &[&str]) -> Option<u16> {
    keys.iter().find_map(|key| {
        obj.get(*key).and_then(|value| {
            value
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .or_else(|| value.as_str()?.trim().parse().ok())
        })
    })
}

/// 解析 `port_forwarding_list` 每项的 `type`（FinalShell `YE.class` 常量或字符串别名）。
fn forward_type(value: Option<&Value>) -> Option<PortForwardType> {
    match value? {
        Value::Number(number) => match number.as_u64()? {
            FORWARD_TYPE_LOCAL => Some(PortForwardType::Local),
            FORWARD_TYPE_REMOTE => Some(PortForwardType::Remote),
            FORWARD_TYPE_DYNAMIC => Some(PortForwardType::Dynamic),
            _ => None,
        },
        Value::String(kind) => match kind.trim().to_ascii_lowercase().as_str() {
            "100" | "l" | "local" => Some(PortForwardType::Local),
            "200" | "r" | "remote" => Some(PortForwardType::Remote),
            "300" | "d" | "dynamic" => Some(PortForwardType::Dynamic),
            _ => None,
        },
        _ => None,
    }
}

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

                // FinalShell `lv.C = 100` → SSH；`lv.F = 101` → Windows 远程桌面 (RDP)。
                let protocol = match obj
                    .get("conection_type")
                    .or_else(|| obj.get("connection_type"))
                    .or_else(|| obj.get("protocol"))
                {
                    None => Protocol::Ssh,
                    Some(Value::Number(number)) => match number.as_u64() {
                        Some(CONNECTION_TYPE_SSH) => Protocol::Ssh,
                        Some(CONNECTION_TYPE_RDP) => Protocol::Rdp,
                        _ => {
                            return Err(format!("unsupported FinalShell connection type: {number}"))
                        }
                    },
                    Some(Value::String(kind)) => match kind.trim().to_ascii_lowercase().as_str() {
                        "100" | "ssh" => Protocol::Ssh,
                        "101" | "rdp" | "mstsc" | "windows" => Protocol::Rdp,
                        "serial" => Protocol::Serial,
                        "telnet" => Protocol::Telnet,
                        "local_shell" => Protocol::LocalShell,
                        "sftp" => Protocol::Sftp,
                        _ => return Err(format!("unsupported FinalShell connection type: {kind}")),
                    },
                    Some(kind) => {
                        return Err(format!("unsupported FinalShell connection type: {kind}"))
                    }
                };

                if protocol.requires_host() && host.is_none() {
                    continue;
                }

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

                // FinalShell `lv.K = 1` → 密码；`lv.n = 2` → 公钥；`lv.v = 3` → 键盘交互。
                // 实际导出的 JSON 键名为 `authentication_type`，其余键名作为兼容别名。
                let auth_method = match obj
                    .get("authentication_type")
                    .or_else(|| obj.get("auth_type"))
                    .or_else(|| obj.get("auth_method"))
                {
                    Some(Value::Number(number)) => match number.as_u64() {
                        Some(AUTH_TYPE_PUBLIC_KEY) => AuthMethod::PublicKey,
                        Some(AUTH_TYPE_KEYBOARD_INTERACTIVE) => AuthMethod::KeyboardInteractive,
                        // 1（密码）与无法识别的编号一律回落到密码，保持导入的容错性
                        Some(AUTH_TYPE_PASSWORD) => AuthMethod::Password,
                        _ => AuthMethod::Password,
                    },
                    Some(Value::String(kind)) => match kind.trim().to_ascii_lowercase().as_str() {
                        "2" | "publickey" | "public_key" | "key" => AuthMethod::PublicKey,
                        "3" | "keyboard_interactive" | "keyboard-interactive" => {
                            AuthMethod::KeyboardInteractive
                        }
                        "agent" => AuthMethod::Agent,
                        "none" => AuthMethod::None,
                        _ => AuthMethod::Password,
                    },
                    None if matches!(protocol, Protocol::Serial | Protocol::LocalShell) => {
                        AuthMethod::None
                    }
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
                let mut options = match obj.get("protocol_options_json") {
                    Some(Value::Object(options)) => options.clone(),
                    None | Some(Value::Null) => Map::new(),
                    Some(_) => return Err("protocol_options_json must be an object".to_string()),
                };
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
                    "port_name",
                    "baud_rate",
                    "data_bits",
                    "stop_bits",
                    "parity",
                    "flow_control",
                    "dtr_on_open",
                    "rts_on_open",
                    "input_newline",
                    "output_newline",
                    "local_echo",
                    "reconnect_interval_ms",
                    "shell_kind",
                    "shell_path",
                    "auto_login",
                    "login_prompt",
                    "password_prompt",
                    "newline_mode",
                ] {
                    if let Some(value) = obj.get(key) {
                        options.insert(key.to_string(), value.clone());
                    }
                }
                if protocol == Protocol::Serial {
                    if let Some(value) = obj.get("auto_reconnect") {
                        options.insert("auto_reconnect".to_string(), value.clone());
                    }
                }

                // 内嵌端口转发：认证字段在落库前剥除，被阻断的条目附原因供预览提示。
                let forward_warnings = sanitize_embedded_forwards(&mut options);
                if !forward_warnings.is_empty() {
                    options.insert(
                        "port_forwarding_warnings".to_string(),
                        Value::Array(forward_warnings.into_iter().map(Value::String).collect()),
                    );
                }

                // 终端编码统一归一化为小写（`UTF-8` → `utf-8`），后端按小写索引查找。
                let encoding = text_field(obj, &["terminal_encoding", "encoding"])
                    .map(|value| value.to_ascii_lowercase());

                sessions.push(SessionInput {
                    // 默认类型分组由展示层按 protocol 派生，不写入自定义分组表。
                    group_id: text_field(obj, &["group_id"])
                        .map(GroupId::from_string)
                        .transpose()
                        .map_err(|error| error.message)?,
                    name: name.or_else(|| host.clone()),
                    protocol: Some(protocol),
                    host,
                    port,
                    username,
                    auth_method: Some(auth_method),
                    host_key_policy: Some(HostKeyPolicy::AcceptNew),
                    encoding,
                    notes,
                    proxy_id,
                    proxy_jump_json: obj.get("proxy_jump_json").filter(|v| !v.is_null()).cloned(),
                    terminal_profile_id: text_field(obj, &["terminal_profile_id"]),
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
                    keepalive_sec: obj.get("keepalive_sec").and_then(Value::as_i64),
                    keepalive_max_miss: obj.get("keepalive_max_miss").and_then(Value::as_i64),
                    tags_json: obj.get("tags_json").filter(|v| !v.is_null()).cloned(),
                    favorite: obj.get("favorite").and_then(Value::as_bool),
                    color: text_field(obj, &["color"]),
                    icon_key: text_field(obj, &["icon_key"]),
                    sort_order: obj.get("sort_order").and_then(Value::as_i64),
                    protocol_options_json: (!options.is_empty()).then_some(Value::Object(options)),
                    ..Default::default()
                });
            }
        }

        Ok(sessions)
    }

    /// 从 FinalShell 会话的 `protocol_options_json.port_forwarding_list` 中提取
    /// 内嵌端口转发规则（`YE.class` 结构），转换为可直接落库的 `PortForwardRuleInput`。
    ///
    /// 兼容两种写法：
    /// - 数字/单字母类型：`{"type": 100|200|300}` 或 `{"type": "L"|"R"|"D"}`；
    /// - 长键名写法：`bind_host` / `bind_port` / `local_port` / `dest_host` / `dest_port`。
    ///
    /// 只保留 `port > 0` 的有效条目，并跳过带认证的条目：
    /// 这些条目在 [`FinalShellParser::parse_json`] 里已被标记 `import_blocked`，
    /// 不能降级成无认证规则（否则等于把「配置了认证」悄悄变成「任何人都能连」）。
    pub fn extract_embedded_forwards(
        session_id: &SessionId,
        protocol_options_json: Option<&Value>,
        auto_reconnect: Option<bool>,
    ) -> Vec<PortForwardRuleInput> {
        let Some(items) = protocol_options_json
            .and_then(|options| options.get("port_forwarding_list"))
            .and_then(Value::as_array)
        else {
            return Vec::new();
        };

        let mut rules = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let Some(obj) = item.as_object() else {
                continue;
            };
            // 阻断标记（parse_json 净化时写入）；原始列表里仍带认证字段的条目同样跳过。
            if obj.contains_key("import_blocked") || carries_auth(obj) {
                continue;
            }
            let rule_type = forward_type(obj.get("type").or_else(|| obj.get("rule_type")))
                .unwrap_or(PortForwardType::Local);

            let bind_host = text_field(obj, &["ip", "bind_host", "local_host"])
                .unwrap_or_else(|| "127.0.0.1".to_string());
            let Some(bind_port) = port_field(obj, &["port", "bind_port", "local_port"]) else {
                continue;
            };
            if bind_port == 0 {
                continue;
            }
            let dest_host = text_field(
                obj,
                &["dst_address", "dest_host", "dst_host", "remote_host"],
            )
            .unwrap_or_else(|| "127.0.0.1".to_string());
            let dest_port = port_field(obj, &["dst_port", "dest_port", "remote_port"]);
            let name = text_field(obj, &["name", "title"])
                .unwrap_or_else(|| format!("{bind_host}:{bind_port}"));

            rules.push(PortForwardRuleInput {
                session_id: Some(session_id.clone()),
                name,
                rule_type: Some(rule_type),
                bind_host: Some(bind_host),
                bind_port,
                dest_host: Some(dest_host),
                dest_port,
                auto_start: Some(false),
                auto_reconnect: Some(
                    obj.get("auto_reconnect")
                        .and_then(Value::as_bool)
                        .or(auto_reconnect)
                        .unwrap_or(true),
                ),
                reconnect_max: obj.get("reconnect_max").and_then(Value::as_i64),
                socks_auth: None,
                socks_username: None,
                socks_password_ref: None,
                socks_password: None,
                socks_clear_password: None,
                expose_warning_ack: None,
                sort_order: Some(index as i64),
            });
        }
        rules
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_all_connection_protocols_without_materializing_default_groups() {
        for (kind, host, protocol, port) in [
            ("ssh", Some("ssh.test"), Protocol::Ssh, Some(22)),
            ("rdp", Some("win.test"), Protocol::Rdp, Some(3389)),
            ("telnet", Some("router.test"), Protocol::Telnet, Some(23)),
            ("serial", None, Protocol::Serial, None),
            ("local_shell", None, Protocol::LocalShell, None),
        ] {
            let source = serde_json::json!({
                "name": kind, "connection_type": kind, "host": host,
                "protocol_options_json": {"port_name":"COM7", "shell_kind":"cmd", "custom":[1,2,3], "auto_reconnect":false},
                "keepalive_sec": 45, "keepalive_max_miss": 8,
                "auto_reconnect": false, "reconnect_max": 12, "proxy_id":"proxy-1"
            });
            let parsed = FinalShellParser::parse_json(&source.to_string()).unwrap();
            assert_eq!(parsed.len(), 1, "{kind}");
            let input = &parsed[0];
            assert_eq!(input.protocol, Some(protocol));
            assert_eq!(input.port, port);
            assert_eq!(input.host.as_deref(), host);
            assert!(input.group_id.is_none());
            assert_eq!(
                input.protocol_options_json.as_ref(),
                Some(&source["protocol_options_json"])
            );
            assert_eq!(input.keepalive_sec, Some(45));
            assert_eq!(input.keepalive_max_miss, Some(8));
            assert_eq!(input.auto_reconnect, Some(false));
            assert_eq!(input.reconnect_max, Some(12));
            assert_eq!(input.proxy_id.as_deref(), Some("proxy-1"));
        }
    }

    #[test]
    fn preserves_custom_group_and_merges_flat_options_with_nested_options() {
        let group_id = openshell_core_domain::GroupId::new();
        let source = serde_json::json!({
            "protocol":"rdp", "host":"win.test", "group_id":group_id,
            "protocol_options_json":{"fullscreen":false,"domain":"EXAMPLE","width":1600},
            "fullscreen":true, "height":900
        });
        let parsed = FinalShellParser::parse_json(&source.to_string()).unwrap();
        assert_eq!(parsed[0].protocol, Some(Protocol::Rdp));
        assert_eq!(parsed[0].group_id.as_ref(), Some(&group_id));
        let options = parsed[0].protocol_options_json.as_ref().unwrap();
        assert_eq!(options["fullscreen"], true);
        assert_eq!(options["domain"], "EXAMPLE");
        assert_eq!(options["width"], 1600);
        assert_eq!(options["height"], 900);
    }

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

    #[test]
    fn imports_numeric_rdp_and_auth_constants() {
        // lv.F = 101 → RDP；lv.n = 2 → 公钥；lv.v = 3 → 键盘交互；lv.K = 1 → 密码
        let parsed = FinalShellParser::parse_json(
            r#"[
                {"host":"win.test","conection_type":101,"port":3389,
                 "authentication_type":2,"terminal_encoding":"GBK"},
                {"host":"ssh.test","conection_type":"101","authentication_type":"3"},
                {"host":"ssh2.test","conection_type":100,"authentication_type":1,
                 "terminal_encoding":"UTF-8"}
            ]"#,
        )
        .unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].protocol, Some(Protocol::Rdp));
        assert_eq!(parsed[0].auth_method, Some(AuthMethod::PublicKey));
        assert_eq!(parsed[0].encoding.as_deref(), Some("gbk"));
        assert_eq!(parsed[1].protocol, Some(Protocol::Rdp));
        assert_eq!(parsed[1].port, Some(3389));
        assert_eq!(parsed[1].auth_method, Some(AuthMethod::KeyboardInteractive));
        assert_eq!(parsed[2].protocol, Some(Protocol::Ssh));
        assert_eq!(parsed[2].auth_method, Some(AuthMethod::Password));
        assert_eq!(parsed[2].encoding.as_deref(), Some("utf-8"));
    }

    #[test]
    fn extracts_ye_port_forwarding_list() {
        let parsed = FinalShellParser::parse_json(
            r#"[{"host":"ssh.test","conection_type":100,
                 "port_forwarding_list":[
                    {"id":1,"name":"web","type":100,"ip":"127.0.0.1","port":8080,
                     "dst_address":"10.0.0.5","dst_port":80},
                    {"type":200,"bind_host":"0.0.0.0","bind_port":2222,"dest_host":"127.0.0.1",
                     "dest_port":22},
                    {"type":"D","port":1080},
                    {"type":100,"port":0}
                 ]}]"#,
        )
        .unwrap();
        let session_id = SessionId::from_string("01HTEST0000000000000000001".to_string()).unwrap();
        let options = parsed[0].protocol_options_json.clone();
        let rules =
            FinalShellParser::extract_embedded_forwards(&session_id, options.as_ref(), None);

        assert_eq!(rules.len(), 3, "端口为 0 的条目必须被跳过");
        assert_eq!(rules[0].name, "web");
        assert_eq!(rules[0].rule_type, Some(PortForwardType::Local));
        assert_eq!(rules[0].bind_host.as_deref(), Some("127.0.0.1"));
        assert_eq!(rules[0].bind_port, 8080);
        assert_eq!(rules[0].dest_host.as_deref(), Some("10.0.0.5"));
        assert_eq!(rules[0].dest_port, Some(80));
        assert_eq!(rules[0].auto_reconnect, Some(true));
        assert_eq!(rules[0].session_id.as_ref(), Some(&session_id));

        assert_eq!(rules[1].rule_type, Some(PortForwardType::Remote));
        assert_eq!(rules[1].bind_host.as_deref(), Some("0.0.0.0"));
        assert_eq!(rules[1].bind_port, 2222);
        assert_eq!(rules[1].dest_port, Some(22));

        assert_eq!(rules[2].rule_type, Some(PortForwardType::Dynamic));
        assert_eq!(rules[2].bind_port, 1080);
        assert_eq!(rules[2].dest_host.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn embedded_forwards_respects_auto_reconnect_flag() {
        let parsed = FinalShellParser::parse_json(
            r#"[{"host":"ssh.test","auto_reconnect":false,
                 "port_forwarding_list":[{"type":100,"port":8081}]}]"#,
        )
        .unwrap();
        let session_id = SessionId::from_string("01HTEST0000000000000000002".to_string()).unwrap();
        let rules = FinalShellParser::extract_embedded_forwards(
            &session_id,
            parsed[0].protocol_options_json.as_ref(),
            parsed[0].auto_reconnect,
        );
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].auto_reconnect, Some(false));

        let options = serde_json::json!({"port_forwarding_list":[{
            "type":100, "port":8081, "auto_reconnect":true, "reconnect_max":2
        }]});
        let rules =
            FinalShellParser::extract_embedded_forwards(&session_id, Some(&options), Some(false));
        assert_eq!(rules[0].auto_reconnect, Some(true));
        assert_eq!(rules[0].reconnect_max, Some(2));
    }

    #[test]
    fn authenticated_embedded_forwards_are_blocked_and_secrets_never_persisted() {
        let password = format!(
            "synthetic-finalshell-{}",
            openshell_core_domain::SecretId::new()
        );
        let reference = openshell_core_domain::SecretId::new().to_string();
        let source = serde_json::json!([{
            "host":"ssh.test", "connection_type":100,
            "port_forwarding_list":[
                {"name":"socks","type":300,"ip":"127.0.0.1","port":1080,
                 "socks_auth":"user_pass","socks_username":"ops",
                 "socks_password": password, "socks_password_ref": reference},
                {"name":"web","type":100,"port":8080,"dst_address":"10.0.0.5","dst_port":80}
            ]
        }]);
        let parsed = FinalShellParser::parse_json(&source.to_string()).unwrap();

        // 1. 会话 JSON（落库/同步/导出/备份的载体）里不能出现任何口令或引用文本。
        let serialized = serde_json::to_string(&parsed).unwrap();
        assert!(!serialized.contains(&password));
        assert!(!serialized.contains(&reference));
        let blocked_entry = parsed[0].protocol_options_json.as_ref().unwrap()
            ["port_forwarding_list"][0]
            .as_object()
            .unwrap();
        for key in [
            "socks_auth",
            "socks_username",
            "socks_password",
            "socks_password_ref",
        ] {
            assert!(
                !blocked_entry.contains_key(key),
                "{key} leaked into session json"
            );
        }

        // 2. 被阻断条目保留非秘密字段，便于界面说明是哪条隧道需要补录。
        let options = parsed[0].protocol_options_json.as_ref().unwrap();
        let items = options["port_forwarding_list"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0]["import_blocked"]
            .as_str()
            .unwrap()
            .contains("认证"));
        assert_eq!(items[0]["port"], 1080);
        assert_eq!(items[0]["type"], 300);

        // 3. 预览必须显式提示，而不是静默丢掉隧道。
        let report = crate::ImportPreviewEngine::generate_preview(
            parsed.clone(),
            &[],
            crate::ConflictStrategy::Skip,
            Vec::new(),
        );
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("port_forwarding_list") && warning.contains("已跳过")));

        // 4. 只生成未带认证的那条；带认证的绝不降级成无认证规则。
        let session_id = SessionId::new();
        let rules = FinalShellParser::extract_embedded_forwards(&session_id, Some(options), None);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].name, "web");
        assert!(rules
            .iter()
            .all(|rule| rule.socks_auth.is_none() && rule.socks_password_ref.is_none()));
    }

    #[test]
    fn raw_authenticated_forwards_are_never_created_without_authentication() {
        // 调用方绕过 parse_json 直接传入原始列表时同样不能生成无认证规则。
        let options = serde_json::json!({"port_forwarding_list":[{
            "type":300, "port":1081, "password":"synthetic-not-a-real-secret"
        }]});
        let rules =
            FinalShellParser::extract_embedded_forwards(&SessionId::new(), Some(&options), None);
        assert!(rules.is_empty());
    }
}
