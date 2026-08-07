// server/index.js — точка входа: Express, статика, API
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const db = require('./db');
const seed = require('./seed');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Инициализация БД: сиды сущностей при первом запуске
seed.run();

app.use('/api', require('./routes/api'));
app.use('/api/admin', require('./routes/admin'));

// Статика фронтенда
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));

app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// SPA-фолбэк для корня
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// 404 для API
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(config.port, config.host, () => {
  console.log(`TON Trace running at http://${config.host}:${config.port}`);
  console.log(`Master admin code: ${config.adminMasterCode}`);
  console.log(`TonAPI key: ${config.tonapiKey ? 'configured' : 'not configured (режим: TonAPI напрямую из браузера)'}`);
  console.log(`DB: ${config.dbPath}`);
});
