// server/routes/api.js — публичные и проксирующие маршруты API
'use strict';

const express = require('express');
const ton = require('../ton-client');
const config = require('../config');
const db = require('../db');
const { analyze } = require('../aml');

const router = express.Router();

// ---------- health / config ----------
router.get('/health', (req, res) => {
  res.json({ ok: true, version: '0.1.0', time: Date.now() });
});

router.get('/config', (req, res) => {
  res.json({
    appName: 'TON Trace',
    dataSource: config.dataSourceMode,
    hasAdmin: db.countAdmins() > 0,
    publicTonapiKey: !!config.publicTonapiKey,
    backendTonapi: !!config.tonapiKey,
    maxEventsDefault: config.maxEventsDefault,
  });
});

// ---------- публичный список сущностей (для подписи графа) ----------
router.get('/entities', (req, res) => {
  const entities = db.listEntities().map(e => ({
    id: e.id,
    name: e.name,
    type: e.type,
    risk_level: e.risk_level,
    status: e.status,
    color: e.color,
    logo_url: e.logo_url,
    addresses: e.addresses.map(a => a.address),
  }));
  res.json({ entities });
});

// ---------- прокси TonAPI (используется фронтендом в режиме backend) ----------
router.get('/ton/v2/accounts/search', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name || name.length < 3) return res.status(400).json({ error: 'Минимум 3 символа' });
  try {
    const data = await ton.search(name);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

router.get('/ton/v2/accounts/:account_id', async (req, res) => {
  try {
    const data = await ton.account(req.params.account_id);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

router.get('/ton/v2/accounts/:account_id/events', async (req, res) => {
  try {
    const data = await ton.events(req.params.account_id, {
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      before_lt: req.query.before_lt,
      after_lt: req.query.after_lt,
      start_date: req.query.start_date,
      end_date: req.query.end_date,
      sort_order: req.query.sort_order,
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

router.get('/ton/v2/accounts/:account_id/events/:event_id', async (req, res) => {
  try {
    const data = await ton.accountEvent(req.params.account_id, req.params.event_id);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

router.get('/ton/v2/accounts/:account_id/jettons', async (req, res) => {
  try {
    const data = await ton.jettons(req.params.account_id);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

router.get('/ton/v2/rates', async (req, res) => {
  try {
    const data = await ton.rates();
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// ---------- AML-анализ ----------
// Фронтенд собирает события и отправляет сводку; сервер обогащает базой сущностей и считает риск.
router.post('/aml/analyze', (req, res) => {
  const { address, account = null, counterparties = [], stats = {} } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Не указан адрес' });

  const raw = db.normalizeAddressKey(address) || String(address);
  const entities = db.findEntitiesByAddress(raw);

  // обогащаем контрагентов сущностями
  const enriched = (counterparties || []).map(c => {
    if (!c.address) return c;
    const found = db.findEntitiesByAddress(c.address);
    return { ...c, entity: found.length ? found[0] : null };
  });

  const report = analyze({ address: raw, account, counterparties: enriched, entities, stats });
  res.json({ address: raw, ...report });
});

module.exports = router;
