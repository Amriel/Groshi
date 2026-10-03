#!/usr/bin/env python3
"""PreToolUse-сторож: правила AGENTS.md, які інакше тримаються лише на памʼяті агента.

Блокує запис у згенеровані й приватні файли, системні елементи інтерфейсу
в новому тексті та масове `git add`. Перевіряється лише ТЕКСТ, що додається
(`new_string`/`content`), а не весь файл: у шаблоні вже є старі місця, і
сторож, що дивиться на файл цілком, забороняв би будь-яку правку.
"""
import json
import re
import sys
from pathlib import Path, PurePosixPath

# Корінь рахується від самого скрипта: робоча тека сесії може бути і `repo/`,
# і батьківська `Expenses/`, а `$CLAUDE_PROJECT_DIR` тоді вказує на різне.
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
from privacy_check import sensitive_filename  # noqa: E402  — той самий список, що й у pre-commit

GENERATED = {"app/Groshi_app.html", "desktop/dist/index.html", "desktop/dist/app.js"}

# Лише те, що в цьому проєкті завжди помилка. `<select` і `title=` не тут:
# `.csel` тримає нативний select як носій значення, а `title` дозволений на iframe.
FORBIDDEN = [
    (re.compile(r"(?<![\w.$])(?:window\.)?(prompt|confirm|alert)\s*\("),
     "системний діалог — використовуйте uiAsk()/uiConfirm()/uiPick()"),
    (re.compile(r"""type\s*=\s*["']?date\b"""), "<input type=date> — використовуйте SD/DP"),
    (re.compile(r"<input\b[^>]*\blist\s*="), "<input list> — використовуйте buildCombo()"),
]
# Власний Blob + <a download> у WebView2 мовчки нічого не зберігає —
# так відвалились «Створити рахунок», експорти й «Поділитись».
BLOB = re.compile(r"new\s+Blob\s*\(")
ANCHOR_DOWNLOAD = re.compile(r"\.download\s*=")
UI_FILES = {".html", ".js", ".mjs"}

GIT_ADD_ALL = re.compile(r"\bgit\s+add\s+(?:[^|;&]*\s)?(?:-A|--all|\.)(?=\s|$|[;&|])")


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}, ensure_ascii=False))
    sys.exit(0)


def relative(path_str):
    """Шлях відносно репозиторію (або його батьківської теки) у POSIX-вигляді."""
    p = Path(path_str)
    if not p.is_absolute():
        p = Path.cwd() / p
    p = p.resolve()
    for base in (REPO, REPO.parent):
        try:
            return base, PurePosixPath(p.relative_to(base).as_posix())
        except ValueError:
            continue
    return None, None


def check_file(data):
    ti = data.get("tool_input") or {}
    base, rel = relative(ti.get("file_path") or ti.get("notebook_path") or "")
    if rel is None:
        return
    name = str(rel)
    if base == REPO and name in GENERATED:
        deny(f"{name} генерується збіркою. Правте app/app.template.html "
             "і запустіть build_app.py та build_desktop.py.")
    if sensitive_filename(name):
        deny(f"{name} — приватні дані або секрет за правилами scripts/privacy_check.py. "
             "Запис через інструменти агента заборонено.")
    if base != REPO or rel.suffix not in UI_FILES or rel.parts[:1] == ("tests",):
        return
    added = ti.get("new_string") if "new_string" in ti else ti.get("content", "")
    for edit in ti.get("edits") or []:
        added += "\n" + (edit.get("new_string") or "")
    for rx, why in FORBIDDEN:
        m = rx.search(added or "")
        if m:
            deny(f"Заборонено правилами проєкту: «{m.group(0)}» — {why} (§5 docs/РОЗРОБКА.md).")
    if BLOB.search(added or "") and ANCHOR_DOWNLOAD.search(added or ""):
        deny("Власний Blob + <a download> мовчки не працює у WebView2. "
             "Використовуйте download(name, text, type).")


def check_bash(data):
    cmd = (data.get("tool_input") or {}).get("command", "")
    if GIT_ADD_ALL.search(cmd):
        deny("Масове git add заборонено: у репозиторії бувають чужі незакомічені зміни. "
             "Додавайте явні шляхи: git add -- <файли>.")


def main():
    # Під Windows консоль за замовчуванням cp1252: кирилиця в JSON впала б.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    data = json.load(sys.stdin)
    tool = data.get("tool_name", "")
    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        check_file(data)
    elif tool in ("Bash", "PowerShell"):
        check_bash(data)


if __name__ == "__main__":
    main()
