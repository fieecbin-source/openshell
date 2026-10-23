//! ULID 文本标识（26 字符 Crockford Base32），对服务端不透明。

use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! id_type {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// 生成新的 ULID。
            pub fn new() -> Self {
                Self(ulid::Ulid::new().to_string())
            }

            /// 从已有字符串构造（不校验长度以外的内容）。
            pub fn from_string(s: impl Into<String>) -> Result<Self, crate::DomainError> {
                let s = s.into();
                if s.len() != 26 || !s.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Err(crate::DomainError::validation(format!(
                        "invalid {}: {}",
                        stringify!($name),
                        s
                    )));
                }
                Ok(Self(s))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl std::str::FromStr for $name {
            type Err = crate::DomainError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::from_string(s)
            }
        }
    };
}

id_type!(VaultId, "保险库标识");
id_type!(SessionId, "会话标识");
id_type!(GroupId, "分组标识");
id_type!(CredentialId, "凭据标识");
id_type!(SshKeyId, "SSH 密钥标识");
id_type!(KnownHostId, "已知主机标识");
id_type!(SnippetId, "片段标识");
id_type!(PortForwardId, "端口转发规则标识");
id_type!(SecretId, "秘密载荷标识");
id_type!(DeviceId, "设备标识");
id_type!(ConnectionId, "连接标识");
id_type!(TabId, "终端标签标识");
id_type!(CardId, "视图卡标识");

/// 生成一个 26 字符 ULID 文本。
pub fn new_id() -> String {
    ulid::Ulid::new().to_string()
}
