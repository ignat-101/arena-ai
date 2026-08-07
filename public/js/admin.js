// public/js/admin.js — логика админ-панели
const $ = (id) => document.getElementById(id);

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, method = 'GET', body = null) {
  const res = await fetch('/api/admin' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) { const err = new Error((json && json.error) || `HTTP ${res.status}`); err.status = res.status; throw err; }
  return json;
}

const TYPE_LABELS = {
  exchange: 'Биржа', defi: 'DeFi', bridge: 'Мост', mixer: 'Миксер', payment: 'Платёжный сервис',
  gambling: 'Гемблинг', scam: 'Скам', fraud: 'Мошенничество', phishing: 'Фишинг',
  suspicious: 'Подозрительный', high_risk: 'Высокий риск', whale: 'Кит', service: 'Сервис', other: 'Другое',
};

let me = null;
let entities = [];
let editingEntity = null;
let importSelection = new Set();

// ---------- аутентификация ----------
async function initAuth() {
  try {
    const data = await api('/me');
    me = data.admin;
    enterApp();
  } catch {
    $('authView').style.display = 'block';
    $('loginCard').style.display = 'block';
  }
}

function enterApp() {
  $('authView').style.display = 'none';
  $('adminMain').style.display = 'block';
  $('whoami').textContent = `${me.username} · ${me.role === 'superadmin' ? 'суперадмин' : me.role === 'admin' ? 'админ' : 'аналитик'}`;
  refreshAll();
  if (me.role === 'analyst') {
    document.querySelectorAll('.admin-tab').forEach(t => { if (['codes', 'admins'].includes(t.dataset.tab)) t.style.display = 'none'; });
    $('addEntityBtn').style.display = 'none';
  }
}

$('showRegister').addEventListener('click', (e) => { e.preventDefault(); $('loginCard').style.display = 'none'; $('registerCard').style.display = 'block'; });
$('showLogin').addEventListener('click', (e) => { e.preventDefault(); $('registerCard').style.display = 'none'; $('loginCard').style.display = 'block'; });

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/login', 'POST', { username: $('loginUser').value, password: $('loginPass').value });
    me = data.admin;
    enterApp();
    toast('Добро пожаловать, ' + me.username, 'success');
  } catch (err) { toast(err.message, 'error'); }
});

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/register', 'POST', { code: $('regCode').value, username: $('regUser').value, password: $('regPass').value });
    me = data.admin;
    enterApp();
    toast('Аккаунт создан. Роль: ' + me.role, 'success');
  } catch (err) { toast(err.message, 'error'); }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', 'POST'); } catch {}
  location.reload();
});

// ---------- табы ----------
document.querySelectorAll('.admin-tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.admin-tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.admin-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + t.dataset.tab));
  refreshPane(t.dataset.tab);
}));

function refreshPane(tab) {
  if (tab === 'entities') loadEntities();
  if (tab === 'codes') loadCodes();
  if (tab === 'admins') loadAdmins();
  if (tab === 'cases') loadCases();
  if (tab === 'audit') loadAudit();
}
function refreshAll() {
  loadEntities(); loadCodes(); loadAdmins(); loadCases(); loadAudit();
}

// ---------- сущности ----------
async function loadEntities() {
  try {
    const data = await api('/entities');
    entities = data.entities;
    $('entityCount').textContent = entities.length;
    const tbody = $('entitiesTable').querySelector('tbody');
    tbody.innerHTML = '';
    for (const e of entities) {
      const tr = document.createElement('tr');
      const riskClass = e.risk_level >= 75 ? 'risk-3' : e.risk_level >= 50 ? 'risk-2' : e.risk_level >= 25 ? 'risk-1' : 'risk-0';
      const statusLabel = e.status === 'active' ? 'активна' : e.status === 'monitored' ? 'мониторинг' : 'заблокирована';
      tr.innerHTML = `
        <td><b>${esc(e.name)}</b>${e.color ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(e.color)};margin-left:7px;"></span>` : ''}
          <div style="font-size:10.5px;color:var(--text-faint);">#${e.id} · ${esc(e.source)}</div></td>
        <td>${TYPE_LABELS[e.type] || e.type}</td>
        <td><span class="risk-badge ${riskClass}">${e.risk_level}</span></td>
        <td>${statusLabel}</td>
        <td>${e.addresses.length}</td>
        <td>${(e.tags || []).slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join(' ')}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-sm" data-edit-entity="${e.id}">✏️</button>
          <button class="btn btn-sm btn-danger" data-del-entity="${e.id}">🗑</button>
        </td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('[data-edit-entity]').forEach(b => b.addEventListener('click', () => openEntity(parseInt(b.dataset.editEntity, 10))));
    tbody.querySelectorAll('[data-del-entity]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Удалить сущность и все её адреса?')) return;
      try { await api('/entities/' + b.dataset.delEntity, 'DELETE'); toast('Удалено', 'success'); loadEntities(); } catch (e) { toast(e.message, 'error'); }
    }));
  } catch (e) { toast(e.message, 'error'); }
}

function openEntity(id) {
  editingEntity = id ? entities.find(e => e.id === id) : null;
  $('entityModalTitle').textContent = editingEntity ? 'Редактировать: ' + editingEntity.name : 'Новая сущность';
  $('fName').value = editingEntity ? editingEntity.name : '';
  $('fType').value = editingEntity ? editingEntity.type : 'exchange';
  $('fRisk').value = editingEntity ? editingEntity.risk_level : 0;
  $('fStatus').value = editingEntity ? editingEntity.status : 'active';
  $('fColor').value = editingEntity ? (editingEntity.color || '') : '';
  $('fLogo').value = editingEntity ? (editingEntity.logo_url || '') : '';
  $('fTags').value = editingEntity ? (editingEntity.tags || []).join(', ') : '';
  $('fDesc').value = editingEntity ? (editingEntity.description || '') : '';
  $('fAddresses').value = editingEntity ? (editingEntity.addresses || []).map(a => a.address + (a.note ? ` # ${a.note}` : '')).join('\n') : '';
  $('deleteEntityBtn').style.display = editingEntity ? 'inline-flex' : 'none';
  $('entityModal').classList.add('open');
}

$('addEntityBtn').addEventListener('click', () => openEntity(null));
$('saveEntityBtn').addEventListener('click', async () => {
  const addresses = $('fAddresses').value.split('\n').map(s => s.trim()).filter(Boolean)
    .map(line => {
      const m = line.split(/\s+#\s+/);
      return { address: m[0].trim(), note: (m[1] || '').trim() };
    });
  const payload = {
    name: $('fName').value.trim(),
    type: $('fType').value,
    risk_level: parseInt($('fRisk').value, 10) || 0,
    status: $('fStatus').value,
    color: $('fColor').value.trim(),
    logo_url: $('fLogo').value.trim(),
    tags: $('fTags').value.split(',').map(s => s.trim()).filter(Boolean),
    description: $('fDesc').value.trim(),
    addresses,
  };
  if (!payload.name) { toast('Укажите название', 'error'); return; }
  try {
    if (editingEntity) {
      await api('/entities/' + editingEntity.id, 'PUT', payload);
      toast('Сохранено', 'success');
    } else {
      await api('/entities', 'POST', payload);
      toast('Сущность добавлена', 'success');
    }
    $('entityModal').classList.remove('open');
    loadEntities();
  } catch (e) { toast(e.message, 'error'); }
});

$('deleteEntityBtn').addEventListener('click', async () => {
  if (!editingEntity) return;
  if (!confirm('Удалить сущность и все её адреса?')) return;
  try { await api('/entities/' + editingEntity.id, 'DELETE'); toast('Удалено', 'success'); $('entityModal').classList.remove('open'); loadEntities(); }
  catch (e) { toast(e.message, 'error'); }
});

// ---------- импорт из TonAPI ----------
$('importSearchBtn').addEventListener('click', async () => {
  const name = $('importName').value.trim();
  if (name.length < 3) { toast('Минимум 3 символа', 'error'); return; }
  $('importResults').textContent = 'Поиск в TonAPI…';
  $('importList').innerHTML = '';
  try {
    const data = await api('/entities/import/search', 'POST', { name });
    const items = data.addresses || [];
    if (!items.length) { $('importResults').textContent = 'Ничего не найдено.'; return; }
    $('importResults').textContent = `Найдено: ${items.length}. Отметьте нужные и импортируйте.`;
    $('importList').innerHTML = '';
    importSelection.clear();
    items.forEach((it, i) => {
      const div = document.createElement('div');
      div.className = 'import-result';
      const trust = it.trust === 'whitelist' ? 'whitelist' : 'none';
      div.innerHTML = `
        <div class="ir-head">
          <input type="checkbox" data-idx="${i}" ${trust === 'whitelist' ? 'checked' : ''}/>
          <span>${esc(it.name || '')}</span>
          <span class="ac-trust trust-${trust}">${trust === 'whitelist' ? 'проверен' : 'не проверен'}</span>
        </div>
        <div class="ir-addr">${esc(it.address || '')}</div>`;
      div.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) importSelection.add(i); else importSelection.delete(i);
        updateImportBtn();
      });
      $('importList').appendChild(div);
      if (trust === 'whitelist') importSelection.add(i);
    });
    updateImportBtn();
  } catch (e) { $('importResults').textContent = 'Ошибка: ' + e.message; }
});

function updateImportBtn() {
  const btn = $('importBulkBtn');
  btn.style.display = importSelection.size ? 'inline-flex' : 'none';
  btn.textContent = `Импортировать выбранные (${importSelection.size})`;
}

$('importBulkBtn').addEventListener('click', async () => {
  const items = [...importSelection].map(i => {
    const div = $('importList').children[i];
    const name = div.querySelector('.ir-head span').textContent;
    const address = div.querySelector('.ir-addr').textContent.trim();
    const trust = div.querySelector('.ac-trust').textContent.trim();
    const type = trust === 'проверен' ? 'exchange' : 'suspicious';
    const risk = trust === 'проверен' ? 5 : 70;
    return { name, type, risk_level: risk, addresses: [{ address, name }], description: `Импорт из TonAPI (${trust})`, trust };
  });
  try {
    const res = await api('/entities/import/bulk', 'POST', { items });
    toast(`Импортировано сущностей: ${res.created}`, 'success');
    $('importList').innerHTML = '';
    $('importBulkBtn').style.display = 'none';
    loadEntities();
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- коды ----------
async function loadCodes() {
  try {
    const data = await api('/codes');
    const tbody = $('codesTable').querySelector('tbody');
    tbody.innerHTML = '';
    for (const c of data.codes) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono"><b>${esc(c.code)}</b></td>
        <td>${c.role}</td>
        <td>${c.uses_total - c.uses_left} / ${c.uses_total}</td>
        <td>${c.expires_at ? new Date(c.expires_at).toLocaleString('ru-RU') : 'бессрочно'}</td>
        <td>${esc(c.note || '')}</td>
        <td style="text-align:right;"><button class="btn btn-sm btn-danger" data-revoke="${esc(c.code)}">Отозвать</button></td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
      try { await api('/codes/' + encodeURIComponent(b.dataset.revoke), 'DELETE'); toast('Код отозван', 'success'); loadCodes(); }
      catch (e) { toast(e.message, 'error'); }
    }));
  } catch (e) { toast(e.message, 'error'); }
}

$('inviteBtn').addEventListener('click', async () => {
  const role = $('inviteRole').value;
  const uses = parseInt($('inviteUses').value, 10) || 1;
  const hours = $('inviteHours').value ? parseInt($('inviteHours').value, 10) : null;
  const note = $('inviteNote').value.trim();
  try {
    const data = await api('/invite', 'POST', { role, uses, note, expires_in_hours: hours });
    toast(`Код: ${data.code}`, 'success');
    loadCodes();
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- админы ----------
async function loadAdmins() {
  try {
    const data = await api('/admins');
    const tbody = $('adminsTable').querySelector('tbody');
    tbody.innerHTML = '';
    for (const a of data.admins) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${esc(a.username)}</b>${a.username === me.username ? ' <span class="tag">это вы</span>' : ''}</td>
        <td>${a.role === 'superadmin' ? '👑 суперадмин' : a.role === 'admin' ? 'админ' : 'аналитик'}</td>
        <td>${new Date(a.created_at).toLocaleString('ru-RU')}</td>
        <td>${esc(a.created_by || '')}</td>
        <td>${a.username === me.username ? '' : `
          <select class="tool-select" data-role="${a.id}">
            <option value="admin" ${a.role === 'admin' ? 'selected' : ''}>админ</option>
            <option value="analyst" ${a.role === 'analyst' ? 'selected' : ''}>аналитик</option>
            <option value="superadmin" ${a.role === 'superadmin' ? 'selected' : ''}>суперадмин</option>
          </select>`}</td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('[data-role]').forEach(sel => sel.addEventListener('change', async () => {
      try { await api('/admins/' + sel.dataset.role + '/role', 'POST', { role: sel.value }); toast('Роль обновлена', 'success'); loadAdmins(); }
      catch (e) { toast(e.message, 'error'); }
    }));
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- кейсы ----------
$('caseFilter').addEventListener('change', loadCases);
async function loadCases() {
  try {
    const status = $('caseFilter').value;
    const data = await api('/cases' + (status ? '?status=' + encodeURIComponent(status) : ''));
    const tbody = $('casesTable').querySelector('tbody');
    tbody.innerHTML = '';
    if (!data.cases.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-faint);">Нет кейсов</td></tr>'; return; }
    for (const c of data.cases) {
      const riskClass = c.score >= 75 ? 'risk-3' : c.score >= 50 ? 'risk-2' : c.score >= 25 ? 'risk-1' : 'risk-0';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${esc(c.friendly_address || c.address)}</td>
        <td><span class="risk-badge ${riskClass}">${c.score} · ${c.level}</span></td>
        <td>${esc(c.status)}</td>
        <td style="max-width:260px;">${esc((c.summary || '').slice(0, 80))}</td>
        <td>${new Date(c.created_at).toLocaleString('ru-RU')}</td>
        <td>
          <select class="tool-select" data-case="${c.id}">
            <option value="open" ${c.status === 'open' ? 'selected' : ''}>открыт</option>
            <option value="investigating" ${c.status === 'investigating' ? 'selected' : ''}>в работе</option>
            <option value="resolved" ${c.status === 'resolved' ? 'selected' : ''}>решён</option>
            <option value="closed" ${c.status === 'closed' ? 'selected' : ''}>закрыт</option>
          </select>
        </td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('[data-case]').forEach(sel => sel.addEventListener('change', async () => {
      try { await api('/cases/' + sel.dataset.case + '/status', 'POST', { status: sel.value }); toast('Статус обновлён', 'success'); loadCases(); }
      catch (e) { toast(e.message, 'error'); }
    }));
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- аудит ----------
async function loadAudit() {
  try {
    const data = await api('/audit');
    const tbody = $('auditTable').querySelector('tbody');
    tbody.innerHTML = '';
    for (const a of data.entries) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${new Date(a.created_at).toLocaleString('ru-RU')}</td><td>${esc(a.admin)}</td><td class="mono">${esc(a.action)}</td><td>${esc(a.details)}</td>`;
      tbody.appendChild(tr);
    }
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// модалка close
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).classList.remove('open')));
document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('open'); }));

initAuth();
