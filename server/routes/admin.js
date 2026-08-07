// server/routes/admin.js — админка: аутентификация, сущности, коды доступа, AML-кейсы, аудит
'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const ton = require('../ton-client');

const router = express.Router();

// ---------- аутентификация ----------
router.post('/register', (req, res) => {
  const { code, username, password } = req.body || {};
  if (!code || !username || !password) return res.status(400).json({ error: 'Заполните код, логин и пароль' });
  if (String(username).length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  if (db.getAdminByUsername(username)) return res.status(409).json({ error: 'Логин уже занят' });

  let role = null;
  let source = '';
  const isMaster = code === config.adminMasterCode;
  if (isMaster) {
    role = db.countAdmins() === 0 ? 'superadmin' : 'superadmin';
    source = 'master-code';
  } else {
    const c = db.getCode(code);
    if (!c) return res.status(403).json({ error: 'Неверный код доступа' });
    if (c.expires_at && c.expires_at < Date.now()) {
      db.deleteCode(code);
      return res.status(403).json({ error: 'Код доступа истёк' });
    }
    role = c.role;
    source = `invite:${c.id}`;
    db.consumeCode(c.id);
  }

  const salt = auth.makeSalt();
  const adminId = db.createAdmin(String(username), auth.hashPassword(password, salt), salt, role, source);
  const token = auth.randomToken();
  const exp = db.createSession(token, adminId, config.sessionTtlMs);
  auth.setSessionCookie(res, token, exp);
  db.audit(username, 'admin.register', `role=${role}`);
  res.json({ ok: true, admin: db.getAdminById(adminId) });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.getAdminByUsername(String(username || ''));
  if (!admin || !auth.verifyPassword(admin, String(password || ''))) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = auth.randomToken();
  const exp = db.createSession(token, admin.id, config.sessionTtlMs);
  auth.setSessionCookie(res, token, exp);
  db.audit(admin.username, 'admin.login', '');
  res.json({ ok: true, admin: db.getAdminById(admin.id) });
});

router.post('/logout', auth.requireAdmin, (req, res) => {
  const token = auth.parseCookies(req)[auth.COOKIE_NAME];
  db.deleteSession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', auth.requireAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

// ---------- админы и коды (superadmin) ----------
router.get('/admins', auth.requireRole('superadmin'), (req, res) => {
  res.json({ admins: db.listAdmins() });
});

router.post('/admins/:id/role', auth.requireRole('superadmin'), (req, res) => {
  const { role } = req.body || {};
  if (!['superadmin', 'admin', 'analyst'].includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
  const target = db.getAdminById(parseInt(req.params.id, 10));
  if (!target) return res.status(404).json({ error: 'Админ не найден' });
  if (target.id === req.admin.id) return res.status(400).json({ error: 'Нельзя менять собственную роль' });
  db.updateAdminRole(target.id, role);
  db.audit(req.admin.username, 'admin.role', `${target.username} -> ${role}`);
  res.json({ ok: true });
});

router.post('/invite', auth.requireRole('superadmin'), (req, res) => {
  const { role = 'admin', uses = 1, note = '' } = req.body || {};
  const code = auth.randomCode(8);
  const expiresAt = req.body.expires_in_hours ? Date.now() + parseInt(req.body.expires_in_hours, 10) * 3600 * 1000 : null;
  db.createCode(code, role, Math.max(1, parseInt(uses, 10) || 1), expiresAt, String(note), req.admin.username);
  db.audit(req.admin.username, 'admin.invite', `role=${role}, uses=${uses}`);
  res.json({ code, role, uses: Math.max(1, parseInt(uses, 10) || 1), expires_at: expiresAt, note });
});

router.get('/codes', auth.requireRole('superadmin'), (req, res) => {
  res.json({ codes: db.listCodes() });
});

router.delete('/codes/:code', auth.requireRole('superadmin'), (req, res) => {
  db.deleteCode(req.params.code);
  db.audit(req.admin.username, 'admin.code.revoke', req.params.code);
  res.json({ ok: true });
});

// ---------- сущности (admin+) ----------
router.get('/entities', auth.requireRole('admin'), (req, res) => {
  res.json({ entities: db.listEntities() });
});

router.post('/entities', auth.requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Укажите название' });
  const entity = db.createEntity({
    name: String(b.name).trim(),
    type: String(b.type || 'other'),
    risk_level: parseInt(b.risk_level, 10) || 0,
    status: String(b.status || 'active'),
    description: String(b.description || ''),
    tags: Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    source: 'manual',
    logo_url: String(b.logo_url || ''),
    color: String(b.color || ''),
    addresses: Array.isArray(b.addresses) ? b.addresses : [],
    created_by: req.admin.username,
  });
  db.audit(req.admin.username, 'entity.create', `#${entity.id} ${entity.name}`);
  res.json({ entity });
});

router.put('/entities/:id', auth.requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const entity = db.updateEntity(parseInt(req.params.id, 10), b);
  if (!entity) return res.status(404).json({ error: 'Сущность не найдена' });
  db.audit(req.admin.username, 'entity.update', `#${entity.id} ${entity.name}`);
  res.json({ entity });
});

router.delete('/entities/:id', auth.requireRole('admin'), (req, res) => {
  const e = db.getEntityById(parseInt(req.params.id, 10));
  if (!e) return res.status(404).json({ error: 'Сущность не найдена' });
  db.deleteEntity(e.id);
  db.audit(req.admin.username, 'entity.delete', `#${e.id} ${e.name}`);
  res.json({ ok: true });
});

router.post('/entities/:id/addresses', auth.requireRole('admin'), (req, res) => {
  const { address, note } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Укажите адрес' });
  const addr = db.addEntityAddress(parseInt(req.params.id, 10), address, String(note || ''), req.admin.username);
  if (!addr) return res.status(400).json({ error: 'Некорректный адрес' });
  res.json({ ok: true, address: addr });
});

router.delete('/entity-addresses/:id', auth.requireRole('admin'), (req, res) => {
  db.removeEntityAddress(parseInt(req.params.id, 10));
  db.audit(req.admin.username, 'entity.address.remove', req.params.id);
  res.json({ ok: true });
});

// ---------- импорт сущностей из TonAPI (admin+) ----------
router.post('/entities/import/search', auth.requireRole('admin'), async (req, res) => {
  const { name } = req.body || {};
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'Минимум 3 символа' });
  try {
    const data = await ton.search(String(name).trim());
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

router.post('/entities/import/bulk', auth.requireRole('admin'), (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Пустой список' });
  const created = [];
  for (const item of items) {
    if (!item || !item.name || !Array.isArray(item.addresses) || !item.addresses.length) continue;
    const entity = db.createEntity({
      name: item.name,
      type: String(item.type || 'exchange'),
      risk_level: parseInt(item.risk_level, 10) || 0,
      status: 'active',
      description: String(item.description || 'Импортировано из TonAPI'),
      tags: ['tonapi', 'imported'],
      source: 'tonapi-import',
      logo_url: String(item.logo_url || ''),
      addresses: item.addresses.map(a => ({ address: a.address, note: a.name || '' })),
      created_by: req.admin.username,
    });
    created.push(entity);
    db.audit(req.admin.username, 'entity.import', `#${entity.id} ${entity.name} (${item.addresses.length} адресов)`);
  }
  res.json({ ok: true, created: created.length });
});

// ---------- AML-кейсы (admin+) ----------
router.get('/cases', auth.requireRole('admin'), (req, res) => {
  res.json({ cases: db.listCases(req.query.status || null) });
});

router.post('/cases', auth.requireRole('admin'), (req, res) => {
  const { address, friendly_address = '', score, level, summary = '', data = {} } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Не указан адрес' });
  const id = db.createCase({
    address: String(address),
    friendly_address: String(friendly_address),
    score: parseInt(score, 10) || 0,
    level: String(level || 'medium'),
    summary: String(summary),
    data,
    created_by: req.admin.username,
  });
  db.audit(req.admin.username, 'case.open', `#${id} ${address} score=${score}`);
  res.json({ ok: true, id });
});

router.post('/cases/:id/status', auth.requireRole('admin'), (req, res) => {
  const { status, note = '' } = req.body || {};
  if (!['open', 'investigating', 'resolved', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Недопустимый статус' });
  }
  const c = db.updateCaseStatus(parseInt(req.params.id, 10), status, String(note));
  if (!c) return res.status(404).json({ error: 'Кейс не найден' });
  db.audit(req.admin.username, 'case.status', `#${c.id} -> ${status}`);
  res.json({ ok: true, case: c });
});

// ---------- аудит (admin+) ----------
router.get('/audit', auth.requireRole('admin'), (req, res) => {
  res.json({ entries: db.listAudit(parseInt(req.query.limit, 10) || 200) });
});

module.exports = router;
