// server/db.js — слой данных (SQLite через встроенный node:sqlite)
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT DEFAULT '',
  type TEXT NOT NULL DEFAULT 'other',
  risk_level INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  source TEXT DEFAULT 'manual',
  logo_url TEXT DEFAULT '',
  color TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS entity_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  note TEXT DEFAULT '',
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ea_addr ON entity_addresses(address);
CREATE INDEX IF NOT EXISTS idx_ea_ent ON entity_addresses(entity_id);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  created_by TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admin_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  uses_total INTEGER NOT NULL DEFAULT 1,
  uses_left INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aml_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  friendly_address TEXT DEFAULT '',
  score INTEGER NOT NULL,
  level TEXT NOT NULL,
  summary TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  data TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
`);

const now = () => Date.now();

// ---------- Entities ----------
function listEntities() {
  const rows = db.prepare('SELECT * FROM entities ORDER BY name').all();
  const addrs = db.prepare('SELECT entity_id, address, note FROM entity_addresses').all();
  const byEntity = {};
  for (const a of addrs) {
    (byEntity[a.entity_id] ||= []).push(a);
  }
  return rows.map(r => ({ ...r, tags: safeJson(r.tags, []), addresses: byEntity[r.id] || [] }));
}

function getEntityById(id) {
  const r = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!r) return null;
  const addresses = db.prepare('SELECT id, address, note FROM entity_addresses WHERE entity_id = ?').all(r.id);
  return { ...r, tags: safeJson(r.tags, []), addresses };
}

function findEntitiesByAddress(raw) {
  const addr = normalizeAddressKey(raw);
  if (!addr) return [];
  const rows = db.prepare(
    `SELECT e.* FROM entity_addresses ea JOIN entities e ON e.id = ea.entity_id
     WHERE ea.address = ? OR ea.address = ?`
  ).all(addr, addr.startsWith('0:') ? addr : `0:${addr}`);
  return rows.map(r => ({ ...r, tags: safeJson(r.tags, []) }));
}

function createEntity({ name, type = 'other', risk_level = 0, status = 'active', description = '', tags = [], source = 'manual', logo_url = '', color = '', addresses = [], created_by = '' }) {
  const ts = now();
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const info = db.prepare(
    `INSERT INTO entities (name, slug, type, risk_level, status, description, tags, source, logo_url, color, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(String(name), slug, type, intClamp(risk_level, 0, 100), status, String(description), JSON.stringify(tags || []), source, logo_url || '', color || '', ts, ts, created_by || '');
  const id = Number(info.lastInsertRowid);
  for (const a of (addresses || [])) {
    if (a && a.address) addEntityAddress(id, a.address, a.note || '', created_by);
  }
  return getEntityById(id);
}

function updateEntity(id, patch) {
  const cur = getEntityById(id);
  if (!cur) return null;
  const fields = ['name', 'type', 'risk_level', 'status', 'description', 'tags', 'logo_url', 'color'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (patch[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(f === 'tags' ? JSON.stringify(patch[f] || []) : (f === 'risk_level' ? intClamp(patch[f], 0, 100) : String(patch[f])));
    }
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(now());
    db.prepare(`UPDATE entities SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  return getEntityById(id);
}

function deleteEntity(id) {
  db.prepare('DELETE FROM entities WHERE id = ?').run(id);
}

function addEntityAddress(entityId, address, note = '', by = '') {
  const raw = normalizeAddressKey(address);
  if (!raw) return null;
  const exists = db.prepare('SELECT id FROM entity_addresses WHERE entity_id = ? AND address = ?').get(entityId, raw);
  if (exists) return { id: exists.id, address: raw, note };
  const info = db.prepare('INSERT INTO entity_addresses (entity_id, address, note, added_at) VALUES (?, ?, ?, ?)')
    .run(entityId, raw, String(note), now());
  audit(by, 'entity.address.add', `${entityId} ${raw}`);
  return { id: Number(info.lastInsertRowid), address: raw, note };
}

function removeEntityAddress(id) {
  db.prepare('DELETE FROM entity_addresses WHERE id = ?').run(id);
}

// ---------- Admins / codes / sessions ----------
function createAdmin(username, passHash, salt, role, createdBy) {
  const info = db.prepare('INSERT INTO admins (username, pass_hash, salt, role, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, passHash, salt, role, now(), createdBy || '');
  return Number(info.lastInsertRowid);
}

function getAdminByUsername(username) {
  return db.prepare('SELECT * FROM admins WHERE lower(username) = lower(?)').get(username);
}

function getAdminById(id) {
  return db.prepare('SELECT id, username, role, created_at, created_by FROM admins WHERE id = ?').get(id);
}

function listAdmins() {
  return db.prepare('SELECT id, username, role, created_at, created_by FROM admins ORDER BY id').all();
}

function updateAdminRole(id, role) {
  db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(role, id);
}

function countAdmins() {
  return Number(db.prepare('SELECT COUNT(*) c FROM admins').get().c);
}

function createCode(code, role, uses, expiresAt, note, createdBy) {
  const info = db.prepare(
    'INSERT INTO admin_codes (code, role, uses_total, uses_left, expires_at, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(code, role, uses, uses, expiresAt || null, note || '', now(), createdBy || '');
  return Number(info.lastInsertRowid);
}

function getCode(code) {
  return db.prepare('SELECT * FROM admin_codes WHERE code = ?').get(code);
}

function consumeCode(id) {
  const c = db.prepare('SELECT * FROM admin_codes WHERE id = ?').get(id);
  if (!c) return false;
  if (c.uses_left > 1) {
    db.prepare('UPDATE admin_codes SET uses_left = uses_left - 1 WHERE id = ?').run(id);
  } else {
    db.prepare('DELETE FROM admin_codes WHERE id = ?').run(id);
  }
  return true;
}

function listCodes() {
  return db.prepare('SELECT * FROM admin_codes ORDER BY id DESC').all();
}

function deleteCode(code) {
  db.prepare('DELETE FROM admin_codes WHERE code = ?').run(code);
}

function createSession(token, adminId, ttlMs) {
  const exp = now() + ttlMs;
  db.prepare('INSERT INTO sessions (token, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, adminId, now(), exp);
  return exp;
}

function getSession(token) {
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return s;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---------- AML cases ----------
function createCase({ address, friendly_address = '', score, level, summary = '', data = {}, created_by = '' }) {
  const ts = now();
  const info = db.prepare(
    `INSERT INTO aml_cases (address, friendly_address, score, level, summary, status, data, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(String(address), String(friendly_address), intClamp(score, 0, 100), level, String(summary), JSON.stringify(data || {}), ts, ts, created_by || '');
  return Number(info.lastInsertRowid);
}

function listCases(status) {
  if (status) {
    return db.prepare('SELECT * FROM aml_cases WHERE status = ? ORDER BY id DESC').all(status);
  }
  return db.prepare('SELECT * FROM aml_cases ORDER BY id DESC').all();
}

function updateCaseStatus(id, status, note) {
  db.prepare('UPDATE aml_cases SET status = ?, summary = summary || ?, updated_at = ? WHERE id = ?')
    .run(status, note ? `\n${note}` : '', now(), id);
  return db.prepare('SELECT * FROM aml_cases WHERE id = ?').get(id);
}

function getCaseById(id) {
  const c = db.prepare('SELECT * FROM aml_cases WHERE id = ?').get(id);
  if (c) c.data = safeJson(c.data, {});
  return c;
}

// ---------- Audit ----------
function audit(admin, action, details = '') {
  try {
    db.prepare('INSERT INTO audit_log (admin, action, details, created_at) VALUES (?, ?, ?, ?)')
      .run(String(admin || 'system'), String(action), String(details), now());
  } catch (e) { /* ignore */ }
}

function listAudit(limit = 200) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

// ---------- helpers ----------
function normalizeAddressKey(addr) {
  let s = String(addr || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) s = `0:${s.toLowerCase()}`;
  if (/^0:[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^[-+]?\d+:[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  return null;
}

function safeJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function intClamp(v, lo, hi) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

module.exports = {
  db,
  now,
  listEntities,
  getEntityById,
  findEntitiesByAddress,
  createEntity,
  updateEntity,
  deleteEntity,
  addEntityAddress,
  removeEntityAddress,
  createAdmin,
  getAdminByUsername,
  getAdminById,
  listAdmins,
  updateAdminRole,
  countAdmins,
  createCode,
  getCode,
  consumeCode,
  listCodes,
  deleteCode,
  createSession,
  getSession,
  deleteSession,
  createCase,
  listCases,
  updateCaseStatus,
  getCaseById,
  audit,
  listAudit,
  normalizeAddressKey,
};
