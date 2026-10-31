#!/usr/bin/env bash
# Install a CI server artifact. No frontend, Docker, or TLS changes.
set -euo pipefail

package_dir="$(realpath "${1:?usage: install-server.sh PACKAGE_DIR [/opt/openshell]}")"
deploy_dir="$(realpath -m "${2:-/opt/openshell}")"
[[ "$deploy_dir" =~ ^/(opt|srv)/[a-zA-Z0-9/_-]+$ ]] || { echo 'Use a directory below /opt or /srv.' >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo 'Run as root or with sudo.' >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo 'This artifact requires Linux x86_64.' >&2; exit 1; }
for command in python3 systemctl curl install; do command -v "$command" >/dev/null; done
test -f "$package_dir/openshell-server"
env_file="$deploy_dir/deploy/.env"
if [ ! -f "$env_file" ]; then
  install -d -m 0755 "$deploy_dir/deploy"
  sed "s|/opt/openshell|$deploy_dir|g" "$package_dir/systemd.env.example" > "$env_file"
  chmod 0600 "$env_file"
  echo "Created $env_file. Set SYNC_USERNAME and SYNC_PASSWORD, then rerun deployment." >&2
  exit 2
fi

# Parse data, never source/eval the configuration. Validate before changing the running service.
port="$(python3 - "$env_file" "$deploy_dir" <<'PY'
import pathlib, shlex, sys
values = {}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    key, separator, raw = line.partition('=')
    if not separator:
        raise SystemExit('Invalid environment line; expected KEY=value.')
    parts = shlex.split(raw, comments=True)
    if len(parts) > 1:
        raise SystemExit('Quote environment values containing spaces.')
    values[key.strip()] = parts[0] if parts else ''
if not values.get('SYNC_USERNAME') or values['SYNC_USERNAME'] == 'your_account':
    raise SystemExit('Configure SYNC_USERNAME on the server.')
password = values.get('SYNC_PASSWORD', '')
if len(password) < 8 or password == 'replace_with_your_strong_password':
    raise SystemExit('Configure your own SYNC_PASSWORD (at least 8 characters).')
if values.get('DATA_DIR') != str(pathlib.Path(sys.argv[2]) / 'data'):
    raise SystemExit('DATA_DIR must point to this installation data directory.')
port = int(values.get('PORT', '8085'))
if not 1 <= port <= 65535:
    raise SystemExit('Invalid PORT.')
print(port)
PY
)"

if ! systemctl is-active --quiet openshell-server.service; then
  python3 - "$port" <<'PY'
import socket, sys
with socket.socket() as listener:
    try:
        listener.bind(('127.0.0.1', int(sys.argv[1])))
    except OSError:
        raise SystemExit('The API port is occupied. Migrate the old OpenShell instance or choose another port; no service was stopped.')
PY
fi

id openshell >/dev/null 2>&1 || useradd --system --home-dir "$deploy_dir/data" --shell /usr/sbin/nologin openshell
install -d -m 0755 "$deploy_dir/bin" "$deploy_dir/deploy"
install -d -o openshell -g openshell -m 0700 "$deploy_dir/data" "$deploy_dir/data/artifacts" "$deploy_dir/data/backups"
chown -R openshell:openshell "$deploy_dir/data"
chmod 0600 "$env_file"

# SQLite's online backup API also captures committed WAL changes.
python3 - "$deploy_dir/data" <<'PY'
import datetime, pathlib, sqlite3, sys
data = pathlib.Path(sys.argv[1])
database = data / 'openshell-server.db'
if database.exists():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = data / 'backups' / ('pre-deploy-' + stamp + '.db')
    with sqlite3.connect(str(database)) as source, sqlite3.connect(str(backup)) as target:
        source.backup(target)
    backup.chmod(0o600)
PY

unit_file=/etc/systemd/system/openshell-server.service
had_binary=false
had_unit=false
if [ -f "$deploy_dir/bin/openshell-server" ]; then
  cp -p "$deploy_dir/bin/openshell-server" "$deploy_dir/bin/openshell-server.previous"
  had_binary=true
fi
if [ -f "$unit_file" ]; then cp -p "$unit_file" "$deploy_dir/deploy/openshell-server.previous.service"; had_unit=true; fi
rollback() {
  trap - ERR
  echo 'Deployment failed; restoring the previous binary. Database snapshots remain in data/backups.' >&2
  systemctl stop openshell-server.service || true
  if $had_binary; then cp -p "$deploy_dir/bin/openshell-server.previous" "$deploy_dir/bin/openshell-server"; fi
  if $had_unit; then cp -p "$deploy_dir/deploy/openshell-server.previous.service" "$unit_file"; fi
  systemctl daemon-reload
  if $had_binary; then systemctl start openshell-server.service || true; fi
  exit 1
}
trap rollback ERR
install -m 0755 "$package_dir/openshell-server" "$deploy_dir/bin/openshell-server.new"
mv -f "$deploy_dir/bin/openshell-server.new" "$deploy_dir/bin/openshell-server"
sed "s|/opt/openshell|$deploy_dir|g" "$package_dir/openshell-server.service" > "$unit_file"
systemctl daemon-reload
systemctl enable openshell-server.service
systemctl restart openshell-server.service
healthy=false
for attempt in $(seq 1 30); do
  if systemctl is-active --quiet openshell-server.service && curl --noproxy '*' -fsS "http://127.0.0.1:$port/readyz" >/dev/null; then healthy=true; break; fi
  sleep 1
done
$healthy || { echo 'Readiness check failed.' >&2; false; }
trap - ERR
echo "OpenShell server ready on 127.0.0.1:$port; .env, data and reverse proxy preserved."
