#!/usr/bin/env python3
"""Перевірка публічного дерева Git без читання невідстежуваних даних."""

import argparse
import fnmatch
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


SEEDS = {
    "app/dataset.json": [],
    "app/meta.json": {"built": "", "source": "", "n": 0},
    "desktop/dist/legacy.json": [],
}
PRIVATE_NAMES = (
    "*.private.*", "*_raw.json", "*.csv", "*.tsv", "*.xml", "*.tmp", "*.bak",
    "*.backup", "*.key", "*.pem", "*.p12", "*.pfx", "*.keystore", "*.jks",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials*", "secrets*",
    "state.json", "networth.json", "inv_cache.json", "quotes.json", "nbu_rates.json",
    "cry_hist.json", "logos.json", "dataset.json", "meta.json", "legacy.json",
)
PRIVATE_DIRS = {"private", "data", "user-data", "userdata", "snapshots", "snapshot",
                "backups", "backup", "exports", "statements", "tmp", "temp"}
RULES = {
    "private-key": re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----"),
    "token": re.compile(
        r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|"
        r"xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|"
        r"sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|"
        r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b"),
    "credential": re.compile(
        r"(?i)[\"']?(?:mono_token|binance_api_key|binance_api_secret|ibkr_token|"
        r"api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|password)"
        r"[\"']?\s*[:=]\s*[\"']?([A-Za-z0-9_+/=-]{20,})"),
    "broker-account": re.compile(r"\b(?:U|DU|F)\d{6,12}\b"),
    "email": re.compile(r"\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b"),
    "personal-path": re.compile(r"(?i)(?:[A-Z]:[\\/]+Users[\\/]+|/(?:Users|home)/)([^\\/\s\"'`<>]+)"),
}
IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b")
CARD = re.compile(r"(?<![\w])(?:\d[ -]?){12,18}\d(?![\w])")
SAFE_USERS = {"user", "username", "yourname", "your_name", "your-user", "public",
              "default", "runner", "test", "example", "…", "...", "вашеімʼя"}
SAFE_DOMAINS = {"example.com", "example.org", "example.net", "localhost"}


def sensitive_filename(name):
    path = PurePosixPath(name.lower())
    if name in SEEDS:
        return False
    if any(part in PRIVATE_DIRS or part.startswith(("backup-", "snapshot-"))
           for part in path.parts[:-1]):
        return True
    if path.name == ".env.example":
        return False
    return (path.name == ".env" or path.name.startswith(".env.")
            or any(fnmatch.fnmatchcase(path.name, pattern) for pattern in PRIVATE_NAMES))


def placeholder(value):
    # Винятки позначають приклад явно; довільне слово «test» усередині секрету не допоможе.
    upper = value.upper()
    return (upper.startswith(("YOUR_", "EXAMPLE_", "PLACEHOLDER_", "REPLACE_ME"))
            or set(value) <= {"0"})


def valid_iban(value):
    compact = re.sub(r"[ -]", "", value)
    if not 15 <= len(compact) <= 34:
        return False
    expanded = "".join(str(ord(c) - 55) if c.isalpha() else c
                       for c in compact[4:] + compact[:4])
    return int(expanded) % 97 == 1


def valid_card(value):
    digits = [int(c) for c in value if c.isdigit()]
    if not 13 <= len(digits) <= 19 or len(set(digits)) < 3:
        return False
    return sum((2 * n - 9 if n > 4 else 2 * n) if i % 2 else n
               for i, n in enumerate(reversed(digits))) % 10 == 0


def unique_object(pairs):
    # JSON із двома source може приховати приватне перше значення за порожнім останнім.
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate-json-key")
        result[key] = value
    return result


def content_findings(name, data):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = data.decode("utf-16", errors="replace")
    else:
        text = data.decode("utf-8-sig", errors="replace")
    if name in SEEDS:
        try:
            actual = json.loads(text, object_pairs_hook=unique_object)
            expected = SEEDS[name]
            # Python вважає False рівним 0; seed має зберігати також типи значень.
            if actual != expected or (name.endswith("meta.json")
                                      and type(actual.get("n")) is not int):
                yield 1, "public-seed"
        except (ValueError, AttributeError):
            yield 1, "public-seed"
    for number, line in enumerate(text.splitlines(), 1):
        for rule, pattern in RULES.items():
            for match in pattern.finditer(line):
                value = match.group(0)
                if rule == "credential" and placeholder(match.group(1)):
                    continue
                if rule == "broker-account" and set(re.sub(r"\D", "", value)) == {"0"}:
                    continue
                if rule == "email":
                    domain = match.group(1).lower()
                    if domain in SAFE_DOMAINS or domain == "users.noreply.github.com":
                        continue
                if rule == "personal-path" and match.group(1).lower() in SAFE_USERS:
                    continue
                yield number, rule
                break
        if any(valid_iban(m.group(0)) for m in IBAN.finditer(line)):
            yield number, "iban"
        if any(valid_card(m.group(0)) for m in CARD.finditer(line)):
            yield number, "payment-card"


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=True).stdout


def check(staged):
    root = Path(git("rev-parse", "--show-toplevel").decode("utf-8").strip())
    entries = git("ls-files", "--stage", "-z", cwd=root).split(b"\0")
    findings = set()
    count = 0
    for entry in entries:
        if not entry:
            continue
        header, raw_path = entry.split(b"\t", 1)
        mode, oid, stage = header.split()
        name = raw_path.decode("utf-8", errors="surrogateescape")
        count += 1
        if stage != b"0":
            findings.add((name, 1, "unmerged-index"))
            continue
        if sensitive_filename(name):
            findings.add((name, 1, "sensitive-filename"))
        # Симлінк може вивести читання за межі репозиторію; підмодуль не є перевіреним файлом.
        if mode not in (b"100644", b"100755"):
            findings.add((name, 1, "unsupported-file-mode"))
            continue
        try:
            if staged:
                data = git("cat-file", "blob", oid.decode("ascii"), cwd=root)
            else:
                path = root / name
                if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                    findings.add((name, 1, "unsafe-path"))
                    continue
                data = path.read_bytes()
            findings.update((name, line, rule) for line, rule in content_findings(name, data))
        except (OSError, subprocess.CalledProcessError):
            findings.add((name, 1, "unreadable-file"))
    for name, line, rule in sorted(findings):
        # Шлях — єдиний контекст; фрагменти рядків і значення ніколи не потрапляють у CI.
        safe_name = json.dumps(name, ensure_ascii=True)[1:-1] if not name.isprintable() else name
        print(f"{safe_name}:{line}:{rule}")
    if findings:
        print(f"Privacy check: FAIL ({len(findings)}).")
        return 1
    print(f"Privacy check: OK ({count} files).")
    return 0


def main():
    # Перенаправлений stdout у Windows інакше використовує cp1252 та губить українські шляхи.
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true",
                        help="перевірити весь індекс Git, тобто вміст майбутнього коміту")
    args = parser.parse_args()
    try:
        return check(args.staged)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print("Privacy check: cannot read Git index.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
