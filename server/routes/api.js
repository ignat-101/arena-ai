// server/routes/api.js — публичные и проксирующие маршруты API
'use strict';

const express = require('express');
const ton = require('../ton-client');
const config = require('../config');
const db = require('../db');
const { analyze } = require('../aml');
const { buildAmlPdf } = require('../report');

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

// ---------- PDF AML-отчёт ----------
router.post('/report/pdf', async (req, res) => {
  const body = req.body || {};
  if (!body.address || (!body.address.raw && !body.address.friendly)) {
    return res.status(400).json({ error: 'Не указан адрес' });
  }
  // ограничиваем объёмы данных
  const sanitized = {
    reportId: String(body.reportId || '').slice(0, 64),
    address: {
      friendly: String(body.address.friendly || '').slice(0, 120),
      raw: String(body.address.raw || '').slice(0, 120),
      name: String(body.address.name || '').slice(0, 80),
      balance: body.address.balance ?? null,
      status: String(body.address.status || '').slice(0, 20),
      is_scam: !!body.address.is_scam,
      is_wallet: !!body.address.is_wallet,
      interfaces: Array.isArray(body.address.interfaces) ? body.address.interfaces.slice(0, 6) : [],
      last_activity: body.address.last_activity ?? null,
    },
    risk: {
      score: Math.max(0, Math.min(100, parseInt(body.risk?.score, 10) || 0)),
      level: String(body.risk?.level || 'low').slice(0, 20),
      level_label: String(body.risk?.level_label || '').slice(0, 40),
      signals: (Array.isArray(body.risk?.signals) ? body.risk.signals : []).slice(0, 12).map(s => ({
        title: String(s.title || '').slice(0, 200),
        severity: parseInt(s.severity, 10) || 0,
        detail: String(s.detail || '').slice(0, 300),
      })),
    },
    stats: {
      in_value: Number(body.stats?.in_value) || 0,
      out_value: Number(body.stats?.out_value) || 0,
      tx_count: parseInt(body.stats?.tx_count, 10) || 0,
      unique_counterparties: parseInt(body.stats?.unique_counterparties, 10) || 0,
      age_days: body.stats?.age_days ?? null,
    },
    entities: (Array.isArray(body.entities) ? body.entities : []).slice(0, 20).map(e => ({
      name: String(e.name || '').slice(0, 120),
      type: String(e.type || '').slice(0, 40),
      risk_level: parseInt(e.risk_level, 10) || 0,
      status: String(e.status || '').slice(0, 20),
    })),
    counterparties: (Array.isArray(body.counterparties) ? body.counterparties : []).slice(0, 40).map(c => ({
      name: String(c.name || '').slice(0, 120),
      address: String(c.address || '').slice(0, 120),
      in_value: Number(c.in_value) || 0,
      out_value: Number(c.out_value) || 0,
      in_count: parseInt(c.in_count, 10) || 0,
      out_count: parseInt(c.out_count, 10) || 0,
    })),
    transactions: (Array.isArray(body.transactions) ? body.transactions : []).slice(0, 400).map(t => ({
      timestamp: t.timestamp ?? null,
      dir: String(t.dir || 'self').slice(0, 8),
      type: String(t.type || '').slice(0, 60),
      description: String(t.description || '').slice(0, 200),
      value: String(t.value || '').slice(0, 60),
      counterparty: String(t.counterparty || '').slice(0, 160),
      event_id: String(t.event_id || '').slice(0, 80),
    })),
  };
  try {
    const pdf = await buildAmlPdf(sanitized);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="aml-report-${Date.now()}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('[report/pdf]', e);
    res.status(500).json({ error: 'Не удалось сформировать отчёт' });
  }
});

module.exports = router;
