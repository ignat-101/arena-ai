// server/report.js — генерация AML PDF-отчётов (pdfkit + DejaVu для кириллицы)
'use strict';

const path = require('path');
const PDFDocument = require('pdfkit');

const FONTS_DIR = path.join(__dirname, 'assets', 'fonts');
const FONT_REGULAR = path.join(FONTS_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(FONTS_DIR, 'DejaVuSans-Bold.ttf');
const FONT_MONO = path.join(FONTS_DIR, 'DejaVuSansMono.ttf');

const COLORS = {
  bg: '#0a0e15', panel: '#131a26', panel2: '#182130', border: '#2a3850',
  text: '#1a2332', dim: '#5c6b82', accent: '#2f6bff',
  low: '#2fbf71', medium: '#f5a623', high: '#f56b23', critical: '#f53423',
};

function riskColor(level) {
  return COLORS[level] || COLORS.medium;
}

function fmtTon(nano) {
  const ton = (nano || 0) / 1e9;
  if (Math.abs(ton) >= 1e6) return (ton / 1e6).toFixed(2) + 'M TON';
  if (Math.abs(ton) >= 1e3) return (ton / 1e3).toFixed(1) + 'k TON';
  return ton.toFixed(2) + ' TON';
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortAddr(addr, head = 8, tail = 6) {
  const s = String(addr || '');
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

/**
 * Собирает PDF-отчёт.
 * @param {object} data { reportId, address:{friendly,raw,name,balance,status,is_scam,is_wallet,interfaces,last_activity},
 *   risk:{score,level,level_label,signals:[{title,severity,detail}]},
 *   stats:{in_value,out_value,tx_count,unique_counterparties,age_days},
 *   entities:[{name,type,risk_level,status}],
 *   counterparties:[{name,address,in_value,out_value,in_count,out_count}],
 *   transactions:[{timestamp,dir,type,description,value,counterparty,event_id}] }
 * @returns {Promise<Buffer>}
 */
async function buildAmlPdf(data) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 56, left: 48, right: 48 }, bufferPages: true });
  const W = doc.page.width - 96; // рабочая ширина

  function ensureSpace(min) {
    if (doc.y > doc.page.height - min) doc.addPage();
  }

  function drawTableHeader(y, cols) {
    const colW = [W - 180, 60, 60, 60];
    doc.roundedRect(48, y, W, 18, 4).fill('#0f1520');
    doc.font(FONT_BOLD).fontSize(8).fillColor('#ffffff');
    let x = 48;
    cols.forEach((c, i) => {
      doc.text(c, x + 6, y + 5, { width: colW[i], align: i === 0 ? 'left' : 'right' });
      x += colW[i];
    });
  }

  function drawTxHeader(y) {
    doc.roundedRect(48, y, W, 16, 4).fill('#0f1520');
    doc.font(FONT_BOLD).fontSize(7.5).fillColor('#ffffff');
    doc.text('Напр.', 48, y + 4, { width: 36 });
    doc.text('Время', 88, y + 4, { width: 68 });
    doc.text('Описание', 162, y + 4, { width: W - 162 - 100 });
    doc.text('Сумма', 48 + W - 92, y + 4, { width: 92, align: 'right' });
  }

  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ---------- шапка ----------
      doc.rect(0, 0, doc.page.width, 78).fill('#0f1520');
      doc.font(FONT_BOLD).fontSize(20).fillColor('#ffffff');
      doc.text('TON Trace', 48, 24);
      doc.font(FONT_REGULAR).fontSize(10).fillColor('#8b98ad');
      doc.text('AML-аналитический отчёт по адресу кошелька TON', 48, 48);

      doc.font(FONT_BOLD).fontSize(11).fillColor('#dbe4f0').text('AML-ОТЧЁТ', 0, 24, { width: W, align: 'right' });
      doc.font(FONT_REGULAR).fontSize(9).fillColor('#8b98ad').text(
        `№ ${data.reportId || '—'}  ·  ${fmtTime(Date.now() / 1000)}`, 0, 40, { width: W, align: 'right' });

      let y = 96;

      // ---------- адрес ----------
      doc.font(FONT_BOLD).fontSize(12).fillColor(COLORS.text).text('Анализируемый адрес');
      y = doc.y + 6;
      doc.roundedRect(48, y, W, 74, 8).fill('#ffffff').stroke('#dde4ee');
      doc.font(FONT_MONO).fontSize(10).fillColor(COLORS.accent);
      doc.text(data.address.friendly || data.address.raw || '—', 60, y + 10);
      doc.font(FONT_REGULAR).fontSize(9).fillColor(COLORS.dim);
      doc.text('raw: ' + (data.address.raw || '—'), 60, y + 26);
      doc.font(FONT_REGULAR).fontSize(9.5).fillColor(COLORS.text);
      const name = data.address.name ? `${data.address.name}${data.address.is_wallet ? '  ·  кошелёк' : ''}` : (data.address.is_wallet ? 'кошелёк' : 'контракт');
      doc.text('Имя: ' + name + '  |  Статус: ' + (data.address.status || '—'), 60, y + 42);
      doc.text('Баланс: ' + fmtTon(data.address.balance) + (data.address.last_activity ? '  |  Последняя активность: ' + fmtTime(data.address.last_activity) : ''), 60, y + 56);
      if (data.address.is_scam) {
        doc.font(FONT_BOLD).fillColor(COLORS.critical).text('⚠ Аккаунт помечен TonAPI как scam', 60, y + 58);
      }
      y = doc.y + 18;

      // ---------- оценка риска ----------
      const risk = data.risk || { score: 0, level: 'low', level_label: 'Низкий', signals: [] };
      const rColor = riskColor(risk.level);
      doc.font(FONT_BOLD).fontSize(12).fillColor(COLORS.text).text('Оценка риска');
      y = doc.y + 6;
      doc.roundedRect(48, y, W, 92, 8).fill('#ffffff').stroke('#dde4ee');
      // шкала
      const barX = 60, barY = y + 44, barW = W - 120;
      doc.rect(barX, barY, barW, 10).fill('#e8edf5');
      doc.rect(barX, barY, Math.max(2, barW * (risk.score / 100)), 10).fill(rColor);
      doc.font(FONT_BOLD).fontSize(26).fillColor(rColor).text(String(risk.score), 60, y + 12, { width: 100 });
      doc.font(FONT_BOLD).fontSize(14).fillColor(COLORS.text).text(risk.level_label || '—', 140, y + 18);
      doc.font(FONT_REGULAR).fontSize(9).fillColor(COLORS.dim).text('оценка 0–100 · формируется по открытым данным TonAPI и базе сущностей', 140, y + 38);

      // сигналы
      y = doc.y + 10;
      const signals = (risk.signals || []).slice(0, 12);
      if (signals.length) {
        doc.font(FONT_BOLD).fontSize(11).fillColor(COLORS.text).text(`Сигналы (${signals.length})`);
        y = doc.y + 4;
        for (const s of signals) {
          doc.circle(56, y + 4, 3).fill(riskColor(s.severity >= 70 ? 'critical' : s.severity >= 40 ? 'medium' : 'low'));
          doc.font(FONT_REGULAR).fontSize(9.5).fillColor(COLORS.text).text(s.title, 66, y, { width: W - 30 });
          if (s.detail) {
            doc.font(FONT_REGULAR).fontSize(8.5).fillColor(COLORS.dim).text(s.detail, 66, doc.y + 1, { width: W - 30 });
          }
          y = doc.y + 4;
          doc.moveTo(48, y).lineTo(48 + W, y).strokeColor('#e3e9f2').lineWidth(0.5).stroke();
          y += 2;
        }
      } else {
        doc.font(FONT_REGULAR).fontSize(9.5).fillColor(COLORS.low).text('Явных риск-сигналов не обнаружено.');
      }

      doc.moveDown(0.8);
      ensureSpace(90);

      // ---------- статистика ----------
      const st = data.stats || {};
      doc.font(FONT_BOLD).fontSize(12).fillColor(COLORS.text).text('Статистика за период');
      y = doc.y + 6;
      const cards = [
        ['Входящие, TON', fmtTon(st.in_value)],
        ['Исходящие, TON', fmtTon(st.out_value)],
        ['Операций', String(st.tx_count ?? '—')],
        ['Контрагентов', String(st.unique_counterparties ?? '—')],
      ];
      const cardW = (W - 24) / 4;
      cards.forEach((c, i) => {
        const cx = 48 + i * (cardW + 8);
        doc.roundedRect(cx, y, cardW, 46, 6).fill('#f3f6fb').stroke('#dde4ee');
        doc.font(FONT_REGULAR).fontSize(8).fillColor(COLORS.dim).text(c[0], cx + 10, y + 8, { width: cardW - 20 });
        doc.font(FONT_BOLD).fontSize(11).fillColor(COLORS.text).text(c[1], cx + 10, y + 22, { width: cardW - 20 });
      });
      doc.moveDown(1.2);
      ensureSpace(60);

      // ---------- сущности ----------
      const entities = (data.entities || []).filter(e => e && e.name);
      if (entities.length) {
        doc.font(FONT_BOLD).fontSize(12).fillColor(COLORS.text).text('Связанные сущности');
        y = doc.y + 6;
        doc.roundedRect(48, y, W, 8 + entities.length * 20, 6).fill('#f8fafc').stroke('#dde4ee');
        let ey = y + 8;
        for (const e of entities) {
          doc.font(FONT_BOLD).fontSize(9.5).fillColor(COLORS.text).text(e.name, 58, ey);
          doc.font(FONT_REGULAR).fontSize(8.5).fillColor(COLORS.dim).text(
            `${e.type || '—'}  ·  риск ${e.risk_level ?? '—'}/100  ·  ${e.status || '—'}`, 210, ey);
          ey += 20;
        }
        doc.moveDown(1.2);
        ensureSpace(70);
      }

      // ---------- контрагенты (топ) ----------
      const cps = (data.counterparties || []).slice(0, 25);
      if (cps.length) {
        doc.font(FONT_BOLD).fontSize(12).fillColor(COLORS.text).text(`Основные контрагенты (топ ${Math.min(25, cps.length)})`);
        y = doc.y + 6;
        drawTableHeader(y, ['Контрагент', 'Входящие', 'Исходящие', 'Операций']);
        let rowY = y + 18;
        for (const c of cps) {
          if (rowY > doc.page.height - 110) { doc.addPage(); rowY = 60; drawTableHeader(rowY, ['Контрагент', 'Входящие', 'Исходящие', 'Операций']); rowY += 18; }
          const name = c.name || shortAddr(c.address);
          const colW = [W - 180, 60, 60, 60];
          doc.font(FONT_REGULAR).fontSize(8.8).fillColor(COLORS.text).text(name, 48, rowY, { width: colW[0] });
          doc.text(fmtTon(c.in_value), 48 + colW[0], rowY, { width: colW[1], align: 'right' });
          doc.text(fmtTon(c.out_value), 48 + colW[0] + colW[1], rowY, { width: colW[1], align: 'right' });
          doc.text(String(c.in_count + c.out_count), 48 + colW[0] + colW[1] + colW[2], rowY, { width: colW[2], align: 'right' });
          rowY += 14;
          if (c.address) {
            doc.font(FONT_MONO).fontSize(7).fillColor(COLORS.dim).text(shortAddr(c.address, 12, 8), 52, rowY, { width: W - 40 });
            rowY += 10;
          }
          doc.moveTo(48, rowY).lineTo(48 + W, rowY).strokeColor('#e3e9f2').lineWidth(0.4).stroke();
          rowY += 3;
        }
        doc.moveDown(1.4);
        ensureSpace(60);
      }

      // ---------- транзакции ----------
      const txs = (data.transactions || []).slice(0, 400);
      doc.font(FONT_BOLD).fontSize(12).fillColor(COLORS.text).text(`Транзакции (${txs.length})`);
      y = doc.y + 6;
      drawTxHeader(y);
      let rowY = y + 16;
      for (const t of txs) {
        if (rowY > doc.page.height - 110) { doc.addPage(); rowY = 60; drawTxHeader(rowY); rowY += 16; }
        const dirLabel = t.dir === 'in' ? 'ВХОД' : t.dir === 'out' ? 'ВЫХОД' : 'ВНУТР';
        const dirColor = t.dir === 'in' ? COLORS.low : t.dir === 'out' ? COLORS.medium : COLORS.accent;
        doc.font(FONT_BOLD).fontSize(8).fillColor(dirColor).text(dirLabel, 48, rowY, { width: 36 });
        doc.font(FONT_REGULAR).fontSize(8.5).fillColor(COLORS.text).text(fmtTime(t.timestamp), 88, rowY, { width: 68 });
        doc.font(FONT_REGULAR).fontSize(8.5).fillColor(COLORS.text).text(String(t.description || t.type || '—').slice(0, 46), 162, rowY, { width: W - 162 - 100 });
        doc.font(FONT_BOLD).fontSize(8.5).fillColor(COLORS.text).text(String(t.value || '—'), 48 + W - 92, rowY, { width: 92, align: 'right' });
        rowY += 13;
        if (t.counterparty) {
          doc.font(FONT_REGULAR).fontSize(7.5).fillColor(COLORS.dim).text(String(t.counterparty).slice(0, 60), 162, rowY, { width: W - 120 });
          rowY += 10;
        }
        doc.moveTo(48, rowY).lineTo(48 + W, rowY).strokeColor('#e9eef6').lineWidth(0.4).stroke();
        rowY += 3;
      }

      // ---------- подвал ----------
      const pages = doc.bufferedPageRange();
      for (let i = pages.start; i < pages.start + pages.count; i++) {
        doc.switchToPage(i);
        doc.font(FONT_REGULAR).fontSize(7.5).fillColor(COLORS.dim);
        doc.text('TON Trace · конфиденциально · сгенерировано автоматически · не является юридическим заключением',
          48, doc.page.height - 40, { width: W, align: 'center' });
        doc.text(`стр. ${i - pages.start + 1} из ${pages.count}`, 48, doc.page.height - 28, { width: W, align: 'center' });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildAmlPdf };
