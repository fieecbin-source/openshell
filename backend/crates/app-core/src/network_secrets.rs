//! Proxy/SOCKS credentials share the existing Vault secret store.
use openshell_core_domain::*;
use openshell_store::{models::bump_sync, repositories::secret::insert_secret_row};
use openshell_store::{PortForwardRepo, SecretRepo, SettingsRepo, Store, VaultRepo};
use openshell_vault::VaultManager;
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use std::sync::Arc;
use zeroize::Zeroizing;

/// `app_meta` 中记录「本库凭据已全部引用化」的来源标记。
///
/// 旧版本把 SOCKS 明文口令直接写进 `port_forward.socks_password_ref`（`secret` 表里没有对应行），
/// 而 `SecretId` 只校验「26 个 ASCII 字母数字」，因此**不能**用字符串形态区分明文口令与真实引用：
/// `abcdefghijklmnopqrstuvwxyz` 这类口令和合法 ULID 形状的口令都会被误判成缺失引用。
///
/// 标记仅记录已验证状态；缺标记也可能是引入标记前的引用库。
/// 缺失引用无法证明旧值是明文，必须保留原值并由用户通过密码输入补录。
const REFERENCE_STORE_MARKER: &str = "network_secrets.store";
const REFERENCE_STORE_VALUE: &str = "reference-v1";

fn table_exists(conn: &rusqlite::Connection, name: &str) -> DomainResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|_| DomainError::internal("无法读取数据库结构"))
}

fn app_meta_available(conn: &rusqlite::Connection) -> DomainResult<bool> {
    table_exists(conn, "app_meta")
}

/// schema v1 没有 `app_meta` 表；缺少标记不证明任何凭据来源。
fn marked_reference_store(conn: &rusqlite::Connection) -> DomainResult<bool> {
    if !app_meta_available(conn)? {
        return Ok(false);
    }
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key=?1",
            [REFERENCE_STORE_MARKER],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| DomainError::internal("无法读取凭据迁移来源"))?;
    Ok(value.as_deref() == Some(REFERENCE_STORE_VALUE))
}

fn mark_reference_store(conn: &rusqlite::Connection) -> DomainResult<()> {
    if !app_meta_available(conn)? {
        // schema v1 库还没有 `app_meta`；升级后的下一次启动会补写。
        return Ok(());
    }
    conn.execute(
        "INSERT INTO app_meta(key,value,updated_at) VALUES(?1,?2,?3) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        rusqlite::params![REFERENCE_STORE_MARKER, REFERENCE_STORE_VALUE, now_ms()],
    )
    .map_err(|_| DomainError::internal("无法记录凭据迁移来源"))?;
    Ok(())
}

/// 明确的代理明文或无法解析的 SOCKS 引用，均不能记为已验证。
fn has_unresolved_credentials(conn: &rusqlite::Connection) -> DomainResult<bool> {
    if table_exists(conn, "setting")? {
        let mut statement = conn
            .prepare("SELECT value_json FROM setting WHERE key='proxy_list'")
            .map_err(|_| DomainError::internal("无法读取代理列表"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| DomainError::internal("无法读取代理列表"))?;
        for row in rows {
            let raw = row.map_err(|_| DomainError::internal("无法读取代理列表"))?;
            let value: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|_| DomainError::validation("代理列表格式无效"))?;
            if value.as_array().is_some_and(|entries| {
                entries.iter().any(|proxy| {
                    proxy
                        .get("password")
                        .and_then(|v| v.as_str())
                        .is_some_and(|password| !password.is_empty())
                })
            }) {
                return Ok(true);
            }
        }
    }
    if table_exists(conn, "port_forward")? && table_exists(conn, "secret")? {
        let legacy: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM port_forward p WHERE p.socks_password_ref IS NOT NULL \
                 AND NOT EXISTS(SELECT 1 FROM secret s WHERE s.id=p.socks_password_ref \
                 AND s.record_type='socks_password' AND (s.deleted_at IS NULL OR s.deleted_at=0)))",
                [],
                |row| row.get(0),
            )
            .map_err(|_| DomainError::internal("无法读取转发规则"))?;
        if legacy {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 列举用的凭据状态。只描述状态，不描述引用内容。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForwardCredentialState {
    None,
    Ready,
    NeedsReentry,
}

/// 脱敏列举视图：坏行不会携带来源不明的引用原值。
#[derive(Debug, Clone, Serialize)]
pub struct ForwardRuleView {
    #[serde(flatten)]
    pub rule: PortForwardRule,
    pub credential_state: ForwardCredentialState,
}

/// 旧库启动恢复用的安全元数据：绝不包含引用原值或旧口令。
#[derive(Debug, Clone, Serialize)]
pub struct LegacyRecoveryItem {
    pub rule_id: String,
    pub name: String,
    pub bind_port: u16,
}

/// 用户逐条显式输入的新口令；临时值在离开作用域时清零。
pub struct LegacyRecoveryEntry {
    pub rule_id: String,
    pub password: Zeroizing<String>,
}

fn unresolved_forward_items(conn: &rusqlite::Connection) -> DomainResult<Vec<LegacyRecoveryItem>> {
    let mut statement = conn
        .prepare(
            "SELECT p.id, p.name, p.bind_port FROM port_forward p \
             LEFT JOIN secret s ON s.id = p.socks_password_ref \
               AND (s.deleted_at IS NULL OR s.deleted_at = 0) \
             WHERE p.socks_password_ref IS NOT NULL \
               AND (s.id IS NULL OR s.record_type IS NULL OR s.record_type <> 'socks_password') \
             ORDER BY p.created_at, p.id",
        )
        .map_err(|_| DomainError::internal("无法读取待补录规则"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(LegacyRecoveryItem {
                rule_id: row.get(0)?,
                name: row.get(1)?,
                bind_port: row.get(2)?,
            })
        })
        .map_err(|_| DomainError::internal("无法读取待补录规则"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| DomainError::internal("无法读取待补录规则"))?;
    Ok(rows)
}

pub struct NetworkSecrets {
    store: Store,
    vault: Arc<VaultManager>,
}

impl NetworkSecrets {
    pub fn new(store: Store, vault: Arc<VaultManager>) -> Self {
        Self { store, vault }
    }

    fn encrypt_in_transaction(
        &self,
        tx: &Transaction<'_>,
        password: &str,
        kind: &str,
    ) -> DomainResult<String> {
        let id = SecretId::new();
        let record = self.vault.encrypt_secret(&id, kind, password.as_bytes())?;
        insert_secret_row(tx, &record)?;
        bump_sync(tx, id.as_str(), "secret", None)?;
        Ok(id.to_string())
    }

    fn migrate_proxy_row(
        &self,
        tx: &Transaction<'_>,
        id: &str,
        raw: &str,
    ) -> DomainResult<Vec<ProxyServerConfig>> {
        let mut value: serde_json::Value =
            serde_json::from_str(raw).map_err(|_| DomainError::validation("代理列表格式无效"))?;
        // Validate the whole row before encrypting or replacing any legacy value.
        let _: Vec<ProxyServerConfig> = serde_json::from_value(value.clone())
            .map_err(|_| DomainError::validation("代理列表格式无效"))?;
        let mut changed = false;
        for entry in value
            .as_array_mut()
            .ok_or_else(|| DomainError::validation("代理列表格式无效"))?
        {
            if let Some(password) = entry
                .get("password")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                entry["password_ref"] = self
                    .encrypt_in_transaction(tx, password, "proxy_password")?
                    .into();
            }
            changed |= entry.as_object_mut().unwrap().remove("password").is_some();
            entry["has_password"] = entry
                .get("password_ref")
                .and_then(|v| v.as_str())
                .is_some_and(|v| !v.is_empty())
                .into();
        }
        if changed {
            tx.execute(
                "UPDATE setting SET value_json=?1,updated_at=?2 WHERE id=?3",
                rusqlite::params![value, now_ms(), id],
            )
            .map_err(|_| DomainError::internal("无法迁移代理密码"))?;
        }
        serde_json::from_value(value).map_err(|_| DomainError::validation("代理列表格式无效"))
    }

    fn validate_socks_reference(
        &self,
        tx: &Transaction<'_>,
        reference: &str,
    ) -> DomainResult<String> {
        let existing: Option<String> = tx.query_row("SELECT record_type FROM secret WHERE id=?1 AND (deleted_at IS NULL OR deleted_at=0)", [reference], |row| row.get(0)).optional().map_err(|_| DomainError::internal("无法读取 SOCKS 密码"))?;
        match existing {
            Some(kind) if kind == "socks_password" => Ok(reference.to_owned()),
            Some(_) => Err(DomainError::validation("SOCKS 密码引用类型无效")),
            None => Err(DomainError::validation(
                "SOCKS 密码引用不存在或旧值来源不明，请重新保存密码或恢复秘密备份",
            )),
        }
    }

    /// 凭据迁移的事务体；逐条补录复用同一事务，保证补录与迁移一起提交或一起回滚。
    fn migrate_legacy_in_transaction(&self, tx: &Transaction<'_>) -> DomainResult<()> {
        let proxies = tx
            .prepare("SELECT id,value_json FROM setting WHERE key='proxy_list'")
            .map_err(|_| DomainError::internal("无法读取代理列表"))?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| DomainError::internal("无法读取代理列表"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| DomainError::internal("无法读取代理列表"))?;
        for (id, value) in proxies {
            self.migrate_proxy_row(tx, &id, &value)?;
        }
        let rules = tx
            .prepare(
                "SELECT socks_password_ref FROM port_forward WHERE socks_password_ref IS NOT NULL",
            )
            .map_err(|_| DomainError::internal("无法读取转发规则"))?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| DomainError::internal("无法读取转发规则"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| DomainError::internal("无法读取转发规则"))?;
        for reference in rules {
            self.validate_socks_reference(tx, &reference)?;
        }
        mark_reference_store(tx)?;
        Ok(())
    }

    /// 旧库恢复的单一提交边界：可选的新 vault 行、逐条补录 secret/SOCKS、代理迁移与
    /// 来源标记全在同一个 Immediate 事务内，失败则整事务回滚。
    ///
    /// `new_vault` 仅在库尚未初始化时由「用户确认后」的恢复入口传入；已有库传 `None`。
    /// 检查/取消路径绝不调用此方法，因此不会在确认前持久化 vault 或绑定主密码。
    pub fn commit_legacy_recovery(
        &self,
        new_vault: Option<&VaultRecord>,
        entries: Option<&[LegacyRecoveryEntry]>,
    ) -> DomainResult<usize> {
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| DomainError::internal("无法开始凭据恢复事务"))?;
            if let Some(record) = new_vault {
                VaultRepo::save_in_transaction(&tx, record)?;
            }
            let applied = match entries {
                Some(entries) => self.reenter_in_transaction(&tx, entries)?,
                None => {
                    // 代理迁移与来源标记同事务提交；不确定的 SOCKS 旧值使整个事务回滚。
                    self.migrate_legacy_in_transaction(&tx)?;
                    0
                }
            };
            tx.commit()
                .map_err(|_| DomainError::internal("无法提交凭据恢复事务"))?;
            Ok(applied)
        })
    }

    /// 逐条补录的事务体；与代理迁移、来源标记共用调用方的事务，不自行提交。
    fn reenter_in_transaction(
        &self,
        tx: &Transaction<'_>,
        entries: &[LegacyRecoveryEntry],
    ) -> DomainResult<usize> {
        let pending = unresolved_forward_items(tx)?;
        let complete = entries.len() == pending.len()
            && pending.iter().all(|item| {
                entries
                    .iter()
                    .filter(|entry| entry.rule_id == item.rule_id)
                    .count()
                    == 1
            })
            && entries
                .iter()
                .all(|entry| pending.iter().any(|item| item.rule_id == entry.rule_id));
        if !complete {
            return Err(DomainError::validation(
                "每条待补录规则都需要逐条输入一次新密码",
            ));
        }
        let mut applied = 0usize;
        for entry in entries {
            if entry.password.is_empty() {
                return Err(DomainError::validation("请输入新的 SOCKS 密码"));
            }
            let reference = self.encrypt_in_transaction(tx, &entry.password, "socks_password")?;
            let updated = tx
                .execute(
                    "UPDATE port_forward SET socks_password_ref=?1, updated_at=?2 \
                     WHERE id=?3 AND socks_password_ref IS NOT NULL",
                    rusqlite::params![reference, now_ms(), entry.rule_id],
                )
                .map_err(|_| DomainError::internal("无法保存补录后的引用"))?;
            if updated != 1 {
                return Err(DomainError::validation("该规则不需要补录凭据"));
            }
            bump_sync(tx, &entry.rule_id, "port_forward", None)?;
            applied += 1;
        }
        self.migrate_legacy_in_transaction(tx)?;
        Ok(applied)
    }

    /// Runs on schema 1–4 before a migration snapshot, including soft-deleted legacy rows.
    pub fn migrate_legacy(&self) -> DomainResult<()> {
        self.commit_legacy_recovery(None, None).map(|_| ())
    }

    /// 只读列举无法判源的旧库规则，仅返回安全元数据，绝不携带引用原值。
    pub fn legacy_recovery_items(&self) -> DomainResult<Vec<LegacyRecoveryItem>> {
        self.store.with_conn(|conn| unresolved_forward_items(conn))
    }

    /// 逐条显式补录：补录、代理迁移与来源标记在**同一事务**内提交，任一失败整事务回滚。
    /// 要求每条待补录规则恰好显式输入一次，避免只补录一部分却留下不完整状态。
    /// 不删除坏规则、不重建库、不改写备份。
    pub fn reenter_legacy_socks(&self, entries: &[LegacyRecoveryEntry]) -> DomainResult<usize> {
        self.commit_legacy_recovery(None, Some(entries))
    }

    /// 启动时记录「本库凭据已全部引用化」的来源标记。
    ///
    /// 仅在无代理明文且所有 SOCKS 引用有效时记录；不能用缺少标记推断旧值是密码。
    /// 返回是否写入；`app_meta` 尚未建立（schema v1）时视为不需要。
    pub fn record_reference_store_if_clean(&self) -> DomainResult<bool> {
        self.store.with_conn(|conn| {
            if has_unresolved_credentials(conn)? || marked_reference_store(conn)? {
                return Ok(false);
            }
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| DomainError::internal("无法开始凭据来源记录"))?;
            mark_reference_store(&tx)?;
            tx.commit()
                .map_err(|_| DomainError::internal("无法提交凭据来源记录"))?;
            Ok(true)
        })
    }

    fn save(&self, password: &str, kind: &str) -> DomainResult<String> {
        let id = SecretId::new();
        let record = self.vault.encrypt_secret(&id, kind, password.as_bytes())?;
        SecretRepo::new(self.store.clone()).insert(record)?;
        Ok(id.to_string())
    }

    pub fn resolve(&self, reference: &str, kind: &str) -> DomainResult<Zeroizing<String>> {
        let id = SecretId::from_string(reference)
            .map_err(|_| DomainError::validation("代理密码引用无效，请重新保存密码"))?;
        let record = SecretRepo::new(self.store.clone())
            .get(&id)?
            .filter(|s| s.record_type == kind)
            .ok_or_else(|| DomainError::validation("代理密码引用无效，请重新保存密码"))?;
        let bytes = Zeroizing::new(self.vault.decrypt_secret(&record)?);
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| DomainError::new(ErrorCode::VaultDecryptFailed, "代理密码格式无效"))?;
        Ok(Zeroizing::new(text.to_owned()))
    }

    pub fn proxies(&self) -> DomainResult<Vec<ProxyServerConfig>> {
        self.store.with_conn(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| DomainError::internal("无法开始代理迁移"))?;
            let row: Option<(String,String)> = tx.query_row("SELECT id,value_json FROM setting WHERE scope='global' AND scope_id IS NULL AND key='proxy_list'", [], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| DomainError::internal("无法读取代理列表"))?;
            let result = match row { Some((id,value)) => self.migrate_proxy_row(&tx,&id,&value)?, None => Vec::new() };
            tx.commit().map_err(|_| DomainError::internal("无法提交代理迁移"))?;
            Ok(result)
        })
    }

    pub fn save_proxies(
        &self,
        inputs: Vec<ProxyServerInput>,
    ) -> DomainResult<Vec<ProxyServerConfig>> {
        let old = self.proxies()?;
        let mut ids = std::collections::HashSet::new();
        let mut result = Vec::new();
        for input in inputs {
            let mut proxy = input.config;
            if proxy.id.trim().is_empty()
                || proxy.name.trim().is_empty()
                || proxy.host.trim().is_empty()
                || proxy.port == 0
                || proxy.host.contains(['\r', '\n', '\0'])
                || !ids.insert(proxy.id.clone())
            {
                return Err(DomainError::validation("代理名称、地址、端口或 ID 无效"));
            }
            // References are owned by the saved row, never supplied as replacement passwords.
            proxy.password_ref = old
                .iter()
                .find(|p| p.id == proxy.id)
                .and_then(|p| p.password_ref.clone());
            if input.clear_password {
                proxy.password_ref = None;
            } else if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
                proxy.password_ref = Some(self.save(password, "proxy_password")?);
            }
            proxy.password = None;
            proxy.has_password = proxy.password_ref.is_some();
            result.push(proxy);
        }
        let value = serde_json::to_value(&result)
            .map_err(|_| DomainError::internal("无法序列化代理列表"))?;
        SettingsRepo::new(self.store.clone()).set("global", None, "proxy_list", value, false)?;
        Ok(result)
    }

    pub fn runtime_proxy(&self, mut proxy: ProxyServerConfig) -> DomainResult<ProxyServerConfig> {
        proxy.password = proxy
            .password_ref
            .as_deref()
            .map(|r| self.resolve(r, "proxy_password"))
            .transpose()?
            .map(|p| p.to_string());
        Ok(proxy)
    }

    pub fn test_proxy(&self, input: ProxyServerInput) -> DomainResult<ProxyServerConfig> {
        let mut proxy = input.config;
        proxy.password = if input.clear_password {
            None
        } else if input.password.as_deref().is_some_and(|p| !p.is_empty()) {
            input.password
        } else {
            self.proxies()?
                .into_iter()
                .find(|p| p.id == proxy.id)
                .map(|p| self.runtime_proxy(p))
                .transpose()?
                .and_then(|p| p.password)
        };
        Ok(proxy)
    }

    /// 供编辑/列表使用的安全枚举：单遍分类，不因一条坏引用丢弃整表，也不写坏持久化原行。
    ///
    /// 未知、软删除、类型不符或来源不明的引用一律置空并标记需显式补录；
    /// 既不回传原值（可能是旧版明文口令），也不把它当密码重新加密。
    pub async fn forwards(
        &self,
        session: Option<&SessionId>,
    ) -> DomainResult<Vec<ForwardRuleView>> {
        let rules = PortForwardRepo::new(self.store.clone())
            .list(session)
            .await?;
        let views = self.store.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT record_type FROM secret WHERE id=?1 AND (deleted_at IS NULL OR deleted_at=0)",
                )
                .map_err(|_| DomainError::internal("无法读取 SOCKS 密码状态"))?;
            let mut result = Vec::with_capacity(rules.len());
            for mut rule in rules {
                let state = match rule.socks_password_ref.as_deref() {
                    None => ForwardCredentialState::None,
                    Some(reference) => {
                        let kind: Option<String> = statement
                            .query_row([reference], |row| row.get(0))
                            .optional()
                            .map_err(|_| DomainError::internal("无法读取 SOCKS 密码状态"))?;
                        if kind.as_deref() == Some("socks_password") {
                            ForwardCredentialState::Ready
                        } else {
                            rule.socks_password_ref = None;
                            ForwardCredentialState::NeedsReentry
                        }
                    }
                };
                rule.has_socks_password = state == ForwardCredentialState::Ready;
                result.push(ForwardRuleView {
                    rule,
                    credential_state: state,
                });
            }
            Ok(result)
        })?;
        Ok(views)
    }

    /// 含秘密导出等必须完整性的边界：任一引用无效即整表失败，且保留有效引用原值。
    pub async fn forwards_strict(
        &self,
        session: Option<&SessionId>,
    ) -> DomainResult<Vec<PortForwardRule>> {
        let repo = PortForwardRepo::new(self.store.clone());
        let mut rules = repo.list(session).await?;
        let reference_store = self.store.with_conn(|conn| marked_reference_store(conn))?;
        for rule in &mut rules {
            if let Some(reference) = rule.socks_password_ref.as_deref() {
                rule.socks_password_ref = Some(self.store.with_conn(|conn| {
                    let tx = conn
                        .transaction_with_behavior(TransactionBehavior::Immediate)
                        .map_err(|_| DomainError::internal("无法开始 SOCKS 迁移"))?;
                    let migrated = self.validate_socks_reference(&tx, reference)?;
                    tx.commit()
                        .map_err(|_| DomainError::internal("无法提交 SOCKS 迁移"))?;
                    Ok(migrated)
                })?);
            }
            rule.has_socks_password = rule.socks_password_ref.is_some();
        }
        if !reference_store {
            // 所有规则引用均有效时才补写标记（本函数可能只列了部分规则，
            // 所以用整库证据再确认一次）；写入失败只影响下次判定，不影响本次结果。
            if let Err(error) = self.record_reference_store_if_clean() {
                tracing::warn!(%error, "failed to record credential store provenance");
            }
        }
        Ok(rules)
    }

    pub async fn prepare_forward(
        &self,
        mut input: PortForwardRuleInput,
        existing: Option<&PortForwardId>,
    ) -> DomainResult<PortForwardRuleInput> {
        let old = match existing {
            Some(id) => {
                PortForwardRepo::new(self.store.clone())
                    .get(id)
                    .await?
                    .socks_password_ref
            }
            None => None,
        };
        if input.socks_clear_password.unwrap_or(false) {
            input.socks_password_ref = None;
        } else if let Some(password) = input.socks_password.take().filter(|p| !p.is_empty()) {
            input.socks_password_ref = Some(self.save(&password, "socks_password")?);
        } else if existing.is_some() {
            input.socks_password_ref = old;
            if let Some(reference) = input.socks_password_ref.as_deref() {
                self.resolve(reference, "socks_password")?;
            }
        } else if let Some(reference) = input.socks_password_ref.as_deref() {
            self.resolve(reference, "socks_password")?;
        }
        input.socks_password = None;
        if input.socks_auth == Some(SocksAuth::Userpass) && input.socks_password_ref.is_none() {
            return Err(DomainError::validation("SOCKS 用户名密码认证需要密码"));
        }
        Ok(input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_vault::KdfParams;

    fn setup() -> (Store, Arc<VaultManager>, NetworkSecrets) {
        let store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let vault = Arc::new(VaultManager::new());
        vault
            .init(
                "synthetic-master-password",
                KdfParams {
                    mem_kib: 1024,
                    time: 1,
                    parallelism: 1,
                },
            )
            .unwrap();
        let service = NetworkSecrets::new(store.clone(), vault.clone());
        (store, vault, service)
    }

    fn input(password: Option<&str>) -> ProxyServerInput {
        serde_json::from_value(serde_json::json!({"id":"test", "name":"test", "proxy_type":"socks5", "host":"localhost", "port":1080, "password":password})).unwrap()
    }

    #[test]
    fn passwords_are_encrypted_preserved_cleared_and_never_returned() {
        let (store, vault, service) = setup();
        let password = format!("synthetic-{}", SecretId::new());
        let saved = service.save_proxies(vec![input(Some(&password))]).unwrap();
        let json = serde_json::to_string(&saved).unwrap();
        assert!(!json.contains(&password));
        assert!(!json.contains("\"password\":"));
        let value = SettingsRepo::new(store.clone())
            .get("global", None, "proxy_list")
            .unwrap()
            .unwrap()
            .value_json
            .to_string();
        assert!(!value.contains(&password));
        assert_eq!(
            service
                .runtime_proxy(saved[0].clone())
                .unwrap()
                .password
                .as_deref(),
            Some(password.as_str())
        );
        vault.lock();
        let preserved = service.save_proxies(vec![input(Some(""))]).unwrap();
        assert_eq!(preserved[0].password_ref, saved[0].password_ref);
        assert!(service
            .save_proxies(vec![input(Some("replacement"))])
            .is_err());
        let mut clear = input(None);
        clear.clear_password = true;
        assert!(!service.save_proxies(vec![clear]).unwrap()[0].has_password);
    }

    #[test]
    fn failed_legacy_proxy_update_rolls_back_secret_and_retries() {
        let (store, _, service) = setup();
        let legacy = serde_json::json!([{"id":"test","name":"test","proxy_type":"http","host":"localhost","port":8080,"password":"synthetic-rollback"}]);
        SettingsRepo::new(store.clone())
            .set("global", None, "proxy_list", legacy.clone(), false)
            .unwrap();
        store.with_conn(|conn| {
            conn.execute_batch("CREATE TRIGGER reject_proxy_update BEFORE UPDATE ON setting WHEN NEW.key='proxy_list' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
            Ok(())
        }).unwrap();
        assert!(service.proxies().is_err());
        store
            .with_conn(|conn| {
                assert_eq!(
                    conn.query_row("SELECT COUNT(*) FROM secret", [], |row| row
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                conn.execute_batch("DROP TRIGGER reject_proxy_update")
                    .unwrap();
                Ok(())
            })
            .unwrap();
        assert_eq!(
            SettingsRepo::new(store)
                .get("global", None, "proxy_list")
                .unwrap()
                .unwrap()
                .value_json,
            legacy
        );
        assert_eq!(
            service
                .runtime_proxy(service.proxies().unwrap().remove(0))
                .unwrap()
                .password
                .as_deref(),
            Some("synthetic-rollback")
        );
    }

    #[test]
    fn legacy_migration_locked_failure_preserves_original_then_retries() {
        let (store, vault, service) = setup();
        let settings = SettingsRepo::new(store);
        let legacy = serde_json::json!([{"id":"test", "name":"test", "proxy_type":"http", "host":"localhost", "port":8080,"password":"synthetic-legacy"}]);
        settings
            .set("global", None, "proxy_list", legacy.clone(), false)
            .unwrap();
        vault.lock();
        assert!(service.proxies().is_err());
        assert_eq!(
            settings
                .get("global", None, "proxy_list")
                .unwrap()
                .unwrap()
                .value_json,
            legacy
        );
        let (parts, key) = {
            let fresh = VaultManager::new();
            fresh
                .init(
                    "synthetic-master-password",
                    KdfParams {
                        mem_kib: 1024,
                        time: 1,
                        parallelism: 1,
                    },
                )
                .unwrap()
        };
        // No secret was migrated before locking, so a fresh isolated key suffices for retry.
        vault.unlock_with_key(&parts, key).unwrap();
        let migrated = service.proxies().unwrap();
        assert_eq!(
            service
                .runtime_proxy(migrated[0].clone())
                .unwrap()
                .password
                .as_deref(),
            Some("synthetic-legacy")
        );
        assert!(settings
            .get("global", None, "proxy_list")
            .unwrap()
            .unwrap()
            .value_json[0]
            .get("password")
            .is_none());
    }

    #[tokio::test]
    async fn missing_socks_reference_can_be_replaced_or_cleared_without_blocking_other_rules() {
        let (store, _, service) = setup();
        let repo = PortForwardRepo::new(store.clone());
        let bad = repo
            .create(PortForwardRuleInput {
                name: "bad".into(),
                bind_port: 1080,
                ..Default::default()
            })
            .await
            .unwrap();
        store
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE port_forward SET socks_password_ref=?1 WHERE id=?2",
                    rusqlite::params![SecretId::new().to_string(), bad.id.as_str()],
                )
                .unwrap();
                Ok(())
            })
            .unwrap();
        let fresh = PortForwardRuleInput {
            name: "new".into(),
            bind_port: 1081,
            socks_password: Some("synthetic-new".into()),
            ..Default::default()
        };
        assert!(service.prepare_forward(fresh, None).await.is_ok());
        let replacement = PortForwardRuleInput {
            name: "bad".into(),
            bind_port: 1080,
            socks_password: Some("synthetic-replacement".into()),
            ..Default::default()
        };
        let repaired = service
            .prepare_forward(replacement, Some(&bad.id))
            .await
            .unwrap();
        assert_eq!(
            service
                .resolve(
                    repaired.socks_password_ref.as_deref().unwrap(),
                    "socks_password"
                )
                .unwrap()
                .as_str(),
            "synthetic-replacement"
        );
        let cleared = service
            .prepare_forward(
                PortForwardRuleInput {
                    name: "bad".into(),
                    bind_port: 1080,
                    socks_clear_password: Some(true),
                    ..Default::default()
                },
                Some(&bad.id),
            )
            .await
            .unwrap();
        assert!(cleared.socks_password_ref.is_none());
    }

    /// 缺陷根因的最小重现：`SecretId` 只校验「26 位 ASCII 字母数字」，
    /// 所以旧明文口令与真实引用在字符串形态上完全相同，必须靠持久化迁移来源区分。
    #[test]
    fn secret_id_shape_alone_cannot_distinguish_legacy_passwords() {
        for password in ["abcdefghijklmnopqrstuvwxyz", "01ARZ3NDEKTSV4RRFFQ69G5FAV"] {
            assert!(
                SecretId::from_string(password).is_ok(),
                "{password} would be misread as a missing reference"
            );
        }
        assert!(SecretId::from_string("plain-old-password").is_err());
    }

    fn insert_legacy_rule(store: &Store, reference: &str) {
        store
            .with_conn(|conn| {
                conn.execute("INSERT INTO port_forward(id,name,type,bind_host,bind_port,socks_password_ref,created_at,updated_at) VALUES(?1,'legacy','dynamic','127.0.0.1',1080,?2,1,1)", rusqlite::params![PortForwardId::new().to_string(), reference]).unwrap();
                Ok(())
            })
            .unwrap();
    }

    #[tokio::test]
    async fn missing_reference_in_reference_store_is_rejected_and_row_kept() {
        let (store, _, service) = setup();
        // 现代库的开局状态：启动时已证明库内无旧明文，因此带来源标记。
        assert!(service.record_reference_store_if_clean().unwrap());
        let reference = SecretId::new().to_string();
        insert_legacy_rule(&store, &reference);
        let listed = service.forwards(None).await.unwrap();
        assert_eq!(listed.len(), 1, "坏引用仍要能进入编辑");
        assert_eq!(
            listed[0].credential_state,
            ForwardCredentialState::NeedsReentry
        );
        assert!(
            listed[0].rule.socks_password_ref.is_none(),
            "未知引用原值绝不回传"
        );
        // 严格完整性边界仍拒绝运行，且错误不含原值。
        let error = service.forwards_strict(None).await.unwrap_err();
        assert!(error.message.contains("引用不存在"), "{}", error.message);
        assert!(!error.message.contains(&reference));
        let stored = openshell_store::PortForwardRepo::new(store)
            .list(None)
            .await
            .unwrap();
        // 真实缺失的现代引用必须保持原样，不得被当成明文口令加密。
        assert_eq!(
            stored[0].socks_password_ref.as_deref(),
            Some(reference.as_str())
        );
    }

    #[tokio::test]
    async fn ambiguous_old_values_require_explicit_password_input_of_any_shape() {
        let (store, _, service) = setup();
        let passwords = [
            "abcdefghijklmnopqrstuvwxyz",
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "plain-old-password",
        ];
        for password in passwords {
            insert_legacy_rule(&store, password);
        }
        // 缺 secret 的旧值不能证明是明文：列表脱敏但可编辑，严格边界与迁移仍拒绝。
        assert!(!service.record_reference_store_if_clean().unwrap());
        let listed = service.forwards(None).await.unwrap();
        assert_eq!(listed.len(), passwords.len());
        for view in &listed {
            assert_eq!(view.credential_state, ForwardCredentialState::NeedsReentry);
            assert!(view.rule.socks_password_ref.is_none());
        }
        assert!(service.forwards_strict(None).await.is_err());
        assert!(service.migrate_legacy().is_err());
        let repo = PortForwardRepo::new(store.clone());
        let rules = repo.list(None).await.unwrap();
        assert_eq!(rules.len(), passwords.len());
        for rule in rules {
            let password = rule.socks_password_ref.as_deref().unwrap();
            assert!(passwords.contains(&password));
            // 模拟用户明确重新输入密码；不从字符串形状推断来源。
            let input = service
                .prepare_forward(
                    PortForwardRuleInput {
                        name: rule.name,
                        bind_port: rule.bind_port,
                        socks_password: Some(password.to_owned()),
                        ..Default::default()
                    },
                    Some(&rule.id),
                )
                .await
                .unwrap();
            repo.update(&rule.id, input).await.unwrap();
        }

        let migrated = service.forwards_strict(None).await.unwrap();
        let mut resolved: Vec<String> = Vec::new();
        for rule in &migrated {
            let reference = rule.socks_password_ref.clone().expect("migrated reference");
            assert!(
                !passwords.contains(&reference.as_str()),
                "plaintext password {reference} was kept as a reference"
            );
            resolved.push(
                service
                    .resolve(&reference, "socks_password")
                    .unwrap()
                    .to_string(),
            );
        }
        resolved.sort();
        let mut expected: Vec<String> = passwords.iter().map(|p| (*p).to_string()).collect();
        expected.sort();
        assert_eq!(resolved, expected, "every legacy password must survive");

        // 显式补录后引用均可解析，缺失的新引用仍必须被严格边界拒绝。
        insert_legacy_rule(&store, &SecretId::new().to_string());
        assert!(service.forwards_strict(None).await.is_err());
        assert!(service
            .forwards(None)
            .await
            .unwrap()
            .iter()
            .any(|view| view.credential_state == ForwardCredentialState::NeedsReentry));
    }

    #[tokio::test]
    async fn socks_input_is_a_secret_reference_and_locked_update_is_safe() {
        let (_, vault, service) = setup();
        let input = PortForwardRuleInput {
            name: "test".into(),
            bind_port: 1080,
            socks_password: Some("synthetic-socks".into()),
            ..Default::default()
        };
        let prepared = service.prepare_forward(input, None).await.unwrap();
        let reference = prepared.socks_password_ref.unwrap();
        assert_ne!(reference, "synthetic-socks");
        assert_eq!(
            service
                .resolve(&reference, "socks_password")
                .unwrap()
                .as_str(),
            "synthetic-socks"
        );
        vault.lock();
        assert!(service.resolve(&reference, "socks_password").is_err());
        let forged = PortForwardRuleInput {
            name: "bad".into(),
            bind_port: 1080,
            socks_password_ref: Some("plain-is-not-a-ref".into()),
            ..Default::default()
        };
        assert!(service.prepare_forward(forged, None).await.is_err());
    }
}
