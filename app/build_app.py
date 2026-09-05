# Збірка браузерної версії: шаблон + скрипти скла + дані одним HTML-файлом.
#
# Шляхи рахуються від САМОГО СКРИПТА, а не від того, звідки його
# запустили: збірка має однаково працювати і з кореня репозиторію
# (`python3 app/build_app.py`), і зсередини теки, і з CI.
import json, datetime as dt, pathlib
H = pathlib.Path(__file__).resolve().parent
tpl   = (H/'app.template.html').read_text('utf-8')
glass = (H/'glassgl.js').read_text('utf-8')
designer = (H/'designer.js').read_text('utf-8')
data  = json.loads((H/'dataset.json').read_text('utf-8'))
mcc   = json.loads((H/'mcc_names.json').read_text('utf-8'))
meta  = json.loads((H/'meta.json').read_text('utf-8'))
html = (tpl.replace('__GLASSGL__', glass).replace('__DESIGNER__', designer)
           .replace('__DATA__', json.dumps(data, ensure_ascii=False, separators=(',',':')))
           .replace('__MCCNAME__', json.dumps(mcc, ensure_ascii=False, separators=(',',':')))
           .replace('__META__', json.dumps(meta, ensure_ascii=False)))
(H/'Groshi_app.html').write_text(html, encoding='utf-8')
print('built', len(html))
