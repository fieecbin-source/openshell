use openshell_app_core::network_secrets::{LegacyRecoveryEntry, LegacyRecoveryItem};
use openshell_app_core::AppServices;
use openshell_core_domain::{DomainError, DomainResult};
use std::path::PathBuf;
use zeroize::Zeroizing;

fn password_text(buffer: &[u16]) -> DomainResult<Zeroizing<String>> {
    let length = buffer
        .iter()
        .position(|&value| value == 0)
        .unwrap_or(buffer.len());
    let text = String::from_utf16(&buffer[..length])
        .map_err(|_| DomainError::validation("主密码格式无效"))?;
    if text.is_empty() {
        return Err(DomainError::validation("请输入主密码"));
    }
    Ok(Zeroizing::new(text))
}

/// 逐条补录或取消保留。取消时原数据库与备份保持不动，可重新启动重试。
pub enum RecoveryDecision {
    Apply(Vec<LegacyRecoveryEntry>),
    Cancel,
}

/// 只由安全元数据构成的逐条提示文案：不含引用原值、口令或任何旧库内容。
pub fn recovery_prompt_labels(items: &[LegacyRecoveryItem]) -> Vec<String> {
    items
        .iter()
        .map(|item| {
            format!(
                "规则「{}」监听端口 {} 的 SOCKS 密码来源不明，请输入新密码；取消将保留原数据库与备份。",
                item.name, item.bind_port
            )
        })
        .collect()
}

/// 启动恢复编排。两个 prompt 可注入，使无图形环境也能证明调用链可达。
/// 主密码错误在此即失败；取消保留由 AppServices 保证不写库、不覆盖备份。
pub fn recover_with_reentry<M, R>(
    data_dir: PathBuf,
    prompt_master: M,
    prompt_items: R,
) -> DomainResult<AppServices>
where
    M: FnOnce() -> DomainResult<Zeroizing<String>>,
    R: FnOnce(&[LegacyRecoveryItem]) -> DomainResult<RecoveryDecision>,
{
    let password = prompt_master()?;
    let items = AppServices::inspect_legacy_recovery(data_dir.clone(), password.as_str())?;
    if items.is_empty() {
        return AppServices::recover_legacy_network_secrets(data_dir, password.as_str());
    }
    match prompt_items(&items)? {
        RecoveryDecision::Apply(entries) => {
            AppServices::recover_legacy_network_secrets_with_reentry(
                data_dir,
                password.as_str(),
                &entries,
            )
        }
        // 取消是「可重试的启动中止」：保留 AppServices 的错误文案，不写库、不覆盖备份。
        RecoveryDecision::Cancel => AppServices::cancel_legacy_recovery().and_then(|()| {
            Err(DomainError::new(
                openshell_core_domain::ErrorCode::VaultLocked,
                "已取消数据恢复；原数据库与备份保持不变，可重新启动后重试",
            ))
        }),
    }
}

#[cfg(windows)]
mod native {
    use super::{password_text, LegacyRecoveryEntry, LegacyRecoveryItem, RecoveryDecision};
    use openshell_core_domain::{DomainError, DomainResult, ErrorCode};
    use std::ffi::c_void;
    use zeroize::Zeroizing;

    #[repr(C)]
    struct CredUiInfo {
        size: u32,
        owner: *mut c_void,
        message: *const u16,
        caption: *const u16,
        banner: *mut c_void,
    }

    #[link(name = "credui")]
    extern "system" {
        fn CredUIPromptForCredentialsW(
            info: *const CredUiInfo,
            target: *const u16,
            reserved: *mut c_void,
            error: u32,
            user: *mut u16,
            user_size: u32,
            password: *mut u16,
            password_size: u32,
            save: *mut i32,
            flags: u32,
        ) -> u32;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// 返回 None 表示用户取消；口令缓冲区与解码后的临时值均由 Zeroizing 清零。
    fn prompt_password(message: &str, caption: &str) -> DomainResult<Option<Zeroizing<String>>> {
        let text = wide(message);
        let title = wide(caption);
        let target = wide("OpenShell Vault Recovery");
        let info = CredUiInfo {
            size: std::mem::size_of::<CredUiInfo>() as u32,
            owner: std::ptr::null_mut(),
            message: text.as_ptr(),
            caption: title.as_ptr(),
            banner: std::ptr::null_mut(),
        };
        let mut user = Zeroizing::new(vec![0u16; 514]);
        let label = wide("OpenShell");
        user[..label.len()].copy_from_slice(&label);
        let mut password = Zeroizing::new(vec![0u16; 514]);
        let mut save = 0;
        // Generic credentials with DO_NOT_PERSIST never touch Credential Manager.
        let result = unsafe {
            CredUIPromptForCredentialsW(
                &info,
                target.as_ptr(),
                std::ptr::null_mut(),
                0,
                user.as_mut_ptr(),
                user.len() as u32,
                password.as_mut_ptr(),
                password.len() as u32,
                &mut save,
                0x40000 | 0x80 | 0x2 | 0x8 | 0x100000,
            )
        };
        if result == 1223 {
            return Ok(None);
        }
        if result != 0 {
            return Err(DomainError::new(ErrorCode::Io, "无法打开密码输入窗口"));
        }
        password_text(&password).map(Some)
    }

    pub fn prompt() -> DomainResult<Zeroizing<String>> {
        prompt_password(
            "输入保险库主密码以升级数据；尚未初始化时，此密码将用于创建保险库。",
            "OpenShell 数据恢复",
        )?
        .ok_or_else(|| DomainError::new(ErrorCode::VaultLocked, "已取消数据恢复"))
    }

    /// Windows 启动前逐条补录：提示仅含规则名与端口，绝不含引用原值。
    pub fn prompt_reentries(items: &[LegacyRecoveryItem]) -> DomainResult<RecoveryDecision> {
        let labels = super::recovery_prompt_labels(items);
        let mut entries = Vec::with_capacity(items.len());
        for (item, label) in items.iter().zip(labels) {
            let password = match prompt_password(&label, "OpenShell 凭据逐条补录")? {
                Some(password) => password,
                None => return Ok(RecoveryDecision::Cancel),
            };
            entries.push(LegacyRecoveryEntry {
                rule_id: item.rule_id.clone(),
                password,
            });
        }
        Ok(RecoveryDecision::Apply(entries))
    }
}

#[cfg(windows)]
pub use native::{prompt, prompt_reentries};

#[cfg(not(windows))]
pub fn prompt() -> DomainResult<Zeroizing<String>> {
    Err(DomainError::new(
        openshell_core_domain::ErrorCode::Unsupported,
        "当前平台不提供启动前凭据输入；请在 Windows 上使用凭据恢复入口逐条补录，或先恢复秘密备份后再启动。原数据库与备份保持不变，可重试。",
    ))
}

/// 非 Windows 无启动前逐条输入能力：明确可操作路径，原库与备份保持不动、可重试。
#[cfg(not(windows))]
pub fn prompt_reentries(_items: &[LegacyRecoveryItem]) -> DomainResult<RecoveryDecision> {
    Err(DomainError::new(
        openshell_core_domain::ErrorCode::Unsupported,
        "当前平台不提供启动前逐条补录窗口；请在 Windows 上使用凭据恢复入口逐条补录，或先恢复秘密备份后再启动。原数据库与备份保持不变，可重试。",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::{AppPaths, PortForwardId};
    use openshell_store::{Store, VaultRepo};
    use openshell_vault::KdfParams;
    use std::cell::{Cell, RefCell};
    use std::path::Path;

    const MASTER: &str = "synthetic-desktop-master";
    const BAD_REF: &str = "synthetic-unknown-reference";

    fn initialized_profile(with_broken_rule: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let app = AppServices::new(dir.path().to_path_buf()).unwrap();
        app.vault
            .init(
                MASTER,
                false,
                Some(KdfParams {
                    mem_kib: 1024,
                    time: 1,
                    parallelism: 1,
                }),
            )
            .unwrap();
        if with_broken_rule {
            let id = PortForwardId::new().to_string();
            app.store
                .with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO port_forward(id,name,type,bind_host,bind_port,socks_password_ref,created_at,updated_at) \
                         VALUES(?1,'legacy','dynamic','127.0.0.1',1080,?2,1,1)",
                        [id.as_str(), BAD_REF],
                    )
                    .unwrap();
                    Ok(())
                })
                .unwrap();
        }
        drop(app);
        dir
    }

    /// Task8 T7-02：未初始化旧库（vault 表为空）的可注入编排 fixture。
    /// 故意不调用 `vault.init()`，模拟升级前尚未创建保险库的旧数据目录。
    fn uninitialized_profile(with_broken_rule: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let app = AppServices::new(dir.path().to_path_buf()).unwrap();
        if with_broken_rule {
            let id = PortForwardId::new().to_string();
            app.store
                .with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO port_forward(id,name,type,bind_host,bind_port,socks_password_ref,created_at,updated_at) \
                         VALUES(?1,'legacy','dynamic','127.0.0.1',1080,?2,1,1)",
                        [id.as_str(), BAD_REF],
                    )
                    .unwrap();
                    Ok(())
                })
                .unwrap();
        }
        drop(app);
        dir
    }

    fn vault_is_uninitialized(root: &Path) -> bool {
        let store = Store::open(&AppPaths::new(root.to_path_buf()).db_path).unwrap();
        VaultRepo::new(store).load().unwrap().is_none()
    }

    fn assert_original_reference_untouched(root: &Path) {
        let store = Store::open(&AppPaths::new(root.to_path_buf()).db_path).unwrap();
        store
            .with_conn(|conn| {
                let reference: String = conn
                    .query_row(
                        "SELECT socks_password_ref FROM port_forward WHERE name='legacy'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(reference, BAD_REF);
                let count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM secret", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(count, 0, "取消与失败路径不得写入任何秘密");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn password_decode_preserves_unicode_and_rejects_empty_or_invalid_utf16() {
        assert_eq!(
            password_text(&"密码😀\0unused".encode_utf16().collect::<Vec<_>>())
                .unwrap()
                .as_str(),
            "密码😀"
        );
        assert!(password_text(&[0]).is_err());
        assert!(password_text(&[0xd800, 0]).is_err());
    }

    #[test]
    fn recovery_prompts_expose_only_safe_metadata() {
        let items = vec![
            LegacyRecoveryItem {
                rule_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
                name: "legacy".into(),
                bind_port: 1080,
            },
            LegacyRecoveryItem {
                rule_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV2".into(),
                name: "legacy-2".into(),
                bind_port: 1081,
            },
        ];
        let labels = recovery_prompt_labels(&items);
        assert_eq!(labels.len(), 2);
        for label in &labels {
            assert!(label.contains("监听端口"));
            assert!(label.contains("取消将保留原数据库与备份"));
            assert!(!label.contains("socks_password_ref"));
            assert!(!label.contains("plain-old-password"));
        }
        let serialized = serde_json::to_string(&items).unwrap();
        assert!(!serialized.contains("socks_password_ref"));
        assert!(!serialized.contains("password"));
    }

    #[test]
    fn cancel_decision_is_representable_without_any_library_write() {
        // 取消分支只返回决策，不接触 Store；路径由 AppServices::cancel_legacy_recovery 保证。
        let decision = RecoveryDecision::Cancel;
        assert!(matches!(decision, RecoveryDecision::Cancel));
        assert!(AppServices::cancel_legacy_recovery().is_err());
    }

    /// 启动恢复编排：逐条补录提示只含安全元数据，取消保留原库且可重试。
    #[test]
    fn recovery_orchestration_offers_safe_metadata_and_cancel_keeps_retry() {
        let dir = initialized_profile(true);
        let root = dir.path().to_path_buf();
        let seen = RefCell::new(Vec::<LegacyRecoveryItem>::new());
        let result = recover_with_reentry(
            root.clone(),
            || Ok(Zeroizing::new(MASTER.to_owned())),
            |items| {
                *seen.borrow_mut() = items.to_vec();
                Ok(RecoveryDecision::Cancel)
            },
        );
        let error = match result {
            Ok(_) => panic!("取消必须给出可重试的明确结果"),
            Err(error) => error,
        };
        assert!(error.message.contains("取消"));
        assert!(!error.message.contains(BAD_REF));
        assert!(!error.message.contains(MASTER));

        let entries = {
            let items = seen.borrow();
            assert_eq!(items.len(), 1, "坏引用规则必须可逐条补录");
            let serialized = serde_json::to_string(&*items).unwrap();
            assert!(!serialized.contains(BAD_REF));
            assert!(!serialized.contains("socks_password_ref"));
            assert!(!serialized.contains(MASTER));
            let labels = recovery_prompt_labels(&items);
            assert_eq!(labels.len(), 1);
            assert!(!labels[0].contains(BAD_REF));
            items
                .iter()
                .map(|item| LegacyRecoveryEntry {
                    rule_id: item.rule_id.clone(),
                    password: Zeroizing::new("synthetic-desktop-new-socks".to_owned()),
                })
                .collect::<Vec<_>>()
        };
        assert_original_reference_untouched(&root);

        let services = recover_with_reentry(
            root,
            || Ok(Zeroizing::new(MASTER.to_owned())),
            |_| Ok(RecoveryDecision::Apply(entries)),
        )
        .expect("取消后重新启动仍可逐条补录");
        let reference = services
            .store
            .with_conn(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT socks_password_ref FROM port_forward WHERE name='legacy'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap())
            })
            .unwrap();
        assert_ne!(reference, BAD_REF);
        assert_eq!(
            services
                .network_secrets
                .resolve(&reference, "socks_password")
                .unwrap()
                .as_str(),
            "synthetic-desktop-new-socks"
        );
    }

    /// 逐条输入新口令后恢复成功，且原库只有该规则被修复。
    #[test]
    fn recovery_orchestration_applies_per_rule_reentry() {
        let dir = initialized_profile(true);
        let services = recover_with_reentry(
            dir.path().to_path_buf(),
            || Ok(Zeroizing::new(MASTER.to_owned())),
            |items| {
                assert_eq!(items.len(), 1);
                Ok(RecoveryDecision::Apply(
                    items
                        .iter()
                        .map(|item| LegacyRecoveryEntry {
                            rule_id: item.rule_id.clone(),
                            password: Zeroizing::new("synthetic-desktop-applied".to_owned()),
                        })
                        .collect(),
                ))
            },
        )
        .expect("逐条补录后应能完成恢复");
        let reference = services
            .store
            .with_conn(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT socks_password_ref FROM port_forward WHERE name='legacy'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap())
            })
            .unwrap();
        assert_eq!(
            services
                .network_secrets
                .resolve(&reference, "socks_password")
                .unwrap()
                .as_str(),
            "synthetic-desktop-applied"
        );
    }

    /// 错误主密码在逐条输入之前即失败，不触发任何提示、不写库。
    #[test]
    fn wrong_master_password_stops_before_per_rule_prompt() {
        let dir = initialized_profile(true);
        let called = Cell::new(false);
        let result = recover_with_reentry(
            dir.path().to_path_buf(),
            || Ok(Zeroizing::new("synthetic-wrong-master".to_owned())),
            |_| {
                called.set(true);
                Ok(RecoveryDecision::Cancel)
            },
        );
        assert!(result.is_err());
        assert!(!called.get(), "主密码错误时不得要求逐条补录");
        assert_original_reference_untouched(dir.path());
    }

    /// 无待补录项时不打扰用户，恢复入口仍可正常启动。
    #[test]
    fn clean_store_skips_per_rule_prompt_and_starts_normally() {
        let dir = initialized_profile(false);
        let called = Cell::new(false);
        let services = recover_with_reentry(
            dir.path().to_path_buf(),
            || Ok(Zeroizing::new(MASTER.to_owned())),
            |_| {
                called.set(true);
                Ok(RecoveryDecision::Cancel)
            },
        )
        .expect("干净库无需逐条补录");
        assert!(!called.get());
        assert_eq!(
            services.store.schema_version().unwrap(),
            openshell_store::SCHEMA_VERSION
        );
    }

    /// Task8 T7-02：未初始化旧库经可注入编排取消后，不得创建 vault 或固定第一次主密码。
    #[test]
    fn uninitialized_recovery_cancel_keeps_vault_empty_and_accepts_a_new_master() {
        let dir = uninitialized_profile(true);
        let root = dir.path().to_path_buf();
        let first = "synthetic-first-desktop-master";
        let second = "synthetic-second-desktop-master";
        assert!(vault_is_uninitialized(&root));

        let cancelled = recover_with_reentry(
            root.clone(),
            || Ok(Zeroizing::new(first.to_owned())),
            |items| {
                assert_eq!(items.len(), 1);
                Ok(RecoveryDecision::Cancel)
            },
        );
        assert!(cancelled.is_err());
        assert!(
            vault_is_uninitialized(&root),
            "检查/取消不得创建 vault 记录或绑定第一次口令"
        );
        assert_original_reference_untouched(&root);

        let services = recover_with_reentry(
            root.clone(),
            || Ok(Zeroizing::new(second.to_owned())),
            |items| {
                assert_eq!(items.len(), 1);
                Ok(RecoveryDecision::Apply(
                    items
                        .iter()
                        .map(|item| LegacyRecoveryEntry {
                            rule_id: item.rule_id.clone(),
                            password: Zeroizing::new("synthetic-desktop-second-try".to_owned()),
                        })
                        .collect(),
                ))
            },
        )
        .expect("取消后换新主密码重试必须成功");
        assert!(
            services.vault.unlock(Some(first), false).is_err(),
            "第一次口令不得被绑定"
        );
        services.vault.unlock(Some(second), false).unwrap();
        let reference = services
            .store
            .with_conn(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT socks_password_ref FROM port_forward WHERE name='legacy'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap())
            })
            .unwrap();
        assert_eq!(
            services
                .network_secrets
                .resolve(&reference, "socks_password")
                .unwrap()
                .as_str(),
            "synthetic-desktop-second-try"
        );
    }

    /// Task8 T7-02：未初始化旧库的部分失败补录必须整事务回滚，不留下已绑定主密码。
    #[test]
    fn uninitialized_recovery_failed_reentry_leaves_no_vault_or_secret() {
        let dir = uninitialized_profile(true);
        let root = dir.path().to_path_buf();
        let result = recover_with_reentry(
            root.clone(),
            || Ok(Zeroizing::new(MASTER.to_owned())),
            |_| Ok(RecoveryDecision::Apply(Vec::new())),
        );
        assert!(result.is_err());
        assert!(
            vault_is_uninitialized(&root),
            "失败补录不得持久化 vault 或主密码绑定"
        );
        assert_original_reference_untouched(&root);
    }
}
