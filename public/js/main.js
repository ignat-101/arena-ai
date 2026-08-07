// public/js/main.js — логика главной страницы (визуализатор)
import { ForceGraph } from './graph.js';
import {
  parseAddress, toRaw, toFriendly, formatTon, formatTonShort, formatNumber,
  formatTime, timeAgo, shortAddr, shortHash, normalizeAddressKey,
} from './ton-utils.js';
import {
  initDataLayer, getDataSource, tonapi, getEntities, analyzeAML,
  exploreAccount, extractTransfers, aggregateTransfers, PERIODS, getDemoData,
} from './api.js';

const $ = (id) => document.getElementById(id);

// ---------- состояние ----------
const state = {
  address: '',
  walletRaw: '',
  account: null,
  events: [],
  nextFrom: null,
  allLoaded: false,
  entities: [],
  counterparties: [],
  stats: {},
  aml: null,
  graph: null,
  filters: { period: 'all', min: 0, direction: 'all', asset: 'all' },
  loading: false,
  demo: false,
  exploredFriendly: '',
};

// ---------- утилиты UI ----------
function toast(msg, type = '') {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function copyText(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Скопировано', 'success'));
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Скопировано', 'success'); }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- типы сущностей ----------
const TYPE_COLORS = {
  exchange: '#8e6cf5', defi: '#00c2a8', bridge: '#4f8cff', mixer: '#f5a623',
  payment: '#2fb8d8', gambling: '#ff9f43', scam: '#f53423', fraud: '#f53423',
  phishing: '#f53423', suspicious: '#f56b23', high_risk: '#f56b23',
  whale: '#c9a227', service: '#7b8ff5', other: '#8b98ad',
};
const TYPE_LABELS = {
  exchange: 'Биржа', defi: 'DeFi', bridge: 'Мост', mixer: 'Миксер', payment: 'Платёжный сервис',
  gambling: 'Гемблинг', scam: 'Скам', fraud: 'Мошенничество', phishing: 'Фишинг',
  suspicious: 'Подозрительный', high_risk: 'Высокий риск', whale: 'Кит', service: 'Сервис', other: 'Другое',
};

function entityByAddress(entities, raw) {
  return entities.find(e => e.addresses && e.addresses.some(a => a === raw));
}

// ---------- период ----------
function renderPeriods() {
  const group = $('periodGroup');
  group.innerHTML = '';
  for (const p of PERIODS) {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (p.id === state.filters.period ? ' active' : '');
    b.textContent = p.label;
    b.dataset.period = p.id;
    b.title = p.label;
    b.addEventListener('click', () => {
      state.filters.period = p.id;
      group.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x.dataset.period === p.id));
      if (state.address) runExplore({ reset: true });
      else applyFilters();
    });
    group.appendChild(b);
  }
}

// ---------- автодополнение ----------
let acTimer = null;
function setupAutocomplete() {
  const input = $('addressInput');
  const box = $('autocomplete');
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (v.length < 3) { box.classList.remove('open'); return; }
    clearTimeout(acTimer);
    acTimer = setTimeout(async () => {
      try {
        const data = await tonapi.search(v);
        const items = (data.addresses || []).slice(0, 12);
        if (!items.length) { box.classList.remove('open'); return; }
        box.innerHTML = '';
        for (const it of items) {
          const div = document.createElement('div');
          div.className = 'ac-item';
          const trust = it.trust === 'whitelist' ? 'whitelist' : 'none';
          div.innerHTML = `
            ${it.preview ? `<img src="${esc(it.preview)}" alt="" onerror="this.style.display='none'"/>` : '<img alt="" style="visibility:hidden"/>'}
            <div style="min-width:0">
              <div class="ac-name">${esc(it.name || '')}</div>
              <div class="ac-addr">${esc(it.address || '')}</div>
            </div>
            <span class="ac-trust trust-${trust}">${trust === 'whitelist' ? 'проверен' : 'не проверен'}</span>`;
          div.addEventListener('click', () => {
            input.value = it.address || it.name || '';
            box.classList.remove('open');
            submitSearch();
          });
          box.appendChild(div);
        }
        box.classList.add('open');
      } catch { box.classList.remove('open'); }
    }, 350);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) box.classList.remove('open');
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSearch(); });
}

// ---------- поиск ----------
function submitSearch() {
  const v = $('addressInput').value.trim();
  if (!v) return;
  const parsed = parseAddress(v);
  if (parsed.error) { toast(parsed.error, 'error'); return; }
  state.address = v;
  $('emptyState').style.display = 'none';
  updateUrl();
  runExplore({ reset: true });
}

async function runExplore({ reset = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  setLoadingUI(true);
  try {
    const maxEvents = 1000;
    const result = await exploreAccount(state.address, {
      period: state.filters.period,
      maxEvents,
      onProgress: (p) => {
        $('progressWrap').style.display = 'block';
        $('progressFill').style.width = Math.min(96, (p.events / maxEvents) * 100) + '%';
        $('progressText').textContent = `Загружено событий: ${p.events}…`;
      },
    });
    state.account = result.account;
    state.walletRaw = result.walletRaw || normalizeAddressKey(result.account.address) || '';
    state.events = result.events;
    state.nextFrom = result.events.length ? result.events[result.events.length - 1].lt : null;
    state.allLoaded = result.events.length < 100;
    state.demo = false;
    state.exploredFriendly = result.account.name || (result.parsed && result.parsed.friendly) || state.address;
    $('addressInput').value = result.parsed && result.parsed.friendly ? result.parsed.friendly : state.address;
    state.entities = await getEntities().catch(() => []);
    await rebuildAll();
    toast(`Найдено событий: ${result.events.length}`, 'success');
  } catch (e) {
    console.error(e);
    toast(e.message || 'Не удалось получить данные', 'error');
    if (getDataSource() === 'direct') {
      toast('Возможно, TonAPI недоступен из браузера (CORS) — на сервере будет работать через прокси', 'error');
    }
  } finally {
    state.loading = false;
    setLoadingUI(false);
    $('progressWrap').style.display = 'none';
  }
}

function setLoadingUI(loading) {
  $('searchBtn').disabled = loading;
  $('refreshBtn').disabled = loading;
  $('searchBtn').textContent = loading ? '…' : 'Показать';
}

// ---------- граф ----------
let graph = null;

function buildGraph() {
  const { direction, min, asset } = state.filters;
  const walletRaw = state.walletRaw;
  if (!walletRaw || !state.events.length) { state.graph = null; return; }

  const transfers = extractTransfers(state.events, walletRaw)
    .filter(t => (asset === 'all') || (asset === 'ton' && t.type === 'ton') || (asset === 'jetton' && t.type === 'jetton'));

  const { counterparties, stats } = aggregateTransfers(transfers, walletRaw);
  state.stats = stats;
  state.counterparties = counterparties;

  // фильтры
  let edges = counterparties
    .filter(c => {
      const v = c.in_value + c.out_value;
      if (direction === 'in' && c.in_count === 0) return false;
      if (direction === 'out' && c.out_count === 0) return false;
      if (min > 0 && v / 1e9 < min) return false;
      return true;
    })
    .map(c => ({
      counterparty: c.address,
      direction: c.in_count > 0 && c.out_count > 0 ? 'both' : (c.in_count > 0 ? 'in' : 'out'),
      value: c.in_value + c.out_value,
      ton_value: c.in_value + c.out_value,
      count: c.in_count + c.out_count,
      in_value: c.in_value,
      out_value: c.out_value,
    }));

  edges.sort((a, b) => b.ton_value - a.ton_value);

  // узлы: главный + контрагенты (объединяем адреса одной сущности в один узел)
  const nodes = [];
  const mainNode = {
    id: walletRaw, label: state.account.name || shortAddr(walletRaw, 6, 4),
    sublabel: 'Искомый кошелёк', r: 26, fill: '#2f6bff', isMain: true,
    inCount: stats.in_count, outCount: stats.out_count,
    inValue: stats.in_value, outValue: stats.out_value,
  };
  nodes.push(mainNode);

  const entityTotals = new Map(); // entityId -> {inValue,outValue,inCount,outCount}
  for (const e of edges) {
    const entity = entityByAddress(state.entities, e.counterparty);
    let nodeId, label, fill, risk, entityObj;
    if (entity) {
      nodeId = `entity:${entity.id}`;
      const t = entityTotals.get(nodeId) || { inValue: 0, outValue: 0, inCount: 0, outCount: 0 };
      t.inValue += e.in_value; t.outValue += e.out_value;
      t.inCount += e.direction !== 'out' ? e.count : 0;
      t.outCount += e.direction !== 'in' ? e.count : 0;
      entityTotals.set(nodeId, t);
      label = entity.name;
      fill = entity.color || TYPE_COLORS[entity.type] || '#8e6cf5';
      risk = entity.risk_level;
      entityObj = entity;
    } else {
      nodeId = e.counterparty;
      const meta = counterparties.find(c => c.address === e.counterparty);
      label = (meta && meta.name) || shortAddr(e.counterparty, 6, 4);
      fill = '#3a4a66';
      risk = (meta && meta.is_scam) ? 90 : 0;
    }
    const total = e.in_value + e.out_value;
    nodes.push({
      id: nodeId, label, sublabel: entity ? TYPE_LABELS[entity.type] : '',
      r: Math.max(9, Math.min(26, 6 + Math.log10((total / 1e9) + 1) * 4.5)),
      fill, risk, entity: entityObj || null,
      inCount: e.direction !== 'out' ? e.count : 0,
      outCount: e.direction !== 'in' ? e.count : 0,
      inValue: e.in_value, outValue: e.out_value,
    });
  }
  // применяем агрегированные суммы по сущностям к узлам
  for (const n of nodes) {
    const t = entityTotals.get(n.id);
    if (t) { n.inValue = t.inValue; n.outValue = t.outValue; n.inCount = t.inCount; n.outCount = t.outCount; }
  }

  // рёбра графа
  const graphEdges = [];
  for (const e of edges) {
    const entity = entityByAddress(state.entities, e.counterparty);
    const targetId = entity ? `entity:${entity.id}` : e.counterparty;
    const mainNodeRef = nodes[0];
    let targetRef = null;
    if (entity) targetRef = nodes.find(n => n.id === targetId);
    else targetRef = nodes.find(n => n.id === targetId);
    if (!targetRef) continue;
    graphEdges.push({
      source: mainNodeRef,
      target: targetRef,
      direction: e.direction,
      tonValue: e.ton_value,
      count: e.count,
      color: e.direction === 'out' ? 'rgba(255,159,67,.4)' : (e.direction === 'in' ? 'rgba(61,220,132,.4)' : 'rgba(120,140,180,.4)'),
    });
  }

  state.graph = { nodes, edges: graphEdges, mainId: walletRaw, stats };
  return state.graph;
}

function renderGraph() {
  const g = buildGraph();
  if (!g) {
    $('emptyState').style.display = 'flex';
    return;
  }
  $('emptyState').style.display = 'none';
  graph.setData(g);
}

// ---------- панели ----------
function renderInfoMain() {
  const el = $('nodeDetail');
  const acc = state.account;
  const st = state.stats;
  if (!acc) { el.innerHTML = '<div class="empty-state"><div class="big">🔍</div><h2>Адрес не выбран</h2><p>Введите адрес кошелька для анализа.</p></div>'; return; }

  const friendly = toFriendly(acc.address || state.walletRaw, true);
  const entity = state.walletRaw ? entityByAddress(state.entities, state.walletRaw) : null;

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="k">Баланс</div><div class="v">${formatTon(acc.balance)}</div></div>
      <div class="stat-card"><div class="k">Активность</div><div class="v" style="font-size:13px;">${timeAgo(acc.last_activity)}</div></div>
      <div class="stat-card"><div class="k">Входящие (период)</div><div class="v green">${formatTon(st.in_value)}</div></div>
      <div class="stat-card"><div class="k">Исходящие (период)</div><div class="v orange">${formatTon(st.out_value)}</div></div>
      <div class="stat-card"><div class="k">Операций</div><div class="v">${formatNumber(st.tx_count, 0)}</div></div>
      <div class="stat-card"><div class="k">Контрагентов</div><div class="v">${formatNumber(st.unique_counterparties, 0)}</div></div>
    </div>
    <div class="address-box">
      <span>${esc(friendly)}</span>
      <span class="copy" title="Скопировать адрес" data-copy="${esc(friendly)}">⧉</span>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
      ${acc.name ? `<span class="badge" style="background:rgba(79,140,255,.13);color:#9cc0ff;">${esc(acc.name)}</span>` : ''}
      ${acc.is_scam ? '<span class="badge badge-scam">⚠ scam (TonAPI)</span>' : '<span class="badge badge-ok">не scam</span>'}
      ${acc.is_wallet ? '<span class="badge badge-ok">кошелёк</span>' : '<span class="badge badge-new">контракт</span>'}
      ${(acc.interfaces || []).slice(0, 3).map(i => `<span class="tag">${esc(i)}</span>`).join('')}
      ${entity ? `<span class="entity-chip">🏷 ${esc(entity.name)} <span class="type">${TYPE_LABELS[entity.type] || entity.type} · риск ${entity.risk_level}</span></span>` : ''}
    </div>
    <div class="section-title">Адрес</div>
    <div class="address-box">
      <span>${esc(acc.address || state.walletRaw)}</span>
      <span class="copy" title="Скопировать raw-адрес" data-copy="${esc(acc.address || state.walletRaw)}">⧉</span>
    </div>
    <div class="action-row">
      <button class="btn btn-sm" data-explore="${esc(friendly)}">Открыть в графе</button>
      <button class="btn btn-sm" data-copy="${esc(friendly)}">Скопировать</button>
      <a class="btn btn-sm" target="_blank" rel="noopener" href="https://tonviewer.com/${esc(friendly)}">Tonviewer ↗</a>
      <a class="btn btn-sm" target="_blank" rel="noopener" href="https://tonapi.io/account/${esc(friendly)}">TonAPI ↗</a>
    </div>
    <div class="section-title">Джеттоны</div>
    <div id="jettonsBox"><span style="color:var(--text-faint);font-size:12px;">загрузка…</span></div>
  `;
  loadJettons();
}

async function loadJettons() {
  const box = $('jettonsBox');
  try {
    const data = await tonapi.getJettons(state.walletRaw || state.address);
    const balances = (data.balances || []).filter(b => parseInt(b.balance, 10) > 0).slice(0, 8);
    if (!balances.length) { box.innerHTML = '<span style="color:var(--text-faint);font-size:12px;">нет балансов</span>'; return; }
    box.innerHTML = '';
    for (const b of balances) {
      const meta = b.jetton || {};
      const amount = parseInt(b.balance, 10) / Math.pow(10, meta.decimals ?? 9);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px;';
      row.innerHTML = `<span>${esc(meta.symbol || '?')} <span style="color:var(--text-faint)">${esc(meta.name || '')}</span></span><b class="mono">${amount.toLocaleString('ru-RU', { maximumFractionDigits: 4 })}</b>`;
      box.appendChild(row);
    }
  } catch { box.innerHTML = '<span style="color:var(--text-faint);font-size:12px;">недоступно</span>'; }
}

// ---------- транзакции ----------
function eventView(ev) {
  const sp = (ev.actions && ev.actions[0] && ev.actions[0].simple_preview) || {};
  const firstAction = ev.actions && ev.actions[0];
  const type = firstAction ? firstAction.type : '';
  const transfers = extractTransfers([ev], state.walletRaw);
  let dir = 'self';
  let valueNano = 0;
  if (transfers.length) {
    const hasIn = transfers.some(t => t.to === state.walletRaw);
    const hasOut = transfers.some(t => t.from === state.walletRaw);
    dir = hasIn && hasOut ? 'self' : (hasIn ? 'in' : 'out');
    valueNano = transfers.reduce((s, t) => s + (t.type === 'ton' ? t.value : 0), 0);
  }
  const icon = dir === 'in' ? '⬇' : dir === 'out' ? '⬆' : '⇄';
  const accounts = sp.accounts || [];
  const other = accounts.find(a => a.address && a.address !== state.walletRaw) || accounts[0] || {};
  const title = sp.name || type || 'Операция';
  const desc = sp.description || (other.name ? `счёт: ${other.name}` : '');
  const value = sp.value || (valueNano ? formatTon(valueNano) : '');
  const hash = firstAction && firstAction.base_transactions && firstAction.base_transactions[0];

  return { dir, icon, title, desc, value, other, ev, type, hash };
}

function renderTxList(filteredOnly = false) {
  const list = $('txList');
  const { direction, min, asset } = state.filters;
  const views = state.events.map(eventView).filter(v => {
    if (direction === 'in' && v.dir !== 'in') return false;
    if (direction === 'out' && v.dir !== 'out') return false;
    if (asset === 'ton' && v.type !== 'TonTransfer' && !v.value) return false;
    return true;
  });
  list.innerHTML = '';
  if (!views.length) {
    list.innerHTML = '<div style="color:var(--text-faint);font-size:12.5px;padding:20px;text-align:center;">Нет операций за выбранный период/фильтры</div>';
  }
  for (const v of views) {
    const el = document.createElement('div');
    el.className = 'tx-item';
    el.innerHTML = `
      <div class="tx-dir ${v.dir}">${v.icon}</div>
      <div class="tx-main">
        <div class="tx-title">${esc(v.title)}
          <span class="badge badge-${v.dir}">${v.dir === 'in' ? 'вход' : v.dir === 'out' ? 'выход' : 'внутр'}</span>
          ${v.other && v.other.is_scam ? '<span class="badge badge-scam">scam</span>' : ''}
          ${v.ev && v.ev.is_scam ? '<span class="badge badge-scam">событие scam</span>' : ''}
        </div>
        ${v.desc ? `<div class="tx-desc">${esc(v.desc)}</div>` : ''}
        <div class="tx-meta">
          <span>${formatTime(v.ev.timestamp)}</span>
          ${v.other && v.other.name ? `<span>${esc(v.other.name)}</span>` : (v.other && v.other.address ? `<span class="mono">${esc(shortAddr(v.other.address, 5, 5))}</span>` : '')}
          ${v.hash ? `<a target="_blank" rel="noopener" href="https://tonviewer.com/transaction/${esc(v.hash)}">tx ${esc(shortHash(v.hash))} ↗</a>` : ''}
        </div>
      </div>
      <div class="tx-value"><div class="v">${esc(v.value)}</div><div class="t">${formatTime(v.ev.timestamp).split(', ')[1] || ''}</div></div>
    `;
    el.addEventListener('click', () => openTxModal(v));
    list.appendChild(el);
  }
  $('loadMoreBtn').style.display = (!state.allLoaded && state.events.length) ? 'block' : 'none';
}

async function loadMore() {
  if (!state.nextFrom || state.loading) return;
  state.loading = true;
  try {
    const periodDef = PERIODS.find(p => p.id === state.filters.period) || PERIODS[0];
    const startDate = periodDef.days ? Math.floor(Date.now() / 1000) - periodDef.days * 86400 : null;
    const q = { limit: 100, sort_order: 'desc', before_lt: state.nextFrom };
    if (startDate) q.start_date = startDate;
    const data = await tonapi.getEvents(state.walletRaw || state.address, q);
    const batch = data.events || [];
    state.events.push(...batch);
    state.nextFrom = batch.length ? batch[batch.length - 1].lt : null;
    state.allLoaded = batch.length < 100;
    renderTxList();
    renderGraph();
  } catch (e) {
    toast(e.message || 'Ошибка загрузки', 'error');
  } finally {
    state.loading = false;
  }
}

function openTxModal(v) {
  const head = $('txModalHead');
  const body = $('txModalBody');
  const sp = v.sp || (v.ev.actions && v.ev.actions[0] && v.ev.actions[0].simple_preview) || {};
  const dirLabel = v.dir === 'in' ? 'Входящий перевод' : v.dir === 'out' ? 'Исходящий перевод' : 'Внутренняя операция';
  const dirIcon = v.dir === 'in' ? '⬇' : v.dir === 'out' ? '⬆' : '⇄';
  const dirColor = v.dir === 'in' ? '#3ddc84' : v.dir === 'out' ? '#ff9f43' : '#4f8cff';

  // контрагент
  let fromAddr = '', toAddr = '', fromName = '', toName = '';
  const transfers = extractTransfers([v.ev], state.walletRaw);
  if (transfers.length) {
    const t = transfers[0];
    fromAddr = t.from; toAddr = t.to;
    fromName = t.name_from || (entityByAddress(state.entities, t.from) ? entityByAddress(state.entities, t.from).name : '');
    toName = t.name_to || (entityByAddress(state.entities, t.to) ? entityByAddress(state.entities, t.to).name : '');
  } else {
    const accs = (sp.accounts || []).filter(a => a.address);
    const other = accs.find(a => a.address !== state.walletRaw) || accs[0];
    if (other) { toAddr = other.address; toName = other.name || ''; }
    fromAddr = state.walletRaw;
  }

  head.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;">
      <div class="tx-dir ${v.dir}" style="width:40px;height:40px;font-size:20px;">${dirIcon}</div>
      <div style="flex:1;min-width:0;">
        <div class="modal-title">${esc(sp.name || v.type || 'Операция')}</div>
        <div style="font-size:11.5px;color:var(--text-dim);">${dirLabel} · ${formatTime(v.ev.timestamp)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-family:var(--mono);font-weight:800;font-size:18px;color:${dirColor};">${esc(sp.value || v.value || '—')}</div>
        <span class="badge badge-${v.dir}">${esc(dirLabel)}</span>
      </div>
    </div>`;

  let actionsHtml = '';
  for (const a of (v.ev.actions || [])) {
    const asp = a.simple_preview || {};
    const accNames = (asp.accounts || []).map(x => x.name || shortAddr(x.address, 6, 4)).join(', ');
    actionsHtml += `
      <div class="tx-item" style="cursor:default;">
        <div class="tx-dir self" style="font-size:11px;">⚙</div>
        <div class="tx-main">
          <div class="tx-title">${esc(a.type)} <span class="badge ${a.status === 'ok' ? 'badge-ok' : 'badge-fail'}">${esc(a.status || '')}</span></div>
          <div class="tx-desc">${esc(asp.description || '')}</div>
          ${accNames ? `<div class="tx-meta">${esc(accNames)}</div>` : ''}
        </div>
        <div class="tx-value"><div class="v">${esc(asp.value || '')}</div></div>
      </div>`;
  }

  body.innerHTML = `
    ${(fromAddr || toAddr) ? `
    <div class="section-title" style="margin-top:0;">Участники</div>
    <div style="display:grid;gap:8px;">
      <div class="participant-row">
        <span class="p-badge" style="background:rgba(255,159,67,.13);color:var(--orange);">из</span>
        <div style="min-width:0;flex:1;">
          <div style="font-weight:600;font-size:12.5px;">${esc(fromName || (fromAddr === state.walletRaw ? (state.account && state.account.name) || 'искомый кошелёк' : 'адрес'))}</div>
          <div class="addr-big">${esc(fromAddr || '—')} ${fromAddr ? `<span class="copy" data-copy="${esc(fromAddr)}">⧉</span>` : ''}</div>
        </div>
        ${fromAddr && fromAddr !== state.walletRaw ? `<a class="btn btn-sm" data-explore="${esc(toFriendly(fromAddr, true))}" href="#">Открыть</a>` : ''}
      </div>
      <div style="display:flex;align-items:center;justify-content:center;color:var(--text-faint);font-size:11px;">↓</div>
      <div class="participant-row">
        <span class="p-badge" style="background:rgba(61,220,132,.13);color:var(--green);">в</span>
        <div style="min-width:0;flex:1;">
          <div style="font-weight:600;font-size:12.5px;">${esc(toName || (toAddr === state.walletRaw ? (state.account && state.account.name) || 'искомый кошелёк' : 'адрес'))}</div>
          <div class="addr-big">${esc(toAddr || '—')} ${toAddr ? `<span class="copy" data-copy="${esc(toAddr)}">⧉</span>` : ''}</div>
        </div>
        ${toAddr && toAddr !== state.walletRaw ? `<a class="btn btn-sm" data-explore="${esc(toFriendly(toAddr, true))}" href="#">Открыть</a>` : ''}
      </div>
    </div>` : ''}
    <div class="section-title">Свойства</div>
    <div class="kv">
      <div class="k">Время</div><div>${formatTime(v.ev.timestamp)}</div>
      <div class="k">Сумма</div><div style="font-family:var(--mono);font-weight:700;">${esc(sp.value || v.value || '—')}</div>
      <div class="k">Event ID</div><div class="mono">${esc(shortHash(v.ev.event_id, 10))}</div>
      <div class="k">LT</div><div class="mono">${v.ev.lt ?? '—'}</div>
      <div class="k">Статус</div><div>${v.ev.in_progress ? 'в обработке' : 'завершено'}</div>
      ${v.hash ? `<div class="k">Tx</div><div class="mono"><a target="_blank" rel="noopener" href="https://tonviewer.com/transaction/${esc(v.hash)}">${esc(shortHash(v.hash, 12))} ↗</a></div>` : ''}
    </div>
    <div class="section-title">Действия (${(v.ev.actions || []).length})</div>
    ${actionsHtml || '<div style="color:var(--text-faint);">нет данных</div>'}
  `;
  $('txModal').classList.add('open');
}

// ---------- AML ----------
async function renderAML() {
  const el = $('amlPane');
  if (!state.walletRaw) { el.innerHTML = '<div class="empty-state"><div class="big">🛡</div><h2>AML-анализ</h2><p>Откройте адрес, чтобы получить оценку риска.</p></div>'; return; }
  el.innerHTML = '<div style="color:var(--text-faint);font-size:13px;padding:20px;text-align:center;">Оценка риска…</div>';

  const transfers = extractTransfers(state.events, state.walletRaw);
  const { counterparties, stats } = aggregateTransfers(transfers, state.walletRaw);

  // возраст кошелька по самым старым загруженным событиям
  if (stats.first_ts) stats.age_days = (Date.now() / 1000 - stats.first_ts) / 86400;
  stats.jetton_mint_count = state.events.filter(ev => (ev.actions || []).some(a => a.type === 'JettonMint')).length;

  const report = await analyzeAML(state.walletRaw, { account: state.account, counterparties, stats });
  state.aml = report;

  const sevColor = s => s >= 70 ? 'var(--red)' : s >= 40 ? 'var(--orange)' : 'var(--yellow)';
  const levelColor = report.color;
  el.innerHTML = `
    <div class="risk-card">
      <div class="risk-head">
        <div>
          <div class="risk-level" style="color:${levelColor};">${esc(report.level_label)}</div>
          <div style="font-size:11.5px;color:var(--text-faint);">оценка риска AML</div>
        </div>
        <div class="risk-score" style="color:${levelColor};">${report.score}<span style="font-size:13px;">/100</span></div>
      </div>
      <div class="risk-bar"><div class="risk-bar-fill" style="width:${report.score}%;background:${levelColor};"></div></div>
      ${report.matched_entities && report.matched_entities.length ? `
        <div style="font-size:12px;color:var(--text-dim);">Связанные сущности:
          ${report.matched_entities.map(e => `<span class="tag">${esc(e.name)} · риск ${e.risk_level}</span>`).join(' ')}
        </div>` : ''}
    </div>
    <div class="section-title">Сигналы (${report.signals.length})</div>
    ${report.signals.length ? report.signals.map(s => `
      <div class="risk-signal">
        <span class="sev" style="background:${sevColor(s.severity)};"></span>
        <div>
          <div style="font-weight:600;">${esc(s.title)}</div>
          ${s.detail ? `<div style="color:var(--text-faint);font-size:11.5px;margin-top:2px;">${esc(s.detail)}</div>` : ''}
        </div>
      </div>`).join('') : '<div style="color:var(--green);font-size:13px;">Явных риск-сигналов не обнаружено</div>'}
    <div class="action-row">
      <button class="btn btn-sm btn-primary" id="openCaseBtn">📋 Открыть AML-кейс</button>
      <button class="btn btn-sm" id="pdfBtn">📄 Скачать PDF-отчёт</button>
    </div>
    <p style="font-size:10.5px;color:var(--text-faint);margin-top:10px;line-height:1.5;">
      Оценка носит информационный характер и формируется на основе открытых данных TonAPI, базы сущностей и эвристик.
      Не является юридическим заключением.
    </p>
  `;
  $('pdfBtn').addEventListener('click', () => downloadPdfReport());
  $('openCaseBtn').addEventListener('click', async () => {
    try {
      await backendAdmin('/admin/cases', 'POST', {
        address: state.walletRaw,
        friendly_address: state.exploredFriendly,
        score: report.score, level: report.level,
        summary: `AML-анализ ${report.level_label} (${report.score}/100), сигналов: ${report.signals.length}`,
        data: { account: state.account ? { name: state.account.name, is_scam: state.account.is_scam } : null, signals: report.signals },
      });
      toast('Кейс открыт в админке', 'success');
    } catch (e) {
      toast('Нужны права админа: ' + e.message, 'error');
      window.open('/admin.html', '_blank');
    }
  });
}

async function backendAdmin(path, method = 'GET', body = null) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) { const err = new Error((json && json.error) || `HTTP ${res.status}`); err.status = res.status; throw err; }
  return json;
}

// ---------- фильтры ----------
function applyFilters() {
  renderGraph();
  renderTxList();
  if (state.walletRaw) renderAML();
}

function updateUrl() {
  const p = new URLSearchParams();
  if (state.address) p.set('addr', state.address);
  if (state.filters.period !== 'all') p.set('period', state.filters.period);
  if (state.filters.min > 0) p.set('min', String(state.filters.min));
  if (state.filters.direction !== 'all') p.set('dir', state.filters.direction);
  if (state.filters.asset !== 'all') p.set('asset', state.filters.asset);
  history.replaceState(null, '', '/?' + p.toString());
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  const addr = p.get('addr');
  if (addr) state.address = addr;
  if (p.get('period')) state.filters.period = p.get('period');
  if (p.get('min')) state.filters.min = parseFloat(p.get('min')) || 0;
  if (p.get('dir')) state.filters.direction = p.get('dir');
  if (p.get('asset')) state.filters.asset = p.get('asset');
  return addr;
}

// ---------- экспорт CSV ----------
function exportCSV() {
  if (!state.events.length) { toast('Нет данных для экспорта', 'error'); return; }
  const views = state.events.map(eventView);
  const header = ['Время', 'Направление', 'Тип', 'Описание', 'Сумма', 'Контрагент', 'Event ID'];
  const rows = views.map(v => [
    new Date(v.ev.timestamp * 1000).toISOString(),
    v.dir === 'in' ? 'in' : v.dir === 'out' ? 'out' : 'self',
    v.type, (v.desc || '').replace(/"/g, '""'),
    v.value, (v.other && (v.other.name || v.other.address)) || '', v.ev.event_id,
  ]);
  const csv = [header, ...rows].map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ton-trace_${(state.exploredFriendly || state.address).replace(/[^a-zA-Z0-9]/g, '_')}_${state.filters.period}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV выгружен', 'success');
}

// ---------- PDF-отчёт ----------
function buildPdfPayload() {
  if (!state.walletRaw) throw new Error('Адрес не загружен');
  const transfers = extractTransfers(state.events, state.walletRaw);
  const { counterparties, stats } = aggregateTransfers(transfers, state.walletRaw);
  const views = state.events.map(eventView);
  return {
    reportId: (state.exploredFriendly || state.walletRaw).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40),
    address: {
      friendly: state.exploredFriendly || toFriendly(state.walletRaw, true),
      raw: state.walletRaw,
      name: (state.account && state.account.name) || '',
      balance: state.account ? state.account.balance : null,
      status: state.account ? state.account.status : '',
      is_scam: !!(state.account && state.account.is_scam),
      is_wallet: !!(state.account && state.account.is_wallet),
      interfaces: (state.account && state.account.interfaces) || [],
      last_activity: state.account ? state.account.last_activity : null,
    },
    risk: state.aml ? {
      score: state.aml.score, level: state.aml.level, level_label: state.aml.level_label,
      signals: state.aml.signals || [],
    } : { score: 0, level: 'low', level_label: 'Низкий', signals: [] },
    stats,
    entities: (state.aml && state.aml.matched_entities) || [],
    counterparties: counterparties.slice(0, 40).map(c => ({
      name: c.name, address: c.address,
      in_value: c.in_value, out_value: c.out_value,
      in_count: c.in_count, out_count: c.out_count,
    })),
    transactions: views.slice(0, 400).map(v => ({
      timestamp: v.ev.timestamp, dir: v.dir, type: v.type,
      description: (v.desc || v.title || ''),
      value: v.value || '', counterparty: (v.other && (v.other.name || v.other.address)) || '',
      event_id: v.ev.event_id,
    })),
  };
}

async function downloadPdfReport() {
  let payload;
  try {
    payload = buildPdfPayload();
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  toast('Формируем PDF-отчёт…');
  try {
    const res = await fetch('/api/report/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error((j && j.error) || 'HTTP ' + res.status);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const name = (state.exploredFriendly || state.walletRaw).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    a.download = `aml-report_${name}_${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('PDF-отчёт скачан', 'success');
  } catch (e) {
    console.error(e);
    toast('Не удалось сформировать PDF: ' + e.message, 'error');
  }
}

// ---------- демо ----------
function loadDemo() {
  const d = getDemoData();
  state.account = d.account;
  state.walletRaw = d.walletRaw;
  state.events = d.events;
  state.nextFrom = null;
  state.allLoaded = true;
  state.demo = true;
  state.exploredFriendly = '7288.ton';
  $('addressInput').value = '7288.ton';
  $('emptyState').style.display = 'none';
  toast('Демо-данные загружены', 'success');
  rebuildAll();
}

// ---------- сборка ----------
async function rebuildAll() {
  renderGraph();
  renderInfoMain();
  renderTxList();
  renderAML();
  $('pdfToolbarBtn').style.display = state.walletRaw ? 'inline-flex' : 'none';
}

// ---------- init ----------
async function init() {
  renderPeriods();
  setupAutocomplete();

  // кнопки
  $('searchBtn').addEventListener('click', submitSearch);
  $('refreshBtn').addEventListener('click', () => state.address && runExplore({ reset: true }));
  $('shareBtn').addEventListener('click', () => {
    updateUrl();
    copyText(location.href);
  });
  $('csvBtn').addEventListener('click', exportCSV);
  $('demoBtn').addEventListener('click', loadDemo);
  $('loadMoreBtn').addEventListener('click', loadMore);
  $('txModalPdfBtn').addEventListener('click', () => {
    $('txModal').classList.remove('open');
    downloadPdfReport();
  });
  $('pdfToolbarBtn').addEventListener('click', () => downloadPdfReport());
  $('zoomInBtn').addEventListener('click', () => graph && graph.zoomBy(1.3));
  $('zoomOutBtn').addEventListener('click', () => graph && graph.zoomBy(1 / 1.3));
  $('fitBtn').addEventListener('click', () => graph && graph.fitView());

  // фильтры
  $('minAmount').addEventListener('change', () => {
    state.filters.min = parseFloat($('minAmount').value) || 0;
    updateUrl(); applyFilters();
  });
  $('direction').addEventListener('change', () => {
    state.filters.direction = $('direction').value;
    updateUrl(); applyFilters();
  });
  $('assetFilter').addEventListener('change', () => {
    state.filters.asset = $('assetFilter').value;
    updateUrl(); applyFilters();
  });

  // табы
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + b.dataset.tab));
  }));

  // модалка
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).classList.remove('open')));
  document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('open'); }));

  // делегирование кликов: копирование / explore
  document.addEventListener('click', (e) => {
    const copyEl = e.target.closest('[data-copy]');
    if (copyEl) { e.preventDefault(); copyText(copyEl.dataset.copy); return; }
    const exEl = e.target.closest('[data-explore]');
    if (exEl) {
      e.preventDefault();
      $('addressInput').value = exEl.dataset.explore;
      state.address = exEl.dataset.explore;
      updateUrl();
      runExplore({ reset: true });
    }
  });

  // граф
  graph = new ForceGraph($('graphCanvas'), {
    onSelect: (node) => {
      showNodeDetail(node);
      if (node && !node.isMain) openNodeModal(node);
    },
    onExplore: (node) => {
      const addr = node.id.startsWith('entity:') ? null : node.id;
      if (addr && addr !== state.walletRaw) {
        $('addressInput').value = toFriendly(addr, true);
        state.address = toFriendly(addr, true);
        updateUrl();
        toast('Открываем адрес: ' + shortAddr(addr, 6, 4));
        runExplore({ reset: true });
      }
    },
    onHover: (node, info) => showTooltip(node, info),
  });

  // подсказка
  $('graphWrap').addEventListener('mousemove', (e) => {
    const tt = $('tooltip');
    if (tt.style.display === 'block') {
      tt.style.left = (e.clientX + 14) + 'px';
      tt.style.top = (e.clientY + 14) + 'px';
    }
  });

  // источник данных
  try {
    const cfg = await initDataLayer();
    const pill = $('dataSourcePill');
    const mode = getDataSource();
    if (mode === 'direct') { pill.innerHTML = '<span class="dot green"></span><span>TonAPI напрямую (браузер)</span>'; }
    else if (mode === 'backend') { pill.innerHTML = '<span class="dot orange"></span><span>через сервер</span>'; }
    else { pill.innerHTML = '<span class="dot red"></span><span>источник недоступен</span>'; }
  } catch { /* ignore */ }

  // загрузка из URL
  const addr = readUrl();
  if (addr) {
    $('addressInput').value = addr;
    $('minAmount').value = state.filters.min || '';
    $('direction').value = state.filters.direction;
    $('assetFilter').value = state.filters.asset;
    renderPeriods();
    runExplore({ reset: true });
  }
}

// ---------- детали узла ----------
function showNodeDetail(node) {
  const el = $('nodeDetail');
  if (!node) { renderInfoMain(); return; }
  if (node.isMain) { renderInfoMain(); return; }
  const raw = node.id.startsWith('entity:') ? null : node.id;
  const addr = raw || '';
  const name = node.label || '';
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
      <div style="width:34px;height:34px;border-radius:10px;background:${node.fill};display:flex;align-items:center;justify-content:center;font-size:16px;">${node.entity ? '🏷' : '👤'}</div>
      <div>
        <div style="font-weight:700;font-size:15px;">${esc(name)}</div>
        <div style="font-size:11.5px;color:var(--text-faint);">${esc(node.sublabel || (node.entity ? TYPE_LABELS[node.entity.type] || node.entity.type : 'адрес-контрагент'))}</div>
      </div>
    </div>
    ${node.entity ? `<span class="entity-chip">🏷 ${esc(node.entity.name)} <span class="type">${TYPE_LABELS[node.entity.type] || node.entity.type} · риск ${node.entity.risk_level} · ${esc(node.entity.status)}</span></span>` : ''}
    <div class="stat-grid">
      <div class="stat-card"><div class="k">Входящие</div><div class="v green">${formatTon(node.inValue)}</div></div>
      <div class="stat-card"><div class="k">Исходящие</div><div class="v orange">${formatTon(node.outValue)}</div></div>
      <div class="stat-card"><div class="k">Операций (в/из)</div><div class="v" style="font-size:13px;">${node.inCount} / ${node.outCount}</div></div>
      <div class="stat-card"><div class="k">Риск</div><div class="v" style="color:${node.risk >= 75 ? 'var(--red)' : node.risk >= 50 ? 'var(--orange)' : 'var(--text)'};">${node.risk ? node.risk + '/100' : '—'}</div></div>
    </div>
    ${addr ? `<div class="address-box"><span>${esc(addr)}</span><span class="copy" data-copy="${esc(addr)}">⧉</span></div>` : `<div style="font-size:12px;color:var(--text-faint);">Сущность объединяет несколько адресов: ${(state.entities.find(e => e.id === (node.entity && node.entity.id)) || {}).addresses ? state.entities.find(e => e.id === (node.entity && node.entity.id)).addresses.length : ''} шт.</div>`}
    <div class="action-row">
      ${addr ? `
        <button class="btn btn-sm btn-primary" data-explore="${esc(toFriendly(addr, true))}">Открыть в графе</button>
        <a class="btn btn-sm" target="_blank" rel="noopener" href="https://tonviewer.com/${esc(toFriendly(addr, true))}">Tonviewer ↗</a>
      ` : ''}
      ${node.entity ? `<a class="btn btn-sm" href="/admin.html" target="_blank">Управление сущностью</a>` : ''}
    </div>
    ${node.entity && node.entity.description ? `<div class="section-title">Описание</div><div style="font-size:12.5px;color:var(--text-dim);line-height:1.5;">${esc(node.entity.description)}</div>` : ''}
  `;
}

// ---------- поп-ап узла графа ----------
function openNodeModal(node) {
  if (!node) return;
  const body = $('nodeModalBody');
  const raw = node.id.startsWith('entity:') ? null : node.id;
  const addr = raw || '';
  const name = node.label || '';
  const ent = node.entity;
  const addrCount = ent ? ((state.entities.find(e => e.id === ent.id) || {}).addresses || []).length : 0;

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
      <div style="width:42px;height:42px;border-radius:12px;background:${node.fill || '#3a4a66'};display:flex;align-items:center;justify-content:center;font-size:20px;">${ent ? '🏷' : '👤'}</div>
      <div style="min-width:0;">
        <div style="font-weight:700;font-size:16px;">${esc(name)}</div>
        <div style="font-size:11.5px;color:var(--text-faint);">${esc(node.sublabel || (ent ? (TYPE_LABELS[ent.type] || ent.type) : 'адрес-контрагент'))}</div>
      </div>
      ${node.risk ? `<div style="margin-left:auto;text-align:right;"><div class="risk-score" style="font-size:20px;color:${node.risk >= 75 ? 'var(--red)' : node.risk >= 50 ? 'var(--orange)' : 'var(--green)'};">${node.risk}</div><div style="font-size:9.5px;color:var(--text-faint);">риск /100</div></div>` : ''}
    </div>
    ${ent ? `<span class="entity-chip">🏷 ${esc(ent.name)} <span class="type">${TYPE_LABELS[ent.type] || ent.type} · риск ${ent.risk_level} · ${esc(ent.status)}</span></span>` : ''}
    ${ent && ent.description ? `<div style="font-size:12.5px;color:var(--text-dim);line-height:1.5;margin-top:8px;">${esc(ent.description)}</div>` : ''}
    <div class="stat-grid" style="margin-top:12px;">
      <div class="stat-card"><div class="k">Входящие</div><div class="v green">${formatTon(node.inValue)}</div></div>
      <div class="stat-card"><div class="k">Исходящие</div><div class="v orange">${formatTon(node.outValue)}</div></div>
      <div class="stat-card"><div class="k">Операций (в/из)</div><div class="v" style="font-size:13px;">${node.inCount} / ${node.outCount}</div></div>
      <div class="stat-card"><div class="k">Сумма связи</div><div class="v" style="font-size:13px;">${formatTon((node.inValue || 0) + (node.outValue || 0))}</div></div>
    </div>
    ${addr ? `
      <div class="section-title">Адрес</div>
      <div class="address-box"><span>${esc(addr)}</span><span class="copy" data-copy="${esc(addr)}">⧉</span></div>
    ` : (ent ? `<div class="section-title">Сущность</div><div style="font-size:12.5px;color:var(--text-dim);">Объединяет ${addrCount} адрес(а/ов) в одном узле графа</div>` : '')}
    <div class="action-row">
      ${addr && addr !== state.walletRaw ? `<button class="btn btn-sm btn-primary" data-explore="${esc(toFriendly(addr, true))}">Открыть в графе</button>` : ''}
      ${addr ? `<a class="btn btn-sm" target="_blank" rel="noopener" href="https://tonviewer.com/${esc(toFriendly(addr, true))}">Tonviewer ↗</a>
      <a class="btn btn-sm" target="_blank" rel="noopener" href="https://tonapi.io/account/${esc(toFriendly(addr, true))}">TonAPI ↗</a>` : ''}
      ${ent ? `<a class="btn btn-sm" href="/admin.html" target="_blank">В админке</a>` : ''}
    </div>
  `;
  $('nodeModal').classList.add('open');
}

// ---------- тултип ----------
function showTooltip(node, info) {
  const tt = $('tooltip');
  if (!node || !info) { tt.style.display = 'none'; return; }
  tt.innerHTML = `
    <div class="tt-title">${esc(info.label)}</div>
    ${info.sublabel ? `<div style="color:var(--text-faint);font-size:11px;margin-bottom:6px;">${esc(info.sublabel)}</div>` : ''}
    <div class="tt-row"><span>Входящие</span><b>${formatTonShort(info.in_value)} TON · ${info.in_count}</b></div>
    <div class="tt-row"><span>Исходящие</span><b>${formatTonShort(info.out_value)} TON · ${info.out_count}</b></div>
    ${info.risk ? `<div class="tt-row"><span>Риск</span><b style="color:${info.risk >= 75 ? 'var(--red)' : info.risk >= 50 ? 'var(--orange)' : '#3ddc84'}">${info.risk}/100</b></div>` : ''}
    ${info.entity ? `<div class="tt-row"><span>Сущность</span><b>${esc(info.entity.name)}</b></div>` : ''}
  `;
  tt.style.display = 'block';
}

init();
