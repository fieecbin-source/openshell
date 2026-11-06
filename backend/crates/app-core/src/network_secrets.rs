//! Proxy/SOCKS credentials share the existing Vault secret store.
use openshell_core_domain::*;
use openshell_store::{models::bump_sync, repositories::secret::insert_secret_row};
use openshell_store::{PortForwardRepo, SecretRepo, SettingsRepo, Store};
use openshell_vault::VaultManager;
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior};
use std::sync::Arc;
use zeroize::Zeroizing;

/// `app_meta` 中记录「本库凭据已全部引用化」的来源标记。
///
/// 旧版本把 SOCKS 明文口令直接写进 `port_forward.socks_password_ref`（`secret` 表里没有对应行），
/// 而 `SecretId` 只校验「26 个 ASCII 字母数字」，因此**不能**用字符串形态区分明文口令与真实引用：
/// `abcdefghijklmnopqrstuvwxyz` 这类口令和合法 ULID 形状的口令都会被误判成缺失引用。
///
/// 这里改用已持久化的迁移来源作为证据：
/// - 有标记：库内凭据已全部引用化，缺失就是真实缺失 → 报错让人重填口令；
/// - 无标记：仍是旧库，缺 `secret` 行的引用一律按旧明文口令加密迁移。
///
/// 标记只在「已证明库内无旧明文」时写入（见 [`NetworkSecrets::record_reference_store_if_clean`]
/// 与 [`NetworkSecrets::migrate_legacy`]），所以旧库不会被提前误标。
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

/// 读取迁移来源标记；schema v1 还没有 `app_meta` 表，按「旧库」处理。
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

/// 库内是否仍存在旧明文证据：明文代理口令，或缺失 `secret` 行的 SOCKS 引用。
///
/// 语义与备份前的安全检查一致，避免「备份拒绝却允许标记为现代库」的错位。
fn has_legacy_plaintext(conn: &rusqlite::Connection) -> DomainResult<bool> {
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
                 AND s.record_type='socks_password'))",
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

    fn migrate_socks_rule(
        &self,
        tx: &Transaction<'_>,
        id: &str,
        reference: &str,
    ) -> DomainResult<String> {
        let existing: Option<String> = tx.query_row("SELECT record_type FROM secret WHERE id=?1 AND (deleted_at IS NULL OR deleted_at=0)", [reference], |row| row.get(0)).optional().map_err(|_| DomainError::internal("无法读取 SOCKS 密码"))?;
        match existing {
            Some(kind) if kind == "socks_password" => return Ok(reference.to_owned()),
            Some(_) => return Err(DomainError::validation("SOCKS 密码引用类型无效")),
            None => {}
        }
        if marked_reference_store(tx)? {
            // 已引用化的库：引用缺失是真实缺失（例如秘密行被删除），
            // 绝不能把引用文本当成口令加密，否则会静默存下错误口令。
            return Err(DomainError::validation(
                "SOCKS 密码引用不存在，请重新保存密码",
            ));
        }
        // 旧库：此列存的是明文口令。此处不看字符串形态，26 位字母数字
        // （含 `abcdefghijklmnopqrstuvwxyz`、合法 ULID 形状）一律按口令迁移。
        let migrated = self.encrypt_in_transaction(tx, reference, "socks_password")?;
        let changed = tx.execute("UPDATE port_forward SET socks_password_ref=?1,dirty=1,updated_at=?2 WHERE id=?3 AND socks_password_ref=?4", rusqlite::params![migrated, now_ms(), id, reference]).map_err(|_| DomainError::internal("无法迁移 SOCKS 密码"))?;
        if changed != 1 {
            return Err(DomainError::conflict("转发规则已改变，请重试"));
        }
        bump_sync(tx, id, "port_forward", None)?;
        Ok(migrated)
    }

    /// Runs on schema 1–4 before a migration snapshot, including soft-deleted legacy rows.
    pub fn migrate_legacy(&self) -> DomainResult<()> {
        self.store.with_conn(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| DomainError::internal("无法开始凭据迁移"))?;
            let proxies = tx.prepare("SELECT id,value_json FROM setting WHERE key='proxy_list'").map_err(|_| DomainError::internal("无法读取代理列表"))?.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|_| DomainError::internal("无法读取代理列表"))?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| DomainError::internal("无法读取代理列表"))?;
            for (id, value) in proxies { self.migrate_proxy_row(&tx, &id, &value)?; }
            let rules = tx.prepare("SELECT id,socks_password_ref FROM port_forward WHERE socks_password_ref IS NOT NULL").map_err(|_| DomainError::internal("无法读取转发规则"))?.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|_| DomainError::internal("无法读取转发规则"))?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| DomainError::internal("无法读取转发规则"))?;
            for (id, reference) in rules { self.migrate_socks_rule(&tx, &id, &reference)?; }
            // 迁移与来源标记同事务提交：失败整体回滚，下次重试仍是「旧库」语义。
            mark_reference_store(&tx)?;
            tx.commit().map_err(|_| DomainError::internal("无法提交凭据迁移"))
        })
    }

    /// 启动时记录「本库凭据已全部引用化」的来源标记。
    ///
    /// 只有证明不存在旧明文（明文代理口令，或缺失 `secret` 行的 SOCKS 引用）时才写入，
    /// 所以仍有旧明文的库不会拿到标记，后续缺失引用仍按旧口令迁移。
    /// 返回是否写入；`app_meta` 尚未建立（schema v1）时视为不需要。
    pub fn record_reference_store_if_clean(&self) -> DomainResult<bool> {
        self.store.with_conn(|conn| {
            if has_legacy_plaintext(conn)? || marked_reference_store(conn)? {
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

    pub async fn forwards(
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
                    let migrated = self.migrate_socks_rule(&tx, rule.id.as_str(), reference)?;
                    tx.commit()
                        .map_err(|_| DomainError::internal("无法提交 SOCKS 迁移"))?;
                    Ok(migrated)
                })?);
            }
            rule.has_socks_password = rule.socks_password_ref.is_some();
        }
        if !reference_store {
            // 旧库的所有规则迁移成功后才补写来源标记（本函数可能只列了部分规则，
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
        let error = service.forwards(None).await.unwrap_err();
        assert!(error.message.contains("引用不存在"), "{}", error.message);
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
    async fn legacy_plaintext_passwords_of_any_shape_migrate_then_store_is_marked() {
        let (store, _, service) = setup();
        let passwords = [
            "abcdefghijklmnopqrstuvwxyz",
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "plain-old-password",
        ];
        for password in passwords {
            insert_legacy_rule(&store, password);
        }
        // 旧库（存在缺 secret 行的引用）此时还不能被标记。
        assert!(!service.record_reference_store_if_clean().unwrap());

        let mut migrated = service.forwards(None).await.unwrap();
        let mut resolved: Vec<String> = Vec::new();
        for rule in &mut migrated {
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

        // 全量迁移成功后库被标记；此后真实缺失的引用必须报错而不是再次加密。
        insert_legacy_rule(&store, &SecretId::new().to_string());
        assert!(service.forwards(None).await.is_err());
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
