//! 仓储实现：`core-domain` 端口契约的 SQLite 适配。

pub mod credential;
pub mod group;
pub mod known_host;
pub mod port_forward;
pub mod secret;
pub mod session;
pub mod settings;
pub mod snippet;
pub mod ssh_key;
pub mod vault;

pub use credential::CredentialRepo;
pub use group::GroupRepo;
pub use known_host::KnownHostRepo;
pub use port_forward::PortForwardRepo;
pub use secret::SecretRepo;
pub use session::SessionRepo;
pub use settings::SettingsRepo;
pub use snippet::SnippetRepo;
pub use ssh_key::SshKeyRepo;
pub use vault::VaultRepo;
