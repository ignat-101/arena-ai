// server/aml.js — AML-риск-скоринг
// Вход: адрес, данные аккаунта, сводка событий (агрегированные связи), база сущностей.
// Выход: оценка 0-100, уровень риска, список сигналов, найденные сущности.
'use strict';

const LEVELS = {
  low: { label: 'Низкий', max: 24, color: '#2fbf71' },
  medium: { label: 'Средний', max: 49, color: '#f5a623' },
  high: { label: 'Высокий', max: 74, color: '#f56b23' },
  critical: { label: 'Критический', max: 100, color: '#f53423' },
};

const LOOKALIKE_PATTERN = /(binance|bybit|okx|kucoin|bitget|gate|htx|mexc|crypto(?:bot)?|wallet|ton)(?:[0-9_-]+|\.(?:com|net|io|ru|xyz|top|app|org|vip|pro|live|club|help|support|menu|send|pay|bonus|id|dex|usdt|btc|mena|pro|beta|card|only|list|not|top|2017|12|1|_|-)*$)/i;

function scoreText(score) {
  if (score <= 24) return 'low';
  if (score <= 49) return 'medium';
  if (score <= 74) return 'high';
  return 'critical';
}

/**
 * @param {object} params
 * @param {string} params.address raw-адрес
 * @param {object|null} params.account данные /v2/accounts/{id}
 * @param {Array} params.counterparties агрегированные связи: [{address, name, is_scam, is_wallet, in_value, out_value, in_count, out_count, entity}]
 * @param {Array} params.entities найденные сущности по адресу
 * @param {object} params.stats {in_value, out_value, tx_count, unique_counterparties, age_days, jetton_mint_count}
 */
function analyze({ address, account = null, counterparties = [], entities = [], stats = {} }) {
  const signals = [];
  let score = 0;
  let severitySum = 0;

  const addSignal = (title, severity, detail = '') => {
    signals.push({ title, severity, detail });
  };

  // 1. Риск сущностей, привязанных к адресу
  const matched = entities.filter(e => e.status === 'active' || e.status === 'monitored');
  if (matched.length) {
    const maxRisk = Math.max(...matched.map(e => e.risk_level || 0));
    const risky = matched.filter(e => (e.risk_level || 0) >= 50);
    for (const e of risky) {
      addSignal(`Адрес привязан к сущности «${e.name}» (${e.type})`, 30 + (e.risk_level || 0) / 2,
        `Риск сущности: ${e.risk_level}`);
    }
    score += maxRisk * 0.45;
    severitySum += 45;
  }

  // 2. Флаг scam у самого аккаунта
  if (account && account.is_scam) {
    addSignal('Аккаунт помечен TonAPI как scam', 80);
    score += 35;
    severitySum += 80;
  }

  // 3. Связи с подозрительными контрагентами
  const scamCounterparties = counterparties.filter(c => c.is_scam || (c.entity && (c.entity.risk_level || 0) >= 60));
  if (scamCounterparties.length) {
    addSignal(`Взаимодействие с ${scamCounterparties.length} подозрительным(и) адресом(ами)`,
      Math.min(90, 40 + scamCounterparties.length * 10),
      scamCounterparties.slice(0, 5).map(c => c.name || c.address.slice(0, 12)).join(', '));
    score += Math.min(40, scamCounterparties.length * 15) * 0.35;
    severitySum += Math.min(90, 40 + scamCounterparties.length * 10);
  }

  // 4. Домены-клоны (lookalike) среди контрагентов
  const lookalikes = counterparties.filter(c => c.name && LOOKALIKE_PATTERN.test(c.name));
  if (lookalikes.length) {
    addSignal(`Подозрительные домены-клоны: ${lookalikes.slice(0, 4).map(c => c.name).join(', ')}`,
      60, 'Адреса с именами, имитирующими известные бренды');
    score += 15;
    severitySum += 60;
  }

  // 5. Объёмы (значения в нано-токенах: 1 TON = 1e9 нано)
  const inVal = stats.in_value || 0;
  const outVal = stats.out_value || 0;
  const total = inVal + outVal;
  if (total >= 1e15) { addSignal(`Суммарный оборот за период превышает 1 млн TON (${fmt(total)})`, 30); score += 6; severitySum += 30; }
  else if (total >= 1e14) { addSignal(`Суммарный оборот превышает 100 тыс. TON (${fmt(total)})`, 20); score += 3; severitySum += 20; }

  // 6. Потоковая активность (churn) — паттерн «мулов»
  const n = stats.unique_counterparties || counterparties.length;
  const tx = stats.tx_count || 0;
  if (tx >= 300 && n >= 50) {
    addSignal(`Высокая транзакционная активность: ${tx} операций с ${n} контрагентами`, 35,
      'Паттерн, характерный для обналичивания/дробления');
    score += 8;
    severitySum += 35;
  }

  // 7. Возраст кошелька
  if (stats.age_days !== undefined && stats.age_days >= 0 && stats.age_days < 1) {
    addSignal('Кошелёк создан менее суток назад', 45);
    score += 10;
    severitySum += 45;
  } else if (stats.age_days !== undefined && stats.age_days < 7) {
    addSignal(`Кошелёк создан менее недели назад (${Math.round(stats.age_days)} дн.)`, 25);
    score += 5;
    severitySum += 25;
  }

  // 8. Минт джеттонов (подозрительная эмиссия)
  if ((stats.jetton_mint_count || 0) > 0) {
    addSignal(`${stats.jetton_mint_count} событий эмиссии (mint) джеттонов`, 40);
    score += 7;
    severitySum += 40;
  }

  // 9. Индикатор «больше входящих, чем исходящих» (аккумуляция) или наоборот
  if (outVal > 0 && outVal > inVal * 10 && tx >= 10) {
    addSignal('Резкое преобладание исходящих переводов', 20, 'Средство может использоваться для вывода средств');
    score += 3;
    severitySum += 20;
  }

  // Итоговая оценка: взвешенная сумма сигналов, нормированная
  const finalScore = Math.max(0, Math.min(100, Math.round(score + (signals.length > 0 ? 5 : 0))));
  const level = scoreText(finalScore);
  signals.sort((a, b) => b.severity - a.severity);

  return {
    score: finalScore,
    level,
    level_label: LEVELS[level].label,
    color: LEVELS[level].color,
    signals,
    matched_entities: matched,
    stats: {
      in_value: inVal,
      out_value: outVal,
      tx_count: tx,
      unique_counterparties: n,
    },
  };
}

function fmt(nano) {
  const ton = (nano || 0) / 1e9;
  if (ton >= 1e6) return (ton / 1e6).toFixed(2) + 'M';
  if (ton >= 1e3) return (ton / 1e3).toFixed(1) + 'k';
  return ton.toFixed(2);
}

module.exports = { analyze, LEVELS };
