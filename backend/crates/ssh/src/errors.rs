use openshell_core_domain::{DomainError, ErrorCode};

pub fn map_russh_error(err: russh::Error) -> DomainError {
    match err {
        russh::Error::KexInit | russh::Error::Kex => {
            DomainError::new(ErrorCode::SshProtocol, "key exchange failed")
        }
        russh::Error::NoCommonAlgo { .. } => DomainError::new(
            ErrorCode::SshProtocol,
            "no common cryptographic algorithm found",
        ),
        russh::Error::WrongServerSig => DomainError::new(
            ErrorCode::AuthFailed,
            "server signature verification failed",
        ),
        russh::Error::KeyChanged { .. } => {
            DomainError::new(ErrorCode::HostkeyMismatch, "server host key changed")
        }
        russh::Error::IndexOutOfBounds => DomainError::new(
            ErrorCode::SshProtocol,
            "protocol packet index out of bounds",
        ),
        russh::Error::ConnectionTimeout
        | russh::Error::KeepaliveTimeout
        | russh::Error::InactivityTimeout => {
            DomainError::new(ErrorCode::Timeout, "connection timed out")
        }
        russh::Error::ChannelOpenFailure(_) => DomainError::new(
            ErrorCode::ChannelLimit,
            "remote server rejected channel open request",
        ),
        russh::Error::Disconnect => {
            DomainError::new(ErrorCode::Network, "disconnected from remote server")
        }
        russh::Error::NotAuthenticated | russh::Error::NoAuthMethod => {
            DomainError::new(ErrorCode::AuthFailed, "authentication failed")
        }
        russh::Error::UnsupportedAuthMethod => DomainError::new(
            ErrorCode::AuthMethodUnsupported,
            "authentication method unsupported",
        ),
        russh::Error::RequestDenied => {
            DomainError::new(ErrorCode::Permission, "remote server denied the request")
        }
        russh::Error::IO(e) => map_io_error(e),
        other => DomainError::new(ErrorCode::SshProtocol, format!("SSH error: {}", other)),
    }
}

pub fn map_io_error(err: std::io::Error) -> DomainError {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::ConnectionRefused => DomainError::new(
            ErrorCode::HostUnreachable,
            "connection refused by remote host",
        ),
        ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted => {
            DomainError::new(ErrorCode::Network, "connection reset by peer")
        }
        ErrorKind::TimedOut => DomainError::new(ErrorCode::Timeout, "network I/O timed out"),
        ErrorKind::PermissionDenied => DomainError::new(ErrorCode::Permission, "permission denied"),
        ErrorKind::NotFound => DomainError::new(ErrorCode::NotFound, "resource not found"),
        _ => DomainError::new(ErrorCode::Io, format!("I/O error: {}", err)),
    }
}
