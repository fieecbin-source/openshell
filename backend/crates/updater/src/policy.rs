//! 版本策略：跳过版本、稍后提醒、强制更新的提示判定。
//!
//! 全部是纯函数（输入输出都是值类型），因此可以完整离线单测。
//! 持久化由调用方负责（写入 [`crate::cache::UpdaterState`]）。

use crate::cache::UpdaterState;
use crate::model::UpdateCheckResult;
use crate::version;
use serde::{Deserialize, Serialize};

/// 「稍后提醒」的默认延迟（小时）。
pub const DEFAULT_REMIND_HOURS: u32 = 24;
/// 「稍后提醒」允许的最大延迟（小时），避免用户设置成十年后。
pub const MAX_REMIND_HOURS: u32 = 24 * 30;

/// 自动检查时应该如何提示用户。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyDecision {
    /// 弹窗提示（有新版本）。
    Notify,
    /// 用户跳过过该版本，静默。
    Skipped,
    /// 用户选择了稍后提醒，静默到时间点。
    RemindLater,
    /// 已是最新。
    UpToDate,
}

/// 计算提示策略。
///
/// * `manual = true`（用户主动点「检查更新」）时忽略跳过/稍后，始终告知结果；
/// * 更新始终可选，远端 mandatory 标记不覆盖用户的跳过与稍后选择。
pub fn evaluate(
    result: &UpdateCheckResult,
    state: &UpdaterState,
    manual: bool,
    now_ms: i64,
) -> NotifyDecision {
    if !result.has_update {
        return NotifyDecision::UpToDate;
    }
    if manual {
        return NotifyDecision::Notify;
    }
    if state
        .skipped_versions
        .iter()
        .any(|skipped| skipped == &result.latest_version)
    {
        return NotifyDecision::Skipped;
    }
    if state
        .remind_after_ms
        .is_some_and(|deadline| deadline > now_ms)
    {
        return NotifyDecision::RemindLater;
    }
    NotifyDecision::Notify
}

/// 是否必须更新：Release 声明 `mandatory`，或当前版本低于 `min_supported_version`。
pub fn is_mandatory(
    current_version: &str,
    declared_mandatory: bool,
    min_supported_version: Option<&str>,
) -> bool {
    if declared_mandatory {
        return true;
    }
    let (Ok(current), Some(min_raw)) = (version::normalize(current_version), min_supported_version)
    else {
        return false;
    };
    let Some(minimum) = version::normalize_opt(min_raw) else {
        return false;
    };
    version::is_below_minimum(&current, Some(&minimum))
}

/// 记录「跳过此版本」。重复跳过同一版本不会产生重复项。
pub fn skip_version(state: &mut UpdaterState, latest_version: &str) {
    let normalized = version::normalize(latest_version)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| latest_version.trim().to_string());
    if normalized.is_empty() {
        return;
    }
    if !state.skipped_versions.iter().any(|v| v == &normalized) {
        state.skipped_versions.push(normalized);
    }
    // 跳过即取消「稍后提醒」，避免两个策略互相打架
    state.remind_after_ms = None;
}

/// 取消跳过（用户手动检查时点「不再跳过」，或出现更高版本时清理旧记录）。
pub fn unskip_version(state: &mut UpdaterState, latest_version: &str) {
    state
        .skipped_versions
        .retain(|skipped| skipped != latest_version);
}

/// 只保留不低于 `latest_version` 的跳过记录之外的历史项：
/// 用户跳过 1.0.9 后出现 1.1.0，提示恢复；之后又回到 1.0.9 的检查结果时不再静默。
pub fn prune_skipped(state: &mut UpdaterState, latest_version: &str) {
    let Ok(latest) = version::normalize(latest_version) else {
        return;
    };
    state.skipped_versions.retain(|skipped| {
        // 保留「更旧」的跳过记录没有意义，会导致未来回滚版本时误静默
        version::normalize_opt(skipped).is_some_and(|v| v >= latest)
    });
}

/// 设置「稍后提醒」截止时间。
pub fn remind_later(state: &mut UpdaterState, now_ms: i64, hours: Option<u32>) {
    let hours = hours
        .unwrap_or(DEFAULT_REMIND_HOURS)
        .clamp(1, MAX_REMIND_HOURS);
    state.remind_after_ms = Some(now_ms.saturating_add(i64::from(hours) * 3_600_000));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Channel;

    fn result(has_update: bool, latest: &str, mandatory: bool) -> UpdateCheckResult {
        UpdateCheckResult {
            has_update,
            current_version: "1.0.1".into(),
            latest_version: latest.into(),
            tag: format!("v{latest}"),
            release_name: String::new(),
            release_notes: String::new(),
            notes_html: String::new(),
            published_at: None,
            asset: None,
            mandatory,
            min_supported_version: None,
            channel: Channel::Stable,
            from_cache: false,
            release_page_url: String::new(),
            source: "github".into(),
            checked_at_ms: 0,
        }
    }

    const NOW: i64 = 1_700_000_000_000;

    #[test]
    fn up_to_date_never_notifies() {
        let state = UpdaterState::default();
        assert_eq!(
            evaluate(&result(false, "1.0.1", false), &state, true, NOW),
            NotifyDecision::UpToDate
        );
    }

    #[test]
    fn skipped_version_is_silent_until_manual_check() {
        let mut state = UpdaterState::default();
        skip_version(&mut state, "1.1.0");
        let r = result(true, "1.1.0", false);
        assert_eq!(evaluate(&r, &state, false, NOW), NotifyDecision::Skipped);
        assert_eq!(evaluate(&r, &state, true, NOW), NotifyDecision::Notify);
    }

    #[test]
    fn higher_version_restores_notification() {
        let mut state = UpdaterState::default();
        skip_version(&mut state, "1.1.0");
        let r = result(true, "1.2.0", false);
        assert_eq!(evaluate(&r, &state, false, NOW), NotifyDecision::Notify);
    }

    #[test]
    fn remind_later_blocks_until_deadline() {
        let mut state = UpdaterState::default();
        remind_later(&mut state, NOW, Some(6));
        let r = result(true, "1.1.0", false);
        assert_eq!(
            evaluate(&r, &state, false, NOW + 1000),
            NotifyDecision::RemindLater
        );
        assert_eq!(
            evaluate(&r, &state, false, NOW + 7 * 3_600_000),
            NotifyDecision::Notify
        );
    }

    #[test]
    fn mandatory_metadata_respects_skip_and_remind() {
        let mut state = UpdaterState::default();
        skip_version(&mut state, "1.1.0");
        remind_later(&mut state, NOW, Some(12));
        let r = result(true, "1.1.0", true);
        assert_eq!(evaluate(&r, &state, false, NOW), NotifyDecision::Skipped);
        state.skipped_versions.clear();
        assert_eq!(
            evaluate(&r, &state, false, NOW),
            NotifyDecision::RemindLater
        );
        assert_eq!(evaluate(&r, &state, true, NOW), NotifyDecision::Notify);
    }

    #[test]
    fn mandatory_by_min_supported_version() {
        assert!(is_mandatory("1.0.1", false, Some("1.1.0")));
        assert!(!is_mandatory("1.1.0", false, Some("1.1.0")));
        assert!(is_mandatory("1.0.1", true, None));
        assert!(!is_mandatory("1.0.1", false, Some("not-a-version")));
        assert!(!is_mandatory("1.0.1", false, None));
    }

    #[test]
    fn skip_is_idempotent_and_cancels_remind() {
        let mut state = UpdaterState::default();
        remind_later(&mut state, NOW, Some(3));
        skip_version(&mut state, "v1.1.0");
        skip_version(&mut state, "1.1.0");
        assert_eq!(state.skipped_versions, vec!["1.1.0".to_string()]);
        assert!(state.remind_after_ms.is_none());
    }

    #[test]
    fn prune_drops_skips_older_than_latest() {
        let mut state = UpdaterState {
            skipped_versions: vec!["1.0.9".into(), "1.1.0".into()],
            ..Default::default()
        };
        prune_skipped(&mut state, "1.1.0");
        assert_eq!(state.skipped_versions, vec!["1.1.0".to_string()]);
    }
}
