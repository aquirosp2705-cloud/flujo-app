/* grid.js — cuadrícula tipo hoja de cálculo (virtualizada) para FlujoWeb.
 *
 *   const grid = new SheetGrid(rootEl, engine, { onChange({sid,changes}), onSelect(sel), onFind() , readOnly });
 *   grid.open('s02', { end: true });      // abre la hoja; end:true salta al último dato
 *   grid.refresh();                        // repintar tras cambios externos en el motor
 *
 * Teclado: flechas, Shift+flechas, Ctrl+flechas, Tab/Enter, Inicio/Fin, RePág/AvPág, F2, Supr, Ctrl+C/X/V/Z/Y/D/R/A/F.
 * Ratón: clic/arrastre, doble clic = editar, asa de relleno (cuadrito azul) arrastrando hacia abajo/derecha, borde de encabezado = ancho.
 * Táctil: tocar = seleccionar, tocar de nuevo = editar; barra de herramientas con deshacer, copiar, pegar, rellenar, zoom, ir al final.
 */
import { cellKey as K, colLetter, addrToA1 } from './engine.js';
import { fmtCell, styleCss, editText, parseInput } from './format.js';

const ROW_H = 22, DEF_W = 64, ROWHDR_W = 46, COLHDR_H = 22, MAX_OVERFLOW = 700;
const EMPTY = {};

export class SheetGrid {
  constructor(root, eng, opts = {}) {
    this.root = root; this.eng = eng;
    this.opts = Object.assign({ toolbar: true, readOnly: false, onChange() { }, onSelect() { }, onFind: null, onToast: null }, opts);
    this.sid = null; this.sh = null; this.zoom = 1;
    this.nodes = new Map();
    this.anchor = { r: 0, c: 0 }; this.focus = { r: 0, c: 0 };
    this.edit = null; this.clip = null; this.barEditing = false; this.drag = null;
    this._raf = 0; this._listeners = [];
    this._mctx = document.createElement('canvas').getContext('2d');
    this._build();
  }

  /* ------------------------------------------------------------------ DOM */
  _build() {
    const r = this.root;
    r.classList.add('fxg');
    r.style.setProperty('--rh', ROWHDR_W + 'px'); r.style.setProperty('--ch', COLHDR_H + 'px');
    r.innerHTML = `
      ${this.opts.toolbar ? `<div class="fxg-tools" role="toolbar" aria-label="Herramientas de la hoja">
        <button data-act="undo" title="Deshacer (Ctrl+Z)">↶ Deshacer</button>
        <button data-act="redo" title="Rehacer (Ctrl+Y)">↷ Rehacer</button>
        <button data-act="copy" title="Copiar (Ctrl+C)">Copiar</button>
        <button data-act="paste" title="Pegar (Ctrl+V)">Pegar</button>
        <button data-act="fill" title="Rellenar hacia abajo (Ctrl+D)">Rellenar ↓</button>
        <button data-act="clear" title="Borrar contenido (Supr)">Borrar</button>
        <button data-act="end" title="Ir al último dato">Ir al final ⇲</button>
        <button data-act="find" title="Buscar (Ctrl+F)">Buscar</button>
        <span class="fxg-sp"></span>
        <button data-act="zout" title="Reducir">−</button><span class="fxg-zv">100%</span><button data-act="zin" title="Ampliar">+</button>
      </div>` : ''}
      <div class="fxg-bar">
        <input class="fxg-name" aria-label="Celda" spellcheck="false" autocomplete="off">
        <span class="fxg-fx" aria-hidden="true">fx</span>
        <input class="fxg-formula" aria-label="Contenido de la celda" spellcheck="false" autocomplete="off" autocapitalize="off">
        ${this.opts.toolbar ? '<button class="fxg-more" type="button" aria-label="Más herramientas" title="Más herramientas">⋯</button>' : ''}
      </div>
      <div class="fxg-body">
        <div class="fxg-corner"></div>
        <div class="fxg-colhdr"><div class="fxg-colhdr-in"></div></div>
        <div class="fxg-rowhdr"><div class="fxg-rowhdr-in"></div></div>
        <div class="fxg-scroll" tabindex="-1"><div class="fxg-sizer"><div class="fxg-layer"></div></div></div>
        <textarea class="fxg-kb" aria-label="Entrada de teclado de la hoja" inputmode="none" autocomplete="off" autocapitalize="off" spellcheck="false" rows="1"></textarea>
      </div>
      <div class="fxg-status"><span class="fxg-st-l"></span><span class="fxg-st-r"></span></div>`;
    const q = (s) => r.querySelector(s);
    this.tools = q('.fxg-tools'); this.nameBox = q('.fxg-name'); this.bar = q('.fxg-formula');
    this.body = q('.fxg-body'); this.colHdr = q('.fxg-colhdr'); this.colHdrIn = q('.fxg-colhdr-in');
    this.rowHdr = q('.fxg-rowhdr'); this.rowHdrIn = q('.fxg-rowhdr-in');
    this.scroll = q('.fxg-scroll'); this.sizer = q('.fxg-sizer'); this.layer = q('.fxg-layer');
    this.kb = q('.fxg-kb'); this.stL = q('.fxg-st-l'); this.stR = q('.fxg-st-r'); this.zv = q('.fxg-zv');

    const mk = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
    this.selEl = mk('fxg-sel'); this.actEl = mk('fxg-act'); this.handle = mk('fxg-handle'); this.clipEl = mk('fxg-clipbox'); this.fillEl = mk('fxg-fillbox');
    this.ed = document.createElement('input'); this.ed.className = 'fxg-ed'; this.ed.spellcheck = false; this.ed.autocomplete = 'off'; this.ed.setAttribute('autocapitalize', 'off');
    this.layer.append(this.selEl, this.clipEl, this.fillEl, this.actEl, this.handle, this.ed);

    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); this._listeners.push([t, ev, fn, o]); };
    on(this.scroll, 'scroll', () => this._schedulePaint());
    this._ro = new ResizeObserver(() => this._schedulePaint()); this._ro.observe(this.scroll);
    on(this.scroll, 'pointerdown', (e) => this._onPointerDown(e));
    on(this.scroll, 'dblclick', (e) => this._onDblClick(e));
    on(this.handle, 'pointerdown', (e) => this._onHandleDown(e));
    on(window, 'pointermove', (e) => this._onPointerMove(e));
    on(window, 'pointerup', (e) => this._onPointerUp(e));
    on(this.colHdr, 'pointerdown', (e) => this._onColHdrDown(e));
    on(this.rowHdr, 'pointerdown', (e) => this._onRowHdrDown(e));
    on(this.kb, 'keydown', (e) => this._onKey(e));
    // texto que llega sin keydown útil (teclados móviles "Unidentified", IME, dictado): inicia la edición con ese texto
    on(this.kb, 'input', () => { const v = this.kb.value; this.kb.value = ''; if (v && !this.edit && !this.opts.readOnly) this._beginEdit('enter', v); });
    on(this.kb, 'copy', (e) => this._onCopy(e, false));
    on(this.kb, 'cut', (e) => this._onCopy(e, true));
    on(this.kb, 'paste', (e) => { e.preventDefault(); this._paste(e.clipboardData.getData('text/plain')); });
    on(this.ed, 'keydown', (e) => this._onEdKey(e));
    on(this.ed, 'blur', () => { if (this.edit) this._commitEdit(null); });
    on(this.ed, 'input', () => { if (this.edit && !this.barEditing) this.bar.value = this.ed.value; });
    on(this.bar, 'focus', () => { this.barEditing = true; this.barDirty = false; });
    on(this.bar, 'input', () => { this.barDirty = true; });
    on(this.bar, 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._commitBar(); this._focusKb(); this._move(1, 0); }
      else if (e.key === 'Escape') { e.preventDefault(); this.barDirty = false; this.bar.blur(); this._focusKb(); this._updateBar(); }
    });
    on(this.bar, 'blur', () => { this._commitBar(); this.barEditing = false; this._updateBar(); });
    on(this.nameBox, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.goTo(this.nameBox.value); this._focusKb(); } else if (e.key === 'Escape') { this._updateName(); this._focusKb(); } });
    on(this.nameBox, 'focus', () => this.nameBox.select());
    if (this.tools) on(this.tools, 'click', (e) => { const b = e.target.closest('button[data-act]'); if (b) this._tool(b.dataset.act); });
    const more = q('.fxg-more'); if (more) on(more, 'click', () => r.classList.toggle('fxg-tools-open'));
  }

  /** Confirma una edición a medias (celda o barra de fórmulas) antes de salir de la hoja. */
  commitPending() { if (this.edit) this._commitEdit(null); this._commitBar(); }

  destroy() {
    for (const [t, ev, fn, o] of this._listeners) t.removeEventListener(ev, fn, o);
    this._listeners = []; if (this._ro) this._ro.disconnect();
    this.root.innerHTML = ''; this.root.classList.remove('fxg');
  }

  /* ------------------------------------------------------------ API pública */
  /** Abre una hoja. opts: {r,c} celda a seleccionar · end:true salta al último dato */
  open(sid, o = {}) {
    if (this.edit) this._cancelEdit();
    this.sid = sid; this.sh = this.eng.sheet(sid);
    this.nodes.forEach(n => n.remove()); this.nodes.clear();
    this.root.classList.toggle('fxg-nogrid', this.sh.gridlines === false);
    this._layout();
    this.anchor = { r: 0, c: 0 }; this.focus = { r: 0, c: 0 }; this.clip = null; this.clipEl.style.display = 'none';
    this.scroll.scrollLeft = 0; this.scroll.scrollTop = 0;
    if (o.end) this.goEnd(); else if (o.r != null) this.select(o.r, o.c || 0, null, null, true);
    else this._afterSelect(true);
    this._paint(true);
    return this;
  }
  refresh() { if (!this.sh) return; this._relayoutIfGrown(); this._paint(true); this._updateBar(); this._updateStatus(); }
  setReadOnly(v) { this.opts.readOnly = !!v; this.root.classList.toggle('fxg-ro', !!v); }
  getSelection() { const R = this._rect(); return { sid: this.sid, ...R, active: { ...this.anchor } }; }
  focusGrid() { this._focusKb(); }
  select(r, c, r1 = null, c1 = null, scroll = true) {
    this.anchor = { r, c }; this.focus = { r: r1 == null ? r : r1, c: c1 == null ? c : c1 };
    this._afterSelect(scroll);
  }
  goTo(text) {
    const t = String(text).trim().replace(/^.*!/, '').replace(/\$/g, '');
    const m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(t);
    if (!m) { this._toast('Referencia no válida: ' + text); this._updateName(); return; }
    const ci = (s) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    const r = +m[2] - 1, c = ci(m[1]);
    if (m[3]) this.select(r, c, +m[4] - 1, ci(m[3])); else this.select(r, c);
  }
  goEnd() {
    let r = this.eng.lastConstRow(this.sid);
    if (r < 0) r = 0;
    this.select(r, 0, null, null, false);
    const d = this._dNear(r);
    const vh = this.scroll.clientHeight || 400;
    this.scroll.scrollTop = Math.max(0, (d + 1) * this.rowH - vh + this.rowH * 4);
    this._afterSelect(false); this._paint(true);
  }
  setZoom(z) {
    this.zoom = Math.max(0.5, Math.min(2, Math.round(z * 100) / 100));
    if (this.zv) this.zv.textContent = Math.round(this.zoom * 100) + '%';
    const keepR = this.anchor.r; this._layout(); this._paint(true); this._ensureVisible(keepR, this.anchor.c);
  }

  /* -------------------------------------------------------------- geometría */
  _layout() {
    const sh = this.sh, z = this.zoom;
    const nCols = Math.max(sh.cols + 3, 14);
    const colX = new Float64Array(nCols + 1);
    for (let c = 0; c < nCols; c++) {
      const hid = sh.hiddenCols.has(c);
      colX[c + 1] = colX[c] + (hid ? 0 : Math.max(10, Math.round((sh.colWidths.get(c) || DEF_W) * z)));
    }
    this.colX = colX; this.nCols = nCols;
    this.nTotal = Math.max(sh.rows + 40, 60);
    this.rowH = Math.round(ROW_H * z);
    if (sh.hiddenRows.size) {
      this.vis = []; this.visIdx = new Int32Array(this.nTotal).fill(-1);
      for (let r = 0; r < this.nTotal; r++) if (!sh.hiddenRows.has(r)) { this.visIdx[r] = this.vis.length; this.vis.push(r); }
      this.nRows = this.vis.length;
    } else { this.vis = null; this.visIdx = null; this.nRows = this.nTotal; }
    this.sizer.style.width = colX[nCols] + 'px'; this.sizer.style.height = this.nRows * this.rowH + 'px';
    this.root.style.setProperty('--rowh', this.rowH + 'px'); this.root.style.setProperty('--fxz', z);
    // combinadas
    this.mergeTL = new Map(); this.mergeCover = new Set();
    for (const m of sh.merges) {
      this.mergeTL.set(K(m.r0, m.c0), m);
    }
  }
  _relayoutIfGrown() {
    const sh = this.sh;
    if (sh.rows + 40 > this.nTotal || sh.cols + 3 > this.nCols) this._layout();
  }
  _d(r) { return this.visIdx ? this.visIdx[r] : r; }
  _r(d) { return this.vis ? this.vis[d] : d; }
  _dNear(r) { if (!this.visIdx) return r; let d = this.visIdx[r]; while (d < 0 && r < this.nTotal - 1) d = this.visIdx[++r]; return d < 0 ? 0 : d; }
  _colAt(x) {
    const cx = this.colX; let lo = 0, hi = this.nCols - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cx[mid] <= x) lo = mid; else hi = mid - 1; }
    return lo;
  }
  _cellRect(r, c) {
    const m = this.sh.mergeAt(r, c);
    const r0 = m ? m.r0 : r, c0 = m ? m.c0 : c, r1 = m ? m.r1 : r, c1 = m ? m.c1 : c;
    const x = this.colX[c0], y = this._dNear(r0) * this.rowH;
    return { x, y, w: this.colX[Math.min(c1 + 1, this.nCols)] - x, h: (this._dNear(r1) - this._dNear(r0) + 1) * this.rowH, r0, c0, r1, c1 };
  }

  /* ----------------------------------------------------------------- pintado */
  _schedulePaint() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this._paint(false); }); }

  _paint(force) {
    if (!this.sh || !this.colX) return;
    const sc = this.scroll, vw = sc.clientWidth, vh = sc.clientHeight, st = sc.scrollTop, sl = sc.scrollLeft;
    const d0 = Math.max(0, Math.floor(st / this.rowH) - 2), d1 = Math.min(this.nRows - 1, Math.ceil((st + vh) / this.rowH) + 2);
    const c0 = Math.max(0, this._colAt(sl) - 4), c1 = Math.min(this.nCols - 1, this._colAt(sl + vw) + 1);
    this._vis = { d0, d1, c0, c1 };
    const need = new Set(), covered = new Set(), extra = new Map();
    // combinadas que tocan la zona visible
    for (const m of this.sh.merges) {
      const md0 = this._d(m.r0), md1 = this._d(m.r1);
      if (md0 < 0 && md1 < 0) continue;
      if (Math.max(md0, 0) > d1 || md1 < d0 || m.c1 < c0 || m.c0 > c1) continue;
      extra.set(K(m.r0, m.c0), m);
      for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(K(r, c));
    }
    const frag = document.createDocumentFragment();
    for (let d = d0; d <= d1; d++) {
      const r = this._r(d); let skipTo = -1;
      for (let c = c0; c <= c1; c++) {
        if (c <= skipTo) continue;
        if (this.colX[c + 1] === this.colX[c]) continue;               // columna oculta
        const key = K(r, c);
        if (covered.has(key)) continue;
        const m = extra.get(key) || null;
        need.add(key);
        let node = this.nodes.get(key);
        if (!node) { node = document.createElement('div'); node.className = 'fxc'; this.nodes.set(key, node); frag.appendChild(node); node._new = true; }
        if (node._new || force) { node._span = this._fillCell(node, r, c, m); node._new = false; }
        if (node._span > c) skipTo = node._span;
      }
    }
    // combinadas cuyo origen está fuera del rango pero que se ven
    for (const [key, m] of extra) {
      if (need.has(key)) continue;
      need.add(key);
      let node = this.nodes.get(key);
      if (!node) { node = document.createElement('div'); node.className = 'fxc'; this.nodes.set(key, node); frag.appendChild(node); node._new = true; }
      if (node._new || force) { this._fillCell(node, m.r0, m.c0, m); node._new = false; }
    }
    for (const [key, node] of this.nodes) if (!need.has(key)) { node.remove(); this.nodes.delete(key); }
    this.layer.insertBefore(frag, this.selEl);
    this._paintHeaders();
    this._paintSel();
  }

  _fillCell(el, r, c, m) {
    const eng = this.eng, sid = this.sid, sh = this.sh;
    const x = this.colX[c], y = this._dNear(r) * this.rowH;
    let w = this.colX[(m ? m.c1 : c) + 1] - x;
    const h = m ? (this._dNear(m.r1) - this._dNear(m.r0) + 1) * this.rowH : this.rowH;
    const stId = sh.styleAt(r, c);
    const st = eng.styles[stId] || EMPTY;
    const v = eng.value(sid, r, c);
    const f = fmtCell(v, st);
    let span = -1;
    // desborde de texto sobre celdas vacías vecinas
    if (f.k === 'txt' && !m && !st.w && (!st.h || st.h === 'left') && f.t.length * 6.4 * this.zoom > w - 6) {
      this._mctx.font = (st.b ? 'bold ' : '') + (13 * this.zoom) + 'px system-ui, Segoe UI, Arial';
      const need = this._mctx.measureText(f.t).width + 8;
      let acc = w, j = c;
      while (acc < need && acc < MAX_OVERFLOW && j + 1 < this.nCols) {
        const nj = j + 1;
        if (this.colX[nj + 1] === this.colX[nj]) { j = nj; continue; }
        if (eng.value(sid, r, nj) !== null || this.sh.mergeAt(r, nj)) break;
        acc += this.colX[nj + 1] - this.colX[nj]; j = nj;
      }
      if (j > c) { w = acc; span = j; }
    }
    el.className = 'fxc' + (f.k === 'num' ? ' n' : f.k === 'err' ? ' e' : f.k === 'bool' ? ' b' : '') + (span > c ? ' ov' : '') + (m ? ' mg' : '');
    el.textContent = f.t;
    let css = 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;' + styleCss(st);
    if (f.color) css += 'color:' + f.color + ';';
    el.style.cssText = css;
    const note = sh.notes.get(K(r, c));
    if (note) { el.title = note; el.classList.add('nt'); } else if (el.title) { el.removeAttribute('title'); }
    return span;
  }

  _paintHeaders() {
    const { d0, d1, c0, c1 } = this._vis;
    const R = this._rect();
    let h = '';
    for (let c = c0; c <= c1; c++) {
      const w = this.colX[c + 1] - this.colX[c]; if (!w) continue;
      const on = c >= R.c0 && c <= R.c1;
      h += `<div class="${on ? 'on' : ''}" data-c="${c}" style="left:${this.colX[c]}px;width:${w}px">${colLetter(c)}</div>`;
    }
    this.colHdrIn.innerHTML = h;
    this.colHdrIn.style.transform = 'translateX(' + (-this.scroll.scrollLeft) + 'px)';
    let g = '';
    for (let d = d0; d <= d1; d++) {
      const r = this._r(d); const on = r >= R.r0 && r <= R.r1;
      g += `<div class="${on ? 'on' : ''}" data-r="${r}" style="top:${d * this.rowH}px;height:${this.rowH}px;line-height:${this.rowH}px">${r + 1}</div>`;
    }
    this.rowHdrIn.innerHTML = g;
    this.rowHdrIn.style.transform = 'translateY(' + (-this.scroll.scrollTop) + 'px)';
  }

  _rect() {
    return {
      r0: Math.min(this.anchor.r, this.focus.r), r1: Math.max(this.anchor.r, this.focus.r),
      c0: Math.min(this.anchor.c, this.focus.c), c1: Math.max(this.anchor.c, this.focus.c),
    };
  }
  _box(el, R) {
    const a = this._cellRect(R.r0, R.c0), b = this._cellRect(R.r1, R.c1);
    const x = a.x, y = a.y, w = b.x + b.w - x, h = b.y + b.h - y;
    el.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    return { x, y, w, h };
  }
  _paintSel() {
    if (!this.sh) return;
    let R = this._rect();
    // ampliar la selección para cubrir celdas combinadas que la cruzan
    for (const m of this.sh.merges) {
      if (m.r1 < R.r0 || m.r0 > R.r1 || m.c1 < R.c0 || m.c0 > R.c1) continue;
      if (R.r0 !== R.r1 || R.c0 !== R.c1) { R = { r0: Math.min(R.r0, m.r0), r1: Math.max(R.r1, m.r1), c0: Math.min(R.c0, m.c0), c1: Math.max(R.c1, m.c1) }; }
    }
    const multi = R.r0 !== R.r1 || R.c0 !== R.c1;
    this.root.classList.toggle('fxg-multi', multi);
    if (multi) this._box(this.selEl, R); else this.selEl.style.display = 'none';
    const a = this._cellRect(this.anchor.r, this.anchor.c);
    this.actEl.style.cssText = `display:block;left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${a.h}px`;
    const box = this._box(document.createElement('div'), R);
    this.handle.style.cssText = this.opts.readOnly ? 'display:none' : `display:block;left:${box.x + box.w - 5}px;top:${box.y + box.h - 5}px`;
    if (this.clip && this.clip.sid === this.sid) { this._box(this.clipEl, this.clip); } else this.clipEl.style.display = 'none';
  }

  /* --------------------------------------------------------------- selección */
  _afterSelect(scroll = true) {
    this._paintSel();
    if (scroll) this._ensureVisible(this.focus.r, this.focus.c);
    if (this._vis) this._paintHeaders();
    this._updateName(); this._updateBar(); this._updateStatus();
    this.opts.onSelect(this.getSelection());
  }
  _ensureVisible(r, c) {
    const R = this._cellRect(r, c), sc = this.scroll;
    const vw = sc.clientWidth, vh = sc.clientHeight;
    if (R.x < sc.scrollLeft) sc.scrollLeft = R.x;
    else if (R.x + R.w > sc.scrollLeft + vw) sc.scrollLeft = Math.min(R.x, R.x + R.w - vw + 4);
    if (R.y < sc.scrollTop) sc.scrollTop = R.y;
    else if (R.y + R.h > sc.scrollTop + vh) sc.scrollTop = R.y + R.h - vh + 2;
    this._paint(false);
  }
  _updateName() {
    const R = this._rect();
    this.nameBox.value = (R.r0 === R.r1 && R.c0 === R.c1) ? addrToA1(R.r0, R.c0) : addrToA1(R.r0, R.c0) + ':' + addrToA1(R.r1, R.c1);
  }
  _rawText(r, c) {
    const raw = this.eng.raw(this.sid, r, c);
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number') return editText(raw, this.eng.styles[this.sh.styleAt(r, c)]);
    if (typeof raw === 'boolean') return raw ? 'TRUE' : 'FALSE';
    return String(raw);
  }
  _updateBar() { if (this.barEditing || this.edit) return; this.bar.value = this.sh ? this._rawText(this.anchor.r, this.anchor.c) : ''; }
  _updateStatus() {
    if (!this.sh) return;
    const R = this._rect(); this.stL.textContent = this.sh.name.trim() + ' · ' + this.nameBox.value;
    if (R.r0 === R.r1 && R.c0 === R.c1) { this.stR.textContent = ''; return; }
    let n = 0, cnt = 0, sum = 0, max = Math.min(R.r1, R.r0 + 20000);
    for (let r = R.r0; r <= max; r++) for (let c = R.c0; c <= R.c1; c++) {
      const v = this.eng.value(this.sid, r, c);
      if (v === null) continue; cnt++;
      if (typeof v === 'number') { n++; sum += v; }
    }
    const f = (x) => x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    this.stR.textContent = n ? `Suma ${f(sum)} · Promedio ${f(sum / n)} · Cuenta ${cnt}` : (cnt ? `Cuenta ${cnt}` : '');
  }

  /* ------------------------------------------------------------------ ratón */
  _cellAt(e) {
    const rect = this.scroll.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const x = px + this.scroll.scrollLeft, y = py + this.scroll.scrollTop;
    const c = this._colAt(Math.max(0, Math.min(x, this.colX[this.nCols] - 1)));
    const d = Math.max(0, Math.min(this.nRows - 1, Math.floor(y / this.rowH)));
    return { r: this._r(d), c, onScrollbar: px > this.scroll.clientWidth || py > this.scroll.clientHeight };
  }
  _focusKb() { try { this.kb.focus({ preventScroll: true }); } catch (e) { this.kb.focus(); } }

  _onPointerDown(e) {
    if (e.target === this.ed || e.target === this.handle) return;
    const cell = this._cellAt(e);
    if (cell.onScrollbar) return;
    if (this.edit) this._commitEdit(null);
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      e.preventDefault(); this._focusKb();
      if (e.shiftKey) this.focus = { r: cell.r, c: cell.c }; else { this.anchor = { r: cell.r, c: cell.c }; this.focus = { r: cell.r, c: cell.c }; }
      this.drag = { type: 'select' };
      this._afterSelect(false);
    } else {
      this._touch = { x: e.clientX, y: e.clientY, t: Date.now(), cell, sx: this.scroll.scrollLeft, sy: this.scroll.scrollTop };
    }
  }
  _onPointerMove(e) {
    if (!this.drag) return;
    const cell = this._cellAt(e);
    if (this.drag.type === 'select') {
      if (cell.r !== this.focus.r || cell.c !== this.focus.c) { this.focus = { r: cell.r, c: cell.c }; this._afterSelect(false); this._autoScroll(e); }
    } else if (this.drag.type === 'fill') {
      const R = this.drag.src;
      const down = cell.r > R.r1, right = cell.c > R.c1;
      let box;
      if (down && (cell.r - R.r1) >= (right ? (cell.c - R.c1) : 0) * 0 + 0 && !(right && (cell.c - R.c1) * this.rowH > (cell.r - R.r1) * 60)) box = { r0: R.r0, c0: R.c0, r1: cell.r, c1: R.c1 };
      else if (right) box = { r0: R.r0, c0: R.c0, r1: R.r1, c1: cell.c };
      else box = null;
      this.drag.target = box;
      if (box) this._box(this.fillEl, box); else this.fillEl.style.display = 'none';
    } else if (this.drag.type === 'colresize') {
      const w = Math.max(14, this.drag.w0 + (e.clientX - this.drag.x0));
      this.drag.w = w;
      this.colHdr.style.cursor = 'col-resize';
    }
  }
  _autoScroll(e) {
    const rect = this.scroll.getBoundingClientRect(); const sc = this.scroll;
    if (e.clientY > rect.bottom - 16) sc.scrollTop += 24; else if (e.clientY < rect.top + 16) sc.scrollTop -= 24;
    if (e.clientX > rect.right - 16) sc.scrollLeft += 40; else if (e.clientX < rect.left + 16) sc.scrollLeft -= 40;
  }
  _onPointerUp(e) {
    if (this._touch) {
      const t = this._touch; this._touch = null;
      const moved = Math.abs(e.clientX - t.x) + Math.abs(e.clientY - t.y) + Math.abs(this.scroll.scrollLeft - t.sx) + Math.abs(this.scroll.scrollTop - t.sy);
      if (moved < 10 && Date.now() - t.t < 600 && e.target !== this.ed) {
        const same = this.anchor.r === t.cell.r && this.anchor.c === t.cell.c && this.rootHasFocusRing;
        this._focusKb();
        if (same) { this._beginEdit('edit', null); }
        else { this.anchor = { r: t.cell.r, c: t.cell.c }; this.focus = { ...this.anchor }; this._afterSelect(false); this.rootHasFocusRing = true; }
      }
      return;
    }
    if (!this.drag) return;
    const d = this.drag; this.drag = null;
    if (d.type === 'fill') {
      this.fillEl.style.display = 'none';
      if (d.target) this._doFill(d.src, d.target);
    } else if (d.type === 'colresize') {
      if (d.w && Math.abs(d.w - d.w0) > 1) {
        this.sh.colWidths.set(d.c, Math.round(d.w / this.zoom)); this.eng.dirty.add(this.sid);
        this._layout(); this._paint(true); this._afterSelect(false); this.opts.onChange({ sid: this.sid, changes: [], layout: true });
      }
      this.colHdr.style.cursor = '';
    }
  }
  _onDblClick(e) {
    const cell = this._cellAt(e);
    if (cell.onScrollbar || this.opts.readOnly) return;
    this.anchor = { r: cell.r, c: cell.c }; this.focus = { ...this.anchor };
    this._beginEdit('edit', null);
  }
  _onHandleDown(e) {
    if (this.opts.readOnly) return;
    e.preventDefault(); e.stopPropagation();
    this.drag = { type: 'fill', src: this._rect(), target: null };
  }
  _onColHdrDown(e) {
    const t = e.target.closest('[data-c]'); if (!t) return;
    const c = +t.dataset.c, rect = t.getBoundingClientRect();
    if (e.clientX > rect.right - 6) {       // borde derecho: cambiar ancho
      e.preventDefault();
      this.drag = { type: 'colresize', c, x0: e.clientX, w0: rect.width, w: rect.width }; return;
    }
    e.preventDefault(); this._focusKb();
    if (e.shiftKey) this.focus = { r: this._r(this.nRows - 1), c }; else { this.anchor = { r: 0, c }; this.focus = { r: this._r(this.nRows - 1), c }; }
    this._afterSelect(false);
  }
  _onRowHdrDown(e) {
    const t = e.target.closest('[data-r]'); if (!t) return;
    const r = +t.dataset.r; e.preventDefault(); this._focusKb();
    if (e.shiftKey) this.focus = { r, c: this.nCols - 1 }; else { this.anchor = { r, c: 0 }; this.focus = { r, c: this.nCols - 1 }; }
    this._afterSelect(false);
  }

  /* ----------------------------------------------------------------- teclado */
  _isEmptyAt(r, c) { return this.eng.value(this.sid, r, c) === null; }
  _step(r, c, dr, dc) {                        // un paso saltando filas/columnas ocultas
    let nr = r + dr, nc = c + dc;
    while (dr && nr >= 0 && nr < this.nTotal && this.sh.hiddenRows.has(nr)) nr += dr;
    while (dc && nc >= 0 && nc < this.nCols && this.sh.hiddenCols.has(nc)) nc += dc;
    return { r: Math.max(0, Math.min(this.nTotal - 1, nr)), c: Math.max(0, Math.min(this.nCols - 1, nc)) };
  }
  _move(dr, dc, extend = false, jump = false) {
    let p = extend ? { ...this.focus } : { ...this.anchor };
    const m0 = this.sh.mergeAt(p.r, p.c);
    if (!extend && m0) { if (dr > 0) p.r = m0.r1; if (dc > 0) p.c = m0.c1; if (dr < 0) p.r = m0.r0; if (dc < 0) p.c = m0.c0; }
    if (jump) {
      const here = !this._isEmptyAt(p.r, p.c);
      let q = this._step(p.r, p.c, dr, dc);
      if (here && !this._isEmptyAt(q.r, q.c)) {
        while (true) { const n = this._step(q.r, q.c, dr, dc); if ((n.r === q.r && n.c === q.c) || this._isEmptyAt(n.r, n.c)) break; q = n; }
      } else {
        while (true) { if (!this._isEmptyAt(q.r, q.c)) break; const n = this._step(q.r, q.c, dr, dc); if (n.r === q.r && n.c === q.c) break; q = n; }
      }
      p = q;
    } else p = this._step(p.r, p.c, dr, dc);
    const m1 = this.sh.mergeAt(p.r, p.c); if (m1 && !extend) { p = { r: m1.r0, c: m1.c0 }; }
    if (extend) this.focus = p; else { this.anchor = p; this.focus = { ...p }; }
    this._afterSelect(true);
  }
  _onKey(e) {
    if (!this.sh) return;
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, k = e.key;
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { e.preventDefault(); this._move(arrows[k][0], arrows[k][1], shift, ctrl); return; }
    if (k === 'Tab') { e.preventDefault(); this._move(0, shift ? -1 : 1); return; }
    if (k === 'Enter') { e.preventDefault(); if (this.opts.readOnly) { this._move(shift ? -1 : 1, 0); } else this._beginEdit('edit', null); return; }
    if (k === 'F2') { e.preventDefault(); this._beginEdit('edit', null); return; }
    if (k === 'Home') { e.preventDefault(); if (ctrl) this.select(0, 0); else this._move(0, -9999, shift); return; }
    if (k === 'End') { e.preventDefault(); if (ctrl) { const r = Math.max(0, this.eng.lastRowWithContent(this.sid)); this.select(r, 0); } else this._move(0, 9999, shift); return; }
    if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); const n = Math.max(1, Math.floor(this.scroll.clientHeight / this.rowH) - 1); this._move((k === 'PageDown' ? 1 : -1) * n, 0, shift); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this._clearSel(); return; }
    if (k === 'Escape') { this.clip = null; this._paintSel(); return; }
    if (ctrl) {
      const key = k.toLowerCase();
      if (key === 'z') { e.preventDefault(); this._undo(); return; }
      if (key === 'y') { e.preventDefault(); this._redo(); return; }
      if (key === 'a') { e.preventDefault(); this.anchor = { r: 0, c: 0 }; this.focus = { r: this.sh.rows - 1 || 0, c: Math.max(0, this.sh.cols - 1) }; this._afterSelect(false); return; }
      if (key === 'd') { e.preventDefault(); this._fillDown(); return; }
      if (key === 'r') { e.preventDefault(); this._fillRight(); return; }
      if (key === 'f') { if (this.opts.onFind) { e.preventDefault(); this.opts.onFind(); } return; }
      return;                                    // Ctrl+C/X/V los atienden los eventos copy/cut/paste
    }
    if (k.length === 1 || k === 'Dead' || k === 'Process') {
      if (this.opts.readOnly) return;
      this._beginEdit('enter', '');              // el carácter tecleado llega al editor porque pasa el foco en keydown
    }
  }

  /* ------------------------------------------------------------------ edición */
  _beginEdit(mode, initial) {
    if (this.opts.readOnly || !this.sh) return;
    // En pantallas táctiles el teclado virtual taparía una celda de la mitad inferior: se edita en la barra de fórmulas (arriba).
    if (initial == null && window.matchMedia && matchMedia('(pointer: coarse)').matches && this.bar) {
      this._ensureVisible(this.anchor.r, this.anchor.c);
      this.bar.focus({ preventScroll: true });
      try { const n = this.bar.value.length; this.bar.setSelectionRange(n, n); } catch (e) { /* */ }
      return;
    }
    const m = this.sh.mergeAt(this.anchor.r, this.anchor.c);
    const r = m ? m.r0 : this.anchor.r, c = m ? m.c0 : this.anchor.c;
    this._ensureVisible(r, c);
    const orig = this._rawText(r, c);
    const text = initial != null ? initial : orig;
    this.edit = { r, c, mode, orig };
    const R = this._cellRect(r, c), ed = this.ed;
    ed.style.cssText = `display:block;left:${R.x}px;top:${R.y}px;min-width:${Math.max(R.w, 80)}px;width:${Math.max(R.w, 80)}px;height:${R.h}px;font-size:${13 * this.zoom}px`;
    ed.value = text; this.bar.value = text;
    ed.focus({ preventScroll: true });
    const n = text.length; ed.setSelectionRange(n, n);
  }
  _onEdKey(e) {
    if (!this.edit) return;
    const k = e.key;
    if (k === 'Enter') { e.preventDefault(); this._commitEdit({ dr: e.shiftKey ? -1 : 1, dc: 0 }); }
    else if (k === 'Tab') { e.preventDefault(); this._commitEdit({ dr: 0, dc: e.shiftKey ? -1 : 1 }); }
    else if (k === 'Escape') { e.preventDefault(); this._cancelEdit(); }
    else if (k === 'F2') { e.preventDefault(); this.edit.mode = this.edit.mode === 'enter' ? 'edit' : 'enter'; }
    else if (this.edit.mode === 'enter' && (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight')) {
      e.preventDefault(); const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k];
      this._commitEdit({ dr: d[0], dc: d[1] });
    }
  }
  _commitEdit(move) {
    const e = this.edit; if (!e) return;
    this.edit = null;
    const text = this.ed.value;
    this.ed.style.display = 'none';
    if (text !== e.orig) this._applyText(e.r, e.c, text);
    this._focusKb();
    this._updateBar();
    if (move) this._move(move.dr, move.dc);
  }
  _cancelEdit() { if (!this.edit) return; this.edit = null; this.ed.style.display = 'none'; this._focusKb(); this._updateBar(); }
  _commitBar() {
    if (!this.barDirty || !this.sh) { this.barDirty = false; return; }
    this.barDirty = false;
    const m = this.sh.mergeAt(this.anchor.r, this.anchor.c);
    const r = m ? m.r0 : this.anchor.r, c = m ? m.c0 : this.anchor.c;
    if (this.bar.value !== this._rawText(r, c)) this._applyText(r, c, this.bar.value);
  }
  _applyText(r, c, text) {
    const sid = this.sid, sh = this.sh, eng = this.eng;
    const stId = sh.styleAt(r, c), st = eng.styles[stId] || EMPTY;
    let { raw, nf } = parseInput(text, st);
    if (typeof raw === 'number' && sh.textCells.has(K(r, c)) && /^\d+$/.test(text.trim())) raw = text.trim();   // números de cuenta con ceros a la izquierda siguen siendo texto
    const cur = eng.raw(sid, r, c);
    if (raw === cur) return;
    let changes;
    try { changes = eng.set(sid, r, c, raw); } catch (err) { this._toast('No se pudo guardar: ' + err.message); return; }
    if (nf && !st.nf) sh.setStyle(r, c, eng.deriveStyle(stId, { nf }));
    this._afterChange(changes);
  }
  _afterChange(changes) {
    this._relayoutIfGrown();
    this._paint(true); this._paintSel(); this._updateBar(); this._updateStatus();
    this.opts.onChange({ sid: this.sid, changes });
  }
  _clearSel() {
    if (this.opts.readOnly) return;
    const R = this._rect();
    const ch = this.eng.clear(this.sid, R.r0, R.c0, R.r1, R.c1);
    this._afterChange(ch);
  }
  _undo() { const ch = this.eng.undo(); if (ch === null) this._toast('Nada que deshacer'); else this._afterChange(ch); }
  _redo() { const ch = this.eng.redo(); if (ch === null) this._toast('Nada que rehacer'); else this._afterChange(ch); }

  /* ----------------------------------------------------------------- rellenar */
  _fillDown() {
    if (this.opts.readOnly) return;
    const R = this._rect(); let ch = [];
    if (R.r0 === R.r1) { if (R.r0 === 0) return; ch = this.eng.copyPaste(this.sid, R.r0 - 1, R.c0, R.r0 - 1, R.c1, this.sid, R.r0, R.c0); }
    else for (let r = R.r0 + 1; r <= R.r1; r++) ch = ch.concat(this.eng.copyPaste(this.sid, R.r0, R.c0, R.r0, R.c1, this.sid, r, R.c0));
    this._afterChange(ch);
  }
  _fillRight() {
    if (this.opts.readOnly) return;
    const R = this._rect(); let ch = [];
    if (R.c0 === R.c1) { if (R.c0 === 0) return; ch = this.eng.copyPaste(this.sid, R.r0, R.c0 - 1, R.r1, R.c0 - 1, this.sid, R.r0, R.c0); }
    else for (let c = R.c0 + 1; c <= R.c1; c++) ch = ch.concat(this.eng.copyPaste(this.sid, R.r0, R.c0, R.r1, R.c0, this.sid, R.r0, c));
    this._afterChange(ch);
  }
  _doFill(src, tgt) {
    let ch = [];
    if (tgt.r1 > src.r1) {
      const rows = src.r1 - src.r0 + 1;
      for (let r = src.r1 + 1; r <= tgt.r1; r++) { const s = src.r0 + ((r - src.r1 - 1) % rows); ch = ch.concat(this.eng.copyPaste(this.sid, s, src.c0, s, src.c1, this.sid, r, src.c0)); }
    } else if (tgt.c1 > src.c1) {
      const cols = src.c1 - src.c0 + 1;
      for (let c = src.c1 + 1; c <= tgt.c1; c++) { const s = src.c0 + ((c - src.c1 - 1) % cols); ch = ch.concat(this.eng.copyPaste(this.sid, src.r0, s, src.r1, s, this.sid, src.r0, c)); }
    }
    this.anchor = { r: tgt.r0, c: tgt.c0 }; this.focus = { r: tgt.r1, c: tgt.c1 };
    this._afterChange(ch); this._afterSelect(false);
  }

  /* ---------------------------------------------------------------- portapapeles */
  _selText(R) {
    const lines = [];
    for (let r = R.r0; r <= R.r1; r++) {
      if (this.sh.hiddenRows.has(r)) continue;
      const cells = [];
      for (let c = R.c0; c <= R.c1; c++) {
        if (this.sh.hiddenCols.has(c)) continue;
        const f = fmtCell(this.eng.value(this.sid, r, c), this.eng.styles[this.sh.styleAt(r, c)]);
        cells.push(f.t.replace(/[\t\r\n]+/g, ' '));
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }
  _setClip(cut) {
    const R = this._rect(); const text = this._selText(R);
    this.clip = { sid: this.sid, ...R, text, cut };
    this._paintSel();
    return text;
  }
  _onCopy(e, cut) {
    e.preventDefault();
    if (cut && this.opts.readOnly) cut = false;
    const text = this._setClip(cut);
    e.clipboardData.setData('text/plain', text);
  }
  async _copyButton() {
    const text = this._setClip(false);
    try { await navigator.clipboard.writeText(text); this._toast('Copiado'); } catch (err) { this._toast('Copiado dentro de la app (el navegador no dio acceso al portapapeles)'); }
  }
  async _pasteButton() {
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch (err) { text = null; }
    if (text == null && this.clip) text = this.clip.text;
    if (text == null) { this._toast('No pude leer el portapapeles: usa Ctrl+V'); return; }
    this._paste(text);
  }
  _paste(text) {
    if (this.opts.readOnly || !this.sh || text == null) return;
    const R = this._rect(); let ch = [];
    if (this.clip && text === this.clip.text) {
      const k = this.clip, rows = k.r1 - k.r0 + 1, cols = k.c1 - k.c0 + 1;
      const tr = Math.max(1, Math.floor((R.r1 - R.r0 + 1) / rows)), tc = Math.max(1, Math.floor((R.c1 - R.c0 + 1) / cols));
      for (let i = 0; i < tr; i++) for (let j = 0; j < tc; j++) ch = ch.concat(this.eng.copyPaste(k.sid, k.r0, k.c0, k.r1, k.c1, this.sid, R.r0 + i * rows, R.c0 + j * cols));
      if (k.cut) { ch = ch.concat(this.eng.clear(k.sid, k.r0, k.c0, k.r1, k.c1)); this.clip = null; }
      this.anchor = { r: R.r0, c: R.c0 }; this.focus = { r: R.r0 + tr * rows - 1, c: R.c0 + tc * cols - 1 };
    } else {
      const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
      const matrix = []; const styleFix = [];
      lines.forEach((ln, i) => {
        const row = ln.split('\t').map((cell, j) => {
          const st = this.eng.styles[this.sh.styleAt(R.r0 + i, R.c0 + j)] || EMPTY;
          const p = parseInput(cell.trim() === '' ? '' : cell, st);
          if (p.nf && !st.nf) styleFix.push([R.r0 + i, R.c0 + j, p.nf]);
          return p.raw;
        });
        matrix.push(row);
      });
      if (!matrix.length) return;
      const width = Math.max(...matrix.map(r => r.length));
      matrix.forEach(r => { while (r.length < width) r.push(null); });
      ch = this.eng.setMatrix(this.sid, R.r0, R.c0, matrix);
      for (const [r, c, nf] of styleFix) this.sh.setStyle(r, c, this.eng.deriveStyle(this.sh.styleAt(r, c), { nf }));
      this.anchor = { r: R.r0, c: R.c0 }; this.focus = { r: R.r0 + matrix.length - 1, c: R.c0 + width - 1 };
    }
    this._afterChange(ch); this._afterSelect(false);
  }

  /* ------------------------------------------------------------------ varios */
  _tool(act) {
    if (act === 'zin') return this.setZoom(this.zoom + 0.1);
    if (act === 'zout') return this.setZoom(this.zoom - 0.1);
    if (act === 'end') return this.goEnd();
    if (act === 'find') { if (this.opts.onFind) this.opts.onFind(); return; }
    if (act === 'copy') return this._copyButton();
    if (act === 'paste') return this._pasteButton();
    if (act === 'undo') return this._undo();
    if (act === 'redo') return this._redo();
    if (act === 'fill') return this._fillDown();
    if (act === 'clear') return this._clearSel();
  }
  _toast(msg) { if (this.opts.onToast) this.opts.onToast(msg); else { this.stL.textContent = msg; clearTimeout(this._tt); this._tt = setTimeout(() => this._updateStatus(), 2500); } }
}
