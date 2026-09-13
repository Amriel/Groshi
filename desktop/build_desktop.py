# -*- coding: utf-8 -*-
"""Складання десктопної версії.

Відмінності від браузерної:
  · дані не вшиваються у файл, а читаються з диска під час запуску;
  · store пише в state.json, а не в localStorage;
  · зʼявляється екран Monobank у налаштуваннях;
  · сам застосунок стартує ПІСЛЯ того, як дані прийшли, тож головний
    зовнішній app.js завантажується після читання даних;
  · CSP дозволяє лише власні скрипти та локальний IPC.
"""
import io, json, pathlib, re, sys

# Шляхи — від скрипта, щоб збірка працювала з будь-якої робочої теки:
#   repo/app     — браузерний шаблон і його скрипти
#   repo/desktop/dist — куди лягає зібраний index.html
# Шляхи — від скрипта, щоб збірка працювала з будь-якої робочої теки:
#   repo/app     — браузерний шаблон і його скрипти
#   repo/desktop/dist — куди лягає зібраний index.html
ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT.parent / 'app'
OUT = ROOT / 'dist'
sys.path.insert(0, str(SRC))
from build_security import script_json, protect_html

tpl = (SRC / 'app.template.html').read_text('utf-8')
glass = (SRC / 'glassgl.js').read_text('utf-8')
designer = (SRC / 'designer.js').read_text('utf-8')
mcc = json.loads((SRC / 'mcc_names.json').read_text('utf-8'))

def sub(s, a, b, what):
    assert s.count(a) == 1, f'якір «{what}» знайдено {s.count(a)} разів'
    return s.replace(a, b)

# ── 1. дані з диска ───────────────────────────────────────────────────
tpl = sub(tpl, 'const TX = __DATA__;', 'const TX = window.__BOOT__.tx;', 'TX')
tpl = sub(tpl, 'const META = __META__;', 'const META = window.__BOOT__.meta;', 'META')

# ── 2. store пише у файл ──────────────────────────────────────────────
OLD_STORE = """const mem = {};
const store = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v===null ? (k in mem?mem[k]:d) : JSON.parse(v); }
             catch(e){ return k in mem ? mem[k] : d; } },
  set(k, v){ mem[k]=v; try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} },
  del(k){ delete mem[k]; try{ localStorage.removeItem(k); }catch(e){} }
};"""
NEW_STORE = """/* Стан живе у %APPDATA%\\\\Groshi\\\\state.json, а не в localStorage:
   файл видно, його можна покласти в бекап, і він не зникає разом із
   даними сайту. Читання лишається синхронним — увесь стан завантажено
   ще до запуску апки; запис іде на диск із затримкою, бо десятки
   store.set() підряд не мають перетворюватись на десятки записів. */
const mem = Object.assign({}, window.__BOOT__.state);
const _dirty = new Map();
let _flushT = null;
function _flush(){
  _flushT = null;
  for(const [k, v] of _dirty){
    if(v === undefined) window.__DESK__.stateDel(k);
    else window.__DESK__.stateSet(k, v);
  }
  _dirty.clear();
}
const store = {
  get(k, d){ return k in mem ? mem[k] : d; },
  committed(k,v){ mem[k]=v; _dirty.delete(k); },
  set(k, v){ mem[k] = v; _dirty.set(k, v);
             if(!_flushT) _flushT = setTimeout(_flush, 400); },
  del(k){ delete mem[k]; _dirty.set(k, undefined);
          if(!_flushT) _flushT = setTimeout(_flush, 400); }
};
/* Закриття вікна не має ковтати останні 400 мс змін. */
addEventListener('beforeunload', ()=>{ if(_flushT){ clearTimeout(_flushT); _flush(); } });
addEventListener('blur', ()=>{ if(_flushT){ clearTimeout(_flushT); _flush(); } });"""
tpl = sub(tpl, OLD_STORE, NEW_STORE, 'store')

# ── 2b. межі дат перераховуються після синхронізації ──────────────────
OLD_D = """const ALL_DATES = TX.map(t=>t.date).sort();"""
NEW_D = """/* У десктопі операції додаються під час роботи, тож межі періоду не
   константи, а змінні: після синхронізації їх переобчислює bootDates. */
let ALL_DATES = TX.map(t=>t.date).sort();
function bootDates(){
  ALL_DATES = TX.map(t=>t.date).sort();
  DMIN = ALL_DATES[0] || new Date().toISOString().slice(0,10);
  DMAX = ALL_DATES[ALL_DATES.length-1] || DMIN;
  LASTYM = DMAX.slice(0,7);
}"""
tpl = sub(tpl, OLD_D, NEW_D, 'dates')
tpl = sub(tpl, '''const DMIN = ALL_DATES[0] || TODAY_ISO;
const DMAX = ALL_DATES[ALL_DATES.length-1] || TODAY_ISO;''',
               '''let DMIN = ALL_DATES[0] || TODAY_ISO;
let DMAX = ALL_DATES[ALL_DATES.length-1] || TODAY_ISO;''', 'DMIN/DMAX')
tpl = sub(tpl, 'const LASTYM = DMAX.slice(0,7);', 'let LASTYM = DMAX.slice(0,7);', 'LASTYM')

# ── 3. PWA-манифест у десктопі зайвий ─────────────────────────────────
i = tpl.index("/* PWA: manifest + offline")
j = tpl.index("render();", i)
tpl = tpl[:i] + tpl[j:]

# ── 3b. банер «немає надходжень» — інша причина в десктопі ────────────
i = tpl.index("el('incomeNotice').innerHTML = (incN || !TX.length) ? '' : `")
j = tpl.index("</div>`;", i) + len("</div>`;")
NOTICE = """/* У браузерній версії тут пояснювалось, чому Notion не віддає
     надходжень. Десктоп бере виписку напряму з банку, тож єдина причина
     порожнечі — банк ще не підключено або період без зарахувань. */
  el('incomeNotice').innerHTML = incN ? '' : (!TX.length ? `
    <div class="warnbox">
      <b>Даних ще немає.</b><br>
      Підключіть Monobank у «Ще» — токен читає лише виписку, платежі ним неможливі.
      Перше завантаження бере рік історії; банк віддає один запит на 60 секунд,
      тож це триває приблизно чверть години. Апку можна згорнути в трей.
      <button class="btn pri glass" id="goMono" style="margin-top:10px">Підключити банк</button>
    </div>` : `
    <div class="warnbox">
      <b>За цей період надходжень немає.</b><br>
      Витрати рахуються, дохід — ні. Спробуйте ширший період або перевірте,
      чи обрано в налаштуваннях усі потрібні рахунки.
    </div>`);
  const gm = el('goMono'); if(gm) gm.onclick = ()=>go2set('src');"""
tpl = tpl[:i] + NOTICE + tpl[j:]

# ── 3c. «перегляд на телефоні» в десктопі не потрібен ─────────────────
# Це був інструмент для браузерної версії — подивитись, як апка виглядає
# на телефоні. У власному вікні застосунку сенсу немає, а кнопка ще й
# лишала по собі привидів у скляному шарі.
tpl = sub(tpl, "if(!INNER && innerWidth >= 860){\n  const btn = el('phoneBtn'); btn.hidden = false;",
          "if(false){\n  const btn = el('phoneBtn'); btn.hidden = false;", 'phone off')
# сам елемент лишається в розмітці (його читає phRender), але назавжди прихований
tpl = sub(tpl, 'id="phoneBtn" data-tip="Перегляд на телефоні" data-key="P" hidden',
          'id="phoneBtn" aria-hidden="true" hidden style="display:none"', 'phone btn')

# ── 3d. картка «Рахунки» на Огляді ───────────────────────────────────
# Баланси приходять із client-info, у браузерній версії їх немає взагалі.
tpl = sub(tpl, '    <div id="ovBalSlot"></div>',
"""    <div class="card" id="balCard" hidden>
    <div class="cardhead" id="balHead" style="cursor:pointer">
      <span class="tw-arrow" id="balArrow">▾</span>
      <h2>Рахунки</h2><span class="hint" id="balFx"></span>
      <span class="hint" id="balSum" style="margin-left:auto"></span>
    </div>
    <div id="balList"></div>
  </div>""", 'balCard')

# ── 3e. звіт про склеювання Notion + банк ────────────────────────────
# Питання «а чи не подвоїлись у мене витрати» має мати відповідь у самій
# апці, а не в моїх словах.
tpl = sub(tpl, """  el('dataInfo').innerHTML = `Операцій: ${TX.length} · ${DMIN} → ${DMAX}${META.built ? ' · знімок ' + META.built : ''}`;""",
"""  const mg = window.monoMerge || {};
  el('dataInfo').innerHTML = `Усього операцій: ${TX.length} · ${DMIN} → ${DMAX}`
    + (mg.bank ? ` · з банку ${mg.bank}` : '')
    + (mg.kept ? ` · з Notion ${mg.kept}` : '')
    + (mg.dropped ? ` · ${mg.dropped} записів Notion відкинуто як уже покриті банком` : '')
    + (mg.since ? ` · межа ${mg.since}` : '');""", 'dataInfo')

# ── 3f. нагадування: це застосунок, а не сторінка ────────────────────
# У браузері сповіщення живуть, поки відкрита вкладка, — звідси й уся
# та обережна мова. У десктопі їх шле сама оболонка через системний
# центр сповіщень, і апка сидить у треї навіть із закритим вікном.
# Лишати тут «обмеження браузера» означало б брехати користувачу.
tpl = sub(tpl, """    <p class="muted" style="margin:0 0 12px">Сторінка може сповістити лише поки вона відкрита — це обмеження
      браузера, а не налаштування. Щоб нагадування приходили й тоді, коли апку закрито,
      експортуйте підписки в календар: у файлі є правило повтору й будильник за вказану кількість днів.</p>""",
"""    <p class="muted" style="margin:0 0 12px">Сповіщення показує сама апка через центр сповіщень Windows —
      вікно для цього відкривати не треба, досить щоб вона сиділа в треї. Експорт у календар лишається
      для телефона: у файлі є правило повтору й будильник за вказану кількість днів.</p>""", 'notif text')

tpl = sub(tpl, """function notifyDue(){
  if(!('Notification' in window) || Notification.permission!=='granted') return;""",
"""function notifyDue(){
  if(!(window.__DESK__ && window.__DESK__.notify)) return;""", 'notifyDue guard')

tpl = sub(tpl, """    new Notification('Списання за підпискою', {
      body: `${s.merchant} — ${money(s.amount)} ${d===0?'сьогодні':d===1?'завтра':'через '+d+' дн.'}`,
      tag: 'sub-'+s.key,
    });""",
"""    window.__DESK__.notify('Списання за підпискою',
      `${s.merchant} — ${money(s.amount)} ${d===0?'сьогодні':d===1?'завтра':'через '+d+' дн.'}`);""",
   'notifyDue body')

tpl = sub(tpl, """async function askNotify(){
  if(!('Notification' in window)){ toastSub('Браузер не підтримує сповіщення'); return; }
  const r = await Notification.requestPermission();
  toastSub(r==='granted' ? 'Сповіщення увімкнено — працюють, поки апка відкрита'
                         : 'Дозвіл не надано. Локальні файли часто блокуються — надійніше експорт у календар.');
  renderSubs();
  if(r==='granted') notifyDue();
}""",
"""async function askNotify(){
  /* Дозволу питає сама оболонка; тут лишається тільки перевірити, що
     він є, і показати, як воно виглядатиме. */
  if(!(window.__DESK__ && window.__DESK__.notify)) return;
  window.__DESK__.notify('Гроші', 'Сповіщення увімкнено — нагадування приходитимуть навіть із закритим вікном.');
  toastSub('Перевірте центр сповіщень Windows — туди щойно пішло тестове.');
  renderSubs();
  notifyDue();
}""", 'askNotify')

tpl = sub(tpl, """  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  el('subNotifyState').textContent =
    perm==='granted' ? 'сповіщення увімкнено (працюють, поки апку відкрито)'
  : perm==='denied'  ? 'браузер заблокував сповіщення — лишається календар'
  : perm==='unsupported' ? 'браузер не підтримує сповіщення'
  : 'не увімкнено';""",
"""  el('subNotifyState').textContent = 'приходять від апки, поки вона в треї';
  el('subNotify').textContent = 'Перевірити сповіщення';""", 'notif state')

tpl = sub(tpl, """<span class="hint">Зберігається у браузері разом із рештою налаштувань — банк про неї не знає.</span>""",
"""<span class="hint">Зберігається у вашій теці з даними разом із рештою налаштувань — банк про неї не знає.</span>""",
   'note hint')

# ── 4. екран Monobank у налаштуваннях ─────────────────────────────────
MONO_HTML = """  <div class="card" data-sec="src" style="margin-bottom:12px">
    <div class="cardhead"><h2>Monobank</h2><span class="hint" id="monoState"></span></div>
    <p class="muted" style="margin:0 0 12px">Токен читає лише виписку — платежі ним неможливі.
      Кнопка «Де взяти токен» відкриє <b>api.monobank.ua</b> — там вхід через застосунок Monobank
      і кнопка «Отримати токен». Зберігається в Диспетчері облікових даних Windows, а не у файлі.</p>
    <div class="mfields">
      <label class="mf grow"><span>Токен</span>
        <input id="monoTok" type="password" placeholder="вставте токен" autocomplete="off"></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn pri glass" id="monoSave">Підключити</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn glass" id="monoGet">Де взяти токен</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn glass" id="monoForget">Забути токен</button></label>
    </div>
    <div id="monoAccs" style="margin-top:14px"></div>
    <div class="fieldrow" style="margin-top:14px">
      <button class="btn pri glass" id="monoSync">Оновити</button>
      <button class="btn glass" id="monoFull">Завантажити історію</button>
      <button class="btn glass" id="monoStop" hidden>Зупинити</button>
      <span class="muted" id="monoProg"></span>
    </div>
    <p class="muted" style="margin:10px 0 0;font-size:11.5px">Банк віддає один запит на 60 секунд,
      а виписка приходить вікнами по 31 добі — тому історія набирається довго. Спершу приходить
      останній місяць по всіх рахунках, далі глибина; зупинити можна будь-коли, завантажене лишиться.</p>
  </div>

  <div class="card" data-sec="app" style="margin-bottom:12px">
    <div class="cardhead"><h2>Оновлення</h2><span class="hint" id="updVer"></span></div>
    <p class="muted" style="margin:0 0 12px">Апка дивиться в Релізи GitHub — там лежать
      збірки. Замість репозиторію можна вказати теку (локальну чи мережеву) або адресу
      з <code>latest.json</code>: тоді оновлення працюватиме й без інтернету.</p>
    <div class="mfields">
      <label class="mf grow"><span>Репозиторій, тека або адреса</span>
        <input id="updSrc" placeholder="github:Amriel/Groshi" autocomplete="off"></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn glass" id="updPick">Обрати теку</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn pri glass" id="updCheck">Перевірити</button></label>
    </div>
    <div id="updBox" style="margin-top:14px"></div>
  </div>

  <div class="card" data-sec="app" style="margin-bottom:12px">
    <div class="cardhead"><h2>Застосунок</h2></div>
    <div class="fieldrow">
      <label class="muted" style="display:flex;gap:7px;align-items:center;cursor:pointer">
        <input type="checkbox" id="autoStart"> Запускати разом із Windows</label>
    </div>
    <div class="mfields" style="margin-top:12px">
      <label class="mf w160"><span>Оновлювати самому</span>
        <select id="autoSync"></select></label>
      <label class="mf w160"><span>Брокер IBKR</span>
        <select id="autoIbkr"></select></label>
      <label class="mf"><span>&nbsp;</span>
        <span class="muted" id="autoSyncInfo" style="line-height:var(--ctl)"></span></label>
    </div>
    <div class="mfields" style="margin-top:8px">
      <label class="mf w130"><span>Тиша з (година)</span>
        <input id="quietFrom" type="number" min="0" max="23" step="1"></label>
      <label class="mf w130"><span>до (година)</span>
        <input id="quietTo" type="number" min="0" max="23" step="1"></label>
      <label class="mf"><span>&nbsp;</span>
        <span class="muted" style="line-height:var(--ctl);font-size:11.5px">уночі банк не смикаємо; однакові години — без паузи</span></label>
    </div>
    <div class="fieldrow" style="margin-top:12px">
      <button class="btn glass" id="openDir">Показати теку з даними</button>
      <button class="btn glass" id="dirPick">Змінити теку</button>
      <button class="btn glass" id="dirReset">Стандартна</button>
    </div>
    <p class="muted" id="dirPath" style="margin:10px 0 0;font-size:12px"></p>
    <div id="dirFiles" style="margin-top:12px"></div>
    <p class="muted" style="margin:8px 0 0;font-size:11.5px">При зміні теки дані <b>переносяться</b>,
      а не копіюються — двох однакових копій не лишається. Тека переживає перевстановлення апки;
      якщо покласти її в OneDrive, Google Drive чи Dropbox, дані синхронізуються між комп'ютерами.
      Тільки не тримайте апку відкритою одночасно на двох машинах: хмара не вміє зливати зміни
      й лишить ту версію, яка збереглась останньою.</p>
  </div>

"""
tpl = sub(tpl, '  <div class="card" data-sec="app" style="margin-bottom:12px">\n    <div class="cardhead"><h2>Дані</h2></div>',
          MONO_HTML + '  <div class="card" data-sec="app" style="margin-bottom:12px">\n    <div class="cardhead"><h2>Дані</h2></div>',
          'settings')

# ── 4б. екрани брокерів (тільки читання) ──────────────────────────────
INV_HTML = """  <div class="card" data-sec="src" style="margin-bottom:12px">
    <div class="cardhead"><h2>Interactive Brokers</h2><span class="hint" id="ibkrState"></span></div>
    <p class="muted" style="margin:0 0 10px">Підключення через Flex Web Service — звітний сервіс,
      який фізично не вміє торгувати чи виводити гроші. Налаштовується один раз, хвилин за пʼять:</p>
    <ol class="muted" style="margin:0 0 12px;padding-left:20px;line-height:1.55">
      <li>У Client Portal: <b>Performance &amp; Reports → Flex Queries</b> →
        плюсик біля <b>Activity Flex Query</b>. Назва — будь-яка, напр. <code>Groshi</code>.</li>
      <li>У <b>Sections</b> клацніть <b>пʼять</b> розділів: <b>Open Positions</b>, <b>Trades</b>,
        <b>Cash Transactions</b>, <b>Cash Report</b> і <b>Net Asset Value (NAV) in Base</b>.
        У вікні кожного розділу поставте верхню галочку <b>Select All</b> і натисніть
        <b>Save</b> унизу (Options, як-от Summary/Lot, не чіпайте). Зайві поля не шкодять —
        апка бере лише потрібні.</li>
      <li>У <b>Delivery Configuration</b> поставте <b>Period → Last 365 Calendar Days</b>
        (інакше угоди й дивіденди прийдуть лише за один день). Format лишіть <b>XML</b>,
        решту (yyyyMMdd, HHmmss, «;») не чіпайте — стандартні значення саме ті, що треба.</li>
      <li><b>Continue → Create</b>. У списку Flex Queries біля назви зʼявиться
        <b>Query ID</b> — число з ~6 цифр, скопіюйте його в поле нижче.</li>
      <li>На тій же сторінці знайдіть <b>Flex Web Service Configuration</b> →
        увімкніть → <b>Generate New Token</b>, термін — рік. Токен — у поле нижче.</li>
    </ol>
    <p class="muted" style="margin:0 0 12px">Токен і Query ID зберігаються в Диспетчері
      облікових даних Windows, а не у файлі. Перший звіт IBKR формує до двох хвилин —
      апка почекає сама.</p>
    <div class="mfields">
      <label class="mf grow"><span>Токен</span>
        <input id="ibkrTok" type="password" placeholder="вставте токен Flex Web Service" autocomplete="off"></label>
      <label class="mf w130"><span>Query ID</span>
        <input id="ibkrQid" placeholder="напр. 123456" autocomplete="off" inputmode="numeric"></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn pri glass" id="ibkrSave">Підключити</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn pri glass" id="ibkrSync" hidden>Оновити зараз</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn glass" id="ibkrGet">Відкрити Client Portal</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn glass" id="ibkrImport">Імпортувати XML</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn glass" id="ibkrForget">Забути</button></label>
    </div>
    <p class="muted" id="ibkrMsg" style="margin:10px 0 0;font-size:12px"></p>
    <p class="muted" style="margin:6px 0 0;font-size:11.5px">«Імпортувати XML» — два призначення.
      <b>Запасний хід</b>, коли веб-сервіс вередує: Run біля свого query → зберегти XML → вибрати тут.
      І <b>глибока історія</b>: Flex-звіт віддає щонайбільше 365 днів, тож за старші роки зробіть у
      порталі окремий запит (Custom date range, до 365 днів на запит), збережіть XML і імпортуйте —
      файли <b>склеюються</b>, дублікати відкидаються, і динаміка з угодами стає на всю глибину.
      <span id="ibkrExtraInfo"></span></p>
    <div class="fieldrow" id="ibkrExtraRow" hidden style="margin-top:8px">
      <button class="btn glass" id="ibkrExtraClear">Прибрати імпортовані XML</button>
    </div>
  </div>

  <div class="card" data-sec="src" style="margin-bottom:12px">
    <div class="cardhead"><h2>Binance</h2><span class="hint" id="binState"></span></div>
    <ol class="muted" style="margin:0 0 12px;padding-left:20px;line-height:1.55">
      <li>На сайті Binance: іконка профілю → <b>Account → API Management</b> →
        <b>Create API</b> → System generated. Назва — будь-яка, напр. <code>Groshi</code>.</li>
      <li>Після створення відкрийте <b>Edit restrictions</b>: має стояти <b>лише</b>
        галочка <b>Enable Reading</b> — без Spot Trading, без Withdrawals, без Transfer.
        Обмеження за IP можна не вмикати (домашній IP змінюється).</li>
      <li>Скопіюйте <b>API Key</b> і <b>Secret Key</b> у поля нижче.
        Секрет Binance показує лише раз — якщо загубили, створіть ключ заново.</li>
    </ol>
    <p class="muted" style="margin:0 0 12px">Апка перевіряє права ключа і відмовиться від
      ключа, яким можна щось, крім читання. Ключ і секрет зберігаються в Диспетчері
      облікових даних Windows, а не у файлі.</p>
    <div class="mfields">
      <label class="mf grow"><span>API Key</span>
        <input id="binKey" type="password" placeholder="вставте ключ" autocomplete="off"></label>
      <label class="mf grow"><span>Secret</span>
        <input id="binSec" type="password" placeholder="вставте секрет" autocomplete="off"></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn pri glass" id="binSave">Підключити</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn pri glass" id="binSync" hidden>Оновити зараз</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn glass" id="binGet">Відкрити API Management</button></label>
      <label class="mf"><span>&nbsp;</span>
        <button class="btn glass" id="binForget">Забути</button></label>
    </div>
    <p class="muted" id="binMsg" style="margin:10px 0 0;font-size:12px"></p>
  </div>

"""
tpl = sub(tpl, '  <div class="card" data-sec="app" style="margin-bottom:12px">\n    <div class="cardhead"><h2>Оновлення</h2>',
          INV_HTML + '  <div class="card" data-sec="app" style="margin-bottom:12px">\n    <div class="cardhead"><h2>Оновлення</h2>',
          'brokers html')

# ── 5. логіка екрана Monobank ─────────────────────────────────────────
MONO_JS = r"""
/* ═══════════════════════ MONOBANK ═══════════════════════
   Опитування, а не вебхук: вебхук вимагає постійно доступного адреса й
   токена на сервері, а тут ні сервера, ні адреси немає. Банк віддає
   виписку одразу, тож різниці у свіжості практично немає. */
const D = window.__DESK__;
let MONO_ACCS = store.get('monoAccsCache', []);
const MONO_CCY = {980:'UAH', 840:'USD', 978:'EUR', 985:'PLN', 826:'GBP', 756:'CHF', 124:'CAD'};

function monoRenderAccs(){
  const host = el('monoAccs'); if(!host) return;
  if(!MONO_ACCS.length){ host.innerHTML = ''; return; }
  const picked = new Set(store.get('monoAccounts', []));
  const auto = picked.size === 0;
  host.innerHTML = `<div class="muted" style="margin-bottom:8px;font-size:12px">
      Які рахунки тягнути${auto ? ' <b>· зараз усі гривневі картки</b>' : ''}.
      Валютні можна брати теж: суми перераховуються в гривню за курсом банку на день операції.</div>`
    + MONO_ACCS.map(a=>`
      <label class="mtx${(auto ? (a.kind!=='jar' && a.currency===980) : picked.has(a.id)) ? ' on' : ' off'}"
             data-acc="${esc(a.id)}" style="cursor:pointer">
        <span class="tick"></span>
        <span class="c">${esc(a.title)}${a.masked && a.masked[0] ? ' · '+esc(a.masked[0]) : ''}</span>
        <span class="a">${fmt2(a.balance)} ${esc(CCYSIGN[MONO_CCY[a.currency]] || '₴')}</span>
      </label>`).join('');
  host.querySelectorAll('[data-acc]').forEach(n=>n.onclick=()=>{
    const id = n.dataset.acc;
    let cur = new Set(store.get('monoAccounts', []));
    if(!cur.size) cur = new Set(MONO_ACCS.filter(a=>a.kind!=='jar' && a.currency===980).map(a=>a.id));
    cur.has(id) ? cur.delete(id) : cur.add(id);
    store.set('monoAccounts', [...cur]);
    monoRenderAccs();
  });
}

function monoRenderState(){
  const n = el('monoState'); if(!n) return;
  const has = window.__BOOT__.hasToken;
  const raw = window.__BOOT__.raw || {};
  const when = raw.synced ? new Date(raw.synced*1000) : null;
  n.textContent = !has ? 'не підключено'
    : when ? `оновлено ${when.toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}`
           : 'підключено, даних ще немає';
  el('monoForget').hidden = !has;
  el('monoSync').disabled = !has;
  el('monoFull').disabled = !has;
}

async function monoReload(){
  window.__BOOT__.raw = await D.raw();
  FX = null;                       // після синку курс теж варто освіжити
  const tx = window.monoNormalize(window.__BOOT__.raw, window.__BOOT__.legacy);
  TX.length = 0; TX.push(...tx);
  invalidate(); invalidateSubs(); dpInvalidate();
  bootDates();
  render();
  monoRenderState();
}

function monoWire(){
  if(!el('monoSave')) return;
  monoRenderAccs(); monoRenderState();
  dirShow();
  autoWire();
  el('openDir').onclick = ()=>D.reveal();
  el('dirPick').onclick = async ()=>{
    const d = await D.pickDirT('Куди складати дані «Грошей»');
    if(d) dirMove(d);
  };
  el('dirReset').onclick = ()=>dirMove(null);

  updWire();
  D.autostartIs().then(v=>{ el('autoStart').checked = !!v; });
  el('autoStart').onchange = e=> e.target.checked ? D.autostartOn() : D.autostartOff();

  el('monoSave').onclick = async ()=>{
    const t = el('monoTok').value.trim();
    if(!t){ toastMono('Вставте токен'); return; }
    el('monoSave').disabled = true;
    try{
      const r = await D.tokenSet(t);
      MONO_ACCS = r.accounts || [];
      store.set('monoAccsCache', MONO_ACCS);
      window.__BOOT__.hasToken = true;
      el('monoTok').value = '';
      monoRenderAccs(); monoRenderState();
      toastMono(`Підключено · рахунків ${MONO_ACCS.length}`);
    }catch(e){ toastMono(String(e)); }
    el('monoSave').disabled = false;
  };
  el('monoForget').onclick = async ()=>{
    const ok = await uiConfirm({title:'Забути токен?',
      text:'Доступ до банку зникне. Уже завантажені операції лишаться на диску.',
      ok:'Забути'});
    if(!ok) return;
    await D.tokenClear();
    window.__BOOT__.hasToken = false;
    monoRenderState(); toastMono('Токен видалено');
  };
  /* Кнопка веде на сторінку банку, де токен і видають. Відкриваємо у
     звичайному браузері, а не всередині вікна: там вхід через Дію і
     QR-код, і робити це у вбудованому webview незручно й небезпечно. */
  el('monoGet').onclick = ()=>D.openUrl('https://api.monobank.ua/');
  el('monoSync').onclick = ()=>monoRun(0);
  el('monoStop').onclick = ()=>{ D.syncStop(); el('monoStop').textContent = 'Зупиняю…'; };
  el('monoFull').onclick = monoDeep;

  D.onSync(p=>{
    const n = el('monoProg'); if(!n) return;
    if(p.stage === 'пауза')
      n.textContent = `ліміт банку · наступний запит через ${p.wait} с (${p.done}/${p.total})`;
    else if(p.stage === 'виписка')
      n.textContent = `${p.account}: запит ${p.done+1} з ${p.total} · нових ${p.added}`;
    else if(p.stage === 'рахунки') n.textContent = 'читаю список рахунків…';
    else n.textContent = '';
  });
  D.onTraySync(()=>{ go2set('src'); monoRun(0); });
  /* Апка оновилась сама — мовчки підмінити дані під руками не можна,
     тож перемальовуємо й кажемо, що саме змінилось. */
  /* Брокер оновився сам — дані під руками не можна підмінити мовчки. */
  D.onAutoIbkr(async ()=>{
    try{ await invReload(); autoInfo(); toastMono('IBKR оновився сам'); }catch(e){}
  });
  D.onAutoSync(async d=>{
    await monoReload();
    autoInfo(); balRender();
    if(d && d.added) toastMono(`Само оновилось: +${d.added} операцій`);
  });
}

/* ── оновлення ────────────────────────────────────────────────────
   Rust перевіряє Ed25519-підпис точних байтів до запуску інсталятора.
   GitHub, HTTPS-маніфест і локальна тека вимагають однаковий .exe.sig.
   Адреса джерела не надає права запускати непідписану програму. */
function updWire(){
  if(!el('updCheck')) return;
  D.version().then(v=>{ el('updVer').textContent = 'версія ' + v; });
  /* До переходу на GitHub джерелом за замовчуванням була тека на диску,
     і в кого апка вже працювала, вона лежить у налаштуваннях. Без цього
     блоку вона мовчки перебивала б нове джерело, і апка й далі шукала б
     збірки в теці, якої на іншому компʼютері немає.

     Скидаємо рівно один раз (позначка `updSrcV`) і тільки ТЕКУ: адресу
     чи репозиторій вписували свідомо, чіпати їх не можна. Хто справді
     оновлюється з теки — обере її знову одним кліком. */
  let saved = store.get('updSource', null);
  if(store.get('updSrcV', 0) < 2){
    store.set('updSrcV', 2);
    if(saved && !/^(https?:|github:|github\.com\/)/i.test(saved.trim())){
      store.del('updSource'); saved = null;
    }
  }
  if(saved) el('updSrc').value = saved;
  else D.updSource().then(s=>{ if(!el('updSrc').value) el('updSrc').value = s || ''; });

  el('updSrc').onchange = ()=> store.set('updSource', el('updSrc').value.trim());
  el('updPick').onclick = async ()=>{
    const d = await D.pickDirT('Тека з оновленнями');
    if(d){ el('updSrc').value = d; store.set('updSource', d); }
    else pjToast && 0;
  };
  el('updCheck').onclick = ()=>updRun();
}

async function updRun(){
  const box = el('updBox'), src = el('updSrc').value.trim();
  box.innerHTML = '<span class="muted">Дивлюсь…</span>';
  try{
    const r = await D.updCheck(src);
    if(!r.available){
      box.innerHTML = `<div class="mfound" style="margin:0"><div class="mfhead">
        <b>Уже найновіша</b><span class="muted">у вас ${esc(r.current)}, у джерелі ${esc(r.version)}</span>
      </div></div>`;
      return;
    }
    box.innerHTML = `<div class="mfound" style="margin:0">
      <div class="mfhead"><b>Є оновлення ${esc(r.version)}</b>
        <span class="muted">зараз ${esc(r.current)} · ${esc(r.file)}</span>
        <button class="btn pri glass" id="updGo">Встановити</button></div>
      ${r.notes ? `<p class="muted" style="margin:4px 0 0;font-size:12.5px">${esc(r.notes)}</p>` : ''}
      <p class="muted" style="margin:8px 0 0;font-size:11.5px">
        Апка закриється, запуститься інсталятор. Дані, підписки й токен лишаться на місці —
        оновлюється тільки програма.</p></div>`;
    el('updGo').onclick = async ()=>{
      const ok = await uiConfirm({title:`Встановити ${r.version}?`,
        text:'Гроші закриються, далі все зробить інсталятор — лишіть у ньому галочку запуску, і апка відкриється сама.',
        ok:'Встановити', danger:false});
      if(!ok) return;
      el('updGo').disabled = true;
      el('updGo').textContent = 'Готую…';
      try{ await D.updInstall(src, r.file); }
      catch(e){ el('updGo').disabled = false; el('updGo').textContent = 'Встановити';
                box.insertAdjacentHTML('beforeend',
                  `<p class="muted" style="margin:8px 0 0;color:var(--warn)">${esc(String(e))}</p>`); }
    };
  }catch(e){
    box.innerHTML = `<span class="muted" style="color:var(--warn)">${esc(String(e))}</span>`;
  }
}

/* Скільки це триватиме — питання номер один. Раніше апка мовчки бралась
   за 96 запитів по хвилині кожен, тобто за півтори години, і людина про
   це дізнавалась із лічильника. Тепер глибину обирають, а поруч одразу
   написано, скільки чекати. */
const MONO_DEPTHS = [
  {m:1,  n:'Місяць'},
  {m:3,  n:'3 місяці'},
  {m:6,  n:'Півроку'},
  {m:12, n:'Рік'},
  {m:24, n:'2 роки'},
];
const humanTime = sec => {
  const m = Math.round(sec/60);
  if(m < 1) return 'менш ніж хвилина';
  if(m < 60) return `${m} хв`;
  const h = Math.floor(m/60), r = m%60;
  return r ? `${h} год ${r} хв` : `${h} год`;
};

async function monoDeep(){
  if(MONO_BUSY) return;
  el('monoProg').textContent = 'рахую, скільки це займе…';
  let plans;
  try{
    plans = await Promise.all(MONO_DEPTHS.map(d=>D.syncPlan(d.m).then(p=>({...d, ...p}))));
  }catch(e){ el('monoProg').textContent = ''; toastMono(String(e)); return; }
  el('monoProg').textContent = '';
  const pick = await uiPick({
    title:'Яку глибину завантажити',
    text:`Рахунків обрано: ${plans[0].accounts}. Банк віддає один запит на 60 секунд — час рахується з цього.`,
    options: plans.map(p=>({v:String(p.m), n:p.n,
      h: p.requests ? `${p.requests} запитів · ${humanTime(p.seconds)}` : 'усе вже є'}))});
  if(!pick) return;
  monoRun(+pick);
}

/* ── саме оновлення з банку ────────────────────────────────────────
   Апка й так сидить у треї заради нагадувань. Раз вона там — хай сама
   забирає нове: питати банк раз на годину дешевше за клацання кнопки,
   а ліміт у 60 секунд це чіпає лише в момент самого запиту. */
const AUTO_STEPS = [
  {v:0,    n:'Ніколи'},
  {v:30,   n:'Кожні 30 хв'},
  {v:60,   n:'Щогодини'},
  {v:180,  n:'Кожні 3 години'},
  {v:360,  n:'Кожні 6 годин'},
  {v:1440, n:'Раз на день'},
];
/* Брокер окремим розкладом: Flex-звіт денний, а IBKR ще й блокує
   токен за надто часті запити — тягнути його щогодини і безглуздо, і
   шкідливо. */
const IBKR_STEPS = [
  {v:0,  n:'Ніколи'},
  {v:12, n:'Двічі на день'},
  {v:24, n:'Раз на день'},
  {v:72, n:'Раз на 3 дні'},
];
function autoWire(){
  const sel = el('autoSync'); if(!sel) return;
  const cur = store.get('autoSyncMin', 0);
  sel.innerHTML = AUTO_STEPS.map(s=>
    `<option value="${s.v}"${s.v===cur?' selected':''}>${s.n}</option>`).join('');
  if(window.cselSync) cselSync(sel);
  sel.onchange = ()=>{ store.set('autoSyncMin', +sel.value); autoInfo(); };

  const ib = el('autoIbkr');
  if(ib){
    const ci = store.get('autoIbkrH', 0);
    ib.innerHTML = IBKR_STEPS.map(s=>
      `<option value="${s.v}"${s.v===ci?' selected':''}>${s.n}</option>`).join('');
    if(window.cselSync) cselSync(ib);
    ib.onchange = ()=>{ store.set('autoIbkrH', +ib.value); autoInfo(); };
  }
  const qf = el('quietFrom'), qt = el('quietTo');
  if(qf && qt){
    qf.value = store.get('autoQuietFrom', 23);
    qt.value = store.get('autoQuietTo', 8);
    const h = v => Math.max(0, Math.min(23, parseInt(v)||0));
    qf.onchange = ()=>{ store.set('autoQuietFrom', h(qf.value)); autoInfo(); };
    qt.onchange = ()=>{ store.set('autoQuietTo', h(qt.value)); autoInfo(); };
  }
  /* Rust не має chrono — годину він рахує зі зсуву, який кладемо тут. */
  store.set('autoTzMin', -new Date().getTimezoneOffset());
  autoInfo();
}
function autoInfo(){
  const n = el('autoSyncInfo'); if(!n) return;
  const every = store.get('autoSyncMin', 0);
  const last  = store.get('autoSyncLast', 0);
  const err   = store.get('autoSyncErr', '');
  /* Банк вимкнено — це ще не «нічого не оновлюється»: брокер може
     мати свій розклад, і мовчати про нього не можна. */
  if(!every){
    const ih = store.get('autoIbkrH', 0);
    n.style.color = '';
    n.textContent = ih ? `банк — тільки кнопкою · IBKR раз на ${ih} год`
                       : 'оновлення тільки кнопкою';
    return;
  }
  if(err){ n.textContent = 'остання спроба: ' + err; n.style.color = 'var(--warn)'; return; }
  n.style.color = '';
  const ibh = store.get('autoIbkrH', 0);
  const ibl = store.get('autoIbkrLast', 0);
  const qf = store.get('autoQuietFrom', 23), qt = store.get('autoQuietTo', 8);
  const parts = [ last
    ? 'востаннє ' + new Date(last*1000).toLocaleString('uk-UA',
        {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})
    : 'ще не запускалось' ];
  if(qf !== qt) parts.push(`тиша ${qf}:00–${qt}:00`);
  if(ibh) parts.push('IBKR ' + (ibl
    ? new Date(ibl*1000).toLocaleString('uk-UA', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})
    : 'ще не тягнули'));
  n.textContent = parts.join(' · ');
}

/* ── скільки лежить на рахунках ────────────────────────────────────
   Баланси приходять разом зі списком рахунків при кожній синхронізації.
   Валютні переводимо в гривню за АКТУАЛЬНИМ курсом банку: на відміну
   від операцій, де потрібен курс того дня, тут питання «скільки це
   зараз», і відповідь на нього дає лише сьогоднішній курс. */
let FX = null;
async function balRender(){
  const card = el('balCard'); if(!card) return;
  const accs = (window.__BOOT__.raw && window.__BOOT__.raw.accounts) || [];
  if(!accs.length){ card.hidden = true; return; }
  card.hidden = false;

  if(!FX){ try{ FX = await D.fx(false); }catch(e){ FX = null; } }
  const rates = (FX && FX.rates) || {};
  /* Живий курс потрібен не лише цій картці: у ньому вся друга валюта
     й перемикання основної. Тому кладемо його туди, де його бачить
     решта апки, і перемальовуємо один раз, коли він щойно приїхав. */
  if(FX && !window.FX_NOW){ window.FX_NOW = rates; try{ render(); }catch(e){} }

  let total = 0, unknown = 0;
  const rows = accs.map(a=>{
    const c = MONO_CCY[a.currency] || '?';
    const r = c === 'UAH' ? 1 : (rates[c] || null);
    if(r) total += a.balance * r; else unknown++;
    return {a, c, r, uah: r ? a.balance * r : null};
  }).sort((x,y)=> (y.uah ?? -1) - (x.uah ?? -1));

  el('balFx').textContent = FX
    ? (FX.stale ? 'курс застарілий' : 'курс банку на '
        + new Date(FX.at*1000).toLocaleString('uk-UA',
            {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}))
    : 'курс не завантажено';

  /* Картка згортається: рахунків буває вісім, а щодня потрібна лише
     загальна сума — вона лишається в шапці й у згорнутому вигляді. */
  const open = store.get('balOpen', true);
  el('balArrow').textContent = open ? '▾' : '▸';
  el('balList').hidden = !open;
  el('balSum').innerHTML = open ? '' : `<b>${money(total)}</b>`
    + (alt(total) ? ` <span class="muted">${alt(total)}</span>` : '');
  el('balHead').onclick = ()=>{ store.set('balOpen', !open); balRender(); };

  /* Рахунки ФОП і особисті картки — це різні гроші: перші оборотні,
     другі свої. Мішати їх в один стовпчик означає щоразу перечитувати
     список, шукаючи очима, де чиє.

     Головна сума завжди СПРАВА, в одній колонці однакової ширини, а
     сірий переклад у гривню — ліворуч від неї. Доти, доки вони стояли
     в порядку «сума, потім сірий», кожен рядок мав свою ширину, і
     стовпчик читався як драбина. */
  const line = ({a,c,r,uah}) => `
    <div class="balrow">
      <span class="nm">${esc(a.title)}${a.masked && a.masked[0]
        ? ` <span class="muted">${esc(a.masked[0])}</span>` : ''}</span>
      <span class="sec">${uah != null && c !== 'UAH'
        ? money(uah) + (r ? ` · курс ${fmt2(r)}` : '') : ''}</span>
      <span class="val">${fmt2(a.balance)} ${esc(CCYSIGN[c] || '₴')}</span>
    </div>`
    /* банка з ціллю: тонкий прогрес просто під рядком — Monobank ціль
       віддає, гріх її не показати */
    + (a.kind==='jar' && a.goal > 0 ? `
    <div class="meter" style="height:4px;margin:-4px 0 6px">
      <i style="width:${Math.min(100, a.balance/a.goal*100).toFixed(1)}%;background:var(--accent)"></i></div>
    <div class="muted" style="font-size:10.5px;margin:-2px 0 4px">${(a.balance/a.goal*100).toFixed(0)}% з ${fmt2(a.goal)} ${esc(CCYSIGN[c] || '₴')}</div>` : '');
  const GROUPS = [
    ['ФОП',     x => x.a.kind === 'fop'],
    ['Картки',  x => x.a.kind !== 'fop' && x.a.kind !== 'jar'],
    ['Банки',   x => x.a.kind === 'jar'],
  ];
  let left = rows.slice(), html = '';
  for(const [name, test] of GROUPS){
    const part = left.filter(test);
    if(!part.length) continue;
    left = left.filter(x => !test(x));
    const sum = part.reduce((n2, x) => n2 + (x.uah ?? 0), 0);
    html += `<div class="balgrp"><span class="nm">${name}</span>
        <span class="sec">${alt(sum) || ''}</span>
        <span class="val">${money(sum)}</span></div>`
      + part.map(line).join('');
  }
  if(left.length) html += `<div class="balgrp"><span class="nm">Інші</span>
      <span class="sec"></span><span class="val"></span></div>` + left.map(line).join('');

  el('balList').innerHTML = html
    + `<div class="balrow baltot">
         <span class="nm"><b>Разом</b></span>
         <span class="sec">${alt(total) || ''}${unknown ? ` · ${unknown} без курсу` : ''}</span>
         <span class="val"><b>${money(total)}</b></span>
       </div>`;
}

/* ── тека з даними ──────────────────────────────────────────────── */
/* Питання «а де взагалі лежить усе, що я нанастроював» має мати
   відповідь у самій апці. Інакше людина боїться чіпати теку. */
const DIR_FILES = [
  ['state.json',    'усі ваші налаштування: власні категорії й підкатегорії, правила, ' +
                    'примітки, підписки, кошториси проєктів, ліміти, виключення, тема'],
  ['mono_raw.json', 'сирі відповіді банку — операції, рахунки, баланси'],
  ['legacy.json',   'знімок історії з Notion'],
  ['fx.json',       'останні курси валют'],
  ['ibkr_raw.json', 'звіт Interactive Brokers'],
  ['binance_raw.json', 'дані Binance'],
  ['inv_cache.json', 'оброблені інвестиції'],
  ['networth.json', 'історія капіталу'],
  ['quotes.json', 'кеш котирувань'],
  ['logos.json', 'кеш логотипів'],
  ['cry_hist.json', 'історія криптовалют'],
  ['nbu_rates.json', 'кеш курсів НБУ'],
];
async function dirShow(){
  const [cur, def] = await Promise.all([D.dir(), D.dirDefault()]);
  el('dirPath').innerHTML = `<code>${esc(cur)}</code>`
    + (cur === def ? ' <span class="muted">· стандартна</span>' : '')
    + (store.get('migrationError','') ? `<p class="warnbox">${esc(store.get('migrationError',''))}</p>` : '');
  el('dirReset').hidden = cur === def;
  el('dirFiles').innerHTML =
    `<div class="muted" style="font-size:12px;margin-bottom:8px">Що саме там лежить</div>`
    + DIR_FILES.map(([f, d])=>`
        <div class="row"><span class="nm"><code>${esc(f)}</code></span>
          <span class="cnt" style="flex:2;text-align:left;white-space:normal">${esc(d)}</span></div>`).join('')
    + `<p class="muted" style="margin:10px 0 0;font-size:11.5px">
         Токена серед них немає — він у Диспетчері облікових даних Windows.
         Скопіювати теку = зробити повний бекап; повернути на місце — і все на місці.</p>`;
}

async function dirMove(path){
  try{
    let mode = 'move';
    /* Якщо в цільовій теці вже щось лежить, мовчки затирати не можна:
       це або та сама хмарна тека з іншого комп'ютера, або чужі дані. */
    if(path){
      const peek = await D.dirPeek(path);
      if(!peek.writable){ toastMono('У цю теку не можна писати'); return; }
      if(peek.has_data){
        const pick = await uiPick({
          title:'Там уже є дані «Грошей»',
          text:`У «${path}» лежать файли з даними. Що з ними робити?`,
          options:[
            {v:'adopt', n:'Працювати з тамтешніми',
             h:'поточні лишаться, де були'},
            {v:'overwrite', n:'Перенести туди мої',
             h:'тамтешні буде замінено'}]});
        if(!pick) return;
        mode = pick;
      }
    }
    const r = await D.dirSet(path, mode);
    const ok = await uiConfirm({
      title:'Перезапустити зараз?',
      text: r.used_existing
        ? `Після перезапуску апка працюватиме з даними в «${r.dir}». Поточні дані залишаться у старій теці.`
        : `Після перезапуску апка перенесе актуальні дані в «${r.dir}». До цього вона працює у поточній теці. Старі резервні копії залишаться на місці.`,
      ok:'Перезапустити', danger:false});
    if(ok) D.restart(); else dirShow();
  }catch(e){ toastMono(String(e)); }
}

let MONO_BUSY = false;
async function monoRun(months){
  if(MONO_BUSY) return;
  MONO_BUSY = true;
  el('monoSync').disabled = true; el('monoFull').disabled = true;
  el('monoStop').hidden = false; el('monoStop').textContent = 'Зупинити';
  try{
    const r = await D.sync(months);
    await monoReload();
    el('monoProg').textContent = '';
    const bits = [];
    bits.push(r.added ? `Додано ${r.added} операцій` : 'Нових операцій немає');
    bits.push(`усього ${r.total}`);
    if(r.skipped) bits.push(`${r.skipped} рахунків без руху пропущено`);
    if(r.stopped) bits.push('зупинено — завантажене збережено');
    toastMono(bits.join(' · '));
    if(r.added && !r.stopped) D.notify('Гроші', `Підтягнуто ${r.added} нових операцій`);
  }catch(e){
    el('monoProg').textContent = '';
    toastMono(String(e));
  }
  MONO_BUSY = false;
  el('monoSync').disabled = false; el('monoFull').disabled = false;
  el('monoStop').hidden = true;
}
function toastMono(m){
  const n = el('dataInfo'); if(!n) return;
  const was = n.textContent;
  n.textContent = m; clearTimeout(n._t);
  n._t = setTimeout(()=>{ n.textContent = was; }, 6000);
}
monoWire();
balRender();
/* Баланси живуть на Огляді — перемальовуємо їх щоразу, коли туди заходять. */
(function(){ const g = window.go;
  window.go = function(tab){ g(tab); if(tab === 'overview') balRender(); }; })();

/* ═══════════════════════ БРОКЕРИ ═══════════════════════
   Той самий патерн, що з банком: ключ перевіряється ДО збереження,
   зберігається в Диспетчері облікових даних, і одразу після
   підключення тягнеться перший знімок — щоб людина побачила
   результат, а не порожню вкладку. */
async function invReload(){
  const raw = await D.invRaw();
  const d = window.invNormalize({ ibkrXml: raw.ibkr ? [raw.ibkr.xml].concat(raw.ibkr.extra || []).filter(Boolean) : null,
                                  binanceRaw: raw.binance || null });
  /* Версія має збігатися зі startup у desktop.js: після синку наступний
     старт повторно використовує вже виправлений кеш нормалізації. */
  try{
    const sig = JSON.stringify([raw.ibkr && raw.ibkr.fetched || 0,
      (raw.ibkr && raw.ibkr.extra || []).length, raw.binance && raw.binance.fetched || 0, 3]);
    d.fetched = { ibkr: raw.ibkr && raw.ibkr.fetched || 0, binance: raw.binance && raw.binance.fetched || 0 };
    D.invCacheSet({ sig, data: d }).catch(()=>{});
  }catch(e){}
  d.fetched = { ibkr: raw.ibkr && raw.ibkr.fetched || 0,
                binance: raw.binance && raw.binance.fetched || 0 };
  window.invSet(d);
}
function brokerStates(){
  const i = el('ibkrState'), b = el('binState');
  if(i) i.textContent = window.__BOOT__.hasIbkr ? 'підключено' : 'не підключено';
  if(b) b.textContent = window.__BOOT__.hasBin ? 'підключено' : 'не підключено';
  /* Ключ уже збережено — головна дія тепер «Оновити зараз», а не поля
     токена: вдруге його вбивати не треба. */
  const fi = el('ibkrForget'); if(fi) fi.hidden = !window.__BOOT__.hasIbkr;
  const fb = el('binForget');  if(fb) fb.hidden = !window.__BOOT__.hasBin;
  const si = el('ibkrSync');   if(si) si.hidden = !window.__BOOT__.hasIbkr;
  const sb = el('binSync');    if(sb) sb.hidden = !window.__BOOT__.hasBin;
}
function brokerWire(){
  if(!el('ibkrSave')) return;
  brokerStates();
  const msg = (id, t)=>{ const n = el(id); if(n) n.textContent = t; };

  el('ibkrGet').onclick = ()=>D.openUrl('https://www.interactivebrokers.com/portal');
  el('binGet').onclick  = ()=>D.openUrl('https://www.binance.com/en/my/settings/api-management');

  /* «Оновити зараз» — синхронізація збереженим ключем, без повторного
     введення. IBKR по дорозі вміє відповідати «зайдіть пізніше» — апка
     чекає сама, тож кнопка чесно каже, що це може тривати кілька хвилин. */
  el('ibkrSync').onclick = async ()=>{
    el('ibkrSync').disabled = true;
    msg('ibkrMsg','Замовляю звіт в IBKR — інколи це кілька хвилин, апка почекає…');
    try{ await D.ibkrSync(); await invReload();
         msg('ibkrMsg','Готово — портфель оновлено, дивіться вкладку «Інвестиції».'); }
    catch(e){ msg('ibkrMsg', String(e)); }
    el('ibkrSync').disabled = false;
  };
  el('ibkrImport').onclick = async ()=>{
    const path = await D.pickXml();
    if(!path) return;
    msg('ibkrMsg','Читаю файл…');
    try{
      const r = await D.ibkrImport(path); await invReload();
      msg('ibkrMsg', r && r.extra
        ? `Імпортовано і склеєно (додаткових файлів: ${r.extra}) — динаміка стала глибшою.`
        : 'Імпортовано — портфель на вкладці «Інвестиції».');
      ibkrExtraUi();
    }catch(e){ msg('ibkrMsg', String(e)); }
  };
  /* показати, скільки додаткових XML склеєно, і дати їх прибрати */
  async function ibkrExtraUi(){
    try{
      const raw = await D.invRaw();
      const n = raw && raw.ibkr && (raw.ibkr.extra||[]).length || 0;
      el('ibkrExtraRow').hidden = !n;
      el('ibkrExtraInfo').textContent = n ? `Зараз склеєно додаткових файлів: ${n}.` : '';
    }catch(e){}
  }
  ibkrExtraUi();
  el('ibkrExtraClear').onclick = async ()=>{
    try{
      await D.ibkrImportClear(); await invReload(); ibkrExtraUi();
      msg('ibkrMsg','Імпортовані XML прибрано — лишився останній звіт веб-сервісу.');
    }catch(e){ msg('ibkrMsg', String(e)); }
  };
  el('binSync').onclick = async ()=>{
    el('binSync').disabled = true;
    msg('binMsg','Тягну баланси з Binance…');
    try{ await D.binSync(); await invReload();
         msg('binMsg','Готово — портфель оновлено, дивіться вкладку «Інвестиції».'); }
    catch(e){ msg('binMsg', String(e)); }
    el('binSync').disabled = false;
  };

  el('ibkrSave').onclick = async ()=>{
    const t = el('ibkrTok').value.trim(), q = el('ibkrQid').value.trim();
    if(!t || !q){ msg('ibkrMsg','Потрібні і токен, і Query ID'); return; }
    el('ibkrSave').disabled = true; msg('ibkrMsg','Перевіряю токен в IBKR…');
    try{
      const r = await D.ibkrSet(t, q);
      window.__BOOT__.hasIbkr = true;
      el('ibkrTok').value = ''; el('ibkrQid').value = '';
      brokerStates();
      /* IBKR у блокуванні «Too many failed attempts»: токен уже збережено,
         але тягнути звіт зараз означає продовжити блок — чесно кажемо
         почекати і НЕ синхронізуємо. */
      if(r && r.deferred){ msg('ibkrMsg','Токен збережено. ' + r.msg); }
      else{
        msg('ibkrMsg','Підключено. Тягну перший звіт — IBKR інколи формує його кілька хвилин…');
        await D.ibkrSync(); await invReload();
        msg('ibkrMsg','Готово — портфель на вкладці «Інвестиції».');
      }
    }catch(e){ msg('ibkrMsg', String(e)); }
    el('ibkrSave').disabled = false;
  };
  el('ibkrForget').onclick = async ()=>{
    const ok = await uiConfirm({title:'Забути токен IBKR?',
      text:'Доступ до звітів зникне. Останній знімок портфеля лишиться на диску.', ok:'Забути'});
    if(!ok) return;
    await D.ibkrClear(); window.__BOOT__.hasIbkr = false;
    brokerStates(); msg('ibkrMsg','Токен видалено');
  };

  el('binSave').onclick = async ()=>{
    const k = el('binKey').value.trim(), s = el('binSec').value.trim();
    if(!k || !s){ msg('binMsg','Потрібні і ключ, і секрет'); return; }
    el('binSave').disabled = true; msg('binMsg','Перевіряю права ключа…');
    try{
      await D.binSet(k, s);
      window.__BOOT__.hasBin = true;
      el('binKey').value = ''; el('binSec').value = '';
      brokerStates();
      msg('binMsg','Ключ читаючий — приймаю. Тягну баланси…');
      await D.binSync(); await invReload();
      msg('binMsg','Готово — портфель на вкладці «Інвестиції».');
    }catch(e){ msg('binMsg', String(e)); }
    el('binSave').disabled = false;
  };
  el('binForget').onclick = async ()=>{
    const ok = await uiConfirm({title:'Забути ключ Binance?',
      text:'Доступ до балансів зникне. Останній знімок лишиться на диску.', ok:'Забути'});
    if(!ok) return;
    await D.binClear(); window.__BOOT__.hasBin = false;
    brokerStates(); msg('binMsg','Ключ видалено');
  };
}
brokerWire();
(function(){ const g = window.go;
  window.go = function(tab){ g(tab); if(tab === 'settings') brokerStates(); }; })();
"""

# логіка вішається після того, як усе інше визначено
# Після render() у шаблоні тепер живе блок прогрівання — якір лишається
# на самому render(), а не на кінці скрипта.
tpl = sub(tpl, '\nrender();\n', MONO_JS + '\nrender();\n', 'tail')

# ── 6. головний скрипт не виконується сам ─────────────────────────────
tpl = tpl.replace('__GLASSGL__', glass).replace('__DESIGNER__', designer)
tpl = tpl.replace('__MCCNAME__', script_json(mcc))

BOOT = """<script src="mononorm.js"></script>
<script src="invnorm.js"></script>
<script src="desktop.js"></script>"""
# останній <script> у файлі — головний
k = tpl.rindex('<script>')
end = tpl.rindex('</script>')
# Окремий локальний файл дозволяє заборонити виконання довільних inline-скриптів.
(OUT / 'app.js').write_text(tpl[k + len('<script>'):end], encoding='utf-8')
tpl = protect_html(tpl[:k] + BOOT + tpl[end + len('</script>'):], desktop=True)

(OUT / 'index.html').write_text(tpl, encoding='utf-8')
print('desktop built', len(tpl))
