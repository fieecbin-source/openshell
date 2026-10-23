//! OpenShell 端口转发管理器：本地转发、远程转发与动态 SOCKS5 代理。

pub mod manager;
pub mod socks5;

pub use manager::{ForwardManager, ForwardStatus};
pub use socks5::handle_socks5_handshake;
