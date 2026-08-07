// scripts/smoke-admin.mjs — headless-проверка админки
// Запуск: node scripts/smoke-admin.mjs
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'admin.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8080/admin.html', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.location = window.location;
globalThis.history = window.history;
globalThis.Event = window.Event;
globalThis.confirm = () => true;

// логинимся и подхватываем сессию
const loginRes = await fetch('http://localhost:8080/api/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'boss', password: 'secret123' }),
});
if (!loginRes.ok) { console.log('FAIL: не удалось залогиниться в тесте'); process.exit(1); }
const setCookie = loginRes.headers.get('set-cookie') || '';
const token = (setCookie.match(/tt_session=([^;]+)/) || [])[1];

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts = {}) => {
  const abs = String(url).startsWith('http') ? String(url) : 'http://localhost:8080' + String(url);
  const headers = new Headers(opts.headers || {});
  if (token && abs.includes('/api/admin')) headers.set('Cookie', `tt_session=${token}`);
  return realFetch(abs, { ...opts, headers });
};

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
};

try {
  await import('../public/js/admin.js');
  await new Promise(r => setTimeout(r, 900));

  check('админка: вошли автоматически (сессия)', document.getElementById('adminMain').style.display === 'block');
  check('админка: строка "кто я"', /boss · суперадмин/.test(document.getElementById('whoami').textContent));
  check('админка: таблица сущностей (5)', document.querySelectorAll('#entitiesTable tbody tr').length === 5,
    String(document.querySelectorAll('#entitiesTable tbody tr').length));
  check('админка: коды доступа', document.querySelectorAll('#codesTable tbody tr').length >= 1);
  check('админка: админы (1)', document.querySelectorAll('#adminsTable tbody tr').length === 1);

  // модалка новой сущности
  document.getElementById('addEntityBtn').click();
  check('модалка сущности открылась', document.getElementById('entityModal').classList.contains('open'));
  document.getElementById('fName').value = 'Test Exchange';
  document.getElementById('fType').value = 'exchange';
  document.getElementById('fRisk').value = '10';
  document.getElementById('fAddresses').value = '0:1111111111111111111111111111111111111111111111111111111111111111';
  document.getElementById('saveEntityBtn').click();
  await new Promise(r => setTimeout(r, 600));
  check('сущность создана (6)', document.querySelectorAll('#entitiesTable tbody tr').length === 6,
    String(document.querySelectorAll('#entitiesTable tbody tr').length));

  // удаляем тестовую
  const delBtn = [...document.querySelectorAll('#entitiesTable tbody tr')].find(tr => tr.textContent.includes('Test Exchange'))?.querySelector('[data-del-entity]');
  if (delBtn) { delBtn.click(); await new Promise(r => setTimeout(r, 500)); }
  check('сущность удалена (5)', document.querySelectorAll('#entitiesTable tbody tr').length === 5,
    String(document.querySelectorAll('#entitiesTable tbody tr').length));
} catch (e) {
  results.push({ name: 'CRASH', ok: false });
  console.error('CRASH:', e.stack || e);
}

const failed = results.filter(r => !r.ok);
console.log('\nИтог: ' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
