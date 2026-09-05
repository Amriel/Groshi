#!/usr/bin/env node
/* Перевірка перед підключенням: чи бачить сервер дані апки.
   Запускати: node selftest.js
   Нічого не змінює — лише читає й друкує звіт. */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const srv = path.join(__dirname, 'groshi-mcp.js');
const p = spawn(process.execPath, [srv], { stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
p.stdout.on('data', d => (out += d));
const send = o => p.stdin.write(JSON.stringify(o) + '\n');

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'groshi_status', arguments: {} } });

setTimeout(() => {
  p.kill();
  let msgs;
  try { msgs = out.trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { console.log('✗ Сервер відповів не тим:\n' + out.slice(0, 400)); process.exit(1); }
  const init = msgs.find(m => m.id === 1), list = msgs.find(m => m.id === 2), st = msgs.find(m => m.id === 3);
  if (!init || !init.result) { console.log('✗ Сервер не піднявся'); process.exit(1); }
  console.log('✓ Сервер працює:', init.result.serverInfo.name, init.result.serverInfo.version);
  console.log('✓ Інструментів:', list.result.tools.length);
  console.log('');
  console.log(st.result.content[0].text);
  console.log('');
  const txt = st.result.content[0].text;
  const bad = [];
  if (/inv_cache.json немає/.test(txt)) bad.push('Інвестицій немає — відкрийте апку раз після синхронізації з брокером (потрібна версія 1.28.1+).');
  if (/mononorm.js не знайдено/.test(txt)) bad.push('mononorm.js має лежати поруч із groshi-mcp.js.');
  if (/теки немає/.test(txt)) bad.push('Теку з даними не знайдено — задайте GROSHI_DIR у конфігурації (шлях показує апка: «Ще → Апка і дані → Показати теку з даними»).');
  if (bad.length) { console.log('Що виправити:'); bad.forEach(b => console.log(' • ' + b)); }
  else console.log('Усе на місці — можна підключати до Claude Desktop (див. ЯК_ПІДКЛЮЧИТИ.md).');
}, 1500);
