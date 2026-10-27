use openshell_core_domain::{DomainError, ErrorCode};

pub fn map_russh_error(err: russh::Error) -> DomainError {
    match err {
        russh::Error::KexInit | russh::Error::Kex => DomainError::new(
            ErrorCode::SshProtocol,
            "SSH 密钥协商初始化失败，请检查服务器支持的加密套件",
        ),
        russh::Error::NoCommonAlgo { .. } => DomainError::new(
            ErrorCode::SshProtocol,
            "未找到客户端与服务器共同支持的加密算法，请检查服务器 sshd 配置",
        ),
        russh::Error::WrongServerSig => {
            DomainError::new(ErrorCode::AuthFailed, "服务器主机密钥签名校验失败")
        }
        russh::Error::KeyChanged { .. } => DomainError::new(
            ErrorCode::HostkeyMismatch,
            "目标服务器的主机公钥已变更，请核对已知主机列表",
        ),
        russh::Error::IndexOutOfBounds => {
            DomainError::new(ErrorCode::SshProtocol, "SSH 协议数据包格式异常 (越界)")
        }
        russh::Error::ConnectionTimeout
        | russh::Error::KeepaliveTimeout
        | russh::Error::InactivityTimeout => {
            DomainError::new(ErrorCode::Timeout, "连接已超时，服务器无响应")
        }
        russh::Error::ChannelOpenFailure(_) => DomainError::new(
            ErrorCode::ChannelLimit,
            "远端服务器拒绝打开终端会话通道 (Channel Open Failure)",
        ),
        russh::Error::Disconnect => DomainError::new(ErrorCode::Network, "已与远端服务器断开连接"),
        russh::Error::NotAuthenticated | russh::Error::NoAuthMethod => DomainError::new(
            ErrorCode::AuthFailed,
            "身份认证失败：用户名、密码或公钥不正确",
        ),
        russh::Error::UnsupportedAuthMethod => DomainError::new(
            ErrorCode::AuthMethodUnsupported,
            "远端服务器不支持所选的认证方式",
        ),
        russh::Error::RequestDenied => {
            DomainError::new(ErrorCode::Permission, "远端服务器拒绝了操作请求")
        }
        russh::Error::IO(e) => map_io_error(e),
        other => DomainError::new(ErrorCode::SshProtocol, format!("SSH 连接异常: {other}")),
    }
}

pub fn map_io_error(err: std::io::Error) -> DomainError {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::ConnectionRefused => DomainError::new(
            ErrorCode::HostUnreachable,
            "连接被远端主机拒绝，请检查目标 IP 与端口是否开放以及 SSH 服务是否正常启动",
        ),
        ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted => DomainError::new(
            ErrorCode::Network,
            "网络连接被远端对等方重置或中断 (Connection Reset)",
        ),
        ErrorKind::TimedOut => DomainError::new(
            ErrorCode::Timeout,
            "网络连接请求超时，请检查网络通畅度及防火墙放行规则",
        ),
        ErrorKind::PermissionDenied => {
            DomainError::new(ErrorCode::Permission, "网络套接字操作权限不足")
        }
        ErrorKind::NotFound => {
            DomainError::new(ErrorCode::NotFound, "未找到目标网络资源或本地套接字")
        }
        _ => DomainError::new(ErrorCode::Io, format!("底层网络 I/O 错误: {err}")),
    }
}
