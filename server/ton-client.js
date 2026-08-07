// server/ton-client.js — клиент TonAPI (tonapi.io) для серверного проксирования
'use strict';

const config = require('./config');

const BASE = 'https://tonapi.io/v2';
const CACHE_TTL_MS = 90 * 1000;
const cache = new Map(); // key -> {ts, data}

// Простая очередь с ограничением частоты запросов
let lastCall = 0;
let chain = Promise.resolve();
const minGapMs = () => (config.tonapiKey ? 200 : 1100);

async function rateLimitedFetch(url, options = {}, retries = 2) {
  const gap = minGapMs();
  const run = async () => {
    const wait = lastCall + gap - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, options);
        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (res.status >= 500 && attempt < retries) {
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        if (!res.ok) {
          const err = new Error(`TonAPI ${res.status}: ${json && json.error ? json.error : text.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
        return json;
      } catch (e) {
        lastErr = e;
        if (e.status && e.status < 500 && e.status !== 429) throw e;
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('TonAPI request failed');
  };
  const res = chain.then(run);
  chain = res.catch(() => {});
  return res;
}

function cacheKey(path) {
  return path.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 200);
}

async function get(path, { noCache = false, ttl = CACHE_TTL_MS } = {}) {
  const key = cacheKey(path);
  if (!noCache && cache.has(key)) {
    const hit = cache.get(key);
    if (Date.now() - hit.ts < ttl) return hit.data;
    cache.delete(key);
  }
  const url = `${BASE}${path}`;
  const headers = { Accept: 'application/json' };
  if (config.tonapiKey) headers.Authorization = `Bearer ${config.tonapiKey}`;
  const data = await rateLimitedFetch(url, { headers });
  if (!noCache) {
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    cache.set(key, { ts: Date.now(), data });
  }
  return data;
}

const ton = {
  account: (address) => get(`/accounts/${encodeURIComponent(address)}`),
  events: (address, q) => {
    const sp = new URLSearchParams();
    if (q.limit) sp.set('limit', String(q.limit));
    if (q.before_lt) sp.set('before_lt', String(q.before_lt));
    if (q.after_lt) sp.set('after_lt', String(q.after_lt));
    if (q.start_date) sp.set('start_date', String(q.start_date));
    if (q.end_date) sp.set('end_date', String(q.end_date));
    if (q.sort_order) sp.set('sort_order', q.sort_order);
    return get(`/accounts/${encodeURIComponent(address)}/events?${sp.toString()}`);
  },
  jettons: (address) => get(`/accounts/${encodeURIComponent(address)}/jettons?limit=100`),
  search: (name) => get(`/accounts/search?name=${encodeURIComponent(name)}`, { noCache: true }),
  accountEvent: (address, eventId) => get(`/accounts/${encodeURIComponent(address)}/events/${eventId}`),
  rates: () => get('/rates?tokens=ton&currencies=usd,rub', { noCache: true, ttl: 60 * 1000 }),
};

module.exports = ton;
