//! Opt-in check of the production HTTP/proxy, Release metadata and streaming download path.
use openshell_updater::download::{DownloadRequest, Downloader, FsSpaceProbe, ReqwestFetcher};
use openshell_updater::http::HostPolicy;
use openshell_updater::{Sha256Verifier, UpdateConfig, UpdateService};
use std::sync::Arc;

#[tokio::test]
#[ignore = "downloads the current published installer from GitHub"]
async fn published_installer_downloads_and_verifies() {
    let dir = tempfile::tempdir().unwrap();
    let config = UpdateConfig::default();
    let service = UpdateService::new(dir.path().join("metadata"), "0.0.0").unwrap();
    let asset = service
        .check(&config, true)
        .await
        .expect("check release")
        .result
        .asset
        .expect("native installer");
    let request = DownloadRequest {
        url: config.download_url(&asset.url),
        file_name: asset.name,
        expected_size: asset.size,
        sha256: asset.sha256.expect("published checksum"),
        dest_dir: dir.path().join("downloads"),
    };
    let fetcher = ReqwestFetcher::new(&config.proxy, HostPolicy::new(None)).unwrap();
    let result = Downloader::new(
        Arc::new(fetcher),
        Arc::new(FsSpaceProbe),
        Arc::new(Sha256Verifier),
    )
    .download(&request)
    .await
    .expect("download and checksum");
    assert_eq!(result.bytes, request.expected_size);
}
