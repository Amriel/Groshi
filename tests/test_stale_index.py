"""Перевірка відсталого індексу (scripts/stale_index_check.py) на штучному репозиторії."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "stale_index_check.py"


def run(cwd, *args, env=None):
    return subprocess.run(list(args), cwd=cwd, capture_output=True, env=env)


class StaleIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = self.tmp.name
        run(self.repo, "git", "init", "-q")
        run(self.repo, "git", "config", "user.email", "tester")
        run(self.repo, "git", "config", "user.name", "t")
        run(self.repo, "git", "config", "core.hooksPath", "/dev/null")
        for text in ("one\n", "two\n", "three\n"):
            Path(self.repo, "a.txt").write_text(text, encoding="utf-8")
            run(self.repo, "git", "add", "a.txt")
            run(self.repo, "git", "commit", "-q", "-m", text.strip())

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, **extra):
        env = dict(os.environ)
        env.pop("GROSHI_ALLOW_REVERT", None)
        env.update(extra)
        return run(self.repo, sys.executable, str(SCRIPT), env=env).returncode

    def test_ordinary_change_passes(self):
        Path(self.repo, "a.txt").write_text("four\n", encoding="utf-8")
        run(self.repo, "git", "add", "a.txt")
        self.assertEqual(self.check(), 0)

    def test_index_left_behind_head_is_blocked(self):
        # саме так виглядає індекс після коміту з іншого середовища
        run(self.repo, "git", "read-tree", "HEAD~1")
        self.assertEqual(self.check(), 1)

    def test_deliberate_revert_can_be_allowed(self):
        run(self.repo, "git", "read-tree", "HEAD~1")
        self.assertEqual(self.check(GROSHI_ALLOW_REVERT="1"), 0)

    def test_git_reset_clears_the_block(self):
        run(self.repo, "git", "read-tree", "HEAD~1")
        run(self.repo, "git", "reset", "-q")
        self.assertEqual(self.check(), 0)


if __name__ == "__main__":
    unittest.main()
