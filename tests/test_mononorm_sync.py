"""Сторож: mcp/mononorm.js мусить дорівнювати desktop/dist/mononorm.js.

Чому: MCP-сервер читає виписку Monobank тими ж правилами нормалізації, що й
апка, але тримає власну копію файлу (сервер поставляється окремо, без теки
desktop). Мовчазний дрейф між копіями дав би різні категорії для тих самих
операцій в апці та в MCP — і ніхто б цього не помітив. Джерело правди —
desktop/dist/mononorm.js (його ж радить брати mcp/README.md); копія в mcp/ — похідна.

Закінчення рядків: перед порівнянням CRLF/LF нормалізуються до LF. Розбіжність
лише в EOL (наприклад, checkout на Windows з autocrlf) не змінює поведінку
коду, а падати через неї означало б хибні спрацювання; у репозиторії js-файли
й так зафіксовані як eol=lf (.gitattributes). Усе інше — побайтово.
"""
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "desktop" / "dist" / "mononorm.js"
COPY = ROOT / "mcp" / "mononorm.js"


def _read_lf(path):
    return Path(path).read_bytes().replace(b"\r\n", b"\n")


def compare(source, copy):
    """None, якщо копія збігається з джерелом; інакше текст помилки."""
    if _read_lf(source) == _read_lf(copy):
        return None
    return (
        f"Копія розійшлася з джерелом:\n  джерело: {source}\n  копія:   {copy}\n"
        f"Що робити: скопіюйте джерело поверх копії (джерело — desktop/dist/mononorm.js), "
        f"напр. `cp {source} {copy}`, і закомітьте обидва файли разом."
    )


class MononormSyncTest(unittest.TestCase):
    def test_mcp_copy_matches_desktop_source(self):
        err = compare(SOURCE, COPY)
        self.assertIsNone(err, err)

    def test_detects_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp, "a.js"), Path(tmp, "b.js")
            a.write_bytes(b"var x = 1;\n")
            b.write_bytes(b"var x = 2;\n")
            err = compare(a, b)
            self.assertIsNotNone(err)
            self.assertIn(str(a), err)
            self.assertIn(str(b), err)

    def test_ignores_line_endings_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp, "a.js"), Path(tmp, "b.js")
            a.write_bytes(b"a\nb\n")
            b.write_bytes(b"a\r\nb\r\n")
            self.assertIsNone(compare(a, b))


if __name__ == "__main__":
    unittest.main()
