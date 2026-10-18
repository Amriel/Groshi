// Вкладка «Порадник»: чат із Claude Code з прихованими NDA-назвами.
// Браузерна збірка показує заглушку; десктопна — з підробленим мостом
// (після завантаження підмінюємо window.__DESK__.advisor*, Rust не потрібен).
// Сторожить:
//  · клавіша 7 відкриває вкладку, у браузері видно «лише в десктопній версії»;
//  · зведення (system) містить «Станом на», а сума місяця в ньому дорівнює
//    сумі «Огляду» за той самий місяць (читаємо з екрана Огляду);
//  · NDA: назва клієнта не потрапляє ні в system, ні в prompt, а відповідь
//    із псевдонімом показується зі справжньою назвою;
//  · «нічого не смикається»: шапка й поле вводу до/під час/після потоку на місці;
//  · <script> у відповіді — текст, а не елемент;
//  · error ховає «Стоп» і не блокує наступне питання;
//  · під час потоку друга відправка заблокована, перемикання вкладок не губить текст;
//  · цифри в полі вводу не перемикають вкладки; advisorStop() один раз при старті;
//  · немає claude/node → картка з кроками, поле вводу сховане;
//  · три способи: «Локальна модель» (без hide, бейдж «локально», історія текстом, підказка про LM Studio),
//    «API Anthropic» (hide, лише дописування conv.api з події state, помилка/Стоп нічого не дописують),
//    картка «вимкнено» для cc/api при privacyServices.advisor=false і «Увімкнути»,
//    ключ API іде лише в advisorKeySet і не лишається ні в історії, ні в localStorage, ні в DOM;
//    перемикач способу лише для порожньої розмови, нова розмова не успадковує історію.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {openDesktop} from './helpers/desktop-boot.mjs';
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
const CLIENT = 'ТОВ "Альфа Груп"';

// Підроблений міст: advisorAsk записує req і віддає події сценарію
// window.__script(req) → [{kind, text, wait}], як їх шле Rust.
async function fakeBridge(page, probe) {
  await page.evaluate(p => {
    const D = window.__DESK__;
    window.__reqs = []; window.__stops = 0; window.__hist = null; window.__script = () => [];
    let emit = null;
    D.advisorProbe = async () => p;
    D.advisorStop = async () => { window.__stops++; };
    D.advisorHist = async () => null;
    D.advisorHistSet = async v => { window.__hist = JSON.parse(JSON.stringify(v)); };
    D.onAdvisor = cb => { emit = cb; };
    const mk = kind => async req => {
      window.__reqs.push(Object.assign({__kind: kind}, req));
      const evs = window.__script(req);
      (async () => {
        for (const ev of evs) {
          await new Promise(r => setTimeout(r, ev.wait || 15));
          emit({conv: req.conv, kind: ev.kind, text: ev.text || ''});
        }
      })();
    };
    D.advisorAsk = mk('cc'); D.advisorLocalAsk = mk('local'); D.advisorApiAsk = mk('api');
    window.__lm = ['model-a', 'model-b']; window.__lmUrls = []; window.__lmFail = false;
    D.advisorLocalModels = async url => {
      window.__lmUrls.push(url);
      if (window.__lmFail) throw new Error('Не вдалося зʼєднатися з локальним сервером');
      return window.__lm;
    };
    // Вхід у Claude Code та каталог LM Studio: за замовчуванням `lms` «не знайдено», тож старі сценарії
    // беруть моделі з сервера; нові сценарії вмикають __lmsFail = false.
    window.__ccAuth = {logged_in: false, method: ''}; window.__ccLogins = 0; window.__ccChecks = 0;
    window.__lmsModels = [{key: 'test-model-7b', name: 'Test Model 7B', params: '7B', size_gb: 4.4, tools: true},
                          {key: 'plain-small', name: 'Plain Small', params: '', size_gb: 0.9, tools: false}];
    window.__lmsFail = true; window.__lmsStarts = 0; window.__lmsStartFail = false;
    D.advisorCcAuth = async () => { window.__ccChecks++; return window.__ccAuth; };
    D.advisorCcLogin = async () => { window.__ccLogins++; };
    D.advisorLmsModels = async () => { if (window.__lmsFail) throw new Error('LM Studio не знайдено'); return window.__lmsModels; };
    D.advisorLmsServerStart = async () => { if (window.__lmsStartFail) throw new Error('збій'); window.__lmsStarts++; };
    window.__keyHas = false; window.__keys = []; window.__keyClears = 0;
    D.advisorKeyHas = async () => window.__keyHas;
    D.advisorKeySet = async k => { window.__keys.push(k); window.__keyHas = true; };
    D.advisorKeyClear = async () => { window.__keyClears++; window.__keyHas = false; };
  }, probe);
}
const OK = {found: true, path: 'claude', version: '2.0.0', node: 'v22.0.0'};
const rects = page => page.evaluate(() => {
  const r = id => { const b = document.querySelector(id).getBoundingClientRect();
    return [b.x, b.y, b.width, b.height].map(v => Math.round(v * 10) / 10); };
  return {head: r('#tab-advisor .advhead'), input: r('#advIn')};
});
const idle = (page, n) => page.waitForFunction(k => window.__reqs.length >= k && document.getElementById('advStop').hidden, n, {timeout: 8000});
const pickProv = async (page, name) => {
  await page.click('#advProvW .cselb');
  await page.click(`.cselm:not([hidden]) .cselo:has-text("${name}")`);
};
// Налаштування Порадника живуть у «Налаштування → Порадник»: шестерня в шапці вкладки веде туди, назад — go('advisor').
const gear = async page => { await page.click('#advGear'); await page.waitForSelector('#advSetLocal', {state: 'visible'}); };
const back = async page => { await page.evaluate(() => go('advisor')); await page.waitForSelector('#advIn', {state: 'visible'}); };
const ask = async (page, q) => {
  await page.fill('#advIn', q);
  await page.click('#advSend');
};

try {
  // ── браузерна збірка ──
  { const ctx = await browser.newContext({viewport: {width: 1400, height: 900}});
    await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(root, '.test-artifacts', 'synthetic_app.html')).href);
    await page.waitForFunction(() => typeof window.go === 'function');
    await page.keyboard.press('7');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => S.tab), 'advisor', 'клавіша 7 не відкрила Порадника');
    const txt = await page.evaluate(() => document.getElementById('tab-advisor').innerText);
    assert.ok(txt.includes('лише в десктопній версії'), 'нема заглушки браузера: ' + txt);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('advIn')).display === 'none' || document.getElementById('advIn').offsetParent === null), true, 'у браузері поле вводу видно');
    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }

  // ── десктоп: основний сценарій ──
  { const {ctx, page, errors} = await openDesktop(browser, {width: 1400, state: {clientsDB: {[CLIENT]: {name: CLIENT, reg: '12345678'}},
    privacyServices: {advisor: true}}});
    await fakeBridge(page, OK);
    await page.keyboard.press('7');
    await page.waitForSelector('#advIn', {state: 'visible'});
    assert.equal(await page.evaluate(() => S.tab), 'advisor');
    assert.equal(await page.evaluate(() => window.__stops), 1, 'advisorStop() має викликатись один раз при старті вкладки');

    // порожня розмова: три підказки
    const sug = await page.$$eval('#advMsgs .advsug', b => b.map(x => x.textContent.trim()));
    assert.deepEqual(sug, ['Куди йдуть гроші', 'Як скоротити витрати', 'Що з портфелем і ринком']);
    assert.ok(await page.evaluate(() => document.getElementById('advStop').hidden), '«Стоп» видно без потоку');

    // цифри й літери в полі вводу не перемикають вкладки
    await page.focus('#advIn');
    await page.keyboard.type('7 t s 3');
    assert.equal(await page.evaluate(() => S.tab), 'advisor', 'клавіша у полі вводу змінила вкладку');
    await page.fill('#advIn', '');

    const before = await rects(page);

    // 1) «Куди йдуть гроші» → зведення
    await page.evaluate(() => { window.__script = () => [
      {kind: 'tool', text: 'операції за вересень', wait: 250},
      {kind: 'text', text: 'Усього '}, {kind: 'text', text: 'пішло '}, {kind: 'text', text: 'багато.'},
      {kind: 'done'}]; });
    await page.click('#advMsgs .advsug >> text=Куди йдуть гроші');
    await page.waitForFunction(() => /дивлюсь: операції за вересень/.test(document.getElementById('advMsgs').innerText), null, {timeout: 5000});
    const mid = await rects(page);
    await idle(page, 1);
    const sys = await page.evaluate(() => window.__reqs[0].system);
    assert.ok(sys.includes('Станом на'), 'у system нема «Станом на»');
    assert.ok(/правил|довіряй зведенню/i.test(sys), 'у system нема інструкції');
    const m = sys.match(/^- (\d{4}-\d{2}) \([^)]*\): витрати ([^;\n]+);/m);
    assert.ok(m, 'у зведенні нема рядка місяця «- РРРР-ММ: витрати …»:\n' + sys.slice(0, 1500));
    const fromOverview = await page.evaluate(ym => {
      const [y, mo] = ym.split('-').map(Number);
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      S.period = 'custom'; S.from = ym + '-01'; S.to = ym + '-' + String(last).padStart(2, '0');
      go('overview');
      return document.querySelector('#kpis .kpi .val').textContent;
    }, m[1]);
    const norm = s => s.replace(/\s+/g, ' ').trim();
    assert.equal(norm(m[2]), norm(fromOverview), `сума місяця ${m[1]}: зведення «${m[2]}», Огляд «${fromOverview}»`);
    await page.evaluate(() => go('advisor'));
    await page.waitForSelector('#advIn', {state: 'visible'});
    const after = await rects(page);
    assert.deepEqual(mid, before, 'шапка/поле вводу зсунулись під час потоку');
    assert.deepEqual(after, before, 'шапка/поле вводу зсунулись після потоку');
    const full = await page.evaluate(() => document.getElementById('advMsgs').innerText);
    assert.ok(full.includes('Усього пішло багато.'), 'текст не дописано повністю: ' + full);
    assert.ok(await page.evaluate(() => document.getElementById('advStop').hidden), '«Стоп» лишився після done');

    // 2) NDA
    await page.evaluate(c => { window.__alias = groshiPseudo.alias('client', c);
      window.__script = () => [{kind: 'text', text: 'Платила ' + window.__alias + ' — вчасно.'}, {kind: 'done'}]; }, CLIENT);
    await ask(page, 'скільки заплатила Альфа Груп?');
    await idle(page, 2);
    const r2 = await page.evaluate(() => window.__reqs[1]);
    assert.ok(!r2.system.includes('Альфа'), 'назва клієнта в system');
    assert.ok(!r2.prompt.includes('Альфа'), 'назва клієнта в prompt: ' + r2.prompt);
    assert.ok(/Клієнт [A-Z2-9]{6}/.test(r2.prompt), 'питання без псевдоніма: ' + r2.prompt);
    const shown = await page.evaluate(() => document.getElementById('advMsgs').innerText);
    assert.ok(shown.includes('Платила ТОВ "Альфа Груп"') || shown.includes('Платила Альфа Груп'), 'відповідь без справжньої назви: ' + shown);
    assert.ok(!shown.includes(await page.evaluate(() => window.__alias)), 'у відповіді лишився псевдонім');
    assert.ok(await page.evaluate(() => /хмара · назви приховано/.test(document.getElementById('tab-advisor').innerText)), 'нема бейджа приватності');

    // 3) XSS
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'ок <script>alert(1)</script> **жирно**'}, {kind: 'done'}]; });
    await ask(page, 'тест');
    await idle(page, 3);
    const xss = await page.evaluate(() => ({s: document.querySelectorAll('#advMsgs script').length,
      t: document.getElementById('advMsgs').innerText, b: document.querySelectorAll('#advMsgs b, #advMsgs strong').length}));
    assert.equal(xss.s, 0, 'script у списку повідомлень');
    assert.ok(xss.t.includes('<script>alert(1)</script>'), 'текст script не показано буквально');
    assert.ok(xss.b >= 1, '**жирний** не відрендерився');

    // вузький екран: жодного горизонтального скролу, поле вводу в межах вікна
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForTimeout(200);
    const narrow = await page.evaluate(() => ({h: document.documentElement.scrollWidth > innerWidth,
      r: document.getElementById('advIn').getBoundingClientRect().right, w: innerWidth,
      badge: document.getElementById('advBadge').scrollWidth <= document.getElementById('advBadge').clientWidth}));
    assert.ok(!narrow.h && narrow.r <= narrow.w, '390 px: переповнення ' + JSON.stringify(narrow));
    assert.ok(narrow.badge, '390 px: бейдж приватності обрізано');
    await page.setViewportSize({width: 1400, height: 900});

    // 4) error → повідомлення, Стоп сховано, наступне питання йде
    await page.evaluate(() => { window.__script = () => [{kind: 'error', text: 'Збій зв\'язку з Claude'}]; });
    await ask(page, 'питання з помилкою');
    await idle(page, 4);
    assert.ok(await page.evaluate(() => document.getElementById('advMsgs').innerText.includes('Збій зв\'язку з Claude')), 'помилку не видно');
    assert.equal(await page.evaluate(() => document.getElementById('advSend').disabled), false, 'після error відправка заблокована');
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'вже добре'}, {kind: 'done'}]; });
    await ask(page, 'ще раз');
    await idle(page, 5);
    assert.ok(await page.evaluate(() => document.getElementById('advMsgs').innerText.includes('вже добре')), 'після error нове питання не пройшло');

    // 5) блокування під час потоку + перемикання вкладок
    await page.evaluate(() => { window.__script = () => [
      {kind: 'text', text: 'AAA ', wait: 300}, {kind: 'text', text: 'BBB ', wait: 300}, {kind: 'text', text: 'CCC', wait: 300}, {kind: 'done'}]; });
    await ask(page, 'довге');
    assert.equal(await page.evaluate(() => document.getElementById('advSend').disabled), true, 'кнопка не заблокована під час потоку');
    assert.equal(await page.evaluate(() => document.getElementById('advStop').hidden), false, '«Стоп» не видно під час потоку');
    await page.fill('#advIn', 'друге');
    await page.focus('#advIn');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__reqs.length), 6, 'друге відправлення пройшло під час потоку');
    await page.evaluate(() => go('overview'));
    await page.waitForTimeout(500);
    await page.evaluate(() => go('advisor'));
    await idle(page, 6);
    const tail = await page.evaluate(() => document.getElementById('advMsgs').innerText);
    assert.ok(tail.includes('AAA BBB CCC'), 'відповідь після перемикання вкладок неповна: ' + tail.slice(-200));

    // 6) Стоп без тексту: одразу «Відповідь перервано», назва інструмента читабельна,
    //    відправка заблокована до done від Rust (хвіст після kill)
    await page.evaluate(() => { window.__script = () => [
      {kind: 'tool', text: 'mcp__groshi__transactions: вересень', wait: 20}, {kind: 'done', wait: 700}]; });
    await ask(page, 'перше на стоп');
    await page.waitForFunction(() => /дивлюсь: операції: вересень/.test(document.getElementById('advMsgs').innerText), null, {timeout: 3000});
    await page.click('#advStop');
    assert.ok(await page.evaluate(() => document.getElementById('advMsgs').innerText.includes('Відповідь перервано')), 'Стоп без тексту: нема «Відповідь перервано»');
    assert.equal(await page.evaluate(() => document.getElementById('advSend').disabled), true, 'відправка не заблокована під час дренажу');
    assert.ok(await page.evaluate(() => document.getElementById('advStop').hidden), '«Стоп» лишився після натискання');
    await page.waitForFunction(() => !document.getElementById('advSend').disabled, null, {timeout: 4000});

    // 7) Стоп посеред тексту: запізнілий хвіст і done не потрапляють у наступну відповідь
    await page.evaluate(() => { window.__script = () => [
      {kind: 'text', text: 'ПОЧАТОК ', wait: 20}, {kind: 'text', text: 'ХВІСТ', wait: 500}, {kind: 'done', wait: 50}]; });
    await ask(page, 'друге на стоп');
    await page.waitForFunction(() => document.getElementById('advMsgs').innerText.includes('ПОЧАТОК'), null, {timeout: 3000});
    await page.click('#advStop');
    assert.equal(await page.evaluate(() => document.getElementById('advSend').disabled), true, 'відправка не заблокована після Стоп');
    await page.waitForFunction(() => !document.getElementById('advSend').disabled, null, {timeout: 4000});
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'НОВА ВІДПОВІДЬ', wait: 200}, {kind: 'done', wait: 100}]; });
    await ask(page, 'після стопу');
    await idle(page, 8);
    const bots = await page.$$eval('#advMsgs .advmsg.bot', n => n.map(x => x.innerText));
    assert.ok(bots.at(-1).includes('НОВА ВІДПОВІДЬ'), 'нова відповідь неповна: ' + bots.at(-1));
    assert.ok(!bots.at(-1).includes('ХВІСТ'), 'хвіст зупиненої відповіді потрапив у нову');
    assert.ok(!bots.at(-2).includes('ХВІСТ'), 'хвіст дописано в зупинену відповідь');

    // підписи інструментів
    const lbl = await page.evaluate(() => ['mcp__groshi__transactions: q', 'money_flow', 'mcp__groshi__portfolio_summary', 'mcp__groshi__position: X',
      'mcp__groshi__fop_and_invoices', 'market: S&P', 'groshi_status', 'WebSearch: ставки НБУ', 'mcp__groshi__невідомий_x', 'mcp__groshi__foo_bar'].map(advToolLabel));
    assert.deepEqual(lbl, ['операції: q', 'доходи й витрати', 'портфель', 'портфель: X', 'ФОП і рахунки', 'ринок: S&P',
      'стан даних', 'пошук у мережі: ставки НБУ', 'невідомий_x', 'foo_bar']);

    // історія збережена, у ній справжні назви (як бачить власник)
    const hist = await page.evaluate(() => window.__hist);
    assert.ok(Array.isArray(hist) && hist.length === 1 && hist[0].provider === 'cc', 'історію не збережено: ' + JSON.stringify(hist));
    assert.ok(JSON.stringify(hist).includes('Альфа Груп'), 'в історії нема справжньої назви');
    assert.ok(hist[0].msgs.every(x => x.role && typeof x.text === 'string'), 'форма повідомлень');

    // список розмов: видалення через uiConfirm
    await page.evaluate(() => document.querySelector('#advList [data-advdel]').click());
    await page.waitForSelector('#modal:not([hidden])');
    await page.click('#modalYes');
    await page.waitForFunction(() => window.__hist && window.__hist.length === 0);

    assert.deepEqual(errors, [], 'помилки JavaScript: ' + errors.join(' | '));
    assert.deepEqual(await page.evaluate(() => window.__unexpectedCommands), [], 'неочікувані IPC-команди');
    await ctx.close(); }

  // ── десктоп: три способи ──
  { // власна інструкція зі справжньою назвою клієнта: hide() її замінив би, у local вона лишається
    const {ctx, page, errors} = await openDesktop(browser, {width: 1400, state: {
      clientsDB: {[CLIENT]: {name: CLIENT, reg: '12345678'}},
      advisorPrompt: 'Довідка: основний клієнт — ' + CLIENT + '. Відповідай коротко.',
      privacyServices: {advisor: false}}});
    await fakeBridge(page, OK);
    await page.keyboard.press('7');
    await page.waitForSelector('#advProv', {state: 'attached'});
    await page.waitForFunction(() => !document.getElementById('advMain').hidden);

    // cc при вимкненому дозволі: картка замість поля вводу
    const off = await page.evaluate(() => ({card: !document.getElementById('advOff').hidden,
      txt: document.getElementById('advOff').innerText, input: document.getElementById('advIn').offsetParent !== null}));
    assert.ok(off.card && /Порадник у хмарі вимкнено/.test(off.txt), 'нема картки «вимкнено»: ' + off.txt);
    assert.equal(off.input, false, 'поле вводу видно при вимкненому дозволі');

    // локальна модель дозволу не потребує
    await pickProv(page, 'Локальна модель');
    await page.waitForSelector('#advIn', {state: 'visible'});
    assert.equal(await page.evaluate(() => document.getElementById('advOff').hidden), true, 'картку не сховано для local');
    assert.equal(await page.evaluate(() => document.getElementById('advBadge').textContent.trim()), 'локально');
    await page.waitForFunction(() => document.getElementById('advLocalModel').value === 'model-a');
    assert.deepEqual(await page.evaluate(() => window.__lmUrls), ['http://localhost:1234/v1'], 'список моделей не запитано за типовою адресою');
    const geo = () => page.evaluate(() => ['advMsgs', 'advIn'].map(id => {
      const b = document.getElementById(id).getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map(v => Math.round(v * 10) / 10); }));
    const g0 = await geo();
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'Готово.'}, {kind: 'done'}]; });
    await ask(page, 'Що з клієнтом ' + CLIENT + '?');
    await idle(page, 1);
    const r1 = await page.evaluate(() => window.__reqs[0]);
    assert.equal(r1.__kind, 'local');
    assert.ok(r1.system.includes(CLIENT), 'local: назву клієнта приховано у system');
    assert.ok(/локальна модель/i.test(r1.system) && /Цифри/.test(r1.system) && r1.system.includes('Станом на'), 'у system нема додатка для локальної моделі чи зведення');
    assert.deepEqual(r1.messages, [{role: 'user', content: 'Що з клієнтом ' + CLIENT + '?'}], 'local: питання змінено');
    assert.equal(r1.url, 'http://localhost:1234/v1'); assert.equal(r1.model, 'model-a'); assert.equal(r1.tools, true, 'за замовчуванням «З інструментами»');
    assert.deepEqual(await geo(), g0, 'вікно повідомлень/поле вводу зсунулись, коли перемикач став бейджем');
    assert.equal(await page.evaluate(() => document.getElementById('advProvW').hidden), true, 'перемикач способу лишився в розмові з повідомленнями');
    assert.equal(await page.evaluate(() => document.getElementById('advProvTag').textContent), 'Локальна модель');
    assert.ok(await page.evaluate(() => document.getElementById('advMsgs').innerText.includes('LM Studio · model-a')), 'нема підпису «LM Studio · model-a»');
    // друге питання: історія текстом; checkbox «З інструментами»
    await gear(page);
    await page.click('#advLocalTools');
    await back(page);
    await ask(page, 'а ще?');
    await idle(page, 2);
    const r2 = await page.evaluate(() => window.__reqs[1]);
    assert.deepEqual(r2.messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(r2.messages[1].content, 'Готово.'); assert.equal(r2.tools, false, 'checkbox «З інструментами» не діє');
    // сервер недоступний
    await page.evaluate(() => { window.__script = () => [{kind: 'error', text: 'Не вдалося зʼєднатися з локальним сервером'}]; });
    await ask(page, 'ще');
    await idle(page, 3);
    assert.ok(await page.evaluate(() => /lms server start/.test(document.getElementById('advMsgs').innerText)), 'нема підказки про запуск сервера');
    // оновлення списку при недоступному сервері
    await page.evaluate(() => { window.__lmFail = true; });
    await gear(page);
    await page.click('#advLocalRefresh');
    await page.waitForFunction(() => /lms server start/.test(document.getElementById('advLocalHint').innerText));
    await back(page);

    // нова розмова іншим способом: перемикач знову доступний, історії нема; API при вимкненому дозволі — картка
    // обрив потоку НЕ про вимкнений сервер: звичайна помилка без підказки про запуск
    await page.evaluate(() => { window.__script = () => [{kind: 'error', text: 'Зʼєднання з локальним сервером перервано'}]; });
    await ask(page, 'обрив');
    await idle(page, 4);
    assert.ok(await page.evaluate(() => /перервано/.test(document.getElementById('advMsgs').innerText)), 'нема тексту помилки обриву');
    assert.ok(await page.evaluate(() => !/lms server start/.test(document.getElementById('advMsgs').lastElementChild.innerText)), 'обрив потоку показав підказку про запуск сервера');
    await page.click('#advNew');
    assert.equal(await page.evaluate(() => document.getElementById('advProvW').hidden), false, 'перемикач недоступний у новій розмові');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#advMsgs .advmsg').length), 0, 'нова розмова успадкувала повідомлення');
    await pickProv(page, 'API Anthropic');
    assert.equal(await page.evaluate(() => !document.getElementById('advOff').hidden && document.getElementById('advIn').offsetParent === null), true, 'API: нема картки вимкнення');
    assert.equal(await page.evaluate(() => document.getElementById('advBadge').textContent.trim()), 'хмара · назви приховано');
    // без дозволу «Зберегти ключ…» вимкнена й не дзвонить у міст; «Видалити ключ» не залежить від дозволу
    assert.equal(await page.evaluate(() => document.getElementById('advKeySet').disabled), true, 'вимкнений Порадник: «Зберегти ключ» активна');
    assert.ok(await page.evaluate(() => /Налаштуваннях → Порадник/.test(document.getElementById('advKeySetW').dataset.tip || '')), 'нема підказки, чому ключ не зберегти');
    await page.evaluate(() => document.getElementById('advKeySet').click());
    assert.equal(await page.evaluate(() => document.getElementById('modal').hidden), true, 'вимкнена кнопка відкрила вікно ключа');
    assert.deepEqual(await page.evaluate(() => window.__keys), [], 'advisorKeySet викликано при вимкненому Порадникові');
    // «Увімкнути» пише той самий ключ, що й «Налаштування → Підключення»
    await page.click('#advOn');
    await page.waitForSelector('#advIn', {state: 'visible'});
    assert.equal(await page.evaluate(() => privacyAllowed('advisor')), true, 'дозвіл не записано');
    assert.equal(await page.evaluate(() => document.getElementById('advKeySet').disabled), false, 'з дозволом «Зберегти ключ» лишилась вимкненою');
    assert.equal(await page.evaluate(() => document.querySelector('[data-privacy="advisor"]').getAttribute('aria-pressed')), 'true', 'перемикач у Підключеннях не синхронізовано');

    // ключ API
    await page.waitForFunction(() => /не збережено/.test(document.getElementById('advKeyState').innerText));
    const SECRET = 'zz-fake-key-0123456789';
    await gear(page);
    await page.click('#advKeySet');
    await page.waitForSelector('#modal:not([hidden])');
    assert.equal(await page.evaluate(() => document.getElementById('modalI').type), 'password', 'поле ключа не приховує символи');
    await page.fill('#modalI', SECRET);
    await page.click('#modalYes');
    await page.waitForFunction(() => /: збережено/.test(document.getElementById('advKeyState').innerText));
    assert.deepEqual(await page.evaluate(() => window.__keys), [SECRET]);
    const leak = await page.evaluate(s => ({dom: document.documentElement.outerHTML.includes(s), inp: document.getElementById('modalI').value,
      ls: JSON.stringify(Object.entries(localStorage)).includes(s), adv: JSON.stringify(ADV.convs).includes(s) || JSON.stringify(ADV.prov).includes(s),
      st: JSON.stringify(store.get('advisorApiModel', null)).includes(s)}), SECRET);
    assert.deepEqual(leak, {dom: false, inp: '', ls: false, adv: false, st: false}, 'ключ лишився на сторінці: ' + JSON.stringify(leak));
    await back(page);

    // API: hide, дописування лише з state, помилка/Стоп нічого не дописують
    await page.evaluate(c => { window.__alias = groshiPseudo.alias('client', c);
      window.__script = () => [{kind: 'text', text: 'Платила ' + window.__alias + '.'},
        {kind: 'state', text: JSON.stringify([{role: 'assistant', content: [{type: 'text', text: 'Платила ' + window.__alias + '.'}]},
                                              {role: 'assistant', content: [{type: 'text', text: 'Ще.'}]}])},
        {kind: 'done'}]; }, CLIENT);
    await ask(page, 'скільки заплатила Альфа Груп?');
    await idle(page, 5);
    const a1 = await page.evaluate(() => window.__reqs[4]);
    assert.equal(a1.__kind, 'api');
    assert.ok(!a1.system.includes('Альфа') && !JSON.stringify(a1.messages).includes('Альфа') && !a1.system.includes(CLIENT), 'API: назва клієнта у запиті');
    assert.equal(a1.messages.length, 1); assert.ok(/Клієнт [A-Z2-9]{6}/.test(a1.messages[0].content), 'API: питання без псевдоніма');
    assert.equal(a1.model, undefined, 'порожня модель має піти як відсутня');
    assert.ok(await page.evaluate(() => document.getElementById('advMsgs').innerText.includes('Платила ТОВ "Альфа Груп".')), 'API: відповідь без справжньої назви');
    assert.ok(await page.evaluate(() => document.getElementById('advMsgs').innerText.includes('API · claude-opus-5-5')), 'нема підпису API');
    let h = await page.evaluate(() => window.__hist[0]);
    assert.equal(h.provider, 'api'); assert.equal(h.api.length, 3, 'у conv.api має бути питання + 2 повідомлення стану');
    assert.equal(h.api[0].role, 'user'); assert.ok(!JSON.stringify(h.api).includes('Альфа'), 'у conv.api справжня назва');
    // друге питання: попередні 3 + нове
    await ask(page, 'і ще');
    await idle(page, 6);
    const a2 = await page.evaluate(() => window.__reqs[5]);
    assert.equal(a2.messages.length, 4);
    assert.deepEqual(a2.messages.slice(0, 3), h.api, 'історія API не дописується як є');
    assert.equal(a2.messages[3].content, 'і ще');
    h = await page.evaluate(() => window.__hist[0]); assert.equal(h.api.length, 6);
    // помилка: нічого не дописується, наступний запит без висячого питання
    await page.evaluate(() => { window.__script = () => [{kind: 'error', text: 'Збій API'}]; });
    await ask(page, 'збій');
    await idle(page, 7);
    h = await page.evaluate(() => window.__hist[0]); assert.equal(h.api.length, 6, 'помилка дописала в conv.api');
    // Стоп до state: нічого не дописується, запізнілі state/done ігноруються
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'почав', wait: 20},
      {kind: 'state', text: JSON.stringify([{role: 'assistant', content: [{type: 'text', text: 'пізно'}]}]), wait: 400}, {kind: 'done', wait: 20}]; });
    await ask(page, 'стоп');
    await page.waitForFunction(() => document.getElementById('advMsgs').innerText.includes('почав'), null, {timeout: 3000});
    await page.click('#advStop');
    await page.waitForFunction(() => !document.getElementById('advSend').disabled, null, {timeout: 4000});
    h = await page.evaluate(() => window.__hist[0]); assert.equal(h.api.length, 6, 'Стоп дописав у conv.api');
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'ок'}, {kind: 'done'}]; });
    await ask(page, 'далі');
    await idle(page, 9);
    assert.equal(await page.evaluate(() => window.__reqs[8].messages.length), 7, 'після збою/Стоп у запиті висить зайве питання');
    assert.equal(await page.evaluate(() => JSON.stringify(window.__hist) + JSON.stringify(Object.entries(localStorage))).then(t => t.includes(SECRET)), false, 'ключ в історії/localStorage');

    // видалення ключа
    await gear(page);
    await page.click('#advKeyClear');
    await page.waitForSelector('#modal:not([hidden])');
    await page.click('#modalYes');
    await page.waitForFunction(() => /не збережено/.test(document.getElementById('advKeyState').innerText));
    assert.equal(await page.evaluate(() => window.__keyClears), 1);
    await back(page);

    // нова розмова Claude Code: без історії попередньої
    await page.click('#advNew');
    await pickProv(page, 'Claude Code');
    assert.equal(await page.evaluate(() => document.getElementById('advBadge').textContent.trim()), 'хмара · назви приховано');
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'cc ок'}, {kind: 'done'}]; });
    await ask(page, 'нова');
    await idle(page, 10);
    const c1 = await page.evaluate(() => window.__reqs[9]);
    assert.equal(c1.__kind, 'cc'); assert.equal(c1.messages, undefined, 'cc: історія API потрапила в запит'); assert.equal(c1.session, undefined);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#advMsgs .advmsg').length), 2, 'нова розмова успадкувала повідомлення');
    assert.deepEqual(await page.evaluate(() => window.__hist.map(c => c.provider)), ['cc', 'api', 'local']);

    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }

  // ── десктоп: local без знеособлювача, типова інструкція, стара розмова без provider ──
  { const {ctx, page, errors} = await openDesktop(browser, {width: 1400, state: {privacyServices: {advisor: true}}});
    await fakeBridge(page, OK);
    await page.evaluate(() => { window.D0 = window.__DESK__;
      window.__DESK__.advisorHist = async () => [{id: 'old1', title: 'стара', created: 1, session: 's1',
        msgs: [{role: 'user', text: 'питання'}, {role: 'assistant', text: 'відповідь', model: ''}]}]; });
    await page.keyboard.press('7');
    await page.waitForSelector('#advIn', {state: 'visible'});
    await page.waitForSelector('[data-advopen="old1"]');
    await page.click('[data-advopen="old1"]');
    const old = await page.evaluate(() => ({badge: document.getElementById('advBadge').textContent.trim(),
      locked: document.getElementById('advProvW').hidden, tag: document.getElementById('advProvTag').textContent,
      cap: document.querySelector('#advMsgs .advmsg.bot').innerText}));
    assert.deepEqual([old.badge, old.locked, old.tag], ['хмара · назви приховано', true, 'Claude Code'], 'стара розмова не відкрилась як Claude Code: ' + JSON.stringify(old));
    // cc: типова інструкція з абзацом про псевдоніми
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'ок'}, {kind: 'done'}]; });
    await ask(page, 'ще');
    await idle(page, 1);
    assert.ok(await page.evaluate(() => /Клієнт AB3D/.test(window.__reqs[0].system)), 'cc: нема абзацу про псевдоніми');
    // api: теж
    await page.click('#advNew');
    await page.evaluate(() => { window.__keyHas = true; });
    await pickProv(page, 'API Anthropic');
    await page.waitForFunction(() => /: збережено/.test(document.getElementById('advKeyState').textContent));
    await ask(page, 'api');
    await idle(page, 2);
    assert.ok(await page.evaluate(() => /Клієнт AB3D/.test(window.__reqs[1].system)), 'api: нема абзацу про псевдоніми');
    // local без groshiPseudo
    await page.click('#advNew');
    await pickProv(page, 'Локальна модель');
    await page.waitForFunction(() => document.getElementById('advLocalModel').value === 'model-a');
    await page.evaluate(() => { delete window.groshiPseudo; });
    await ask(page, 'локально');
    await idle(page, 3);
    const lr = await page.evaluate(() => window.__reqs[2]);
    assert.equal(lr.__kind, 'local');
    assert.ok(!/псевдонім|Клієнт /i.test(lr.system), 'local: у system абзац про псевдоніми');
    assert.ok(lr.system.includes('Станом на'));
    assert.ok(await page.evaluate(() => document.querySelector('#advMsgs .advmsg.bot:last-child').innerText.includes('ок')), 'local без знеособлювача: відповідь не показано');
    // cc/api без знеособлювача — відмова
    await page.click('#advNew');
    await pickProv(page, 'Claude Code');
    await ask(page, 'cc без pseudo');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__reqs.length), 3, 'cc надіслано без знеособлювача');
    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }

  // ── десктоп: claude не знайдено ──
  { const {ctx, page, errors} = await openDesktop(browser, {width: 1400});
    await fakeBridge(page, {found: false, path: null, version: null, node: null});
    await page.keyboard.press('7');
    await page.waitForFunction(() => /Claude Code не знайдено|встановіть/i.test(document.getElementById('tab-advisor').innerText));
    assert.equal(await page.evaluate(() => document.getElementById('advIn').offsetParent === null), true, 'поле вводу видно без Claude Code');
    assert.equal(await page.evaluate(() => window.__reqs.length), 0);
    // без Claude Code локальна модель все одно доступна: шапка з перемикачем лишається
    await pickProv(page, 'Локальна модель');
    await page.waitForSelector('#advIn', {state: 'visible'});
    assert.equal(await page.evaluate(() => document.getElementById('advSetup').hidden), true, 'картку «не знайдено» видно для local');
    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }


  // ── десктоп: вхід у Claude Code, розділ «Порадник» у налаштуваннях, список моделей LM Studio ──
  { const {ctx, page, errors} = await openDesktop(browser, {width: 1400, state: {privacyServices: {advisor: true}}});
    await fakeBridge(page, OK);
    await page.keyboard.press('7');
    await page.waitForSelector('#advIn', {state: 'visible'});
    // прострочений вхід: кнопка під помилкою відкриває вхід, а не лишає людину без виходу
    await page.evaluate(() => { window.__script = () => [{kind: 'error', text: 'Failed to authenticate: OAuth session expired'}]; });
    await ask(page, 'питання');
    await idle(page, 1);
    const act = '#advMsgs .advmsg.bot [data-advact="login"]';
    await page.waitForSelector(act);
    assert.equal((await page.textContent(act)).trim(), 'Увійти в Claude Code');
    const hb = await page.evaluate(() => document.getElementById('advIn').getBoundingClientRect().y);
    await page.click(act);
    await page.waitForFunction(() => window.__ccLogins === 1);
    await page.waitForFunction(() => /Завершіть вхід у вікні, що відкрилось, і поставте питання ще раз/.test(document.getElementById('advMsgs').innerText));
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-advact]').length), 0, 'кнопка входу лишилась після натискання');
    assert.equal(await page.evaluate(() => document.getElementById('advIn').getBoundingClientRect().y), hb, 'поле вводу зсунулось після підказки');
    // звичайна помилка кнопки не має
    await page.click('#advNew');
    await page.evaluate(() => { window.__script = () => [{kind: 'error', text: 'Щось зламалось'}]; });
    await ask(page, 'ще'); await idle(page, 2);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-advact]').length), 0, 'кнопка під сторонньою помилкою');

    // шестерня → розділ «Порадник»
    await page.click('#advGear');
    await page.waitForSelector('#advSetLocal', {state: 'visible'});
    assert.equal(await page.evaluate(() => S.tab), 'settings');
    assert.equal(await page.evaluate(() => document.querySelector('#setSeg [data-sec="adv"]').getAttribute('aria-pressed')), 'true');
    const cards = await page.evaluate(() => ['advSetCloud', 'advSetCc', 'advSetLocal', 'advSetApi', 'advSetPrompt']
      .map(id => !document.getElementById(id).hidden));
    assert.deepEqual(cards, [true, true, true, true, true], 'не всі картки розділу видно');
    assert.equal(await page.evaluate(() => document.getElementById('advCloudState').textContent), 'Увімкнено');
    // та сама кнопка дозволу, що й у «Підключенні»: вимкнення міняє стан і рядок про вхід
    assert.equal(await page.evaluate(() => document.getElementById('advCloudBtn').classList.contains('pri')), false, '«Вимкнути» в акценті');
    await page.click('#advCloudBtn');
    await page.waitForFunction(() => document.getElementById('advCloudState').textContent === 'Вимкнено');
    assert.equal(await page.evaluate(() => privacyAllowed('advisor')), false);
    await page.waitForFunction(() => /не перевіряється/.test(document.getElementById('advCcState').textContent));
    await page.click('#advCloudBtn');
    await page.waitForFunction(() => document.getElementById('advCloudState').textContent === 'Увімкнено');
    // стан входу
    await page.waitForFunction(() => /Не увійдено/.test(document.getElementById('advCcState').textContent));
    assert.equal(await page.evaluate(() => document.getElementById('advCcLogin').hidden), false, 'нема кнопки «Увійти»');
    await page.click('#advCcLogin');
    await page.waitForFunction(() => window.__ccLogins === 2);
    await page.evaluate(() => { window.__ccAuth = {logged_in: true, method: 'claude.ai'}; });
    await page.click('#advCcCheck');
    await page.waitForFunction(() => /Увійдено \(claude\.ai\)/.test(document.getElementById('advCcState').textContent));
    assert.equal(await page.evaluate(() => document.getElementById('advCcLogin').hidden), true, '«Увійти» лишилась при виконаному вході');
    // помилка статусу: текст помилки, кнопки «Увійти» нема
    await page.evaluate(() => { window.__ccPrev = window.__DESK__.advisorCcAuth; window.__DESK__.advisorCcAuth = async () => { throw new Error('Claude Code не знайдено'); }; });
    await page.click('#advCcCheck');
    await page.waitForFunction(() => /Стан входу невідомий/.test(document.getElementById('advCcState').textContent));
    assert.equal(await page.evaluate(() => document.getElementById('advCcLogin').hidden), true, '«Увійти» при помилці статусу');
    assert.match(await page.evaluate(() => document.getElementById('advCcHint').textContent), /не знайдено/);
    await page.evaluate(() => { window.__DESK__.advisorCcAuth = window.__ccPrev; });
    await page.click('#advCcCheck');
    await page.waitForFunction(() => /Увійдено/.test(document.getElementById('advCcState').textContent));
    // випадайка моделей із lms (сервер вимкнено, але список є)
    await page.evaluate(() => { window.__lmsFail = false; store.set('advisorLocalModel', null); });
    await page.click('#advLocalRefresh');
    await page.waitForFunction(() => document.getElementById('advLocalModel').value === 'test-model-7b');
    const before = await page.evaluate(() => ['advSetLocal', 'advSetApi'].map(id => Math.round(document.getElementById(id).getBoundingClientRect().height)));
    await page.click('#advSetLocal .cselb');
    const labels = await page.$$eval('.cselm:not([hidden]) .cselo', b => b.map(x => x.textContent.trim()));
    assert.deepEqual(labels, ['Test Model 7B · 7B · 4,4 ГБ · інструменти', 'Plain Small · 0,9 ГБ']);
    await page.click('.cselm:not([hidden]) .cselo:has-text("Plain Small")');
    assert.equal(await page.evaluate(() => store.get('advisorLocalModel', null)), 'plain-small', 'вибір не збережено');
    await page.click('#advLocalRefresh');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.getElementById('advLocalModel').value), 'plain-small', 'оновлення списку скинуло вибір');
    assert.deepEqual(await page.evaluate(() => ['advSetLocal', 'advSetApi'].map(id => Math.round(document.getElementById(id).getBoundingClientRect().height))), before, 'картка стрибнула після оновлення списку');
    // порожній каталог і порожній сервер
    await page.evaluate(() => { window.__lmsModels = []; window.__lm = []; store.set('advisorLocalModel', null); });
    await page.click('#advLocalRefresh');
    await page.waitForFunction(() => /Моделей не знайдено — завантажте модель у LM Studio/.test(document.querySelector('#advSetLocal .cselb').textContent));
    // запуск сервера з налаштувань
    await page.click('#advLmsStart');
    await page.waitForFunction(() => window.__lmsStarts === 1);
    await back(page);

    // локальна розмова без сервера: кнопка запуску під помилкою
    await page.click('#advNew');
    await pickProv(page, 'Локальна модель');
    await page.evaluate(() => { store.set('advisorLocalModel', 'm'); window.__script = () => [{kind: 'error', text: 'Не вдалося зʼєднатися з локальним сервером'}]; });
    await ask(page, 'локально'); await idle(page, 3);
    const srv = '#advMsgs .advmsg.bot [data-advact="server"]';
    await page.waitForSelector(srv);
    assert.equal((await page.textContent(srv)).trim(), 'Запустити сервер LM Studio');
    await page.click(srv);
    await page.waitForFunction(() => window.__lmsStarts === 2);
    await page.waitForFunction(() => /Сервер запущено, поставте питання ще раз/.test(document.getElementById('advMsgs').innerText));
    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }

  // ── браузер: розділ «Порадник» лише з нотаткою ──
  { const ctx = await browser.newContext({viewport: {width: 1400, height: 900}});
    await ctx.addInitScript(() => localStorage.setItem('wizDone', 'true'));
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(path.join(root, '.test-artifacts', 'synthetic_app.html')).href);
    await page.waitForFunction(() => typeof window.go2set === 'function');
    await page.evaluate(() => go2set('adv'));
    await page.waitForSelector('#advSetNote', {state: 'visible'});
    assert.equal(await page.evaluate(() => document.getElementById('advSetLocal').offsetParent === null), true, 'у браузері видно картки Порадника');
    await ctx.close(); }

  console.log('Порадник: браузер, зведення = Огляд, NDA, XSS, error, потік, три способи, ключ API, картка «не знайдено» — OK');
} finally { await browser.close(); }
