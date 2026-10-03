#!/usr/bin/env python3
"""PostToolUse: перезбирає обидві версії після правки джерел шаблону.

Проби читають лише зібрані файли. Без цього кроку забута збірка дає
зелену пробу на старій версії — найдорожча помилка з можливих.
"""
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCES = {
    REPO / "app" / "app.template.html",
    REPO / "app" / "glassgl.js",
    REPO / "app" / "designer.js",
    REPO / "app" / "build_security.py",
    REPO / "app" / "build_app.py",
    REPO / "desktop" / "build_desktop.py",
}
BUILDERS = [REPO / "app" / "build_app.py", REPO / "desktop" / "build_desktop.py"]


def main():
    # Під Windows консоль за замовчуванням cp1252: кирилиця в JSON впала б.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    data = json.load(sys.stdin)
    path = (data.get("tool_input") or {}).get("file_path") or ""
    if not path:
        return
    p = Path(path)
    if not p.is_absolute():
        p = Path.cwd() / p
    if p.resolve() not in SOURCES:
        return
    for builder in BUILDERS:
        r = subprocess.run([sys.executable, str(builder)], cwd=REPO,
                           capture_output=True, text=True, encoding="utf-8")
        if r.returncode != 0:
            # Код 2 повертає помилку моделі: зламана збірка має зупинити роботу,
            # а не лишити на диску попередній HTML.
            sys.stderr.write(f"Збірка {builder.relative_to(REPO)} впала:\n{r.stdout}{r.stderr}")
            sys.exit(2)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": "Обидві збірки оновлено (build_app.py, build_desktop.py).",
    }}, ensure_ascii=False))


if __name__ == "__main__":
    main()
