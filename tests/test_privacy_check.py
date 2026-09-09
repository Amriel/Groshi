"""Синтетичні проби: жодні значення не походять із виписок користувача."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CHECKER = Path(__file__).resolve().parents[1] / "scripts" / "privacy_check.py"


class PrivacyCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        self.git("init", "-q")
        self.git("config", "user.name", "Privacy test")
        self.git("config", "user.email", "test@example.com")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env,
                              check=True, capture_output=True).stdout

    def write(self, name, content, stage=True):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if stage:
            self.git("add", "--", name)

    def scan(self, staged=False):
        result = subprocess.run([sys.executable, str(CHECKER), *(["--staged"] if staged else [])],
                                cwd=self.repo, env=self.env, capture_output=True, text=True,
                                encoding="utf-8")
        self.assertNotEqual(result.returncode, 2, result.stderr)
        return result

    def test_sensitive_filenames_are_rejected_even_with_empty_contents(self):
        for name in (".env", ".env.local", "secret.key", "id_ed25519", "report.XML",
                     "report.csv", "dataset.json.tmp", "private/draft.txt", "backup-2026/x.json",
                     "app/dataset.private.json", "state.json", "nested/credentials.json"):
            with self.subTest(name=name):
                self.write(name, "")
                result = self.scan(True)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn("sensitive-filename", result.stdout)
                self.git("rm", "--cached", "--", name)

    def test_empty_public_seeds_and_public_assets_pass(self):
        safe = {
            "app/dataset.json": "[]", "app/meta.json": '{"built":"","source":"","n":0}',
            "desktop/dist/legacy.json": "[]", ".env.example": "MONO_TOKEN=YOUR_TOKEN_HERE",
            "release.sig": "aG9uZXN0LXB1YmxpYy1zaWduYXR1cmU=",
            "release.pub": "-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----",
            "Cargo.lock": 'checksum = "' + "b91d82ea" * 8 + '"',
            "fixture.json": '{"account":"U0000000", "email":"demo@example.com"}',
            "authors.txt": "12345+fixture@users.noreply.github.com\nC:/Users/USER/project\n/home/runner/work/project"
                           "\n`/home/…`, `/Users/…`\nC:\\Users\\ВашеІмʼя\\AppData\\Roaming\\ua.groshi.desktop",
        }
        for name, content in safe.items():
            self.write(name, content)
        self.assertEqual(self.scan(True).returncode, 0)
        self.assertEqual(self.scan().returncode, 0)

    def test_nonempty_or_malformed_seeds_are_rejected(self):
        for name, content in (("app/dataset.json", '[{"amount":1}]'),
                              ("desktop/dist/legacy.json", "{}"),
                              ("app/meta.json", '{"built":"","source":"","n":0,"extra":"x"}'),
                              ("app/meta.json", '{"built":"","source":"","n":false}'),
                              ("app/meta.json", '{"built":"","source":"hidden","source":"","n":0}'),
                              ("app/dataset.json", "invalid")):
            with self.subTest(name=name, content=content):
                self.write(name, content)
                result = self.scan(True)
                self.assertEqual(result.returncode, 1)
                self.assertIn("public-seed", result.stdout)
                self.git("rm", "--cached", "--", name)

    def test_sensitive_values_are_detected_without_echoing_them(self):
        cases = [
            ("token", "ghp_" + "A7b9" * 10),
            ("private-key", "-----BEGIN " + "RSA PRIVATE KEY-----"),
            ("iban", "GB82" + " WEST 1234 5698 7654 32"),
            ("payment-card", "4532" + " 0151 1283 0366"),
            ("broker-account", "U" + "1234567"),
            ("personal-path", "C:\\Users\\" + "SyntheticPerson\\Documents\\notes.txt"),
            ("personal-path", "/home/" + "synthetic-person/documents"),
            ("email", "synthetic.person@" + "sample.invalid"),
            ("credential", 'MONO_TOKEN="' + "Ab3Cd4Ef5Gh6" * 5 + '"'),
        ]
        for rule, value in cases:
            with self.subTest(rule=rule):
                self.write("notes.txt", "Нотатки\n" + value + "\n")
                result = self.scan(True)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(":" + rule, result.stdout)
                self.assertNotIn(value, result.stdout + result.stderr)
                self.assertIn("notes.txt:2:", result.stdout)

    def test_staged_blob_is_checked_even_if_worktree_is_clean(self):
        value = "ghp_" + "B2d4" * 10
        self.write("notes.txt", value)
        self.write("notes.txt", "clean", stage=False)
        self.assertEqual(self.scan(True).returncode, 1)
        self.assertEqual(self.scan().returncode, 0)

    def test_unstaged_secret_does_not_taint_clean_index(self):
        self.write("notes.txt", "clean")
        self.write("notes.txt", "ghp_" + "B2d4" * 10, stage=False)
        self.assertEqual(self.scan(True).returncode, 0)
        self.assertEqual(self.scan().returncode, 1)

    def test_rename_checks_destination_and_deleted_files_do_not_fail(self):
        self.write("notes.txt", "clean")
        self.git("commit", "-qm", "fixture")
        self.git("mv", "notes.txt", ".env")
        self.assertEqual(self.scan(True).returncode, 1)
        self.git("rm", "-f", ".env")
        self.assertEqual(self.scan(True).returncode, 0)

    def test_untracked_private_data_is_not_opened(self):
        self.write("notes.txt", "clean")
        self.write("state.json", "ghp_" + "B2d4" * 10, stage=False)
        self.assertEqual(self.scan().returncode, 0)

    def test_unicode_paths_and_utf16_content_are_checked(self):
        name = "нотатки.txt"
        self.write(name, "clean")
        (self.repo / name).write_bytes(("ghp_" + "B2d4" * 10).encode("utf-16"))
        self.git("add", "--", name)
        result = self.scan(True)
        self.assertEqual(result.returncode, 1)
        self.assertIn(name + ":1:token", result.stdout)

    def test_missing_tracked_worktree_file_fails_closed(self):
        self.write("notes.txt", "clean")
        (self.repo / "notes.txt").unlink()
        self.assertEqual(self.scan().returncode, 1)

    def test_case_variant_cannot_bypass_seed_policy(self):
        self.write("APP/dataset.json", '[{"amount":1}]')
        result = self.scan(True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("sensitive-filename", result.stdout)

    def test_symlink_blob_is_rejected_without_reading_external_target(self):
        self.write("target.txt", "outside-path-do-not-open")
        oid = self.git("rev-parse", ":target.txt").decode().strip()
        self.git("update-index", "--add", "--cacheinfo", "120000," + oid + ",link.txt")
        for staged in (False, True):
            result = self.scan(staged)
            self.assertEqual(result.returncode, 1)
            self.assertIn("link.txt:1:unsupported-file-mode", result.stdout)

    def test_gitignore_blocks_private_files_but_allows_public_seeds(self):
        source = CHECKER.parents[1] / ".gitignore"
        self.write(".gitignore", source.read_text(encoding="utf-8"))
        for name in (".env.local", "notes.csv", "report.xml", "state.json.tmp",
                     "private/new.json", "backups/new.txt", "secret.key", ".test-artifacts/run.png"):
            with self.subTest(name=name):
                self.assertTrue(self.git("check-ignore", "--", name).strip())
        for name in ("app/dataset.json", "app/meta.json", "desktop/dist/legacy.json",
                     ".env.example", "release.sig", "release.pub", "Cargo.lock"):
            with self.subTest(name=name):
                result = subprocess.run(["git", "check-ignore", "--", name], cwd=self.repo,
                                        env=self.env, capture_output=True)
                self.assertEqual(result.returncode, 1)


if __name__ == "__main__":
    unittest.main()
