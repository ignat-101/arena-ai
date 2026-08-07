// public/js/api.js — слой данных: TonAPI напрямую из браузера + фолбэк на серверный прокси
import { parseAddress, toRaw, normalizeAddressKey } from './ton-utils.js';

const TONAPI_BASE = 'https://tonapi.io/v2';

// ---------- состояние источника данных ----------
let dataSource = null; // 'direct' | 'backend' | 'unavailable'
let backendUrl = '';

function detectBackend() {
  // тот же origin, где лежит фронтенд
  return window.location.origin;
}

// Очередь запросов для режима direct (лимит TonAPI без ключа ~1 rps)
let queueChain = Promise.resolve();
let lastDirectCall = 0;
const DIRECT_GAP_MS = 1100;

function enqueue(fn) {
  const run = async () => {
    const wait = lastDirectCall + DIRECT_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastDirectCall = Date.now();
    return fn();
  };
  const p = queueChain.then(run);
  queueChain = p.catch(() => {});
  return p;
}

export async function initDataLayer() {
  backendUrl = detectBackend();

  // 0) Если сервер явно настроен на проксирование — используем его
  try {
    const res = await fetch(`${backendUrl}/api/config`, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.dataSource === 'backend') {
        dataSource = 'backend';
        return { mode: dataSource, ...cfg };
      }
    }
  } catch { /* бэкенд недоступен */ }

  // 1) Пробуем TonAPI напрямую из браузера (быстрее и не зависит от сервера)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${TONAPI_BASE}/status`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (res.ok) {
      dataSource = 'direct';
      return { mode: dataSource };
    }
  } catch { /* CORS/сеть не пускают */ }

  // 2) Фолбэк: прокси через сервер (нужен доступ сервера к TonAPI)
  try {
    const res = await fetch(`${backendUrl}/api/config`, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.backendTonapi) {
        dataSource = 'backend';
        return { mode: dataSource, ...cfg };
      }
    }
  } catch {}
  dataSource = 'unavailable';
  return { mode: dataSource };
}

export function getDataSource() {
  return dataSource;
}

// ---------- базовые запросы ----------

async function directGet(path) {
  return enqueue(async () => {
    const res = await fetch(`${TONAPI_BASE}${path}`, { headers: { Accept: 'application/json' } });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((json && json.error) || `TonAPI ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  });
}

async function backendGet(path) {
  const res = await fetch(`${backendUrl}/api/ton/v2${path}`, { headers: { Accept: 'application/json' } });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((json && json.error) || `Backend ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function tonGet(path) {
  if (dataSource === 'direct') return directGet(path);
  if (dataSource === 'backend') return backendGet(path);
  throw new Error('Нет доступного источника данных TonAPI');
}

export async function backendApi(path, opts = {}) {
  const res = await fetch(`${backendUrl}/api${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((json && json.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---------- высокоуровневые методы ----------

export const tonapi = {
  getAccount: (addr) => tonGet(`/accounts/${encodeURIComponent(addr)}`),
  getEvents: (addr, q = {}) => {
    const sp = new URLSearchParams();
    if (q.limit) sp.set('limit', String(q.limit));
    if (q.before_lt) sp.set('before_lt', String(q.before_lt));
    if (q.start_date) sp.set('start_date', String(q.start_date));
    if (q.end_date) sp.set('end_date', String(q.end_date));
    if (q.sort_order) sp.set('sort_order', q.sort_order);
    return tonGet(`/accounts/${encodeURIComponent(addr)}/events?${sp.toString()}`);
  },
  getJettons: (addr) => tonGet(`/accounts/${encodeURIComponent(addr)}/jettons?limit=100`),
  search: (name) => tonGet(`/accounts/search?name=${encodeURIComponent(name)}`),
  getRates: () => tonGet('/rates?tokens=ton&currencies=usd,rub'),
};

export async function getEntities() {
  try {
    const data = await backendApi('/entities');
    return data.entities || [];
  } catch {
    return [];
  }
}

// ---------- AML ----------
export async function analyzeAML(address, { account, counterparties, stats }) {
  try {
    return await backendApi('/aml/analyze', {
      method: 'POST',
      body: { address, account, counterparties, stats },
    });
  } catch (e) {
    return { score: 0, level: 'low', level_label: 'Низкий', color: '#2fbf71', signals: [], matched_entities: [], error: e.message };
  }
}

// ---------- извлечение переводов из событий ----------

/**
 * Собирает из списка событий направленные переводы (edges).
 * Каждый edge: {from, to, value(nano, только TON), amount(для jetton), symbol, decimals, type, timestamp, event_id, is_scam_from, is_scam_to, name_from, name_to}
 */
export function extractTransfers(events, walletRaw) {
  const out = [];
  const seen = new Set();
  for (const ev of events) {
    const actions = ev.actions || [];
    for (const a of actions) {
      const type = a.type;
      let tx = null;
      if (type === 'TonTransfer' && a.TonTransfer) {
        const t = a.TonTransfer;
        const sender = t.sender && t.sender.address;
        const recipient = t.recipient && t.recipient.address;
        const amount = parseInt(t.amount || t.value, 10);
        if (!sender || !recipient || isNaN(amount)) continue;
        tx = {
          type: 'ton', value: amount, symbol: 'TON', decimals: 9,
          from: sender, to: recipient,
          name_from: t.sender.name || '', name_to: t.recipient.name || '',
          is_scam_from: !!t.sender.is_scam, is_scam_to: !!t.recipient.is_scam,
        };
      } else if (type === 'JettonTransfer' && a.JettonTransfer) {
        const t = a.JettonTransfer;
        const sender = t.sender && t.sender.address;
        const recipient = t.recipient && t.recipient.address;
        const amount = parseInt(t.amount, 10);
        if (!sender || !recipient || isNaN(amount)) continue;
        const jetton = t.jetton || {};
        tx = {
          type: 'jetton', value: amount, symbol: jetton.symbol || 'JETTON', decimals: jetton.decimals ?? 9,
          jetton_address: jetton.address || '',
          from: sender, to: recipient,
          name_from: t.sender.name || '', name_to: t.recipient.name || '',
          is_scam_from: !!t.sender.is_scam, is_scam_to: !!t.recipient.is_scam,
        };
      } else if (type === 'NftTransfer' && a.NftTransfer) {
        const t = a.NftTransfer;
        const sender = t.sender && t.sender.address;
        const recipient = t.recipient && t.recipient.address;
        if (!sender || !recipient) continue;
        tx = {
          type: 'nft', value: 0, symbol: 'NFT', decimals: 0,
          from: sender, to: recipient,
          name_from: t.sender.name || '', name_to: t.recipient.name || '',
          is_scam_from: !!t.sender.is_scam, is_scam_to: !!t.recipient.is_scam,
        };
      } else if (!/^(Jetton|Nft|NftItem|Auctions)/i.test(type)) {
        // прочие действия (стейкинг, контракты и т.п.): через simple_preview.accounts и value
        const sp = a.simple_preview;
        if (sp && sp.accounts && sp.value) {
          const accs = sp.accounts.filter(x => x.address);
          // контрагент — единственный аккаунт, не являющийся искомым кошельком
          const others = accs.filter(x => x.address !== walletRaw);
          const other = others.length === 1 ? others[0] : (accs.length === 1 ? accs[0] : null);
          if (other) {
            const valueMatch = String(sp.value).match(/([\d.,]+)\s*([A-Za-z0-9-]+)?/);
            if (valueMatch) {
              const amount = parseFloat(valueMatch[1].replace(',', '.'));
              if (!isNaN(amount)) {
                const isFrom = other.address !== walletRaw;
                tx = {
                  type: 'other', value: amount * 1e9, symbol: valueMatch[2] || '', decimals: 9,
                  from: isFrom ? other.address : walletRaw,
                  to: isFrom ? walletRaw : other.address,
                  name_from: isFrom ? (other.name || '') : '', name_to: isFrom ? '' : (other.name || ''),
                  is_scam_from: false, is_scam_to: false,
                  action_type: type,
                };
              }
            }
          }
        }
      }
      if (!tx) continue;
      const key = `${tx.from}|${tx.to}|${tx.type}|${tx.value}|${ev.event_id || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tx.timestamp = ev.timestamp;
      tx.event_id = ev.event_id;
      tx.is_scam_event = !!ev.is_scam;
      out.push(tx);
    }
  }
  return out;
}

/** Агрегирует переводы в связи для графа и статистики. */
export function aggregateTransfers(transfers, walletRaw) {
  const edges = new Map(); // key = sorted pair + direction
  const counterpartyMeta = new Map();
  const stats = {
    in_value: 0, out_value: 0,
    in_count: 0, out_count: 0,
    tx_count: transfers.length,
    jetton_mint_count: 0,
    unique_counterparties: 0,
    first_ts: Infinity,
    last_ts: 0,
  };

  for (const t of transfers) {
    if (t.timestamp < stats.first_ts) stats.first_ts = t.timestamp;
    if (t.timestamp > stats.last_ts) stats.last_ts = t.timestamp;

    const isIn = t.to === walletRaw;
    const cp = isIn ? t.from : t.to;
    if (!cp) continue;
    if (!counterpartyMeta.has(cp)) {
      counterpartyMeta.set(cp, {
        address: cp,
        name: isIn ? t.name_from : t.name_to,
        is_scam: isIn ? t.is_scam_from : t.is_scam_to,
        in_value: 0, out_value: 0, in_count: 0, out_count: 0,
      });
    }
    const meta = counterpartyMeta.get(cp);
    if (isIn) {
      meta.in_value += t.type === 'ton' ? t.value : 0;
      meta.in_count++;
      stats.in_value += t.type === 'ton' ? t.value : 0;
      stats.in_count++;
    } else {
      meta.out_value += t.type === 'ton' ? t.value : 0;
      meta.out_count++;
      stats.out_value += t.type === 'ton' ? t.value : 0;
      stats.out_count++;
    }
  }

  const counterparties = [...counterpartyMeta.values()];
  stats.unique_counterparties = counterparties.length;
  if (stats.first_ts === Infinity) stats.first_ts = 0;

  // Графовые рёбра (агрегированные по паре адресов и направлению)
  const agg = new Map();
  for (const t of transfers) {
    const isIn = t.to === walletRaw;
    const cp = isIn ? t.from : t.to;
    if (!cp) continue;
    const key = isIn ? `in:${cp}` : `out:${cp}`;
    let e = agg.get(key);
    if (!e) {
      e = { counterparty: cp, direction: isIn ? 'in' : 'out', value: 0, count: 0, ton_value: 0 };
      agg.set(key, e);
    }
    e.count++;
    e.value += t.value;
    if (t.type === 'ton') e.ton_value += t.value;
  }

  return { edges: [...agg.values()], counterparties, stats };
}

// ---------- explore: загрузка событий по периоду ----------

export const PERIODS = [
  { id: 'all', label: 'Всё', days: null },
  { id: '1d', label: '1Д', days: 1 },
  { id: '7d', label: '7Д', days: 7 },
  { id: '30d', label: '30Д', days: 30 },
  { id: '90d', label: '90Д', days: 90 },
  { id: '180d', label: '180Д', days: 180 },
  { id: '1y', label: '1Г', days: 365 },
];

export async function exploreAccount(addressInput, {
  period = 'all',
  maxEvents = 1000,
  pageSize = 100,
  onProgress = null,
} = {}) {
  const parsed = parseAddress(addressInput);
  if (parsed.error) throw new Error(parsed.error);

  const periodDef = PERIODS.find(p => p.id === period) || PERIODS[0];
  const startDate = periodDef.days ? Math.floor(Date.now() / 1000) - periodDef.days * 86400 : null;

  // 1) аккаунт
  const account = await tonapi.getAccount(parsed.friendly || addressInput);

  // 2) события постранично
  const events = [];
  let before_lt = null;
  let pages = 0;
  const maxPages = Math.ceil(maxEvents / pageSize) + 1;
  let extra = null;

  while (pages < maxPages) {
    const q = { limit: pageSize, sort_order: 'desc' };
    if (before_lt) q.before_lt = before_lt;
    if (startDate) q.start_date = startDate;
    const data = await tonapi.getEvents(parsed.friendly || addressInput, q);
    const batch = data.events || [];
    if (!batch.length) break;
    events.push(...batch);
    pages++;
    if (onProgress) onProgress({ events: events.length, page: pages });
    extra = data.extra !== undefined ? data.extra : null;
    before_lt = data.next_from || batch[batch.length - 1].lt;
    if (data.next_from === undefined) {
      // достигли конца (или next_from отсутствует) — стоп
      const lastTs = batch[batch.length - 1].timestamp;
      if (startDate && lastTs < startDate) break;
      if (batch.length < pageSize) break;
    }
    if (batch.length < pageSize) break;
  }

  return {
    account,
    events,
    walletRaw: normalizeAddressKey(account.address || parsed.friendly) || (parsed.raw || ''),
    parsed,
    startDate,
    pages,
    extra,
  };
}

// ---------- демо-режим ----------
export function getDemoData() {
  // Локальные демо-данные, чтобы интерфейс можно было посмотреть без доступа к TonAPI
  const walletRaw = '0:9f772adbd058fc940df639f8b34f0198f36f6d4f38a1b04625d45ae907379529';
  const now = Math.floor(Date.now() / 1000);
  const mk = (deltaHours) => now - deltaHours * 3600;
  const events = [
    { event_id: 'demo-1', timestamp: mk(2), account: { name: '7288.ton', is_scam: false, is_wallet: true },
      actions: [{ type: 'TonTransfer', status: 'ok',
        TonTransfer: { sender: { address: '0:1111111111111111111111111111111111111111111111111111111111111111', name: 'Bybit 1', is_scam: false },
          recipient: { address: walletRaw, name: '7288.ton', is_scam: false }, amount: 15000000000 },
        simple_preview: { name: 'Transfer', description: 'Deposit', value: '15 TON' } }] },
    { event_id: 'demo-2', timestamp: mk(5), account: { name: '7288.ton', is_scam: false, is_wallet: true },
      actions: [{ type: 'JettonTransfer', status: 'ok',
        JettonTransfer: { sender: { address: walletRaw, name: '7288.ton', is_scam: false },
          recipient: { address: '0:2222222222222222222222222222222222222222222222222222222222222222', name: 'binance12.ton', is_scam: true },
          amount: 5000000000, jetton: { address: '0:aa0ba121449feda569e02b12fa755d24e834a7454aecf4649590b6df742aac8f', symbol: 'STAKED', decimals: 9 } },
        simple_preview: { name: 'Jetton Transfer', description: 'Transfer 5 STAKED', value: '5 STAKED' } }] },
    { event_id: 'demo-3', timestamp: mk(9), account: { name: '7288.ton', is_scam: false, is_wallet: true },
      actions: [{ type: 'TonTransfer', status: 'ok',
        TonTransfer: { sender: { address: '0:3333333333333333333333333333333333333333333333333333333333333333', name: '', is_scam: false },
          recipient: { address: walletRaw, name: '7288.ton', is_scam: false }, amount: 3200000000 },
        simple_preview: { name: 'Transfer', description: 'Incoming', value: '3.2 TON' } }] },
    { event_id: 'demo-4', timestamp: mk(14), account: { name: '7288.ton', is_scam: false, is_wallet: true },
      actions: [{ type: 'TonTransfer', status: 'ok',
        TonTransfer: { sender: { address: walletRaw, name: '7288.ton', is_scam: false },
          recipient: { address: '0:4444444444444444444444444444444444444444444444444444444444444444', name: '', is_scam: false }, amount: 900000000 },
        simple_preview: { name: 'Transfer', description: 'Outgoing', value: '0.9 TON' } }] },
    { event_id: 'demo-5', timestamp: mk(22), account: { name: '7288.ton', is_scam: false, is_wallet: true },
      actions: [{ type: 'DepositStake', status: 'ok',
        DepositStake: { staker: { address: walletRaw, name: '7288.ton', is_scam: false },
          pool: { address: '0:f6ff877dd4ce1355b101572045f09d54c29309737eb52ca542cfa6c195f7cc5b', name: 'Stakee', is_scam: false },
          amount: 10000000000 },
        simple_preview: { name: 'Deposit Stake', description: 'Deposit 10 Gram to staking pool', value: '10 TON' } }] },
    { event_id: 'demo-6', timestamp: mk(30), account: { name: '7288.ton', is_scam: false, is_wallet: true },
      actions: [{ type: 'TonTransfer', status: 'ok',
        TonTransfer: { sender: { address: '0:5555555555555555555555555555555555555555555555555555555555555555', name: 'OKX 3', is_scam: false },
          recipient: { address: walletRaw, name: '7288.ton', is_scam: false }, amount: 45000000000 },
        simple_preview: { name: 'Transfer', description: 'Deposit', value: '45 TON' } }] },
    { event_id: 'demo-7', timestamp: mk(40), account: { name: '7288.ton', is_scam: false, is_wallet: true },
      actions: [{ type: 'TonTransfer', status: 'ok',
        TonTransfer: { sender: { address: walletRaw, name: '7288.ton', is_scam: false },
          recipient: { address: '0:6666666666666666666666666666666666666666666666666666666666666666', name: 'Bybit 3', is_scam: false }, amount: 12000000000 },
        simple_preview: { name: 'Transfer', description: 'Withdraw', value: '12 TON' } }] },
  ];
  return {
    account: { address: '0:' + walletRaw.split(':')[1], name: '7288.ton', balance: 10339806878, status: 'active', is_scam: false, is_wallet: true, interfaces: ['wallet_v5r1'] },
    events,
    walletRaw,
    demo: true,
  };
}
