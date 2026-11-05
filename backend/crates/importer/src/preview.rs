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
}

pub struct ImportPreviewEngine;

impl ImportPreviewEngine {
    /// 对比候选会话与已有会话列表，生成预览报告。
    pub fn generate_preview(
        candidates: Vec<SessionInput>,
        existing_sessions: &[Session],
        strategy: ConflictStrategy,
        global_warnings: Vec<String>,
    ) -> ImportPreviewReport {
        let mut report_candidates = Vec::new();
        let mut new_count = 0;
        let mut update_count = 0;
        let mut skip_count = 0;

        for mut input in candidates {
            let protocol_match = input.protocol.unwrap_or(Protocol::Ssh);
            let host_match = input.host.as_deref().unwrap_or_default();
            let port_match = input.port.unwrap_or(22);
            let user_match = input.username.as_deref().unwrap_or_default();

            let existing = existing_sessions.iter().find(|s| {
                s.protocol == protocol_match
                    && s.host
                        .as_deref()
                        .unwrap_or_default()
                        .eq_ignore_ascii_case(host_match)
                    && s.port.unwrap_or(22) == port_match
                    && s.username
                        .as_deref()
                        .unwrap_or_default()
                        .eq_ignore_ascii_case(user_match)
            });

            match existing {
                Some(existing_session) => match strategy {
                    ConflictStrategy::Skip => {
                        skip_count += 1;
                        report_candidates.push(ImportCandidate {
                            input,
                            action: CandidateAction::Skip,
                            existing_session_id: Some(existing_session.id.as_str().to_string()),
                        });
                    }
                    ConflictStrategy::Overwrite => {
                        update_count += 1;
                        report_candidates.push(ImportCandidate {
                            input,
                            action: CandidateAction::Update,
                            existing_session_id: Some(existing_session.id.as_str().to_string()),
                        });
                    }
                    ConflictStrategy::KeepBoth => {
                        new_count += 1;
                        let old_name = input.name.unwrap_or_else(|| "会话".to_string());
                        input.name = Some(format!("{} (副本)", old_name));
                        report_candidates.push(ImportCandidate {
                            input,
                            action: CandidateAction::Create,
                            existing_session_id: None,
                        });
                    }
                },
                None => {
                    new_count += 1;
                    report_candidates.push(ImportCandidate {
                        input,
                        action: CandidateAction::Create,
                        existing_session_id: None,
                    });
                }
            }
        }

        ImportPreviewReport {
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
