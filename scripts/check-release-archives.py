#!/usr/bin/env python3
"""Inspect client ZIP contents rather than trusting compressed archive strings."""
import os
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import urlsplit
import zipfile

markers = set()
for value in os.environ.get("OPENSHELL_PRIVATE_MARKERS", "").splitlines():
    if value.strip():
        markers.add(value.strip())
        if urlsplit(value.strip()).hostname:
            markers.add(urlsplit(value.strip()).hostname)
patterns = [marker.encode(encoding).lower() for marker in markers for encoding in ("utf-8", "utf-16-le")]
private_path = re.compile(r"(^|/)(?:\.env(?:\.[^/]*)?|[^/]+\.env|vault\.json|factory-state\.json|(?:profiles|backups|logs|userdata|indexeddb)(?:/|$))|\.(?:db(?:-wal|-shm)?|sqlite3?|osvault|pem|key|log)$", re.I)
problems = []
scanned = 0

def inspect(name, data):
    global scanned
    scanned += 1
    if private_path.search(name) or data.startswith(b"SQLite format 3\x00"):
        problems.append(name + ": private application data")
    if patterns and any(marker in data.lower() for marker in patterns):
        problems.append(name + ": deployment-private information (value hidden)")

for arg in sys.argv[1:]:
    target = Path(arg)
    if not target.exists():
        raise SystemExit("Missing client release audit input.")
    files = [target] if target.is_file() else [p for p in target.rglob("*") if p.is_file()]
    for path in files:
        inspect(path.name, path.read_bytes())
        if path.suffix.lower() == ".zip":
            with zipfile.ZipFile(path) as archive:
                for item in archive.infolist():
                    if item.is_dir():
                        continue
                    name = PurePosixPath(item.filename)
                    if name.is_absolute() or ".." in name.parts or item.file_size > 256 * 1024 * 1024:
                        raise SystemExit("Unsafe or oversized client archive entry.")
                    inspect(path.name + "/" + item.filename, archive.read(item))

if problems:
    raise SystemExit("\n".join(problems))
print(f"Client archive privacy audit passed: {scanned} files inspected.")
