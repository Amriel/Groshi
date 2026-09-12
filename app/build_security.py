"""Спільні межі HTML: JSON лишається даними, скрипти — лише кодом збірки."""
import base64
import hashlib
import html
import json


def script_json(value):
    # JSON-екранування саме по собі не закриває HTML-послідовність </script>.
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'))
            .replace('<', r'\u003c').replace('>', r'\u003e').replace('&', r'\u0026')
            .replace('\u2028', r'\u2028').replace('\u2029', r'\u2029'))


def protect_html(document, desktop=False):
    if desktop:
        scripts = "'self'"
        connect = "ipc: http://ipc.localhost https://ipc.localhost"
    else:
        start = document.index('<script>') + len('<script>')
        end = document.rindex('</script>')
        digest = base64.b64encode(hashlib.sha256(document[start:end].encode()).digest()).decode()
        scripts = f"'sha256-{digest}'"
        connect = "'none'"
    # Tauri додає nonce до style-src: тоді unsafe-inline у ньому вже не
    # дозволяє style="...". Окрема директива зберігає наявне оформлення.
    policy = (f"default-src 'none'; script-src {scripts}; connect-src {connect}; "
              "style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; "
              "img-src 'self' data: blob:; "
              "font-src 'self' data:; frame-src 'self'; manifest-src blob:; "
              "object-src 'none'; base-uri 'none'; form-action 'none'")
    meta = '<meta http-equiv="Content-Security-Policy" content="' + html.escape(policy, quote=True) + '">'
    # Перед ресурсами й скриптами, інакше частина запитів уникнула б політики.
    return document.replace('<head>', '<head>\n' + meta, 1)
