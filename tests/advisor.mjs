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
//  · немає claude/node → картка з кроками, поле вводу сховане.
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
    D.advisorAsk = async req => {
      window.__reqs.push(req);
      const evs = window.__script(req);
      (async () => {
        for (const ev of evs) {
          await new Promise(r => setTimeout(r, ev.wait || 15));
          emit({conv: req.conv, kind: ev.kind, text: ev.text || ''});
        }
      })();
    };
  }, probe);
}
const OK = {found: true, path: 'claude', version: '2.0.0', node: 'v22.0.0'};
const rects = page => page.evaluate(() => {
  const r = id => { const b = document.querySelector(id).getBoundingClientRect();
    return [b.x, b.y, b.width, b.height].map(v => Math.round(v * 10) / 10); };
  return {head: r('#tab-advisor .advhead'), input: r('#advIn')};
});
const idle = (page, n) => page.waitForFunction(k => window.__reqs.length >= k && document.getElementById('advStop').hidden, n, {timeout: 8000});
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
  { const {ctx, page, errors} = await openDesktop(browser, {width: 1400, state: {clientsDB: {[CLIENT]: {name: CLIENT, reg: '12345678'}}}});
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

  // ── десктоп: claude не знайдено ──
  { const {ctx, page, errors} = await openDesktop(browser, {width: 1400});
    await fakeBridge(page, {found: false, path: null, version: null, node: null});
    await page.keyboard.press('7');
    await page.waitForFunction(() => /Claude Code не знайдено|встановіть/i.test(document.getElementById('tab-advisor').innerText));
    assert.equal(await page.evaluate(() => document.getElementById('advIn').offsetParent === null), true, 'поле вводу видно без Claude Code');
    assert.equal(await page.evaluate(() => window.__reqs.length), 0);
    assert.deepEqual(errors, [], 'помилки: ' + errors.join(' | '));
    await ctx.close(); }

  console.log('Порадник: браузер, зведення = Огляд, NDA, XSS, error, потік, картка «не знайдено» — OK');
} finally { await browser.close(); }
