#!/usr/bin/env python3
"""Run the actual shipped executable against a new, isolated user profile."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("executable", type=Path)
args = parser.parse_args()
executable = args.executable.resolve(strict=True)
with tempfile.TemporaryDirectory(prefix="openshell-factory-check-") as directory:
    profile = Path(directory) / "profile"
    result = subprocess.run([str(executable), "--profile-dir", str(profile), "--verify-clean-profile"],
                            capture_output=True, timeout=60)
    if result.returncode:
        raise SystemExit("Shipped executable failed the isolated factory profile check.")
    report = json.loads((profile / "factory-state.json").read_text(encoding="utf-8"))
    assert report["clean"] and not report["vault_initialized"], "Factory application has a preconfigured vault."
    assert all(value == 0 for value in report["private_rows"].values()), "Factory application has private records."
    print(json.dumps(report))
