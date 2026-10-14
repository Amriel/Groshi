# Збірка браузерної версії: шаблон + скрипти скла + дані одним HTML-файлом.
#
# Шляхи рахуються від САМОГО СКРИПТА, а не від того, звідки його
# запустили: збірка має однаково працювати і з кореня репозиторію
# (`python3 app/build_app.py`), і зсередини теки, і з CI.
#
# --data / --out потрібні пробам: знімки з наповненим екраном збирають
# окремий HTML зі штучним набором, а приватний dataset.private.json не
# чіпають і публічний Groshi_app.html не перезаписують.
import argparse, json, pathlib
from build_security import script_json, protect_html
H = pathlib.Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument('--data', help='JSON із операціями замість dataset.json / dataset.private.json')
ap.add_argument('--out', help='куди писати HTML замість app/Groshi_app.html')
args = ap.parse_args()
tpl   = (H/'app.template.html').read_text('utf-8')
glass = (H/'glassgl.js').read_text('utf-8')
designer = (H/'designer.js').read_text('utf-8')
data_path = pathlib.Path(args.data) if args.data else (H/'dataset.private.json')
if not data_path.exists():
    data_path = H/'dataset.json'
data  = json.loads(data_path.read_text('utf-8'))
mcc   = json.loads((H/'mcc_names.json').read_text('utf-8'))
meta_path = H/'meta.private.json'
meta  = json.loads((meta_path if meta_path.exists() else H/'meta.json').read_text('utf-8'))
html = (tpl.replace('__GLASSGL__', glass).replace('__DESIGNER__', designer)
           .replace('__DATA__', script_json(data))
           .replace('__MCCNAME__', script_json(mcc))
           .replace('__META__', script_json(meta)))
html = protect_html(html)
out = pathlib.Path(args.out) if args.out else (H/'Groshi_app.html')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding='utf-8')
print('built', len(html), out)
