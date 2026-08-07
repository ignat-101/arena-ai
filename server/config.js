// server/config.js — конфигурация сервиса
// Все секреты и настройки задаются через переменные окружения (.env или export).
'use strict';

const path = require('path');
const fs = require('fs');

// Поддержка .env файла без внешних зависимостей
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue; // не перезаписываем реальное окружение
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[m[1]] = val;
  }
}
loadEnvFile();

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const config = {
  port: PORT,
  host: HOST,
  // Ключ TonAPI (tonapi.io). Используется на сервере для проксирования запросов.
  tonapiKey: process.env.TONAPI_KEY || '',
  // Если задан — фронтенд сможет ходить в TonAPI напрямую из браузера с этим ключом
  // (ключ станет видимым в коде страницы — используйте осознанно).
  publicTonapiKey: process.env.PUBLIC_TONAPI_KEY || '',
  // Мастер-код админа: по нему регистрируется первый суперадмин.
  adminMasterCode: process.env.ADMIN_MASTER_CODE || 'trace-admin-2026',
  // Путь к БД
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'aml.db'),
  // Путь к файлу сидов (сущности)
  seedPath: process.env.SEED_PATH || path.join(__dirname, '..', 'data', 'seed', 'entities.json'),
  // Режим источника данных: 'backend' (прокси через сервер) | 'auto'
  dataSourceMode: (process.env.DATA_SOURCE_MODE || 'auto'),
  // Ограничения выборки событий по умолчанию
  maxEventsDefault: parseInt(process.env.MAX_EVENTS_DEFAULT || '1000', 10),
  maxEventsCap: parseInt(process.env.MAX_EVENTS_CAP || '5000', 10),
  eventsPageSize: 100,
  sessionTtlMs: 7 * 24 * 3600 * 1000, // 7 дней
};

module.exports = config;
