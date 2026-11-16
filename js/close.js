/* close.js — cierre de mes COMPLETO de CONSOL (hoja s01). Sin DOM: solo lee y escribe con el motor.
 *
 * Qué hace «cerrar el mes» (lo que la persona hacía a mano en su Excel):
 *   Meses 1..11 (flujo A B C D E G)                       Diciembre (flujo A C D F E: cierra el mes Y ABRE el año nuevo)
 *   A  fija como VALORES la columna viva del mes          A  igual
 *   B  abre la columna viva del mes siguiente             C  «Mes anterior» ← valores actuales; L21 = día 1 del mes nuevo
 *   C  «Mes anterior» del patrimonio ← valores actuales   D  «Mes anterior» de la tabla de bancos ← «Mes actual»
 *   D  «Mes anterior» de la tabla de bancos               F  archiva el año como valores, reinicia el bloque vivo,
 *   E  fila de resumen del mes nuevo + punteros                 comparativo anual y resumen del año nuevo
 *   G  extiende el resumen por año / «var periodo»        E  fila de resumen de enero + punteros
 *
 * Contrato (todo en una sola tanda SÍNCRONA, sin dejar la hoja a medias):
 *   planClose(engine, {today})            -> plan SIN escribir nada: bloqueos (precondiciones), avisos, fases y celdas
 *   applyClose(engine, plan, opts)        -> escribe; verifica las poscondiciones; si algo falla RESTAURA TODO
 *   undoClose(engine, undo, opts)         -> devuelve exactamente lo que escribió applyClose (contenido y formato)
 *   findBlocks / findSummaries            -> descubren los bloques anuales y los resúmenes por año por su estructura
 *
 * MAPA DE CONSOL QUE USA (A1; el motor usa base 0). Solo se conoce la POSICIÓN de cada bloque, nunca datos de la persona.
 *   L21 / M21 / O21         mes en curso / mes anterior / diciembre base (fechas tecleadas, día 1 de cada mes)
 *   K22:P27                 patrimonio: L actual · M mes anterior · N variación · O diciembre base · P acumulado
 *                           L22 Bancos · L23 gastos provisionados · L24 inversiones · L25 total · L26 inversiones out
 *   J2:O10                  tabla de bancos: M4:M7 «Mes actual» · N4:N7 «Mes anterior» (tecleado) · M9/N9 totales · M10 control (= 0)
 *   B29 / C53               presupuesto del mes y su copia de control (C53 = B29)
 *   S21:W26                 comparativo anual (columnas S, T, U = tres diciembres; V y W variaciones)
 *   Q28:AD36                bloque VIVO del año: R = diciembre previo (base) · S..AD = ene..dic
 *                           fila 28 fechas · 29:31 Bancos, gastos, inversiones · 32 total · 35 acumulado del año · 36 variación del mes
 *                           (la columna del mes en curso son fórmulas =+L22/=+L23/=+L24; las anteriores, valores)
 *   Q:AD debajo de la fila 36   archivo de años cerrados: bloques de 7 filas (fechas, 3 partes, total, «var periodo», cambio) + 1 de margen
 *   AD:AT                   resumen por año: bloques de 4 filas (año, inicio, fin mes, MES) + 1 de margen; AF..AQ = ene..dic; AR/AS/AT = cambio del año
 *   A55:G…                  lista de ingresos: A concepto · B mes (día 1) · C importe; en la primera fila de cada mes: D egreso · E mes · F ingresos · G I-E
 *   L57 · L58 · K52         punteros al resumen del mes en curso (mes, egreso, egreso − gasto presupuestado J52)
 *   RESERVADAS              AD37 (la lee D55) y H26 (la lee J24): nunca se escriben y no se usan como espacio libre
 *
 * Todas las lecturas del plan se hacen sobre el estado PREVIO (nada se lee a mitad de la escritura): «fijar» y «copiar»
 * escriben números/textos (nunca fórmulas). El motor redondea los resultados a 11 cifras significativas.
 */
import { a1ToAddr, colLetter, colIndex } from './engine.js';
import { isDateFormat, todaySerial } from './format.js';

export const SID = 's01';
/** Clave del almacén «kv» de IndexedDB donde la pantalla guarda el deshacer del último cierre (las claves con «_» no entran en respaldos). */
export const CLOSE_KEY = '_close:ultimo';
export const EPS = 0.005;

export const BASE_COL = 'R';
export const MONTH_COLS = ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD'];
export const SUMMARY_COLS = ['AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ'];
export const LIVE = { dateRow: 28, partRows: [29, 30, 31], totalRow: 32, accRow: 35, mesRow: 36, labelCol: 'Q' };
const LIST = { firstRow: 55, sumifLast: 980 };
const ARCH = { rows: 7, margin: 1, from: 'Q', to: 'AD' };
const SUMB = { rows: 4, margin: 1, from: 'AD', to: 'AT' };
const RESERVED = new Set(['AD37', 'H26']);
const SCAN_LIMIT = 1000;                                                     // filas máximas que se recorren buscando bloques o espacio libre

/* ================================================================== utilidades */
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isErr = (x) => !!(x && typeof x === 'object' && x.error);
const blank = (x) => x === null || x === undefined || x === '';
const isFormulaRaw = (x) => typeof x === 'string' && x[0] === '=';
const near = (a, b, t = EPS) => isNum(a) && isNum(b) && Math.abs(a - b) <= t;
const plural = (n, one, many) => (n === 1 ? one : many);

const SER0 = Date.UTC(1899, 11, 30);
const serial = (y, m, d = 1) => Math.round((Date.UTC(y, m - 1, d) - SER0) / 86400000);
const ymd = (s) => { const d = new Date(SER0 + Math.floor(s) * 86400000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const shortLabel = (s) => { const d = ymd(s); return MONTHS[d.m - 1] + '-' + String(d.y).slice(2); };
const longLabel = (y, m) => MONTHS_LONG[m - 1] + ' ' + y;
const DATE_MIN = 36526, DATE_MAX = 73415;                                     // 2000-01-01 .. 2100-01-01
const isDateSerial = (x) => isNum(x) && x >= DATE_MIN && x <= DATE_MAX;

const money = (n) => (isNum(n) ? (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
const fmtNum = (n) => (n < 0 && Math.abs(n) >= 0.005 ? '−' : '') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

/** Contenido «crudo» comparable: las fórmulas se comparan sin espacios; null, undefined y '' son lo mismo. */
const normRaw = (x) => (x === undefined || x === '' ? null : isFormulaRaw(x) ? x.replace(/\s+/g, '') : x);
const sameRaw = (a, b) => normRaw(a) === normRaw(b);

function cellsOf(rng) {
  const [a, b] = rng.split(':');
  const p = a1ToAddr(a), q = b ? a1ToAddr(b) : p;
  if (!p || !q) throw new Error('Rango inválido: ' + rng);
  const out = [];
  for (let r = p.r; r <= q.r; r++) for (let c = p.c; c <= q.c; c++) out.push(colLetter(c) + (r + 1));
  return out;
}
const rowOf = (a1) => a1ToAddr(a1).r + 1;
const colOf = (a1) => colLetter(a1ToAddr(a1).c);
/** «AC29» o «AC29:AD31»: etiqueta de las celdas de un conjunto ordenado. */
const spanLabel = (list) => (list.length === 1 ? list[0] : list[0] + ':' + list[list.length - 1]);
const addrKey = (a1) => { const p = a1ToAddr(a1); return p.r * 4096 + p.c; };
const byAddr = (x, y) => addrKey(x) - addrKey(y);

/** Error de planificación: algo impide escribir y se explica en español. Nunca sale de planClose. */
class PlanError extends Error {
  constructor(message, id = 'OP') { super(message); this.pid = id; }
}

/* ================================================================== contexto de lectura de CONSOL */
function makeCtx(engine) {
  let sh = null;
  try { sh = engine && typeof engine.sheet === 'function' ? engine.sheet(SID) : null; } catch (e) { sh = null; }
  const memo = new Map();
  const P = (a1) => { let p = memo.get(a1); if (!p) { p = a1ToAddr(a1); if (!p) throw new Error('Dirección inválida: ' + a1); memo.set(a1, p); } return p; };
  return {
    engine, sh, P,
    val(a1) { const p = P(a1); try { const v = engine.value(SID, p.r, p.c); return v === undefined ? null : v; } catch (e) { return null; } },
    raw(a1) { const p = P(a1); try { const x = engine.raw(SID, p.r, p.c); return x === undefined ? null : x; } catch (e) { return null; } },
    sty(a1) { const p = P(a1); try { return sh.styleAt(p.r, p.c) | 0; } catch (e) { return 0; } },
    num(a1) { const v = this.val(a1); return isNum(v) ? v : null; },
    txt(a1) { const v = this.val(a1); return typeof v === 'string' ? v.trim() : ''; },
    free(a1) { return blank(this.raw(a1)) && !RESERVED.has(a1) && !this.referenced(a1); },
    /** ¿Alguna fórmula lee esta celda vacía por su dirección? (p. ej. AD37 la lee D55): entonces no es espacio libre. */
    referenced(a1) {
      const hf = engine.hf;
      if (!hf || typeof hf.getCellDependents !== 'function') return false;
      try {
        const p = P(a1);
        return hf.getCellDependents({ sheet: sh.hfId, row: p.r, col: p.c }).some((d) => d && d.sheet !== undefined);   // las referencias por rango (SUM(A:B)) no cuentan
      } catch (e) { return false; }
    },
    rectFree(rng) { return cellsOf(rng).every((a) => this.free(a)); },
  };
}

/** Todas las celdas con contenido de CONSOL: {A1: raw}. */
function snapshotRaw(C) {
  const o = {}, sh = C.sh;
  for (let r = 0; r < sh.rows; r++) for (let c = 0; c < sh.cols; c++) {
    let x = null; try { x = C.engine.raw(SID, r, c); } catch (e) { x = null; }
    if (x !== null && x !== undefined) o[colLetter(c) + (r + 1)] = x;
  }
  return o;
}
function snapshotValues(C) {
  const o = {}, sh = C.sh;
  for (let r = 0; r < sh.rows; r++) for (let c = 0; c < sh.cols; c++) {
    let v = null; try { v = C.engine.value(SID, r, c); } catch (e) { v = null; }
    if (v !== null && v !== undefined && !isErr(v)) o[colLetter(c) + (r + 1)] = v;
  }
  return o;
}
function errorCells(C) {
  const out = [], sh = C.sh;
  for (let r = 0; r < sh.rows; r++) for (let c = 0; c < sh.cols; c++) {
    let v = null; try { v = C.engine.value(SID, r, c); } catch (e) { v = null; }
    if (isErr(v)) out.push(colLetter(c) + (r + 1) + ' ' + v.error);
  }
  return out;
}
function diffRaw(a, b) {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]), out = [];
  for (const k of ks) if (!sameRaw(a[k], b[k])) out.push(k);
  return out.sort(byAddr);
}
/** Huella de contenido (hash de 53 bits) de una hoja: sirve para comprobar que las demás hojas no cambiaron. */
function hashText(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 0x9e3779b1); h2 = Math.imul(h2 ^ ch, 0x5f356495); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0x85ebca6b) ^ Math.imul(h1 ^ (h1 >>> 13), 0xc2b2ae35);
  return (0x100000000 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + s.length;
}
function otherSheetsFingerprint(engine) {
  const out = {};
  for (const sh of engine.sheets || []) {
    if (sh.id === SID || !sh.loaded) continue;
    try { out[sh.id] = hashText(JSON.stringify(engine.hf.getSheetSerialized(sh.hfId))); } catch (e) { out[sh.id] = 'sin-huella'; }
  }
  return out;
}

/* ================================================================== bloques anuales y resúmenes (descubiertos por su estructura) */
/**
 * Bloques anuales de patrimonio mensual: una fila de fechas (S..AD = ene..dic, día 1, enero en S) con 3 filas de partes debajo
 * y la fila de totales. Devuelve [{year, dateRow, partRows:[a,b,c], totalRow, live}] con filas en A1 (base 1).
 * El bloque «vivo» es el de la fila 28; los demás son años archivados.
 */
export function findBlocks(engine, { sid = SID } = {}) {
  const out = [];
  let sh = null; try { sh = engine && typeof engine.sheet === 'function' ? engine.sheet(sid) : null; } catch (e) { sh = null; }
  if (!sh) return out;
  const val = (r, c) => { try { return engine.value(sid, r, c); } catch (e) { return null; } };
  const c0 = colIndex(MONTH_COLS[0]);
  const maxRow = Math.min(Math.max(sh.rows, 1), SCAN_LIMIT);
  for (let r = 0; r + 4 < maxRow; r++) {
    let any = false;
    for (let k = 0; k < 3; k++) if (isNum(val(r, c0 + k))) { any = true; break; }          // filtro rápido: casi todas las filas se descartan aquí
    if (!any) continue;
    let n = 0, idx0 = null, ok = 0;
    for (let k = 0; k < 12; k++) {
      const v = val(r, c0 + k);
      if (!isDateSerial(v)) continue;
      const d = ymd(v); if (d.d !== 1) continue;
      const mi = d.y * 12 + d.m - 1;
      n++; if (idx0 === null) idx0 = mi - k;
      if (mi - k === idx0) ok++;
    }
    if (n >= 10 && ok === n && idx0 % 12 === 0) {
      out.push({ year: idx0 / 12, dateRow: r + 1, partRows: [r + 2, r + 3, r + 4], totalRow: r + 5, live: r + 1 === LIVE.dateRow });
      r += 4;
    }
  }
  return out;
}

/** Resúmenes por año (AD:AT): [{year, label, ri, rf, rm}] = fila del rótulo del año y filas «inicio», «fin mes» y «MES» (A1, base 1). */
export function findSummaries(engine, { sid = SID } = {}) {
  const out = [];
  let sh = null; try { sh = engine && typeof engine.sheet === 'function' ? engine.sheet(sid) : null; } catch (e) { sh = null; }
  if (!sh) return out;
  const val = (r, c) => { try { return engine.value(sid, r, c); } catch (e) { return null; } };
  const cAD = colIndex('AD'), cAE = colIndex('AE');
  const maxRow = Math.min(Math.max(sh.rows, 1), SCAN_LIMIT);
  for (let r = 0; r < maxRow; r++) {
    const t = val(r, cAE);
    if (typeof t !== 'string' || t.trim().toLowerCase() !== 'inicio') continue;
    for (const rr of [r, r - 1]) {
      if (rr < 0) continue;
      const v = val(rr, cAD);
      if (isNum(v) && v >= 2000 && v <= 2100) { out.push({ year: v, label: rr + 1, ri: r + 1, rf: r + 2, rm: r + 3 }); break; }
    }
  }
  return out;
}

/* ================================================================== variables del cierre */
function makeVars(C) {
  const L21 = C.val('L21');
  if (!isDateSerial(L21)) return null;
  const d = ymd(L21);
  const V = { L21, Y: d.y, m: d.m, Y1: d.y + 1, isDec: d.m === 12, dayOne: d.d === 1 };
  V.col = MONTH_COLS[d.m - 1];
  V.prev = d.m === 1 ? BASE_COL : MONTH_COLS[d.m - 2];
  V.next = d.m <= 11 ? MONTH_COLS[d.m] : '';
  V.newL21 = d.m === 12 ? serial(d.y + 1, 1, 1) : serial(d.y, d.m + 1, 1);
  V.newCol = d.m === 12 ? MONTH_COLS[0] : MONTH_COLS[d.m];
  V.decY = serial(d.y, 12, 1);
  V.monthLabel = longLabel(d.y, d.m);
  V.nextLabel = d.m === 12 ? longLabel(d.y + 1, 1) : longLabel(d.y, d.m + 1);
  V.key = d.y + '-' + String(d.m).padStart(2, '0');
  V.nextKey = d.m === 12 ? (d.y + 1) + '-01' : d.y + '-' + String(d.m + 1).padStart(2, '0');
  return V;
}

/** Meses 1..11: resumen por año del año en curso, fila «var periodo» del año archivado anterior. */
function groupVars(C, V) {
  const sums = findSummaries(C.engine), sy = sums.find((x) => x.year === V.Y), sp = sums.find((x) => x.year === V.Y - 1);
  V.hasSummary = !!sy;
  if (sy) { V.ysi = sy.ri; V.ysf = sy.rf; V.ysm = sy.rm; V.sc = SUMMARY_COLS[V.m - 1]; V.scn = SUMMARY_COLS[V.m]; }
  V.hasPrevSummary = !!sp; if (sp) V.psi = sp.ri;
  V.isNov = V.m === 11;
  V.hasVarRow = false;
  const pb = findBlocks(C.engine).find((b) => !b.live && b.year === V.Y - 1);
  if (pb && V.m <= 10) {
    const q = C.val('Q' + (pb.totalRow + 1));
    if (typeof q === 'string' && q.trim().toLowerCase() === 'var periodo') { V.hasVarRow = true; V.pvr = pb.totalRow + 1; V.pT = pb.totalRow; }
  }
  return V;
}

/** Diciembre: dónde se archiva el año (primer rectángulo libre debajo de los archivados) y dónde va el resumen del año nuevo. */
function openingVars(C, V) {
  const blocks = findBlocks(C.engine), hist = blocks.filter((b) => !b.live);
  V.blocks = blocks;
  V.reject11 = [];
  V.reject12 = [];
  const already = hist.find((b) => b.year === V.Y);
  if (already) V.reject11.push({ code: 'exists', row: already.dateRow });
  const prevHist = hist.filter((b) => b.year < V.Y).sort((a, b) => b.year - a.year)[0];
  V.prevT = prevHist ? prevHist.totalRow : null;
  V.prevBlock = prevHist || null;
  let lastUsed = LIVE.mesRow;
  for (const b of hist) lastUsed = Math.max(lastUsed, b.totalRow + 2);
  V.d = null;
  for (let r = lastUsed + 1 + ARCH.margin; r < SCAN_LIMIT; r++) {
    if (C.rectFree(`${ARCH.from}${r - ARCH.margin}:${ARCH.to}${r + ARCH.rows - 1}`)) { V.d = r; break; }
  }
  if (V.d === null) { if (!already) V.reject11.push({ code: 'room' }); } else { V.d1 = V.d + 1; V.d2 = V.d + 2; V.d3 = V.d + 3; V.T = V.d + 4; V.Vr = V.d + 5; V.CH = V.d + 6; }
  // formatos del archivo: se copian del bloque archivado más reciente (fechas, partes, total, cambio) y de la fila «var periodo» más cercana
  V.styleSrc = null;
  if (prevHist) {
    const hasVar = (b) => { const q = C.val('Q' + (b.totalRow + 1)); return typeof q === 'string' && q.trim().toLowerCase() === 'var periodo'; };
    const hasChange = (b) => !blank(C.raw('AD' + (b.totalRow + 2)));
    const histDesc = hist.slice().sort((a, b) => b.year - a.year);
    const withVar = histDesc.find(hasVar), withChange = histDesc.find(hasChange);
    V.styleSrc = { dateRow: prevHist.dateRow, parts: prevHist.partRows, total: prevHist.totalRow, varRow: withVar ? withVar.totalRow + 1 : null, changeRow: withChange ? withChange.totalRow + 2 : null };
  }
  const sums = findSummaries(C.engine), mine = sums.find((s) => s.year === V.Y);
  if (!mine) V.reject12.push({ code: 'nosummary' });
  else { V.sp = mine.label; V.spi = mine.ri; V.spf = mine.rf; V.spm = mine.rm; }
  let lastSum = 0; for (const s of sums) lastSum = Math.max(lastSum, s.rm);
  V.s = null;
  for (let r = lastSum + 1 + SUMB.margin; r < SCAN_LIMIT; r++) {
    if (C.rectFree(`${SUMB.from}${r - SUMB.margin}:${SUMB.to}${r + SUMB.rows - 1}`)) { V.s = r; break; }
  }
  if (V.s === null) V.reject12.push({ code: 'room' }); else { V.si = V.s + 1; V.sf = V.s + 2; V.sm = V.s + 3; }
  return V;
}

/* ================================================================== lista de ingresos: fila de resumen del mes nuevo */
function summaryRowFor(C, s) {
  for (let r = LIST.firstRow; r <= C.sh.rows; r++) { const e = C.val('E' + r); if (isNum(e) && e === s) return r; }
  return null;
}
function lastRowABC(C) {
  let last = 0;
  for (let r = LIST.firstRow; r <= C.sh.rows; r++) if (!blank(C.raw('A' + r)) || !blank(C.raw('B' + r)) || !blank(C.raw('C' + r))) last = r;
  return last;
}
/** Dónde va (o ya está) la fila de resumen D:G del mes nuevo y qué hay que escribir. */
function planSummaryRow(C, serialMonth, colLetterLive) {
  const ex = summaryRowFor(C, serialMonth);
  if (ex) return { row: ex, existing: true, writes: [] };
  let rb = null;
  for (let r = LIST.firstRow; r <= C.sh.rows; r++) { const b = C.val('B' + r); if (isNum(b) && b === serialMonth) { rb = r; break; } }
  let r = rb !== null ? rb : lastRowABC(C) + 1;
  while (['D', 'E', 'F', 'G'].some((c) => !blank(C.raw(c + r)))) r++;
  const first = rb !== null ? rb : r, L = LIST.sumifLast;
  const writes = [
    { a1: 'E' + r, raw: serialMonth, asDate: true },
    { a1: 'F' + r, raw: `=SUMIF(B$${first}:B$${L},E${r},C$${first}:C$${L})` },
    { a1: 'D' + r, raw: `=+${colLetterLive}$${LIVE.mesRow}-F${r}` },
    { a1: 'G' + r, raw: `=+D${r}+F${r}` },
  ];
  let prev = null;                                                               // los formatos se copian de la fila de resumen anterior
  for (let q = r - 1; q >= LIST.firstRow; q--) { const e = C.val('E' + q); if (isNum(e) && isFormulaRaw(C.raw('F' + q))) { prev = q; break; } }
  if (prev) for (const c of ['D', 'E', 'F', 'G']) writes.push({ a1: c + r, style: C.sty(c + prev), from: c + prev });
  return { row: r, existing: false, first, writes };
}

/* ================================================================== textos para la persona (precondiciones y avisos) */
const WHAT = { L22: 'Bancos', L23: 'los gastos provisionados', L24: 'las inversiones', L25: 'el total del patrimonio', L26: 'las inversiones out', M4: 'la tabla de bancos («Mes actual»)', M5: 'la tabla de bancos («Mes actual»)', M6: 'la tabla de bancos («Mes actual»)', M7: 'la provisión («Mes actual»)', M9: 'el total de la tabla de bancos' };

const dayMonthText = (s) => { const d = ymd(s); return d.d + ' de ' + MONTHS_LONG[d.m - 1]; };

/* ================================================================== precondiciones (null = cumple; texto = motivo) */
const pureConst = (x) => typeof x === 'number' || (typeof x === 'string' && x[0] === '=' && !/[A-Za-z_$]+\$?\d+/.test(x.slice(1)));
const livePattern = (row) => new RegExp('^=\\+?L' + row + '$');
const ymIndex = (s) => { const d = ymd(s); return d.y * 12 + d.m - 1; };

const PRE = [
  { id: 'PRE03', run: (C, V) => {
    const h = C.val(V.col + '28');
    if (!isDateSerial(h)) return `En el patrimonio mensual de CONSOL falta la fecha de ${V.monthLabel} (celda ${V.col}28). Escríbela (día 1 del mes) y vuelve a intentarlo.`;
    if (ymIndex(h) !== ymIndex(V.L21)) return `El patrimonio mensual de CONSOL tiene ${shortLabel(h)} en la columna del mes en curso (${V.col}28), pero el mes en curso es ${shortLabel(V.L21)}. Revisa que las fechas de la hoja estén bien antes de cerrar.`;
    for (const [row, re] of [[29, livePattern(22)], [30, livePattern(23)], [31, livePattern(24)]]) {
      const x = C.raw(V.col + row);
      if (!(typeof x === 'string' && re.test(x.replace(/\s/g, '')))) return `La columna de ${V.monthLabel} del patrimonio mensual (${V.col}) ya no tiene sus fórmulas vivas: parece que ese mes ya se cerró a mano o se cambió. Para no duplicar el cierre, no se continúa. Revisa las celdas ${V.col}29 a ${V.col}31 de CONSOL.`;
    }
    return null;
  } },
  { id: 'PRE04', run: (C, V) => {
    if (V.isDec) return null;
    const h = C.raw(V.next + '28');
    if (!blank(h) && !(isDateSerial(C.val(V.next + '28')) && ymIndex(C.val(V.next + '28')) === ymIndex(V.newL21))) return `La fecha de la columna siguiente del patrimonio mensual (${V.next}28) no es ${V.nextLabel}. Revisa las fechas de la hoja antes de cerrar.`;
    for (const a of [...cellsOf(`${V.next}29:${V.next}31`), ...cellsOf(`${V.next}35:${V.next}36`)]) {
      if (!blank(C.raw(a))) return `La columna de ${V.nextLabel} del patrimonio mensual ya tiene datos (celda ${a}). Para no pisarlos, no se cierra. Si es un error, bórralos y vuelve a intentarlo.`;
    }
    return null;
  } },
  { id: 'PRE05', run: (C, V) => {
    const pl = V.m === 1 ? 'el diciembre base' : longLabel(V.Y, V.m - 1);
    const cells = cellsOf(`${V.prev}29:${V.prev}31`);
    for (const a of cells) {
      const x = C.raw(a);
      if (!blank(x) && !pureConst(x)) return `El mes anterior (${pl}) todavía no está cerrado: sus cifras del patrimonio mensual (celda ${a}) siguen siendo fórmulas. Cierra los meses en orden, uno por uno.`;
    }
    if (cells.every((a) => blank(C.raw(a)))) return `El mes anterior (${pl}) no tiene cifras en el patrimonio mensual (${cells[0]} a ${cells[2]} están vacías). Cierra los meses en orden, uno por uno.`;
    return null;
  } },
  { id: 'PRE06', run: (C) => {
    const m10 = C.val('M10');
    if (!isNum(m10)) return 'No se puede comprobar el control de la tabla de bancos (celda M10): no tiene un número. Revisa la hoja CONSOL.';
    if (Math.abs(m10) > EPS) return `La tabla de bancos no cuadra con el flujo del mes: la diferencia es ${money(m10)} y debe ser cero (control M10). Revisa la hoja CONSOL antes de cerrar.`;
    if (!near(C.val('C53'), C.val('B29'))) return 'El presupuesto del mes no cuadra: el total de la tarjeta (celda C53) no es igual al presupuesto (B29). Revisa la hoja CONSOL antes de cerrar.';
    return null;
  } },
  { id: 'PRE07', run: (C) => {
    for (const a of ['L22', 'L23', 'L24', 'L25', 'L26', 'M4', 'M5', 'M6', 'M7', 'M9']) {
      if (!isNum(C.val(a))) return `Falta una cifra para poder cerrar: ${WHAT[a]} (celda ${a}) no es un número. Revisa la hoja CONSOL.`;
    }
    return null;
  } },
  { id: 'PRE08', run: (C) => {
    const e = errorCells(C);
    if (!e.length) return null;
    return `Hay ${e.length} ${plural(e.length, 'celda', 'celdas')} con error en CONSOL (por ejemplo ${e.slice(0, 3).map((x) => x.split(' ')[0]).join(', ')}). Corrígelas antes de cerrar, para no guardar cifras dañadas.`;
  } },
  { id: 'PRE09', run: (C) => (near(C.val('M25'), C.val('L25')) && [4, 5, 6, 7].every((n) => near(C.val('N' + n), C.val('M' + n)))
    ? 'Este mes ya está cerrado: no hay cambios desde el último cierre («Mes anterior» ya es igual a «Mes actual»). Si ya cerraste este mes, no hace falta repetirlo.' : null) },
  { id: 'PRE10', run: (C, V) => (V.sum && V.sum.row > LIST.sumifLast ? `La lista de ingresos de CONSOL ya llegó a su límite (fila ${LIST.sumifLast}), así que no hay dónde preparar el mes siguiente.` : null) },
  { id: 'PRE11', dec: true, run: (C, V) => {
    const x = V.reject11[0];
    if (!x) return null;
    if (x.code === 'exists') return `El año ${V.Y} ya está archivado en CONSOL (fila ${x.row}). Para no duplicarlo, no se cierra. Revisa la hoja.`;
    return `No hay espacio libre en CONSOL (columnas ${ARCH.from} a ${ARCH.to}) para archivar el año ${V.Y}: hacen falta ${ARCH.rows + ARCH.margin} filas libres seguidas debajo de los años anteriores. Libera ese espacio y vuelve a intentarlo.`;
  } },
  { id: 'PRE12', dec: true, run: (C, V) => {
    const x = V.reject12[0];
    if (!x) return null;
    if (x.code === 'nosummary') return `No encuentro en CONSOL el resumen por año de ${V.Y} (filas «inicio», «fin mes» y «MES», columnas ${SUMB.from} a ${SUMB.to}). Sin él no se puede abrir el año nuevo.`;
    return `No hay espacio libre en CONSOL (columnas ${SUMB.from} a ${SUMB.to}) para el resumen por año de ${V.Y1}: hacen falta ${SUMB.rows + SUMB.margin} filas libres seguidas. Libera ese espacio y vuelve a intentarlo.`;
  } },
  { id: 'PRE13', dec: true, run: (C) => {
    for (const a of [...cellsOf('S22:S24'), ...cellsOf('T22:T24')]) {
      if (!pureConst(C.raw(a))) return `Para pasar el comparativo anual (S21:W26) al año nuevo, las columnas S y T deben tener cifras fijas, y la celda ${a} lee otras celdas. Cámbiala por un número fijo y vuelve a intentarlo.`;
    }
    return null;
  } },
  { id: 'PRE14', dec: true, run: (C) => (blank(C.raw('AD37')) ? null : 'La celda AD37 de CONSOL debe seguir vacía porque otra celda la lee (D55). Vacíala y vuelve a intentarlo.') },
];

/** Avisos: {id, text, confirm}. confirm=true exige que la persona lo acepte expresamente. */
const AVI = [
  { id: 'AVI01', confirm: true, run: (C, V, X) => {
    const last = serial(V.Y, V.m + 1, 0);
    return isNum(X.today) && X.today < last ? `Hoy es ${dayMonthText(X.today)}: el mes aún no termina. Si cierras ahora, se fijará el patrimonio de hoy como el de ${V.monthLabel}.` : null;
  } },
  { id: 'AVI02', confirm: true, run: (C, V, X) => {
    if (!isNum(X.today)) return null;
    const dm = ymIndex(X.today) - ymIndex(V.L21);
    if (dm >= 2) return `Hoy es ${longLabel(ymd(X.today).y, ymd(X.today).m)}, pero la hoja sigue en ${V.monthLabel}: puede que falten cierres. Cierra los meses en orden, uno por uno.`;
    if (dm < 0) return `La hoja está en ${V.monthLabel}, que es posterior a hoy (${longLabel(ymd(X.today).y, ymd(X.today).m)}). Revisa que la fecha del mes en curso sea correcta.`;
    return null;
  } },
  { id: 'AVI03', run: (C, V) => {
    const m21 = C.val('M21'), exp = V.m === 1 ? serial(V.Y - 1, 12, 1) : serial(V.Y, V.m - 1, 1);
    return isNum(m21) && m21 !== exp ? `En CONSOL, la fecha de «Mes anterior» (${shortLabel(m21)}) no es la del mes anterior a ${V.monthLabel}. Al cerrar se corregirá.` : null;
  } },
  { id: 'AVI04', run: (C, V) => {
    if (!V.isDec) return null;
    const a = C.val('S24'), b = C.val('R31');
    return isNum(a) && isNum(b) && !near(a, b) ? `En el comparativo anual de CONSOL, las inversiones del diciembre anterior (${money(a)}) no coinciden con las del diciembre base (${money(b)}). Se moverán tal cual al nuevo comparativo; conviene revisarlas.` : null;
  } },
  { id: 'AVI05', run: (C, V) => (!V.dayOne ? `La fecha del mes en curso (L21) no es día 1: se ajustará al día 1 de ${V.nextLabel}.` : null) },
  { id: 'AVI06', run: (C, V) => {
    if (!V.sum || V.sum.existing) return null;
    const hf = C.engine.hf;
    if (!hf || typeof hf.getCellDependents !== 'function') return null;
    const names = new Set();
    try {
      for (let r = V.sum.row; r < V.sum.row + 8; r++) {
        for (const d of hf.getCellDependents({ sheet: C.sh.hfId, row: r - 1, col: 1 })) {
          const sid = d && (d.sheet !== undefined ? d.sheet : d.start && d.start.sheet);
          if (sid !== undefined && sid !== C.sh.hfId) { const s = (C.engine.sheets || []).find((x) => x.hfId === sid); if (s) names.add(String(s.name).trim()); }
        }
      }
    } catch (e) { return null; }
    if (!names.size) return null;
    return `Los ingresos de ${V.nextLabel} se anotarán desde la fila ${V.sum.row} de la lista de CONSOL. ${names.size === 1 ? 'La hoja' : 'Las hojas'} «${[...names].join('», «')}» ${names.size === 1 ? 'lee' : 'leen'} la columna de fechas de esas filas, así que sus cifras pueden cambiar cuando anotes los ingresos.`;
  } },
];

/* ================================================================== fases y operaciones */
const PHASE_TITLE = {
  A: (V) => `Fijar los valores de ${V.monthLabel}`,
  B: (V) => `Abrir ${V.nextLabel} en el patrimonio mensual`,
  C: (V) => `«Mes anterior» pasa a ser ${V.monthLabel}`,
  D: () => '«Mes anterior» de la tabla de bancos',
  E: (V) => `Lista de ingresos de ${V.nextLabel}`,
  F: (V) => `Cerrar ${V.Y} y abrir ${V.Y1}`,
  G: (V) => `Resumen por año de ${V.Y}`,
};
export const FLOWS = { m1_11: ['A', 'B', 'C', 'D', 'E', 'G'], m12: ['A', 'C', 'D', 'F', 'E'] };

/** Constructor de operaciones: cada operación produce escrituras {a1, raw} (contenido) o {a1, style, from} (formato). */
function makeBuilder(C, V) {
  const ops = [], warnings = [], meta = { listRows: [], varCells: [] };
  const pvCache = new Map();
  const B = {
    ops, warnings, meta, V,
    pv(a1) { if (!pvCache.has(a1)) pvCache.set(a1, C.val(a1)); return pvCache.get(a1); },
    num(a1) { const v = B.pv(a1); if (!isNum(v)) throw new PlanError(`No se puede fijar el valor de ${a1}: no es un número.`); return v; },
    copy(a1) { const v = B.pv(a1); if (isErr(v)) throw new PlanError(`No se puede copiar ${a1}: tiene un error (${v.error}).`); return v === undefined ? null : v; },
    op(id, kind, note, writes, phase) {
      ops.push({ id, phase, kind, note, writes: writes.filter(Boolean) });
    },
    warn(id, text, confirm = false) { warnings.push({ id, text, confirm }); },
  };
  return B;
}

/** Copia de formatos de un rango origen a otro de igual tamaño (se omite si no coinciden). */
function styleCopy(C, fromRng, toRng) {
  const s = cellsOf(fromRng), t = cellsOf(toRng);
  if (s.length !== t.length) return [];
  return t.map((a, i) => ({ a1: a, style: C.sty(s[i]), from: s[i] }));
}

const PHASES = {
  A: (C, V, B) => {
    [['A1', 29, 'Bancos'], ['A2', 30, 'los gastos provisionados'], ['A3', 31, 'las inversiones']].forEach(([id, row, what]) => {
      const a1 = V.col + row;
      B.op(id, 'congelar', `Fija ${what} de ${V.monthLabel}: la fórmula pasa a ser un número`, [{ a1, raw: B.num(a1) }], 'A');
    });
  },
  B: (C, V, B) => {
    const n = V.next, p = V.col;
    B.op('B1', 'fecha', `Cabecera de ${V.nextLabel} en el patrimonio mensual`, [{ a1: n + '28', raw: V.newL21, asDate: true }], 'B');
    B.op('B2', 'formula', `${V.nextLabel}: Bancos sigue a la hoja`, [{ a1: n + '29', raw: '=+L22' }], 'B');
    B.op('B3', 'formula', `${V.nextLabel}: gastos provisionados siguen a la hoja`, [{ a1: n + '30', raw: '=+L23' }], 'B');
    B.op('B4', 'formula', `${V.nextLabel}: inversiones siguen a la hoja`, [{ a1: n + '31', raw: '=+L24' }], 'B');
    B.op('B5', 'formula', `${V.nextLabel}: acumulado del año contra el diciembre base`, [{ a1: n + '35', raw: `=+${n}32-$O$25` }], 'B');
    B.op('B6', 'formula', `${V.nextLabel}: variación contra ${V.monthLabel}`, [{ a1: n + '36', raw: `=+${n}32-${p}32` }], 'B');
    B.op('B7', 'copiar_estilo', 'Formato del acumulado (igual al de la columna anterior)', [{ a1: n + '35', style: C.sty(p + '35'), from: p + '35' }], 'B');
    B.op('B8', 'copiar_estilo', 'Formato de la variación del mes (igual al de la columna anterior)', [{ a1: n + '36', style: C.sty(p + '36'), from: p + '36' }], 'B');
  },
  C: (C, V, B) => {
    B.op('C1', 'copiar_valor', `«Mes anterior» de Bancos: valor actual`, [{ a1: 'M22', raw: B.copy('L22') }], 'C');
    B.op('C2', 'copiar_valor', `«Mes anterior» de gastos: valor actual`, [{ a1: 'M23', raw: B.copy('L23') }], 'C');
    B.op('C3', 'copiar_valor', `«Mes anterior» de inversiones: valor actual`, [{ a1: 'M24', raw: B.copy('L24') }], 'C');
    B.op('C4', 'copiar_valor', `«Mes anterior» de inversiones out: valor actual`, [{ a1: 'M26', raw: B.copy('L26') }], 'C');
    B.op('C5', 'copiar_valor', `Fecha del «Mes anterior» = ${V.monthLabel}`, [{ a1: 'M21', raw: B.copy('L21'), asDate: true }], 'C');
    B.op('C6', 'fecha', `Mes en curso = ${V.nextLabel} (día 1)`, [{ a1: 'L21', raw: V.newL21, asDate: true }], 'C');
  },
  D: (C, V, B) => {
    [['D1', 4], ['D2', 5], ['D3', 6], ['D4', 7]].forEach(([id, row]) => {
      B.op(id, 'copiar_valor', `«Mes anterior» de la fila ${row} de la tabla de bancos = su «Mes actual» exacto`, [{ a1: 'N' + row, raw: B.copy('M' + row) }], 'D');
    });
  },
  E: (C, V, B) => {
    const r = V.sum.row;
    B.op('E1', 'asegurar_fila_resumen', V.sum.existing ? `La fila de resumen de ${V.nextLabel} ya existe (fila ${r})` : `Crea la fila de resumen de ${V.nextLabel} en la lista de ingresos (fila ${r})`, V.sum.writes, 'E');
    B.op('E2', 'formula', 'Puntero al mes de la fila de resumen', [{ a1: 'L57', raw: `=+E${r}` }], 'E');
    B.op('E3', 'formula', 'Puntero al egreso del mes', [{ a1: 'L58', raw: `=+D${r}` }], 'E');
    B.op('E4', 'formula', 'Puntero al egreso del mes menos el gasto presupuestado', [{ a1: 'K52', raw: `=+D${r}-J52` }], 'E');
  },
  F: (C, V, B) => {
    const { d, d1, d3, T, Vr, CH, s, si, sf, sm } = V, Y1 = V.Y1;
    const copyVals = (rngFrom, rngTo) => { const a = cellsOf(rngFrom), b = cellsOf(rngTo); return b.map((x, i) => ({ a1: x, raw: B.copy(a[i]) })); };
    const note = {
      F01: `Archivo de ${V.Y}: fechas`, F02: `Archivo de ${V.Y}: rótulos de las partes`, F03: `Archivo de ${V.Y}: las tres partes de los 13 meses, como valores`,
      F04: `Archivo de ${V.Y}: totales como suma de las partes`,
    };
    B.op('F01', 'copiar_rango_valores', note.F01, copyVals('R28:AD28', `R${d}:AD${d}`), 'F');
    B.op('F02', 'copiar_rango_valores', note.F02, copyVals('Q29:Q31', `Q${d1}:Q${d3}`), 'F');
    B.op('F03', 'copiar_rango_valores', note.F03, copyVals('R29:AD31', `R${d1}:AD${d3}`), 'F');
    B.op('F04', 'rellenar_formula', note.F04, cellsOf(`R${T}:AD${T}`).map((a) => { const c = colOf(a); return { a1: a, raw: `=SUM(${c}${d1}:${c}${d3})` }; }), 'F');
    B.op('F05', 'texto', 'Rótulo de la fila de comparación', [{ a1: 'Q' + Vr, raw: 'var periodo' }], 'F');
    B.op('F06', 'rellenar_formula', `Comparación: ${V.Y1} contra ${V.Y} (diciembre base y enero)`, ['R', 'S'].map((c) => ({ a1: c + Vr, raw: `=+${c}32-${c}${T}` })), 'F');
    B.op('F07', 'formula', `Cambio de ${V.Y}: diciembre menos diciembre previo`, [{ a1: 'AD' + Vr, raw: `=+AD${T}-R${T}` }], 'F');
    if (V.prevT) B.op('F08', 'formula', `Cambio de ${V.Y} contra el cierre del año anterior`, [{ a1: 'AD' + CH, raw: `=+AD${T}-AD${V.prevT}` }], 'F');
    const ss = V.styleSrc;
    if (ss) {
      B.op('F09', 'copiar_estilo', 'Formato de la fila de fechas del archivo', styleCopy(C, `Q${ss.dateRow}:AD${ss.dateRow}`, `Q${d}:AD${d}`), 'F');
      B.op('F10', 'copiar_estilo', 'Formato de las tres partes del archivo', styleCopy(C, `Q${ss.parts[0]}:AD${ss.parts[2]}`, `Q${d1}:AD${d3}`), 'F');
      B.op('F11', 'copiar_estilo', 'Formato de la fila de totales del archivo', styleCopy(C, `Q${ss.total}:AD${ss.total}`, `Q${T}:AD${T}`), 'F');
      if (ss.varRow) B.op('F12', 'copiar_estilo', 'Formato de la fila de comparación', styleCopy(C, `Q${ss.varRow}:AD${ss.varRow}`, `Q${Vr}:AD${Vr}`), 'F');
      if (ss.changeRow) B.op('F13', 'copiar_estilo', 'Formato de la celda del cambio del año', styleCopy(C, `Q${ss.changeRow}:AD${ss.changeRow}`, `Q${CH}:AD${CH}`), 'F');
    }
    B.op('F14', 'rellenar_formula', `Resumen por año de ${V.Y}: «fin mes» ahora lee el archivo, no el bloque vivo`, SUMMARY_COLS.map((c, i) => ({ a1: c + V.spf, raw: `=+${MONTH_COLS[i]}${T}` })), 'F');
    // F15: la columna D de las filas de resumen de la lista del año que se cierra lee el archivo (mismo número)
    const f15 = [];
    for (let r = LIST.firstRow; r <= Math.max(C.sh.rows, V.sum.row); r++) {
      const D = C.raw('D' + r), e = C.val('E' + r);
      if (!isNum(e) || typeof D !== 'string') continue;
      const m = new RegExp('^=\\+?([A-Z]{1,2})\\$?' + LIVE.mesRow + '-F' + r + '$').exec(D.replace(/\s/g, ''));
      if (!m) continue;
      const dd = ymd(e); if (dd.y !== V.Y) continue;
      const c = MONTH_COLS[dd.m - 1], p = dd.m === 1 ? BASE_COL : MONTH_COLS[dd.m - 2];
      if (m[1] !== c) { B.warn('F15', `En la lista de ingresos, la fila ${r} (${shortLabel(e)}) lee otra columna del patrimonio mensual y no se cambia.`); continue; }
      f15.push({ a1: 'D' + r, raw: `=+${c}$${T}-${p}$${T}-F${r}` }); B.meta.listRows.push(r);
    }
    B.op('F15', 'reapuntar_D_lista', `Lista de ingresos de ${V.Y}: el egreso de cada mes ahora lee el archivo (mismo número)`, f15, 'F');
    // F16: las filas «var periodo» que leen el bloque vivo quedan como valores
    const f16 = [];
    for (let r = 1; r <= Math.min(C.sh.rows, SCAN_LIMIT); r++) {
      const q = C.val('Q' + r); if (typeof q !== 'string' || q.trim().toLowerCase() !== 'var periodo') continue;
      for (const c of [BASE_COL, ...MONTH_COLS.slice(0, 11)]) {
        const a = c + r, x = C.raw(a);
        if (typeof x === 'string' && new RegExp('(^|[^A-Z$])\\$?' + c + '\\$?' + LIVE.totalRow + '([^0-9]|$)').test(x.slice(1))) {
          const v = B.pv(a); if (!isNum(v)) throw new PlanError(`No se puede fijar la comparación ${a}: no es un número.`);
          f16.push({ a1: a, raw: v }); B.meta.varCells.push(a);
        }
      }
    }
    B.op('F16', 'congelar_filas_var', 'Las comparaciones «var periodo» que leían el año vivo pasan a valores', f16, 'F');
    // reinicio del bloque vivo
    B.op('F17', 'fechas_bloque', `Fechas del bloque vivo: diciembre ${V.Y} y enero a diciembre de ${Y1}`, [{ a1: 'R28', raw: V.decY, asDate: true }, ...MONTH_COLS.map((c, i) => ({ a1: c + '28', raw: serial(Y1, i + 1, 1), asDate: true }))], 'F');
    [['F18', 29], ['F19', 30], ['F20', 31]].forEach(([id, row]) => B.op(id, 'copiar_valor', `Base (diciembre) del bloque vivo: ${['Bancos', 'gastos', 'inversiones'][row - 29]} = cierre de diciembre`, [{ a1: 'R' + row, raw: B.copy('AD' + row) }], 'F'));
    B.op('F21', 'limpiar', `Vacía los 12 meses de las partes del bloque vivo`, cellsOf('S29:AD31').map((a) => ({ a1: a, raw: null })), 'F');
    B.op('F22', 'limpiar', 'Vacía el acumulado y la variación del año que termina', cellsOf('S35:AD36').map((a) => ({ a1: a, raw: null })), 'F');
    B.op('F23', 'formula', `Enero de ${Y1}: Bancos sigue a la hoja`, [{ a1: 'S29', raw: '=+L22' }], 'F');
    B.op('F24', 'formula', `Enero de ${Y1}: gastos siguen a la hoja`, [{ a1: 'S30', raw: '=+L23' }], 'F');
    B.op('F25', 'formula', `Enero de ${Y1}: inversiones siguen a la hoja`, [{ a1: 'S31', raw: '=+L24' }], 'F');
    B.op('F26', 'formula', `Enero de ${Y1}: acumulado contra el diciembre base`, [{ a1: 'S35', raw: '=+S32-$O$25' }], 'F');
    B.op('F27', 'formula', `Enero de ${Y1}: variación del mes = acumulado`, [{ a1: 'S36', raw: '=+S35' }], 'F');
    B.op('F28', 'texto', `Rótulo del acumulado de ${Y1}`, [{ a1: 'Q35', raw: 'acumulado ' + Y1 }], 'F');
    B.op('F29', 'fecha', 'Diciembre base de la tabla de patrimonio', [{ a1: 'O21', raw: V.decY, asDate: true }], 'F');
    B.op('F30', 'copiar_rango_valores', 'Diciembre base: bancos, gastos e inversiones = cierre de diciembre', copyVals('AD29:AD31', 'O22:O24'), 'F');
    B.op('F31', 'copiar_rango_crudo', 'Comparativo anual: la columna T pasa a la U', cellsOf('U21:U24').map((a, i) => ({ a1: a, raw: C.raw(cellsOf('T21:T24')[i]) })), 'F');
    B.op('F32', 'copiar_rango_crudo', 'Comparativo anual: la columna S pasa a la T', cellsOf('T21:T24').map((a, i) => ({ a1: a, raw: C.raw(cellsOf('S21:S24')[i]) })), 'F');
    B.op('F33', 'fecha', 'Comparativo anual: nueva columna = diciembre que se cierra', [{ a1: 'S21', raw: V.decY, asDate: true }], 'F');
    B.op('F34', 'copiar_rango_valores', 'Comparativo anual: cifras del diciembre que se cierra', copyVals('AD29:AD31', 'S22:S24'), 'F');
    B.op('F35', 'numero', `Resumen por año: rótulo ${Y1}`, [{ a1: 'AD' + s, raw: Y1 }], 'F');
    B.op('F36', 'texto', 'Resumen por año: rótulo «inicio»', [{ a1: 'AE' + si, raw: 'inicio' }], 'F');
    B.op('F37', 'texto', 'Resumen por año: rótulo «fin mes»', [{ a1: 'AE' + sf, raw: 'fin mes' }], 'F');
    B.op('F38', 'texto', 'Resumen por año: rótulo «MES»', [{ a1: 'AE' + sm, raw: 'MES' }], 'F');
    B.op('F39', 'formula', `Resumen por año de ${Y1}: inicio de enero = fin de diciembre de ${V.Y}`, [{ a1: 'AF' + si, raw: `=+AQ${V.spf}` }], 'F');
    B.op('F41', 'formula', `Resumen por año de ${Y1}: fin de enero = total de enero`, [{ a1: 'AF' + sf, raw: '=+S32' }], 'F');
    B.op('F42', 'formula', `Resumen por año de ${Y1}: MES de enero = fin − inicio`, [{ a1: 'AF' + sm, raw: `=+AF${sf}-AF${si}` }], 'F');
    if (V.sp && cellsOf(`AD${V.sp}:AT${V.spm}`).length === cellsOf(`AD${s}:AT${sm}`).length) B.op('F48', 'copiar_estilo', `Formatos del resumen por año de ${Y1} = los de ${V.Y}`, styleCopy(C, `AD${V.sp}:AT${V.spm}`, `AD${s}:AT${sm}`), 'F');
  },
  G: (C, V, B) => {
    const emptyOnly = (ws) => ws.filter((w) => blank(C.raw(w.a1)));
    if (V.hasSummary) {
      const { scn, sc, ysi, ysf, ysm, next } = V;
      B.op('G1', 'formula', `Resumen por año: inicio de ${V.nextLabel} = fin de ${V.monthLabel}`, emptyOnly([{ a1: scn + ysi, raw: `=+${sc}${ysf}` }]), 'G');
      B.op('G2', 'formula', `Resumen por año: fin de ${V.nextLabel} = total de la columna viva`, emptyOnly([{ a1: scn + ysf, raw: `=+${next}32` }]), 'G');
      B.op('G3', 'formula', `Resumen por año: MES de ${V.nextLabel} = fin − inicio`, emptyOnly([{ a1: scn + ysm, raw: `=+${scn}${ysf}-${scn}${ysi}` }]), 'G');
      if (V.isNov) {
        B.op('G4', 'formula', `Resumen por año: cambio del año = fin de diciembre − inicio de enero`, emptyOnly([{ a1: 'AR' + ysf, raw: `=+AQ${ysf}-AF${ysi}` }]), 'G');
        B.op('G5', 'formula', 'Resumen por año: suma de los 12 meses', emptyOnly([{ a1: 'AR' + ysm, raw: `=SUM(AF${ysm}:AQ${ysm})` }]), 'G');
        if (V.hasPrevSummary) {
          B.op('G6', 'formula', 'Resumen por año: ahorro de 24 meses', emptyOnly([{ a1: 'AS' + ysm, raw: `=+AQ${ysf}-AF${V.psi}` }]), 'G');
          B.op('G7', 'formula', 'Resumen por año: promedio mensual de esos 24 meses', emptyOnly([{ a1: 'AT' + ysm, raw: `=+AS${ysm}/24` }]), 'G');
          B.op('G8', 'texto', 'Resumen por año: rótulo «MENSUAL»', emptyOnly([{ a1: 'AT' + ysf, raw: 'MENSUAL' }]), 'G');
        }
      }
    }
    if (V.hasVarRow) B.op('G9', 'formula', `Comparación «var periodo» de ${V.nextLabel} contra el mismo mes de ${V.Y - 1}`, emptyOnly([{ a1: V.next + V.pvr, raw: `=+${V.next}32-${V.next}${V.pT}` }]), 'G');
  },
};

/** Ids de las comprobaciones que hace el cierre: precondiciones (rechazan), avisos y poscondiciones (si fallan, se restaura todo). */
export const CHECK_IDS = {
  pre: ['PRE01', 'PRE02', ...PRE.map((x) => x.id)].sort(),
  avi: AVI.map((x) => x.id),
  pos: ['POS01', 'POS02', 'POS03', 'POS04', 'POS05', 'POS06', 'POS07', 'POS08', 'POS09', 'POS10', 'POS11', 'POS12', 'POS13', 'POS14', 'POG01', 'POG02',
    'POF01', 'POF02', 'POF03', 'POF04', 'POF05', 'POF06', 'POF07', 'POF08', 'POF09', 'POF10', 'POF11', 'POF12'],
};

/** Ids de operación en el orden de cada flujo (para pruebas y para cruzar con la especificación). */
export const OP_IDS = {
  A: ['A1', 'A2', 'A3'], B: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'], C: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'], D: ['D1', 'D2', 'D3', 'D4'], E: ['E1', 'E2', 'E3', 'E4'],
  F: ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24', 'F25', 'F26', 'F27', 'F28', 'F29', 'F30', 'F31', 'F32', 'F33', 'F34', 'F35', 'F36', 'F37', 'F38', 'F39', 'F41', 'F42', 'F48'],
  G: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'],
};

/* ================================================================== presentación de celdas (antes → después) */
function dispValue(C, a1, raw, asDate) {
  if (raw === null || raw === undefined || raw === '') return '(vacío)';
  if (typeof raw === 'number') {
    let date = !!asDate;
    if (!date && isDateSerial(raw) && Number.isInteger(raw)) { const p = C.P(a1); try { date = isDateFormat((C.engine.styleOf(SID, p.r, p.c) || {}).nf); } catch (e) { date = false; } }
    return date && isDateSerial(raw) ? shortLabel(raw) : fmtNum(raw);
  }
  if (typeof raw === 'boolean') return raw ? 'VERDADERO' : 'FALSO';
  return isFormulaRaw(raw) ? raw : '«' + raw + '»';
}
const kindLabel = (raw) => (raw === null || raw === undefined ? 'vaciar' : isFormulaRaw(raw) ? 'fórmula' : typeof raw === 'number' ? 'valor' : 'texto');

const CONTROL_CELLS = ['L21', 'M21', 'O21', 'L22', 'L23', 'L24', 'L25', 'L26', 'M22', 'M23', 'M24', 'M25', 'M26', 'M4', 'M5', 'M6', 'M7', 'M9', 'N4', 'N5', 'N6', 'N7', 'N9', 'N25', 'M10', 'C53', 'B29', 'H17', 'P25'];
function readControls(C) {
  const o = {};
  for (const a of CONTROL_CELLS) { const v = C.val(a); o[a] = isNum(v) ? v : null; }
  return o;
}

/* ================================================================== planClose */
function emptyPlan(today) {
  return { ok: false, blocked: [], warnings: [], month: null, next: null, yearEnd: false, figures: null, phases: [], cells: [], writes: [], counts: { cells: 0, formulas: 0, values: 0, texts: 0, cleared: 0, formats: 0, ops: 0 }, controls: { antes: {} }, vars: {}, today, signature: '', flow: [], meta: {} };
}

/**
 * Prepara el cierre del mes de L21 SIN escribir nada.
 * @param {object} engine  motor de cálculo
 * @param {{today?:number}} opts  today = número de serie de hoy (por omisión el del reloj)
 * @returns {{ok:boolean, blocked:{id,text}[], warnings:{id,text,confirm}[], month:object, next:object, yearEnd:boolean,
 *            phases:{id,title,ops:{id,addr,kind,before,after,note,n,cells}[]}[], cells:object[], writes:object[], counts:object,
 *            controls:{antes:object}, vars:object, today:number, signature:string}}
 */
export function planClose(engine, opts = {}) {
  const today = isNum(opts.today) ? opts.today : todaySerial();
  const plan = emptyPlan(today);
  try {
    const C = makeCtx(engine);
    if (!C.sh) { plan.blocked.push({ id: 'PRE01', text: 'No encuentro la hoja CONSOL en este libro, y sin ella no se puede cerrar el mes.' }); return plan; }
    const V = makeVars(C);
    if (!V) { plan.blocked.push({ id: 'PRE02', text: 'No sé qué mes se está cerrando: la fecha del «mes en curso» de CONSOL (celda L21) no es una fecha válida. Corrígela en la hoja (debe ser el día 1 del mes) y vuelve a intentarlo.' }); return plan; }
    plan.month = { year: V.Y, m: V.m, label: V.monthLabel, key: V.key, serial: V.L21 };
    plan.next = { year: V.isDec ? V.Y1 : V.Y, m: V.isDec ? 1 : V.m + 1, label: V.nextLabel, key: V.nextKey, serial: V.newL21 };
    plan.yearEnd = V.isDec;
    plan.flow = V.isDec ? FLOWS.m12 : FLOWS.m1_11;
    plan.controls.antes = readControls(C);
    if (V.isDec) openingVars(C, V); else groupVars(C, V);
    V.sum = planSummaryRow(C, V.newL21, V.newCol);

    // ---- precondiciones y avisos
    const X = { today };
    for (const pc of PRE) {
      if (pc.dec && !V.isDec) continue;
      let msg = null;
      try { msg = pc.run(C, V, X); } catch (e) { msg = 'No se pudo comprobar esta condición (' + ((e && e.message) || e) + ').'; }
      if (msg) plan.blocked.push({ id: pc.id, text: msg });
    }
    for (const av of AVI) {
      let msg = null;
      try { msg = av.run(C, V, X); } catch (e) { msg = null; }
      if (msg) plan.warnings.push({ id: av.id, text: msg, confirm: !!av.confirm });
    }
    plan.vars = publicVars(V);
    Object.defineProperty(plan, '_V', { value: V, enumerable: false, writable: true });
    if (plan.blocked.length) return plan;

    // ---- operaciones, en el orden del flujo
    const B = makeBuilder(C, V);
    try {
      for (const ph of plan.flow) PHASES[ph](C, V, B);
    } catch (e) {
      if (e instanceof PlanError) { plan.blocked.push({ id: e.pid, text: e.message }); return plan; }
      throw e;
    }
    for (const w of B.warnings) plan.warnings.push({ id: w.id, text: w.text, confirm: !!w.confirm });
    plan.meta = B.meta;
    plan.figures = { labels: ['K22', 'K23', 'K24'].map((a, i) => C.txt(a) || ['Bancos', 'gastos', 'inversiones'][i]), parts: ['L22', 'L23', 'L24'].map((a) => C.num(a)), total: C.num('L25') };
    buildNet(C, V, plan, B.ops);
    plan.ok = true;
    return plan;
  } catch (e) {
    plan.ok = false;
    plan.blocked.push({ id: 'ERR', text: 'No se pudo preparar el cierre (' + ((e && e.message) || e) + '). No se escribió nada en la hoja.' });
    return plan;
  }
}

const publicVars = (V) => { const o = {}; for (const [k, v] of Object.entries(V)) if (!['blocks', 'prevBlock', 'styleSrc', 'reject11', 'reject12', 'sum'].includes(k)) o[k] = v; if (V.sum) { o.rowNext = V.sum.row; o.rowNextExisting = !!V.sum.existing; } if (V.styleSrc) o.styleSrc = V.styleSrc; return o; };

/** Del conjunto de operaciones al efecto NETO por celda (primer «antes» → último «después»), y a las estructuras públicas del plan. */
function buildNet(C, V, plan, ops) {
  const running = new Map(), net = new Map();
  const cur = (a1) => { let s = running.get(a1); if (!s) { s = { raw: C.raw(a1), style: C.sty(a1) }; running.set(a1, s); } return s; };
  const phases = new Map();
  for (const ph of plan.flow) phases.set(ph, { id: ph, title: PHASE_TITLE[ph](V), ops: [] });
  for (const op of ops) {
    const cells = [];
    for (const w of op.writes) {
      const s = cur(w.a1);
      let n = net.get(w.a1);
      if (!n) { n = { a1: w.a1, raw0: C.raw(w.a1), st0: C.sty(w.a1), raw1: undefined, st1: undefined, op: op.id, phase: op.phase, asDate: false, from: null }; net.set(w.a1, n); }
      if ('raw' in w) {
        const before = s.raw, after = w.raw;
        cells.push({ a1: w.a1, kind: 'content', before: dispValue(C, w.a1, before, w.asDate), after: dispValue(C, w.a1, after, w.asDate), beforeRaw: before, afterRaw: after, changed: !sameRaw(before, after) });
        s.raw = after; n.raw1 = after; n.op = op.id; n.phase = op.phase; if (w.asDate) n.asDate = true;
      }
      if ('style' in w) {
        const before = s.style, after = w.style;
        cells.push({ a1: w.a1, kind: 'style', before, after, changed: before !== after, from: w.from || null });
        s.style = after; n.st1 = after; n.from = w.from || null;
      }
    }
    const changed = cells.filter((c) => c.changed), contentChanged = changed.filter((c) => c.kind === 'content');
    const single = contentChanged.length === 1 ? contentChanged[0] : null;
    const addrs = (contentChanged.length ? contentChanged : changed).map((c) => c.a1).sort(byAddr);
    phases.get(op.phase).ops.push({
      id: op.id, addr: addrs.length ? spanLabel(addrs) : (op.writes[0] ? spanLabel(op.writes.map((w) => w.a1).sort(byAddr)) : ''), kind: op.kind, note: op.note,
      before: single ? single.before : contentChanged.length ? contentChanged.length + ' celdas' : '', after: single ? single.after : contentChanged.length ? 'nuevo contenido' : (changed.length ? changed.length + ' formatos' : 'sin cambios'),
      n: changed.length, cells,
    });
  }
  plan.phases = [...phases.values()].filter((p) => p.ops.length);
  // efecto neto
  const writes = [], cellsOut = [];
  for (const n of net.values()) {
    const contentChanged = n.raw1 !== undefined && !sameRaw(n.raw0, n.raw1);
    const styleChanged = n.st1 !== undefined && n.st1 !== n.st0;
    if (!contentChanged && !styleChanged) continue;
    const w = { a1: n.a1, op: n.op, phase: n.phase };
    if (contentChanged) { w.raw = n.raw1 === undefined ? null : n.raw1; w.raw0 = n.raw0 === undefined ? null : n.raw0; }
    if (styleChanged) { w.style = n.st1; w.style0 = n.st0; }
    writes.push(w);
    if (contentChanged) cellsOut.push({ a1: n.a1, op: n.op, phase: n.phase, kind: kindLabel(w.raw), before: dispValue(C, n.a1, w.raw0, n.asDate), after: dispValue(C, n.a1, w.raw, n.asDate), beforeRaw: w.raw0, afterRaw: w.raw });
  }
  writes.sort((x, y) => byAddr(x.a1, y.a1));
  const order = plan.flow;
  cellsOut.sort((x, y) => order.indexOf(x.phase) - order.indexOf(y.phase) || byAddr(x.a1, y.a1));
  plan.writes = writes; plan.cells = cellsOut;
  plan.counts = {
    cells: cellsOut.length, ops: ops.length,
    formulas: cellsOut.filter((c) => isFormulaRaw(c.afterRaw)).length,
    values: cellsOut.filter((c) => typeof c.afterRaw === 'number').length,
    texts: cellsOut.filter((c) => typeof c.afterRaw === 'string' && !isFormulaRaw(c.afterRaw)).length,
    cleared: cellsOut.filter((c) => c.afterRaw === null).length,
    formats: writes.filter((w) => 'style' in w).length,
  };
  plan.signature = JSON.stringify(writes.map((w) => [w.a1, 'raw' in w ? w.raw : '~', 'style' in w ? w.style : '~']));
}

/* ================================================================== poscondiciones (null = cumple; texto = motivo) */
const fx = (x) => (typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : x);

/** Fábrica de comprobaciones; K trae el estado previo (valores, errores, huellas) y los datos del plan. */
function makeChecks(C, V, plan, pre) {
  const K = {
    pv: (a1) => (a1 in pre.values ? pre.values[a1] : null),
    closedTotal: () => (V.isDec ? C.val('AD' + V.T) : C.val(V.col + '32')),
    closedPart: (k) => (V.isDec ? C.val('AD' + (V.d1 + k)) : C.val(V.col + (29 + k))),
  };
  const known = new Set(plan.writes.map((w) => w.a1));
  const sumsNow = () => findSummaries(C.engine);
  const checks = [];
  const add = (id, text, fn, dec = false) => checks.push({ id, text, fn, dec });

  add('POS01', 'El total del mes cerrado coincide con el patrimonio que mostraba la hoja', () => (near(K.closedTotal(), K.pv('L25')) ? null : `total cerrado ${fx(K.closedTotal())} ≠ patrimonio previo ${fx(K.pv('L25'))}`));
  add('POS02', 'Las variaciones del patrimonio quedaron en cero', () => (near(C.val('M25'), K.closedTotal()) && isNum(C.val('N25')) && Math.abs(C.val('N25')) <= EPS ? null : `M25=${fx(C.val('M25'))}, N25=${fx(C.val('N25'))}`));
  add('POS03', 'El total de «Mes anterior» de la tabla de bancos coincide con lo cerrado', () => {
    const sum = [4, 5, 6, 7, 8].reduce((t, n) => t + (C.num('N' + n) || 0), 0);
    return near(C.val('N9'), K.closedPart(0) + K.closedPart(1)) && near(C.val('N9'), sum) ? null : `N9=${fx(C.val('N9'))} ≠ Bancos+gastos cerrados ${fx(K.closedPart(0) + K.closedPart(1))} o ≠ SUM(N4:N8)=${fx(sum)}`;
  });
  add('POS04', 'Los controles de la hoja (tabla de bancos y presupuesto) cuadran', () => (isNum(C.val('M10')) && Math.abs(C.val('M10')) <= EPS && near(C.val('C53'), C.val('B29')) ? null : `M10=${C.val('M10')}, C53=${C.val('C53')}, B29=${C.val('B29')}`));
  add('POS05', 'El cambio del año de cada resumen por año coincide con la suma de sus meses', () => {
    for (const s of sumsNow()) { if (blank(C.raw('AR' + s.rf)) && blank(C.raw('AR' + s.rm))) continue; const a = C.val('AR' + s.rf), b = C.val('AR' + s.rm); if (!near(a, b)) return `AR${s.rf}=${fx(a)} ≠ AR${s.rm}=${fx(b)} (resumen ${s.year})`; }
    return null;
  });
  add('POS06', 'La columna viva del mes nuevo vale lo mismo que el patrimonio y su variación empieza en cero', () => {
    const live = V.newCol;
    if (!near(C.val(live + '32'), C.val('L25'))) return `${live}32=${fx(C.val(live + '32'))} ≠ L25=${fx(C.val('L25'))}`;
    if (!isNum(C.val(live + '36')) || Math.abs(C.val(live + '36')) > EPS) return `${live}36 debería ser 0 al abrir el mes y es ${C.val(live + '36')}`;
    return null;
  });
  add('POS07', 'El acumulado del año coincide en las tres celdas que lo muestran', () => (near(C.val('H17'), C.val('P25')) && near(C.val('H17'), C.val(V.newCol + '35')) ? null : `H17=${fx(C.val('H17'))}, P25=${fx(C.val('P25'))}, ${V.newCol}35=${fx(C.val(V.newCol + '35'))}`));
  add('POS08', '«Mes anterior» de la tabla de bancos quedó con los valores exactos de «Mes actual»', () => { for (const n of [4, 5, 6, 7]) if (C.val('N' + n) !== K.pv('M' + n)) return `N${n}=${C.val('N' + n)} ≠ M${n} previo ${K.pv('M' + n)}`; return null; });
  add('POS09', '«Mes anterior» del patrimonio y las fechas quedaron como corresponde', () => {
    for (const [a, b] of [['M22', 'L22'], ['M23', 'L23'], ['M24', 'L24'], ['M26', 'L26'], ['M21', 'L21']]) if (C.val(a) !== K.pv(b)) return `${a}=${C.val(a)} ≠ ${b} previo ${K.pv(b)}`;
    return C.val('L21') === V.newL21 ? null : `L21=${C.val('L21')} ≠ ${V.newL21}`;
  });
  add('POS10', 'Los punteros de la lista de ingresos apuntan al mes nuevo', () => {
    const r = V.sum.row;
    if (C.val('E' + r) !== V.newL21) return `E${r} no es el mes nuevo`;
    if (C.val('L57') !== V.newL21 || !near(C.val('L58'), C.val('D' + r)) || !near(C.val('K52'), C.val('D' + r) - C.val('J52'))) return `L57=${C.val('L57')}, L58=${C.val('L58')}, K52=${C.val('K52')}`;
    return null;
  });
  add('POS11', 'No aparecen errores nuevos en CONSOL', () => { const old = new Set(pre.errors), now = errorCells(C).filter((e) => !old.has(e)); return now.length ? 'errores nuevos: ' + now.slice(0, 5).join(', ') : null; });
  add('POS12', 'Solo cambiaron las celdas del plan (ninguna escritura colateral, ni en CONSOL ni en las demás hojas)', () => {
    const extra = diffRaw(pre.raw, snapshotRaw(C)).filter((a) => !known.has(a));
    if (extra.length) return 'celdas cambiadas que no están en el plan: ' + extra.slice(0, 6).join(', ');
    const fp = otherSheetsFingerprint(C.engine), bad = Object.keys(pre.fingerprints).filter((sid) => fp[sid] !== pre.fingerprints[sid]);
    if (bad.length) return 'cambió el contenido de otra hoja: ' + bad.join(', ');
    const sh = C.sh, grid = sh.styleGrid, was = pre.styleGrid;
    if (grid.length === was.length) {
      const planned = new Set(plan.writes.filter((w) => 'style' in w).map((w) => addrKey(w.a1) ));
      for (let r = 0; r < sh.sRows; r++) for (let c = 0; c < sh.sCols; c++) if (grid[r * sh.sCols + c] !== was[r * sh.sCols + c] && !planned.has(r * 4096 + c)) return `cambió el formato de ${colLetter(c)}${r + 1}`;
    }
    return null;
  });
  add('POS13', 'El resumen por año coincide con la variación mensual del bloque vivo', () => {
    const s = sumsNow().find((x) => x.year === V.Y); if (V.isDec || !s) return null;
    for (let k = 0; k <= V.m; k++) {
      const a = C.val(SUMMARY_COLS[k] + s.rm), b = C.val(MONTH_COLS[k] + LIVE.mesRow);
      if (isNum(b) && !near(a, b, 1e-3)) return `resumen ${SUMMARY_COLS[k]}${s.rm}=${fx(a)} ≠ ${MONTH_COLS[k]}36=${fx(b)}`;
    }
    return null;
  });
  add('POS14', 'En la lista de ingresos, el resultado de cada mes sigue igual a la variación del patrimonio', () => {
    for (let r = LIST.firstRow; r <= C.sh.rows; r++) {
      const D = C.raw('D' + r), e = C.val('E' + r); if (!isNum(e) || typeof D !== 'string') continue;
      const m = new RegExp('^=\\+?([A-Z]{1,2})\\$?36-F' + r + '$').exec(D.replace(/\s/g, '')); if (!m) continue;
      const g = C.val('G' + r), v = C.val(m[1] + '36');
      if (isNum(v) && !near(g, v, 1e-3)) return `G${r}=${fx(g)} ≠ ${m[1]}36=${fx(v)}`;
    }
    return null;
  });
  add('POG01', 'El resumen por año tiene el mes nuevo (inicio = fin anterior; fin = total vivo; MES = variación)', () => {
    if (V.isDec || !V.hasSummary) return null;
    const a = C.val(V.scn + V.ysi), b = C.val(V.sc + V.ysf), c = C.val(V.scn + V.ysf), d = C.val(V.next + '32'), e = C.val(V.scn + V.ysm), f = C.val(V.next + '36');
    if (!near(a, b, 1e-3) || !near(c, d, 1e-3) || !near(e, f, 1e-3)) return `resumen ${V.scn}: inicio=${fx(a)} (fin anterior ${fx(b)}), fin=${fx(c)} (fila 32 ${fx(d)}), MES=${fx(e)} (fila 36 ${fx(f)})`;
    if (V.isNov && !near(C.val('AR' + V.ysf), C.val('AR' + V.ysm), 1e-3)) return `AR${V.ysf}=${fx(C.val('AR' + V.ysf))} ≠ AR${V.ysm}=${fx(C.val('AR' + V.ysm))}`;
    return null;
  });
  add('POG02', 'La comparación «var periodo» del mes nuevo = total vivo − total archivado del mismo mes', () => {
    if (V.isDec || !V.hasVarRow) return null;
    const a = C.val(V.next + V.pvr), b = C.val(V.next + '32') - C.val(V.next + V.pT);
    return near(a, b, 1e-3) ? null : `${V.next}${V.pvr}=${fx(a)} ≠ ${fx(b)}`;
  });
  // ---- solo diciembre: apertura del año nuevo
  const baseCols = [BASE_COL, ...MONTH_COLS];
  add('POF01', 'Archivo: los 13 totales archivados = los totales del bloque vivo antes de reiniciarlo', () => { for (const c of baseCols) if (!near(C.val(c + V.T), K.pv(c + '32'))) return `${c}${V.T}=${fx(C.val(c + V.T))} ≠ ${c}32 previo ${fx(K.pv(c + '32'))}`; return null; }, true);
  add('POF02', 'Archivo: fechas y las tres partes de los 13 meses = las del bloque vivo antes de reiniciarlo', () => {
    for (const c of baseCols) {
      for (let k = 0; k < 3; k++) if (!near(C.val(c + (V.d1 + k)), K.pv(c + (29 + k)))) return `${c}${V.d1 + k} ≠ ${c}${29 + k} previo`;
      if (C.val(c + V.d) !== K.pv(c + '28')) return `fecha ${c}${V.d} ≠ ${c}28 previo`;
    }
    return null;
  }, true);
  add('POF03', 'Bloque vivo nuevo: base = cierre de diciembre = O25; enero = patrimonio; febrero a diciembre en cero', () => (near(C.val('R32'), K.pv('AD32')) && near(C.val('R32'), C.val('O25')) && near(C.val('S32'), C.val('L25')) && MONTH_COLS.slice(1).every((c) => isNum(C.val(c + '32')) && Math.abs(C.val(c + '32')) <= EPS) ? null : `R32=${fx(C.val('R32'))}, AD32 previo=${fx(K.pv('AD32'))}, O25=${fx(C.val('O25'))}, S32=${fx(C.val('S32'))}`), true);
  add('POF04', 'Enero: el acumulado y la variación del mes coinciden con H17', () => (near(C.val('S35'), C.val('H17')) && near(C.val('S36'), C.val('S35')) && near(C.val('S35'), C.val('S32') - C.val('O25')) ? null : `S35=${C.val('S35')}, S36=${C.val('S36')}, H17=${C.val('H17')}`), true);
  add('POF05', 'El resumen por año del año que cierra conserva exactamente sus valores', () => {
    const bad = [];
    for (const k of [...cellsOf(`AF${V.spi}:AR${V.spm}`), 'AS' + V.spm, 'AT' + V.spm]) { const a = K.pv(k), b = C.val(k); if (isNum(a) && !near(a, b, 1e-3)) bad.push(`${k}: ${fx(a)} → ${fx(b)}`); }
    return bad.length ? 'el resumen del año que cierra cambió: ' + bad.slice(0, 4).join('; ') : null;
  }, true);
  add('POF06', 'Las filas de resumen de la lista del año que cierra conservan su egreso y su resultado', () => {
    const bad = [];
    for (const r of plan.meta.listRows || []) { const a = K.pv('D' + r), b = C.val('D' + r), g = K.pv('G' + r); if (!near(a, b, 1e-3) || !near(g, C.val('G' + r), 1e-3)) bad.push('D/G' + r); }
    return bad.length ? 'la lista cambió: ' + bad.join(', ') : null;
  }, true);
  add('POF07', 'Las comparaciones «var periodo» que leían el año vivo quedaron como valores', () => {
    for (const a of plan.meta.varCells || []) if (!near(K.pv(a), C.val(a), 1e-3) || isFormulaRaw(C.raw(a))) return `${a} no quedó fija con su valor (${fx(K.pv(a))} → ${fx(C.val(a))})`;
    return null;
  }, true);
  add('POF08', 'Resumen por año nuevo: solo enero (inicio = fin de diciembre; fin = total de enero; MES = variación de enero)', () => (near(C.val('AF' + V.si), C.val('AQ' + V.spf)) && near(C.val('AF' + V.sf), C.val('S32')) && near(C.val('AF' + V.sm), C.val('S36')) && blank(C.raw('AG' + V.sf)) && blank(C.raw('AR' + V.sf)) && blank(C.raw('AS' + V.sm)) ? null : `resumen nuevo: AF${V.si}=${fx(C.val('AF' + V.si))}, AF${V.sf}=${fx(C.val('AF' + V.sf))}, AF${V.sm}=${fx(C.val('AF' + V.sm))}`), true);
  add('POF09', 'Archivo: la comparación y el cambio del año coinciden con el resumen del año que cerró', () => (near(C.val('R' + V.Vr), C.val('AD' + V.Vr)) && (V.prevT ? near(C.val('AD' + V.CH), C.val('AR' + V.spf)) : true) && !blank(C.raw('S' + V.Vr)) && blank(C.raw('T' + V.Vr)) ? null : `R${V.Vr}=${fx(C.val('R' + V.Vr))}, AD${V.Vr}=${fx(C.val('AD' + V.Vr))}, AD${V.CH}=${fx(C.val('AD' + V.CH))}, AR${V.spf}=${fx(C.val('AR' + V.spf))}`), true);
  add('POF10', 'Comparativo anual: la columna nueva es el cierre de diciembre y las anteriores se corrieron un lugar', () => {
    for (let k = 0; k < 3; k++) if (!near(C.val('S' + (22 + k)), C.val('R' + (29 + k))) || !near(C.val('T' + (22 + k)), K.pv('S' + (22 + k))) || !near(C.val('U' + (22 + k)), K.pv('T' + (22 + k)))) return `comparativo S21:W26: fila ${22 + k}`;
    return C.val('S21') === V.decY && C.val('T21') === K.pv('S21') && C.val('U21') === K.pv('T21') ? null : 'cabeceras S21:U21';
  }, true);
  add('POF11', 'Diciembre base: fechas y cifras del nuevo año', () => (C.val('O21') === V.decY && C.val('R28') === V.decY && [0, 1, 2].every((k) => near(C.val('O' + (22 + k)), C.val('R' + (29 + k)))) && near(C.val('M25'), C.val('O25')) && C.val('M21') === V.decY ? null : `O21=${C.val('O21')}, R28=${C.val('R28')}, M25=${C.val('M25')}, O25=${C.val('O25')}`), true);
  add('POF12', 'El rótulo del acumulado lleva el año nuevo', () => (C.val('Q35') === 'acumulado ' + V.Y1 ? null : `Q35=${C.val('Q35')}`), true);
  return checks.filter((x) => !x.dec || V.isDec);
}
/** Ejecuta las poscondiciones: {failures:[{id, text, detail}], checked:[ids]}. */
function runChecks(C, V, plan, pre) {
  const failures = [], checked = [];
  for (const ck of makeChecks(C, V, plan, pre)) {
    let msg = null;
    checked.push(ck.id);
    try { msg = ck.fn(); } catch (e) { msg = 'error al comprobar: ' + ((e && e.message) || e); }
    if (msg) failures.push({ id: ck.id, text: ck.text, detail: msg });
  }
  return { failures, checked };
}

/* ================================================================== escritura (una tanda síncrona) y restauración */
function suspendEnd(engine) {
  try { const hf = engine.hf; if (hf && typeof hf.isEvaluationSuspended === 'function' && hf.isEvaluationSuspended()) hf.resumeEvaluation(); } catch (e) { /* nada */ }
}
function inBatch(engine, fn) {
  const hf = engine.hf;
  if (hf && typeof hf.batch === 'function') {
    try { hf.batch(fn); } finally { suspendEnd(engine); }
  } else fn();
}
function clearUndoStack(engine) { try { if (engine.hf && typeof engine.hf.clearUndoStack === 'function') engine.hf.clearUndoStack(); } catch (e) { /* nada */ } }

/** Escribe contenido y formatos: items = [{a1, raw?, style?}] (raw: se escribe tal cual; undefined = no tocar). */
function writeItems(C, items) {
  inBatch(C.engine, () => {
    for (const w of items) {
      const p = C.P(w.a1);
      if ('raw' in w) C.engine.set(SID, p.r, p.c, w.raw === undefined ? null : w.raw);
    }
  });
  for (const w of items) if ('style' in w && w.style !== undefined) { const p = C.P(w.a1); C.sh.setStyle(p.r, p.c, w.style); }
}
/** Comprueba que cada celda quedó con el contenido esperado; devuelve las que no. */
function verifyItems(C, items) {
  const bad = [];
  for (const w of items) {
    if ('raw' in w && !sameRaw(C.raw(w.a1), w.raw)) bad.push(w.a1);
    else if ('style' in w && w.style !== undefined && C.sty(w.a1) !== w.style) bad.push(w.a1);
  }
  return bad;
}
function toUndo(plan) {
  const cells = [], styles = [];
  for (const w of plan.writes) {
    if ('raw' in w) cells.push({ a: w.a1, b: w.raw0 === undefined ? null : w.raw0, n: w.raw });
    if ('style' in w) styles.push({ a: w.a1, b: w.style0, n: w.style });
  }
  return { v: 1, sid: SID, key: plan.month.key, label: plan.month.label, next: plan.next.label, yearEnd: plan.yearEnd, at: Date.now(), cells, styles };
}

const fail = (error, extra = {}) => Object.assign({ ok: false, error }, extra);

/**
 * Aplica el cierre. Todo o nada: si una poscondición falla (o algo se escribe distinto de lo previsto) se restaura el
 * contenido Y el formato de todas las celdas y se devuelve {ok:false, error, failures}.
 * @param {object} plan  el resultado de planClose (se vuelve a calcular: si la hoja cambió desde entonces, no se escribe)
 * @param {{confirmed?:boolean}} opts  confirmed:true = la persona aceptó los avisos que lo exigen
 * @returns {{ok:true, changes:{count,formats,cells}, undo:object, controls:{antes,despues}, ms:number}|{ok:false, error:string, reason:string, failures?:object[]}}
 */
export function applyClose(engine, plan, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!plan || !plan.ok || plan.blocked.length) return fail('El cierre no se puede aplicar: ' + ((plan && plan.blocked && plan.blocked[0] && plan.blocked[0].text) || 'el plan está bloqueado.'), { reason: 'blocked' });
  if (plan.warnings.some((w) => w.confirm) && !opts.confirmed) return fail('Hay avisos que necesitan tu confirmación antes de cerrar.', { reason: 'confirm' });
  let C;
  try {
    C = makeCtx(engine);
    if (!C.sh) return fail('No encuentro la hoja CONSOL.', { reason: 'blocked' });
    const fresh = planClose(engine, { today: plan.today });                 // el estado pudo cambiar mientras se revisaba el cierre
    if (!fresh.ok) return fail('La hoja cambió y ya no se puede cerrar: ' + (fresh.blocked[0] ? fresh.blocked[0].text : ''), { reason: 'stale' });
    if (fresh.signature !== plan.signature) return fail('La hoja cambió mientras se revisaba el cierre. Vuelve a intentarlo.', { reason: 'stale' });
    plan = fresh;
  } catch (e) { return fail('No se pudo preparar la escritura: ' + ((e && e.message) || e), { reason: 'error' }); }

  const V = plan._V;
  const pre = { raw: snapshotRaw(C), values: snapshotValues(C), errors: errorCells(C), fingerprints: otherSheetsFingerprint(engine), styleGrid: C.sh.styleGrid.slice() };
  const items = plan.writes.map((w) => { const o = { a1: w.a1 }; if ('raw' in w) o.raw = w.raw; if ('style' in w) o.style = w.style; return o; });
  const back = plan.writes.map((w) => { const o = { a1: w.a1 }; if ('raw' in w) o.raw = w.raw0; if ('style' in w) o.style = w.style0; return o; });
  /** Devuelve TODO a como estaba: las celdas del plan, cualquier otra celda de CONSOL que haya cambiado y la rejilla completa de formatos. */
  const restoreAll = () => {
    const put = (list) => { for (const w of list) { const p = C.P(w.a1); if ('raw' in w) engine.set(SID, p.r, p.c, w.raw === undefined ? null : w.raw); if ('style' in w && w.style !== undefined) C.sh.setStyle(p.r, p.c, w.style); } };
    try { writeItems(C, back); } catch (e) { try { put(back); } catch (e2) { /* sin más recursos */ } }
    suspendEnd(engine);
    try {
      const stray = diffRaw(pre.raw, snapshotRaw(C));                      // escrituras fuera del plan (no deberían existir): también se devuelven
      if (stray.length) writeItems(C, stray.map((a) => ({ a1: a, raw: a in pre.raw ? pre.raw[a] : null })));
      const grid = C.sh.styleGrid;
      if (grid.length === pre.styleGrid.length) grid.set(pre.styleGrid);
    } catch (e) { /* se informa abajo con lo que quede */ }
    suspendEnd(engine); clearUndoStack(engine);
    return diffRaw(pre.raw, snapshotRaw(C));
  };
  try {
    writeItems(C, items);
  } catch (e) {
    const left = restoreAll();
    return fail('No se pudo escribir el cierre (' + ((e && e.message) || e) + '). ' + (left.length ? 'ATENCIÓN: no se pudo restaurar del todo (' + left.slice(0, 4).join(', ') + ').' : 'No se cambió nada.'), { reason: 'write', rolledBack: !left.length });
  }
  suspendEnd(engine);
  let failures = [], checked = [];
  const wrong = verifyItems(C, items);
  if (wrong.length) failures.push({ id: 'ESC', text: 'Algunas celdas no quedaron con lo previsto', detail: wrong.slice(0, 6).join(', ') });
  if (!failures.length) ({ failures, checked } = runChecks(C, V, plan, pre));
  if (failures.length) {
    const left = restoreAll();
    const otherSheet = failures.some((f) => f.id === 'POS12' && /otra hoja/.test(f.detail));      // no hay copia de las demás hojas: solo se puede avisar
    return fail('Se detuvo el cierre porque una comprobación no cuadró (' + failures.map((f) => f.text).join('; ') + '). ' + (left.length ? 'ATENCIÓN: no se pudo restaurar del todo (' + left.slice(0, 4).join(', ') + ').' : otherSheet ? 'ATENCIÓN: otra hoja del libro cambió y no se puede restaurar desde aquí: revisa el libro.' : 'No se cambió nada en la hoja.'), { reason: 'verify', failures, rolledBack: !left.length && !otherSheet });
  }
  clearUndoStack(engine);                                                   // el «Deshacer» de la cuadrícula no debe poder deshacer el cierre a medias
  const after = readControls(C);
  return {
    ok: true,
    changes: { count: plan.cells.length, formats: plan.counts.formats, cells: plan.cells.map((c) => ({ a1: c.a1, before: c.before, after: c.after })) },
    undo: toUndo(plan),
    controls: { antes: plan.controls.antes, despues: after },
    month: plan.month, next: plan.next, yearEnd: plan.yearEnd, checked,
    ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };
}

/** Celdas que el cierre escribió y que ya no tienen lo que escribió (alguien las cambió después). null si el registro o la hoja no sirven. Solo lee. */
export function undoConflicts(engine, undo) {
  try {
    if (!isUndoRecord(undo)) return null;
    const C = makeCtx(engine);
    if (!C.sh) return null;
    return undo.cells.filter((x) => !sameRaw(C.raw(x.a), x.n)).map((x) => x.a);
  } catch (e) { return null; }
}

/**
 * Deshace un cierre con el registro que devolvió applyClose (undo). Restaura contenido y formato exactamente.
 * Si desde el cierre se cambió alguna celda que el cierre había escrito, NO restaura (para no perder ese cambio) salvo opts.force.
 * @returns {{ok:true, restored:number}|{ok:false, error:string, conflict?:boolean, conflicts?:string[]}}
 */
export function undoClose(engine, undo, opts = {}) {
  try {
    if (!undo || undo.sid !== SID || !Array.isArray(undo.cells) || !Array.isArray(undo.styles || [])) return fail('El registro para deshacer no es válido.');
    const C = makeCtx(engine);
    if (!C.sh) return fail('No encuentro la hoja CONSOL.');
    const conflicts = undo.cells.filter((x) => !sameRaw(C.raw(x.a), x.n)).map((x) => x.a);
    if (conflicts.length && !opts.force) {
      return fail(`Desde el cierre se cambiaron ${conflicts.length} ${plural(conflicts.length, 'celda', 'celdas')} que el cierre había escrito (por ejemplo ${conflicts.slice(0, 3).join(', ')}). Para no perder esos cambios no se deshizo.`, { conflict: true, conflicts });
    }
    const nStyles = (engine.styles || []).length;
    const items = [...undo.cells.map((x) => ({ a1: x.a, raw: x.b === undefined ? null : x.b })), ...(undo.styles || []).filter((x) => Number.isInteger(x.b) && (!nStyles || x.b < nStyles)).map((x) => ({ a1: x.a, style: x.b }))];
    const forward = [...undo.cells.map((x) => ({ a1: x.a, raw: x.n === undefined ? null : x.n })), ...(undo.styles || []).filter((x) => Number.isInteger(x.n) && (!nStyles || x.n < nStyles)).map((x) => ({ a1: x.a, style: x.n }))];
    const was = snapshotRaw(C);
    try { writeItems(C, items); } catch (e) {
      try { writeItems(C, forward); } catch (e2) { /* sin más recursos */ }
      suspendEnd(engine); clearUndoStack(engine);
      return fail('No se pudo deshacer (' + ((e && e.message) || e) + '). Todo quedó como estaba.');
    }
    suspendEnd(engine);
    const wrong = verifyItems(C, items);
    if (wrong.length) {
      writeItems(C, forward); suspendEnd(engine); clearUndoStack(engine);
      void was;
      return fail('No se pudo deshacer del todo (' + wrong.slice(0, 4).join(', ') + '). Todo quedó como estaba.');
    }
    clearUndoStack(engine);
    return { ok: true, restored: undo.cells.length, formats: (undo.styles || []).length, label: undo.label, key: undo.key };
  } catch (e) { return fail('No se pudo deshacer: ' + ((e && e.message) || e)); }
}

/** ¿Es un registro de deshacer con forma válida? (por ejemplo, el que se leyó de IndexedDB) */
export function isUndoRecord(x) {
  return !!x && x.v === 1 && x.sid === SID && typeof x.key === 'string' && typeof x.label === 'string' && Array.isArray(x.cells) && x.cells.every((c) => c && typeof c.a === 'string' && 'n' in c && 'b' in c) && (x.styles === undefined || Array.isArray(x.styles));
}

/** Controles de lectura rápida (para mostrar «antes / después» o depurar). */
export function readCloseControls(engine) {
  const C = makeCtx(engine);
  return C.sh ? readControls(C) : {};
}
