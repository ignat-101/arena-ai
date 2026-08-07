// public/js/ton-utils.js — адреса TON и форматирование (работает в браузере без зависимостей)

export function crc16(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 !== undefined ? b1 : 0) >> 4)];
    if (b1 !== undefined) out += B64_ALPHABET[((b1 & 15) << 2) | ((b2 !== undefined ? b2 : 0) >> 6)];
    if (b2 !== undefined) out += B64_ALPHABET[b2 & 63];
  }
  return out;
}

function b64urlDecode(str) {
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of String(str)) {
    const v = B64_ALPHABET.indexOf(ch);
    if (v === -1) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Парсит адрес: friendly (bounceable/non-bounceable) или raw ("0:hex").
 * @returns {{raw: string|null, friendly: string, friendlyNonBounce: string, isDomain: boolean, error?: string}}
 */
export function parseAddress(input) {
  const s = String(input || '').trim();
  if (!s) return { error: 'Пустой адрес' };

  const rawMatch = s.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (rawMatch) {
    const wc = parseInt(rawMatch[1], 10);
    const raw = `${wc}:${rawMatch[2].toLowerCase()}`;
    return { raw, friendly: toFriendly(raw, true), friendlyNonBounce: toFriendly(raw, false), isDomain: false };
  }

  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length === 48) {
    try {
      const data = b64urlDecode(s);
      if (data.length !== 36) return { error: 'Неверная длина адреса' };
      const crc = (data[34] << 8) | data[35];
      if (crc !== crc16(data.subarray(0, 34))) return { error: 'Неверная контрольная сумма' };
      const tag = data[0];
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const wc = data[1] === 0 ? 0 : dv.getInt32(1, false);
      const raw = `${wc}:${bytesToHex(data.subarray(2, 34))}`;
      const bounceable = (tag & 0x40) !== 0;
      return {
        raw,
        friendly: bounceable ? s : toFriendly(raw, true),
        friendlyNonBounce: bounceable ? toFriendly(raw, false) : s,
        isDomain: false,
      };
    } catch {
      return { error: 'Не удалось разобрать адрес' };
    }
  }

  if (/^[a-zA-Z0-9-_.]+\.(ton|t\.me)$/i.test(s)) {
    return { raw: null, friendly: s, isDomain: true };
  }
  return { error: 'Это не похоже на адрес TON' };
}

export function toFriendly(raw, bounceable = true) {
  const m = String(raw).match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (!m) return String(raw);
  const wc = parseInt(m[1], 10);
  const data = new Uint8Array(34);
  data[0] = bounceable ? 0x11 : 0x51;
  data[1] = wc === 0 ? 0 : 0xff;
  data.set(hexToBytes(m[2].toLowerCase()), 2);
  const crc = crc16(data);
  const full = new Uint8Array(36);
  full.set(data, 0);
  full[34] = (crc >> 8) & 0xff;
  full[35] = crc & 0xff;
  return b64urlEncode(full);
}

export function toRaw(input) {
  const p = parseAddress(input);
  return p.error ? null : p.raw;
}

export function isValidAddress(input) {
  return !parseAddress(input).error;
}

// ---------- форматирование ----------

export function formatTon(nano, digits = 2) {
  if (nano === null || nano === undefined || isNaN(nano)) return '—';
  const ton = Number(nano) / 1e9;
  if (ton === 0) return '0';
  if (Math.abs(ton) >= 1e6) return ton.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' TON';
  if (Math.abs(ton) >= 1000) return ton.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' TON';
  return ton.toLocaleString('ru-RU', { maximumFractionDigits: digits }) + ' TON';
}

export function formatTonShort(nano, digits = 2) {
  if (nano === null || nano === undefined || isNaN(nano)) return '—';
  const ton = Number(nano) / 1e9;
  if (Math.abs(ton) >= 1e6) return (ton / 1e6).toFixed(2) + 'M';
  if (Math.abs(ton) >= 1e3) return (ton / 1e3).toFixed(1) + 'k';
  return ton.toFixed(digits);
}

export function formatNumber(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

export function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} дн назад`;
  return new Date(ts * 1000).toLocaleDateString('ru-RU');
}

export function shortAddr(addr, head = 6, tail = 6) {
  const s = String(addr || '');
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

export function shortHash(hash, n = 8) {
  const s = String(hash || '');
  if (s.length <= n * 2 + 1) return s;
  return s.slice(0, n) + '…' + s.slice(-n);
}

export function normalizeAddressKey(addr) {
  const raw = toRaw(addr);
  if (raw) return raw.toLowerCase();
  return null;
}
