//! 监控数据解析器：Linux /proc 与降级输出解析。

use openshell_core_domain::{DiskMountMetrics, HostMetrics, ProcessMetrics, SessionId};

/// 上一次采样快照状态（用于计算 CPU% 和网络速率差值）。
#[derive(Debug, Clone, Default)]
pub struct PrevSampleState {
    pub total_cpu_time: u64,
    pub idle_cpu_time: u64,
    pub core_times: Vec<(u64, u64)>, // (total, idle)
    pub net_rx_total: u64,
    pub net_tx_total: u64,
    pub timestamp_ms: i64,
}

pub struct ParsedOutput {
    pub stat_section: Option<String>,
    pub mem_section: Option<String>,
    pub net_section: Option<String>,
    pub df_section: Option<String>,
    pub load_section: Option<String>,
    pub ps_section: Option<String>,
    pub uptime_section: Option<String>,
}

/// 拆解分段输出。
pub fn split_sections(raw: &str) -> ParsedOutput {
    let mut stat = None;
    let mut mem = None;
    let mut net = None;
    let mut df = None;
    let mut load = None;
    let mut ps = None;
    let mut uptime = None;

    let parts: Vec<&str> = raw.split("===").collect();
    let mut i = 0;
    while i < parts.len() {
        let tag = parts[i].trim();
        if i + 1 < parts.len() {
            let content = parts[i + 1].trim().to_string();
            match tag {
                "STAT" => stat = Some(content),
                "MEM" => mem = Some(content),
                "NET" => net = Some(content),
                "DF" => df = Some(content),
                "LOAD" => load = Some(content),
                "PS" => ps = Some(content),
                "UPTIME" => uptime = Some(content),
                _ => {}
            }
        }
        i += 1;
    }

    ParsedOutput {
        stat_section: stat,
        mem_section: mem,
        net_section: net,
        df_section: df,
        load_section: load,
        ps_section: ps,
        uptime_section: uptime,
    }
}

/// 解析完整的 HostMetrics。
pub fn parse_host_metrics(
    session_id: SessionId,
    timestamp_ms: i64,
    raw_output: &str,
    prev: &mut PrevSampleState,
) -> HostMetrics {
    let sections = split_sections(raw_output);

    // 1. CPU
    let (cpu_percent, cpu_cores) = if let Some(stat) = sections.stat_section.as_deref() {
        parse_cpu_stat(stat, prev)
    } else {
        (0.0, Vec::new())
    };

    // 2. Memory
    let (mem_total, mem_used, mem_cached) = if let Some(mem) = sections.mem_section.as_deref() {
        parse_meminfo(mem)
    } else {
        (0, 0, 0)
    };

    // 3. Load
    let (load1, load5, load15) = if let Some(load) = sections.load_section.as_deref() {
        parse_loadavg(load)
    } else {
        (0.0, 0.0, 0.0)
    };

    // 4. Net
    let (rx_bps, tx_bps, rx_total, tx_total) = if let Some(net) = sections.net_section.as_deref() {
        parse_net_dev(net, timestamp_ms, prev)
    } else {
        (0, 0, 0, 0)
    };

    // 5. Disk
    let disk_mounts = if let Some(df) = sections.df_section.as_deref() {
        parse_df(df)
    } else {
        Vec::new()
    };

    // 6. PS
    let top_processes = if let Some(ps) = sections.ps_section.as_deref() {
        parse_ps(ps)
    } else {
        Vec::new()
    };

    // 7. Uptime
    let uptime_seconds = if let Some(up) = sections.uptime_section.as_deref() {
        parse_uptime(up)
    } else {
        0
    };

    prev.timestamp_ms = timestamp_ms;

    HostMetrics {
        session_id,
        timestamp_ms,
        cpu_percent,
        cpu_cores,
        memory_total_bytes: mem_total,
        memory_used_bytes: mem_used,
        memory_cached_bytes: mem_cached,
        load_1: load1,
        load_5: load5,
        load_15: load15,
        net_rx_bps: rx_bps,
        net_tx_bps: tx_bps,
        net_rx_total: rx_total,
        net_tx_total: tx_total,
        disk_mounts,
        top_processes,
        uptime_seconds,
    }
}

fn parse_cpu_stat(stat: &str, prev: &mut PrevSampleState) -> (f64, Vec<f64>) {
    let mut total_percent = 0.0;
    let mut cores = Vec::new();
    let mut new_core_times = Vec::new();

    for line in stat.lines() {
        if line.starts_with("cpu ") {
            let fields: Vec<u64> = line
                .split_whitespace()
                .skip(1)
                .filter_map(|s| s.parse().ok())
                .collect();
            if fields.len() >= 4 {
                let user = fields[0];
                let nice = fields[1];
                let system = fields[2];
                let idle = fields[3];
                let iowait = fields.get(4).copied().unwrap_or(0);
                let irq = fields.get(5).copied().unwrap_or(0);
                let softirq = fields.get(6).copied().unwrap_or(0);
                let steal = fields.get(7).copied().unwrap_or(0);

                let total = user + nice + system + idle + iowait + irq + softirq + steal;
                let idle_all = idle + iowait;

                if prev.total_cpu_time > 0 && total > prev.total_cpu_time {
                    let diff_total = total - prev.total_cpu_time;
                    let diff_idle = idle_all.saturating_sub(prev.idle_cpu_time);
                    if diff_total > 0 {
                        let used = diff_total.saturating_sub(diff_idle);
                        total_percent = (used as f64 / diff_total as f64) * 100.0;
                    }
                }
                prev.total_cpu_time = total;
                prev.idle_cpu_time = idle_all;
            }
        } else if line.starts_with("cpu")
            && line
                .chars()
                .nth(3)
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
        {
            let fields: Vec<u64> = line
                .split_whitespace()
                .skip(1)
                .filter_map(|s| s.parse().ok())
                .collect();
            if fields.len() >= 4 {
                let total: u64 = fields.iter().sum();
                let idle = fields[3] + fields.get(4).copied().unwrap_or(0);
                let core_idx = cores.len();
                let mut core_pct = 0.0;

                if let Some(&(p_total, p_idle)) = prev.core_times.get(core_idx) {
                    if total > p_total {
                        let diff_total = total - p_total;
                        let diff_idle = idle.saturating_sub(p_idle);
                        if diff_total > 0 {
                            let used = diff_total.saturating_sub(diff_idle);
                            core_pct = (used as f64 / diff_total as f64) * 100.0;
                        }
                    }
                }
                cores.push(core_pct.clamp(0.0, 100.0));
                new_core_times.push((total, idle));
            }
        }
    }

    if !new_core_times.is_empty() {
        prev.core_times = new_core_times;
    }

    (total_percent.clamp(0.0, 100.0), cores)
}

fn parse_meminfo(meminfo: &str) -> (u64, u64, u64) {
    let mut total_kb = 0u64;
    let mut free_kb = 0u64;
    let mut avail_kb = None;
    let mut buffers_kb = 0u64;
    let mut cached_kb = 0u64;

    for line in meminfo.lines() {
        let mut parts = line.split(':');
        if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
            let val = v
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            match k.trim() {
                "MemTotal" => total_kb = val,
                "MemFree" => free_kb = val,
                "MemAvailable" => avail_kb = Some(val),
                "Buffers" => buffers_kb = val,
                "Cached" => cached_kb = val,
                _ => {}
            }
        }
    }

    let total = total_kb * 1024;
    let cached = (buffers_kb + cached_kb) * 1024;
    let used = if let Some(avail) = avail_kb {
        total_kb.saturating_sub(avail) * 1024
    } else {
        total_kb.saturating_sub(free_kb + buffers_kb + cached_kb) * 1024
    };

    (total, used, cached)
}

fn parse_loadavg(loadavg: &str) -> (f64, f64, f64) {
    let parts: Vec<&str> = loadavg.split_whitespace().collect();
    if parts.len() >= 3 {
        let l1 = parts[0].parse().unwrap_or(0.0);
        let l5 = parts[1].parse().unwrap_or(0.0);
        let l15 = parts[2].parse().unwrap_or(0.0);
        (l1, l5, l15)
    } else {
        (0.0, 0.0, 0.0)
    }
}

fn parse_net_dev(
    net_dev: &str,
    timestamp_ms: i64,
    prev: &mut PrevSampleState,
) -> (u64, u64, u64, u64) {
    let mut total_rx = 0u64;
    let mut total_tx = 0u64;

    for line in net_dev.lines() {
        if let Some((iface, data)) = line.split_once(':') {
            let iface = iface.trim();
            if iface == "lo" {
                continue;
            }
            let fields: Vec<u64> = data
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            if fields.len() >= 9 {
                total_rx += fields[0];
                total_tx += fields[8];
            }
        }
    }

    let mut rx_bps = 0u64;
    let mut tx_bps = 0u64;

    if prev.timestamp_ms > 0 && timestamp_ms > prev.timestamp_ms {
        let delta_sec = (timestamp_ms - prev.timestamp_ms) as f64 / 1000.0;
        if delta_sec > 0.0 {
            if total_rx >= prev.net_rx_total {
                rx_bps = ((total_rx - prev.net_rx_total) as f64 / delta_sec) as u64;
            }
            if total_tx >= prev.net_tx_total {
                tx_bps = ((total_tx - prev.net_tx_total) as f64 / delta_sec) as u64;
            }
        }
    }

    prev.net_rx_total = total_rx;
    prev.net_tx_total = total_tx;

    (rx_bps, tx_bps, total_rx, total_tx)
}

fn parse_df(df: &str) -> Vec<DiskMountMetrics> {
    let mut mounts = Vec::new();
    let lines: Vec<&str> = df.lines().collect();
    if lines.is_empty() {
        return mounts;
    }

    // 跳过首行表头
    for line in lines.iter().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() >= 6 {
            let fs = fields[0].to_string();
            // 过滤虚拟文件系统
            if fs == "tmpfs" || fs == "devtmpfs" || fs == "udev" || fs == "overlay" {
                continue;
            }
            let total_kb = fields[1].parse::<u64>().unwrap_or(0);
            let used_kb = fields[2].parse::<u64>().unwrap_or(0);
            let avail_kb = fields[3].parse::<u64>().unwrap_or(0);
            let pct_str = fields[4].trim_end_matches('%');
            let use_percent = pct_str.parse::<f64>().unwrap_or(0.0);
            let mount_point = fields[5].to_string();

            mounts.push(DiskMountMetrics {
                mount_point,
                filesystem: fs,
                total_bytes: total_kb * 1024,
                used_bytes: used_kb * 1024,
                available_bytes: avail_kb * 1024,
                use_percent,
            });
        }
    }

    mounts
}

/// 从命令行里取可执行文件名，用于 ps 输出没有独立 comm 列时的回退展示。
fn short_name(command_line: &str) -> String {
    let first = command_line.split_whitespace().next().unwrap_or("");
    let base = first.rsplit('/').next().unwrap_or(first);
    if base.is_empty() {
        command_line.to_string()
    } else {
        base.to_string()
    }
}

/// 解析 ps 输出。
///
/// 远端环境差异很大，不能假设只有一种格式：
/// - `ps -eo pid,user,pcpu,pmem,comm,args`（procps / BSD，本项目的首选命令）
/// - `ps aux`（BusyBox、macOS：USER PID %CPU %MEM VSZ RSS ... COMMAND）
/// - `ps -ef`（无 CPU/MEM 列：UID PID PPID C STIME TTY TIME CMD）
/// - 裸 `ps`（BusyBox：PID USER TIME COMMAND，无 CPU/MEM 列）
///
/// 旧实现固定 `skip(1)` 跳过表头并强制要求 5 列以上，导致 BusyBox/Alpine
/// 这类只有 4 列的 `ps` 输出被整段丢弃 —— 表现就是「进程列表一直是空的」。
fn parse_ps(ps: &str) -> Vec<ProcessMetrics> {
    let mut list: Vec<ProcessMetrics> = Vec::new();

    for line in ps.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }

        let push = |list: &mut Vec<ProcessMetrics>,
                    pid: u32,
                    user: String,
                    cpu_percent: f64,
                    memory_percent: f64,
                    name: String,
                    command: String| {
            if pid == 0 {
                return;
            }
            list.push(ProcessMetrics {
                pid,
                user,
                cpu_percent,
                memory_percent,
                name,
                command,
            });
        };

        // 形态 1：PID 在第一列（ps -eo ... / ps -ef / busybox ps）
        if let Ok(pid) = fields[0].parse::<u32>() {
            let user = fields[1].to_string();
            let cpu_ok = fields[2].parse::<f64>().is_ok();
            let mem_ok = fields[3].parse::<f64>().is_ok();

            if cpu_ok && mem_ok && fields.len() >= 5 {
                // ps -eo pid,user,pcpu,pmem,comm,args
                let name = fields[4].to_string();
                let command = if fields.len() > 5 {
                    fields[5..].join(" ")
                } else {
                    name.clone()
                };
                push(
                    &mut list,
                    pid,
                    user,
                    fields[2].parse().unwrap_or(0.0),
                    fields[3].parse().unwrap_or(0.0),
                    name,
                    command,
                );
            } else {
                // busybox: PID USER TIME COMMAND（无 CPU / MEM 列）
                let command = fields[3..].join(" ");
                push(
                    &mut list,
                    pid,
                    user,
                    0.0,
                    0.0,
                    short_name(&command),
                    command,
                );
            }
            continue;
        }

        // 形态 2：USER/UID 在第一列
        if let Ok(pid) = fields[1].parse::<u32>() {
            // ps aux 的 %CPU/%MEM 一定是带小数点的百分比；ps -ef 的第 4 列是整数 C，
            // 用它区分，避免把 ps -ef 的长命令行整体裁掉。
            let aux_like = fields.len() >= 11
                && fields[2].parse::<f64>().is_ok()
                && fields[3].parse::<f64>().is_ok()
                && (fields[2].contains('.') || fields[3].contains('.'));

            if aux_like {
                // ps aux
                let command = fields[10..].join(" ");
                push(
                    &mut list,
                    pid,
                    fields[0].to_string(),
                    fields[2].parse().unwrap_or(0.0),
                    fields[3].parse().unwrap_or(0.0),
                    short_name(&command),
                    command,
                );
            } else if fields.len() >= 8 {
                // ps -ef
                let command = fields[7..].join(" ");
                push(
                    &mut list,
                    pid,
                    fields[0].to_string(),
                    0.0,
                    0.0,
                    short_name(&command),
                    command,
                );
            }
        }
    }

    // 统一按 CPU 占用降序，保证面板顶部就是最吃 CPU 的进程
    list.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    list.truncate(30);
    list
}

fn parse_uptime(uptime: &str) -> u64 {
    uptime
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|f| f as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_meminfo_basic() {
        let sample = "MemTotal:       16384000 kB\nMemFree:         4096000 kB\nMemAvailable:   10240000 kB\nBuffers:          500000 kB\nCached:          2000000 kB\n";
        let (total, used, cached) = parse_meminfo(sample);
        assert_eq!(total, 16384000 * 1024);
        assert_eq!(used, (16384000 - 10240000) * 1024);
        assert_eq!(cached, (500000 + 2000000) * 1024);
    }

    #[test]
    fn test_parse_loadavg_basic() {
        let sample = "0.45 0.52 0.61 1/840 12345";
        let (l1, l5, l15) = parse_loadavg(sample);
        assert!((l1 - 0.45).abs() < 1e-4);
        assert!((l5 - 0.52).abs() < 1e-4);
        assert!((l15 - 0.61).abs() < 1e-4);
    }

    #[test]
    fn test_parse_df_basic() {
        let sample = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1        104857600  41943040  62914560      40% /\ntmpfs              8192000         0   8192000       0% /dev/shm\n/dev/sdb1        209715200 104857600 104857600      50% /data\n";
        let mounts = parse_df(sample);
        assert_eq!(mounts.len(), 2);
        assert_eq!(mounts[0].mount_point, "/");
        assert_eq!(mounts[0].use_percent, 40.0);
        assert_eq!(mounts[1].mount_point, "/data");
    }

    #[test]
    fn test_parse_ps_basic() {
        let sample = "  PID USER     %CPU %MEM COMMAND COMMAND\n 1234 root      2.5  1.2 nginx   nginx: master process\n 5678 ops       0.8  3.4 node    node server.js\n";
        let procs = parse_ps(sample);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].user, "root");
        assert_eq!(procs[0].cpu_percent, 2.5);
        assert_eq!(procs[0].command, "nginx: master process");
    }

    /// BusyBox（Alpine 等）裸 ps 只有 4 列，旧实现会整段丢弃。
    #[test]
    fn test_parse_ps_busybox_columns() {
        let sample = "PID   USER     TIME  COMMAND\n    1 root      0:02 init\n  230 root      0:00 /usr/sbin/sshd -D\n";
        let procs = parse_ps(sample);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1);
        assert_eq!(procs[0].name, "init");
        let sshd = procs.iter().find(|p| p.pid == 230).expect("sshd 应被解析");
        assert_eq!(sshd.command, "/usr/sbin/sshd -D");
        assert_eq!(sshd.name, "sshd");
    }

    /// ps aux（BusyBox / macOS）：USER 在第一列，COMMAND 从第 11 列开始。
    #[test]
    fn test_parse_ps_aux_format() {
        let sample = "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n\
root         1  0.0  0.1 169312 12000 ?        Ss   Oct01   0:05 /sbin/init splash\n\
mysql      902  5.0  8.5 1200312 340000 ?      Sl   10:00   3:12 /usr/sbin/mysqld --defaults-file=/etc/my.cnf\n";
        let procs = parse_ps(sample);
        assert_eq!(procs.len(), 2);
        // 按 CPU 降序：mysqld 在前
        assert_eq!(procs[0].pid, 902);
        assert_eq!(procs[0].cpu_percent, 5.0);
        assert_eq!(procs[0].memory_percent, 8.5);
        assert_eq!(procs[0].name, "mysqld");
        assert_eq!(procs[1].user, "root");
    }
}
