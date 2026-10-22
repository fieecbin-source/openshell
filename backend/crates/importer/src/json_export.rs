//! JSON 导入导出与加密包封装（对齐 SPEC IMP-004 ~ IMP-006）。

use openshell_core_domain::{Group, PortForwardRule, Session, Snippet};
use openshell_vault::kdf::KdfParams;
use openshell_vault::package::{open_package, seal_package};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenShellExportBundle {
    pub schema_version: u32,
    pub exported_at: i64,
    pub app_version: String,
    pub sessions: Vec<Session>,
    pub groups: Vec<Group>,
    pub snippets: Vec<Snippet>,
    pub port_forwards: Vec<PortForwardRule>,
}

impl OpenShellExportBundle {
    pub fn new(
        sessions: Vec<Session>,
        groups: Vec<Group>,
        snippets: Vec<Snippet>,
        port_forwards: Vec<PortForwardRule>,
    ) -> Self {
        Self {
            schema_version: 1,
            exported_at: openshell_core_domain::now_ms(),
            app_version: "0.1.0".to_string(),
            sessions,
            groups,
            snippets,
            port_forwards,
        }
    }

    /// 导出为明文字符串。
    pub fn to_json_string(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// 从明文字符串解析。
    pub fn from_json_str(s: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(s)
    }

    /// 导出为受密码保护的加密二进制包（.osvault）。
    pub fn to_encrypted_package(
        &self,
        password: &str,
    ) -> Result<Vec<u8>, openshell_core_domain::DomainError> {
        let json_bytes = serde_json::to_vec(self).map_err(|e| {
            openshell_core_domain::DomainError::internal(format!("serialize bundle failed: {e}"))
        })?;
        seal_package(password, &json_bytes, KdfParams::default())
    }

    /// 从加密二进制包解密并加载。
    pub fn from_encrypted_package(
        pkg_bytes: &[u8],
        password: &str,
    ) -> Result<Self, openshell_core_domain::DomainError> {
        let decrypted = open_package(password, pkg_bytes)?;
        serde_json::from_slice(&decrypted).map_err(|e| {
            openshell_core_domain::DomainError::validation(format!("corrupt bundle json: {e}"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_bundle_json_and_encrypted_roundtrip() {
        let bundle = OpenShellExportBundle::new(Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let json = bundle.to_json_string().expect("serialize json");
        let parsed = OpenShellExportBundle::from_json_str(&json).expect("parse json");
        assert_eq!(parsed.schema_version, 1);

        let pass = "StrongExportPassword123!";
        let encrypted = bundle.to_encrypted_package(pass).expect("encrypt");
        let restored =
            OpenShellExportBundle::from_encrypted_package(&encrypted, pass).expect("decrypt");
        assert_eq!(restored.schema_version, 1);

        assert!(OpenShellExportBundle::from_encrypted_package(&encrypted, "wrongpass").is_err());
    }
}
