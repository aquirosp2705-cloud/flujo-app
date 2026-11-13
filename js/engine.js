/* engine.js — modelo de hojas + motor de cálculo (HyperFormula) de FlujoWeb.
 *
 * Requiere que vendor/hyperformula.full.min.js ya esté cargado (global `HyperFormula`).
 * Todas las filas/columnas son base 0. `sid` = id de hoja ("s01"...).
 *
 * Contenido "crudo" de una celda (raw): número | texto | booleano | null | texto que empieza con "=" (fórmula).
 * Los textos que HyperFormula convertiría solos (p. ej. "0012345678", "12/05/2020", "TRUE") se guardan
 * internamente como fórmula ="..." y se marcan en `sheet.textCells` para que se muestren/exporten como texto.
 */

export const HF_CONFIG = {
  licenseKey: 'gpl-v3',
  evaluateNullToZero: true,          // =A1 con A1 vacía da 0, como Excel
  nullDate: { year: 1899, month: 12, day: 31 },
  leapYear1900: true,                // emula el 29-feb-1900 de Excel: números de serie pequeños (DAY(2)=2) idénticos a Excel
  accentSensitive: true,             // Excel distingue "peluquería" de "peluqueria" en SUMIF/BUSCARV
  caseSensitive: false,
  dateFormats: ['DD/MM/YYYY', 'DD/MM/YY', 'DD-MM-YYYY', 'YYYY-MM-DD'],
  timeFormats: ['hh:mm', 'hh:mm:ss.sss'],
  smartRounding: true,
  undoLimit: 100,
};

const K = (r, c) => r * 4096 + c;           // clave de celda
export const cellKey = K;

const NUMLIKE = /^\s*[+-]?(\d+([.,]\d*)?|[.,]\d+)(e[+-]?\d+)?\s*%?\s*$/i;
const BOOLLIKE = /^\s*(true|false|verdadero|falso)\s*$/i;
const DATELIKE = /^\s*\d{1,4}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{1,4}\s*$/;
const TIMELIKE = /^\s*\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\s*$/i;
const ERRLIKE = /^#(REF|DIV\/0|VALUE|NAME|N\/A|NUM|NULL|ERROR)[!?]?$/i;
const CURLIKE = /^\s*[-+(]?\s*[$€£]\s*[-+]?[\d.,]+\s*\)?\s*$/;   // "$300.00" pegado del banco = texto en Excel
const WRAPPED = /^="((?:[^"]|"")*)"$/;

export function looksParsable(s) {
  return NUMLIKE.test(s) || BOOLLIKE.test(s) || DATELIKE.test(s) || TIMELIKE.test(s) || ERRLIKE.test(s) || CURLIKE.test(s) || s[0] === '=';
}
export const wrapText = (s) => '="' + s.replace(/"/g, '""') + '"';
export const unwrapText = (f) => { const m = WRAPPED.exec(f); return m ? m[1].replace(/""/g, '"') : null; };

/* ---------- compatibilidad con Excel: SUMIF con rangos de distinto tamaño ----------
 * Excel toma la esquina superior izquierda de sum_range y lo redimensiona al tamaño del rango de criterios.
 * HyperFormula exige el mismo tamaño (#VALUE!), así que reescribimos sum_range con el tamaño correcto. */
const REF_RE = /^((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?$/;
function splitTopLevel(s, start) {
  // s[start] está justo después del "(" ; devuelve {args:[{text,from,to}], end} con end = índice del ")" que cierra
  const args = []; let depth = 0, inStr = false, inQ = false, from = start;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '"') { if (s[i + 1] === '"') i++; else inStr = false; } continue; }
    if (inQ) { if (ch === "'") { if (s[i + 1] === "'") i++; else inQ = false; } continue; }
    if (ch === '"') inStr = true;
    else if (ch === "'") inQ = true;
    else if (ch === '(') depth++;
    else if (ch === ')') { if (depth === 0) { args.push({ text: s.slice(from, i), from, to: i }); return { args, end: i }; } depth--; }
    else if (ch === ',' && depth === 0) { args.push({ text: s.slice(from, i), from, to: i }); from = i + 1; }
  }
  return null;
}
export function fixFormulaForHF(f, mode = 'extend') {
  if (typeof f !== 'string' || !/sumif\s*\(/i.test(f)) return f;
  let out = f, guard = 0;
  const re = /sumif\s*\(/gi;
  const hits = [];
  let m; while ((m = re.exec(out))) hits.push(m.index + m[0].length);
  for (let h = hits.length - 1; h >= 0 && guard++ < 50; h--) {      // de atrás hacia adelante: los índices previos no se mueven
    const sp = splitTopLevel(out, hits[h]);
    if (!sp || sp.args.length !== 3) continue;
    const a1 = REF_RE.exec(sp.args[0].text.trim()), a3 = REF_RE.exec(sp.args[2].text.trim());
    if (!a1 || !a3 || !a1[6] && !a1[9]) continue;                   // criterio debe ser un rango A1:B2
    const rows1 = +a1[9] - +a1[5] + 1, cols1 = colIndex(a1[7]) - colIndex(a1[3]) + 1;
    const rows3 = a3[9] ? +a3[9] - +a3[5] + 1 : 1, cols3 = a3[7] ? colIndex(a3[7]) - colIndex(a3[3]) + 1 : 1;
    if (rows1 === rows3 && cols1 === cols3) continue;
    if (mode === 'truncate') {                                      // solo se usan las columnas/filas que tiene sum_range
      const e1r = +a1[5] + rows3 - 1, e1c = colIndex(a1[3]) + cols3 - 1;
      const f1 = (a1[1] || '') + a1[2] + a1[3] + a1[4] + a1[5] + ':' + a1[6] + colLetter(e1c) + a1[8] + e1r;
      const l1 = sp.args[0].text.match(/^\s*/)[0], t1 = sp.args[0].text.match(/\s*$/)[0];
      out = out.slice(0, sp.args[0].from) + l1 + f1 + t1 + out.slice(sp.args[0].to);
      continue;
    }
    const endRow = +a3[5] + rows1 - 1, endCol = colIndex(a3[3]) + cols1 - 1;
    const d2 = a3[9] ? a3[8] : a3[4], dc2 = a3[9] ? a3[6] : a3[2];  // $ del extremo
    const fixed = (a3[1] || '') + a3[2] + a3[3] + a3[4] + a3[5] + ':' + dc2 + colLetter(endCol) + d2 + endRow;
    const lead = sp.args[2].text.match(/^\s*/)[0], trail = sp.args[2].text.match(/\s*$/)[0];
    out = out.slice(0, sp.args[2].from) + lead + fixed + trail + out.slice(sp.args[2].to);
  }
  return out;
}

/* ---------- compatibilidad con Excel en español: VALUE("300,00") = 300 ----------
 * Excel (configuración regional de Ecuador) acepta la coma decimal en VALUE/VALOR; HyperFormula solo el punto.
 * El libro usa VALUE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(x,"$",""),",",""),".",",")) para convertir "$1,234.50" en número. */
export function parseNumberText(s) {
  let t = String(s).trim().replace(/\s+/g, '').replace(/^([-+]?)[$€£]/, '$1').replace(/^\(([^)]*)\)$/, '-$1');
  if (t === '') return null;
  let pct = false; if (t.endsWith('%')) { pct = true; t = t.slice(0, -1); }
  let n = null, m;
  if (/^[-+]?\d+,\d+$/.test(t)) n = parseFloat(t.replace(',', '.'));                                   // 300,00
  else if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) n = parseFloat(t.replace(/\./g, '').replace(',', '.'));   // 1.234,56
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) n = parseFloat(t.replace(/,/g, ''));            // 1,234.56
  else if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) n = parseFloat(t);                         // 1234.56
  else if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/.exec(t))) {                          // dd/mm/aaaa -> serie
    let y = +m[3]; if (y < 100) y += 2000;
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) n = Math.round((Date.UTC(y, +m[2] - 1, +m[1]) - Date.UTC(1899, 11, 30)) / 86400000);
  }
  if (n === null || Number.isNaN(n)) return null;
  return pct ? n / 100 : n;
}
let _compatDone = false;
export function installExcelCompat(HF) {
  if (_compatDone || !HF || !HF.FunctionPlugin) return;
  try {
    const { FunctionPlugin, FunctionArgumentType, CellError, ErrorType } = HF;
    class EsValuePlugin extends FunctionPlugin {
      value(ast, state) {
        return this.runFunction(ast.args, state, this.metadata('VALUE'), (arg) => {
          if (typeof arg === 'number') return arg;
          if (arg === null || arg === undefined || arg === '') return 0;
          if (typeof arg === 'string') { const n = parseNumberText(arg); return n === null ? new CellError(ErrorType.VALUE) : n; }
          return new CellError(ErrorType.VALUE);
        });
      }
    }
    EsValuePlugin.implementedFunctions = { VALUE: { method: 'value', parameters: [{ argumentType: FunctionArgumentType.SCALAR }] } };
    HF.unregisterFunction('VALUE');
    HF.registerFunctionPlugin(EsValuePlugin, { enGB: { VALUE: 'VALUE' } });
    _compatDone = true;
  } catch (e) { console.warn('[engine] no se pudo instalar VALUE compatible con Excel:', e); }
}

/* ---------- utilidades de direcciones ---------- */
export function colLetter(c) { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = ((c - 1 - m) / 26) | 0; } return s; }
export function colIndex(letters) { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
export function addrToA1(r, c) { return colLetter(c) + (r + 1); }
export function a1ToAddr(a1) { const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(a1.trim()); if (!m) return null; return { r: parseInt(m[2], 10) - 1, c: colIndex(m[1]) }; }

export class Sheet {
  constructor(meta, data, nStyles) {
    this.id = meta.id; this.name = meta.name; this.hidden = !!meta.hidden; this.tabColor = meta.tabColor || null;
    this.rows = data.rows; this.cols = data.cols;
    this.freeze = data.freeze || null; this.gridlines = data.gridlines !== false;
    this.colWidths = new Map(Object.entries(data.colWidths || {}).map(([k, v]) => [+k, v]));
    this.hiddenCols = new Set(data.hiddenCols || []); this.hiddenRows = new Set(data.hiddenRows || []);
    this.merges = (data.merges || []).map(m => { const [a, b] = m.split(':'); const A = a1ToAddr(a), B = b ? a1ToAddr(b) : A; return { r0: A.r, c0: A.c, r1: B.r, c1: B.c }; });
    this.notes = new Map((data.notes || []).map(([r, c, t]) => [K(r, c), t]));
    this.textCells = new Set();
    this.hfId = -1;
    this._data = data;
    this.lazy = false;          // hoja que nadie necesita para calcular otras: se carga al abrirla
    this.loaded = true;         // contenido ya cargado en el motor
    this.refs = new Set();      // hojas que esta hoja referencia en sus fórmulas
    this._buildStyleGrid(data.fmt || []);
  }
  _buildStyleGrid(fmt) {
    this.sRows = Math.max(this.rows, 1); this.sCols = Math.max(this.cols, 1);
    this.styleGrid = new Uint16Array(this.sRows * this.sCols);
    for (const [c, r0, r1, s] of fmt) for (let r = r0; r <= r1; r++) if (r < this.sRows && c < this.sCols) this.styleGrid[r * this.sCols + c] = s;
  }
  styleAt(r, c) { return (r < this.sRows && c < this.sCols) ? this.styleGrid[r * this.sCols + c] : 0; }
  setStyle(r, c, s) {
    if (r >= this.sRows || c >= this.sCols) {
      const nr = Math.max(this.sRows, r + 1), nc = Math.max(this.sCols, c + 1);
      const g = new Uint16Array(nr * nc);
      for (let i = 0; i < this.sRows; i++) g.set(this.styleGrid.subarray(i * this.sCols, (i + 1) * this.sCols), i * nc);
      this.styleGrid = g; this.sRows = nr; this.sCols = nc;
    }
    this.styleGrid[r * this.sCols + c] = s;
  }
  /** tramos de formato por columna (RLE) para guardar */
  fmtRuns() {
    const out = [];
    for (let c = 0; c < this.sCols; c++) {
      let start = -1, cur = 0;
      for (let r = 0; r <= this.sRows; r++) {
        const s = r < this.sRows ? this.styleGrid[r * this.sCols + c] : 0;
        if (s !== cur) {
          if (cur) out.push([c, start, r - 1, cur]);
          cur = s; start = r;
        }
      }
    }
    return out;
  }
  mergeAt(r, c) { for (const m of this.merges) if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return m; return null; }
}

export class Engine {
  /** @param {object} meta contenido de meta.json  @param {Object<string,object>} sheetDatas {sid: contenido de sNN.json} */
  /** @param {{keepCells?:boolean}} opts keepCells:true conserva los arreglos `cells` originales (solo para pruebas) */
  constructor(meta, sheetDatas, opts = {}) {
    const HF = globalThis.HyperFormula;
    if (!HF) throw new Error('HyperFormula no está cargado');
    installExcelCompat(HF);
    this.HF = HF;
    this.meta = meta;
    this.styles = meta.styles;
    this.sheets = [];
    this.byId = new Map(); this.byName = new Map();
    this.dirty = new Set();
    this.listeners = new Set();
    this.nameErrors = [];
    this._sumifFixed = [];
    this.cycleFallbacks = 0;
    this._keepCells = !!opts.keepCells;

    for (const sm of meta.sheets) {
      const sh = new Sheet(sm, sheetDatas[sm.id], meta.styles.length);
      this.sheets.push(sh); this.byId.set(sh.id, sh); this.byName.set(sh.name.toLowerCase(), sh);
    }
    this._computeLazy(opts);
    const arrays = {};
    for (const sh of this.sheets) arrays[sh.name] = sh.lazy ? [[]] : this._sheetArray(sh);
    this.hf = HF.buildFromSheets(arrays, HF_CONFIG);
    for (const sh of this.sheets) sh.hfId = this.hf.getSheetId(sh.name);
    for (const [name, txt] of Object.entries(meta.names || {})) {
      try { this.hf.addNamedExpression(name, '=' + txt); } catch (e) { this.nameErrors.push(name + ': ' + e.message); }
    }
    this._fixCycles();
    this.hf.clearUndoStack && this.hf.clearUndoStack();
    if (!this._keepCells) for (const sh of this.sheets) if (sh.loaded) sh._data.cells = null;   // el motor ya tiene el contenido: liberar memoria
  }

  /* ---- carga diferida de hojas "hoja final" (ninguna hoja cargada depende de ellas) ---- */
  _computeLazy(opts) {
    const RE = /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!/g;
    const find = (txt, self, set) => {
      RE.lastIndex = 0; let m;
      while ((m = RE.exec(txt))) { const t = this.byName.get((m[1] ? m[1].replace(/''/g, "'") : m[2]).toLowerCase()); if (t && t !== self) set.add(t); }
    };
    const inbound = new Map(this.sheets.map((s) => [s, new Set()]));
    for (const sh of this.sheets) {
      for (const cell of sh._data.cells || []) if (cell.length > 3 && cell[3] != null && cell[3].indexOf('!') >= 0) find(cell[3], sh, sh.refs);
      for (const t of sh.refs) inbound.get(t).add(sh);
    }
    if (opts.lazy === false) return;
    const roots = new Set();
    for (const txt of Object.values(this.meta.names || {})) { const s = new Set(); find(String(txt), null, s); s.forEach((x) => roots.add(x)); }
    const L = new Set(); let changed = true;
    while (changed) {
      changed = false;
      for (const sh of this.sheets) {
        if (L.has(sh) || roots.has(sh)) continue;
        let ok = true; for (const x of inbound.get(sh)) if (!L.has(x)) { ok = false; break; }
        if (ok) { L.add(sh); changed = true; }
      }
    }
    for (const sh of L) { sh.lazy = true; sh.loaded = false; }
  }
  /** Matriz de contenido para HyperFormula a partir del JSON de la hoja */
  _sheetArray(sh) {
    sh.loaded = true;
    const data = sh._data;
    const nr = Math.max(sh.rows, 1), nc = Math.max(sh.cols, 1);
    const arr = new Array(nr);
    for (let r = 0; r < nr; r++) arr[r] = new Array(nc).fill(null);
    for (const cell of data.cells || []) {
      const [r, c, v, f] = cell;
      if (cell.length > 3 && f != null) {
        const fx = fixFormulaForHF(f);
        arr[r][c] = '=' + fx;
        if (fx !== f) this._sumifFixed.push({ sh, r, c, f, done: false });
      } else if (typeof v === 'string' && looksParsable(v)) { arr[r][c] = wrapText(v); sh.textCells.add(K(r, c)); }
      else arr[r][c] = v;
    }
    return arr;
  }
  /** Carga (si hace falta) una hoja diferida y las hojas diferidas que ella referencia. */
  ensureLoaded(sidOrName) {
    const sh = this.sheet(sidOrName);
    if (!sh || sh.loaded) return sh;
    sh.loaded = true;                                     // evita recursión entre hojas diferidas que se referencian
    for (const d of sh.refs) if (d.lazy && !d.loaded) this.ensureLoaded(d.id);
    const arr = this._sheetArray(sh);
    this.hf.setSheetContent(sh.hfId, arr);
    if (this.hf.clearUndoStack) this.hf.clearUndoStack();
    this._fixCycles();
    if (!this._keepCells) sh._data.cells = null;
    return sh;
  }
  ensureAll() { let n = 0; for (const sh of this.sheets) if (!sh.loaded) { this.ensureLoaded(sh.id); n++; } return n; }
  /** Igual que ensureLoaded pero cede el hilo antes, para que la interfaz alcance a mostrar "Cargando…". */
  async loadSheetAsync(sidOrName) {
    const sh = this.sheet(sidOrName);
    if (sh && !sh.loaded) { await new Promise((r) => setTimeout(r, 30)); this.ensureLoaded(sh.id); }
    return sh;
  }
  async ensureAllAsync(onProgress) {
    const pend = this.sheets.filter((s) => !s.loaded);
    for (let i = 0; i < pend.length; i++) { if (onProgress) onProgress(i, pend.length, pend[i].name.trim()); await new Promise((r) => setTimeout(r, 15)); this.ensureLoaded(pend[i].id); }
    return pend.length;
  }
  _ld(sidOrName) { const sh = this.sheet(sidOrName); if (sh && !sh.loaded) this.ensureLoaded(sh.id); return sh; }
  _ensureRefsIn(formula) {
    if (typeof formula !== 'string' || formula.indexOf('!') < 0) return;
    const RE = /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!/g; let m;
    while ((m = RE.exec(formula))) { const t = this.byName.get((m[1] ? m[1].replace(/''/g, "'") : m[2]).toLowerCase()); if (t && !t.loaded) this.ensureLoaded(t.id); }
  }
  /** SUMIF ampliado que cierra un ciclo (Excel no lo ve porque rastrea el rango tal como se escribió):
   *  se reemplaza por la versión recortada al tamaño de sum_range. */
  _fixCycles() {
    const todo = this._sumifFixed.filter((e) => !e.done && e.sh.loaded);
    if (!todo.length) return;
    const bad = todo.filter((e) => { const v = this.hf.getCellValue({ sheet: e.sh.hfId, row: e.r, col: e.c }); return v && typeof v === 'object' && v.value === '#CYCLE!'; });
    if (bad.length) {
      this.hf.batch(() => { for (const e of bad) this.hf.setCellContents({ sheet: e.sh.hfId, row: e.r, col: e.c }, '=' + fixFormulaForHF(e.f, 'truncate')); });
      this.cycleFallbacks += bad.length;
    }
    for (const e of todo) e.done = true;
  }

  sheet(sidOrName) { return this.byId.get(sidOrName) || this.byName.get(String(sidOrName).toLowerCase()); }
  _addr(sh, r, c) { return { sheet: sh.hfId, row: r, col: c }; }

  /** valor calculado: number | string | boolean | null | {error:'#REF!'} */
  value(sid, r, c) {
    const sh = this._ld(sid);
    const v = this.hf.getCellValue(this._addr(sh, r, c));
    if (v && typeof v === 'object' && 'value' in v && 'type' in v) return { error: v.value };
    return v === undefined ? null : v;
  }
  /** contenido crudo editable: fórmula "=..." | número | texto | booleano | null */
  raw(sid, r, c) {
    const sh = this._ld(sid);
    const ser = this.hf.getCellSerialized(this._addr(sh, r, c));
    if (typeof ser === 'string') {
      if (sh.textCells.has(K(r, c))) { const u = unwrapText(ser); if (u != null) return u; }
      return ser;
    }
    return ser === undefined ? null : ser;
  }
  isFormula(sid, r, c) { const x = this.raw(sid, r, c); return typeof x === 'string' && x[0] === '=' && !this.sheet(sid).textCells.has(K(r, c)); }
  styleOf(sid, r, c) { const sh = this.sheet(sid); return this.styles[sh.styleAt(r, c)] || {}; }

  /** Escribe contenido crudo. Devuelve lista de {sid,r,c} (celdas cuyo valor cambió, incluidas dependientes). */
  set(sid, r, c, raw) { return this.setMatrix(sid, r, c, [[raw]]); }
  setMatrix(sid, r, c, matrix) {
    const sh = this._ld(sid);
    for (const row of matrix) for (const x of row) if (typeof x === 'string' && x[0] === '=') this._ensureRefsIn(x);
    const prepared = matrix.map((row, i) => row.map((x, j) => this._prep(sh, r + i, c + j, x)));
    const changes = this.hf.setCellContents({ sheet: sh.hfId, row: r, col: c }, prepared);
    this.dirty.add(sh.id);
    if (r + matrix.length > sh.rows) sh.rows = r + matrix.length;
    if (c + (matrix[0] || []).length > sh.cols) sh.cols = c + matrix[0].length;
    return this._changes(changes);
  }
  _prep(sh, r, c, x) {
    const key = K(r, c);
    if (typeof x === 'string' && x[0] !== '=' && looksParsable(x)) { sh.textCells.add(key); return wrapText(x); }
    if (typeof x === 'string' && x[0] === '=' && unwrapText(x) != null && sh.textCells.has(key)) return x;
    sh.textCells.delete(key);
    if (typeof x === 'string' && x[0] === '=') return fixFormulaForHF(x);
    return x === undefined ? null : x;
  }
  clear(sid, r0, c0, r1, c1) {
    const sh = this._ld(sid);
    const blank = []; for (let r = r0; r <= r1; r++) blank.push(new Array(c1 - c0 + 1).fill(null));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) sh.textCells.delete(K(r, c));
    const ch = this.hf.setCellContents({ sheet: sh.hfId, row: r0, col: c0 }, blank);
    this.dirty.add(sh.id);
    return this._changes(ch);
  }
  _changes(changes) {
    const out = [];
    for (const ch of changes || []) {
      if (ch.address) {
        const sh = this.sheets.find(s => s.hfId === ch.address.sheet);
        if (sh) out.push({ sid: sh.id, r: ch.address.row, c: ch.address.col });
      }
    }
    return out;
  }
  /** Copia un rango y lo pega ajustando referencias relativas (como Excel). */
  copyPaste(sid, r0, c0, r1, c1, dsid, dr, dc) {
    const a = this._ld(sid), b = this._ld(dsid);
    this.hf.copy({ start: { sheet: a.hfId, row: r0, col: c0 }, end: { sheet: a.hfId, row: r1, col: c1 } });
    const ch = this.hf.paste({ sheet: b.hfId, row: dr, col: dc });
    this.dirty.add(b.id);
    const nr = dr + (r1 - r0) + 1, nc = dc + (c1 - c0) + 1;
    if (nr > b.rows) b.rows = nr; if (nc > b.cols) b.cols = nc;
    // los estilos viajan con la copia
    for (let i = 0; i <= r1 - r0; i++) for (let j = 0; j <= c1 - c0; j++) b.setStyle(dr + i, dc + j, a.styleAt(r0 + i, c0 + j));
    return this._changes(ch);
  }
  undo() { if (!this.hf.isThereSomethingToUndo()) return null; return this._changes(this.hf.undo()); }
  redo() { if (!this.hf.isThereSomethingToRedo()) return null; return this._changes(this.hf.redo()); }
  /** Recalcula funciones volátiles (HOY()) */
  refreshVolatile() { this.hf.rebuildAndRecalculate(); }

  /** Id de un estilo = base + cambios (p. ej. {nf:'dd/mm/yyyy'}). Crea el estilo si no existe y marca metaDirty. */
  deriveStyle(baseId, patch) {
    if (!this._styleIndex) this._styleIndex = new Map(this.styles.map((s, i) => [JSON.stringify(s), i]));
    const st = Object.assign({}, this.styles[baseId] || {}, patch);
    for (const k of Object.keys(st)) if (st[k] === undefined || st[k] === null) delete st[k];
    const key = JSON.stringify(st);
    let id = this._styleIndex.get(key);
    if (id === undefined) { id = this.styles.length; this.styles.push(st); this._styleIndex.set(key, id); this.metaDirty = true; this.dirty.add('meta'); }   // 'meta' = hay que guardar también meta.json (tabla de estilos)
    return id;
  }

  /** Última fila con contenido NO fórmula (dato tecleado). -1 si no hay. */
  lastConstRow(sid, c0 = 0, c1 = null) {
    const sh = this._ld(sid);
    const ser = this.hf.getSheetSerialized(sh.hfId);
    for (let r = ser.length - 1; r >= 0; r--) {
      const row = ser[r]; const end = c1 == null ? row.length - 1 : Math.min(c1, row.length - 1);
      for (let c = c0; c <= end; c++) {
        const x = row[c];
        if (x === null || x === undefined || x === '') continue;
        if (typeof x === 'string' && x[0] === '=' && !sh.textCells.has(K(r, c))) continue;
        return r;
      }
    }
    return -1;
  }

  /** Búsqueda de texto (sin distinguir mayúsculas ni acentos) en valores calculados y fórmulas. */
  search(query, { sids = null, max = 300 } = {}) {
    const NONASCII = /[^\x00-\x7f]/;
    const COMBINING = new RegExp('[\\u0300-\\u036f]', 'g');
    const norm = (s) => (NONASCII.test(s) ? s.normalize('NFD').replace(COMBINING, '') : s).toLowerCase();
    const q = norm(query.trim());
    const out = [];
    if (!q) return out;
    const numericQuery = /^[\d.,\-$%\s]+$/.test(q);          // los números solo se miran si lo buscado parece un número
    for (const sh of this.sheets) {
      if (sids && !sids.includes(sh.id)) continue;
      this._ld(sh.id);
      const vals = this.hf.getSheetValues(sh.hfId);
      for (let r = 0; r < vals.length; r++) {
        const row = vals[r];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v === null || v === undefined || v === '') continue;
          let t;
          if (typeof v === 'string') t = v;
          else if (typeof v === 'number') { if (!numericQuery) continue; t = String(v); }
          else if (typeof v === 'object') t = v.value || '';
          else continue;
          if (norm(t).includes(q)) { out.push({ sid: sh.id, sheet: sh.name, r, c, text: t }); if (out.length >= max) return out; }
        }
      }
    }
    return out;
  }

  /** Última fila con algún contenido en [c0..c1] (o en toda la hoja) */
  lastRowWithContent(sid, c0 = 0, c1 = null) {
    const sh = this._ld(sid);
    const ser = this.hf.getSheetSerialized(sh.hfId);
    c1 = c1 == null ? (ser[0] ? ser[0].length - 1 : 0) : c1;
    for (let r = ser.length - 1; r >= 0; r--) for (let c = c0; c <= c1; c++) { const x = ser[r][c]; if (x !== null && x !== undefined && x !== '') return r; }
    return -1;
  }

  /** Objeto listo para guardar como sNN.json */
  exportSheet(sid) {
    const sh = this.sheet(sid);
    if (!sh.loaded) return sh._data;                      // hoja diferida sin abrir: nada cambió, se devuelve tal cual
    const ser = this.hf.getSheetSerialized(sh.hfId);
    const cells = [];
    let maxR = 0, maxC = 0;
    for (let r = 0; r < ser.length; r++) {
      const row = ser[r];
      for (let c = 0; c < row.length; c++) {
        let x = row[c];
        if (x === null || x === undefined) continue;
        if (typeof x === 'string' && x[0] === '=') {
          if (sh.textCells.has(K(r, c))) { const u = unwrapText(x); if (u != null) { cells.push([r, c, u]); maxR = Math.max(maxR, r + 1); maxC = Math.max(maxC, c + 1); continue; } }
          cells.push([r, c, null, x.slice(1)]);
        } else cells.push([r, c, x]);
        maxR = Math.max(maxR, r + 1); maxC = Math.max(maxC, c + 1);
      }
    }
    const d = sh._data;
    return {
      id: sh.id, name: sh.name, hidden: sh.hidden, rows: Math.max(sh.rows, maxR), cols: Math.max(sh.cols, maxC),
      freeze: sh.freeze, tabColor: sh.tabColor, gridlines: sh.gridlines,
      colWidths: Object.fromEntries(sh.colWidths), hiddenCols: [...sh.hiddenCols], hiddenRows: [...sh.hiddenRows],
      merges: d.merges || [], notes: [...sh.notes].map(([k, t]) => [Math.floor(k / 4096), k % 4096, t]),
      cells, fmt: sh.fmtRuns(),
    };
  }
}

/* ---------- carga de datos (fetch) ---------- */
export async function loadBundle(baseUrl = 'data/') {
  const meta = await (await fetch(baseUrl + 'meta.json')).json();
  const entries = await Promise.all(meta.sheets.map(async s => [s.id, await (await fetch(baseUrl + s.file)).json()]));
  return { meta, sheetDatas: Object.fromEntries(entries) };
}
