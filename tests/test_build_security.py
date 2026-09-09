"""Штучні дані не повинні змінювати структуру зібраного HTML."""
import importlib.util
import json
import pathlib
import unittest
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_security', ROOT/'app/build_security.py')
security = importlib.util.module_from_spec(spec)
spec.loader.exec_module(security)


class BuildSecurity(unittest.TestCase):
    def test_embedded_json_roundtrip_without_html_breakout(self):
        data = [{'merchant': '</script><img src=x onerror=window.marker=1>', 'note':'Українська & < > \u2028\u2029'}]
        encoded = security.script_json(data)
        self.assertNotIn('<', encoded)
        self.assertEqual(json.loads(encoded), data)

    def test_private_snapshot_changes_script_hash(self):
        first = security.protect_html('<html><head></head><body><script>const data=[];</script></body></html>')
        second = security.protect_html('<html><head></head><body><script>const data=[1];</script></body></html>')
        self.assertNotEqual(first.split('sha256-')[1].split(';')[0], second.split('sha256-')[1].split(';')[0])
        self.assertIn('Content-Security-Policy', first)
        self.assertNotIn("'unsafe-eval'", first)

    def test_csp_precedes_resources(self):
        result = security.protect_html('<html><head><link href="x"></head><body></body></html>', desktop=True)
        self.assertLess(result.index('Content-Security-Policy'), result.index('<link'))


if __name__ == '__main__':
    unittest.main()
