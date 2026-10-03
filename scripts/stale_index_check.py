"""Зупиняє коміт, якщо індекс тягне файли назад до старого стану.

Симптом, який це ловить (траплявся двічі, 21.09 і 03.10.2026): інше
середовище комітило в цей репозиторій власним git, переводило гілку, але
не оновлювало індекс цього checkout'а. Індекс лишався на дереві до тих
комітів, і `git status` показував «застейджений відкат». Наступний
`git add -- файл && git commit` мовчки закомітив би весь індекс — тобто
скасував би чужі коміти разом зі своєю правкою.

Правило: застейджена версія файла збігається з його версією в одному з
останніх комітів, але не з HEAD — значить, коміт повертає файл назад.
Свідомий відкат: GROSHI_ALLOW_REVERT=1 git commit ...
Лікування випадкового: `git reset` (без шляхів) скидає індекс до HEAD,
робочі файли лишаються як є.
"""
import os
import subprocess
import sys

DEPTH = 10


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True)
    return r.returncode, r.stdout.decode("utf-8", "replace").strip()


def blob(rev, path):
    code, out = git("rev-parse", "--verify", "--quiet", f"{rev}:{path}")
    return out if code == 0 else None


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if os.environ.get("GROSHI_ALLOW_REVERT") == "1":
        return 0
    if git("rev-parse", "--verify", "--quiet", "HEAD")[0] != 0:
        return 0  # перший коміт — порівнювати нема з чим
    _, staged = git("-c", "core.quotepath=off", "diff", "--cached", "--name-only", "-z")
    paths = [p for p in staged.split("\0") if p]
    _, revs = git("rev-list", f"--max-count={DEPTH}", "HEAD~1")
    ancestors = revs.split() if revs else []
    hits = []
    for path in paths:
        now, head = blob("", path), blob("HEAD", path)  # ":" + path — індекс
        for k, rev in enumerate(ancestors, 1):
            old = blob(rev, path)
            if old != head and old == now:
                hits.append((path, k))
                break
    if not hits:
        return 0
    print("Коміт зупинено: індекс повертає файли до стану з попередніх комітів.")
    for path, k in hits:
        print(f"  {path} — як {k} коміт(и) тому")
    print("Якщо це випадковість (індекс відстав від HEAD) — виконайте `git reset`,")
    print("знову додайте свої файли й комітьте. Свідомий відкат: GROSHI_ALLOW_REVERT=1.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
