# Збірка браузерної версії: шаблон + скрипти скла + дані одним HTML-файлом.
#
# Шляхи рахуються від САМОГО СКРИПТА, а не від того, звідки його
# запустили: збірка має однаково працювати і з кореня репозиторію
# (`python3 app/build_app.py`), і зсередини теки, і з CI.
import json, pathlib
from build_security import script_json, protect_html
H = pathlib.Path(__file__).resolve().parent
tpl   = (H/'app.template.html').read_text('utf-8')
glass = (H/'glassgl.js').read_text('utf-8')
designer = (H/'designer.js').read_text('utf-8')
data_path = H/'dataset.private.json'
data  = json.loads((data_path if data_path.exists() else H/'dataset.json').read_text('utf-8'))
mcc   = json.loads((H/'mcc_names.json').read_text('utf-8'))
meta_path = H/'meta.private.json'
meta  = json.loads((meta_path if meta_path.exists() else H/'meta.json').read_text('utf-8'))
html = (tpl.replace('__GLASSGL__', glass).replace('__DESIGNER__', designer)
           .replace('__DATA__', script_json(data))
           .replace('__MCCNAME__', script_json(mcc))
           .replace('__META__', script_json(meta)))
html = protect_html(html)
(H/'Groshi_app.html').write_text(html, encoding='utf-8')
print('built', len(html))
