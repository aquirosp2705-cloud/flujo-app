/* grid.js — cuadrícula tipo hoja de cálculo (virtualizada) para FlujoWeb.
 *
 *   const grid = new SheetGrid(rootEl, engine, { onChange({sid,changes}), onSelect(sel), onFind() , readOnly });
 *   grid.open('s02', { end: true });      // abre la hoja; end:true salta al último dato
 *   grid.refresh();                        // repintar tras cambios externos en el motor
 *
 * Teclado: flechas, Shift+flechas, Ctrl+flechas, Tab/Enter, Inicio/Fin, RePág/AvPág, F2, Supr, Ctrl+C/X/V/Z/Y/D/R/A/F.
 * Ratón: clic/arrastre, doble clic = editar, asa de relleno (cuadrito azul) arrastrando hacia abajo/derecha, borde de encabezado = ancho.
 * Táctil: tocar = seleccionar, tocar de nuevo = editar, arrastrar el circulito azul de la esquina = seleccionar un rango (abajo se ven
 *   su suma, promedio y cuenta); para copiar hacia abajo está «Rellenar ↓». Barra de herramientas con deshacer, copiar, pegar, zoom, ir al final.
 * Formato: negrita, color de letra, relleno y bordes (raya abajo, raya arriba, arriba y abajo, todos, contorno, sin bordes); se deshace con Ctrl+Z.
 */
import { cellKey as K, colLetter, addrToA1, a1ToAddr, sheetRef } from './engine.js';
import { fmtCell, styleCss, editText, parseInput, isDateFormat } from './format.js';
import { toSpanish } from './formula-es.js';

/** ¿Pantalla táctil como puntero principal (celular, tableta)? Ahí el asa de la esquina selecciona en vez de rellenar. */
const COARSE = () => { try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } };

/* Colores de las celdas que usa la fórmula que se está editando (como Excel: cada referencia con su color). */
const REF_COLORS = ['#1c7ed6', '#e8590c', '#7048e8', '#2f9e44', '#d6336c', '#0c8599', '#f59f00', '#5c940d'];
/** Referencias de una fórmula que apuntan a ESTA hoja: [{ text, r0, c0, r1, c1 }]. Ignora textos entre comillas, nombres de
 *  función (LOG10( …) y referencias a otras hojas ('Otra hoja'!A1). */
export function formulaRefs(text, sheetName) {
  if (!text || !'=+-'.includes(text[0])) return [];
  const t = text.replace(/"(?:[^"]|"")*"?/g, (m) => ' '.repeat(m.length));
  const re = /(?:('(?:[^']|'')+'|[A-Za-z_À-ɏ][\w.À-ɏ]*)!)?(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::(\$?[A-Za-z]{1,3}\$?\d{1,7}))?/g;
  const me = String(sheetName || '').trim().toLowerCase(), out = [];
  let m;
  while ((m = re.exec(t))) {
    const prev = m.index > 0 ? t[m.index - 1] : '';
    const next = t[m.index + m[0].length] || '';
    if (/[\w.$:!'À-ɏ]/.test(prev) || /[\w(!À-ɏ]/.test(next)) continue;
    if (m[1]) { const sh = (m[1][0] === "'" ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]).trim().toLowerCase(); if (sh !== me) continue; }
    const a = a1ToAddr(m[2]), b = m[3] ? a1ToAddr(m[3]) : a;
    if (!a || !b) continue;
    out.push({ text: (m[2] + (m[3] ? ':' + m[3] : '')).replace(/\$/g, '').toUpperCase(), r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) });
  }
  return out;
}

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
        <button data-act="undo" title="Deshacer (Ctrl+Z)" aria-label="Deshacer">↶<span class="fxg-lbl"> Deshacer</span></button>
        <button data-act="redo" title="Rehacer (Ctrl+Y)" aria-label="Rehacer">↷<span class="fxg-lbl"> Rehacer</span></button>
        <button data-act="copy" title="Copiar (Ctrl+C)">Copiar</button>
        <button data-act="paste" title="Pegar (Ctrl+V)">Pegar</button>
        <button data-act="fill" title="Rellenar hacia abajo (Ctrl+D)">Rellenar ↓</button>
        <button data-act="clear" title="Borrar contenido (Supr)">Borrar</button>
        <button data-act="bold" class="fxg-fmt" title="Negrita (Ctrl+B)"><b>N</b></button>
        <button data-act="fc" class="fxg-fmt" title="Color de letra"><span class="fxg-fc">A</span> ▾</button>
        <button data-act="bg" class="fxg-fmt" title="Color de relleno"><span class="fxg-bg"></span> ▾</button>
        <button data-act="bd" class="fxg-fmt" title="Bordes: raya abajo, raya arriba, contorno…" aria-label="Bordes" aria-haspopup="menu"><span class="fxg-bdi" aria-hidden="true"></span> ▾</button>
        <button data-act="unfmt" class="fxg-fmt" title="Quitar negrita y colores de lo seleccionado">Sin color</button>
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
    this.selEl = mk('fxg-sel'); this.actEl = mk('fxg-act'); this.handle = mk('fxg-handle'); this.clipEl = mk('fxg-clipbox'); this.fillEl = mk('fxg-fillbox'); this.pointEl = mk('fxg-pointbox'); this._point = null; this._refBoxes = [];
    this.ed = document.createElement('input'); this.ed.className = 'fxg-ed'; this.ed.spellcheck = false; this.ed.autocomplete = 'off'; this.ed.setAttribute('autocapitalize', 'off');
    this.layer.append(this.selEl, this.clipEl, this.fillEl, this.pointEl, this.actEl, this.handle, this.ed);

    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); this._listeners.push([t, ev, fn, o]); };
    on(this.scroll, 'scroll', () => this._schedulePaint());
    this._ro = new ResizeObserver(() => this._schedulePaint()); this._ro.observe(this.scroll);
    on(this.scroll, 'pointerdown', (e) => this._onPointerDown(e));
    on(this.scroll, 'dblclick', (e) => this._onDblClick(e));
    on(this.handle, 'pointerdown', (e) => this._onHandleDown(e));
    on(window, 'pointermove', (e) => this._onPointerMove(e));
    on(window, 'pointerup', (e) => this._onPointerUp(e));
    on(window, 'pointercancel', () => this._onPointerCancel());
    on(this.colHdr, 'pointerdown', (e) => this._onColHdrDown(e));
    on(this.rowHdr, 'pointerdown', (e) => this._onRowHdrDown(e));
    on(this.kb, 'keydown', (e) => this._onKey(e));
    // texto que llega sin keydown útil (teclados móviles "Unidentified", IME, dictado): inicia la edición con ese texto
    on(this.kb, 'input', () => { const v = this.kb.value; this.kb.value = ''; if (v && !this.edit && !this.opts.readOnly) this._beginEdit('enter', v); });
    on(this.kb, 'copy', (e) => this._onCopy(e, false));
    on(this.kb, 'cut', (e) => this._onCopy(e, true));
    on(this.kb, 'paste', (e) => { e.preventDefault(); this._paste(e.clipboardData.getData('text/plain')); });
    on(this.ed, 'keydown', (e) => this._onEdKey(e));
    // v37: no se guarda a medias si el dedo está señalando una celda para la fórmula o si la fórmula sigue en otra hoja
    on(this.ed, 'blur', () => { if (this.edit && !this._held && !(this._touch && this._touch.point === this.ed)) this._commitEdit(null); });
    on(this.ed, 'input', () => { this._pointReset(); if (this.edit && !this.barEditing) this.bar.value = this.ed.value; this._paintRefs(this.ed.value); });
    on(this.bar, 'focus', () => { this.barEditing = true; this.barDirty = false; if (!this.opts.readOnly) this._paintRefs(this.bar.value); });
    on(this.bar, 'input', () => { this._pointReset(); this.barDirty = true; this._paintRefs(this.bar.value); });
    on(this.bar, 'keydown', (e) => {
      if (this.xdraft) {                                    // v37: fórmula de otra hoja: Enter la guarda allá, Esc la deja como estaba
        if (e.key === 'Enter') { e.preventDefault(); this._draftDone(); }
        else if (e.key === 'Escape') { e.preventDefault(); this._draftCancel(); }
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); if (!this.barDirty && this._isTextFormulaAt(this.anchor.r, this.anchor.c)) this.barDirty = true; this._commitBar(); this._focusKb(); this._move(1, 0); }
      else if (e.key === 'Escape') { e.preventDefault(); this.barDirty = false; this.bar.blur(); this._focusKb(); this._updateBar(); }
    });
    on(this.bar, 'blur', () => {
      if (this.xdraft || this._held || (this._touch && this._touch.point === this.bar)) return;      // v37: la fórmula sigue abierta
      this._commitBar(); this.barEditing = false; this._updateBar(); if (!this.edit) this._paintRefs('');
    });
    on(this.nameBox, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.goTo(this.nameBox.value); this._focusKb(); } else if (e.key === 'Escape') { this._updateName(); this._focusKb(); } });
    on(this.nameBox, 'focus', () => this.nameBox.select());
    if (this.tools) on(this.tools, 'click', (e) => { const b = e.target.closest('button[data-act]'); if (b) this._tool(b.dataset.act); });
    const more = q('.fxg-more'); if (more) on(more, 'click', () => r.classList.toggle('fxg-tools-open'));
  }

  /** Confirma una edición a medias (celda o barra de fórmulas) antes de salir de la hoja. */
  commitPending() { if (this.xdraft) return; if (this.edit) this._commitEdit(null); this._commitBar(); }

  /* ------------------------------------------------------- v37: fórmulas que usan celdas de otra hoja (como en Excel)
   * Mientras se escribe una fórmula se puede elegir otra hoja en la lista: la fórmula viaja con ella, un toque en una celda de esa hoja
   * agrega «'Hoja'!A1» y Enter (o «Listo») la guarda en la celda de origen. La app (app.js) lleva la fórmula de una hoja a otra. */
  /** Fórmula a medio escribir: { sid, r, c, text, name } (hoja y celda de ORIGEN) o null. */
  formulaDraft() {
    if (this.xdraft) return { ...this.xdraft, text: this.bar.value };
    return this._held || this._draftNow();
  }
  _draftNow() {
    if (!this.sh || this.opts.readOnly) return null;
    let text = null, r, c;
    if (this.edit && this.ed.style.display !== 'none') { text = this.ed.value; r = this.edit.r; c = this.edit.c; }
    else if (this.barEditing && this.barDirty) { const m = this.sh.mergeAt(this.anchor.r, this.anchor.c); r = m ? m.r0 : this.anchor.r; c = m ? m.c0 : this.anchor.c; text = this.bar.value; }
    if (!text || !'=+-'.includes(text[0])) return null;
    return { sid: this.sid, r, c, text, name: this.sh.name };
  }
  /** Justo antes de que la lista de hojas tome el foco: la fórmula a medias no se guarda al perderlo. */
  holdDraft() { this._held = this.xdraft ? null : this._draftNow(); return this._held; }
  /** No se cambió de hoja: se sigue escribiendo donde estaba. */
  releaseDraft() {
    const d = this._held; this._held = null; if (!d) return;
    const el = this.edit ? this.ed : this.bar;
    try { el.focus({ preventScroll: true }); const n = el.value.length; el.setSelectionRange(n, n); } catch (e) { /* */ }
  }
  /** La fórmula siguió en otra hoja: aquí no se guarda nada. */
  dropPending() { this._held = null; if (this.edit) { this.edit = null; this.ed.style.display = 'none'; } this.barDirty = false; }
  /** Esta hoja recibe la fórmula de otra: la barra de arriba la muestra y los toques agregan celdas de ESTA hoja. */
  openDraft(d, { onDone, onCancel } = {}) {
    this.xdraft = { sid: d.sid, r: d.r, c: d.c, name: d.name, text: d.text };
    this._draftCb = { onDone, onCancel };
    this.root.classList.add('fxg-xdraft');
    this.bar.value = d.text; this.barEditing = true; this.barDirty = false;
    this._pointReset();
    try { this.bar.focus({ preventScroll: true }); const n = d.text.length; this.bar.setSelectionRange(n, n); } catch (e) { /* */ }
  }
  _draftDone() { const cb = this._draftCb, t = this.bar.value; if (cb && cb.onDone) cb.onDone(t); }
  _draftCancel() { const cb = this._draftCb; if (cb && cb.onCancel) cb.onCancel(); }
  /** De vuelta en la hoja de origen: sigue escribiendo la fórmula (commit=false) o la guarda en su celda (commit=true). */
  resumeDraft(d, { commit = false } = {}) {
    this.select(d.r, d.c, null, null, true);
    if (commit) { this._applyText(d.r, d.c, d.text); return; }
    if (COARSE() && this.bar) {                                  // en el celular se escribe en la barra de arriba
      this.bar.value = d.text; this.barEditing = true;
      try { this.bar.focus({ preventScroll: true }); const n = d.text.length; this.bar.setSelectionRange(n, n); } catch (e) { /* */ }
      this.barDirty = true; this._paintRefs(d.text);
    } else this._beginEdit('enter', d.text);
  }
  /** ¿La celda tiene una fórmula guardada como texto (vino así del Excel)? Al confirmarla otra vez pasa a calcular. */
  _isTextFormulaAt(r, c) { const x = this.eng.raw(this.sid, r, c); return typeof x === 'string' && x[0] === '=' && this.sh.textCells.has(K(r, c)); }

  destroy() {
    for (const [t, ev, fn, o] of this._listeners) t.removeEventListener(ev, fn, o);
    this._listeners = []; if (this._ro) this._ro.disconnect();
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }      // un repintado pendiente leería el motor DESPUÉS de soltarlo (p. ej. el visor del archivo lo libera al salir)
    clearTimeout(this._tt);
    this.sh = null;                                                           // desde aquí _paint/_updateStatus no hacen nada
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
  /**
   * Modo solo lectura (p. ej. el visor del archivo mensual): sin edición, pegado, relleno, borrado ni deshacer; se puede seleccionar,
   * copiar, cambiar el zoom y moverse. La barra de fórmulas pasa a ser de solo lectura (se puede ver y copiar su contenido).
   */
  setReadOnly(v) {
    const ro = !!v;
    this.opts.readOnly = ro;
    this.root.classList.toggle('fxg-ro', ro);
    if (this.bar) { this.bar.readOnly = ro; if (ro) this.barDirty = false; }
    if (this.handle && ro && !COARSE()) this.handle.style.display = 'none';
    if (this.tools) {
      for (const b of this.tools.querySelectorAll('button[data-act]')) {
        const act = b.dataset.act;
        b.hidden = ro && (act === 'undo' || act === 'redo' || act === 'paste' || act === 'fill' || act === 'clear' || act === 'bold' || act === 'fc' || act === 'bg' || act === 'bd' || act === 'unfmt' || (act === 'find' && !this.opts.onFind));
      }
    }
  }
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
  /** Deja la fila r hacia el 62 % de la altura visible: se ven los movimientos anteriores encima y la fila libre queda a mano. */
  showRowLow(r) {
    const R = this._cellRect(r, 0), sc = this.scroll;
    sc.scrollTop = Math.max(0, R.y - Math.round((sc.clientHeight || 400) * 0.62));
    this._paint(true);
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
    // con ratón el asa rellena (no en solo lectura); en pantallas táctiles selecciona un rango, también en solo lectura (para ver la suma)
    this.handle.style.cssText = this.opts.readOnly && !COARSE() ? 'display:none' : `display:block;left:${box.x + box.w - 5}px;top:${box.y + box.h - 5}px`;
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
    if (typeof raw === 'string') return raw[0] === '=' && !this.sh.textCells.has(K(r, c)) ? toSpanish(raw) : raw;      // las fórmulas se muestran como en Excel en español (SUMAR.SI, «;»); un texto que empieza con «=» no
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
    this.stR.classList.toggle('sum', n > 0);
  }

  /* ------------------------------------------------------------------ apuntar (como Excel)
   * Mientras se escribe una fórmula (empieza con = + -) y el cursor está donde va una celda (después de un operador, «(», «,»…), un clic en otra celda,
   * Mayús+clic, arrastrar o una flecha INSERTAN su dirección (H2050, A1:B3) en vez de terminar la edición; otro clic seguido la cambia por la nueva. */
  _pointField() {
    let el = null;
    if (this.xdraft) el = this.bar;                          // v37: fórmula que viene de otra hoja
    else if (this.edit && this.ed.style.display !== 'none') el = this.ed;
    else if (this.barEditing && document.activeElement === this.bar && !this.opts.readOnly) el = this.bar;
    if (!el) return null;
    const v = el.value, a = el.selectionStart, b = el.selectionEnd;
    if (!v || !'=+-'.includes(v[0]) || a == null) return null;
    const p = this._point;
    if (p && p.el === el && a === p.end && b === p.end && v.slice(p.start, p.end) === p.text) return el;      // justo tras la celda apuntada: se puede cambiar por otra
    const before = v.slice(0, a).replace(/\s+$/, '');
    return before && '=+-*/^(,;&<>:'.includes(before[before.length - 1]) ? el : null;
  }
  _pointInsert(el, r, c, r2 = r, c2 = c) {
    const m = this.sh.mergeAt(r, c); if (m) { r = m.r0; c = m.c0; }
    const a1 = (rr, cc) => colLetter(cc) + (rr + 1);
    const lo = { r: Math.min(r, r2), c: Math.min(c, c2) }, hi = { r: Math.max(r, r2), c: Math.max(c, c2) };
    const pre = this.xdraft ? sheetRef(this.sh.name) + '!' : '';            // v37: en otra hoja la celda lleva el nombre de la hoja
    const text = pre + ((lo.r === hi.r && lo.c === hi.c) ? a1(lo.r, lo.c) : a1(lo.r, lo.c) + ':' + a1(hi.r, hi.c));
    const v = el.value, p = this._point;
    let start = el.selectionStart, end = el.selectionEnd;
    if (p && p.el === el && v.slice(p.start, p.end) === p.text && start === p.end && end === p.end) { start = p.start; end = p.end; }
    el.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    try { el.setSelectionRange(pos, pos); } catch (e) { /* sin selección */ }
    this._point = { el, start, end: pos, text, r: lo.r, c: lo.c };
    this._paintRefs(el.value);
    this._box(this.pointEl, { r0: lo.r, c0: lo.c, r1: hi.r, c1: hi.c });
    try { el.focus({ preventScroll: true }); el.setSelectionRange(pos, pos); } catch (e) { /* */ }
    if (el === this.ed) this.bar.value = el.value; else { this.barEditing = true; this.barDirty = true; }   // después del foco (al enfocar se reinicia barDirty)
  }
  _pointReset() { this._point = null; if (this.pointEl) this.pointEl.style.display = 'none'; }
  /** Enciende con un recuadro de color cada celda o rango de esta hoja que usa la fórmula en edición ('' = apagar). */
  _paintRefs(text) {
    for (const b of this._refBoxes) b.remove();
    this._refBoxes = [];
    if (!this.sh || !text) return;
    const refs = formulaRefs(text, this.sh.name), colors = new Map();
    for (const R of refs.slice(0, 40)) {
      if (R.r0 >= this.nTotal || R.c0 >= this.nCols) continue;
      const box = { r0: R.r0, c0: R.c0, r1: Math.min(R.r1, this.nTotal - 1), c1: Math.min(R.c1, this.nCols - 1) };
      if (box.r0 === box.r1 && box.c0 === box.c1) { const mg = this.sh.mergeAt(box.r0, box.c0); if (mg) Object.assign(box, mg); }
      if (!colors.has(R.text)) colors.set(R.text, REF_COLORS[colors.size % REF_COLORS.length]);
      const col = colors.get(R.text), el = document.createElement('div');
      el.className = 'fxg-refbox'; el.dataset.ref = R.text;
      this._box(el, box);
      el.style.borderColor = col; el.style.background = col + '1f';
      this.layer.insertBefore(el, this.pointEl);
      this._refBoxes.push(el);
    }
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
    if (e.pointerType === 'mouse' && e.button === 0) {
      const pf = this._pointField();
      if (pf) {                                              // escribiendo una fórmula: el clic inserta la celda
        e.preventDefault();
        const p = this._point, from = e.shiftKey && p && p.el === pf ? { r: p.r, c: p.c } : { r: cell.r, c: cell.c };
        this._pointInsert(pf, from.r, from.c, cell.r, cell.c);
        this.drag = { type: 'point', el: pf, from };
        return;
      }
    }
    if (e.pointerType !== 'mouse') {                        // v37: con el dedo también: tocar una celda la agrega a la fórmula (al soltar, si no fue para desplazarse)
      const pf = this._pointField();
      if (pf) { e.preventDefault(); this._touch = { x: e.clientX, y: e.clientY, t: Date.now(), cell, sx: this.scroll.scrollLeft, sy: this.scroll.scrollTop, point: pf }; return; }
    }
    if (this.xdraft && e.pointerType === 'mouse') {        // fórmula de otra hoja y el cursor no está después de un signo
      e.preventDefault();
      this._toast('Escribe un signo (+ − * /) antes de tocar la celda que quieres agregar.');
      return;
    }
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
    if (this.drag.type === 'point') { this._pointInsert(this.drag.el, this.drag.from.r, this.drag.from.c, cell.r, cell.c); this._autoScroll(e); return; }
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
      if (t.point) {                                         // v37: escribiendo una fórmula: el toque agrega la celda; si se desplazó, se sigue escribiendo
        if (moved < 10 && Date.now() - t.t < 900) this._pointInsert(t.point, t.cell.r, t.cell.c);
        else { try { t.point.focus({ preventScroll: true }); } catch (err) { /* */ } }
        return;
      }
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
    if (d.type === 'point') { try { d.el.focus({ preventScroll: true }); } catch (err) { /* */ } return; }
    if (d.type === 'fill') {
      this.fillEl.style.display = 'none';
      if (d.target) this._doFill(d.src, d.target);
    } else if (d.type === 'colresize') {
      if (d.w && Math.abs(d.w - d.w0) > 1) {
        this.sh.colWidths.set(d.c, Math.round(d.w / this.zoom)); if (!this.opts.readOnly) this.eng.dirty.add(this.sid);   // en solo lectura el ancho es solo de la vista
        this._layout(); this._paint(true); this._afterSelect(false); this.opts.onChange({ sid: this.sid, changes: [], layout: true });
      }
      this.colHdr.style.cursor = '';
    }
  }
  _onDblClick(e) {
    const cell = this._cellAt(e);
    if (cell.onScrollbar || this.opts.readOnly) return;
    if (this.xdraft || this._pointField()) return;           // v37: escribiendo una fórmula, el doble clic no abre otra celda
    this.anchor = { r: cell.r, c: cell.c }; this.focus = { ...this.anchor };
    this._beginEdit('edit', null);
  }
  /** Asa de la esquina: con ratón rellena hacia abajo/derecha (como Excel); con el dedo o un lápiz extiende la selección (como Excel y
   *  Google Sheets en el celular), así se ve la suma del rango; para copiar en el celular está «Rellenar ↓». */
  _onHandleDown(e) {
    e.preventDefault(); e.stopPropagation();
    if (this.edit) this._commitEdit(null);
    if (e.pointerType === 'mouse' && !this.opts.readOnly) { this.drag = { type: 'fill', src: this._rect(), target: null }; return; }
    this._focusKb();
    this.drag = { type: 'select', grip: true };
  }
  /** El sistema canceló el gesto (p. ej. iOS lo tomó para desplazar): se suelta sin hacer nada. */
  _onPointerCancel() {
    const t = this._touch;
    this._touch = null;
    if (t && t.point) { try { t.point.focus({ preventScroll: true }); } catch (e) { /* */ } }   // v37: se desplazó escribiendo una fórmula
    if (!this.drag) return;
    if (this.drag.type === 'fill') this.fillEl.style.display = 'none';
    if (this.drag.type === 'colresize') this.colHdr.style.cursor = '';
    this.drag = null;
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
    if (this.xdraft) {                                       // v37: fórmula de otra hoja: las teclas siguen escribiéndola en la barra
      if (k === 'Enter') { e.preventDefault(); this._draftDone(); }
      else if (k === 'Escape') { e.preventDefault(); this._draftCancel(); }
      else if (!ctrl && (k.length === 1 || k === 'Backspace' || k === 'Dead' || k === 'Process')) { try { this.bar.focus({ preventScroll: true }); const n = this.bar.value.length; this.bar.setSelectionRange(n, n); } catch (err) { /* */ } }
      else if (!ctrl) e.preventDefault();
      return;
    }
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
      if (key === 'b') { e.preventDefault(); this._toggleBold(); return; }
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
    if (this.xdraft) {                                       // v37: aquí no se edita otra celda: se sigue la fórmula de la otra hoja
      try { this.bar.focus({ preventScroll: true }); const n = this.bar.value.length; this.bar.setSelectionRange(n, n); } catch (e) { /* */ }
      if (initial) { this.bar.value += initial; this.bar.dispatchEvent(new Event('input')); }
      return;
    }
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
    this.edit = { r, c, mode, orig }; this._pointReset();
    const R = this._cellRect(r, c), ed = this.ed;
    ed.style.cssText = `display:block;left:${R.x}px;top:${R.y}px;min-width:${Math.max(R.w, 80)}px;width:${Math.max(R.w, 80)}px;height:${R.h}px;font-size:${13 * this.zoom}px`;
    ed.value = text; this.bar.value = text; this._paintRefs(text);
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
      if (this._pointField() === this.ed) {                  // escribiendo una fórmula: la flecha apunta a la celda vecina
        const p = this._point && this._point.el === this.ed ? this._point : null;
        const base = p ? { r: p.r, c: p.c } : { r: this.edit.r, c: this.edit.c };
        const nr = Math.max(0, base.r + d[0]), nc = Math.max(0, Math.min(this.nCols - 1, base.c + d[1]));
        this._ensureVisible(nr, nc); this._pointInsert(this.ed, nr, nc);
        return;
      }
      this._commitEdit({ dr: d[0], dc: d[1] });
    }
  }
  _commitEdit(move) {
    const e = this.edit; if (!e) return;
    this.edit = null; this._pointReset(); this._paintRefs('');
    const text = this.ed.value;
    this.ed.style.display = 'none';
    if (text !== e.orig || (text === e.orig && this._isTextFormulaAt(e.r, e.c))) this._applyText(e.r, e.c, text);   // v37: fórmula que era texto: al confirmarla calcula
    this._focusKb();
    this._updateBar();
    if (move) this._move(move.dr, move.dc);
  }
  _cancelEdit() { if (!this.edit) return; this.edit = null; this._pointReset(); this._paintRefs(''); this.ed.style.display = 'none'; this._focusKb(); this._updateBar(); }
  _commitBar() {
    if (this.opts.readOnly || !this.barDirty || !this.sh) { this.barDirty = false; return; }
    this.barDirty = false;
    const m = this.sh.mergeAt(this.anchor.r, this.anchor.c);
    const r = m ? m.r0 : this.anchor.r, c = m ? m.c0 : this.anchor.c;
    if (this.bar.value !== this._rawText(r, c) || this._isTextFormulaAt(r, c)) this._applyText(r, c, this.bar.value);
  }
  _applyText(r, c, text) {
    if (this.opts.readOnly) return;
    const sid = this.sid, sh = this.sh, eng = this.eng;
    const stId = sh.styleAt(r, c), st = eng.styles[stId] || EMPTY;
    let { raw, nf } = parseInput(text, st);
    if (typeof raw === 'number' && sh.textCells.has(K(r, c)) && /^\d+$/.test(text.trim())) raw = text.trim();   // números de cuenta con ceros a la izquierda siguen siendo texto
    const cur = eng.raw(sid, r, c);
    if (raw === cur && !(typeof raw === 'string' && raw[0] === '=' && sh.textCells.has(K(r, c)))) return;
    let changes;
    try { changes = eng.set(sid, r, c, raw); } catch (err) { this._toast('No se pudo guardar: ' + err.message); return; }
    const useNf = (!st.nf || st.nf === 'General') ? this._inferNf(r, c, raw, nf, text) : null;
    if (useNf) sh.setStyle(r, c, eng.deriveStyle(stId, { nf: useNf }));
    this._afterChange(changes);
  }
  /**
   * Formato de número para lo que se acaba de teclear en una celda SIN formato: el de la celda de arriba en la misma columna (la más cercana con contenido o con formato,
   * hasta 60 filas) —igual que Excel al seguir una lista—, así las fechas quedan como fechas y los montos como dólares con centavos en las filas nuevas.
   * Una fecha tecleada usa el formato de fecha de la columna; un número o una fórmula, el de números (dólares, decimales, %); con «$» tecleado y sin
   * nada arriba se usa dólares con dos decimales.
   */
  _inferNf(r, c, raw, nfTyped, text) {
    const isNum = typeof raw === 'number', isFormula = typeof raw === 'string' && raw[0] === '=';
    if (isNum || isFormula) {
      for (let k = r - 1; k >= 0 && k >= r - 60; k--) {
        const v = this.eng.raw(this.sid, k, c);
        const above = (this.eng.styles[this.sh.styleAt(k, c)] || EMPTY).nf;
        const hasNf = !!above && above !== 'General' && above !== '@';
        const blank = v === null || v === undefined || v === '';
        if (blank && !hasNf) continue;                                           // fila en blanco y sin formato: se sigue buscando hacia arriba
        if (hasNf) {                                                             // con contenido o con el formato ya puesto (filas preparadas)
          const dateAbove = isDateFormat(above);
          if (nfTyped) return dateAbove ? above : nfTyped;                      // fecha tecleada: formato de fecha de la columna
          if (!dateAbove) return above;                                          // número o fórmula: formato numérico de la columna
        }
        break;                                                                   // la columna usa formato General: no se busca más lejos
      }
    }
    if (nfTyped) return nfTyped;
    if (isNum && /^[-+]?\s*\$/.test(String(text).trim())) return '$#,##0.00';      // «$12.5» sin nada arriba: dólares con centavos
    return undefined;
  }
  /** steps = cuántas operaciones del motor hizo este cambio (rellenar pega fila por fila): Deshacer las revierte todas juntas. */
  _afterChange(changes, { fromUndo = false, steps = 1 } = {}) {
    if (!fromUndo) { this._pushHist({ hf: true, steps }); this._redoN = []; }
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
  _undo() {
    if (this.opts.readOnly) return;
    const h = this._hist && this._hist.length ? this._hist.pop() : null;
    if (h && h.fmt) { for (const [r, c, s] of h.fmt) this.sh.setStyle(r, c, s); this._afterFormat(); return; }   // el último cambio fue de formato
    const n = h && h.hf && h.steps > 1 ? h.steps : 1;
    let all = null;
    for (let i = 0; i < n; i++) { const ch = this.eng.undo(); if (ch === null) break; all = (all || []).concat(ch); }
    if (all === null) { this._toast('Nada que deshacer'); return; }
    (this._redoN || (this._redoN = [])).push(n);
    this._afterChange(all, { fromUndo: true });
  }
  _redo() {
    if (this.opts.readOnly) return;
    const n = this._redoN && this._redoN.length ? this._redoN.pop() : 1;
    let all = null;
    for (let i = 0; i < n; i++) { const ch = this.eng.redo(); if (ch === null) break; all = (all || []).concat(ch); }
    if (all === null) { this._toast('Nada que rehacer'); return; }
    this._pushHist({ hf: true, steps: n });                                  // vuelve a quedar para Deshacer, en su orden
    this._afterChange(all, { fromUndo: true });
  }
  _pushHist(x) { if (!this._hist) this._hist = []; this._hist.push(x); if (this._hist.length > 200) this._hist.shift(); }

  /* ----------------------------------------------------------------- formato: negrita y colores (para conciliar) */
  /** Aplica cambios de estilo a lo seleccionado (valor undefined = quitar). Se deshace con Deshacer o Ctrl+Z. */
  _format(patch) {
    if (this.opts.readOnly || !this.sh) return;
    const R = this._rect();
    if ((R.r1 - R.r0 + 1) * (R.c1 - R.c0 + 1) > 300000) { this._toast('La selección es demasiado grande para darle formato'); return; }
    const prev = [];
    for (let r = R.r0; r <= R.r1; r++) for (let c = R.c0; c <= R.c1; c++) {
      const s = this.sh.styleAt(r, c), ns = this.eng.deriveStyle(s, patch);
      if (ns !== s) { prev.push([r, c, s]); this.sh.setStyle(r, c, ns); }
    }
    if (!prev.length) return;
    this._pushHist({ fmt: prev });
    this._afterFormat();
  }
  _afterFormat() { this._relayoutIfGrown(); this._paint(true); this._paintSel(); this.opts.onChange({ sid: this.sid, changes: [], format: true }); }
  _toggleBold() {
    if (this.opts.readOnly || !this.sh) return;
    const R = this._rect(); let all = true;
    for (let r = R.r0; r <= R.r1 && all; r++) for (let c = R.c0; c <= R.c1 && all; c++) if (!(this.eng.styles[this.sh.styleAt(r, c)] || {}).b) all = false;
    this._format({ b: all ? undefined : true });
  }
  /** Paleta de colores (letra o relleno) junto al botón. */
  _palette(kind) {
    if (this.opts.readOnly) return;
    if (this._pal) { const same = this._pal.dataset.kind === kind; this._pal.remove(); this._pal = null; if (same) return; }
    const colors = kind === 'fc'
      ? [['#000000', 'Negro'], ['#C00000', 'Rojo'], ['#E36C09', 'Naranja'], ['#00803C', 'Verde'], ['#0070C0', 'Azul'], ['#7030A0', 'Morado'], ['#808080', 'Gris']]
      : [['#FFFF00', 'Amarillo'], ['#C6EFCE', 'Verde claro'], ['#FFC7CE', 'Rojo claro'], ['#FCE4D6', 'Naranja claro'], ['#DDEBF7', 'Azul claro'], ['#E4DFEC', 'Morado claro'], ['#D9D9D9', 'Gris']];
    const pal = document.createElement('div');
    pal.className = 'fxg-pal'; pal.dataset.kind = kind; pal.setAttribute('role', 'menu');
    pal.setAttribute('aria-label', kind === 'fc' ? 'Color de letra' : 'Color de relleno');
    const add = (val, label, inner) => {
      const b = document.createElement('button'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.setAttribute('role', 'menuitem');
      if (inner) b.textContent = inner; else b.style.background = val;
      if (val) b.dataset.color = val;
      b.addEventListener('click', () => { pal.remove(); this._pal = null; this._format({ [kind]: val || undefined }); this._focusKb(); });
      pal.append(b);
    };
    for (const [v, l] of colors) add(v, l);
    add(null, kind === 'fc' ? 'Letra normal' : 'Sin relleno', 'Ninguno');
    const btn = this.tools && this.tools.querySelector('button[data-act="' + kind + '"]');
    const rc = btn ? btn.getBoundingClientRect() : { left: 10, bottom: 60 };
    pal.style.left = Math.max(6, Math.min(rc.left, window.innerWidth - 230)) + 'px';
    pal.style.top = (rc.bottom + 4) + 'px';
    document.body.append(pal); this._pal = pal;
    const away = (e) => {
      if (!pal.isConnected) { document.removeEventListener('pointerdown', away, true); return; }
      if (!pal.contains(e.target) && !(btn && btn.contains(e.target))) { pal.remove(); if (this._pal === pal) this._pal = null; document.removeEventListener('pointerdown', away, true); }
    };
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  }

  /**
   * Bordes de lo seleccionado, como en Excel (rayas finas, las mismas que ya traía el libro):
   *   'b' raya abajo (borde inferior del rango) · 't' raya arriba (borde superior) · 'tb' arriba y abajo · 'all' todos los bordes ·
   *   'box' contorno (solo el borde exterior) · 'none' sin bordes (quita también la raya de la celda vecina que toca lo seleccionado).
   * Se guardan en el estilo de cada celda (bd = lados 't', 'b', 'l', 'r') y se deshacen con Deshacer o Ctrl+Z.
   */
  _borders(kind) {
    if (this.opts.readOnly || !this.sh) return;
    const R = this._rect();
    if ((R.r1 - R.r0 + 1) * (R.c1 - R.c0 + 1) > 300000) { this._toast('La selección es demasiado grande para darle formato'); return; }
    const prev = [], seen = new Set();
    const setBd = (r, c, add, del) => {
      if (r < 0 || c < 0) return;
      const s = this.sh.styleAt(r, c), st = this.eng.styles[s] || {};
      const cur = typeof st.bd === 'string' ? st.bd : '';
      const next = 'tblr'.split('').filter((ch) => (cur.includes(ch) && !del.includes(ch)) || add.includes(ch)).join('');
      if (next === 'tblr'.split('').filter((ch) => cur.includes(ch)).join('')) return;
      const ns = this.eng.deriveStyle(s, { bd: next || undefined });
      if (ns === s) return;
      const k = r + ',' + c;
      if (!seen.has(k)) { seen.add(k); prev.push([r, c, s]); }
      this.sh.setStyle(r, c, ns);
    };
    for (let r = R.r0; r <= R.r1; r++) for (let c = R.c0; c <= R.c1; c++) {
      const top = r === R.r0, bot = r === R.r1, left = c === R.c0, right = c === R.c1;
      if (kind === 'b') { if (bot) setBd(r, c, 'b', ''); }
      else if (kind === 't') { if (top) setBd(r, c, 't', ''); }
      else if (kind === 'tb') { if (top || bot) setBd(r, c, (top ? 't' : '') + (bot ? 'b' : ''), ''); }
      else if (kind === 'all') setBd(r, c, 'tblr', '');
      else if (kind === 'box') { if (top || bot || left || right) setBd(r, c, (top ? 't' : '') + (bot ? 'b' : '') + (left ? 'l' : '') + (right ? 'r' : ''), ''); }
      else if (kind === 'none') {
        setBd(r, c, '', 'tblr');
        if (top) setBd(r - 1, c, '', 'b');
        if (bot) setBd(r + 1, c, '', 't');
        if (left) setBd(r, c - 1, '', 'r');
        if (right) setBd(r, c + 1, '', 'l');
      }
    }
    if (!prev.length) return;
    this._pushHist({ fmt: prev });
    this._afterFormat();
  }
  /** Menú «Bordes» junto al botón (como la paleta de colores). */
  _borderMenu() {
    if (this.opts.readOnly) return;
    if (this._pal) { const same = this._pal.dataset.kind === 'bd'; this._pal.remove(); this._pal = null; if (same) return; }
    const icon = (sides, inner) => '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">' +
      '<rect x="3" y="3" width="14" height="14" fill="none" stroke="#b5bdc1" stroke-dasharray="2 2"/>' +
      (inner ? '<path d="M10 3v14M3 10h14" stroke="#1d2b2e" stroke-width="1.6"/>' : '') +
      (sides.includes('t') ? '<path d="M2 3h16" stroke="#1d2b2e" stroke-width="2.2"/>' : '') +
      (sides.includes('b') ? '<path d="M2 17h16" stroke="#1d2b2e" stroke-width="2.2"/>' : '') +
      (sides.includes('l') ? '<path d="M3 2v16" stroke="#1d2b2e" stroke-width="2.2"/>' : '') +
      (sides.includes('r') ? '<path d="M17 2v16" stroke="#1d2b2e" stroke-width="2.2"/>' : '') + '</svg>';
    const items = [['b', 'Raya abajo', icon('b')], ['t', 'Raya arriba', icon('t')], ['tb', 'Raya arriba y abajo', icon('tb')],
      ['all', 'Todos los bordes', icon('tblr', true)], ['box', 'Contorno', icon('tblr')], ['none', 'Sin bordes', icon('')]];
    const menu = document.createElement('div');
    menu.className = 'fxg-pal fxg-bdm'; menu.dataset.kind = 'bd'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Bordes');
    const close = () => { menu.remove(); if (this._pal === menu) this._pal = null; document.removeEventListener('pointerdown', away, true); };
    for (const [kind, label, svg] of items) {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.dataset.bd = kind;
      b.innerHTML = svg + '<span>' + label + '</span>';
      b.addEventListener('click', () => { close(); this._borders(kind); this._focusKb(); });
      menu.append(b);
    }
    menu.addEventListener('keydown', (e) => {
      const list = [...menu.querySelectorAll('button')], i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); this._focusKb(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    });
    const btn = this.tools && this.tools.querySelector('button[data-act="bd"]');
    const rc = btn ? btn.getBoundingClientRect() : { left: 10, bottom: 60 };
    menu.style.left = Math.max(6, Math.min(rc.left, window.innerWidth - 230)) + 'px';
    menu.style.top = (rc.bottom + 4) + 'px';
    document.body.append(menu); this._pal = menu;
    const away = (e) => {
      if (!menu.isConnected) { document.removeEventListener('pointerdown', away, true); return; }
      if (!menu.contains(e.target) && !(btn && btn.contains(e.target))) close();
    };
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    const first = menu.querySelector('button'); if (first) try { first.focus({ preventScroll: true }); } catch (e) { /* nada */ }
  }

  /* ----------------------------------------------------------------- rellenar */
  _fillDown() {
    if (this.opts.readOnly) return;
    const R = this._rect(); let ch = [];
    let steps = 1;
    if (R.r0 === R.r1) { if (R.r0 === 0) return; ch = this.eng.copyPaste(this.sid, R.r0 - 1, R.c0, R.r0 - 1, R.c1, this.sid, R.r0, R.c0); }
    else { steps = R.r1 - R.r0; for (let r = R.r0 + 1; r <= R.r1; r++) ch = ch.concat(this.eng.copyPaste(this.sid, R.r0, R.c0, R.r0, R.c1, this.sid, r, R.c0)); }
    this._afterChange(ch, { steps });
  }
  _fillRight() {
    if (this.opts.readOnly) return;
    const R = this._rect(); let ch = [];
    if (R.c0 === R.c1) { if (R.c0 === 0) return; ch = this.eng.copyPaste(this.sid, R.r0, R.c0 - 1, R.r1, R.c0 - 1, this.sid, R.r0, R.c0); }
    else for (let c = R.c0 + 1; c <= R.c1; c++) ch = ch.concat(this.eng.copyPaste(this.sid, R.r0, R.c0, R.r1, R.c0, this.sid, R.r0, c));
    this._afterChange(ch);
  }
  _doFill(src, tgt) {
    if (this.opts.readOnly) return;
    let ch = [];
    let steps = 0;
    if (tgt.r1 > src.r1) {
      const rows = src.r1 - src.r0 + 1;
      for (let r = src.r1 + 1; r <= tgt.r1; r++) { const s = src.r0 + ((r - src.r1 - 1) % rows); ch = ch.concat(this.eng.copyPaste(this.sid, s, src.c0, s, src.c1, this.sid, r, src.c0)); steps++; }
    } else if (tgt.c1 > src.c1) {
      const cols = src.c1 - src.c0 + 1;
      for (let c = src.c1 + 1; c <= tgt.c1; c++) { const s = src.c0 + ((c - src.c1 - 1) % cols); ch = ch.concat(this.eng.copyPaste(this.sid, src.r0, s, src.r1, s, this.sid, src.r0, c)); steps++; }
    }
    if (!steps) return;
    this.anchor = { r: tgt.r0, c: tgt.c0 }; this.focus = { r: tgt.r1, c: tgt.c1 };
    this._afterChange(ch, { steps }); this._afterSelect(false);
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
    if (this.opts.readOnly) return;                // sin pegar (y sin pedir permiso para leer el portapapeles)
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
          const useNf = (!st.nf || st.nf === 'General') ? this._inferNf(R.r0 + i, R.c0 + j, p.raw, p.nf, cell) : null;
          if (useNf) styleFix.push([R.r0 + i, R.c0 + j, useNf]);
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
    if (this.xdraft) { this._toast('Primero termina la fórmula: «Listo» la guarda y «Cancelar» la deja como estaba.'); return; }   // v37
    if (act === 'find') { if (this.opts.onFind) this.opts.onFind(); return; }
    if (act === 'copy') return this._copyButton();
    if (act === 'paste') return this._pasteButton();
    if (act === 'undo') return this._undo();
    if (act === 'redo') return this._redo();
    if (act === 'fill') return this._fillDown();
    if (act === 'clear') return this._clearSel();
    if (act === 'bold') return this._toggleBold();
    if (act === 'fc' || act === 'bg') return this._palette(act);
    if (act === 'bd') return this._borderMenu();
    if (act === 'unfmt') return this._format({ b: undefined, fc: undefined, bg: undefined });
  }
  _toast(msg) { if (this.opts.onToast) this.opts.onToast(msg); else { this.stL.textContent = msg; clearTimeout(this._tt); this._tt = setTimeout(() => this._updateStatus(), 2500); } }
}
