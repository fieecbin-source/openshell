//! 构建期资源生成工具。
//!
//! 子命令：
//! - `catalog fetch`：拉取 models.dev 快照并写入 `backend/crates/ai/assets/catalog/`。
//! - `logos sync`：同步厂商 Logo 并生成 `logo_key` 映射。
//! - `notices`：追加 `THIRD_PARTY_NOTICES` 条目。
//!
//! 网络失败时保留仓库内已有资源、打印中文警告并以退出码 0 结束，不阻断构建。

mod catalog;
mod logos;
mod notices;
mod util;

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        [] | ["help"] | ["-h"] | ["--help"] => {
            print_help();
            ExitCode::SUCCESS
        }
        [catalog_cmd, action] if *catalog_cmd == "catalog" && *action == "fetch" => {
            catalog::fetch();
            ExitCode::SUCCESS
        }
        [logos_cmd, action] if *logos_cmd == "logos" && *action == "sync" => {
            logos::sync();
            ExitCode::SUCCESS
        }
        [notices_cmd] if *notices_cmd == "notices" => {
            notices::append();
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("未知命令：{}", other.join(" "));
            print_help();
            ExitCode::FAILURE
        }
    }
}

fn print_help() {
    println!(
        "OpenShell 构建期资源工具（openshell-xtask）\n\
         \n\
         用法：cargo run -p openshell-xtask -- <命令>\n\
         \n\
         命令：\n\
           catalog fetch   拉取 https://models.dev/api.json，写入 assets/catalog/models_snapshot.json\n\
                           与整理后的 catalog.json（含 source/fetched_at/version/sha256/providers）\n\
           logos sync      从 @lobehub/icons-static-svg 与 models.dev 下载 SVG Logo，\n\
                           写入 assets/logos/*.svg 并生成 src/catalog/logos_generated.rs\n\
           notices         在 THIRD_PARTY_NOTICES.md 末尾追加 AI 目录与 Logo 授权说明（幂等）\n\
           help            显示本帮助\n\
         \n\
         网络失败时不会删除仓库内已有快照与 Logo，进程仍以退出码 0 结束。"
    );
}
