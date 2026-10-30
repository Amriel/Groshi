// MCP читає знімок апки (advice_cache.json) замість власних підрахунків.
// Досі MCP мав свою копію «що вважати витратою» — без правил апки,
// виключень і повернень — і показував за серпень 1,49 млн проти 601 тис.
// у зведенні. Сторожимо:
//  · money_flow, transactions, spending_by_category, subscriptions і
//    groshi_status беруть цифри зі знімка;
//  · застарілий знімок і його відсутність — з попередженням; без знімка
//    перекази між своїми рахунками не рахуються витратами;
//  · у режимі GROSHI_PSEUDO назва клієнта в примітці прихована;
//  · у mcp/ немає коду запису.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, '.test-artifacts', 'mcp-snap');
fs.rmSync(base, {recursive: true, force: true});

const iso = d => d.toISOString().slice(0, 10);
const now = new Date();
const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10, 12));
const ym = iso(prev).slice(0, 7);
const sec = d => Math.floor(d.getTime() / 1000);
const OWN = 'UA' + '7'.repeat(27);

// Сира виписка Monobank: покупка, переказ людині, переказ на власний рахунок.
const raw = {
  synced: sec(new Date(now.getTime() - 3600e3)),
  accounts: [{id: 'a1', title: 'Чорна картка', type: 'black', currency: 980, balance: 100000, iban: 'UA' + '1'.repeat(27)},
             {id: 'a2', title: 'ФОП', type: 'fop', currency: 980, balance: 0, iban: OWN}],
  items: {a1: [
    {id: 'm1', time: sec(prev), amount: -50000, operationAmount: -50000, currencyCode: 980, description: 'Сільпо', mcc: 5411, balance: 100000},
    {id: 'm2', time: sec(prev) + 60, amount: -250000, operationAmount: -250000, currencyCode: 980, description: 'Олена П.', mcc: 4829, balance: 90000},
    {id: 'm3', time: sec(prev) + 120, amount: -1000000, operationAmount: -1000000, currencyCode: 980, description: 'На ФОП', mcc: 4829, counterIban: OWN, balance: 80000},
  ]},
};
const state = {clientsDB: {'ТОВ "Альфа Груп"': {name: 'ТОВ "Альфа Груп"', reg: '12345678'}}};
const snap = (today) => ({
  v: 1, built: new Date().toISOString(), today, app: 'test', moveMode: 'count', dmax: iso(now), base: 'UAH',
  months: [{ym, full: true, exp: 3000, inc: 0, moves: 10000, invest: 8000, people: 2500, cash: 700}],
  cats: [
    {k: 'Перекази', byM: {[ym]: 2500}, n: 1, med: 2500, min: 2500, max: 2500,
     top: [{date: iso(prev), amt: 2500, merchant: 'Олена П.'}], subs: [{k: 'Людям', byM: {[ym]: 2500}, n: 1, med: 2500, min: 2500, max: 2500}], tot: 2500},
    {k: 'Продукти', byM: {[ym]: 500}, n: 1, med: 500, min: 500, max: 500,
     top: [{date: iso(prev), amt: 500, merchant: 'Сільпо'}], subs: [{k: 'Супермаркети', byM: {[ym]: 500}, n: 1, med: 500, min: 500, max: 500}], tot: 500},
  ],
  tags: {debt: {[ym]: 2500}},
  subs: [
    {name: 'Хмарка', amount: 300, famt: null, ccy: 'UAH', period: 'month', last: iso(prev), next: '2099-01-10', live: true, perMonth: 300},
    {name: 'Стара', amount: 999, famt: null, ccy: 'UAH', period: 'month', last: '2020-01-01', next: '2020-02-01', live: false, perMonth: 999},
  ],
  tx: {
    m1: {c: 'Продукти', s: 'Супермаркети', k: 'spend', a: 500},
    m2: {c: 'Перекази', s: 'Людям', k: 'spend', a: 2500, tag: 'debt', note: 'позичила, поверне ТОВ "Альфа Груп"'},
    m3: {c: 'Між рахунками', s: 'Свої рахунки', k: 'move', a: 0},
    man_1: {c: 'Готівка', s: 'Банкомат', k: 'spend', a: 700,
      raw: {date: iso(prev), dir: 'expense', amount: 700, merchant: 'Готівка на ремонт', account: 'Вручну'}},
  },
});
const mk = (name, s) => {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'mono_raw.json'), JSON.stringify(raw));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  if (s) fs.writeFileSync(path.join(dir, 'advice_cache.json'), JSON.stringify(s));
  return dir;
};
const fresh = mk('fresh', snap(iso(now)));
const stale = mk('stale', snap(iso(new Date(now.getTime() - 2 * 864e5))));
const none = mk('none', null);

const call = async (dir, name, args = {}, pseudo = false) => {
  const env = {...process.env, GROSHI_DIR: dir};
  if (pseudo) env.GROSHI_PSEUDO = '1'; else delete env.GROSHI_PSEUDO;
  const p = spawn(process.execPath, [path.join(root, 'mcp', 'groshi-mcp.js')], {env, stdio: ['pipe', 'pipe', 'inherit']});
  let out = '';
  p.stdout.on('data', x => (out += x));
  p.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}) + '\n');
  await new Promise(res => { const t = setInterval(() => { if (out.includes('\n')) { clearInterval(t); res(); } }, 50); setTimeout(() => { clearInterval(t); res(); }, 4000); });
  p.kill();
  const r = JSON.parse(out.trim().split('\n')[0]).result;
  return r.content[0].text.replace(/[  ]/g, ' ');   // uk-UA ставить нерозривні пробіли
};
const has = (text, s, what) => assert.ok(text.includes(s), `${what}: нема «${s}» у\n${text}`);
const hasnt = (text, s, what) => assert.ok(!text.includes(s), `${what}: зайве «${s}» у\n${text}`);

// money_flow — зі знімка, з окремими рядками руху й інвестицій
const mf = await call(fresh, 'money_flow');
has(mf, `${ym}: +0 / −3 000`, 'money_flow: витрати місяця зі знімка');
has(mf, 'між рахунками', 'money_flow'); has(mf, 'відкладено в інвестиції', 'money_flow');
hasnt(mf, '⚠', 'money_flow свіжий знімок');

// transactions — фільтри категорії, мітки; мітка й примітка в рядку; операція не з Monobank
const tc = await call(fresh, 'transactions', {category: 'перекази'});
has(tc, 'Знайдено 1 ', 'transactions category'); has(tc, 'Олена П.', 'transactions category');
has(tc, 'борг', 'мітка в рядку'); has(tc, 'позичила', 'примітка в рядку');
const tt = await call(fresh, 'transactions', {tag: 'debt'});
has(tt, 'Знайдено 1 ', 'transactions tag');
const ts = await call(fresh, 'transactions', {category: 'Продукти', sub: 'супермаркети'});
has(ts, 'Знайдено 1 ', 'transactions sub'); has(ts, 'Сільпо', 'transactions sub');
const tm = await call(fresh, 'transactions', {query: 'ремонт'});
has(tm, 'Знайдено 1 ', 'ручна операція зі знімка'); has(tm, 'Готівка', 'ручна операція: категорія');

// spending_by_category — таблиця з ознаками; з category — підкатегорії
const sc = await call(fresh, 'spending_by_category');
has(sc, 'Перекази', 'spending_by_category'); has(sc, 'медіана', 'spending_by_category');
has(sc, 'Сільпо', 'spending_by_category: найбільші операції');
const scs = await call(fresh, 'spending_by_category', {category: 'Продукти'});
has(scs, 'Супермаркети', 'spending_by_category з category'); hasnt(scs, 'Людям', 'spending_by_category з category');

// subscriptions — активні окремо від зупинених, сума лише з активних, наступне списання
const su = await call(fresh, 'subscriptions');
has(su, 'Хмарка', 'subscriptions'); has(su, 'наступне 2099-01-10', 'subscriptions: дата наступного');
has(su, 'Разом: 300 ₴/міс', 'subscriptions: лише активні'); has(su, 'ЗУПИНЕНІ', 'subscriptions: зупинені окремо');

// groshi_status — вік знімка
has(await call(fresh, 'groshi_status'), 'Знімок апки:', 'groshi_status');

// застарілий знімок — попередження
has(await call(stale, 'money_flow'), '⚠ Знімок апки застарів', 'застарілий знімок');

// без знімка: попередження, перекази собі поза витратами, категорія з t.cat
const mf0 = await call(none, 'money_flow');
has(mf0, '⚠ Знімка апки немає', 'без знімка');
has(mf0, `${ym}: +0 / −3 000`, 'без знімка перекази собі не витрати');
has(await call(none, 'transactions', {query: 'Сільпо'}), 'Продукти', 'без знімка категорія з t.cat');

// GROSHI_PSEUDO: назва клієнта в примітці прихована
const tp = await call(fresh, 'transactions', {category: 'Перекази'}, true);
has(tp, 'позичила', 'pseudo: примітка є'); hasnt(tp, 'Альфа', 'pseudo: клієнт прихований');

// у MCP немає коду запису
for (const f of fs.readdirSync(path.join(root, 'mcp')).filter(f => f.endsWith('.js')))
  assert.ok(!/\b(writeFile|appendFile|createWriteStream)/.test(fs.readFileSync(path.join(root, 'mcp', f), 'utf8')), `запис у mcp/${f}`);

console.log('mcp_snapshot: знімок, фільтри, категорії, підписки, свіжість, знеособлення — OK');
