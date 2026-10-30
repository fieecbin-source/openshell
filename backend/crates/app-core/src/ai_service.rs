//! AI 终端助手配置服务：档案 CRUD、设置持久化与联通测试编排。
//!
//! 安全约束：
//! - API Key 只经 [`ApiKeyStore`] 读写，绝不进入 SQLite、日志或返回值；
//! - 对外视图中的 `has_api_key` 只反映“是否存在”，不返回密钥内容。

use openshell_ai::catalog;
use openshell_ai::error::{AiError, AiErrorCode};
use openshell_ai::secrets::ApiKeyStore;
use openshell_ai::service::{HttpProfileTester, ProfileTester, PROFILE_TEST_TIMEOUT};
use openshell_core_domain::{
    now_ms, AiCatalogView, AiConfigView, AiProfile, AiProfileInput, AppPaths, ApprovalPolicy,
    DomainError, DomainResult, ProviderTestResult,
};
use openshell_store::{AiProfileRepo, CommandHistoryRepo, SettingsRepo, Store};
use openshell_vault::VaultManager;
use serde_json::{json, Value};
use std::sync::Arc;

/// 设置作用域（`scope_id` 固定为 `None`）。
const SETTINGS_SCOPE: &str = "ai";
const SETTING_ENABLED: &str = "enabled";
const SETTING_ACTIVE_PROFILE_ID: &str = "active_profile_id";
const SETTING_DEFAULT_POLICY: &str = "default_policy";

const DEFAULT_HISTORY_LIMIT: u32 = 50;
const MAX_HISTORY_LIMIT: u32 = 200;

/// AI 配置服务。
pub struct AiService {
    profiles: AiProfileRepo,
    history: CommandHistoryRepo,
    settings: SettingsRepo,
    keys: ApiKeyStore,
    tester: Arc<dyn ProfileTester>,
}

impl AiService {
    /// 生产装配：系统凭据库 + 保险库回退，真实 HTTP 测试器。
    pub fn new(paths: &AppPaths, store: Store, vault: Arc<VaultManager>) -> DomainResult<Self> {
        let keys = ApiKeyStore::new(paths.data_dir.join("ai_keys"), Some(vault));
        Self::with_components(paths, store, keys, Arc::new(HttpProfileTester))
    }

    /// 测试注入：自定义凭据存储与测试器。
    pub fn with_components(
        paths: &AppPaths,
        store: Store,
        keys: ApiKeyStore,
        tester: Arc<dyn ProfileTester>,
    ) -> DomainResult<Self> {
        let _ = paths;
        Ok(Self {
            profiles: AiProfileRepo::new(store.clone()),
            history: CommandHistoryRepo::new(store.clone()),
            settings: SettingsRepo::new(store),
            keys,
            tester,
        })
    }

    /// 完整配置视图（不含任何密钥）。
    pub fn config_get(&self) -> DomainResult<AiConfigView> {
        let mut profiles = self.profiles.list()?;
        for profile in &mut profiles {
            profile.has_api_key = self.keys.has_api_key(&profile.id);
        }

        let active_profile_id = self
            .setting(SETTING_ACTIVE_PROFILE_ID)?
            .and_then(|value| value.as_str().map(str::to_string))
            .filter(|id| !id.is_empty());

        let default_policy = self
            .setting(SETTING_DEFAULT_POLICY)?
            .and_then(|value| value.as_str().and_then(ApprovalPolicy::parse))
            .unwrap_or_default();

        Ok(AiConfigView {
            feature_enabled: self.enabled()?,
            active_profile_id,
            default_policy,
            profiles,
            key_backend: self.keys.backend().as_str().to_string(),
            key_backend_message: self.keys.backend_message(),
        })
    }

    /// 新建或更新模型档案。
    pub fn config_save(&self, input: AiProfileInput) -> DomainResult<AiProfile> {
        validate_input(&input)?;

        let logo_key = input
            .logo_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .or_else(|| catalog::provider(&input.provider).map(|preset| preset.logo_key.clone()))
            .unwrap_or_else(|| "custom".to_string());

        let profile = match input.id.as_deref() {
            None => {
                let now = now_ms();
                let id = ulid::Ulid::new().to_string();

                if let Some(api_key) = input.api_key.as_deref().filter(|key| !key.is_empty()) {
                    self.write_key(&id, api_key)?;
                }

                let profile = AiProfile {
                    id,
                    provider: input.provider.trim().to_string(),
                    label: input.label.trim().to_string(),
                    base_url: input.base_url.trim().to_string(),
                    model_id: input.model_id.trim().to_string(),
                    wire: input.wire,
                    default_policy: input.default_policy,
                    logo_key,
                    verified_at: None,
                    has_api_key: false,
                    created_at: now,
                    updated_at: now,
                };
                self.profiles.create(&profile)?;
                profile
            }
            Some(id) => {
                let mut profile = self
                    .profiles
                    .get(id)?
                    .ok_or_else(|| DomainError::not_found("模型档案不存在，请刷新后重试"))?;

                match input.api_key.as_deref() {
                    Some("") => self.delete_key(id)?,
                    Some(api_key) => self.write_key(id, api_key)?,
                    None => {}
                }

                profile.provider = input.provider.trim().to_string();
                profile.label = input.label.trim().to_string();
                profile.base_url = input.base_url.trim().to_string();
                profile.model_id = input.model_id.trim().to_string();
                profile.wire = input.wire;
                profile.default_policy = input.default_policy;
                profile.logo_key = logo_key;
                profile.updated_at = now_ms();

                self.profiles.update(&profile)?;
                profile
            }
        };

        Ok(AiProfile {
            has_api_key: self.keys.has_api_key(&profile.id),
            ..profile
        })
    }

    /// 删除档案与其 API Key；若为激活档案则同时清空激活设置。
    pub fn delete_profile(&self, profile_id: &str) -> DomainResult<()> {
        if self.profiles.get(profile_id)?.is_none() {
            return Err(DomainError::not_found("模型档案不存在，请刷新后重试"));
        }
        self.profiles.delete(profile_id)?;
        self.delete_key(profile_id)?;

        if self.active_profile_id()?.as_deref() == Some(profile_id) {
            self.set_setting(SETTING_ACTIVE_PROFILE_ID, json!(""))?;
        }
        Ok(())
    }

    /// 设置激活档案。
    pub fn set_active_profile(&self, profile_id: &str) -> DomainResult<()> {
        if self.profiles.get(profile_id)?.is_none() {
            return Err(DomainError::not_found("模型档案不存在，请刷新后重试"));
        }
        self.set_setting(SETTING_ACTIVE_PROFILE_ID, json!(profile_id))
    }

    /// 一键联通测试；密钥缺失或测试失败均返回结构化结果而不是 `Err`。
    pub async fn profile_test(&self, profile_id: &str) -> DomainResult<ProviderTestResult> {
        let profile = self
            .profiles
            .get(profile_id)?
            .ok_or_else(|| DomainError::not_found("模型档案不存在，请刷新后重试"))?;

        if !self.keys.has_api_key(profile_id) {
            return Ok(ProviderTestResult {
                ok: false,
                latency_ms: 0,
                model: profile.model_id,
                message: "尚未填写 API Key，请先填写后再测试连接".to_string(),
                code: Some(AiErrorCode::KeyDecryptFailed.as_str().to_string()),
            });
        }

        let api_key = match self.keys.get_api_key(profile_id) {
            Ok(key) => key,
            Err(error) => {
                return Ok(ProviderTestResult {
                    ok: false,
                    latency_ms: 0,
                    model: profile.model_id,
                    message: error.message,
                    code: Some(error.code.as_str().to_string()),
                });
            }
        };

        let result = match self
            .tester
            .test_profile(
                profile.wire,
                &profile.base_url,
                &profile.model_id,
                api_key.as_str(),
                PROFILE_TEST_TIMEOUT,
            )
            .await
        {
            Ok(result) => result,
            Err(error) => ProviderTestResult {
                ok: false,
                latency_ms: 0,
                model: profile.model_id.clone(),
                message: error.message,
                code: Some(error.code.as_str().to_string()),
            },
        };

        if result.ok {
            self.profiles.set_verified_at(profile_id, now_ms())?;
        }
        Ok(result)
    }

    /// 最近命令历史（按时间倒序，去重由仓储保证）。
    pub fn history_list(&self, limit: Option<u32>) -> DomainResult<Vec<String>> {
        let limit = limit
            .unwrap_or(DEFAULT_HISTORY_LIMIT)
            .clamp(1, MAX_HISTORY_LIMIT) as usize;
        let entries = self.history.list(limit)?;
        Ok(entries.into_iter().map(|entry| entry.command).collect())
    }

    /// 内置厂商目录快照。
    pub fn catalog_get(&self) -> DomainResult<AiCatalogView> {
        catalog::catalog()
            .cloned()
            .map_err(|error| error.to_domain_error())
    }

    /// 厂商 Logo SVG 文本；未知 key 返回内置默认图标。
    pub fn logo_svg(&self, logo_key: &str) -> String {
        catalog::logo_svg(logo_key).unwrap_or("").to_string()
    }

    /// AI 功能是否启用（默认关闭）。
    pub fn is_enabled(&self) -> bool {
        self.enabled().unwrap_or(false)
    }

    /// 写入功能开关。
    pub fn set_enabled(&self, enabled: bool) -> DomainResult<()> {
        self.set_setting(SETTING_ENABLED, json!(enabled))
    }

    fn enabled(&self) -> DomainResult<bool> {
        Ok(self
            .setting(SETTING_ENABLED)?
            .and_then(|value| value.as_bool())
            .unwrap_or(false))
    }

    fn active_profile_id(&self) -> DomainResult<Option<String>> {
        Ok(self
            .setting(SETTING_ACTIVE_PROFILE_ID)?
            .and_then(|value| value.as_str().map(str::to_string))
            .filter(|id| !id.is_empty()))
    }

    fn setting(&self, key: &str) -> DomainResult<Option<Value>> {
        Ok(self
            .settings
            .get(SETTINGS_SCOPE, None, key)?
            .map(|record| record.value_json))
    }

    fn set_setting(&self, key: &str, value: Value) -> DomainResult<()> {
        self.settings.set(SETTINGS_SCOPE, None, key, value, false)?;
        Ok(())
    }

    fn write_key(&self, profile_id: &str, api_key: &str) -> DomainResult<()> {
        self.keys
            .set_api_key(profile_id, api_key)
            .map_err(|error: AiError| error.to_domain_error())
    }

    fn delete_key(&self, profile_id: &str) -> DomainResult<()> {
        self.keys
            .delete_api_key(profile_id)
            .map_err(|error: AiError| error.to_domain_error())
    }
}

fn validate_input(input: &AiProfileInput) -> DomainResult<()> {
    if input.provider.trim().is_empty() {
        return Err(DomainError::validation("请选择模型厂商"));
    }
    if input.label.trim().is_empty() {
        return Err(DomainError::validation("请填写档案名称"));
    }
    let base_url = input.base_url.trim();
    if base_url.is_empty() {
        return Err(DomainError::validation("请填写端点地址"));
    }
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err(DomainError::validation(
            "端点地址必须以 http:// 或 https:// 开头",
        ));
    }
    if input.model_id.trim().is_empty() {
        return Err(DomainError::validation("请填写模型 ID"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use openshell_core_domain::{AiWireKind, ErrorCode};
    use std::time::Duration;

    /// 固定返回值的联通测试器。
    struct MockTester {
        result: Result<ProviderTestResult, AiError>,
    }

    #[async_trait]
    impl ProfileTester for MockTester {
        async fn test_profile(
            &self,
            _wire: AiWireKind,
            _base_url: &str,
            _model_id: &str,
            _api_key: &str,
            _timeout: Duration,
        ) -> Result<ProviderTestResult, AiError> {
            self.result.clone()
        }
    }

    fn service_with(result: Result<ProviderTestResult, AiError>) -> (AiService, tempfile::TempDir) {
        let store = Store::open_in_memory().expect("open in-memory db");
        store.migrate().expect("migrate");
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::new(dir.path().to_path_buf());
        let keys = ApiKeyStore::for_test(dir.path().to_path_buf());
        let tester: Arc<dyn ProfileTester> = Arc::new(MockTester { result });
        let service =
            AiService::with_components(&paths, store, keys, tester).expect("build ai service");
        (service, dir)
    }

    fn input(api_key: Option<&str>) -> AiProfileInput {
        AiProfileInput {
            id: None,
            provider: "deepseek".into(),
            label: "DeepSeek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            model_id: "deepseek-chat".into(),
            wire: AiWireKind::OpenAiChat,
            default_policy: ApprovalPolicy::Manual,
            logo_key: None,
            api_key: api_key.map(str::to_string),
        }
    }

    fn success_result() -> ProviderTestResult {
        ProviderTestResult {
            ok: true,
            latency_ms: 42,
            model: "deepseek-chat".into(),
            message: "连接成功".into(),
            code: None,
        }
    }

    #[tokio::test]
    async fn profile_test_success_marks_verified() {
        let (service, _dir) = service_with(Ok(success_result()));
        let profile = service
            .config_save(input(Some("sk-test-secret-value")))
            .expect("create profile");

        let result = service
            .profile_test(&profile.id)
            .await
            .expect("test profile");
        assert!(result.ok);
        assert_eq!(result.code, None);
        assert_eq!(result.message, "连接成功");
        assert_eq!(result.latency_ms, 42);

        let view = service.config_get().expect("config view");
        assert!(view.profiles[0].verified_at.is_some());
    }

    #[tokio::test]
    async fn profile_test_normalizes_provider_failures() {
        let cases = [
            (
                AiError::auth("API Key 无效或没有访问权限，请检查密钥").with_status(401),
                "AI_AUTH",
                "API Key 无效",
            ),
            (
                AiError::rate_limit("请求过于频繁，已触发厂商限流，请稍后重试").with_status(429),
                "AI_RATE_LIMIT",
                "限流",
            ),
            (
                AiError::timeout("连接模型服务超时，请检查网络或调大超时时间"),
                "AI_TIMEOUT",
                "超时",
            ),
            (
                AiError::model_not_found("模型不存在或当前账号无权访问该模型").with_status(404),
                "AI_MODEL_NOT_FOUND",
                "模型不存在",
            ),
        ];

        for (error, code, fragment) in cases {
            let (service, _dir) = service_with(Err(error));
            let profile = service
                .config_save(input(Some("sk-test-secret-value")))
                .expect("create profile");

            let result = service
                .profile_test(&profile.id)
                .await
                .expect("test profile");
            assert!(!result.ok, "{code} 应返回失败结果");
            assert_eq!(result.code.as_deref(), Some(code));
            assert!(
                result.message.contains(fragment),
                "{code} 的文案应包含 {fragment}，实际为 {}",
                result.message
            );
            // 失败不应记录 verified_at。
            let view = service.config_get().expect("config view");
            assert!(view.profiles[0].verified_at.is_none());
        }
    }

    #[tokio::test]
    async fn profile_test_without_key_returns_structured_failure() {
        let (service, _dir) = service_with(Ok(success_result()));
        let profile = service.config_save(input(None)).expect("create profile");

        let result = service
            .profile_test(&profile.id)
            .await
            .expect("test profile");
        assert!(!result.ok);
        assert_eq!(result.code.as_deref(), Some("AI_KEY_DECRYPT_FAILED"));
        assert_eq!(result.message, "尚未填写 API Key，请先填写后再测试连接");
        assert_eq!(result.model, "deepseek-chat");
    }

    #[test]
    fn profile_crud_tracks_key_and_clears_active_profile() {
        let (service, _dir) = service_with(Ok(success_result()));

        assert!(!service.is_enabled());
        service.set_enabled(true).expect("enable ai");
        assert!(service.is_enabled());

        let created = service
            .config_save(input(Some("sk-test-secret-value")))
            .expect("create profile");
        assert!(created.has_api_key);
        assert_eq!(created.created_at, created.updated_at);
        assert_eq!(
            created.logo_key,
            catalog::provider("deepseek")
                .expect("deepseek preset")
                .logo_key
        );

        let view = service.config_get().expect("config view");
        assert!(view.feature_enabled);
        assert_eq!(view.default_policy, ApprovalPolicy::Manual);
        assert_eq!(view.profiles.len(), 1);
        assert!(view.profiles[0].has_api_key);
        assert_eq!(view.key_backend, "keyring");

        let json = serde_json::to_string(&view).expect("serialize config");
        assert!(
            !json.contains("sk-test-secret-value"),
            "配置视图不得包含密钥明文"
        );

        service
            .set_active_profile(&created.id)
            .expect("set active profile");
        assert_eq!(
            service
                .config_get()
                .expect("config view")
                .active_profile_id
                .as_deref(),
            Some(created.id.as_str())
        );

        let mut update = input(None);
        update.id = Some(created.id.clone());
        update.model_id = "deepseek-reasoner".into();
        let updated = service.config_save(update).expect("update profile");
        assert_eq!(updated.model_id, "deepseek-reasoner");
        assert!(updated.has_api_key, "未提供 api_key 时应保留原密钥");
        assert!(updated.updated_at >= updated.created_at);

        let view = service.config_get().expect("config view");
        assert_eq!(view.profiles[0].model_id, "deepseek-reasoner");

        service.delete_profile(&created.id).expect("delete profile");
        let view = service.config_get().expect("config view");
        assert!(view.profiles.is_empty());
        assert!(view.active_profile_id.is_none());
    }

    #[test]
    fn config_save_validates_required_fields() {
        let (service, _dir) = service_with(Ok(success_result()));

        let mut empty_model = input(None);
        empty_model.model_id = "  ".into();
        let error = service
            .config_save(empty_model)
            .expect_err("empty model id");
        assert_eq!(error.code, ErrorCode::Validation);
        assert_eq!(error.message, "请填写模型 ID");

        let mut bad_url = input(None);
        bad_url.base_url = "ftp://example.com/v1".into();
        let error = service.config_save(bad_url).expect_err("bad base url");
        assert_eq!(error.code, ErrorCode::Validation);
        assert!(error.message.contains("http://"));

        let mut empty_label = input(None);
        empty_label.label = String::new();
        let error = service.config_save(empty_label).expect_err("empty label");
        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[test]
    fn set_active_profile_and_delete_require_existing_profile() {
        let (service, _dir) = service_with(Ok(success_result()));
        let missing = ulid::Ulid::new().to_string();

        assert_eq!(
            service
                .set_active_profile(&missing)
                .expect_err("missing")
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(
            service.delete_profile(&missing).expect_err("missing").code,
            ErrorCode::NotFound
        );
        assert!(service
            .config_get()
            .expect("config view")
            .active_profile_id
            .is_none());
    }

    #[tokio::test]
    async fn history_and_catalog_views() {
        let (service, _dir) = service_with(Ok(success_result()));
        assert!(service.history_list(None).expect("history").is_empty());
        assert!(service
            .history_list(Some(0))
            .expect("clamped history")
            .is_empty());

        let catalog = service.catalog_get().expect("catalog");
        assert!(catalog.providers.len() >= 10);
        let logo = service.logo_svg("not-a-real-logo");
        assert!(logo.contains("<svg"));
    }
}
