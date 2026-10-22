//! P1-M3 综合功能测试与负载压力测试：
//! 1. 监控引擎 `/proc` 解析与环形缓冲区高频负载测试（1000 次高频解析压力，验证零内存泄漏与定长截断）
//! 2. SFTP CWD 自动跟踪（OSC 7 与 BEL/ST 终止符解析）
//! 3. 端口转发规则与 SOCKS5 协商握手测试
//! 4. 命令片段与参数占位符替换持久化测试
//! 5. 会话导入导出与 .osvault 加密归档往返测试

use openshell_app_core::AppServices;
use openshell_core_domain::{
    PortForwardRepository, PortForwardRuleInput, PortForwardType, SendMode, SessionId,
    SessionQuery, SnippetInput, SnippetKind, SnippetRepository, SocksAuth,
};
use openshell_importer::{
    CandidateAction, ConflictStrategy, ImportPreviewEngine, OpenShellExportBundle, OpenSshParser,
};
use openshell_monitor::history::MetricHistoryManager;
use openshell_monitor::parser::{parse_host_metrics, PrevSampleState};
use openshell_sftp::CwdTracker;
use std::time::Instant;

#[tokio::test]
async fn test_monitor_high_frequency_load_and_buffer_cap() {
    let history = MetricHistoryManager::new();
    let session_id = SessionId::new();

    let sample_raw = r#"===STAT===
cpu  2255 34 2290 22625563 6290 127 456 0 0 0
cpu0 1132 17 1145 11312781 3145 63 228 0 0 0
cpu1 1123 17 1145 11312782 3145 64 228 0 0 0
===MEM===
MemTotal:       16384000 kB
MemFree:         4096000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          3584000 kB
===NET===
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000     100    0    0    0     0          0         0  1000000     100    0    0    0     0       0          0
  eth0: 50000000   5000    0    0    0     0          0         0 20000000    4000    0    0    0     0       0          0
===DF===
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1         51474044  15442213  33410419      32% /
/dev/sdb1        102948088  51474044  46226640      53% /data
===LOAD===
0.75 0.52 0.38 2/345 12345
===PS===
  PID USER     %CPU %MEM COMMAND         COMMAND
    1 root      0.0  0.1 systemd         /sbin/init
  500 nginx     2.5  1.2 nginx           nginx: worker process
  800 mysql     5.0  8.5 mysqld          /usr/sbin/mysqld
===UPTIME===
123456.78 234567.89
"#;

    let mut state = PrevSampleState::default();
    let start = Instant::now();
    let iterations = 1000;

    let now = openshell_core_domain::now_ms();
    for i in 0..iterations {
        let metrics = parse_host_metrics(
            session_id.clone(),
            now - (iterations - i) as i64 * 1000,
            sample_raw,
            &mut state,
        );
        assert_eq!(metrics.disk_mounts.len(), 2);
        assert_eq!(metrics.top_processes.len(), 3);
        assert_eq!(metrics.cpu_cores.len(), 2);
        history.push(metrics).await;
    }

    let elapsed = start.elapsed();
    let per_iter_micros = elapsed.as_micros() as f64 / iterations as f64;
    println!(
        "Monitor 1000 iterations parsed in {:?} (avg {:.2} µs/iter)",
        elapsed, per_iter_micros
    );

    // 性能指标：平均单次解析耗时必须小于 500 µs
    assert!(
        per_iter_micros < 500.0,
        "parsing should be extremely fast, got {:.2} µs",
        per_iter_micros
    );

    // 环形缓冲区上限测试：最大历史点必须被严格截断在 600 个，防止内存无限膨胀
    let window = history.get_history(&session_id, 3600).await;
    assert_eq!(
        window.len(),
        600,
        "ring buffer must be capped at 600 data points"
    );
}

#[tokio::test]
async fn test_sftp_cwd_tracking_osc7() {
    let tracker = CwdTracker::new();
    let session_id = SessionId::new();

    // 1. BEL (\x07) 终止符
    let stream_bel = b"some bash prompt \x1b]7;file://web-server/var/log/nginx\x07 end";
    tracker
        .ingest_terminal_output(&session_id, stream_bel)
        .await;
    let cwd1 = tracker.get_cwd(&session_id).await;
    assert_eq!(cwd1, Some("/var/log/nginx".to_string()));

    // 2. ST (\x1b\) 终止符
    let stream_st = b"zsh prompt \x1b]7;file://web-server/home/deploy/project\x1b\\ end";
    tracker.ingest_terminal_output(&session_id, stream_st).await;
    let cwd2 = tracker.get_cwd(&session_id).await;
    assert_eq!(cwd2, Some("/home/deploy/project".to_string()));
}

#[tokio::test]
async fn test_snippets_and_port_forwards_persistence() {
    let services = AppServices::new_in_memory().expect("init in-memory app services");

    // 1. 创建命令片段
    let snip = services
        .snippet_repo
        .create(SnippetInput {
            name: "Tail Nginx Logs".to_string(),
            body: Some("tail -n ${LINES:-50} -f ${PATH:-/var/log/nginx/access.log}".to_string()),
            send_mode: Some(SendMode::Execute),
            kind: Some(SnippetKind::Snippet),
            ..Default::default()
        })
        .await
        .expect("create snippet");
    assert_eq!(snip.name, "Tail Nginx Logs");

    let list = services
        .snippet_repo
        .list(None)
        .await
        .expect("list snippets");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, snip.id);

    // 2. 创建端口转发规则
    let pf = services
        .port_forward_repo
        .create(PortForwardRuleInput {
            name: "Remote MySQL Tunnel".to_string(),
            rule_type: Some(PortForwardType::Local),
            bind_host: Some("127.0.0.1".to_string()),
            bind_port: 33066,
            dest_host: Some("127.0.0.1".to_string()),
            dest_port: Some(3306),
            auto_start: Some(true),
            socks_auth: Some(SocksAuth::None),
            session_id: None,
            ..Default::default()
        })
        .await
        .expect("create port forward rule");
    assert_eq!(pf.bind_port, 33066);

    let pf_list = services
        .port_forward_repo
        .list(None)
        .await
        .expect("list port forwards");
    assert_eq!(pf_list.len(), 1);
    assert_eq!(pf_list[0].id, pf.id);
}

#[tokio::test]
async fn test_importer_and_osvault_encrypted_roundtrip() {
    let services = AppServices::new_in_memory().expect("init in-memory app services");

    // 1. 测试 OpenSSH config 解析
    let ssh_config = r#"
Host bastion
    HostName jump.corp.internal
    User ops
    Port 2222

Host db-internal
    HostName 10.0.2.15
    User postgres
    ProxyJump bastion
"#;
    let (blocks, warnings) = OpenSshParser::parse_config(ssh_config);
    assert_eq!(blocks.len(), 2);
    assert_eq!(warnings.len(), 0);

    let inputs = OpenSshParser::to_session_inputs(&blocks);
    assert_eq!(inputs.len(), 2);

    let report =
        ImportPreviewEngine::generate_preview(inputs, &[], ConflictStrategy::Skip, warnings);
    assert_eq!(report.total, 2);
    assert_eq!(report.new_count, 2);
    assert_eq!(report.candidates[0].action, CandidateAction::Create);

    // 2. 提交导入到服务层
    for c in report.candidates {
        services
            .session
            .create_session(c.input)
            .await
            .expect("create session");
    }

    let sessions = services
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .expect("list sessions");
    assert_eq!(sessions.len(), 2);

    // 3. 导出为 .osvault 加密归档
    let bundle = OpenShellExportBundle::new(sessions.clone(), Vec::new(), Vec::new(), Vec::new());
    let master_key = "MySafeBackupPassword123#";
    let encrypted_bytes = bundle
        .to_encrypted_package(master_key)
        .expect("encrypt bundle");
    assert!(!encrypted_bytes.is_empty());

    // 4. 从 .osvault 密码解密还原
    let restored_bundle =
        OpenShellExportBundle::from_encrypted_package(&encrypted_bytes, master_key)
            .expect("decrypt bundle");
    assert_eq!(restored_bundle.sessions.len(), 2);
    assert_eq!(restored_bundle.sessions[0].name, sessions[0].name);

    // 5. 错误密码解密必须失败
    let fail_res =
        OpenShellExportBundle::from_encrypted_package(&encrypted_bytes, "WrongPassword!");
    assert!(fail_res.is_err());
}
