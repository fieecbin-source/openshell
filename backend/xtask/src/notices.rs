//! `notices`：向 `THIRD_PARTY_NOTICES.md` 追加 AI 目录与品牌 Logo 授权说明（幂等）。

use crate::util;
use std::fs;

const MARKER: &str = "<!-- AI-CATALOG-AND-LOGO-NOTICES -->";

const SECTION: &str = r#"<!-- AI-CATALOG-AND-LOGO-NOTICES -->

---

## 4. AI 厂商目录与品牌 Logo

### 4.1 models.dev 数据快照

- **项目**：models.dev（<https://models.dev>，源码仓库 <https://github.com/anomalyco/models.dev>）
- **许可证**：MIT
- **用途**：构建期由 `openshell-xtask` 拉取 <https://models.dev/api.json>，生成厂商 / 模型目录快照并内置于 OpenShell 二进制；运行时优先使用内置快照，外网失败时自动回退。
- **声明**：数据按“原样（AS IS）”提供，OpenShell 不背书其准确性、完整性或时效性。

### 4.2 @lobehub/icons-static-svg 品牌图标

- **项目**：LobeHub Icons（<https://github.com/lobehub/lobe-icons>）
- **许可证**：MIT
- **用途**：构建期下载厂商 SVG 图标并内置于设置页、模型选择器与 AI 模式 Logo 流星特效；部分缺失图标由 models.dev（MIT）补充。
- **商标声明**：文中出现的所有厂商名称、Logo 与商标均归其各自权利人所有。本项目仅在识别与展示场景中按原样式使用，不构成任何隶属、赞助、担保或背书关系。
- **回退图标**：当厂商图标缺失或安全校验未通过时，使用 OpenShell 自绘的赛博朋克风格 AI 核心 SVG，随本项目源码以 MIT OR Apache-2.0 授权发布。
"#;

pub fn append() {
    let path = util::workspace_root().join("THIRD_PARTY_NOTICES.md");
    let existing = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) => {
            eprintln!("⚠ 无法读取 {}：{err}", path.display());
            return;
        }
    };
    if existing.contains(MARKER) {
        println!("✓ {} 已包含 AI 目录与 Logo 声明，跳过追加", path.display());
        return;
    }
    let mut updated = existing;
    if !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push('\n');
    updated.push_str(SECTION);
    match fs::write(&path, updated) {
        Ok(()) => println!("✓ 已向 {} 追加 AI 目录与 Logo 授权说明", path.display()),
        Err(err) => eprintln!("⚠ 写入 {} 失败：{err}", path.display()),
    }
}
