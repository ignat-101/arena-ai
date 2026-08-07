// server/auth.js — аутентификация админов (сессии, пароли scrypt, роли)
'use strict';

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const COOKIE_NAME = 'tt_session';

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomCode(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const rnd = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[rnd[i] % alphabet.length];
  return out;
}

function verifyPassword(admin, password) {
  const hash = hashPassword(password, admin.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(admin.pass_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function currentAdmin(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const s = db.getSession(token);
  if (!s) return null;
  const admin = db.getAdminById(s.admin_id);
  return admin || null;
}

function setSessionCookie(res, token, expiresAt) {
  const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Middleware: требует админа (любой роли) */
function requireAdmin(req, res, next) {
  const admin = currentAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Требуется авторизация' });
  req.admin = admin;
  next();
}

/** Middleware: требует указанную роль или выше (superadmin > admin > analyst) */
function requireRole(minRole) {
  const rank = { analyst: 1, admin: 2, superadmin: 3 };
  return (req, res, next) => {
    const admin = currentAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Требуется авторизация' });
    if ((rank[admin.role] || 0) < (rank[minRole] || 1)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    req.admin = admin;
    next();
  };
}

function auditAdmin(req, action, details) {
  db.audit(req.admin ? req.admin.username : 'system', action, details);
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  makeSalt,
  verifyPassword,
  randomToken,
  randomCode,
  currentAdmin,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
  requireRole,
  auditAdmin,
  parseCookies,
};
