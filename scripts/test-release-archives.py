"""Regression checks for unpacked client privacy auditing."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name("check-release-archives.py")


class ArchivePrivacyTests(unittest.TestCase):
    def check_files(self, files, zipped=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            if zipped:
                target = root / "client.zip"
                with zipfile.ZipFile(target, "w") as archive:
                    for name, content in files.items():
                        archive.writestr(name, content)
            else:
                target = root / "unpacked"
                for name, content in files.items():
                    path = target / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
            return subprocess.run([sys.executable, str(SCRIPT), str(target)], capture_output=True).returncode

    def test_clean_program_is_accepted(self):
        self.assertEqual(self.check_files({"OpenShell.exe": b"clean program"}), 0)

    def test_cache_directories_are_rejected_in_unpacked_and_zip_inputs(self):
        for zipped in (False, True):
            for name in ("cache/item", "webview/Local Storage/item", "profiles/release/item"):
                with self.subTest(zipped=zipped, name=name):
                    self.assertNotEqual(self.check_files({name: b"private"}, zipped), 0)

    def test_database_without_a_database_extension_is_rejected(self):
        self.assertNotEqual(self.check_files({"settings.dat": b"SQLite format 3\x00private"}), 0)


if __name__ == "__main__":
    unittest.main()
