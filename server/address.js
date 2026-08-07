// server/address.js — работа с адресами TON (raw <-> friendly)
'use strict';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function crc16(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = ((crc & 0x8000) !== 0) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

function base64UrlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
 * Парсит адрес: принимает friendly (bounceable/non-bounceable, любые case) или raw ("wc:hex").
 * Возвращает { raw, friendly, friendlyNonBounce, isDomain, error }
 */
function parseAddress(input) {
  const s = String(input || '').trim();
  if (!s) return { error: 'Пустой адрес' };

  // Сырой вид: "0:9f77..." или "-1:abc..."
  const rawMatch = s.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (rawMatch) {
    const wc = parseInt(rawMatch[1], 10);
    const hash = rawMatch[2].toLowerCase();
    const raw = `${wc}:${hash}`;
    return { raw, friendly: toFriendly(raw, true), friendlyNonBounce: toFriendly(raw, false), isDomain: false };
  }

  // Friendly: 48 символов base64url (36 байт)
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length === 48) {
    try {
      const data = base64UrlDecode(s);
      if (data.length !== 36) return { error: 'Неверная длина адреса' };
      const crc = (data[34] << 8) | data[35];
      const calc = crc16(data.subarray(0, 34));
      if (crc !== calc) return { error: 'Неверная контрольная сумма адреса' };
      const tag = data[0];
      const wc = data[1] === 0 ? 0 : data.readInt32BE(1);
      const hash = bytesToHex(data.subarray(2, 34));
      const raw = `${wc}:${hash}`;
      const bounceable = (tag & 0x40) !== 0; // bit "bounceable"
      return {
        raw,
        friendly: bounceable ? s : toFriendly(raw, true),
        friendlyNonBounce: bounceable ? toFriendly(raw, false) : s,
        isDomain: false,
      };
    } catch (e) {
      return { error: 'Не удалось разобрать адрес' };
    }
  }

  // Возможно .ton домен или t.me поддомен — оставляем как есть (TonAPI умеет резолвить)
  if (/^[a-zA-Z0-9-_.]+\.(ton|t\.me)$/.test(s.toLowerCase())) {
    return { raw: null, friendly: s, isDomain: true };
  }
  if (s.startsWith('0:') && s.length === 66) {
    return { raw: s, friendly: toFriendly(s, true), friendlyNonBounce: toFriendly(s, false), isDomain: false };
  }
  return { error: 'Похоже, это не адрес кошелька TON' };
}

function toFriendly(raw, bounceable = true) {
  const m = String(raw).match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (!m) return String(raw);
  const wc = parseInt(m[1], 10);
  const hash = hexToBytes(m[2].toLowerCase());
  const tag = bounceable ? 0x11 : 0x51;
  const wcByte = wc === 0 ? 0 : 0xff;
  const data = new Uint8Array(34);
  data[0] = tag;
  data[1] = wcByte;
  data.set(hash, 2);
  const crc = crc16(data);
  const full = new Uint8Array(36);
  full.set(data, 0);
  full[34] = (crc >> 8) & 0xff;
  full[35] = crc & 0xff;
  return base64UrlEncode(full);
}

/** Нормализует любой адрес в raw-вид (0:hex). Для доменов возвращает null. */
function toRaw(input) {
  const p = parseAddress(input);
  if (p.error) return null;
  return p.raw;
}

module.exports = { parseAddress, toRaw, toFriendly, crc16, bytesToHex, hexToBytes };
