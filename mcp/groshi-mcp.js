#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Гроші · MCP-сервер (stdio-обгортка)

   Лише протокол JSON-RPC. Усі інструменти й читання даних — у
   tools.js поруч: його ж підключає застосунок усередині себе, тому
   бібліотека не читає stdin при імпорті, а обгортка тримає цю частину.
   Сервер — це ДВА файли поруч: groshi-mcp.js + tools.js (+ mononorm.js).
   ═══════════════════════════════════════════════════════════════════ */

'use strict';
const fs = require('fs');
const path = require('path');
const { T, DIR, state, txAll } = require('./tools.js');
const pseudo = require('./pseudo.js');

/* Режим «Порадник»: GROSHI_PSEUDO=1 ховає NDA-імена в тексті кожного інструмента, бо відповідь
   іде в хмарну модель. Словник кешуємо до зміни state.json/mono_raw.json: перебудова — це повний
   прохід по операціях, а викликів за розмову багато. */
let _dict = null, _dictKey = '';
function pseudoDict() {
  const key = ['state.json', 'mono_raw.json'].map(f => {
    try { return fs.statSync(path.join(DIR, f)).mtimeMs; } catch (e) { return 0; }
  }).join('|');
  if (!_dict || key !== _dictKey) { _dict = pseudo.buildDict(state(), txAll()); _dictKey = key; }
  return _dict;
}

/* Пояс до знеособлення: абсолютні шляхи (Windows і Unix) містять імʼя користувача й не мають
   іти в хмару, навіть якщо якийсь інструмент або повідомлення про помилку їх випадково назве. */
function scrubPaths(text) {
  let s = String(text);
  if (DIR) s = s.split(DIR).join('[шлях приховано]');
  return s.replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '[шлях приховано]')
          .replace(/\/(?:Users|home)\/[^\s"'<>|]*/g, '[шлях приховано]');
}

/* ═══════════════════ ПРОТОКОЛ MCP (stdio, JSON-RPC 2.0) ═══════════════════
   Без SDK: обмін — рядки JSON у stdin/stdout. Так сервер запускається
   голим `node groshi-mcp.js` на будь-якій машині з Node 18+, без npm
   install і без ризику, що оновлення пакета щось зламає. */
const TOOLS = Object.entries(T).map(([name, t]) => ({
  name, description: t.desc, inputSchema: t.schema
}));

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'groshi', version: '1.0.0' }
    }});
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params && params.name;
    const t = T[name];
    if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Немає такого інструмента: ' + name } });
    try {
      let args = (params && params.arguments) || {};
      if (process.env.GROSHI_PSEUDO === '1') args = pseudo.revealArgs(args, pseudoDict());
      let text = String(t.run(args));
      /* Збій знеособлення йде в catch нижче: краще помилка, ніж відповідь із справжніми іменами. */
      if (process.env.GROSHI_PSEUDO === '1') text = scrubPaths(pseudo.hide(text, pseudoDict()));
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
    } catch (e) {
      /* Помилку віддаємо як результат, а не як збій протоколу: клієнт
         покаже її мені, і я зможу пояснити людині, що не так. */
      let msg = 'Помилка інструмента: ' + (e && e.message || e);
      if (process.env.GROSHI_PSEUDO === '1') {
        /* Текст помилки теж іде в хмару (може містити шлях або NDA-імʼя з аргументу). Якщо
           знеособлення саме впало — віддаємо загальну помилку без подробиць. */
        try { msg = scrubPaths(pseudo.hide(msg, pseudoDict())); }
        catch (e2) { msg = 'Помилка інструмента (подробиці приховано)'; }
      } else msg += '\nТека даних: ' + DIR;
      return send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: msg }],
        isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Метод не підтримується: ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    try { handle(req); } catch (e) {
      if (req && req.id !== undefined)
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(e && e.message || e) } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
