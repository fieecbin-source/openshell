#!/usr/bin/env python3
"""Exercise a container using isolated, disposable test credentials and volume."""
import io
import json
import pathlib
import secrets
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else "openshell-server:ci"
run_id = "openshell-smoke-" + uuid.uuid4().hex[:12]
volume = run_id + "-data"
device_id = None


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True)


def request(path, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
        headers["X-Device-Id"] = device_id
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base_url + path, data=data, headers=headers)
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3) as response:
        return json.load(response)


def ready():
    for _ in range(90):
        try:
            if request("/readyz").get("status") == "ready":
                return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(1)
    raise AssertionError("Container never became ready")


try:
    info = json.loads(docker("image", "inspect", image).stdout)[0]
    assert info["Config"]["User"] not in ("", "root", "0", "0:0"), "Container must run as non-root"
    baked = dict(item.split("=", 1) for item in info["Config"].get("Env", []))
    assert not baked.get("SYNC_USERNAME") and not baked.get("SYNC_PASSWORD"), "No baked-in account"
    assert baked.get("DATA_DIR") == "/data", "JWT and database must share the persistent data volume"
    rejected = docker("run", "--rm", image, check=False)
    assert rejected.returncode != 0, "Missing credentials must not start a public registration server"
    docker("create", "--name", run_id, image)
    filesystem = docker("export", run_id).stdout
    with tarfile.open(fileobj=io.BytesIO(filesystem)) as archive:
        names = {member.name.lstrip("./") for member in archive.getmembers()}
    for prefix in ("app/frontend", "app/backend", "app/node_modules", "app/target", "root/.codex", "app/.env"):
        assert not any(name == prefix or name.startswith(prefix + "/") for name in names), prefix
    docker("rm", "--volumes", run_id)
    docker("volume", "create", volume)
    with tempfile.TemporaryDirectory(prefix="openshell-container-test-") as directory:
        env_file = pathlib.Path(directory) / "test.env"
        username = "container_test_user"
        password = secrets.token_urlsafe(24)
        env_file.write_text(f"SYNC_USERNAME={username}\nSYNC_PASSWORD={password}\n", encoding="utf-8")
        env_file.chmod(0o600)
        docker("run", "--detach", "--name", run_id, "--publish", "127.0.0.1::8080", "--env-file", str(env_file),
               "--mount", f"type=volume,src={volume},dst=/data", image)
    port = docker("port", run_id, "8080/tcp").stdout.decode().strip().rsplit(":", 1)[1]
    base_url = "http://127.0.0.1:" + port
    ready()
    auth = request("/v1/auth/login", {
        "email": username, "password": password,
        "device": {"id": None, "name": "Container smoke test", "platform": "linux", "arch": info["Architecture"],
                   "public_key": "test-only-public-key", "app_version": "container-test"},
    })
    token = auth["access_token"]
    device_id = auth["device_id"]
    account = request("/v1/account", token=token)
    secret_before = docker("exec", run_id, "cat", "/data/.jwt_secret").stdout
    assert len(secret_before.strip()) >= 32
    docker("restart", run_id)
    port = docker("port", run_id, "8080/tcp").stdout.decode().strip().rsplit(":", 1)[1]
    base_url = "http://127.0.0.1:" + port
    ready()
    assert docker("exec", run_id, "cat", "/data/.jwt_secret").stdout == secret_before
    assert request("/v1/account", token=token)["account_id"] == account["account_id"]
    print(json.dumps({"image": image, "architecture": info["Architecture"], "non_root": True,
                      "login": "passed", "persistent_jwt_and_database": "passed", "no_source_or_baked_credentials": True}))
except Exception:
    logs = docker("logs", run_id, check=False)
    sys.stderr.write(logs.stdout.decode(errors="replace") + logs.stderr.decode(errors="replace"))
    raise
finally:
    docker("rm", "--force", "--volumes", run_id, check=False)
    docker("volume", "rm", volume, check=False)
