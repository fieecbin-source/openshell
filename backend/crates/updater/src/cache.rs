//! 本地状态与检测缓存。
//!
//! 未认证的 GitHub API 每小时只有 60 次额度，因此：
//! * 6 小时内重复检查直接返回缓存，不发请求；
//! * 缓存过期后带 `If-None-Match` 做条件请求，304 时刷新时间戳、复用旧结果；
//! * 所有状态落在一个 JSON 里（原子写：先写 `.tmp` 再 rename），损坏时自动备份并重建。

use crate::error::UpdaterError;
use crate::model::UpdateCheckResult;
use crate::model::DEFAULT_CACHE_TTL_HOURS;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 状态文件名（位于 `<app_data_dir>/updater/`）。
pub const STATE_FILE: &str = "state.json";

/// 更新模块的持久化状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdaterState {
    /// 最近一次成功检查的时间。
    pub last_check_at_ms: Option<i64>,
    /// 最近一次检查的 ETag（用于条件请求）。
    pub etag: Option<String>,
    /// 最近一次检查的结果（缓存命中时直接返回）。
    pub cached_result: Option<UpdateCheckResult>,
    /// 用户选择「跳过此版本」的版本号列表。
    pub skipped_versions: Vec<String>,
    /// 「稍后提醒」的生效时间点。
    pub remind_after_ms: Option<i64>,
    /// 最近一次失败的用户可读原因（清空表示上次成功）。
    pub last_error: Option<String>,
    /// 已下载待安装文件的绝对路径（P2 使用，用于断点续传与「待安装」状态恢复）。
    pub pending_install_path: Option<String>,
}

impl UpdaterState {
    /// 缓存是否仍然新鲜。
    pub fn is_fresh(&self, now_ms: i64) -> bool {
        self.is_fresh_within(now_ms, DEFAULT_CACHE_TTL_HOURS)
    }

    /// 按指定 TTL 判断缓存是否新鲜。
    pub fn is_fresh_within(&self, now_ms: i64, ttl_hours: u32) -> bool {
        let Some(checked_at) = self.last_check_at_ms else {
            return false;
        };
        let ttl_ms = i64::from(ttl_hours.max(1)) * 3_600_000;
        now_ms.saturating_sub(checked_at) < ttl_ms
    }
}

/// 状态文件的读写器。
#[derive(Debug, Clone)]
pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            path: dir.as_ref().join(STATE_FILE),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取状态；文件不存在或损坏都返回默认值（损坏文件会改名留档，便于排查）。
    pub fn load(&self) -> UpdaterState {
        let Ok(raw) = std::fs::read_to_string(&self.path) else {
            return UpdaterState::default();
        };
        match serde_json::from_str::<UpdaterState>(&raw) {
            Ok(state) => state,
            Err(err) => {
                tracing::warn!(error = %err, "updater state is corrupted, rebuilding");
                let backup = self.path.with_extension("json.corrupted");
                let _ = std::fs::rename(&self.path, backup);
                UpdaterState::default()
            }
        }
    }

    /// 原子写入状态。
    pub fn save(&self, state: &UpdaterState) -> Result<(), UpdaterError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let payload = serde_json::to_vec_pretty(state)
            .map_err(|err| UpdaterError::internal(format!("failed to encode state: {err}")))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, payload)?;
        // Windows 上 rename 覆盖已存在文件会失败，先删除旧文件（内容已完整落盘）
        if self.path.exists() {
            let _ = std::fs::remove_file(&self.path);
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Channel;

    fn sample_result() -> UpdateCheckResult {
        UpdateCheckResult {
            has_update: true,
            current_version: "1.0.1".into(),
            latest_version: "1.1.0".into(),
            tag: "v1.1.0".into(),
            release_name: "OpenShell 1.1.0".into(),
            release_notes: "- 新增自动更新".into(),
            notes_html: "<ul><li>新增自动更新</li></ul>".into(),
            published_at: Some("2026-10-27T00:00:00Z".into()),
            asset: None,
            mandatory: false,
            min_supported_version: None,
            channel: Channel::Stable,
            from_cache: false,
            release_page_url: "https://github.com/a/b/releases".into(),
            source: "github".into(),
            checked_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn round_trips_state_to_disk() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = StateStore::new(dir.path());
        let mut state = UpdaterState {
            last_check_at_ms: Some(1_700_000_000_000),
            etag: Some("\"abc\"".into()),
            cached_result: Some(sample_result()),
            skipped_versions: vec!["1.0.9".into()],
            remind_after_ms: Some(1_700_000_100_000),
            ..Default::default()
        };
        state.last_error = None;
        store.save(&state).expect("save");
        let loaded = store.load();
        assert_eq!(loaded.last_check_at_ms, Some(1_700_000_000_000));
        assert_eq!(loaded.skipped_versions, vec!["1.0.9".to_string()]);
        assert_eq!(
            loaded.cached_result.expect("cached").latest_version,
            "1.1.0"
        );
    }

    #[test]
    fn corrupted_state_is_rebuilt_without_panicking() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = StateStore::new(dir.path());
        std::fs::write(store.path(), b"{not json").expect("write garbage");
        let loaded = store.load();
        assert!(loaded.last_check_at_ms.is_none());
        assert!(dir.path().join("state.json.corrupted").exists());
    }

    #[test]
    fn freshness_uses_ttl() {
        let mut state = UpdaterState::default();
        assert!(!state.is_fresh(1_000));
        state.last_check_at_ms = Some(0);
        assert!(state.is_fresh(3_600_000)); // 1 小时内
        assert!(!state.is_fresh(7 * 3_600_000)); // 7 小时后过期
        assert!(state.is_fresh_within(7 * 3_600_000, 12));
    }
}
