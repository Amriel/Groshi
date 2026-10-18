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
    // Живий список моделей Claude Code (штучний): за замовчуванням успішний; __ccModelsFail — текст помилки.
    window.__ccModels = [
      {value: 'default', name: 'Default (recommended)', description: 'Test model X', efforts: ['low', 'medium', 'high', 'xhigh', 'max']},
      {value: 'sonnet', name: 'Sonnet', description: 'Fast', efforts: ['low', 'medium', 'high', 'xhigh', 'max']},
      {value: 'haiku', name: 'Haiku', description: 'Quick', efforts: []}];
    window.__ccModelsFail = ''; window.__ccModelCalls = 0;
    D.advisorCcModels = async () => {
      window.__ccModelCalls++;
      if (window.__ccModelsFail) throw new Error(window.__ccModelsFail);
      return JSON.parse(JSON.stringify(window.__ccModels));
    };
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
    assert.equal(a1.model, 'claude-opus-5-5', 'модель розмови має йти явно: її зафіксовано в розмові');
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

  // ── десктоп: живий список моделей, effort, лічильник лімітів ──
  { const hm = ms => `new Date(${ms}).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})`;
    const {ctx, page, errors} = await openDesktop(browser, {width: 1400, state: {privacyServices: {advisor: true},
      advisorModel: 'old-model', advisorEffort: 'high'}});
    await fakeBridge(page, OK);
    await page.keyboard.press('7');
    await page.waitForSelector('#advIn', {state: 'visible'});
    const modelCsel = '#advSetCc .csel:has(#advModel)';
    const effCsel = '#advCcEffortW .csel';
    const sel = async (csel, text) => {
      await page.click(csel + ' .cselb');
      await page.click(`.cselm:not([hidden]) .cselo:has-text("${text}")`);
    };

    await gear(page);
    // список підтягнувся при відкритті розділу; зниклу модель скинуто на типову з поясненням
    await page.waitForFunction(() => window.__ccModelCalls >= 1 && !!ADV.ccModels);
    assert.equal(await page.evaluate(() => document.getElementById('advModel').value), '', 'зникла модель не скинута');
    assert.equal(await page.evaluate(() => store.get('advisorModel', null)), null, 'зниклу модель не стерто зі сховища');
    assert.equal(await page.evaluate(() => document.getElementById('advModelHint').textContent), 'Модель «old-model» більше недоступна — вибрано типову');
    await page.click(modelCsel + ' .cselb');
    assert.deepEqual(await page.$$eval('.cselm:not([hidden]) .cselo', b => b.map(x => x.textContent.trim())),
      ['Default (recommended) — Test model X', 'Sonnet — Fast', 'Haiku — Quick']);
    await page.keyboard.press('Escape');
    // збережений effort 'high' підтримується типовою моделлю → лишився
    assert.equal(await page.evaluate(() => document.getElementById('advCcEffort').value), 'high');

    // кожне відкриття розділу питає список знову
    const calls = await page.evaluate(() => window.__ccModelCalls);
    await back(page); await gear(page);
    await page.waitForFunction(n => window.__ccModelCalls > n, calls);
    // але не плодить запити, поки попередній у польоті; кнопка перепитує завжди
    await page.waitForFunction(() => !ADV.ccLoading);
    await page.evaluate(() => { window.__ccGate = null; window.__ccPrevModels = window.__DESK__.advisorCcModels;
      window.__DESK__.advisorCcModels = () => { window.__ccModelCalls++; return new Promise(r => { window.__ccGate = r; }); }; });
    const c0 = await page.evaluate(() => window.__ccModelCalls);
    await back(page); await gear(page);
    await page.waitForFunction(() => !!window.__ccGate);
    await back(page); await gear(page);
    assert.equal(await page.evaluate(() => window.__ccModelCalls), c0 + 1, 'повторне відкриття розділу породило ще один запит');
    await page.evaluate(() => { window.__ccGate(JSON.parse(JSON.stringify(window.__ccModels))); window.__DESK__.advisorCcModels = window.__ccPrevModels; });
    await page.waitForFunction(() => !ADV.ccLoading);
    // «Оновити список» в одному рядку з випадайкою; порожня підказка не займає місця
    const lay = await page.evaluate(() => { const a = document.querySelector('#advSetCc .csel:has(#advModel)').getBoundingClientRect(), b = document.getElementById('advModelRefresh').getBoundingClientRect();
      return {sameRow: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 30, hint: getComputedStyle(document.getElementById('advModelHint')).display}; });
    assert.deepEqual(lay, {sameRow: true, hint: 'none'}, JSON.stringify(lay));

    // вибір Sonnet → рівні моделі; вибір рівня зберігається; Haiku ховає поле й скидає рівень
    await sel(modelCsel, 'Sonnet');
    assert.equal(await page.evaluate(() => store.get('advisorModel', null)), 'sonnet');
    assert.equal(await page.evaluate(() => document.getElementById('advModelHint').textContent), '', 'підказка лишилась після вибору');
    assert.equal(await page.evaluate(() => document.getElementById('advCcEffortW').hidden), false);
    await page.click(effCsel + ' .cselb');
    assert.deepEqual(await page.$$eval('.cselm:not([hidden]) .cselo', b => b.map(x => x.textContent.trim())),
      ['За замовчуванням', 'низький', 'середній', 'високий', 'дуже високий', 'максимальний']);
    await page.click('.cselm:not([hidden]) .cselo:has-text("максимальний")');
    assert.equal(await page.evaluate(() => store.get('advisorEffort', null)), 'max');
    await sel(modelCsel, 'Haiku');
    assert.equal(await page.evaluate(() => document.getElementById('advCcEffortW').hidden), true, 'Haiku: effort не сховано');
    assert.equal(await page.evaluate(() => store.get('advisorEffort', null)), null, 'effort Haiku не скинуто');
    await sel(modelCsel, 'Sonnet');
    await sel(effCsel, 'максимальний');

    // сервер: sonnet + max; Haiku без effort; «Default» без model
    await back(page);
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'Відповідь.'}, {kind: 'done'}]; });
    await ask(page, 'перше'); await idle(page, 1);
    let r = await page.evaluate(() => window.__reqs[0]);
    assert.equal(r.model, 'sonnet'); assert.equal(r.effort, 'max');
    assert.ok(await page.evaluate(() => /Claude Code · sonnet · effort: максимальний/.test(document.getElementById('advMsgs').innerText)), 'нема effort у підписі');
    await gear(page);
    await sel(modelCsel, 'Haiku');
    await back(page);
    await page.click('#advNew');
    await ask(page, 'друге'); await idle(page, 2);
    r = await page.evaluate(() => window.__reqs[1]);
    assert.equal(r.model, 'haiku'); assert.equal(r.effort, undefined, 'Haiku отримав effort');
    await gear(page);
    await sel(modelCsel, 'Default');
    await back(page);
    await page.click('#advNew');
    await ask(page, 'третє'); await idle(page, 3);
    r = await page.evaluate(() => window.__reqs[2]);
    assert.ok(!r.model, 'для «Default» model має бути порожнім: ' + r.model); assert.equal(r.effort, undefined);

    // помилка списку: текст помилки, поле лишається з поточним значенням
    await gear(page);
    await page.evaluate(() => { window.__ccModelsFail = 'Claude Code не відповів'; });
    await sel(modelCsel, 'Sonnet');
    await page.click('#advModelRefresh');
    await page.waitForFunction(() => document.getElementById('advModelHint').textContent === 'Claude Code не відповів');
    assert.equal(await page.evaluate(() => document.getElementById('advModel').value), 'sonnet', 'помилка списку скинула модель');
    assert.equal(await page.evaluate(() => document.getElementById('advModelRefresh').disabled), false);
    // Порадник у хмарі вимкнено
    await page.evaluate(() => { window.__ccModelsFail = ''; store.set('privacyServices', {advisor: false}); });
    await page.click('#advModelRefresh');
    await page.waitForFunction(() => document.getElementById('advModelHint').textContent === 'Увімкніть Порадника в хмарі, щоб побачити список');
    assert.equal(await page.evaluate(() => document.getElementById('advModel').value), 'sonnet');
    await page.evaluate(() => { store.set('privacyServices', {advisor: true}); });
    await page.click('#advModelRefresh');
    await page.waitForFunction(() => document.getElementById('advModelHint').textContent === '' && !!ADV.ccModels);
    // нова модель у списку просто з'являється
    await page.evaluate(() => { window.__ccModels.push({value: 'opus[1m]', name: 'Opus', description: 'Big', efforts: ['low', 'max']}); });
    await page.click('#advModelRefresh');
    await page.waitForFunction(() => ADV.ccModels.length === 4);
    await sel(modelCsel, 'Opus');
    assert.equal(await page.evaluate(() => store.get('advisorModel', null)), 'opus[1m]');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#advCcEffort option')].map(o => o.value)), ['', 'low', 'max']);
    await sel(modelCsel, 'Default');

    // API: effort за замовчуванням medium, вибір іде в запит і в підпис
    assert.equal(await page.evaluate(() => document.getElementById('advApiEffort').value), 'medium');
    await back(page);
    await page.click('#advNew');
    await pickProv(page, 'API Anthropic');
    await page.evaluate(() => { window.__keyHas = true; ADV.keyHas = true; window.__script = () => [{kind: 'text', text: 'API.'}, {kind: 'state', text: '[]'}, {kind: 'done'}]; });
    await ask(page, 'api-1'); await idle(page, 4);
    r = await page.evaluate(() => window.__reqs[3]);
    assert.equal(r.__kind, 'api'); assert.equal(r.effort, 'medium');
    assert.ok(await page.evaluate(() => /API · claude-opus-5-5 · effort: середній/.test(document.getElementById('advMsgs').innerText)));
    await gear(page);
    await sel('#advSetApi .csel', 'високий');
    assert.equal(await page.evaluate(() => store.get('advisorApiEffort', null)), 'high');
    await back(page);
    await page.click('#advNew');
    await pickProv(page, 'API Anthropic');
    await ask(page, 'api-2'); await idle(page, 5);
    assert.equal((await page.evaluate(() => window.__reqs[4])).effort, 'high');
    // локальна модель effort не передає
    await page.click('#advNew');
    await pickProv(page, 'Локальна модель');
    await page.evaluate(() => { store.set('advisorLocalModel', 'm'); window.__script = () => [{kind: 'text', text: 'Л.'}, {kind: 'done'}]; });
    await ask(page, 'loc'); await idle(page, 6);
    assert.equal((await page.evaluate(() => window.__reqs[5])).effort, undefined, 'локальна модель отримала effort');

    // ── токени, вартість і лічильник лімітів (Claude Code) ──
    await page.click('#advNew');
    await pickProv(page, 'Claude Code');
    const inH = Math.floor(Date.now() / 1000) + 3600, in3d = Math.floor(Date.now() / 1000) + 3 * 86400;
    const L = o => JSON.stringify(o);
    await page.evaluate(([a, b]) => { window.__script = () => [
      {kind: 'text', text: 'Готово.'},
      {kind: 'limits', text: JSON.stringify({type: 'five_hour', status: 'allowed', utilization: 0.42, resets_at: a})},
      {kind: 'limits', text: JSON.stringify({type: 'seven_day', status: 'allowed', utilization: 0.1, resets_at: b})},
      {kind: 'usage', text: JSON.stringify({input: 10000, output: 2400, cache_read: 25000, cache_write: 5000, cost_usd: 0.0421, turns: 2})},
      {kind: 'done'}]; }, [inH, in3d]);
    const limRect = () => page.evaluate(() => { const b = document.getElementById('advLim').getBoundingClientRect(); return [b.y, b.height]; });
    const inRect = async () => (await rects(page)).input;
    const lim0 = await limRect(), in0 = await inRect();
    await ask(page, 'ліміти'); await idle(page, 7);
    const cap = await page.evaluate(() => document.querySelector('#advMsgs .advmsg.bot:last-child .advcap').innerText);
    assert.match(cap, /≈ 12,4 тис\. токенів/); assert.match(cap, /кеш 30 тис\./); assert.match(cap, /\$0,04 за тарифом API/);
    assert.ok(await page.evaluate(() => /Скільки коштувала б відповідь за тарифом API; підписка платить фіксовано/.test(
      document.querySelector('#advMsgs .advmsg.bot:last-child .advcap [data-tip]').dataset.tip)), 'нема пояснення вартості');
    const limTxt = await page.evaluate(() => document.getElementById('advLim').innerText.replace(/\s+/g, ' ').trim());
    const wantH = await page.evaluate(`(${hm(inH * 1000)})`);
    assert.ok(limTxt.includes('5 год: 42% · до ' + wantH), limTxt);
    assert.match(limTxt, /7 днів: 10% · до \d{2}\.\d{2}/);
    assert.equal(await page.evaluate(() => store.get('advisorLimits', null).cc.five_hour.utilization), 0.42, 'ліміти не збережено');
    assert.deepEqual(await limRect(), lim0, 'рядок лімітів зсунувся');
    assert.deepEqual(await inRect(), in0, 'поле вводу зсунулось від лічильника');

    // попередження → чип з крапкою-попередженням; вичерпано → текст про вичерпаний ліміт
    await page.evaluate(a => { window.__script = () => [{kind: 'text', text: 'Х.'},
      {kind: 'limits', text: JSON.stringify({type: 'five_hour', status: 'allowed_warning', utilization: 0.91, resets_at: a})}, {kind: 'done'}]; }, inH);
    await page.click('#advNew'); await ask(page, 'warn'); await idle(page, 8);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#advLim .tag .dot.warn').length), 1, 'нема позначки попередження');
    assert.ok((await page.evaluate(() => document.getElementById('advLim').innerText)).includes('5 год: 91%'));
    await page.evaluate(a => { window.__script = () => [{kind: 'text', text: 'Х.'},
      {kind: 'limits', text: JSON.stringify({type: 'five_hour', status: 'rejected', utilization: 1, resets_at: a})}, {kind: 'done'}]; }, inH);
    await page.click('#advNew'); await ask(page, 'rej'); await idle(page, 9);
    const rejTxt = await page.evaluate(() => document.getElementById('advLim').innerText.replace(/\s+/g, ' ').trim());
    assert.ok(rejTxt.includes('Ліміт вичерпано до ' + wantH), rejTxt);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#advLim .tag.neg').length), 1);

    // API: токени й запити
    await page.click('#advNew');
    await pickProv(page, 'API Anthropic');
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'A.'},
      {kind: 'limits', text: JSON.stringify({type: 'api', tokens_remaining: 38000, tokens_limit: 40000, requests_remaining: 49, requests_limit: 50, resets_at: null})},
      {kind: 'usage', text: JSON.stringify({input: 800, output: 100, cache_read: 0, cache_write: 0})},
      {kind: 'state', text: '[]'}, {kind: 'done'}]; });
    await ask(page, 'api-lim'); await idle(page, 10);
    assert.equal(await page.evaluate(() => document.getElementById('advLim').innerText.replace(/\s+/g, ' ').trim()),
      'токенів лишилось 38 тис. з 40 тис. · запитів 49/50');
    const apiCap = await page.evaluate(() => document.querySelector('#advMsgs .advmsg.bot:last-child .advcap').innerText);
    assert.ok(apiCap.includes('≈ 900 токенів') && !apiCap.includes('$') && !apiCap.includes('кеш'), apiCap);
    // локальна розмова: лічильник порожній
    await page.click('#advNew'); await pickProv(page, 'Локальна модель');
    assert.equal(await page.evaluate(() => document.getElementById('advLim').childNodes.length), 0, 'лічильник у локальній розмові');
    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }

  // ── десктоп: збережені ліміти після «перезапуску» ──
  { const nowS = Math.floor(Date.now() / 1000);
    const {ctx, page, errors} = await openDesktop(browser, {width: 1400, state: {privacyServices: {advisor: true}, advisorLimits: {cc: {
      five_hour: {status: 'allowed', utilization: 0.9, resets_at: nowS - 600, at: Date.now() - 7200000},
      seven_day: {status: 'allowed', utilization: 0.33, resets_at: nowS + 2 * 86400, at: Date.now() - 3600000},
      // «вичерпано» без часу скидання: свіже показуємо, старше за добу — ні
      overage: {status: 'rejected', utilization: null, resets_at: null, at: Date.now() - 3600000},
      seven_day_opus: {status: 'rejected', utilization: null, resets_at: null, at: Date.now() - 25 * 3600000}}}}});
    await fakeBridge(page, OK);
    await page.keyboard.press('7');
    await page.waitForSelector('#advIn', {state: 'visible'});
    const txt = await page.evaluate(() => document.getElementById('advLim').innerText.replace(/\s+/g, ' ').trim());
    assert.ok(!txt.includes('5 год') && !txt.includes('90%'), 'показано відсоток із минулого вікна: ' + txt);
    assert.match(txt, /7 днів: 33% · до \d{2}\.\d{2} станом на \d{2}:\d{2}/);
    assert.ok(txt.includes('Ліміт понад план вичерпано') && !txt.includes('(понад ліміт)'), 'overage: ' + txt);
    assert.ok(!txt.includes('Opus'), 'добовий «вичерпано» без скидання не прибрано: ' + txt);
    // API: запис живе 10 хв від отримання, а не до resets_at (воно за секунди)
    const apiTxt = async at => page.evaluate(a => {
      store.set('advisorLimits', {api: {tokens_remaining: 100, tokens_limit: 200, requests_remaining: null, requests_limit: null, resets_at: Math.floor(Date.now() / 1000) - 5, at: Date.now() - a}});
      ADV.prov = 'api'; advProvUi(); return document.getElementById('advLim').innerText.replace(/\s+/g, ' ').trim();
    }, at);
    assert.ok((await apiTxt(5 * 60000)).startsWith('токенів лишилось 100 з 200'), 'API: свіжий запис сховано через resets_at');
    assert.equal(await apiTxt(11 * 60000), '', 'API: запис старший за 10 хв показано');
    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }

  // ── десктоп: швидкий вибір моделі й effort у вкладці ──
  { const {ctx, page, errors} = await openDesktop(browser, {width: 1400, state: {privacyServices: {advisor: true}}});
    await fakeBridge(page, Object.assign({}, OK, {version: '2.1.268', source: 'winget'}));
    await page.evaluate(() => { window.__upd = 0; window.__DESK__.advisorCcUpdate = async () => { window.__upd++; }; });
    await page.keyboard.press('7');
    await page.waitForSelector('#advIn', {state: 'visible'});
    await page.waitForFunction(() => !!ADV.ccModels && !ADV.ccLoading);   // список вантажиться з вкладки, без налаштувань
    const qModel = '.csel:has(#advQModel)', qEff = '.csel:has(#advQEffort)';
    const pick = async (csel, text) => {
      await page.click(csel + ' .cselb');
      await page.click(`.cselm:not([hidden]) .cselo:has-text("${text}")`);
    };
    const val = id => page.evaluate(i => document.getElementById(i).value, id);
    assert.equal(await page.isVisible(qModel), true, 'нема випадайки Модель у вкладці');
    assert.equal(await page.isVisible(qEff), true, 'нема випадайки Effort у вкладці');
    // короткі підписи: лише назва, повний опис у data-tip поля
    await page.click(qModel + ' .cselb');
    assert.deepEqual(await page.$$eval('.cselm:not([hidden]) .cselo', b => b.map(x => x.textContent.trim())),
      ['Default (recommended)', 'Sonnet', 'Haiku']);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('advQModel').parentNode.dataset.tip), 'Default (recommended) — Test model X');
    const badgeTip = await page.evaluate(() => document.getElementById('advBadge').dataset.tip);
    assert.ok(/Anthropic/.test(badgeTip) && /замінено псевдонімами/.test(badgeTip), 'бейдж без data-tip: ' + badgeTip);
    assert.equal(await page.evaluate(() => document.getElementById('advBadge').hasAttribute('title')), false);
    const r0 = await rects(page);
    const calls = await page.evaluate(() => window.__ccModelCalls);
    assert.equal(calls, 1, 'вкладка запустила більше одного запиту списку: ' + calls);

    // Sonnet у вкладці → те саме в налаштуваннях і в наступному запиті
    await pick(qModel, 'Sonnet');
    assert.equal(await page.evaluate(() => store.get('advisorModel', null)), 'sonnet');
    assert.equal(await val('advModel'), 'sonnet', 'налаштування не побачили вибір із вкладки');
    await pick(qEff, 'високий');
    assert.equal(await val('advCcEffort'), 'high');
    assert.deepEqual(await rects(page), r0, 'шапка чи поле вводу зсунулись від вибору');
    await page.evaluate(() => { window.__script = () => [{kind: 'text', text: 'Так.'}, {kind: 'done'}]; });
    await ask(page, 'перше'); await idle(page, 1);
    assert.equal(await page.evaluate(() => window.__reqs[0].model), 'sonnet');
    assert.equal(await page.evaluate(() => window.__reqs[0].effort), 'high');
    assert.ok((await page.evaluate(() => document.querySelector('#advMsgs .advmsg.bot .advcap').textContent)).includes('Claude Code · sonnet · effort: високий'));
    assert.deepEqual(await rects(page), r0, 'шапка чи поле вводу зсунулись від відповіді');
    // посеред розмови (Claude Code) модель і effort змінюються й діють на наступне питання; підпис першої відповіді не мінявся
    await pick(qModel, 'Haiku');
    assert.equal(await page.isVisible(qEff), false, 'Haiku: effort не сховано');
    await ask(page, 'друге'); await idle(page, 2);
    assert.equal(await page.evaluate(() => window.__reqs[1].model), 'haiku');
    assert.equal(await page.evaluate(() => 'effort' in window.__reqs[1]), false, 'effort пішов з Haiku');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#advMsgs .advcap')[0].textContent.startsWith('Claude Code · sonnet')), true, 'підпис старої відповіді змінився');
    // зміна в налаштуваннях видна у вкладці
    await gear(page);
    await page.evaluate(() => { document.getElementById('advModel').value = 'sonnet'; document.getElementById('advModel').dispatchEvent(new Event('change', {bubbles: true})); });
    await back(page);
    assert.equal(await page.evaluate(() => document.querySelector('.csel:has(#advQModel) .cselt').textContent), 'Sonnet');
    assert.equal(await page.isVisible(qEff), true);

    // локальна: список LM Studio, effort прихований, вибір пишеться в те саме сховище
    await page.evaluate(() => { window.__lmsFail = false; });
    await page.click('#advNew');
    await pickProv(page, 'Локальна модель');
    await page.waitForFunction(() => ADV.lmItems.length === 2 && ADV.lmItems[0].key === 'test-model-7b');
    assert.equal(await page.isVisible(qEff), false, 'local: effort видно');
    assert.equal(await val('advQModel'), await page.evaluate(() => store.get('advisorLocalModel', null)), 'вкладка показує не збережену локальну модель');
    await pick(qModel, 'Plain Small');
    assert.equal(await page.evaluate(() => store.get('advisorLocalModel', null)), 'plain-small');
    assert.equal(await val('advLocalModel'), 'plain-small');
    assert.ok((await page.evaluate(() => document.getElementById('advBadge').dataset.tip)).includes('цьому комп'));

    // API: модель з варіантів, effort є; після першого повідомлення модель — тег, effort змінюється
    await page.click('#advNew');
    await pickProv(page, 'API Anthropic');
    assert.equal(await page.isVisible(qEff), true);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#advQModel option')].map(o => o.value)),
      ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    await pick(qModel, 'claude-sonnet-5-5');
    assert.equal(await page.evaluate(() => store.get('advisorApiModel', null)), 'claude-sonnet-5-5');
    assert.equal(await page.evaluate(() => document.getElementById('advApiModel').value), 'claude-sonnet-5-5');
    await page.evaluate(() => { window.__keyHas = true; ADV.keyHas = true; window.__script = () => [{kind: 'text', text: 'А.'}, {kind: 'state', text: '[]'}, {kind: 'done'}]; });
    await ask(page, 'api'); await idle(page, 3);
    assert.equal(await page.evaluate(() => window.__reqs[2].model), 'claude-sonnet-5-5');
    assert.equal(await page.isVisible(qModel), false, 'API-розмова: модель не заблоковано');
    assert.equal(await page.evaluate(() => document.getElementById('advQModelTag').textContent), 'claude-sonnet-5-5');
    assert.ok(await page.evaluate(() => !!document.getElementById('advQModelTag').dataset.tip));
    await pick(qEff, 'низький');
    assert.equal(await page.evaluate(() => store.get('advisorApiEffort', null)), 'low');
    await ask(page, 'api2'); await idle(page, 4);
    assert.equal(await page.evaluate(() => window.__reqs[3].effort), 'low');
    assert.equal(await page.evaluate(() => window.__reqs[3].model), 'claude-sonnet-5-5');
    assert.ok((await page.evaluate(() => document.querySelector('#advMsgs .advmsg.bot:last-child .advcap').textContent)).includes('API · claude-sonnet-5-5 · effort: низький'));
    // модель розмови зашита в ній: зміна в налаштуваннях діє лише на нову розмову
    assert.equal(await page.evaluate(() => advConv().model), 'claude-sonnet-5-5');
    await page.evaluate(() => { store.set('advisorApiModel', 'claude-haiku-5-5'); advQuickUi(); });
    assert.equal(await page.evaluate(() => document.getElementById('advQModelTag').dataset.tip), 'Модель зафіксовано для цієї розмови');
    assert.equal(await page.evaluate(() => document.getElementById('advQModelTag').textContent), 'claude-sonnet-5-5');
    await ask(page, 'api3'); await idle(page, 5);
    assert.equal(await page.evaluate(() => window.__reqs[4].model), 'claude-sonnet-5-5', 'стара API-розмова взяла нову модель з налаштувань');
    await page.click('#advNew');
    await ask(page, 'api4'); await idle(page, 6);
    assert.equal(await page.evaluate(() => window.__reqs[5].model), 'claude-haiku-5-5', 'нова розмова не взяла збережену модель');

    // налаштування: версія з джерелом, кнопка оновлення викликає міст і показує підказку
    await gear(page);
    assert.ok((await page.evaluate(() => document.getElementById('advVer').textContent)).startsWith('Claude Code 2.1.268 (WinGet)'));
    assert.equal(await page.isVisible('#advCcUpdate'), true);
    await page.click('#advCcUpdate');
    await page.waitForFunction(() => window.__upd === 1);
    await page.waitForFunction(() => /Завершіть оновлення у вікні, що відкрилось, потім натисніть «Оновити список»/.test(document.getElementById('advUpdHint').textContent));
    // «Оновити список» перечитує джерело: копія Claude Desktop — без кнопки
    await page.evaluate(() => { window.__DESK__.advisorProbe = async () => ({found: true, version: '2.1.299', source: 'desktop', node: true}); });
    await page.click('#advModelRefresh');
    await page.waitForFunction(() => document.getElementById('advVer').textContent.includes('(Claude Desktop)'));
    assert.equal(await page.isVisible('#advCcUpdate'), false, 'для копії Claude Desktop є кнопка оновлення');
    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }

  // ── десктоп: автооновлення Claude Code ──
  { const boot = async (state, probe) => {
      const o = await openDesktop(browser, {width: 1400, state: Object.assign({privacyServices: {advisor: true}}, state)});
      await fakeBridge(o.page, probe);
      await o.page.evaluate(() => { window.__au = 0; window.__probes = 0; window.__auGate = null;
        const pr = window.__DESK__.advisorProbe;
        window.__DESK__.advisorProbe = async () => { window.__probes++; return pr(); };
        window.__DESK__.advisorCcAutoUpdate = () => { window.__au++;
          return new Promise(r => { window.__auGate = r; }); }; });
      return o;
    };
    const W = Object.assign({}, OK, {version: '2.1.268', source: 'winget'});
    // увімкнено: одна спроба, Send вимкнено з підказкою, тост про оновлення, повторно за добу не питає
    { const {ctx, page, errors} = await boot({}, W);
      await page.keyboard.press('7');
      await page.waitForSelector('#advIn', {state: 'visible'});
      await page.waitForFunction(() => window.__au === 1);
      assert.equal(await page.evaluate(() => document.getElementById('advSend').disabled), true, 'Send не вимкнено під час оновлення');
      assert.equal(await page.evaluate(() => document.getElementById('advSend').parentNode.dataset.tip), 'Оновлюю Claude Code…');
      assert.equal(await page.evaluate(() => typeof store.get('advisorCcAutoUpdAt', 0) === 'number' && store.get('advisorCcAutoUpdAt', 0) > 0), true, 'мітку спроби не записано до завершення');
      const probes0 = await page.evaluate(() => window.__probes), models0 = await page.evaluate(() => window.__ccModelCalls);
      await page.evaluate(() => { ADV.probe = Object.assign({}, ADV.probe, {upd_source: 'winget', upd_version: '2.1.268'}); advVerUi(); });
      assert.equal(await page.evaluate(() => document.getElementById('advCcUpdate').disabled), true, 'ручна кнопка активна під час автооновлення');
      await page.evaluate(() => window.__auGate({updated: true, from: '2.1.268', to: '2.1.302'}));
      await page.waitForFunction(() => !document.getElementById('advSend').disabled);
      assert.ok((await page.evaluate(() => document.body.innerText)).includes('Claude Code оновлено: 2.1.268 → 2.1.302'), 'нема тосту');
      await page.waitForFunction(p => window.__probes > p, probes0);
      await page.waitForFunction(m => window.__ccModelCalls > m, models0);
      await page.evaluate(() => { go('settings'); go2set('adv'); });
      await page.evaluate(() => { go('advisor'); });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.__au), 1, 'повторна спроба раніше ніж за 24 год');
      await page.evaluate(() => go2set('adv'));
      await page.waitForSelector('#advSetCc', {state: 'visible'});
      assert.equal(await page.isVisible('#advAutoUpdW'), true);
      assert.match(await page.evaluate(() => document.getElementById('advAutoUpdSt').textContent), /^Остання перевірка оновлень: \d{2}\.\d{2} \d{2}:\d{2}$/);
      assert.equal(await page.evaluate(() => document.getElementById('advAutoUpd').checked), true);
      assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
      await ctx.close(); }
    // помилка: текст у картці, без тосту
    { const {ctx, page, errors} = await boot({}, W);
      await page.evaluate(() => { window.__DESK__.advisorCcAutoUpdate = async () => { window.__au++; throw new Error('Не вдалося оновити Claude Code (код 1)'); }; });
      await page.keyboard.press('7');
      await page.waitForSelector('#advIn', {state: 'visible'});
      await page.waitForFunction(() => window.__au === 1 && !ADV.auRun);
      await page.evaluate(() => go2set('adv'));
      await page.waitForSelector('#advSetCc', {state: 'visible'});
      assert.equal(await page.evaluate(() => document.getElementById('advAutoUpdSt').textContent), 'Не вдалося оновити Claude Code (код 1)');
      assert.equal(await page.evaluate(() => document.getElementById('advSend').disabled), false);
      assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
      await ctx.close(); }
    // вимкнений перемикач: жодного виклику
    { const {ctx, page, errors} = await boot({advisorCcAutoUpd: false}, W);
      await page.keyboard.press('7');
      await page.waitForSelector('#advIn', {state: 'visible'});
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => window.__au), 0, 'виклик попри вимкнений перемикач');
      await page.evaluate(() => go2set('adv'));
      await page.waitForSelector('#advSetCc', {state: 'visible'});
      assert.equal(await page.evaluate(() => document.getElementById('advAutoUpd').checked), false);
      assert.equal(await page.evaluate(() => window.__au), 0);
      await ctx.close(); }
    // свіжа мітка (< 24 год): виклику немає
    { const {ctx, page} = await boot({advisorCcAutoUpdAt: Date.now() - 3600000}, W);
      await page.keyboard.press('7');
      await page.waitForSelector('#advIn', {state: 'visible'});
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => window.__au), 0, 'виклик раніше ніж за 24 год');
      await ctx.close(); }
    // годинник відвели назад: мітка з майбутнього застаріла
    { const {ctx, page} = await boot({advisorCcAutoUpdAt: Date.now() + 5 * 86400000}, W);
      await page.keyboard.press('7');
      await page.waitForSelector('#advIn', {state: 'visible'});
      await page.waitForFunction(() => window.__au === 1);
      await ctx.close(); }
    // реальний випадок: запускається Claude Desktop 2.1.299, а оновлювана WinGet-копія 2.1.268
    { const {ctx, page} = await boot({}, Object.assign({}, OK, {version: '2.1.299', source: 'desktop', upd_source: 'winget', upd_version: '2.1.268'}));
      await page.keyboard.press('7');
      await page.waitForSelector('#advIn', {state: 'visible'});
      await page.waitForFunction(() => window.__au === 1);
      await page.evaluate(() => go2set('adv'));
      await page.waitForSelector('#advSetCc', {state: 'visible'});
      assert.ok((await page.evaluate(() => document.getElementById('advVer').textContent)).startsWith('Використовується 2.1.299 (Claude Desktop) · WinGet 2.1.268'));
      assert.equal(await page.isVisible('#advCcUpdate'), true, 'нема кнопки оновлення WinGet-копії');
      assert.equal(await page.isVisible('#advAutoUpdW'), true);
      await ctx.close(); }
    // копія Claude Desktop: ні виклику, ні перемикача
    { const {ctx, page} = await boot({}, Object.assign({}, OK, {version: '2.1.299', source: 'desktop'}));
      await page.keyboard.press('7');
      await page.waitForSelector('#advIn', {state: 'visible'});
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => window.__au), 0, 'оновлюємо копію Claude Desktop');
      await page.evaluate(() => go2set('adv'));
      await page.waitForSelector('#advSetCc', {state: 'visible'});
      assert.equal(await page.isVisible('#advAutoUpdW'), false, 'перемикач для копії Claude Desktop');
      await ctx.close(); }
  }

  // ── десктоп 390 px: швидкі поля не дають горизонтальної прокрутки ──
  { const {ctx, page, errors} = await openDesktop(browser, {width: 390, height: 800, state: {privacyServices: {advisor: true}}});
    await fakeBridge(page, OK);
    await page.evaluate(() => go('advisor'));
    await page.waitForSelector('#advIn', {state: 'visible'});
    await page.waitForFunction(() => !!ADV.ccModels);
    const of = () => page.evaluate(() => ({sw: document.documentElement.scrollWidth, iw: innerWidth,
      out: [...document.querySelectorAll('.advmode > *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > innerWidth).length}));
    let o = await of(); assert.ok(o.sw <= o.iw && o.out === 0, 'cc: переповнення ' + JSON.stringify(o));
    await page.evaluate(() => { ADV.prov = 'api'; advProvUi(); });
    o = await of(); assert.ok(o.sw <= o.iw && o.out === 0, 'api: переповнення ' + JSON.stringify(o));
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
