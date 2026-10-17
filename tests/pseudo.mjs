// Знеособлювач mcp/pseudo.js: NDA-імена (клієнти, проєкти, номери рахунків, платники ФОП) не мають
// потрапляти в хмарну модель, а у відповіді відновлюються. Лише штучні дані.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = createRequire(import.meta.url)(path.join(root, 'mcp', 'pseudo.js'));

const state = {
  clientsDB: {'ТОВ "Альфа Груп"': {name: 'ТОВ "Альфа Груп"', reg: '12345678', iban: 'UA' + '1'.repeat(27)},
              'Альфа': {name: 'Альфа'}},
  projects: [{client: 'ТОВ "Альфа Груп"', name: 'Ребрендинг Омега'}, {client: 'Клієнт', name: 'Новий проєкт'}],
  invcLog: [{no: 'INV-2026-007', client: 'ТОВ "Альфа Груп"', total: 1200}],
  fopCfg: null
};
const tx = [
  {id: 1, dir: 'income', account: 'Чорна', acctype: 'fop', merchant: 'ALFA GROUP LLC', counterName: 'ALFA GROUP LLC', category: 'Дохід'},
  {id: 2, dir: 'income', account: 'Чорна', acctype: 'fop', merchant: 'Себе Власник', category: 'Між рахунками'},
  {id: 3, dir: 'income', account: 'Біла', acctype: 'white', merchant: 'Петро', counterName: 'Петро'},
  {id: 4, dir: 'expense', account: 'Чорна', acctype: 'fop', merchant: 'Кава Лавка'}
];
const d = P.buildDict(state, tx);

const s = P.hide('Рахунок INV-2026-007 для ТОВ «Альфа Груп» по проєкту Ребрендинг Омега: 1200 USD', d);
for (const w of ['Альфа', 'Омега', 'INV-2026-007']) assert.ok(!s.includes(w), w + ' протік: ' + s);
assert.ok(s.includes('1200 USD'));
assert.equal(P.hide('альфа груп', d), P.hide('Альфа Груп', d));
assert.equal(P.hide('Альфабанк', d), 'Альфабанк');
assert.ok(!P.hide('ALFA GROUP LLC +50000', d).includes('ALFA'));
assert.equal(P.hide('Переказ Петро 2000', d), 'Переказ Петро 2000');
assert.equal(P.hide('Себе Власник Кава Лавка', d), 'Себе Власник Кава Лавка', 'власні перекази й витрати не платники');
assert.ok(!P.hide('UA' + '1'.repeat(27) + ' 12345678', d).match(/UA1|12345678/));
assert.equal(P.hide('Клієнт Новий проєкт', d), 'Клієнт Новий проєкт', 'службові назви не ховаємо');
const back = P.reveal(P.hide('Проєкт Ребрендинг Омега для ТОВ "Альфа Груп"', d), d);
assert.ok(back.includes('Ребрендинг Омега') && back.includes('Альфа Груп') && !/Клієнт [A-Z0-9]{6}/.test(back), back);
assert.equal(P.alias('client', 'ТОВ "Альфа Груп"'), P.alias('client', 'альфа груп'));
assert.match(P.alias('project', 'x1'), /^Проєкт [A-Z2-9]{6}$/);
// пари від довшого до коротшого
for (let i = 1; i < d.pairs.length; i++) assert.ok(d.pairs[i - 1][0].length >= d.pairs[i][0].length);
// рахунки ФОП за fopCfg.accs: лише перелічені
const d2 = P.buildDict({fopCfg: {accs: ['Біла']}}, tx);
assert.ok(d2.pairs.some(p => p[0] === 'Петро') && !d2.pairs.some(p => /ALFA/.test(p[0])));

// Числові id: № + 1200 ховаємо лише після маркера; суми й дати цілі
const dn = P.buildDict({invcLog: [{no: '1200', client: 'Тест Клієнт Один'}, {no: '2026'}], clientsDB: {'Тест Клієнт Один': {name: 'Тест Клієнт Один', reg: '12345678'}}}, []);
const hn = P.hide('Рахунок №1200 на 1200 USD від 2026-03-01, ЄДРПОУ 12345678, ФОП 2026: # 2026', dn);
assert.ok(!hn.includes('№1200') && /№Реквізит [A-Z2-9]{6} на 1200 USD від 2026-03-01/.test(hn), hn);
assert.ok(!hn.includes('12345678') && hn.includes('ФОП 2026:'), hn);
assert.ok(!/# 2026/.test(hn), 'після # номер ховається: ' + hn);
// Закрита відмова: збіг без запису в мапі (ſ ≠ s після toLowerCase) -> заглушка, не справжнє ім'я
const rp = P._replacer([['Strasse Group', 'X']], () => '[приховано]');
assert.equal(rp('ſtrasse group'), '[приховано]');
assert.equal(rp('Strasse Group'), 'X');
// Аргументи: псевдонім у фільтрі розкривається до справжнього імені
const al = P.alias('client', 'ТОВ "Альфа Груп"');
assert.deepEqual(P.revealArgs({query: al, n: 3, list: [al, {x: al}]}, d),
  {query: 'ТОВ "Альфа Груп"', n: 3, list: ['ТОВ "Альфа Груп"', {x: 'ТОВ "Альфа Груп"'}]});

// Інтеграція: groshi-mcp.js з GROSHI_PSEUDO=1 не віддає імена
const dir = path.join(root, '.test-artifacts', 'pseudo-dir');
fs.mkdirSync(dir, {recursive: true});
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
fs.writeFileSync(path.join(dir, 'mono_raw.json'), JSON.stringify({
  accounts: [{id: 'a1', title: 'ФОП чорна', kind: 'fop', currency: 980}],
  items: {a1: [{id: 't1', time: 1772000000, amount: 500000, description: 'Оплата', counterName: 'ТОВ "Альфа Груп"'}]}}));
const run = async (pseudo, name = 'fop_and_invoices', args = {}) => {
  const env = {...process.env, GROSHI_DIR: dir};
  if (pseudo) env.GROSHI_PSEUDO = '1'; else delete env.GROSHI_PSEUDO;
  const p = spawn(process.execPath, [path.join(root, 'mcp', 'groshi-mcp.js')], {env, stdio: ['pipe', 'pipe', 'inherit']});
  let out = '';
  p.stdout.on('data', x => (out += x));
  p.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}) + '\n');
  await new Promise(res => { const t = setInterval(() => { if (out.includes('\n')) { clearInterval(t); res(); } }, 50); setTimeout(() => { clearInterval(t); res(); }, 4000); });
  p.kill();
  return JSON.parse(out.trim().split('\n')[0]).result.content[0].text;
};
const plain = await run(false), hidden = await run(true);
assert.ok(plain.includes('Альфа') && plain.includes('INV-2026-007'), 'без прапора імена видно: ' + plain);
assert.ok(!hidden.includes('Альфа') && !hidden.includes('INV-2026-007'), 'GROSHI_PSEUDO=1 не сховав: ' + hidden);
const q = await run(true, 'transactions', {query: al});
assert.ok(q.includes('Знайдено 1 '), 'псевдонім в аргументі не розкрито: ' + q);
assert.ok(!q.includes('Альфа'), q);

// Шлях теки даних містить імʼя користувача ОС і не має йти в хмару ні зі статусом, ні з помилкою.
const rawRun = async (pseudo, name, args) => {
  const env = {...process.env, GROSHI_DIR: dir};
  if (pseudo) env.GROSHI_PSEUDO = '1'; else delete env.GROSHI_PSEUDO;
  const p = spawn(process.execPath, [path.join(root, 'mcp', 'groshi-mcp.js')], {env, stdio: ['pipe', 'pipe', 'inherit']});
  let out = '';
  p.stdout.on('data', x => (out += x));
  p.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}) + '\n');
  await new Promise(res => { const t = setInterval(() => { if (out.includes('\n')) { clearInterval(t); res(); } }, 50); setTimeout(() => { clearInterval(t); res(); }, 4000); });
  p.kill();
  return JSON.parse(out.trim().split('\n')[0]).result;
};
const stPlain = (await rawRun(false, 'groshi_status', {})).content[0].text;
assert.ok(stPlain.includes(dir), 'без прапора статус показує теку (контроль проби): ' + stPlain);
const stHidden = (await rawRun(true, 'groshi_status', {})).content[0].text;
assert.ok(!stHidden.includes(dir) && !stHidden.includes('pseudo-dir') && !/[A-Za-z]:[\\/]/.test(stHidden), 'groshi_status витік шлях: ' + stHidden);
// account не рядок → TypeError усередині інструмента
const errPlain = await rawRun(false, 'transactions', {account: 123});
assert.ok(errPlain.isError && errPlain.content[0].text.includes(dir), 'контроль: без прапора помилка називає теку');
const errHidden = await rawRun(true, 'transactions', {account: 123});
assert.ok(errHidden.isError && !errHidden.content[0].text.includes(dir) && !/[A-Za-z]:[\\/]/.test(errHidden.content[0].text),
  'помилка в режимі Порадника витекла: ' + errHidden.content[0].text);
console.log('pseudo: OK');
