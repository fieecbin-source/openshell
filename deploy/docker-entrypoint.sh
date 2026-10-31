#!/bin/sh
set -eu

if [ -z "${SYNC_USERNAME:-}" ] || [ -z "${SYNC_PASSWORD:-}" ]; then
  echo 'Set your own SYNC_USERNAME and SYNC_PASSWORD to start the personal server.' >&2
  exit 1
fi
if [ "${SYNC_PASSWORD}" = 'replace_with_your_strong_password' ]; then
  echo 'Replace the example password before starting the server.' >&2
  exit 1
fi

exec /usr/local/bin/openshell-server "$@"
