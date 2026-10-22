use openshell_serial::{
    list_serial_ports, DataBits, FlowControl, MockSerialBackend, NewlineMode, OutputNewlineMode,
    Parity, SerialBackend, SerialError, SerialProfileConfig, SerialService, StopBits,
};

#[tokio::test]
async fn test_mock_serial_basic_rw() {
    let mut backend = MockSerialBackend::new();
    let config = SerialProfileConfig {
        port_name: "COM99".to_string(),
        baud_rate: 115200,
        data_bits: DataBits::Eight,
        stop_bits: StopBits::One,
        parity: Parity::None,
        flow_control: FlowControl::None,
        dtr_on_open: true,
        rts_on_open: true,
        input_newline: NewlineMode::Crlf,
        output_newline: OutputNewlineMode::LfToCrlf,
        local_echo: false,
        auto_reconnect: false,
        reconnect_interval_ms: 1000,
    };

    backend.open(&config).await.expect("open should succeed");
    assert!(backend.is_open());

    // 写入数据
    let written = backend.write(b"Hello Serial").await.expect("write ok");
    assert_eq!(written, 12);
    assert_eq!(backend.take_tx(), b"Hello Serial");

    // 注入数据并读取
    backend.inject_rx(b"Response 123");
    let mut buf = [0u8; 64];
    let n = backend.read(&mut buf).await.expect("read ok");
    assert_eq!(n, 12);
    assert_eq!(&buf[..n], b"Response 123");

    // 引脚控制
    backend.set_dtr(false).await.unwrap();
    assert!(!backend.get_dtr());
    backend.set_rts(false).await.unwrap();
    assert!(!backend.get_rts());

    let modem = backend.read_modem_status().await.unwrap();
    assert!(modem.cts);
    assert!(modem.dsr);

    // 热修改波特率
    backend.set_baud_rate(921600).await.unwrap();

    // 关闭
    backend.close().await.unwrap();
    assert!(!backend.is_open());
}

#[tokio::test]
async fn test_mock_serial_auto_responder() {
    let mut backend = MockSerialBackend::new();
    let config = SerialProfileConfig::default();
    backend.open(&config).await.unwrap();

    // 设定 AT 握手自动回包
    backend.add_responder(b"AT\r\n", b"\r\nOK\r\n");

    backend.write(b"AT\r\n").await.unwrap();
    assert_eq!(backend.take_tx(), b"AT\r\n");

    let mut buf = [0u8; 32];
    let n = backend.read(&mut buf).await.unwrap();
    assert_eq!(n, 6);
    assert_eq!(&buf[..n], b"\r\nOK\r\n");
}

#[tokio::test]
async fn test_mock_serial_unplug_and_busy() {
    let mut backend = MockSerialBackend::new();
    let config = SerialProfileConfig::default();

    // 测试占用失败
    backend.set_simulate_busy(true);
    let res = backend.open(&config).await;
    assert!(matches!(res, Err(SerialError::PortBusy(_))));

    // 解除占用，打开成功
    backend.set_simulate_busy(false);
    backend.open(&config).await.unwrap();
    assert!(backend.is_open());

    // 模拟热拔出
    backend.simulate_unplug();
    assert!(!backend.is_open());
    let mut buf = [0u8; 16];
    let read_res = backend.read(&mut buf).await;
    assert!(matches!(read_res, Err(SerialError::DeviceDisconnected)));

    let write_res = backend.write(b"test").await;
    assert!(matches!(write_res, Err(SerialError::DeviceDisconnected)));
}

#[tokio::test]
async fn test_serial_service_management_and_stats() {
    let service = SerialService::new();
    let card_id = "card-serial-01";
    let config = SerialProfileConfig::default();

    // 打开 Mock 会话
    service.open(card_id, &config, true).await.unwrap();
    assert!(service.is_open(card_id).await);

    let mock = service.get_mock(card_id).await.expect("mock backend available");

    // 写入
    service.write(card_id, b"DATA_OUT").await.unwrap();
    assert_eq!(mock.take_tx(), b"DATA_OUT");

    // 注入并读取
    mock.inject_rx(b"DATA_IN");
    let mut buf = [0u8; 32];
    let n = service.read(card_id, &mut buf).await.unwrap();
    assert_eq!(&buf[..n], b"DATA_IN");

    // 检查流量统计
    let stats = service.get_stats(card_id).await.unwrap();
    assert_eq!(stats.tx_bytes, 8);
    assert_eq!(stats.rx_bytes, 7);

    // 关闭
    service.close(card_id).await.unwrap();
    assert!(!service.is_open(card_id).await);
}

#[test]
fn test_list_serial_ports_safe() {
    // 验证枚举函数在当前系统上可安全执行，不引发 panic
    let ports = list_serial_ports().unwrap();
    // ports 可能是空的（如果没有接入 USB 转串口），但类型与结构完整
    println!("Found {} serial ports", ports.len());
}

#[tokio::test]
async fn test_high_baud_rate_throughput_921600() {
    let service = SerialService::new();
    let card_id = "card-high-speed-01";
    let mut config = SerialProfileConfig::default();
    config.baud_rate = 921600;

    service.open(card_id, &config, true).await.unwrap();
    let mock = service.get_mock(card_id).await.unwrap();

    // 产生 1MB (1,048,576 字节) 连续数据流
    let total_bytes = 1024 * 1024;
    let mut test_payload = Vec::with_capacity(total_bytes);
    for i in 0..total_bytes {
        test_payload.push((i % 256) as u8);
    }

    let start = std::time::Instant::now();

    // 模拟远端高速持续推入数据
    mock.inject_rx(&test_payload);

    // 客户端以 16 KiB 块读取
    let mut received = Vec::with_capacity(total_bytes);
    let mut chunk = [0u8; 16384];
    while received.len() < total_bytes {
        let n = service.read(card_id, &mut chunk).await.unwrap();
        if n == 0 {
            break;
        }
        received.extend_from_slice(&chunk[..n]);
    }

    let elapsed = start.elapsed();
    let speed_mb_s = (total_bytes as f64 / 1024.0 / 1024.0) / elapsed.as_secs_f64();

    println!(
        "921600 baud stream test: received {} bytes in {:?} ({:.2} MB/s)",
        received.len(),
        elapsed,
        speed_mb_s
    );

    // 验证 100% 完整性，0 丢包
    assert_eq!(received.len(), total_bytes);
    assert_eq!(received, test_payload);

    service.close(card_id).await.unwrap();
}

