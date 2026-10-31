#!/usr/bin/env python3
"""Inspect a legacy OpenShell installation without logging credentials.

Only this helper is sent over SSH; account configuration stays on the server.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess


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
    candidates = [legacy / "deploy/.env", legacy / "openshell.env", legacy / ".env",
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
        raise SystemExit("Inspection completed; installation helper is not yet enabled.")


if __name__ == "__main__":
    main()
