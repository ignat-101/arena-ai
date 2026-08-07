// server/seed.js — наполнение БД сущностями при первом запуске
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');

function run() {
  if (db.countAdmins() > 0 || db.listEntities().length > 0) {
    // База уже инициализирована
    return;
  }
  if (!fs.existsSync(config.seedPath)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(config.seedPath, 'utf8'));
  } catch (e) {
    console.error('[seed] не удалось прочитать seed:', e.message);
    return;
  }
  let n = 0;
  for (const e of (data.entities || [])) {
    if (!e || !e.name || !Array.isArray(e.addresses) || !e.addresses.length) continue;
    db.createEntity({
      name: e.name,
      type: e.type || 'other',
      risk_level: e.risk_level || 0,
      status: e.status || 'active',
      description: e.description || '',
      tags: e.tags || [],
      source: e.source || 'seed',
      logo_url: e.logo_url || '',
      color: e.color || '',
      addresses: e.addresses,
      created_by: 'seed',
    });
    n++;
  }
  db.audit('seed', 'seed.loaded', `${n} сущностей`);
  console.log(`[seed] загружено сущностей: ${n}`);
}

module.exports = { run };
