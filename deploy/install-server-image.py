#!/usr/bin/env python3
"""Deploy a published server image, preserving rollback data and private config."""
import argparse
import base64
import datetime
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request


def run(*args, check=False):
    result = subprocess.run(args, capture_output=True, text=True)
    if check and result.returncode:
        raise SystemExit("Command failed: " + args[0] + " " + args[1])
    return result


def dotenv(path):
    values = {}
    if not path.is_file():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.removeprefix("export ").partition("=")
        if not separator:
            continue
        if value.startswith(("'", '"')):
            parts = shlex.split(value, comments=True)
            value = parts[0] if len(parts) == 1 else ""
        values[key.strip()] = value
    return values


def inspect(legacy):
    containers = []
    if shutil.which("docker") and run("docker", "info").returncode == 0:
        ids = run("docker", "ps", "-aq", "--filter", "label=com.docker.compose.service=openshell-server").stdout.split()
        named = run("docker", "ps", "-aq", "--filter", "name=^/openshell-server$").stdout.split()
        for cid in dict.fromkeys(ids + named):
            info = json.loads(run("docker", "inspect", cid, check=True).stdout)[0]
            containers.append(info)
    runtime = runtime_directory()
    candidates = [runtime / "openshell.env", legacy / "deploy/.env", legacy / "openshell.env", legacy / ".env",
                  Path("/opt/openshell/openshell.env"), Path("/opt/openshell/deploy/.env")]
    config = {}
    config_path = None
    for path in candidates:
        values = dotenv(path)
        if values.get("SYNC_USERNAME") and values.get("SYNC_PASSWORD"):
            config, config_path = values, path
            break
    if not config and len(containers) == 1:
        config = dict(item.split("=", 1) for item in containers[0]["Config"].get("Env", []) if "=" in item)
    return containers, config, config_path


def runtime_directory():
    return Path("/opt/openshell-image") if os.geteuid() == 0 else Path.home() / ".local/share/openshell-server"


def private_write(path, text):
    # Set permissions when opening, before writing any secret bytes.
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
        output.write(text)
    path.chmod(0o600)


def request(base, path, payload=None, token=None, device=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers.update({"Authorization": "Bearer " + token, "X-Device-Id": device})
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=5) as response:
        body = response.read()
        return json.loads(body) if body else {}


def wait_ready(base):
    for _ in range(60):
        try:
            if request(base, "/readyz").get("status") == "ready":
                return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(1)
    raise RuntimeError("The new OpenShell container did not become ready.")


def verify_login(base, config):
    auth = request(base, "/v1/auth/login", {
        "email": config["SYNC_USERNAME"], "password": config["SYNC_PASSWORD"],
        "device": {"id": "ci-image-deployment", "name": "CI deployment verification", "platform": "linux",
                   "arch": os.uname().machine, "public_key": "deployment-verification-only", "app_version": "deployment-test"}})
    token, device = auth["access_token"], auth["device_id"]
    request(base, "/v1/account", token=token, device=device)
    sync = "available"
    try:
        request(base, "/v2/sync/changes?cursor=0&limit=1", token=token, device=device)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        sync = "awaiting_client_vault_initialization"
    request(base, "/v1/auth/logout", {"all_devices": False}, token=token, device=device)
    return sync


def deploy(legacy, image, containers, config, config_path):
    if len(containers) > 1:
        raise SystemExit("Multiple OpenShell containers found; refuse to replace an ambiguous instance.")
    if run("systemctl", "is-active", "--quiet", "openshell-server.service").returncode == 0:
        raise SystemExit("A systemd instance is active; migrate that instance before Docker deployment.")
    if not shutil.which("docker") or run("docker", "info").returncode:
        raise SystemExit("Docker must be installed and accessible to the SSH deployment user.")
    if not re.fullmatch(r"(?:docker.io/)?yilecbin/openshell-server(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})", image):
        raise SystemExit("Use the published OpenShell server image.")
    print("Pulling the published server image; existing runtime remains active.", flush=True)
    run("docker", "pull", image, check=True)
    image_info = json.loads(run("docker", "image", "inspect", image, check=True).stdout)[0]
    if image_info["Config"].get("User", "") in ("", "root", "0", "0:0"):
        raise SystemExit("The production image must run as non-root.")
    baked = dict(item.split("=", 1) for item in image_info["Config"].get("Env", []) if "=" in item)
    if baked.get("SYNC_USERNAME") or baked.get("SYNC_PASSWORD"):
        raise SystemExit("Refuse an image containing a baked-in account.")
    image_id = image_info["Id"]
    runtime = runtime_directory().resolve()
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    runtime.chmod(0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = runtime / "backups" / stamp
    backup.mkdir(mode=0o700, parents=True)
    backup.parent.chmod(0o700)
    if config_path:
        private_write(backup / "previous.env", config_path.read_text())
    env_path = runtime / "openshell.env"
    previous_runtime_env = env_path.read_text() if env_path.is_file() else None
    old = containers[0] if containers else None
    port = int(config.get("SERVER_PORT", "8085"))
    if old:
        bindings = old.get("HostConfig", {}).get("PortBindings", {}).get("8080/tcp") or []
        if bindings:
            port = int(bindings[0]["HostPort"])
    if not 1 <= port <= 65535:
        raise SystemExit("Invalid API port.")
    volume = "openshell-server-data"
    data_mount = None
    if old:
        private_write(backup / "previous-container.json", json.dumps(old, indent=2))
        data_mount = next((m for m in old.get("Mounts", []) if m["Destination"] == "/data"), None)
        if data_mount and data_mount["Type"] == "volume":
            volume = data_mount["Name"]
    old_name = old["Name"].lstrip("/") if old else None
    was_running = old and old["State"]["Running"]
    previous_name = "openshell-server-previous-" + stamp.lower()
    started_new = False
    stopped_old = False
    renamed_old = False
    data = backup / "data"
    reuse_volume = data_mount is not None and data_mount["Type"] == "volume"
    try:
        if was_running:
            run("docker", "stop", "--time", "20", old["Id"], check=True)
            stopped_old = True
        if old:
            if not data_mount:
                raise RuntimeError("The old container has no /data mount; refuse to lose an unknown data location.")
            (backup / "data").mkdir(mode=0o700)
            run("docker", "cp", old["Id"] + ":/data/.", str(backup / "data"), check=True)
        else:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", port))
        # Copied after stopping the old writer: SQLite plus WAL form a consistent snapshot.
        generated = not config.get("SYNC_USERNAME") or not config.get("SYNC_PASSWORD")
        if generated:
            username = "openshell"
            database = data / "openshell-server.db"
            if database.is_file():
                with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as conn:
                    accounts = conn.execute("SELECT email FROM account LIMIT 2").fetchall()
                    if len(accounts) == 1:
                        username = accounts[0][0]
            config["SYNC_USERNAME"] = username
            config["SYNC_PASSWORD"] = secrets.token_urlsafe(32)
        if config["SYNC_PASSWORD"] == "replace_with_your_strong_password":
            raise RuntimeError("Replace the example account password before deployment.")
        allowed = {key: config[key] for key in ("SYNC_USERNAME", "SYNC_PASSWORD", "JWT_SECRET") if config.get(key)}
        allowed.update({"ALLOW_MULTI_USER": "false", "RELAY_ENABLED": "false"})
        if any("\n" in value or "\r" in value for value in allowed.values()):
            raise RuntimeError("Docker environment values must not contain newlines.")
        private_write(env_path, "".join(key + "=" + value + "\n" for key, value in allowed.items()))
        if not reuse_volume and run("docker", "volume", "inspect", volume).returncode == 0:
            raise RuntimeError("The destination volume already exists and belongs to an unknown installation.")
        run("docker", "volume", "create", volume, check=True)
        prepare = ["docker", "run", "--rm", "--user", "0", "--entrypoint", "sh", "--mount", "type=volume,src=" + volume + ",dst=/data"]
        if not reuse_volume and data.is_dir():
            prepare += ["--mount", "type=bind,src=" + str(data) + ",dst=/backup,readonly"]
            command = "cp -a /backup/. /data/; chown -R openshell:openshell /data"
        else:
            command = "chown -R openshell:openshell /data"
        run(*prepare, image_id, "-ec", command, check=True)
        if old:
            run("docker", "rename", old["Id"], previous_name, check=True)
            renamed_old = True
        run("docker", "run", "-d", "--name", "openshell-server", "--restart", "unless-stopped",
            "--label", "io.openshell.managed=ci-image-deploy", "--env-file", str(env_path),
            "-p", "127.0.0.1:" + str(port) + ":8080", "--mount", "type=volume,src=" + volume + ",dst=/data", image_id, check=True)
        started_new = True
        base = "http://127.0.0.1:" + str(port)
        wait_ready(base)
        sync = verify_login(base, config)
        # Exercise a real restart using the same volume, then authenticate again.
        run("docker", "restart", "openshell-server", check=True)
        wait_ready(base)
        verify_login(base, config)
    except BaseException:
        if started_new:
            run("docker", "rm", "-f", "openshell-server")
        if renamed_old:
            run("docker", "rename", old["Id"], old_name)
        if started_new and reuse_volume and data.is_dir():
            restored = run("docker", "run", "--rm", "--user", "0", "--entrypoint", "sh",
                           "--mount", "type=volume,src=" + volume + ",dst=/data",
                           "--mount", "type=bind,src=" + str(data) + ",dst=/backup,readonly", image_id,
                           "-ec", "find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a /backup/. /data/; chown -R openshell:openshell /data")
            if restored.returncode:
                print("Data recovery failed; retain the backup and restore it before resuming writes.", flush=True)
                raise
        if stopped_old:
            run("docker", "start", old["Id"])
        if previous_runtime_env is not None:
            private_write(env_path, previous_runtime_env)
        print("Deployment failed; restored the previous runtime. Backup retained on the server.", flush=True)
        raise
    if old:
        run("docker", "rm", old["Id"], check=True)
    private_write(runtime / "deployment.json", json.dumps({"image": image, "image_id": image_id,
                  "volume": volume, "port": port, "deployed_at": stamp, "backup": str(backup)}, indent=2))
    archived_source = False
    manifest = legacy / "backend/server/Cargo.toml"
    # Move only a positively identified old OpenShell checkout, outside the new runtime.
    if (legacy.is_dir() and legacy not in (Path("/"), Path.home(), runtime)
            and runtime not in legacy.parents and legacy not in runtime.parents
            and manifest.is_file() and 'name = "openshell-server"' in manifest.read_text()
            and (legacy / "deploy/docker-compose.yml").is_file()):
        try:
            legacy.rename(backup / "legacy-source")
            archived_source = True
        except OSError:
            pass
    print(json.dumps({"mode": "deployed", "image": image, "image_id": image_id,
                      "ready": True, "login": "passed", "restart_and_login": "passed", "sync_api": sync,
                      "credentials_generated": generated, "credentials_file": str(env_path),
                      "old_container_removed": bool(old), "old_source_archived": archived_source,
                      "api_bind": "127.0.0.1", "api_port": port, "backup_created": True}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-dir-base64", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--deploy", action="store_true")
    args = parser.parse_args()
    raw = base64.b64decode(args.legacy_dir_base64).decode().strip()
    legacy = Path(raw).expanduser()
    if not legacy.is_absolute():
        raise SystemExit("Legacy deployment directory must be absolute (or start with ~/).")
    legacy = legacy.resolve()
    containers, config, config_path = inspect(legacy)
    active = run("systemctl", "is-active", "--quiet", "openshell-server.service").returncode == 0
    print(json.dumps({"mode": "inspect", "docker_installed": bool(shutil.which("docker")),
                      "docker_available": bool(shutil.which("docker")) and run("docker", "info").returncode == 0,
                      "legacy_directory_exists": legacy.is_dir(), "legacy_container_count": len(containers),
                      "systemd_active": active, "sync_credentials_available": bool(config.get("SYNC_USERNAME") and config.get("SYNC_PASSWORD")),
                      "config_file_found": config_path is not None,
                      "legacy_location": "root-home" if legacy.is_relative_to(Path("/root")) else "other",
                      "image": args.image}), flush=True)
    if args.deploy:
        try:
            deploy(legacy, args.image, containers, config, config_path)
        except RuntimeError as error:
            raise SystemExit(str(error)) from None
        except Exception as error:
            # urllib exception URLs, Docker stderr, and config values can contain private data.
            raise SystemExit("Server image deployment failed (" + type(error).__name__ + "). Previous runtime recovery was attempted.") from None


if __name__ == "__main__":
    main()
