//! 导入预览与冲突解决（对齐 SPEC IMP-002）。

use openshell_core_domain::{Protocol, Session, SessionInput};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictStrategy {
    Skip,
    Overwrite,
    KeepBoth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateAction {
    Create,
    Update,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportCandidate {
    pub input: SessionInput,
    pub action: CandidateAction,
    pub existing_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreviewReport {
    pub total: usize,
    pub new_count: usize,
    pub update_count: usize,
    pub skip_count: usize,
    pub warnings: Vec<String>,
    pub candidates: Vec<ImportCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_token: Option<String>,
}

pub fn same_connection(a: &SessionInput, b: &SessionInput) -> bool {
    let protocol = a.protocol.unwrap_or(Protocol::Ssh);
    protocol == b.protocol.unwrap_or(Protocol::Ssh)
        && a.host
            .as_deref()
            .unwrap_or_default()
            .eq_ignore_ascii_case(b.host.as_deref().unwrap_or_default())
        && a.port.or_else(|| protocol.default_port()) == b.port.or_else(|| protocol.default_port())
        && a.username
            .as_deref()
            .unwrap_or_default()
            .eq_ignore_ascii_case(b.username.as_deref().unwrap_or_default())
        && match protocol {
            Protocol::Serial => {
                let port = |input: &SessionInput| {
                    input
                        .protocol_options_json
                        .as_ref()
                        .and_then(|v| v.get("port_name"))
                        .cloned()
                };
                port(a).is_some() && port(a) == port(b)
            }
            Protocol::LocalShell => {
                a.protocol_options_json == b.protocol_options_json
                    && a.working_dir == b.working_dir
                    && a.startup_command == b.startup_command
            }
            _ => true,
        }
}

pub struct ImportPreviewEngine;

fn copy_name(input: &SessionInput, candidates: &[ImportCandidate], existing: &[Session]) -> String {
    let name = input.name.as_deref().unwrap_or("会话");
    let mut index = 1;
    loop {
        let suffix = if index == 1 {
            " (副本)".to_owned()
        } else {
            format!(" (副本 {index})")
        };
        let candidate = format!(
            "{}{}",
            name.chars()
                .take(128 - suffix.chars().count())
                .collect::<String>(),
            suffix
        );
        if !candidates
            .iter()
            .any(|c| c.input.name.as_deref() == Some(&candidate))
            && !existing.iter().any(|s| s.name == candidate)
        {
            return candidate;
        }
        index += 1;
    }
}

impl ImportPreviewEngine {
    /// 对比候选会话与已有会话列表，生成预览报告。
    pub fn generate_preview(
        candidates: Vec<SessionInput>,
        existing_sessions: &[Session],
        strategy: ConflictStrategy,
        mut global_warnings: Vec<String>,
    ) -> ImportPreviewReport {
        let mut report_candidates: Vec<ImportCandidate> = Vec::new();

        for mut input in candidates {
            // 条目级导入提示（例如 FinalShell 内嵌转发因认证不受支持而被跳过）：
            // 会话本身仍可导入，但必须在预览里说明哪些隧道没有随之恢复。
            if let Some(warnings) = input
                .protocol_options_json
                .as_ref()
                .and_then(|options| options.get("port_forwarding_warnings"))
                .and_then(serde_json::Value::as_array)
            {
                global_warnings.extend(
                    warnings
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned),
                );
            }
            if let Some(reason) = input
                .protocol_options_json
                .as_ref()
                .and_then(|v| v.get("import_blocked"))
                .and_then(serde_json::Value::as_str)
            {
                global_warnings.push(reason.to_owned());
                report_candidates.push(ImportCandidate {
                    input,
                    action: CandidateAction::Skip,
                    existing_session_id: None,
                });
                continue;
            }
            let duplicate = report_candidates.iter().position(|previous| {
                previous.action != CandidateAction::Skip && same_connection(&previous.input, &input)
            });
            if let Some(index) = duplicate {
                match strategy {
                    ConflictStrategy::Skip => {
                        let existing_session_id =
                            report_candidates[index].existing_session_id.clone();
                        report_candidates.push(ImportCandidate {
                            input,
                            action: CandidateAction::Skip,
                            existing_session_id,
                        });
                        continue;
                    }
                    ConflictStrategy::Overwrite => {
                        let previous = &mut report_candidates[index];
                        let action = previous.action;
                        let existing_session_id = previous.existing_session_id.clone();
                        previous.action = CandidateAction::Skip;
                        report_candidates.push(ImportCandidate {
                            input,
                            action,
                            existing_session_id,
                        });
                        continue;
                    }
                    ConflictStrategy::KeepBoth => {}
                }
            }
            let protocol_match = input.protocol.unwrap_or(Protocol::Ssh);
            let host_match = input.host.as_deref().unwrap_or_default();
            let port_match = input.port.or_else(|| protocol_match.default_port());
            let user_match = input.username.as_deref().unwrap_or_default();

            let existing = existing_sessions.iter().find(|s| {
                s.protocol == protocol_match
                    && s.host
                        .as_deref()
                        .unwrap_or_default()
                        .eq_ignore_ascii_case(host_match)
                    && s.port.or_else(|| s.protocol.default_port()) == port_match
                    && s.username
                        .as_deref()
                        .unwrap_or_default()
                        .eq_ignore_ascii_case(user_match)
                    && match protocol_match {
                        Protocol::Serial => {
                            let port_name = input
                                .protocol_options_json
                                .as_ref()
                                .and_then(|options| options.get("port_name"))
                                .and_then(serde_json::Value::as_str)
                                .filter(|name| !name.is_empty());
                            port_name.is_some()
                                && port_name
                                    == s.protocol_options_json
                                        .as_ref()
                                        .and_then(|options| options.get("port_name"))
                                        .and_then(serde_json::Value::as_str)
                        }
                        Protocol::LocalShell => {
                            s.protocol_options_json == input.protocol_options_json
                                && s.working_dir == input.working_dir
                                && s.startup_command == input.startup_command
                        }
                        _ => true,
                    }
            });

            match existing {
                Some(existing_session) => match strategy {
                    ConflictStrategy::Skip => {
                        report_candidates.push(ImportCandidate {
                            input,
                            action: CandidateAction::Skip,
                            existing_session_id: Some(existing_session.id.as_str().to_string()),
                        });
                    }
                    ConflictStrategy::Overwrite => {
                        report_candidates.push(ImportCandidate {
                            input,
                            action: CandidateAction::Update,
                            existing_session_id: Some(existing_session.id.as_str().to_string()),
                        });
                    }
                    ConflictStrategy::KeepBoth => {
                        input.name = Some(copy_name(&input, &report_candidates, existing_sessions));
                        report_candidates.push(ImportCandidate {
                            input,
                            action: CandidateAction::Create,
                            existing_session_id: None,
                        });
                    }
                },
                None => {
                    if strategy == ConflictStrategy::KeepBoth && duplicate.is_some() {
                        input.name = Some(copy_name(&input, &report_candidates, existing_sessions));
                    }
                    report_candidates.push(ImportCandidate {
                        input,
                        action: CandidateAction::Create,
                        existing_session_id: None,
                    });
                }
            }
        }

        let new_count = report_candidates
            .iter()
            .filter(|c| c.action == CandidateAction::Create)
            .count();
        let update_count = report_candidates
            .iter()
            .filter(|c| c.action == CandidateAction::Update)
            .count();
        let skip_count = report_candidates
            .iter()
            .filter(|c| c.action == CandidateAction::Skip)
            .count();
        ImportPreviewReport {
            archive_token: None,
            total: report_candidates.len(),
            new_count,
            update_count,
            skip_count,
            warnings: global_warnings,
            candidates: report_candidates,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::SessionId;
    use serde_json::json;

    #[test]
    fn duplicates_in_one_batch_follow_conflict_strategy() {
        let first = SessionInput {
            name: Some("first".into()),
            host: Some("duplicate.test".into()),
            ..Default::default()
        };
        let mut last = first.clone();
        last.name = Some("last".into());
        for strategy in [
            ConflictStrategy::Skip,
            ConflictStrategy::Overwrite,
            ConflictStrategy::KeepBoth,
        ] {
            let report = ImportPreviewEngine::generate_preview(
                vec![first.clone(), last.clone()],
                &[],
                strategy,
                Vec::new(),
            );
            assert_eq!(
                report.new_count,
                if strategy == ConflictStrategy::KeepBoth {
                    2
                } else {
                    1
                }
            );
            assert_eq!(
                report.skip_count,
                if strategy == ConflictStrategy::KeepBoth {
                    0
                } else {
                    1
                }
            );
            let creates: Vec<_> = report
                .candidates
                .iter()
                .filter(|c| c.action == CandidateAction::Create)
                .collect();
            if strategy == ConflictStrategy::Overwrite {
                assert_eq!(creates[0].input.name.as_deref(), Some("last"));
            }
            if strategy == ConflictStrategy::KeepBoth {
                assert_ne!(creates[0].input.name, creates[1].input.name);
            }
        }
    }

    #[test]
    fn conflict_matching_uses_protocol_defaults_and_device_identity() {
        for (protocol, options, different_options) in [
            (Protocol::Rdp, json!({}), json!({})),
            (Protocol::Telnet, json!({}), json!({})),
            (
                Protocol::Serial,
                json!({"port_name":"COM1"}),
                json!({"port_name":"COM2"}),
            ),
            (
                Protocol::LocalShell,
                json!({"shell_kind":"cmd"}),
                json!({"shell_kind":"powershell"}),
            ),
        ] {
            let existing: Session = serde_json::from_value(json!({
                "id": SessionId::new(), "name":"existing", "protocol":protocol,
                "host":protocol.requires_host().then_some("server.test"), "port":protocol.default_port(), "username":null,
                "auth_method":"none", "host_key_policy":"strict", "encoding":"utf-8",
                "keepalive_sec":30, "keepalive_max_miss":3, "auto_reconnect":true,
                "reconnect_max":5, "compression":false, "agent_forwarding":false,
                "x11_forwarding":false, "favorite":false, "use_count":0, "sort_order":0,
                "created_at":0, "updated_at":0, "version":0, "dirty":false,
                "protocol_options_json":options
            }))
            .unwrap();
            let mut input = SessionInput {
                protocol: Some(protocol),
                host: protocol.requires_host().then(|| "server.test".to_string()),
                protocol_options_json: Some(options),
                ..Default::default()
            };
            let report = ImportPreviewEngine::generate_preview(
                vec![input.clone()],
                std::slice::from_ref(&existing),
                ConflictStrategy::Overwrite,
                Vec::new(),
            );
            assert_eq!(report.update_count, 1, "{protocol:?}");
            assert!(report.candidates[0].input.group_id.is_none());
            if !protocol.requires_host() {
                input.protocol_options_json = Some(different_options);
                let report = ImportPreviewEngine::generate_preview(
                    vec![input],
                    &[existing],
                    ConflictStrategy::Overwrite,
                    Vec::new(),
                );
                assert_eq!(report.new_count, 1, "{protocol:?}");
            }
        }
    }

    #[test]
    fn keep_both_avoids_names_already_used_by_earlier_imports() {
        let existing: Session = serde_json::from_value(json!({
            "id":SessionId::new(),"name":"host (副本)","protocol":"ssh","host":"same.invalid",
            "auth_method":"password","host_key_policy":"strict","encoding":"UTF-8","keepalive_sec":30,
            "keepalive_max_miss":3,"auto_reconnect":true,"reconnect_max":5,"compression":false,
            "agent_forwarding":false,"x11_forwarding":false,"favorite":false,"use_count":0,
            "sort_order":0,"created_at":0,"updated_at":0,"version":0,"dirty":false
        })).unwrap();
        let input = SessionInput {
            name: Some("host".into()),
            host: Some("same.invalid".into()),
            ..Default::default()
        };
        let report = ImportPreviewEngine::generate_preview(
            vec![input.clone(), input],
            std::slice::from_ref(&existing),
            ConflictStrategy::KeepBoth,
            vec![],
        );
        let names: std::collections::HashSet<_> = report
            .candidates
            .iter()
            .map(|c| c.input.name.as_ref().unwrap())
            .collect();
        assert_eq!(names.len(), 2);
        assert!(!names.contains(&existing.name));
    }

    #[test]
    fn protocol_is_part_of_import_conflict_identity() {
        let existing: Session = serde_json::from_value(json!({
            "id": SessionId::new(), "name": "existing SSH", "protocol": "ssh",
            "host": "server.test", "port": 22, "username": "user",
            "auth_method": "password", "host_key_policy": "strict",
            "encoding": "UTF-8", "keepalive_sec": 30, "keepalive_max_miss": 3,
            "auto_reconnect": true, "reconnect_max": 5, "compression": false,
            "agent_forwarding": false, "x11_forwarding": false, "favorite": false,
            "use_count": 0, "sort_order": 0, "created_at": 0, "updated_at": 0,
            "version": 0, "dirty": true
        }))
        .unwrap();
        for (protocol, expected) in [
            (Some(Protocol::Rdp), CandidateAction::Create),
            (Some(Protocol::Ssh), CandidateAction::Update),
            (None, CandidateAction::Update),
        ] {
            let input = SessionInput {
                protocol,
                host: Some("server.test".into()),
                port: Some(22),
                username: Some("user".into()),
                ..Default::default()
            };
            let report = ImportPreviewEngine::generate_preview(
                vec![input],
                std::slice::from_ref(&existing),
                ConflictStrategy::Overwrite,
                Vec::new(),
            );
            assert_eq!(report.candidates[0].action, expected);
            assert_eq!(
                report.candidates[0].existing_session_id.is_some(),
                expected == CandidateAction::Update
            );
        }
    }
}
