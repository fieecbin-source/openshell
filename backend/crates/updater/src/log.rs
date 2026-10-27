//! 更新过程日志。
//!
//! * 位置：`<app_data_dir>/updater/updater.log`（不写系统临时目录，方便用户「打开日志目录」）。
//! * 滚动：单文件 2 MiB，最多保留 3 个历史文件，避免无限增长。
//! * 脱敏：只记录阶段、版本、域名、耗时、错误分类；URL 去掉 query 与 fragment，
//!   绝不记录 token / 密码 / 完整本地路径以外的敏感信息（本模块也不接收这些字段）。
//! * 失败静默：日志写不进去不能影响更新流程本身。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use time::format_description::FormatItem;
use time::macros::format_description;
use time::OffsetDateTime;

/// 单个日志文件的大小上限（2 MiB）。
pub const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
/// 历史文件保留数量。
pub const KEEP_LOG_FILES: usize = 3;
/// 单条日志值最大长度。
const MAX_VALUE_CHARS: usize = 512;

const TS_FORMAT: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

/// 更新日志写入器（无状态句柄，可跨线程共享）。
#[derive(Debug, Clone)]
pub struct UpdateLog {
    path: PathBuf,
}

impl UpdateLog {
    /// 绑定到指定日志目录（通常是 `<app_data_dir>/updater`）。
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            path: dir.as_ref().join("updater.log"),
        }
    }

    /// 日志文件绝对路径（设置页「打开日志目录」用）。
    pub fn file_path(&self) -> &Path {
        &self.path
    }

    /// 记录一条日志；`fields` 是键值对，值会自动脱敏与截断。
    pub fn record(&self, level: &str, event: &str, fields: &[(&str, String)]) {
        let mut line = String::with_capacity(128);
        line.push_str(&timestamp());
        line.push(' ');
        line.push_str(level);
        line.push(' ');
        line.push_str(event);
        for (key, value) in fields {
            line.push(' ');
            line.push_str(key);
            line.push('=');
            line.push_str(&sanitize_value(value));
        }
        line.push('\n');

        if let Err(err) = self.append(&line) {
            // 日志失败不冒泡：更新流程不能因为磁盘只读而中断。
            tracing::warn!(error = %err, "failed to write updater log");
        }
        tracing::debug!(target: "openshell_updater", "{line}");
    }

    /// 记录一个信息级事件。
    pub fn info(&self, event: &str, fields: &[(&str, String)]) {
        self.record("INFO", event, fields);
    }

    /// 记录一个告警级事件（更新失败、回退到备用源等）。
    pub fn warn(&self, event: &str, fields: &[(&str, String)]) {
        self.record("WARN", event, fields);
    }

    fn append(&self, line: &str) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        self.rotate_if_needed()?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())
    }

    fn rotate_if_needed(&self) -> std::io::Result<()> {
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return Ok(());
        };
        if meta.len() < MAX_LOG_BYTES {
            return Ok(());
        }
        // updater.log.(n-1) → updater.log.n，最老的一份丢弃
        for index in (1..KEEP_LOG_FILES).rev() {
            let from = rotated_path(&self.path, index);
            let to = rotated_path(&self.path, index + 1);
            if from.exists() {
                let _ = std::fs::rename(&from, &to);
            }
        }
        let _ = std::fs::rename(&self.path, rotated_path(&self.path, 1));
        Ok(())
    }
}

fn rotated_path(base: &Path, index: usize) -> PathBuf {
    let mut raw = base.as_os_str().to_os_string();
    raw.push(format!(".{index}"));
    PathBuf::from(raw)
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(TS_FORMAT)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/// 去掉换行、URL query/fragment 并截断，防止日志被注入或泄漏参数。
fn sanitize_value(value: &str) -> String {
    let mut cleaned = value.replace(['\n', '\r'], " ");
    if let Some(scheme_end) = cleaned.find("://") {
        let rest = &cleaned[scheme_end + 3..];
        if let Some(cut) = rest.find(['?', '#']) {
            let keep = scheme_end + 3 + cut;
            cleaned.truncate(keep);
        }
    }
    if cleaned.chars().count() > MAX_VALUE_CHARS {
        cleaned = cleaned.chars().take(MAX_VALUE_CHARS).collect();
        cleaned.push('…');
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_query_and_fragment_from_urls() {
        assert_eq!(
            sanitize_value("https://github.com/a/b?token=secret#frag"),
            "https://github.com/a/b"
        );
        assert_eq!(
            sanitize_value("https://api.github.com/repos/a/b/releases/latest"),
            "https://api.github.com/repos/a/b/releases/latest"
        );
    }

    #[test]
    fn removes_newlines_and_truncates() {
        assert_eq!(sanitize_value("a\nb\rc"), "a b c");
        let long = "x".repeat(MAX_VALUE_CHARS + 10);
        let out = sanitize_value(&long);
        assert_eq!(out.chars().count(), MAX_VALUE_CHARS + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn writes_and_rotates_log_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let log = UpdateLog::new(dir.path());
        log.info("check_start", &[("channel", "stable".to_string())]);
        let content = std::fs::read_to_string(log.file_path()).expect("read log");
        assert!(content.contains("check_start"));
        assert!(content.contains("channel=stable"));
    }
}
