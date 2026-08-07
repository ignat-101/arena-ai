// public/js/graph.js — канвас-рендер графа связей с физическим макетом (без зависимостей)
export class ForceGraph {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = opts.onSelect || (() => {});
    this.onExplore = opts.onExplore || (() => {});
    this.onHover = opts.onHover || (() => {});

    this.nodes = [];
    this.edges = [];
    this.mainId = null;
    this.selectedId = null;

    // камера
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    // физика
    this.running = true;
    this.energy = Infinity;
    this.dragging = null;
    this.hoverNode = null;
    this._raf = null;

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();

    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
    canvas.addEventListener('mouseleave', () => { this.dragging = null; this._setHover(null); });
    canvas.addEventListener('dblclick', (e) => this._onDblClick(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    canvas.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: false });

    this._tick();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(100, rect.width * dpr);
    this.canvas.height = Math.max(100, rect.height * dpr);
    this.width = rect.width;
    this.height = rect.height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- данные ----------
  setData({ nodes, edges, mainId }) {
    this.nodes = nodes || [];
    this.edges = edges || [];
    this.mainId = mainId || null;
    this.selectedId = null;
    this.energy = Infinity;

    const cx = this.width / 2;
    const cy = this.height / 2;
    const nonMain = this.nodes.filter(n => n.id !== this.mainId);
    const n = Math.max(1, nonMain.length);
    const R = Math.max(this.width, this.height) * 0.32;
    nonMain.forEach((node, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      node.x = cx + Math.cos(angle) * R * (0.6 + (i % 5) * 0.1);
      node.y = cy + Math.sin(angle) * R * (0.6 + (i % 5) * 0.1);
      node.vx = 0; node.vy = 0;
      node.fx = null; node.fy = null;
    });
    const main = this.nodes.find(n => n.id === this.mainId);
    if (main) { main.x = cx; main.y = cy; main.fx = cx; main.fy = cy; }
    this.fitView();
  }

  fitView() {
    if (!this.nodes.length) return;
    const pad = 60;
    const nonMain = this.nodes.filter(n => n.fx === null || n.fx === undefined);
    const list = nonMain.length ? nonMain : this.nodes;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of list) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) { minX = this.width / 2; maxX = this.width / 2; minY = this.height / 2; maxY = this.height / 2; }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const s = Math.min(this.width / (w + pad * 2), this.height / (h + pad * 2), 2.2);
    this.scale = Math.max(0.15, s);
    this.offsetX = this.width / 2 - ((minX + maxX) / 2) * this.scale;
    this.offsetY = this.height / 2 - ((minY + maxY) / 2) * this.scale;
    this.running = true;
  }

  toScreen(x, y) { return { x: x * this.scale + this.offsetX, y: y * this.scale + this.offsetY }; }
  toWorld(x, y) { return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale }; }

  nodeAt(sx, sy) {
    const w = this.toWorld(sx, sy);
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = n.x - w.x, dy = n.y - w.y;
      const r = (n.r + 6) / this.scale;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  // ---------- взаимодействие ----------
  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.max(0.08, Math.min(8, this.scale * factor));
    const wx = (mx - this.offsetX) / this.scale;
    const wy = (my - this.offsetY) / this.scale;
    this.offsetX = mx - wx * ns;
    this.offsetY = my - wy * ns;
    this.scale = ns;
    this.running = true;
  }

  _onMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const node = this.nodeAt(sx, sy);
    if (node) {
      this.dragging = { node, moved: false };
      node.fx = node.x; node.fy = node.y;
      node.dragging = true;
      this.running = true;
    } else {
      this.dragging = { pan: true, sx, sy, ox: this.offsetX, oy: this.offsetY };
      this.canvas.style.cursor = 'grabbing';
    }
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (this.dragging) {
      if (this.dragging.pan) {
        this.offsetX = this.dragging.ox + (sx - this.dragging.sx);
        this.offsetY = this.dragging.oy + (sy - this.dragging.sy);
        this.running = true;
      } else {
        this.dragging.moved = true;
        const w = this.toWorld(sx, sy);
        const n = this.dragging.node;
        n.x = w.x; n.y = w.y; n.fx = w.x; n.fy = w.y;
        this.running = true;
      }
      return;
    }
    const node = this.nodeAt(sx, sy);
    this._setHover(node);
    this.canvas.style.cursor = node ? 'pointer' : 'default';
  }

  _onMouseUp() {
    if (this.dragging && !this.dragging.pan) {
      const node = this.dragging.node;
      node.fx = null; node.fy = null;
      node.dragging = false;
      if (!this.dragging.moved) this._select(node);
    }
    this.dragging = null;
  }

  _onDblClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const node = this.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (node && node.id !== this.mainId) this.onExplore(node);
  }

  _onTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    const rect = this.canvas.getBoundingClientRect();
    this.dragging = { pan: true, sx: t.clientX - rect.left, sy: t.clientY - rect.top, ox: this.offsetX, oy: this.offsetY };
  }
  _onTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    const rect = this.canvas.getBoundingClientRect();
    if (this.dragging && this.dragging.pan) {
      this.offsetX = this.dragging.ox + (t.clientX - rect.left - this.dragging.sx);
      this.offsetY = this.dragging.oy + (t.clientY - rect.top - this.dragging.sy);
      this.running = true;
    }
  }
  _onTouchEnd() { this.dragging = null; }

  _setHover(node) {
    if (this.hoverNode !== node) {
      this.hoverNode = node;
      this.onHover(node, this.hoverInfo(node));
      this.canvas.style.cursor = node ? 'pointer' : 'default';
    }
  }

  _select(node) {
    this.selectedId = node ? node.id : null;
    this.onSelect(node);
    this.running = true;
  }

  selectNode(id) {
    const node = this.nodes.find(n => n.id === id) || null;
    this.selectedId = id || null;
    this.onSelect(node);
    this.running = true;
  }

  // ---------- физика ----------
  _physics() {
    const nodes = this.nodes;
    if (nodes.length < 2) return 0;
    let energy = 0;
    const repulsion = 5200;
    const springLen = 130;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = repulsion / Math.max(d, 20);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        if (a.fx === null || a.fx === undefined) { a.vx += fx; a.vy += fy; }
        if (b.fx === null || b.fx === undefined) { b.vx -= fx; b.vy -= fy; }
      }
    }

    for (const e of this.edges) {
      const a = e.source, b = e.target;
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (d - springLen) * 0.02;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (a.fx === null || a.fx === undefined) { a.vx += fx; a.vy += fy; }
      if (b.fx === null || b.fx === undefined) { b.vx -= fx; b.vy -= fy; }
    }

    for (const n of nodes) {
      if (n.fx !== null && n.fx !== undefined) { n.x = n.fx; n.y = n.fy; continue; }
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x += n.vx;
      n.y += n.vy;
      energy += Math.abs(n.vx) + Math.abs(n.vy);
    }
    return energy;
  }

  _tick() {
    if (this.running) {
      this.energy = this._physics();
      if (this.energy < 0.05) this.running = false;
    }
    this._draw();
    this._raf = requestAnimationFrame(() => this._tick());
  }

  // ---------- отрисовка ----------
  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    for (const e of this.edges) {
      const a = e.source, b = e.target;
      if (!a || !b) continue;
      const p1 = this.toScreen(a.x, a.y);
      const p2 = this.toScreen(b.x, b.y);
      const lw = Math.max(0.6, Math.min(5, Math.log10((e.tonValue || 1e9) / 1e9 + 1) * 2.2));
      ctx.strokeStyle = e.color || 'rgba(120,140,180,0.35)';
      ctx.globalAlpha = this.selectedId && (a.id !== this.selectedId && b.id !== this.selectedId) ? 0.22 : 1;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      const dirs = [];
      if (e.direction === 'in' || e.direction === 'both') dirs.push({ from: b, to: a, color: '#3ddc84' });
      if (e.direction === 'out' || e.direction === 'both') dirs.push({ from: a, to: b, color: '#ff9f43' });
      for (const d of dirs) {
        const q1 = this.toScreen(d.from.x, d.from.y);
        const q2 = this.toScreen(d.to.x, d.to.y);
        const ang = Math.atan2(q2.y - q1.y, q2.x - q1.x);
        const tipX = q2.x - (d.to.r || 10) * this.scale * Math.cos(ang);
        const tipY = q2.y - (d.to.r || 10) * this.scale * Math.sin(ang);
        const size = 5 + Math.min(4, lw);
        ctx.fillStyle = d.color;
        ctx.globalAlpha = this.selectedId && (a.id !== this.selectedId && b.id !== this.selectedId) ? 0.22 : 0.9;
        ctx.beginPath();
        ctx.moveTo(tipX + size * Math.cos(ang), tipY + size * Math.sin(ang));
        ctx.lineTo(tipX + size * 0.55 * Math.cos(ang + 2.6), tipY + size * 0.55 * Math.sin(ang + 2.6));
        ctx.lineTo(tipX + size * 0.55 * Math.cos(ang - 2.6), tipY + size * 0.55 * Math.sin(ang - 2.6));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    for (const n of this.nodes) {
      const p = this.toScreen(n.x, n.y);
      const r = Math.max(5, n.r * this.scale);
      if (p.x < -r || p.y < -r || p.x > this.width + r || p.y > this.height + r) continue;

      if (n.id === this.selectedId || n.id === this.mainId) {
        ctx.shadowColor = n.id === this.mainId ? 'rgba(79,140,255,0.9)' : 'rgba(255,255,255,0.5)';
        ctx.shadowBlur = 18;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.fill || '#3a4a66';
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.lineWidth = n.id === this.mainId ? 2.5 : 1;
      ctx.strokeStyle = n.id === this.mainId ? '#4f8cff' : (n.id === this.selectedId ? '#fff' : 'rgba(255,255,255,0.18)');
      ctx.stroke();

      if (n.risk && n.risk >= 50) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = n.risk >= 75 ? '#f53423' : '#f5a623';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (this.scale > 0.42) {
        const label = n.label || '';
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const lw2 = ctx.measureText(label).width;
        const lx = p.x, ly = p.y + r + 4;
        ctx.fillStyle = 'rgba(10,14,20,0.75)';
        ctx.fillRect(lx - lw2 / 2 - 4, ly - 2, lw2 + 8, 15);
        ctx.fillStyle = n.id === this.mainId ? '#7eb3ff' : (n.dim ? '#7c8899' : '#c9d4e3');
        ctx.fillText(label, lx, ly);
      }
    }
  }

  hoverInfo(node) {
    if (!node) return null;
    return {
      label: node.label || node.id,
      sublabel: node.sublabel || '',
      address: node.id,
      in_count: node.inCount,
      out_count: node.outCount,
      in_value: node.inValue,
      out_value: node.outValue,
      risk: node.risk,
      entity: node.entity,
    };
  }

  zoomBy(factor) {
    const mx = this.width / 2, my = this.height / 2;
    const ns = Math.max(0.08, Math.min(8, this.scale * factor));
    const wx = (mx - this.offsetX) / this.scale;
    const wy = (my - this.offsetY) / this.scale;
    this.offsetX = mx - wx * ns;
    this.offsetY = my - wy * ns;
    this.scale = ns;
    this.running = true;
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resize);
  }
}
