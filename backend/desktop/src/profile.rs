//! Separate shipped application profiles from development and legacy test data.
use openshell_app_core::AppServices;
use serde::Serialize;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

#[derive(Default)]
pub(crate) struct LaunchOptions {
    pub profile_dir: Option<PathBuf>,
    pub verify_clean: bool,
}

impl LaunchOptions {
    pub fn parse() -> Result<Self, String> {
        let mut options = Self::default();
        let mut args = std::env::args_os().skip(1);
        while let Some(arg) = args.next() {
            if arg == "--profile-dir" {
                let path = PathBuf::from(
                    args.next()
                        .ok_or("--profile-dir requires an absolute path")?,
                );
                if !path.is_absolute() || options.profile_dir.is_some() {
                    return Err("Use one absolute --profile-dir path".into());
                }
                options.profile_dir = Some(path);
            } else if arg == "--verify-clean-profile" {
                options.verify_clean = true;
            }
        }
        if options.verify_clean && options.profile_dir.is_none() {
            return Err("Factory verification requires an explicit isolated --profile-dir".into());
        }
        Ok(options)
    }
}

pub(crate) fn default_directory(
    base: &Path,
    exe_dir: &Path,
    development: bool,
    portable: bool,
) -> PathBuf {
    let name = if development {
        "development".to_string()
    } else if portable {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        exe_dir.hash(&mut hasher);
        format!("portable-{:016x}", hasher.finish())
    } else {
        "release".to_string()
    };
    base.join("profiles").join(name)
}

#[derive(Serialize)]
pub(crate) struct FactoryState {
    pub version: &'static str,
    pub clean: bool,
    pub vault_initialized: bool,
    pub private_rows: BTreeMap<&'static str, i64>,
}

pub(crate) fn factory_state(app: &AppServices) -> Result<FactoryState, String> {
    let mut rows = BTreeMap::new();
    app.store
        .with_conn(|conn| {
            for table in [
                "vault",
                "session",
                "session_group",
                "credential",
                "secret",
                "ssh_key",
                "known_host",
                "snippet",
                "port_forward",
                "sync_meta",
                "sync_record",
            ] {
                let count = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .map_err(|e| openshell_core_domain::DomainError::internal(e.to_string()))?;
                rows.insert(table, count);
            }
            let count = conn
                .query_row("SELECT COUNT(*) FROM setting WHERE scope='sync'", [], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| openshell_core_domain::DomainError::internal(e.to_string()))?;
            rows.insert("sync_settings", count);
            Ok(())
        })
        .map_err(|error| error.to_string())?;
    let initialized = app.vault.status().map_err(|e| e.to_string())?.state != "uninitialized";
    Ok(FactoryState {
        version: openshell_app_core::APP_VERSION,
        clean: !initialized && rows.values().all(|count| *count == 0),
        vault_initialized: initialized,
        private_rows: rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_release_and_portable_profiles_are_separate() {
        let base = Path::new("/users/example/app-data");
        let exe = Path::new("/applications/OpenShell");
        let release = default_directory(base, exe, false, false);
        assert_ne!(release, base);
        assert_ne!(release, default_directory(base, exe, true, false));
        assert_ne!(release, default_directory(base, exe, false, true));
        assert_ne!(
            default_directory(base, exe, false, true),
            default_directory(base, Path::new("/other/OpenShell"), false, true)
        );
    }

    #[test]
    fn a_factory_profile_has_no_vault_connections_or_sync_credentials() {
        let app = AppServices::new_in_memory().unwrap();
        let report = factory_state(&app).unwrap();
        assert!(report.clean);
        assert!(!report.vault_initialized);
        assert!(report.private_rows.values().all(|count| *count == 0));
    }

    #[test]
    fn legacy_test_data_is_preserved_but_never_loaded_into_a_new_release_profile() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().join("application-data");
        let old = AppServices::new(base.clone()).unwrap();
        old.vault.init("legacy-test-password", false, None).unwrap();
        old.sync
            .save_config(Some("https://legacy.example.invalid".into()), false)
            .unwrap();
        assert!(!factory_state(&old).unwrap().clean);
        drop(old);
        let release = AppServices::new(default_directory(
            &base,
            Path::new("/application"),
            false,
            false,
        ))
        .unwrap();
        assert!(factory_state(&release).unwrap().clean);
        assert!(
            !factory_state(&AppServices::new(base).unwrap())
                .unwrap()
                .clean
        );
    }
}
