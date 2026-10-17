// MCP розділено на бібліотеку інструментів (mcp/tools.js) і stdio-обгортку (mcp/groshi-mcp.js).
// Бібліотека не має читати stdin при імпорті: інакше апка, що підключає її всередині себе,
// зависне (процес не виходить, поки відкритий stdin). Дані — лише порожня тека-заглушка.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const empty = path.join(root, '.test-artifacts', 'mcp-empty');
fs.mkdirSync(empty, {recursive: true});
const env = {...process.env, GROSHI_DIR: empty};
const tools = path.join(root, 'mcp', 'tools.js');
const NAMES = ['groshi_status', 'transactions', 'fop_and_invoices'];

// 1) імпорт завершується сам. stdin дитини — відкритий pipe, який ми НЕ закриваємо:
// spawnSync із input закрив би його одразу, і слухач stdin на імпорті побачив би EOF та вийшов
// (регресія пройшла б непоміченою).
const child = spawn(process.execPath, ['-e',
  `const m=require(${JSON.stringify(tools)});` +
  `console.log(JSON.stringify({keys:Object.keys(m.T),exp:Object.keys(m),dir:m.DIR,st:typeof m.state,tx:typeof m.txAll}))`],
  {env, stdio: ['pipe', 'pipe', 'pipe']});
let so = '', se = '';
child.stdout.on('data', d => (so += d));
child.stderr.on('data', d => (se += d));
const exit = await new Promise(res => {
  const t = setTimeout(() => { child.kill(); res({hung: true}); }, 2000);
  child.on('exit', code => { clearTimeout(t); res({code}); });
});
assert.ok(!exit.hung, 'імпорт tools.js завис: процес не вийшов сам за 2 с (stdin відкритий)');
assert.equal(exit.code, 0, se);
const o = JSON.parse(so);
assert.equal(o.keys.length, 11, 'очікувано 11 інструментів, є ' + o.keys.length);
for (const n of NAMES) assert.ok(o.keys.includes(n), 'бракує ' + n);
assert.deepEqual(o.exp.sort(), ['DIR', 'T', 'state', 'txAll']);
assert.equal(o.tx, 'function');

// 2) stdio-обгортка: initialize → tools/list
const p = spawn(process.execPath, [path.join(root, 'mcp', 'groshi-mcp.js')], {env, stdio: ['pipe', 'pipe', 'inherit']});
let out = '';
p.stdout.on('data', d => (out += d));
p.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {}}) + '\n');
p.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}) + '\n');
await new Promise(res => { const t = setInterval(() => { if (out.split('\n').filter(Boolean).length >= 2) { clearInterval(t); res(); } }, 50); setTimeout(() => { clearInterval(t); res(); }, 3000); });
p.kill();
const msgs = out.trim().split('\n').filter(Boolean).map(JSON.parse);
const init = msgs.find(m => m.id === 1), list = msgs.find(m => m.id === 2);
assert.ok(init && init.result, 'initialize без відповіді');
assert.equal(list.result.tools.length, 11);

// 3) market: лише кеш на диску. Штучні теки; форми файлів — з quotes.rs / nbu.rs / main.rs (fx).
const runMarket = dir => {
  const r = spawnSync(process.execPath, ['-e',
    `const m=require(${JSON.stringify(tools)});process.stdout.write(m.T.market.run({}))`],
    {env: {...process.env, GROSHI_DIR: dir}, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const mk = (name, files) => {
  const d = path.join(root, '.test-artifacts', name);
  fs.rmSync(d, {recursive: true, force: true});
  fs.mkdirSync(d, {recursive: true});
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), JSON.stringify(v));
  return d;
};
const emptyOut = runMarket(mk('mcp-market-empty', {}));
assert.match(emptyOut, /немає/);
const ts = Date.UTC(2026, 9, 17, 12) / 1000;
const full = runMarket(mk('mcp-market-full', {
  'quotes.json': {fetched: ts, quotes: {AAPL: {price: 200, prev: 190}, MSFT: {price: 400, prev: 400}, ZZZ: {price: 1, prev: 2}}},
  'inv_cache.json': {data: {pos: [{symbol: 'AAPL', kind: 'stock', qty: 1, ccy: 'USD'}, {symbol: 'MSFT', kind: 'stock', qty: 1, ccy: 'USD'}], ivt: [], navh: [], fetched: {}}},
  'nbu_rates.json': {'USD:2026-10-16': 41.5, 'USD:2026-10-15': 41.4, 'EUR:2026-10-16': 48.2},
  'fx.json': {at: ts, rates: {USD: 41.6, EUR: 48.3}},
}));
const first = full.split('\n')[0];
assert.equal(first, 'Станом на 2026-10-16', first);   // найстарша: курс НБУ 16-го
assert.match(full, /AAPL.*\+5\.3%/);
assert.match(full, /MSFT/);
assert.doesNotMatch(full, /ZZZ/, 'папери поза портфелем не показуємо');
assert.match(full, /USD/); assert.match(full, /EUR/); assert.match(full, /41,5/);
const onlyFx = runMarket(mk('mcp-market-fx', {'fx.json': {at: ts, rates: {USD: 41.6}}}));
assert.match(onlyFx, /^Станом на 2026-10-17/); assert.doesNotMatch(onlyFx, /AAPL/);
const old = ts - 21 * 86400;
const stale = runMarket(mk('mcp-market-stale', {
  'quotes.json': {fetched: old, quotes: {AAPL: {price: 200, prev: 190}}},
  'inv_cache.json': {data: {pos: [{symbol: 'AAPL', kind: 'stock', qty: 1, ccy: 'USD'}], ivt: [], navh: [], fetched: {}}},
  'fx.json': {at: ts, rates: {USD: 41.6}},
}));
assert.equal(stale.split('\n')[0], 'Станом на 2026-09-26', stale);
assert.match(stale, /Ціни паперів портфеля станом на 2026-09-26/);
assert.match(stale, /банк 41,60 ₴ \(2026-10-17\)/);
console.log('mcp_tools: OK');
