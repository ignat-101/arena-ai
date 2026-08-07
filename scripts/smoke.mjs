// scripts/smoke.mjs — headless-проверка фронтенда (jsdom + реальный бэкенд на :8080)
// Запуск: node scripts/smoke.mjs
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:8080/',
  pretendToBeVisual: true,
});

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.location = window.location;
globalThis.history = window.history;
globalThis.btoa = window.btoa;
globalThis.atob = window.atob;
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.URLSearchParams = window.URLSearchParams;
globalThis.HTMLElement = window.HTMLElement;

// стаб канваса
const noop = () => {};
const ctxStub = new Proxy({}, {
  get: (t, prop) => {
    if (prop === 'measureText') return (txt) => ({ width: String(txt).length * 6 });
    if (prop === 'canvas') return {};
    if (typeof prop === 'string') return noop;
    return undefined;
  },
  set: () => true,
});
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;

// fetch: реальный бэкенд (сохраняем оригинальный fetch, чтобы избежать рекурсии)
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) => realFetch(url, opts);

// сбор ошибок
const errors = [];
window.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && e.message)));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
}

try {
  await import('../public/js/main.js');
  await sleep(1200);

  check('main.js импортировался и init() выполнился без ошибок', errors.length === 0, errors.join(' | '));
  check('кнопки периодов отрисованы', document.querySelectorAll('#periodGroup .seg-btn').length === 7);
  check('пилюля источника данных обновилась', /TonAPI|сервер|недоступен/.test(document.querySelector('#dataSourcePill').textContent));

  // тест PDF-эндпоинта (до демо, т.к. fetch из jsdom валиден)
  try {
    const pdfRes = await realFetch('http://localhost:8080/api/report/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: { friendly: 'UQCfdyrb0Fj8lA32OfizTwGY829tTzihsEYl1FrpBzeVKdi0', raw: '0:9f772adbd058fc940df639f8b34f0198f36f6d4f38a1b04625d45ae907379529', name: '7288.ton', balance: 10339806878, is_wallet: true },
        risk: { score: 38, level: 'medium', level_label: 'Средний', signals: [{ title: 'Тест', severity: 60, detail: '' }] },
        stats: { in_value: 63200000000, out_value: 12900000000, tx_count: 7, unique_counterparties: 6 },
        counterparties: [{ name: 'Bybit 1', address: '0:1111111111111111111111111111111111111111111111111111111111111111', in_value: 15000000000, out_value: 0, in_count: 1, out_count: 0 }],
        transactions: [{ timestamp: 1785700000, dir: 'in', type: 'TonTransfer', description: 'Депозит', value: '15 TON', counterparty: 'Bybit 1', event_id: 'abc' }],
      }),
    });
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    check('PDF эндпоинт: 200', pdfRes.status === 200, String(pdfRes.status));
    check('PDF эндпоинт: %PDF magic', buf.slice(0, 5).toString() === '%PDF-', buf.length + ' bytes');
  } catch (e) {
    results.push({ name: 'PDF эндпоинт', ok: false, extra: e.message });
    console.log('FAIL  PDF эндпоинт — ' + e.message);
  }

  // демо-режим
  const demoBtn = document.getElementById('demoBtn');
  demoBtn.click();
  await sleep(1500);

  check('демо: кнопка спрятана', document.getElementById('emptyState').style.display === 'none');
  const statCards = document.querySelectorAll('#nodeDetail .stat-card');
  check('демо: карточки статистики (6)', statCards.length === 6, String(statCards.length));
  check('демо: баланс 10.34 TON', document.querySelector('#nodeDetail .stat-card .v')?.textContent.replace('\u00a0',' ').includes('10,34') || document.querySelector('#nodeDetail .stat-card .v')?.textContent.includes('10.34'), document.querySelector('#nodeDetail .stat-card .v')?.textContent || 'empty');
  const txItems = document.querySelectorAll('#txList .tx-item');
  check('демо: список транзакций', txItems.length >= 5, String(txItems.length));
  const reportErr = document.querySelector('#pane-aml')?.textContent.match(/ошибка[^<]*/i);
  if (reportErr) console.log('AML report.error присутствует:', reportErr[0]);
  const riskScore = document.querySelector('#pane-aml .risk-score')?.textContent || '';
  check('демо: AML-оценка посчитана', /\/100/.test(riskScore) && riskScore !== '0/100', riskScore);
  if (!/\/100/.test(riskScore) || riskScore === '0/100') {
    console.log('AML-панель:', document.getElementById('amlPane').innerHTML.slice(0, 600));
  }
  check('демо: сигналы AML', document.querySelectorAll('#pane-aml .risk-signal').length > 0);

  // прямой тест fetch в окружении smoke
  try {
    const r = await fetch('http://localhost:8080/api/aml/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '0:9f772adbd058fc940df639f8b34f0198f36f6d4f38a1b04625d45ae907379529', counterparties: [{ address: '0:2222222222222222222222222222222222222222222222222222222222222222', name: 'binance12.ton', is_scam: true }], stats: {} }),
    });
    const j = await r.json();
    console.log('DIRECT fetch aml:', r.status, j.score);
  } catch (e) { console.log('DIRECT fetch aml FAILED:', e.message); }

  // клик по транзакции → модалка
  txItems[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check('модалка транзакции открылась', document.getElementById('txModal').classList.contains('open'));
  check('модалка транзакции: шапка с заголовком', document.getElementById('txModalHead').textContent.includes('Операция') || document.getElementById('txModalHead').textContent.includes('Transfer') || document.getElementById('txModalHead').textContent.length > 5, document.getElementById('txModalHead').textContent.slice(0, 40));
  check('модалка транзакции: участники', document.querySelectorAll('#txModalBody .participant-row').length >= 1, String(document.querySelectorAll('#txModalBody .participant-row').length));
  check('модалка транзакции: кнопка PDF', !!document.getElementById('txModalPdfBtn'));

  // поп-ап узла
  check('модалка узла присутствует в DOM', !!document.getElementById('nodeModal'));

  // фильтры
  document.getElementById('minAmount').value = '50';
  document.getElementById('minAmount').dispatchEvent(new window.Event('change'));
  await sleep(400);
  const dirIn = document.getElementById('direction');
  dirIn.value = 'in';
  dirIn.dispatchEvent(new window.Event('change'));
  await sleep(400);
  check('фильтры применились без ошибок', errors.length === 0, errors.join(' | '));

  // табы
  document.querySelector('.tab-btn[data-tab="tx"]').click();
  check('таб транзакций активен', document.getElementById('pane-tx').classList.contains('active'));

  // узлы графа
  const nodes = window.__graphTestNodes;
} catch (e) {
  results.push({ name: 'SMOKE TEST CRASH', ok: false, extra: e.stack });
  console.error('CRASH:', e);
}

const failed = results.filter(r => !r.ok);
console.log('\nИтог: ' + (results.length - failed.length) + '/' + results.length + ' passed');
if (errors.length) console.log('Ошибки JS:', errors);
process.exit(failed.length ? 1 : 0);
