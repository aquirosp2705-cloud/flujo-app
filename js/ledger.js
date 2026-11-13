/* ledger.js — captura de movimientos bancarios ("Movimientos") de FlujoWeb.
 *
 * Dos capas en un solo archivo (sin dependencias externas):
 *   1) Capa de datos (sin DOM): LEDGERS, getLedger, ledgerInfo, listMovements, suggestDescriptions, addMovement,
 *      updateMovement, removeLastMovement, parsePastedMovements, analyzeImport, importMovements, extendTemplate.
 *   2) Pantalla: mount(host, ctx, { ledgerId }).
 *
 * Modelo: un "libro mayor simple" es una hoja con una fila por movimiento y una columna de saldo corrido cuya
 * fórmula (saldo anterior ± importes) viene prellenada hacia abajo ("plantilla"). Capturar = escribir SOLO las
 * celdas de entrada en la primera fila libre, que es (última fila con algo en las columnas de entrada) + 1,
 * NUNCA la primera celda vacía: hay filas en blanco intercaladas en el historial.
 *
 * Todas las filas y columnas son base 0, como en engine.js. `rowNumber`/`a1` son los números que ve el usuario.
 * Convención de signos por cuenta (config `terms` y `put`):
 *   - terms: cada columna que suma al saldo con su efecto (+1 / -1) y su lado (debit | credit).
 *   - put:   en qué columna se escribe un débito, un crédito y una comisión, y con qué signo.
 * Fechas: las filas nuevas llevan fecha real (número de serie de Excel, base 1899-12-30), por defecto el día 1 del
 * mes con el formato que ya usa la columna; nunca se imitan los textos antiguos.
 *
 * Ejemplos de este archivo: datos ficticios ("Pago de servicios", 1234.50, ...).
 */
import { colLetter, colIndex } from './engine.js';
import { isDateFormat, fmtCell, todaySerial } from './format.js';
import * as UI from './ui.js';

/* ===================================================================== 1. utilidades */

const DAY_MS = 86400000;
const EPOCH_MS = Date.UTC(1899, 11, 30);
export const toSerial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - EPOCH_MS) / DAY_MS);
export function fromSerial(n) {
  const d = new Date(EPOCH_MS + Math.floor(n) * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
export const monthStart = (n) => { const x = fromSerial(n); return toSerial(x.y, x.m, 1); };
export const monthEnd = (n) => { const x = fromSerial(n); return toSerial(x.y, x.m + 1, 1) - 1; };
/** ¿Es una fecha razonable (1990-2100)? Descarta años imposibles de tipeos antiguos. */
export const isPlausibleSerial = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 32874 && n <= 73415;

/** Redondeo a centavos sin errores de coma flotante (1.005 -> 1.01). */
export function round2(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return NaN;
  if (Math.abs(n) >= 1e13) return n;
  const v = Number(Math.round(Number(Math.abs(n) + 'e2')) + 'e-2');
  return n < 0 ? -v : v;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Texto comparable: sin acentos, minúsculas, solo letras y números separados por un espacio. */
export function normDesc(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const MONTH_NAMES = {
  ene: 1, enero: 1, jan: 1, january: 1, feb: 2, febrero: 2, february: 2, mar: 3, marzo: 3, march: 3, abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5, jun: 6, junio: 6, june: 6, jul: 7, julio: 7, july: 7, ago: 8, agosto: 8, aug: 8, august: 8,
  sep: 9, sept: 9, set: 9, septiembre: 9, setiembre: 9, september: 9, oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11, dic: 12, diciembre: 12, dec: 12, december: 12,
};
const monthNo = (s) => MONTH_NAMES[String(s).toLowerCase().replace(/\./g, '')] || null;
function mkDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = toSerial(y, m, d), x = fromSerial(s);
  if (x.y !== y || x.m !== m || x.d !== d) return null;
  return isPlausibleSerial(s) ? s : null;
}
const yy = (s) => { let y = +s; if (y < 100) y += 2000; return y; };

/** Fecha tolerante -> número de serie (o null). Solo para mostrar o leer textos pegados; nunca modifica celdas.
 *  Acepta dd/mm/aaaa, aaaa-mm-dd, dd-mm-aa, "13 nov 2026", "nov 13 2026", "nov132026", "nov1326". */
export function parseLooseDate(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t || !/\d/.test(t)) return null;
  let m;
  if ((m = /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?:[ t].*)?$/.exec(t))) return mkDate(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})(?:[ t].*)?$/.exec(t))) {
    let d = +m[1], mo = +m[2]; const y = yy(m[3]);
    if (mo > 12 && d <= 12) { const x = d; d = mo; mo = x; }
    return mkDate(y, mo, d);
  }
  if ((m = /^(\d{1,2})[\s.\/\-]+(?:de\s+)?([a-z]{3,10})\.?[\s.,\/\-]+(?:de\s+)?(\d{4}|\d{2})$/.exec(t)) && monthNo(m[2])) return mkDate(yy(m[3]), monthNo(m[2]), +m[1]);
  if ((m = /^(\d{1,2})([a-z]{3,10})(\d{4}|\d{2})$/.exec(t)) && monthNo(m[2])) return mkDate(yy(m[3]), monthNo(m[2]), +m[1]);
  if ((m = /^([a-z]{3,10})\.?[\s.\/\-]+(\d{1,2})[\s.,\/\-]+(\d{4}|\d{2})$/.exec(t)) && monthNo(m[1])) return mkDate(yy(m[3]), monthNo(m[1]), +m[2]);
  if ((m = /^([a-z]{3,10})(\d{4,6})$/.exec(t)) && monthNo(m[1])) {           // compacto: nov132026, nov1326, nov12015
    const g = m[2];
    if (g.length === 6) return mkDate(+g.slice(2), monthNo(m[1]), +g.slice(0, 2));
    if (g.length === 5) return mkDate(+g.slice(1), monthNo(m[1]), +g[0]);
    return mkDate(2000 + +g.slice(2), monthNo(m[1]), +g.slice(0, 2));
  }
  return null;
}

function toSerialDate(d) {
  if (typeof d === 'number') return Math.floor(d);
  if (d instanceof Date) return toSerial(d.getFullYear(), d.getMonth() + 1, d.getDate());
  if (typeof d === 'string') { const s = parseLooseDate(d); return s === null ? NaN : s; }
  return NaN;
}

/** Texto de importe -> {value (con signo), negative, strong}. `strong` = parece un importe (decimales, $, signo,
 *  paréntesis, miles); un entero pelado es "débil" (puede ser un número de documento). null si no es un importe.
 *  Acepta $1,234.50 · 1.234,50 · (45.20) · -45.20 · 45.20- · 45,20 */
export function parseMoney(token) {
  if (token === null || token === undefined) return null;
  let t = String(token).replace(/ /g, ' ').trim();
  if (!t) return null;
  let neg = false, strong = false, signSeen = false, m;
  if ((m = /^\(\s*(.*?)\s*\)$/.exec(t))) { neg = true; strong = true; t = m[1]; }
  if ((m = /^([+\-−])\s*(.*)$/.exec(t))) { if (m[1] !== '+') neg = true; strong = true; signSeen = true; t = m[2]; }
  if ((m = /^(?:US\$|USD|U\$S|\$)\s*(.*)$/i.exec(t))) { strong = true; t = m[1]; }
  if ((m = /^([+\-−])\s*(.*)$/.exec(t))) { if (signSeen) return null; if (m[1] !== '+') neg = true; strong = true; signSeen = true; t = m[2]; }
  if ((m = /^(.*?)\s*[\-−]$/.exec(t))) { if (signSeen) return null; neg = true; strong = true; t = m[1]; }
  if (/\s/.test(t)) { if (/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(t)) t = t.replace(/ /g, ''); else return null; }
  let v;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) { v = parseFloat(t.replace(/,/g, '')); strong = true; }
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) && (t.split('.').length > 2 || t.includes(','))) { v = parseFloat(t.replace(/\./g, '').replace(',', '.')); strong = true; }
  else if (/^\d+,\d{1,2}$/.test(t)) { v = parseFloat(t.replace(',', '.')); strong = true; }
  else if (/^\d+\.\d+$/.test(t) || /^\.\d+$/.test(t)) { v = parseFloat(t); strong = true; }
  else if (/^\d+$/.test(t)) v = parseFloat(t);
  else return null;
  if (!Number.isFinite(v)) return null;
  return { value: neg ? -v : v, negative: neg, strong };
}

/** Importe escrito por la usuaria: acepta "1,234.50", "45,20" y expresiones como "14.37+0.31" o "=45.05/3".
 *  -> {ok, value, expression} | {ok:false, empty?, error?} */
export function evalAmount(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, empty: true, error: 'Escribe el monto.' };
  const t = raw.replace(/^=/, '').replace(/\$/g, '').replace(/−/g, '-').trim();
  const pm = parseMoney(t);
  if (pm) return { ok: true, value: round2(pm.value), expression: false };
  if (!/^[\d\s.,+\-*/()]+$/.test(t) || !/\d/.test(t) || /\d\s+\d/.test(t)) return { ok: false, error: 'No entiendo ese monto.' };
  const norm = t.replace(/(\d),(?=\d{3}(?!\d))/g, '$1').replace(/,/g, '.').replace(/\s+/g, '');
  let i = 0;
  const fail = () => { throw new Error('expr'); };
  const num = () => { const m = /^(\d+(\.\d*)?|\.\d+)/.exec(norm.slice(i)); if (!m) fail(); i += m[0].length; return parseFloat(m[0]); };
  const factor = () => {
    if (norm[i] === '+') { i++; return factor(); }
    if (norm[i] === '-') { i++; return -factor(); }
    if (norm[i] === '(') { i++; const v = expr(); if (norm[i] !== ')') fail(); i++; return v; }
    return num();
  };
  const term = () => { let v = factor(); while (norm[i] === '*' || norm[i] === '/') { const op = norm[i++]; const w = factor(); v = op === '*' ? v * w : v / w; } return v; };
  const expr = () => { let v = term(); while (norm[i] === '+' || norm[i] === '-') { const op = norm[i++]; const w = term(); v = op === '+' ? v + w : v - w; } return v; };
  try {
    const v = expr();
    if (i !== norm.length || !Number.isFinite(v)) return { ok: false, error: 'Expresión no válida.' };
    return { ok: true, value: round2(v), expression: true };
  } catch (e) { return { ok: false, error: 'Expresión no válida.' }; }
}

/* ===================================================================== 2. configuración de las cuentas */

const TEMPLATE_MIN_FREE = 30;   // filas de plantilla que conviene mantener libres bajo el último movimiento
const POINTER_MARGIN = 30;      // si el puntero queda a menos filas que esto del último movimiento, se mueve
const EXTEND_BY = 500;          // filas que se agregan al extender la plantilla

/* Cada cuenta describe una hoja concreta del libro. `terms`: columnas que suman al saldo (efecto y lado);
 * `put`: dónde se escribe cada tipo; `balanceTpl`: fórmula de saldo con {r} = número de fila y {p} = fila anterior;
 * `pointers`: celdas de cabecera que leen una fila de la plantilla (las lee el tablero) y `offset` = distancia
 * habitual entre ese puntero y el final de la plantilla (se conserva al moverlo). */
const DEFS = [
  {
    id: 'gye', sid: 's02', sheet: 'GYE', title: 'Guayaquil · Cuenta corriente', short: 'Guayaquil', chip: 'Guayaquil Cte.',
    firstDataRow: 5, cols: { date: 0, number: 1, desc: 2, balance: 7 }, entry: [0, 6], header: { r: 3, c: 7, re: /saldo/i },
    terms: [{ col: 5, effect: -1, side: 'debit' }, { col: 6, effect: 1, side: 'credit' }],
    put: { debit: { col: 5, sign: 1 }, credit: { col: 6, sign: 1 }, fee: { col: 6, sign: -1 } },
    balanceTpl: '+H{p}-F{r}+G{r}',
    pointers: [{ r: 2, c: 7, offset: 26, consumers: [{ sid: 's01', r: 2, c: 2, label: 'En el tablero (CONSOL)' }] }],
    dateMode: 'month', dateNf: 'mmm-yy', numberLabel: 'Número de documento', extendBy: EXTEND_BY,
  },
  {
    id: 'gye-ah', sid: 's10', sheet: 'GYE AH', title: 'Guayaquil · Ahorros', short: 'Guayaquil Ahorros', chip: 'Guayaquil Ahorros',
    firstDataRow: 4, cols: { date: 0, number: 2, desc: 1, balance: 6 }, entry: [0, 5], header: { r: 3, c: 6, re: /saldo/i },
    terms: [{ col: 3, effect: -1, side: 'debit' }, { col: 4, effect: 1, side: 'credit' }, { col: 5, effect: 1, side: 'credit' }],
    put: { debit: { col: 3, sign: 1 }, credit: { col: 5, sign: 1 }, fee: { col: 4, sign: -1 } },
    balanceTpl: '+G{p}+E{r}-D{r}+F{r}',
    pointers: [],
    dateMode: 'month', dateNf: 'mmm-yy', numberLabel: 'Parcial o nota', extendBy: 250,
  },
  {
    id: 'pich', sid: 's06', sheet: 'PICH', title: 'Pichincha · Cuenta corriente', short: 'Pichincha', chip: 'Pichincha',
    firstDataRow: 3, cols: { date: 0, number: 2, desc: 1, balance: 7 }, entry: [0, 6], header: { r: 1, c: 7, re: /saldo/i },
    terms: [{ col: 4, effect: 1, side: 'debit' }, { col: 5, effect: 1, side: 'credit' }, { col: 6, effect: 1, side: 'credit' }],
    put: { debit: { col: 4, sign: -1 }, credit: { col: 6, sign: 1 }, fee: { col: 6, sign: -1 } },
    balanceTpl: '+H{p}+E{r}+F{r}+G{r}',
    pointers: [{ r: 0, c: 7, offset: 51, consumers: [{ sid: 's01', r: 4, c: 2, label: 'En el tablero (CONSOL)' }] }],
    dateMode: 'month', dateNf: 'dd/mmm/yyyy', numberLabel: 'Cheque o nota', extendBy: EXTEND_BY,
  },
  {
    id: 'bol', sid: 's07', sheet: 'BOL', title: 'Bolivariano · Cuenta corriente', short: 'Bolivariano', chip: 'Bolivariano',
    firstDataRow: 4, cols: { date: 1, number: 3, desc: 2, balance: 7 }, entry: [1, 6], header: { r: 3, c: 6, re: /cr[eé]ditos/i },
    terms: [{ col: 5, effect: -1, side: 'debit' }, { col: 6, effect: 1, side: 'credit' }],
    put: { debit: { col: 5, sign: 1 }, credit: { col: 6, sign: 1 }, fee: { col: 6, sign: -1 } },
    balanceTpl: '+H{p}-F{r}+G{r}',
    pointers: [{ r: 1, c: 7, offset: 51, consumers: [{ sid: 's01', r: 3, c: 2, label: 'En el tablero (CONSOL)' }] }],
    dateMode: 'month', dateNf: 'mmm-yy', numberLabel: 'Cheque o nota', extendBy: EXTEND_BY,
  },
];
for (const d of DEFS) { d.templateMinFree = TEMPLATE_MIN_FREE; }

export const LEDGERS = Object.freeze(Object.fromEntries(DEFS.map((d) => [d.id, d])));
export const listLedgers = () => DEFS.slice();
const keyOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = new Map();
for (const d of DEFS) for (const k of [d.id, d.sid, d.sheet]) ALIASES.set(keyOf(k), d);
/** Config de una cuenta por id ("gye", "gye-ah", "pich", "bol"), por id de hoja ("s02") o por nombre de hoja. */
export function getLedger(id) {
  if (id && typeof id === 'object' && id.id) return LEDGERS[id.id] || null;
  return ALIASES.get(keyOf(id)) || null;
}
function need(id) { const L = getLedger(id); if (!L) throw new Error('Cuenta desconocida: ' + id); return L; }

/* ===================================================================== 3. lectura de celdas */

const isBlank = (v) => v === null || v === undefined || v === '';
const a1 = (r, c) => colLetter(c) + (r + 1);
const numOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function sheetOf(engine, L) {
  const sh = engine.ensureLoaded ? engine.ensureLoaded(L.sid) : engine.sheet(L.sid);
  if (!sh) throw new Error('No se encontró la hoja de la cuenta (' + L.sid + ').');
  return sh;
}
function cellEmpty(engine, sh, r, c) {
  const hf = engine.hf;
  if (typeof hf.isCellEmpty === 'function') return hf.isCellEmpty({ sheet: sh.hfId, row: r, col: c });
  return isBlank(engine.raw(sh.id, r, c));
}
function hasFormula(engine, sh, r, c) {
  const hf = engine.hf;
  if (typeof hf.doesCellHaveFormula === 'function') return hf.doesCellHaveFormula({ sheet: sh.hfId, row: r, col: c });
  return engine.isFormula(sh.id, r, c);
}
/** Última fila con algo en las columnas de entrada (-1 si no hay). */
function lastEntryRow(engine, L, sh) {
  const [c0, c1] = L.entry;
  for (let r = Math.max(sh.rows, L.firstDataRow + 1) - 1; r >= L.firstDataRow; r--) {
    for (let c = c0; c <= c1; c++) if (!cellEmpty(engine, sh, r, c)) return r;
  }
  return -1;
}
/** ¿La celda de saldo de la fila r es una fórmula "en cadena" (lee el saldo de la fila anterior)? */
function isChainFormula(engine, L, sh, r) {
  const bc = L.cols.balance;
  if (!hasFormula(engine, sh, r, bc)) return false;
  const f = engine.raw(L.sid, r, bc);
  return typeof f === 'string' && new RegExp("(^|[^A-Za-z0-9_!'])\\$?" + colLetter(bc) + '\\$?' + r + '(?!\\d)').test(f);   // fila anterior en base 1 = r
}
/** Última fila de la plantilla (fórmula de saldo contigua) desde `from`; ignora fórmulas sueltas que no leen la fila anterior. */
function templateEndFrom(engine, L, sh, from) {
  const bc = L.cols.balance; let end = from - 1;
  for (let r = from; r < from + 60000; r++) { if (!hasFormula(engine, sh, r, bc)) break; end = r; }
  while (end >= from && !isChainFormula(engine, L, sh, end)) end--;
  return end;
}
function scan(engine, L) {
  const sh = sheetOf(engine, L);
  const lastRow = lastEntryRow(engine, L, sh);
  const nextRow = lastRow < 0 ? L.firstDataRow : lastRow + 1;
  const end = templateEndFrom(engine, L, sh, nextRow);
  return { sh, lastRow, nextRow, templateEnd: end, templateLeft: Math.max(0, end - nextRow + 1) };
}

function dateLabelOf(engine, L, r, serial) {
  try {
    const st = engine.styleOf(L.sid, r, L.cols.date);
    if (st && st.nf && isDateFormat(st.nf)) { const t = fmtCell(serial, st).t; if (t) return t; }
  } catch (e) { /* sin SSF: texto simple */ }
  return UI.dateText(serial);
}

/** Columnas que suman al saldo, con su contenido crudo y calculado. */
function termsAt(engine, L, r) {
  return L.terms.map((t) => {
    const raw = engine.raw(L.sid, r, t.col), val = engine.value(L.sid, r, t.col);
    return { col: t.col, effect: t.effect, side: t.side, raw, value: numOr0(val), blank: isBlank(raw), formula: engine.isFormula(L.sid, r, t.col) };
  });
}
function sums(terms) {
  let debit = 0, credit = 0;
  for (const t of terms) { if (t.side === 'debit') debit += -t.effect * t.value; else credit += t.effect * t.value; }
  return { debit: round2(debit), credit: round2(credit), amount: round2(credit - debit) };
}
/** Débito o crédito "principal" de una fila (para editarla); null si la fila es mixta o especial. */
function principalOf(debit, credit) {
  if (debit > 0 && credit <= 0) return { kind: 'debit', amount: debit, fee: round2(-credit) };
  if (credit > 0 && debit <= 0) return { kind: 'credit', amount: credit, fee: 0 };
  return null;
}
const netAt = (engine, L, r) => sums(termsAt(engine, L, r)).amount;

/** Lee una fila como movimiento; null si no es un movimiento (en blanco o solo con fecha). */
function readRow(engine, L, r) {
  const sid = L.sid, c = L.cols;
  const dv = engine.value(sid, r, c.date), descV = engine.value(sid, r, c.desc), numV = engine.value(sid, r, c.number);
  const terms = termsAt(engine, L, r);
  const s = sums(terms);
  const desc = typeof descV === 'string' ? clean(descV) : (isBlank(descV) ? '' : (typeof descV === 'object' ? String(descV.error || '') : String(descV)));
  const number = isBlank(numV) ? null : (typeof numV === 'object' ? String(numV.error || '') : numV);
  const hasAmount = terms.some((t) => !t.blank && t.value !== 0);
  if (!desc && !hasAmount && number === null) return null;
  let date = null, dateLabel = '', dateIsText = false, dateGuess = false, dateInvalid = false;
  if (typeof dv === 'number') {
    if (isPlausibleSerial(dv)) { date = Math.floor(dv); dateLabel = dateLabelOf(engine, L, r, dv); }
    else { dateInvalid = true; dateLabel = String(dv); }
  } else if (typeof dv === 'string' && dv.trim()) {
    dateIsText = true; dateLabel = dv.trim();
    const g = parseLooseDate(dv); if (g !== null) { date = g; dateGuess = true; }
  }
  const bal = engine.value(sid, r, c.balance);
  return {
    row: r, rowNumber: r + 1, date, dateLabel, dateIsText, dateGuess, dateInvalid, desc, number,
    debit: s.debit, credit: s.credit, amount: s.amount, kind: s.amount < 0 ? 'debit' : 'credit',
    balance: typeof bal === 'number' ? bal : null,
    principal: principalOf(s.debit, s.credit),
    hasFormula: terms.some((t) => t.formula),
    cells: { date: engine.raw(sid, r, c.date), desc: engine.raw(sid, r, c.desc), number: engine.raw(sid, r, c.number) },
    amountCells: terms.map((t) => ({ col: t.col, raw: t.raw, value: t.value, formula: t.formula })),
  };
}

/** Punteros: celdas de cabecera que leen una fila de la plantilla (p. ej. "=+H{fila}" o "=ROUND(H{fila},0)-n"). */
function pointerRe(L) { return new RegExp("(^|[^A-Za-z0-9_!'])(\\$?" + colLetter(L.cols.balance) + '\\$?)(\\d+)'); }
function readPointer(engine, L, p) {
  const raw = engine.raw(L.sid, p.r, p.c);
  let row = null;
  if (typeof raw === 'string' && raw[0] === '=') { const m = pointerRe(L).exec(raw); if (m) row = parseInt(m[3], 10) - 1; }
  const value = engine.value(L.sid, p.r, p.c);
  return { raw, row, value: typeof value === 'number' ? value : null };
}
const movePointerRaw = (L, raw, newRow) => raw.replace(pointerRe(L), (m, a, b) => a + b + (newRow + 1));

/* ===================================================================== 4. información, lista y sugerencias */

function monthChange(engine, L, lastRow, today) {
  const start = monthStart(today), end = monthEnd(today);
  let amount = 0, inflow = 0, outflow = 0, count = 0;
  for (let r = lastRow, n = 0; r >= L.firstDataRow && n < 600; r--, n++) {
    const d = engine.value(L.sid, r, L.cols.date);
    if (typeof d !== 'number' || d < start || d > end) continue;
    const net = netAt(engine, L, r);
    if (net === 0) continue;
    count++; amount += net; if (net > 0) inflow += net; else outflow += net;
  }
  return { start, end, label: UI.monthText(start), amount: round2(amount), inflow: round2(inflow), outflow: round2(outflow), count };
}

/** Estado de una cuenta: saldo, último movimiento, próxima fila, plantilla, punteros y variación del mes. */
export function ledgerInfo(engine, id, opts = {}) {
  const L = need(id);
  const st = scan(engine, L);
  const sid = L.sid, bc = L.cols.balance;
  const today = Number.isFinite(opts.today) ? opts.today : todaySerial();
  let balRow = st.lastRow >= 0 ? st.lastRow : L.firstDataRow - 1, balance = null;
  for (let r = balRow, n = 0; r >= 0 && n < 40; r--, n++) { const v = engine.value(sid, r, bc); if (typeof v === 'number') { balance = v; balRow = r; break; } }
  let lastDate = null, lastDateLabel = '';
  for (let r = st.lastRow, n = 0; r >= L.firstDataRow && n < 80; r--, n++) {
    const v = engine.value(sid, r, L.cols.date);
    if (isPlausibleSerial(v)) { lastDate = Math.floor(v); lastDateLabel = dateLabelOf(engine, L, r, v); break; }
  }
  const warnings = [];
  const h = engine.value(sid, L.header.r, L.header.c);
  if (!(typeof h === 'string' && L.header.re.test(h))) warnings.push('La hoja ya no tiene el encabezado esperado en ' + a1(L.header.r, L.header.c) + '. Revisa la hoja antes de capturar.');
  const pointers = L.pointers.map((p) => {
    const rp = readPointer(engine, L, p);
    const stale = rp.row === null ? null : rp.row < st.lastRow;
    if (rp.row === null) warnings.push('La celda ' + a1(p.r, p.c) + ' ya no apunta al saldo: el tablero podría no ver el saldo actual.');
    else if (stale) warnings.push('La celda ' + a1(p.r, p.c) + ' apunta a la fila ' + (rp.row + 1) + ', antes del último movimiento. Se corrige al guardar el próximo movimiento.');
    const consumers = p.consumers.map((cn) => { const v = engine.value(cn.sid, cn.r, cn.c); return { sid: cn.sid, label: cn.label, a1: a1(cn.r, cn.c), value: typeof v === 'number' ? v : null }; });
    return { a1: a1(p.r, p.c), r: p.r, c: p.c, formula: rp.raw, row: rp.row, rowNumber: rp.row === null ? null : rp.row + 1, value: rp.value, stale, consumers };
  });
  return {
    id: L.id, title: L.title, short: L.short, sid, sheetName: L.sheet,
    balance, balanceRow: balRow,
    lastRow: st.lastRow, lastRowNumber: st.lastRow + 1, lastDate, lastDateLabel,
    nextRow: st.nextRow, nextRowNumber: st.nextRow + 1, templateEnd: st.templateEnd, templateRowsLeft: st.templateLeft,
    pointers, month: monthChange(engine, L, st.lastRow, today),
    dateMode: L.dateMode, dateNf: L.dateNf, numberLabel: L.numberLabel, warnings,
  };
}

/** Últimos movimientos, el más reciente primero. `before` = fila (base 0) desde la que seguir hacia atrás (exclusiva). */
export function listMovements(engine, id, { limit = 50, before = null } = {}) {
  const L = need(id);
  const sh = sheetOf(engine, L);
  const top = before === null || before === undefined ? lastEntryRow(engine, L, sh) : before - 1;
  const out = [];
  for (let r = top; r >= L.firstDataRow && out.length < limit; r--) { const m = readRow(engine, L, r); if (m) out.push(m); }
  return out;
}

const DESC_WINDOW = 1800;   // filas hacia atrás que se miran para sugerir
const DESC_RECENT = 300;    // las últimas filas pesan más: lo que se usa hoy es lo que se vuelve a teclear
/** Índice de descripciones usadas para autocompletar. Puntaje = 3 × usos en las últimas 300 filas
 *  + 0,35 × usos en toda la ventana + 6 × cercanía de la última vez (0 a 1). */
export function descriptionIndex(engine, id, { lastRow = null } = {}) {
  const L = need(id);
  const sh = sheetOf(engine, L);
  const last = lastRow === null ? lastEntryRow(engine, L, sh) : lastRow;
  const map = new Map();
  let minRow = last, maxRow = last;
  for (let r = last, n = 0; r >= L.firstDataRow && n < DESC_WINDOW; r--, n++) {
    const v = engine.value(L.sid, r, L.cols.desc);
    if (typeof v !== 'string') continue;
    const text = clean(v);
    if (text.length < 2 || text.length > 80) continue;
    const key = normDesc(text);
    if (!key) continue;
    let e = map.get(key);
    if (!e) { e = { key, text, count: 0, recent: 0, last: r }; map.set(key, e); }    // se recorre hacia atrás: la primera lectura es la más reciente
    e.count++; if (n < DESC_RECENT) e.recent++;
    minRow = r;
  }
  return { items: [...map.values()], minRow, maxRow };
}
/** Filtra un índice: primero las que empiezan con el texto, luego palabras y contiene; dentro de cada grupo, frecuentes y recientes. */
export function filterSuggestions(index, prefix, limit = 8) {
  const q = normDesc(prefix);
  const span = Math.max(1, index.maxRow - index.minRow);
  const scored = [];
  for (const e of index.items) {
    let tier = 0;
    if (q) {
      if (e.key.startsWith(q)) tier = 0;
      else if (e.key.split(' ').some((w) => w.startsWith(q))) tier = 1;
      else if (e.key.includes(q)) tier = 2;
      else continue;
    }
    scored.push({ e, tier, score: 3 * e.recent + 0.35 * e.count + 6 * ((e.last - index.minRow) / span) });
  }
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score || (a.e.text < b.e.text ? -1 : 1));
  return scored.slice(0, limit).map((x) => x.e.text);
}
export function suggestDescriptions(engine, id, prefix, { limit = 8, index = null } = {}) {
  return filterSuggestions(index || descriptionIndex(engine, id), prefix, limit);
}
/** Último uso de una descripción: tipo, monto y número, para rellenar el formulario. */
export function suggestionDetails(engine, id, text) {
  const L = need(id);
  const sh = sheetOf(engine, L);
  const key = normDesc(text);
  if (!key) return null;
  let count = 0, found = null;
  for (let r = lastEntryRow(engine, L, sh), n = 0; r >= L.firstDataRow && n < DESC_WINDOW; r--, n++) {
    const v = engine.value(L.sid, r, L.cols.desc);
    if (typeof v !== 'string' || normDesc(v) !== key) continue;
    count++;
    if (!found) { const m = readRow(engine, L, r); if (m && m.principal) found = { row: r, kind: m.principal.kind, amount: m.principal.amount, number: m.number }; }
  }
  return found ? { ...found, count } : null;
}

/* ===================================================================== 5. escritura */

/* Diario en memoria: lo que hizo cada addMovement, para que "deshacer" restaure EXACTAMENTE el estado anterior
 * (celdas, estilos, plantilla extendida y punteros). No sobrevive a una recarga: sin diario, deshacer solo vacía la fila. */
const JOURNAL = new WeakMap();
function journalOf(engine, id) {
  let m = JOURNAL.get(engine); if (!m) { m = new Map(); JOURNAL.set(engine, m); }
  let a = m.get(id); if (!a) { a = []; m.set(id, a); }
  return a;
}
export function resetJournal(engine, id = null) { const m = JOURNAL.get(engine); if (!m) return; if (id) m.delete(getLedger(id)?.id); else JOURNAL.delete(engine); }

/** Ejecuta varias escrituras como una sola operación de HyperFormula (un recálculo, un paso de deshacer) y
 *  devuelve las celdas cuyo valor cambió. `w` ofrece set/setMatrix/clear con el mismo contrato que Engine. */
function runBatch(engine, fn) {
  const hf = engine.hf, acc = [];
  const w = {
    set: (...a) => { const ch = engine.set(...a); acc.push(...ch); return ch; },
    setMatrix: (...a) => { const ch = engine.setMatrix(...a); acc.push(...ch); return ch; },
    clear: (...a) => { const ch = engine.clear(...a); acc.push(...ch); return ch; },
  };
  let exported = null;
  if (typeof hf.batch === 'function') {
    try { exported = hf.batch(() => { fn(w); }); }
    catch (e) {      // que un error a medio lote no deje el motor con la evaluación suspendida
      try { if (typeof hf.isEvaluationSuspended === 'function' && hf.isEvaluationSuspended()) hf.resumeEvaluation(); } catch (e2) { /* nada más que hacer */ }
      throw e;
    }
  } else fn(w);
  const out = [], seen = new Set();
  const push = (sid, r, c) => { const k = sid + ':' + r + ':' + c; if (!seen.has(k)) { seen.add(k); out.push({ sid, r, c }); } };
  for (const ch of exported || []) {
    if (!ch || !ch.address) continue;
    const sh = engine.sheets.find((s) => s.hfId === ch.address.sheet);
    if (sh) push(sh.id, ch.address.row, ch.address.col);
  }
  for (const x of acc) push(x.sid, x.r, x.c);
  return out;
}

const tplFormula = (L, r) => '=' + L.balanceTpl.replace(/\{r\}/g, String(r + 1)).replace(/\{p\}/g, String(r));
function planExtension(engine, L, sh, templateEnd, count) {
  const bc = L.cols.balance, from = templateEnd + 1;
  let n = 0;
  while (n < count && cellEmpty(engine, sh, from + n, bc)) n++;      // no pisar celdas ocupadas debajo de la plantilla
  if (n === 0) return null;
  const formulas = [];
  for (let i = 0; i < n; i++) formulas.push([tplFormula(L, from + i)]);
  return { from, to: from + n - 1, count: n, formulas, clamped: n < count };
}
function copyRowStyles(sh, fromRow, toRow, c1, setSt) {
  for (let c = 0; c <= c1; c++) setSt(toRow, c, sh.styleAt(fromRow, c));
}

/** Extiende la plantilla de saldo hacia abajo (sin mover punteros). Devuelve {from,to,count,clamped}|null. */
export function extendTemplate(engine, id, { rows = null } = {}) {
  const L = need(id);
  const st = scan(engine, L);
  const sh = st.sh;
  const ext = planExtension(engine, L, sh, st.templateEnd, rows || L.extendBy);
  if (!ext) return null;
  runBatch(engine, (w) => { w.setMatrix(L.sid, ext.from, L.cols.balance, ext.formulas); });
  for (let r = ext.from; r <= ext.to; r++) copyRowStyles(sh, st.templateEnd, r, L.cols.balance, (rr, c, id2) => { if (sh.styleAt(rr, c) !== id2) sh.setStyle(rr, c, id2); });
  return { from: ext.from, to: ext.to, count: ext.count, clamped: ext.clamped };
}

/* ---- estilos ---- */
const nfHasDay = (nf) => /d/i.test(String(nf).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''));
function refDateStyle(engine, L, sh, r) {
  const c = L.cols.date;
  for (let rr = r - 1, n = 0; rr >= L.firstDataRow && n < 400; rr--, n++) {
    if (typeof engine.raw(L.sid, rr, c) !== 'number') continue;
    const id = sh.styleAt(rr, c), nf = (engine.styles[id] || {}).nf;
    if (nf && isDateFormat(nf)) return id;
  }
  return null;
}
/** Formato (nf) que tendrá la fecha: el de las filas anteriores; con día exacto, uno que muestre el día. */
function dateNfFor(engine, L, sh, r, serial, mode) {
  const ref = refDateStyle(engine, L, sh, r);
  const exact = mode === 'exact' || (mode == null && fromSerial(serial).d !== 1);
  const nf = ref !== null ? engine.styles[ref].nf : L.dateNf;
  return exact && !nfHasDay(nf) ? 'dd/mm/yyyy' : nf;
}
function dateStyleIdFor(engine, L, sh, r, serial, mode) {
  const ref = refDateStyle(engine, L, sh, r);
  const nf = dateNfFor(engine, L, sh, r, serial, mode);
  if (ref !== null && engine.styles[ref].nf === nf) return ref;
  return engine.deriveStyle(ref !== null ? ref : sh.styleAt(r, L.cols.date), { nf });
}
function amountStyleFor(engine, L, sh, r, col) {
  const cur = sh.styleAt(r, col), nfCur = (engine.styles[cur] || {}).nf;
  if (nfCur && nfCur !== 'General') return cur;
  for (let rr = r - 1, n = 0; rr >= L.firstDataRow && n < 400; rr--, n++) {
    if (typeof engine.raw(L.sid, rr, col) !== 'number') continue;
    const id = sh.styleAt(rr, col), nf = (engine.styles[id] || {}).nf;
    if (nf && nf !== 'General') return id;
  }
  return cur;
}
/** Cómo se verá una fecha al guardarla: {serial, nf, label}. mode: 'month' (día 1) | 'exact' | null (automático). */
export function previewDate(engine, id, serial, { mode = null, row = null } = {}) {
  const L = need(id);
  const sh = sheetOf(engine, L);
  const r = row === null ? lastEntryRow(engine, L, sh) + 1 : row;
  const eff = mode === 'month' ? monthStart(serial) : serial;
  const nf = dateNfFor(engine, L, sh, r, eff, mode);
  let label = UI.dateText(eff);
  try { label = fmtCell(eff, { nf }).t || label; } catch (e) { /* sin SSF */ }
  return { serial: eff, nf, label };
}

/* ---- altas ---- */
function normalizeNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  return /^[1-9]\d{0,8}$/.test(s) ? Number(s) : s;      // 12345 -> número; "0012" o "ch 15" se conservan como texto
}
function normalizeMovement(L, mv) {
  if (!mv || typeof mv !== 'object') throw new Error('Falta el movimiento.');
  if (mv.kind !== 'credit' && mv.kind !== 'debit') throw new Error("Tipo de movimiento inválido: usa 'credit' o 'debit'.");
  let amount = mv.amount;
  if (typeof amount === 'string') { const e = evalAmount(amount); amount = e.ok ? e.value : NaN; }
  amount = round2(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('El monto debe ser mayor que cero.');
  const date = toSerialDate(mv.date);
  if (!isPlausibleSerial(date)) throw new Error('La fecha no es válida.');
  let desc = clean(mv.desc);
  if (desc[0] === '=') desc = desc.replace(/^=+\s*/, '');
  if (!desc) throw new Error('Escribe una descripción.');
  const extra = mv.extra || {};
  let fee = 0;
  if (extra.commission !== undefined && extra.commission !== null && extra.commission !== '') {
    fee = round2(Number(extra.commission));
    if (!Number.isFinite(fee) || fee < 0) throw new Error('La comisión no es válida.');
    if (fee > 0 && mv.kind !== 'debit') throw new Error('La comisión bancaria solo aplica a débitos.');
  }
  return { date, desc, number: normalizeNumber(mv.number), kind: mv.kind, amount, fee, cols: extra.cols || null, dateStyle: mv.dateStyle || null };
}

function addAt(engine, L, a, st) {
  const sh = st.sh, sid = L.sid, bc = L.cols.balance;
  const [c0, c1] = L.entry;
  const r = st.nextRow;
  for (let c = c0; c <= c1; c++) if (!cellEmpty(engine, sh, r, c)) throw new Error('La fila ' + (r + 1) + ' ya tiene datos. Actualiza la pantalla e inténtalo otra vez.');
  const pb = engine.value(sid, r - 1, bc);
  const balanceBefore = typeof pb === 'number' ? pb : null;

  // punteros y plantilla: se mueven solo si los datos se acercan, y la plantilla se extiende si quedan pocas filas
  const ptrs = L.pointers.map((p) => ({ p, ...readPointer(engine, L, p) }));
  const movers = ptrs.filter((x) => x.row !== null && x.row - r < POINTER_MARGIN);
  const maxOff = movers.reduce((m, x) => Math.max(m, x.p.offset || 0), 0);
  const neededFree = Math.max(L.templateMinFree, movers.length ? maxOff + POINTER_MARGIN : 0);
  let ext = null;
  if (st.templateEnd - r < neededFree || st.templateEnd < r) {
    ext = planExtension(engine, L, sh, st.templateEnd, Math.max(L.extendBy, neededFree - (st.templateEnd - r) + 10));
    if (st.templateEnd < r && (!ext || ext.to < r)) throw new Error('No se pudo preparar la fórmula de saldo en la fila ' + (r + 1) + ' (hay celdas ocupadas debajo).');
  }
  const newEnd = ext ? ext.to : st.templateEnd;
  const pmoves = [];
  for (const x of movers) {
    const target = Math.max(r, newEnd - (x.p.offset || 0));
    if (target === x.row) continue;
    const next = movePointerRaw(L, x.raw, target);
    if (next !== x.raw) pmoves.push({ r: x.p.r, c: x.p.c, before: x.raw, after: next, from: x.row, to: target });
  }

  // celdas de entrada de la fila
  const vals = new Array(c1 - c0 + 1).fill(null);
  const used = new Set([bc, L.cols.date, L.cols.desc]);
  const put = (c, v) => { vals[c - c0] = v; };
  put(L.cols.date, a.date); put(L.cols.desc, a.desc);
  if (a.number !== null) { put(L.cols.number, a.number); used.add(L.cols.number); }
  const pk = L.put[a.kind];
  put(pk.col, round2(pk.sign * a.amount)); used.add(pk.col);
  const amountCols = [pk.col];
  if (a.fee > 0) { put(L.put.fee.col, round2(L.put.fee.sign * a.fee)); used.add(L.put.fee.col); amountCols.push(L.put.fee.col); }
  if (a.cols) for (const [letter, v] of Object.entries(a.cols)) {
    const c = colIndex(letter);
    if (c < c0 || c > c1 || used.has(c)) throw new Error('Columna no permitida: ' + letter);
    put(c, v);
  }

  const rowsBefore = sh.rows, colsBefore = sh.cols;
  const changes = runBatch(engine, (w) => {
    if (ext) w.setMatrix(sid, ext.from, bc, ext.formulas);
    w.setMatrix(sid, r, c0, [vals]);
    for (const m of pmoves) w.set(sid, m.r, m.c, m.after);
  });

  const styleOps = [];
  const setSt = (rr, c, id) => { const prev = sh.styleAt(rr, c); if (prev !== id) { styleOps.push([rr, c, prev]); sh.setStyle(rr, c, id); } };
  if (ext) for (let rr = ext.from; rr <= ext.to; rr++) copyRowStyles(sh, st.templateEnd, rr, bc, setSt);
  setSt(r, L.cols.date, dateStyleIdFor(engine, L, sh, r, a.date, a.dateStyle));
  for (const c of amountCols) setSt(r, c, amountStyleFor(engine, L, sh, r, c));

  const av = engine.value(sid, r, bc);
  const balanceAfter = typeof av === 'number' ? av : null;
  const net = a.kind === 'credit' ? a.amount : -(a.amount + a.fee);
  const expected = round2((balanceBefore || 0) + net);
  const j = journalOf(engine, L.id);
  j.push({ row: r, wrote: vals.map((v, i) => ({ c: c0 + i, after: v })).filter((x) => x.after !== null), styleOps, ext: ext ? { from: ext.from, to: ext.to, rowsBefore, colsBefore } : null, pointers: pmoves });
  if (j.length > 60) j.shift();
  st.lastRow = r; st.nextRow = r + 1; st.templateEnd = newEnd; st.templateLeft = Math.max(0, newEnd - r);
  return {
    ok: true, row: r, rowNumber: r + 1, date: a.date, kind: a.kind, amount: a.amount, fee: a.fee, net,
    changes, balanceBefore, balanceAfter, delta: balanceAfter === null || balanceBefore === null ? null : round2(balanceAfter - balanceBefore),
    extended: ext ? { from: ext.from, to: ext.to, count: ext.count, clamped: ext.clamped } : null,
    pointers: pmoves.map((m) => ({ a1: a1(m.r, m.c), from: m.from, to: m.to, before: m.before, after: m.after })),
    check: { expected, actual: balanceAfter, ok: balanceAfter !== null && Math.abs(balanceAfter - expected) < 0.005 },
  };
}

/** Agrega un movimiento en la primera fila libre. mv = {date, desc, number?, kind:'credit'|'debit', amount, extra?}.
 *  extra: {commission?: número>0 (solo débitos; se anota como importe negativo en la columna de comisión),
 *          cols?: {D: valor}} columnas de entrada adicionales.  mv.dateStyle: 'month' | 'exact' (por defecto, automático).
 *  Escribe SOLO celdas de entrada; la fórmula de saldo ya existe (si no, se crea con la plantilla de la cuenta). */
export function addMovement(engine, id, mv) {
  const L = need(id);
  const a = normalizeMovement(L, mv);
  return addAt(engine, L, a, scan(engine, L));
}

/** Quita el último movimiento: vacía las celdas de entrada y deja la fórmula. Si lo registró addMovement en esta
 *  sesión, restaura también estilos, plantilla y punteros. opts.row: solo si ese es el último (evita deshacer otro);
 *  opts.force: no verificar que nadie modificó la fila. -> {ok, ...} | {ok:false, reason, message} */
export function removeLastMovement(engine, id, opts = {}) {
  const L = need(id);
  const st = scan(engine, L);
  const sid = L.sid, bc = L.cols.balance, sh = st.sh;
  if (st.lastRow < 0) return { ok: false, reason: 'empty', message: 'No hay movimientos.' };
  if (opts.row !== undefined && opts.row !== null && opts.row !== st.lastRow) return { ok: false, reason: 'not-last', lastRow: st.lastRow, message: 'Ya hay movimientos más recientes: no se puede deshacer este.' };
  const row = st.lastRow, [c0, c1] = L.entry;
  const jr = journalOf(engine, L.id), j = jr.length ? jr[jr.length - 1] : null;
  const useJ = !!j && j.row === row;
  if (j && !useJ) jr.length = 0;
  const same = (x, y) => (typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) < 1e-9 : x === y);
  if (useJ && !opts.force) {
    const wroteCols = new Set(j.wrote.map((w) => w.c));
    const touched = j.wrote.some((w) => !same(engine.raw(sid, row, w.c), w.after)) || (() => { for (let c = c0; c <= c1; c++) if (!wroteCols.has(c) && !cellEmpty(engine, sh, row, c)) return true; return false; })();
    if (touched) return { ok: false, reason: 'modified', message: 'Esa fila se modificó después de guardarla; revísala en la hoja.' };
  }
  const balanceBefore = numOr0(engine.value(sid, row, bc));
  let extIntact = false;
  if (useJ && j.ext) {
    extIntact = true;
    for (let r = j.ext.from; r <= j.ext.to && extIntact; r++) {
      if (!hasFormula(engine, sh, r, bc)) { extIntact = false; break; }
      for (let c = c0; c <= c1; c++) if (!cellEmpty(engine, sh, r, c)) { extIntact = false; break; }
    }
  }
  const changes = runBatch(engine, (w) => {
    w.clear(sid, row, c0, row, c1);
    if (useJ) {
      for (let i = j.pointers.length - 1; i >= 0; i--) w.set(sid, j.pointers[i].r, j.pointers[i].c, j.pointers[i].before);
      if (j.ext && extIntact) w.clear(sid, j.ext.from, bc, j.ext.to, bc);
    }
  });
  if (useJ) {
    for (let i = j.styleOps.length - 1; i >= 0; i--) { const [rr, c, prev] = j.styleOps[i]; sh.setStyle(rr, c, prev); }
    if (j.ext && extIntact) { sh.rows = j.ext.rowsBefore; sh.cols = j.ext.colsBefore; }
    jr.pop();
  }
  const av = engine.value(sid, row, bc);
  return { ok: true, row, rowNumber: row + 1, changes, balanceBefore, balanceAfter: typeof av === 'number' ? av : null, restored: useJ };
}

/** Foto de las celdas de entrada de una fila (valores crudos y estilos), para deshacer una edición. */
export function snapshotRow(engine, id, row) {
  const L = need(id), sh = sheetOf(engine, L), [c0, c1] = L.entry, cells = [];
  for (let c = c0; c <= c1; c++) cells.push({ c, raw: engine.raw(L.sid, row, c), style: sh.styleAt(row, c) });
  return { id: L.id, row, cells };
}
export function restoreSnapshot(engine, id, snap) {
  const L = need(id), sh = sheetOf(engine, L);
  const changes = runBatch(engine, (w) => { for (const x of snap.cells) w.set(L.sid, snap.row, x.c, x.raw); });
  for (const x of snap.cells) sh.setStyle(snap.row, x.c, x.style);
  return { ok: true, row: snap.row, changes };
}

/** Edita campos de una fila. fields: {date?, desc?, number?, kind?, amount?, fee?, dateStyle?}. Solo escribe lo indicado.
 *  Cambiar tipo/monto/comisión reescribe las columnas de importe de esa fila; se rechaza si alguna es una fórmula
 *  o si la fila mezcla débito y crédito (editarla en la hoja). */
export function updateMovement(engine, id, row, fields = {}) {
  const L = need(id), sh = sheetOf(engine, L), sid = L.sid, bc = L.cols.balance;
  if (!Number.isInteger(row) || row < L.firstDataRow || row >= Math.max(sh.rows, row + 1)) throw new Error('Fila no válida.');
  const snapshot = snapshotRow(engine, L.id, row);
  const writes = [];     // [col, valor]
  const styleOps = [];
  if ('date' in fields) {
    if (fields.date === null || fields.date === '') writes.push([L.cols.date, null]);
    else { const d = toSerialDate(fields.date); if (!isPlausibleSerial(d)) throw new Error('La fecha no es válida.'); writes.push([L.cols.date, d]); styleOps.push(['date', d]); }
  }
  if ('desc' in fields) { let d = clean(fields.desc); if (d[0] === '=') d = d.replace(/^=+\s*/, ''); if (!d) throw new Error('Escribe una descripción.'); writes.push([L.cols.desc, d]); }
  if ('number' in fields) writes.push([L.cols.number, normalizeNumber(fields.number)]);
  if ('kind' in fields || 'amount' in fields || 'fee' in fields) {
    const terms = termsAt(engine, L, row), s = sums(terms);
    if (terms.some((t) => t.formula)) return { ok: false, reason: 'formula', message: 'El monto de esta fila es una fórmula; edítala en la hoja para no perderla.' };
    const p = principalOf(s.debit, s.credit);
    if (!p && !(terms.every((t) => t.blank))) return { ok: false, reason: 'mixed', message: 'Esta fila mezcla débito y crédito; edítala en la hoja.' };
    const kind = fields.kind || (p ? p.kind : 'debit');
    let amount = 'amount' in fields ? round2(Number(fields.amount)) : (p ? p.amount : NaN);
    let fee = 'fee' in fields ? round2(Number(fields.fee || 0)) : (p ? p.fee : 0);
    if (kind === 'credit') fee = 0;
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('El monto debe ser mayor que cero.');
    if (!Number.isFinite(fee) || fee < 0) throw new Error('La comisión no es válida.');
    const next = new Map(terms.map((t) => [t.col, null]));
    next.set(L.put[kind].col, round2(L.put[kind].sign * amount));
    if (fee > 0) next.set(L.put.fee.col, round2(L.put.fee.sign * fee));
    for (const [c, v] of next) writes.push([c, v]);
    styleOps.push(['amount', [...next.keys()]]);
  }
  const prevB = engine.value(sid, row, bc), balanceBefore = typeof prevB === 'number' ? prevB : null;
  const changes = runBatch(engine, (w) => { for (const [c, v] of writes) w.set(sid, row, c, v); });
  for (const op of styleOps) {
    if (op[0] === 'date') sh.setStyle(row, L.cols.date, dateStyleIdFor(engine, L, sh, row, op[1], fields.dateStyle || null));
    else for (const c of op[1]) { if (!cellEmpty(engine, sh, row, c)) sh.setStyle(row, c, amountStyleFor(engine, L, sh, row, c)); }
  }
  const av = engine.value(sid, row, bc);
  return { ok: true, row, rowNumber: row + 1, changes, snapshot, balanceBefore, balanceAfter: typeof av === 'number' ? av : null };
}

/* ===================================================================== 6. texto del banco: lectura, duplicados e importación */

const HEADER_ROLES = [
  ['date', /^fecha/], ['debit', /(debito|retiro|cargo|egreso|salida)/], ['credit', /(credito|deposito|abono|ingreso|entrada)/],
  ['value', /^(valor|monto|importe)/], ['balance', /saldo/], ['number', /(^n(umero|ro|°|º|\.)|documento|^doc\b|cheque|comprobante|secuencial)/],
  ['desc', /(descrip|concepto|detalle|referencia|glosa|movimiento|observ)/],
];
function detectHeader(fields) {
  const h = { n: fields.length }; let roles = 0;
  fields.forEach((f, i) => {
    const t = normDesc(f);
    if (!t) return;
    for (const [role, re] of HEADER_ROLES) if (re.test(t)) { if (h[role] === undefined) { h[role] = i; roles++; } return; }
  });
  return roles >= 2 && (h.date !== undefined || h.debit !== undefined || h.credit !== undefined || h.value !== undefined) ? h : null;
}
function splitCsv(line, delim) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function mergeThousands(fields) {            // "1","234.50" separados por una coma de miles -> "1,234.50"
  const out = [];
  for (const f of fields) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /^\(?[\-+]?\s*(?:\$\s*)?\d{1,3}$/.test(prev) && /^\d{3}(?:\.\d+)?\)?$/.test(f)) out[out.length - 1] = prev + ',' + f;
    else out.push(f);
  }
  return out;
}
const isDateField = (f) => /\d/.test(f) && parseLooseDate(f) !== null;
function splitFields(line) {
  if (line.includes('\t')) return { mode: 'tab', fields: line.split('\t').map((s) => s.trim()) };
  if (line.includes(';')) return { mode: 'semi', fields: splitCsv(line, ';') };
  if (line.includes('|')) return { mode: 'pipe', fields: line.split('|').map((s) => s.trim()) };
  if (line.includes('"') && line.includes(',')) return { mode: 'csv', fields: mergeThousands(splitCsv(line, ',')) };
  if (line.includes(',')) { const f = mergeThousands(line.split(',').map((s) => s.trim())); if (f.length >= 3 && isDateField(f[0])) return { mode: 'csv', fields: f }; }
  const gap = line.split(/\s{2,}/).map((s) => s.trim()).filter((s) => s !== '');
  if (gap.length >= 3) return { mode: 'gap', fields: gap };
  return { mode: 'space', fields: line.split(/\s+/).filter(Boolean) };
}
const isWeakInt = (f) => /^\d{1,12}$/.test(f);
const strongMoney = (f) => { const m = f === '' ? null : parseMoney(f); return !!(m && m.strong); };
const DATE_ANYWHERE = /(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2}(?!\d))/;

/** Interpreta una línea: {date, desc, number, debit, credit, uncertain} | {error}. */
function interpretLine(sp, header, flags) {
  const { mode } = sp;
  let fields = sp.fields.slice();
  const get = (i) => (i !== undefined && i !== null && i < fields.length ? fields[i] : '');
  // 1) con encabezado alineado: columnas por posición
  if (header && mode !== 'space' && fields.length === header.n && header.date !== undefined) {
    const date = parseLooseDate(get(header.date));
    if (date !== null) {
      let debit = 0, credit = 0, uncertain = false;
      if (header.debit !== undefined || header.credit !== undefined) {
        const d = parseMoney(get(header.debit)), c = parseMoney(get(header.credit));
        debit = d ? Math.abs(d.value) : 0; credit = c ? Math.abs(c.value) : 0;
      } else if (header.value !== undefined) {
        const m = parseMoney(get(header.value));
        if (m) { if (m.negative) debit = Math.abs(m.value); else { credit = m.value; if (!m.strong || !/[+]/.test(get(header.value))) { uncertain = true; flags.unsigned = true; } } }
      }
      const used = new Set([header.date, header.debit, header.credit, header.value, header.balance, header.number]);
      const desc = header.desc !== undefined ? get(header.desc) : fields.filter((f, i) => !used.has(i) && f).join(' ');
      const nm = header.number !== undefined ? get(header.number) : '';
      return { date, desc: clean(desc), number: nm || null, debit, credit, uncertain };
    }
  }
  // 2) heurística sin encabezado
  let di = fields.findIndex(isDateField), date = null;
  if (di >= 0) date = parseLooseDate(fields[di]);
  else {
    for (let i = 0; i < fields.length && date === null; i++) {
      const m = DATE_ANYWHERE.exec(fields[i]);
      if (m && parseLooseDate(m[1]) !== null) { date = parseLooseDate(m[1]); fields[i] = clean(fields[i].replace(m[1], ' ')); di = i; }
    }
  }
  if (date === null) return { error: 'sin fecha' };
  const allowBlank = mode !== 'space';
  let k0 = fields.length, taken = 0;
  for (let i = fields.length - 1; i >= 0 && taken < 3; i--) {          // bloque final de importes: a lo sumo 3 columnas
    if (i === di) break;
    const f = fields[i];
    if (f === '' ? allowBlank : !!parseMoney(f)) { k0 = i; taken++; } else break;
  }
  let block = fields.slice(k0);
  let number = null;
  while (block.length > 1 && isWeakInt(block[0]) && block.slice(1).some(strongMoney)) { number = number || block.shift(); k0++; }
  while (block.length > 1 && block[0] === '' && block[1] === '' ) { block.shift(); k0++; }
  let debit = 0, credit = 0, uncertain = false;
  const val = (f) => (f === '' ? null : parseMoney(f));
  if (block.length === 0) return { error: 'sin importe' };
  if (block.length === 1) {
    const m = val(block[0]);
    if (!m) return { error: 'sin importe' };
    if (m.negative) debit = Math.abs(m.value); else { credit = m.value; if (!/^\+/.test(block[0])) { uncertain = true; flags.unsigned = true; } }
  } else if (block.length === 2) {
    const a = val(block[0]), b = val(block[1]);
    if (!a || !b || a.value === 0 || b.value === 0) { debit = a ? Math.abs(a.value) : 0; credit = b ? Math.abs(b.value) : 0; }
    else if (a.negative || !b.negative) { if (a.negative) debit = Math.abs(a.value); else { credit = a.value; uncertain = true; flags.unsigned = true; } }   // valor + saldo
    else { debit = Math.abs(a.value); credit = Math.abs(b.value); }
  } else {
    const a = val(block[0]), b = val(block[1]), c = val(block[2]);
    if ((!a || a.value === 0) && (!b || b.value === 0) && c) { if (c.negative) debit = Math.abs(c.value); else { credit = c.value; uncertain = true; flags.unsigned = true; } }
    else { debit = a ? Math.abs(a.value) : 0; credit = b ? Math.abs(b.value) : 0; }          // débito | crédito | saldo
  }
  const rest = fields.slice(0, k0).filter((f, i) => i !== di && f !== '');
  if (!number && rest.length > 1 && isWeakInt(rest[0]) && rest[0].length >= 3 && di === 0) number = rest.shift();
  else if (!number && fields[di + 1] !== undefined && di + 1 < k0 && isWeakInt(fields[di + 1]) && fields[di + 1].length >= 3 && rest.length > 1) { number = fields[di + 1]; rest.splice(rest.indexOf(number), 1); }
  return { date, desc: clean(rest.join(' ')), number, debit: round2(debit), credit: round2(credit), uncertain };
}

/** Texto pegado del portal del banco -> {rows:[{date, desc, number, debit, credit, line, uncertain}], warnings:[]}.
 *  Separadores: tabulador, ; | , o 2+ espacios (o espacios simples). Fechas dd/mm/aaaa, aaaa-mm-dd, "13 nov 2026".
 *  Importes con $, comas de miles, paréntesis o signo negativo. Con una sola columna de importe, el signo decide
 *  (negativo = débito); con dos o tres, se toman como Débito | Crédito | (Saldo). Los encabezados se reconocen por nombre. */
export function parsePastedMovements(text, id) {
  const warnings = [], rows = [], flags = {};
  if (id !== undefined && id !== null && !getLedger(id)) warnings.push('Cuenta desconocida: ' + id);
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let header = null, skipped = 0;
  lines.forEach((line0, i) => {
    const line = line0.replace(/ /g, ' ').replace(/^ +/, '').replace(/ +$/, '');   // no se recortan tabuladores: una celda vacía al final importa (Débito | Crédito)
    if (!line.trim()) return;
    const n = i + 1, sp = splitFields(line);
    const hasDate = sp.fields.some(isDateField) || DATE_ANYWHERE.test(line);
    if (!hasDate) {
      const h = !header ? detectHeader(sp.mode === 'space' ? [] : sp.fields) : null;
      if (h) header = h; else { skipped++; if (skipped <= 6) warnings.push('Línea ' + n + ': no tiene fecha, se omitió.'); }
      return;
    }
    const r = interpretLine(sp, header, flags);
    if (r.error) { skipped++; if (skipped <= 6) warnings.push('Línea ' + n + ': ' + (r.error === 'sin importe' ? 'no se encontró el importe' : 'no se entendió la fecha') + ', se omitió.'); return; }
    if (r.debit === 0 && r.credit === 0) { skipped++; if (skipped <= 6) warnings.push('Línea ' + n + ': el importe es cero, se omitió.'); return; }
    rows.push({ date: r.date, desc: r.desc, number: r.number, debit: r.debit, credit: r.credit, line: n, uncertain: !!r.uncertain });
  });
  if (skipped > 6) warnings.push('…y ' + (skipped - 6) + ' línea(s) más omitidas.');
  if (flags.unsigned) warnings.push('Hay importes sin signo en una sola columna: se tomaron como créditos. Revisa el tipo en la vista previa.');
  return { rows, warnings };
}

function sameDayFor(L, monthDates) { return monthDates ? (a, b) => monthStart(a) === monthStart(b) : (a, b) => a === b; }
/** Compara filas por importar con lo ya registrado. -> [{status:'new'|'duplicate'|'similar', matchRow?}] en el mismo orden.
 *  duplicate = misma fecha (o mes, en cuentas por mes) + mismo importe + misma descripción normalizada, en las filas
 *  de los últimos ~90 días; similar = misma fecha e importe con otra descripción (¿ya lo tecleaste con otras palabras?). */
export function analyzeImport(engine, id, rows, { monthDates = null } = {}) {
  const L = need(id), sh = sheetOf(engine, L);
  const month = monthDates === null ? L.dateMode === 'month' : monthDates;
  const same = sameDayFor(L, month);
  const items = rows.map((x) => ({ date: x.date, cents: Math.round(round2(numOr0(x.credit) - numOr0(x.debit)) * 100), key: normDesc(x.desc) }));
  const dates = items.map((x) => x.date).filter(isPlausibleSerial);
  const out = items.map(() => ({ status: 'new' }));
  if (!dates.length) return out;
  const lo = Math.min(...dates) - 90, hi = Math.max(...dates) + 31;
  const byCents = new Map();
  let older = 0;
  for (let r = lastEntryRow(engine, L, sh), n = 0; r >= L.firstDataRow && n < 2500; r--, n++) {
    const d = engine.value(L.sid, r, L.cols.date);
    if (typeof d !== 'number') continue;
    if (d < lo) { if (++older > 150) break; continue; }
    older = 0;
    if (d > hi) continue;
    const net = netAt(engine, L, r);
    if (net === 0) continue;
    const key = Math.round(net * 100);
    const desc = engine.value(L.sid, r, L.cols.desc);
    let a = byCents.get(key); if (!a) { a = []; byCents.set(key, a); }
    a.push({ row: r, date: d, key: normDesc(typeof desc === 'string' ? desc : ''), used: false });
  }
  items.forEach((it, i) => {
    if (!isPlausibleSerial(it.date)) return;
    const c = byCents.get(it.cents) || [];
    const dup = c.find((e) => !e.used && same(e.date, it.date) && e.key === it.key);
    if (dup) { dup.used = true; out[i] = { status: 'duplicate', matchRow: dup.row }; return; }
    const sim = c.find((e) => !e.used && same(e.date, it.date));
    if (sim) out[i] = { status: 'similar', matchRow: sim.row };
  });
  return out;
}

/** Importa filas {date, desc, number, debit, credit}. Un extracto "más nuevo primero" se invierte para que la hoja
 *  quede en orden cronológico. skipDuplicates (por defecto sí): omite los duplicados estrictos de analyzeImport.
 *  monthDates: guardar el día 1 del mes (por defecto, según la cuenta). -> {added, skipped, invalid, rows, ...} */
export function importMovements(engine, id, rows, { skipDuplicates = true, monthDates = null } = {}) {
  const L = need(id);
  const month = monthDates === null ? L.dateMode === 'month' : monthDates;
  const valid = []; let invalid = 0;
  for (const x of rows || []) {
    const date = toSerialDate(x && x.date);
    const amount = round2(numOr0(x && x.credit) - numOr0(x && x.debit));
    if (!isPlausibleSerial(date) || !Number.isFinite(amount) || amount === 0) { invalid++; continue; }
    valid.push({ date, desc: clean(x.desc) || 'Movimiento bancario', number: x.number, amount });
  }
  const verdicts = analyzeImport(engine, id, valid.map((v) => ({ date: v.date, desc: v.desc, debit: v.amount < 0 ? -v.amount : 0, credit: v.amount > 0 ? v.amount : 0 })), { monthDates: month });
  const skippedRows = [];
  let todo = [];
  valid.forEach((v, i) => { if (skipDuplicates && verdicts[i].status === 'duplicate') skippedRows.push({ desc: v.desc, date: v.date, matchRow: verdicts[i].matchRow }); else todo.push(v); });
  const dated = todo.filter((v) => isPlausibleSerial(v.date));
  if (dated.length > 1 && dated[0].date > dated[dated.length - 1].date) todo = todo.reverse();
  todo = todo.map((v, i) => ({ v, i })).sort((p, q) => p.v.date - q.v.date || p.i - q.i).map((p) => p.v);
  const st = scan(engine, L);
  const addedRows = [], changes = [];
  let balanceBefore = null, balanceAfter = null, error = null;
  try {
    for (const v of todo) {
      const a = normalizeMovement(L, { date: month ? monthStart(v.date) : v.date, desc: v.desc, number: v.number, kind: v.amount > 0 ? 'credit' : 'debit', amount: Math.abs(v.amount), dateStyle: month ? 'month' : 'exact' });
      const res = addAt(engine, L, a, st);
      if (balanceBefore === null) balanceBefore = res.balanceBefore;
      balanceAfter = res.balanceAfter; addedRows.push(res.row); changes.push(...res.changes);
    }
  } catch (e) { error = e.message || String(e); }
  return { ok: !error, error, added: addedRows.length, skipped: skippedRows.length, invalid, rows: addedRows, skippedRows, changes, balanceBefore, balanceAfter };
}

/* ===================================================================== 7. pantalla */

let UID = 0;
const nid = (p) => 'lg-' + p + '-' + (++UID);
const KIND_LABEL = { credit: 'Crédito', debit: 'Débito' };
const PAGE = 30;

/** Pantalla "Movimientos". host = contenedor; ctx = contexto de la app (engine, changed, openSheet, toast, confirm, modal, ui, today). */
export function mount(host, ctx, { ledgerId = null } = {}) {
  const U = ctx.ui || UI, el = U.el, money = U.money;
  const engine = ctx.engine;
  const today = () => (typeof ctx.today === 'function' ? ctx.today() : todaySerial());
  const st = { L: null, info: null, items: [], more: false, index: null, destroyed: false, error: null, lastKind: null };
  const timers = new Set(), modals = new Set(), listeners = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!st.destroyed) fn(); }, ms); timers.add(t); return t; };
  const setKids = (node, ...kids) => { node.textContent = ''; node.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false)); };
  const signed = (n) => money(n, { sign: true });
  /** Mantiene el foco del teclado dentro de la hoja abierta (Tab y Mayús+Tab dan la vuelta). */
  const trapFocus = (box) => box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll('button, [href], input, select, textarea, summary')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  const root = el('div', { class: 'lg-root' });
  const chipsEl = el('div', { class: 'chips lg-chips', role: 'radiogroup', 'aria-label': 'Cuenta bancaria' });
  const cardId = nid('card'), listId = nid('list');
  const cardEl = el('section', { class: 'card lg-card', 'aria-labelledby': cardId });
  const listEl = el('section', { class: 'card lg-listcard', 'aria-labelledby': listId });
  const addBtn = el('button', { type: 'button', class: 'btn primary lg-add', 'aria-label': 'Nuevo movimiento', onclick: () => openForm({ mode: 'add' }) }, el('span', { 'aria-hidden': 'true', class: 'lg-plus', text: '+' }), ' Movimiento');
  const pasteBtn = el('button', { type: 'button', class: 'btn lg-paste', 'aria-label': 'Pegar texto del banco', title: 'Pegar texto del banco', onclick: () => openPaste() },
    el('span', { class: 'lg-ico', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M8.5 12h7M8.5 16h4.5"/></svg>' }),
    el('span', { class: 'lg-paste-short', 'aria-hidden': 'true', text: 'Pegar' }), el('span', { class: 'lg-paste-long', 'aria-hidden': 'true', text: 'Pegar texto del banco' }));
  const barEl = el('div', { class: 'lg-bar' }, addBtn, pasteBtn);
  root.append(chipsEl, cardEl, listEl, barEl);
  host.append(root);

  /* ---------- carga y dibujo ---------- */
  function load() {
    if (st.destroyed || !st.L) return;
    try {
      st.info = ledgerInfo(engine, st.L.id, { today: today() });
      st.items = listMovements(engine, st.L.id, { limit: PAGE });
      st.more = st.items.length === PAGE && listMovements(engine, st.L.id, { limit: 1, before: st.items[st.items.length - 1].row }).length > 0;
      st.error = null;
    } catch (e) { console.error('[ledger]', e); st.error = e; }
    st.index = null;
    renderCard(); renderList();
    listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } });
  }
  let pending = false;
  function refresh() { if (st.destroyed || pending) return; pending = true; queueMicrotask(() => { pending = false; load(); }); }
  const getIndex = () => st.index || (st.index = descriptionIndex(engine, st.L.id, { lastRow: st.info ? st.info.lastRow : null }));

  function select(id, { fromUser = false } = {}) {
    const L = getLedger(id) || LEDGERS.gye;
    if (st.L && st.L.id === L.id && st.info) return;
    st.L = L; st.items = []; st.info = null; st.index = null;
    if (fromUser) { try { localStorage.setItem('fx-ledger', L.id); } catch (e) { /* sin almacenamiento */ } try { history.replaceState(null, '', '#/mov/' + L.id); } catch (e) { /* no pasa nada */ } }
    renderChips(); load();
    later(() => { const on = chipsEl.querySelector('.chip.on'); if (on && on.scrollIntoView) { try { on.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) { /* navegador sin opciones */ } } }, 0);
  }

  function renderChips() {
    const defs = listLedgers();
    setKids(chipsEl, defs.map((d) => {
      const on = st.L && d.id === st.L.id;
      const b = el('button', {
        type: 'button', class: 'chip' + (on ? ' on' : ''), role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', 'data-id': d.id,
        onclick: () => select(d.id, { fromUser: true }),
        onkeydown: (e) => {
          const i = defs.findIndex((x) => x.id === d.id);
          let j = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % defs.length;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i + defs.length - 1) % defs.length;
          if (j !== null) { e.preventDefault(); select(defs[j].id, { fromUser: true }); later(() => { const n = chipsEl.querySelector('[data-id="' + defs[j].id + '"]'); if (n) n.focus(); }, 0); }
        },
      }, d.chip);
      return b;
    }));
  }

  function renderCard() {
    const L = st.L, info = st.info;
    if (st.error) { setKids(cardEl, el('h2', { text: L.title }), el('p', { class: 'muted', text: 'No se pudo leer la cuenta: ' + (st.error.message || st.error) })); return; }
    if (!info) { setKids(cardEl, el('h2', { text: L ? L.title : '' }), el('p', { class: 'muted', text: 'Cargando…' })); return; }
    const m = info.month;
    const facts = el('dl', { class: 'lg-facts' });
    const fact = (label, ...body) => facts.append(el('div', { class: 'lg-fact' }, el('dt', { text: label }), el('dd', {}, ...body)));
    fact('Último movimiento', info.lastRow < 0 ? 'Sin movimientos' : [info.lastDateLabel || 'sin fecha', el('span', { class: 'muted', text: ' · fila ' + info.lastRowNumber })]);
    fact('Variación de ' + m.label, m.count ? [el('span', { class: m.amount < 0 ? 'neg' : (m.amount > 0 ? 'pos' : ''), text: signed(m.amount) }), el('span', { class: 'muted', text: ' · ' + m.count + (m.count === 1 ? ' movimiento' : ' movimientos') })] : [el('span', { class: 'muted', text: 'Sin movimientos este mes' })]);
    for (const p of info.pointers) for (const cn of p.consumers) if (cn.value !== null) fact(cn.label, money(cn.value));
    setKids(cardEl,
      el('div', { class: 'lg-card-head' }, el('h2', { id: cardId, text: info.title }), el('span', { class: 'badge', text: 'Hoja ' + info.sheetName })),
      el('div', { class: 'kpi lg-kpi' }, el('span', { class: 'l', text: 'Saldo actual' }), el('span', { class: 'v' + (info.balance !== null && info.balance < 0 ? ' neg' : ''), text: info.balance === null ? '—' : money(info.balance) })),
      facts,
      info.warnings.map((w) => el('div', { class: 'banner lg-banner', role: 'status', text: w })),
      info.templateRowsLeft < TEMPLATE_MIN_FREE ? el('p', { class: 'small muted lg-note', text: 'Quedan ' + info.templateRowsLeft + ' filas con saldo prellenado; al guardar se agregan más automáticamente.' }) : null,
      el('div', { class: 'row lg-links' }, el('button', { type: 'button', class: 'btn ghost lg-link', onclick: () => openInSheet(info.lastRow >= 0 ? info.lastRow : info.nextRow) }, 'Ver en la hoja')),
    );
  }

  function openInSheet(row) { if (ctx.openSheet) ctx.openSheet(st.L.sid, { r: row, c: st.L.cols.desc }); }

  function rowButton(mv) {
    const cls = mv.amount < 0 ? 'neg' : (mv.amount > 0 ? 'pos' : '');
    const meta = [mv.dateLabel || 'sin fecha'];
    if (mv.number !== null && mv.number !== '') meta.push('N.º ' + mv.number);
    const label = (mv.kind === 'debit' ? 'Débito ' : 'Crédito ') + money(Math.abs(mv.amount)) + ', ' + (mv.desc || 'sin descripción') + ', ' + (mv.dateLabel || 'sin fecha') + '. Tocar para editar.';
    return el('li', {}, el('button', { type: 'button', class: 'lg-row', 'aria-label': label, onclick: () => openForm({ mode: 'edit', movement: mv }) },
      el('span', { class: 'grow' },
        el('span', { class: 't', text: mv.desc || '(sin descripción)' }),
        el('span', { class: 's' }, meta.join(' · '), mv.hasFormula ? el('span', { class: 'badge lg-tag', text: 'fórmula' }) : null, mv.dateIsText ? el('span', { class: 'badge lg-tag', text: 'fecha en texto' }) : null)),
      el('span', { class: 'lg-side' }, el('span', { class: 'lg-amt num ' + cls, text: signed(mv.amount) }), el('span', { class: 'lg-bal num', text: mv.balance === null ? '' : money(mv.balance) }))));
  }
  function renderList() {
    if (!st.info) { setKids(listEl); return; }
    const ul = el('ul', { class: 'list lg-list' });
    for (const mv of st.items) ul.append(rowButton(mv));
    setKids(listEl,
      el('div', { class: 'lg-listhead' }, el('h2', { id: listId, text: 'Últimos movimientos' }), el('span', { class: 'small muted', text: 'Toca uno para editarlo' })),
      st.items.length ? ul : el('p', { class: 'empty', text: 'Esta cuenta todavía no tiene movimientos.' }),
      st.more ? el('div', { class: 'row lg-morerow' }, el('button', { type: 'button', class: 'btn', onclick: moreItems }, 'Ver más movimientos')) : null);
  }
  function moreItems() {
    if (!st.items.length) return;
    const next = listMovements(engine, st.L.id, { limit: PAGE, before: st.items[st.items.length - 1].row });
    st.items = st.items.concat(next);
    st.more = next.length === PAGE && listMovements(engine, st.L.id, { limit: 1, before: st.items[st.items.length - 1].row }).length > 0;
    renderList();
  }

  /* ---------- avisos con "Deshacer" ---------- */
  function toastUndo(text, undo) {
    let used = false;
    const btn = el('button', { type: 'button', class: 'lg-toast-btn', text: 'Deshacer', onclick: () => { if (used) return; used = true; btn.disabled = true; undo(); } });
    ctx.toast(el('span', { class: 'lg-toast' }, text, ' ', btn), { type: 'ok', ms: 9000 });
  }
  function undoRows(rows, label) {
    let ok = 0, msg = null;
    for (const row of rows.slice().reverse()) { const r = removeLastMovement(engine, st.L.id, { row }); if (!r.ok) { msg = r.message; break; } ok++; }
    if (ok) ctx.changed([st.L.sid]);
    if (msg) ctx.toast(msg + (ok ? ' (se deshicieron ' + ok + ')' : ''), { type: 'warn', ms: 6000 });
    else ctx.toast(label, { ms: 2500 });
  }

  /* ---------- formulario: nuevo movimiento / editar ---------- */
  function openForm({ mode = 'add', movement = null } = {}) {
    const L = st.L, info = st.info;
    if (!info) return;
    const edit = mode === 'edit';
    const ids = { amount: nid('amount'), desc: nid('desc'), date: nid('date'), num: nid('num'), fee: nid('fee'), month: nid('month') };
    const p = edit ? movement.principal : null;
    const locked = edit && (!p || movement.hasFormula);            // fila con fórmulas o mixta: solo fecha, descripción y número
    let kind = edit ? (p ? p.kind : movement.kind) : (st.lastKind || 'debit');
    let submitted = false, kindTouched = false, dateTouched = !edit, liveText = '';
    const initDate = edit ? (movement.date !== null && !movement.dateIsText ? movement.date : null) : today();

    const seg = el('div', { class: 'seg lg-seg', role: 'radiogroup', 'aria-labelledby': ids.amount + '-t' });
    const kindBtn = (k, hint) => el('button', {
      type: 'button', role: 'radio', 'data-kind': k, disabled: locked, 'aria-checked': 'false',
      onclick: () => setKind(k, true),
      onkeydown: (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setKind(k === 'debit' ? 'credit' : 'debit', true); (seg.querySelector('[data-kind="' + (k === 'debit' ? 'credit' : 'debit') + '"]') || {}).focus?.(); } },
    }, el('b', { text: KIND_LABEL[k] }), el('small', { text: hint }));
    seg.append(kindBtn('credit', 'entra dinero'), kindBtn('debit', 'sale dinero'));

    const amount = el('input', { id: ids.amount, type: 'text', inputmode: 'decimal', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '0.00', enterkeyhint: 'next', disabled: locked, 'aria-describedby': ids.amount + '-h' });
    const amountHint = el('div', { class: 'lg-hint', id: ids.amount + '-h' });
    const amountErr = el('div', { class: 'lg-err', role: 'alert' });
    const desc = el('input', { id: ids.desc, type: 'text', autocomplete: 'off', autocapitalize: 'sentences', maxlength: '80', enterkeyhint: 'done', placeholder: 'Ej.: Pago de servicios', 'aria-describedby': ids.desc + '-s' });
    const sugg = el('div', { class: 'lg-sugg', id: ids.desc + '-s', role: 'group', 'aria-label': 'Sugerencias de descripción' });
    const descHint = el('div', { class: 'lg-hint' });
    const descErr = el('div', { class: 'lg-err', role: 'alert' });
    const date = el('input', { id: ids.date, type: 'date', min: '1990-01-01', max: '2100-12-31', 'aria-describedby': ids.date + '-h' });
    const dateHint = el('div', { class: 'lg-hint', id: ids.date + '-h' });
    const dateErr = el('div', { class: 'lg-err', role: 'alert' });
    const monthChk = el('input', { id: ids.month, type: 'checkbox' });
    const num = el('input', { id: ids.num, type: 'text', autocomplete: 'off', maxlength: '40', placeholder: 'Opcional' });
    const fee = el('input', { id: ids.fee, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', disabled: locked });
    const feeErr = el('div', { class: 'lg-err', role: 'alert' });
    const preview = el('div', { class: 'lg-preview' });
    const live = el('div', { class: 'lg-sr', role: 'status', 'aria-live': 'polite' });       // anuncia el nuevo saldo al terminar de escribir el monto (no en cada tecla)
    const formErr = el('div', { class: 'lg-err lg-formerr', role: 'alert' });
    const saveBtn = el('button', { type: 'submit', class: 'btn primary lg-save' }, edit ? 'Guardar cambios' : 'Guardar');
    const againBtn = edit ? null : el('button', { type: 'button', class: 'btn lg-again', title: 'Guardar y agregar otro movimiento', onclick: () => submit(true) }, 'Guardar y otro');
    const delBtn = edit && info.lastRow === movement.row ? el('button', { type: 'button', class: 'btn danger lg-del', onclick: () => removeIt() }, 'Eliminar') : null;
    const sheetBtn = edit ? el('button', { type: 'button', class: 'btn ghost lg-link', onclick: () => { handle.close(); openInSheet(movement.row); } }, 'Ver en la hoja') : null;

    if (edit) {
      amount.value = String(p ? p.amount : Math.abs(movement.amount));
      if (p && p.fee > 0) fee.value = String(p.fee);
      desc.value = movement.desc; num.value = movement.number === null ? '' : String(movement.number);
      date.value = initDate !== null ? U.dateInputValue(initDate) : '';
      monthChk.checked = initDate !== null && fromSerial(initDate).d === 1 && L.dateMode === 'month';
    } else {
      date.value = U.dateInputValue(initDate);
      monthChk.checked = L.dateMode === 'month';
    }

    const monthRow = L.dateMode === 'month'
      ? el('div', { class: 'lg-check' }, monthChk, el('label', { for: ids.month, text: 'Guardar solo el mes (día 1)' }))
      : null;
    const monthNote = L.dateMode === 'month' ? el('div', { class: 'lg-hint', text: 'Esta cuenta guarda cada movimiento con el primer día del mes. Quita la marca para guardar el día exacto.' }) : null;
    const feeBox = el('div', { class: 'field lg-feebox' }, el('label', { for: ids.fee, text: 'Comisión bancaria' }), fee, feeErr, el('div', { class: 'lg-hint', text: 'Se anota en la misma fila como un importe negativo pequeño.' }));
    const more = el('details', { class: 'lg-more' }, el('summary', { text: 'Más opciones' }), feeBox);
    if (edit && p && p.fee > 0) more.open = true;

    /* --- estado --- */
    function setKind(k, user) {
      kind = k; if (user) kindTouched = true;
      seg.querySelectorAll('button').forEach((b) => { const on = b.dataset.kind === k; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
      feeBox.hidden = k !== 'debit' || locked;
      more.hidden = k !== 'debit' || locked;
      recalc();
    }
    function effectiveDate() {
      const d = U.serialFromInput(date.value);
      if (d === null) return null;
      return monthChk.checked && L.dateMode === 'month' ? monthStart(d) : d;
    }
    function recalc() {
      const am = evalAmount(amount.value);
      amountHint.textContent = am.ok && am.expression ? '= ' + money(am.value) : '';
      const f = kind === 'debit' && fee.value.trim() ? evalAmount(fee.value) : null;
      const feeV = f && f.ok ? f.value : 0;
      const base = st.info && st.info.balance !== null ? st.info.balance : null;
      liveText = '';
      if (locked) { setKids(preview, el('span', { class: 'muted', text: movement.hasFormula ? 'El monto de esta fila es una fórmula: edítalo en la hoja para no perderla.' : 'Esta fila mezcla débito y crédito: edita su monto en la hoja.' })); }
      else if (am.ok && am.value > 0 && base !== null) {
        const net = kind === 'credit' ? am.value : -(am.value + feeV);
        const from = edit ? base - movement.amount : base;
        liveText = 'Nuevo saldo ' + money(from + net) + '. ' + (net < 0 ? 'Sale ' : 'Entra ') + money(Math.abs(net)) + '.';
        setKids(preview,
          el('div', { class: 'lg-pv-line' }, el('span', { text: edit ? 'Saldo sin este movimiento' : 'Saldo actual' }), el('span', { class: 'num', text: money(from) })),
          el('div', { class: 'lg-pv-line' }, el('span', { text: kind === 'credit' ? 'Entra' : 'Sale' + (feeV ? ' (con comisión)' : '') }), el('span', { class: 'num ' + (net < 0 ? 'neg' : 'pos'), text: signed(net) })),
          el('div', { class: 'lg-pv-line lg-pv-new' }, el('span', { text: 'Nuevo saldo' }), el('span', { class: 'num', text: money(from + net) })));
      } else setKids(preview, el('span', { class: 'muted', text: 'Escribe el monto para ver el nuevo saldo.' }));
      const d = U.serialFromInput(date.value);
      if (d !== null && (dateTouched || !edit)) {
        const pd = previewDate(engine, L.id, d, { mode: monthChk.checked && L.dateMode === 'month' ? 'month' : 'exact', row: info.nextRow });
        dateHint.textContent = (monthChk.checked && L.dateMode === 'month' ? 'Se guardará como ' : 'Se guardará con la fecha exacta ') + pd.label + '.';
      } else dateHint.textContent = edit && initDate === null && movement.dateLabel ? 'La fecha de esta fila está en texto («' + movement.dateLabel + '»). Déjala vacía para no cambiarla.' : '';
    }
    function renderSugg() {
      let list = [];
      try { list = filterSuggestions(getIndex(), desc.value, 8); } catch (e) { console.warn(e); }
      const q = normDesc(desc.value);
      list = list.filter((t) => normDesc(t) !== q || list.length > 1);
      setKids(sugg, list.map((t) => el('button', { type: 'button', class: 'lg-sugg-btn', text: t, onclick: () => pick(t) })));
    }
    function pick(text) {
      desc.value = text; descErr.textContent = ''; desc.removeAttribute('aria-invalid');
      if (!edit && !amount.value.trim()) {
        let d = null; try { d = suggestionDetails(engine, L.id, text); } catch (e) { /* sin sugerencia */ }
        if (d) {
          if (!kindTouched) setKind(d.kind, false);
          amount.value = String(d.amount);
          if (d.number !== null && !num.value) num.value = String(d.number);
          descHint.textContent = 'Se rellenó con el último uso: ' + KIND_LABEL[d.kind] + ' ' + money(d.amount) + '. Cámbialo si hace falta.';
        }
      }
      renderSugg(); recalc();
      (amount.value.trim() ? desc : amount).focus();
    }
    const markErr = (input, box, msg) => { box.textContent = msg || ''; if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); return !!msg; };
    function validate() {
      let first = null;
      const bad = (input, box, msg) => { if (markErr(input, box, msg) && !first) first = input; };
      const am = evalAmount(amount.value);
      if (!locked) bad(amount, amountErr, am.ok ? (am.value > 0 ? '' : 'El monto debe ser mayor que cero.') : (am.error || 'Monto no válido.'));
      bad(desc, descErr, clean(desc.value) ? '' : 'Escribe una descripción.');
      const d = U.serialFromInput(date.value);
      bad(date, dateErr, (d === null && (!edit || dateTouched)) && !(edit && initDate === null && !date.value) ? 'Elige una fecha válida.' : '');
      if (!locked && kind === 'debit' && fee.value.trim()) { const f = evalAmount(fee.value); bad(fee, feeErr, f.ok && f.value >= 0 ? '' : 'La comisión no es válida.'); if (first === fee) more.open = true; } else markErr(fee, feeErr, '');
      if (first) first.focus();
      return !first;
    }
    function setBusy(b) { saveBtn.disabled = b; if (againBtn) againBtn.disabled = b; if (delBtn) delBtn.disabled = b; }

    function submit(again) {
      if (submitted) return;
      formErr.textContent = '';
      if (!validate()) return;
      submitted = true; setBusy(true);
      try {
        const am = locked ? null : evalAmount(amount.value).value;
        const feeV = !locked && kind === 'debit' && fee.value.trim() ? evalAmount(fee.value).value : 0;
        if (!edit) {
          const res = addMovement(engine, L.id, { date: effectiveDate(), desc: desc.value, number: num.value, kind, amount: am, extra: feeV > 0 ? { commission: feeV } : undefined, dateStyle: L.dateMode === 'month' && monthChk.checked ? 'month' : 'exact' });
          st.lastKind = kind;
          ctx.changed([L.sid]);
          toastUndo('Guardado · nuevo saldo ' + money(res.balanceAfter) + '.', () => undoRows([res.row], 'Movimiento deshecho'));
          if (again) {
            submitted = false; setBusy(false);
            amount.value = ''; desc.value = ''; num.value = ''; fee.value = ''; descHint.textContent = ''; kindTouched = false;
            renderSugg(); recalc(); amount.focus();
          } else handle.close();
        } else {
          const f = {};
          if (clean(desc.value) !== movement.desc) f.desc = desc.value;
          if ((num.value.trim() || '') !== (movement.number === null ? '' : String(movement.number))) f.number = num.value;
          if (date.value && (dateTouched || monthChk.checked !== (initDate !== null && fromSerial(initDate).d === 1))) { const ed = effectiveDate(); if (ed !== null && ed !== initDate) { f.date = ed; f.dateStyle = L.dateMode === 'month' && monthChk.checked ? 'month' : 'exact'; } }
          if (!locked && (kind !== p.kind || am !== p.amount || feeV !== p.fee)) { f.kind = kind; f.amount = am; f.fee = feeV; }
          if (!Object.keys(f).length) { handle.close(); return; }
          const res = updateMovement(engine, L.id, movement.row, f);
          if (!res.ok) { formErr.textContent = res.message; submitted = false; setBusy(false); return; }
          ctx.changed([L.sid]);
          toastUndo('Cambios guardados · nuevo saldo ' + money(res.balanceAfter) + '.', () => { restoreSnapshot(engine, L.id, res.snapshot); ctx.changed([L.sid]); ctx.toast('Cambios deshechos', { ms: 2500 }); });
          handle.close();
        }
      } catch (e) {
        console.error('[ledger]', e);
        formErr.textContent = e.message || String(e); submitted = false; setBusy(false);
      }
    }
    async function removeIt() {
      const ok = await ctx.confirm('Se vaciará la fila ' + movement.rowNumber + ' (' + (movement.desc || 'sin descripción') + ', ' + money(Math.abs(movement.amount)) + '). La fórmula del saldo se conserva.', { ok: 'Eliminar', danger: true, title: 'Eliminar el último movimiento' });
      if (!ok || submitted) return;
      submitted = true; setBusy(true);
      const r = removeLastMovement(engine, L.id, { row: movement.row, force: true });
      if (!r.ok) { formErr.textContent = r.message; submitted = false; setBusy(false); return; }
      ctx.changed([L.sid]); ctx.toast('Movimiento eliminado', { ms: 2500 }); handle.close();
    }

    /* --- estructura --- */
    const form = el('form', { class: 'lg-form', novalidate: true, autocomplete: 'off', onsubmit: (e) => { e.preventDefault(); submit(false); } },
      el('div', { class: 'lg-scroll' },
        el('div', { class: 'lg-ctxrow' }, el('p', { class: 'small muted lg-ctx', text: L.title + (edit ? ' · fila ' + movement.rowNumber : '') }), sheetBtn),
        el('div', { class: 'field' }, el('span', { class: 'lg-lbl', id: ids.amount + '-t', text: 'Tipo de movimiento' }), seg),
        el('div', { class: 'field' }, el('label', { for: ids.amount, text: 'Monto' }), el('div', { class: 'lg-money' }, el('span', { 'aria-hidden': 'true', text: '$' }), amount), amountHint, amountErr),
        el('div', { class: 'field' }, el('label', { for: ids.desc, text: 'Descripción' }), desc, sugg, descHint, descErr),
        el('div', { class: 'field' }, el('label', { for: ids.date, text: 'Fecha' }), date, monthRow, monthNote, dateHint, dateErr),
        el('div', { class: 'field' }, el('label', { for: ids.num, text: L.numberLabel + ' (opcional)' }), num),
        more, preview, live, formErr),
      el('div', { class: 'lg-foot' }, saveBtn, againBtn, delBtn));

    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
      e.preventDefault();
      if (e.target === amount && !edit) desc.focus(); else submit(false);
    });
    amount.addEventListener('input', () => { amountErr.textContent = ''; amount.removeAttribute('aria-invalid'); recalc(); });
    amount.addEventListener('change', () => { live.textContent = ''; later(() => { live.textContent = liveText; }, 30); });
    fee.addEventListener('input', recalc);
    let sdeb = null;
    desc.addEventListener('input', () => { descErr.textContent = ''; desc.removeAttribute('aria-invalid'); descHint.textContent = ''; clearTimeout(sdeb); sdeb = later(renderSugg, 60); });
    desc.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { const b = sugg.querySelector('button'); if (b) { e.preventDefault(); b.focus(); } } });
    sugg.addEventListener('keydown', (e) => {
      const bs = [...sugg.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); (bs[i + 1] || bs[0]).focus(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) desc.focus(); else bs[i - 1].focus(); }
    });
    date.addEventListener('input', () => { dateTouched = true; dateErr.textContent = ''; date.removeAttribute('aria-invalid'); recalc(); });
    monthChk.addEventListener('change', () => { dateTouched = true; recalc(); });
    const onInfo = () => recalc();
    listeners.add(onInfo);

    setKind(kind, false);
    renderSugg(); recalc();
    const handle = ctx.modal(form, { title: edit ? 'Editar movimiento' : 'Nuevo movimiento', onClose: () => { modals.delete(handle); listeners.delete(onInfo); } });
    if (handle.body) handle.body.classList.add('lg-body');          // el cuerpo no se desplaza: se desplaza .lg-scroll y el pie queda fijo
    if (handle.el) trapFocus(handle.el);
    modals.add(handle);
    if (edit) { const f = locked ? desc : amount; later(() => f.focus(), 30); }
    return handle;
  }

  /* ---------- pegar texto del banco ---------- */
  function openPaste() {
    const L = st.L, info = st.info;
    if (!info) return;
    const ids = { ta: nid('paste'), month: nid('pmonth') };
    let items = [], busy = false;
    const ta = el('textarea', { id: ids.ta, rows: '6', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', placeholder: '13/11/2026\tPago de servicios\t(45.20)\n12/11/2026\tDepósito\t$1,234.50', 'aria-describedby': ids.ta + '-h' });
    const monthChk = el('input', { id: ids.month, type: 'checkbox' });
    monthChk.checked = L.dateMode === 'month';
    const out = el('div', { class: 'lg-pv-out', 'aria-live': 'polite' });
    const importBtn = el('button', { type: 'button', class: 'btn primary lg-import', disabled: true, onclick: () => doImport() }, 'Importar');
    const err = el('div', { class: 'lg-err', role: 'alert' });

    function toRow(it) {
      const amt = Math.abs(round2(it.row.credit - it.row.debit));
      return { date: it.row.date, desc: it.row.desc, number: it.row.number, debit: it.kind === 'debit' ? amt : 0, credit: it.kind === 'credit' ? amt : 0 };
    }
    const importable = () => items.filter((it) => it.include && it.status !== 'duplicate');
    function updateBtn() {
      const n = importable().length;
      importBtn.disabled = busy || n === 0;
      importBtn.textContent = n ? 'Importar ' + n + (n === 1 ? ' nuevo' : ' nuevos') : 'Importar';
    }
    function analyze() {
      err.textContent = '';
      const parsed = parsePastedMovements(ta.value, L.id);
      let verdicts = [];
      try { verdicts = analyzeImport(engine, L.id, parsed.rows, { monthDates: monthChk.checked }); } catch (e) { console.warn(e); verdicts = parsed.rows.map(() => ({ status: 'new' })); }
      items = parsed.rows.map((row, i) => ({ row, status: verdicts[i].status, matchRow: verdicts[i].matchRow, include: verdicts[i].status === 'new', kind: row.credit - row.debit >= 0 ? 'credit' : 'debit' }));
      renderPreview(parsed.warnings);
    }
    function renderPreview(warnings) {
      if (!ta.value.trim()) { setKids(out); updateBtn(); return; }
      const cnt = { new: 0, duplicate: 0, similar: 0 };
      items.forEach((it) => { cnt[it.status]++; });
      const sum = items.length
        ? items.length + (items.length === 1 ? ' línea leída' : ' líneas leídas') + ' · ' + cnt.new + ' nuevas' + (cnt.duplicate ? ' · ' + cnt.duplicate + ' duplicadas' : '') + (cnt.similar ? ' · ' + cnt.similar + ' parecidas' : '')
        : 'No se reconoció ninguna línea con fecha e importe.';
      const ul = el('ul', { class: 'list lg-pv' });
      items.forEach((it, i) => {
        const amt = Math.abs(round2(it.row.credit - it.row.debit));
        const dup = it.status === 'duplicate';
        const cid = nid('pv');
        const cb = el('input', { id: cid, type: 'checkbox', checked: it.include && !dup, disabled: dup, 'aria-label': 'Incluir línea ' + it.row.line, onchange: () => { it.include = cb.checked; updateBtn(); } });
        const tag = dup ? el('span', { class: 'badge lg-tag lg-dup', text: 'Duplicado · fila ' + (it.matchRow + 1) }) : (it.status === 'similar' ? el('span', { class: 'badge lg-tag lg-sim', text: '¿Ya está? · fila ' + (it.matchRow + 1) }) : (it.row.uncertain ? el('span', { class: 'badge lg-tag lg-sim', text: 'Revisa el tipo' }) : null));
        const kindBtn = el('button', { type: 'button', class: 'lg-pv-kind ' + (it.kind === 'debit' ? 'neg' : 'pos'), disabled: dup, 'aria-label': 'Tipo: ' + KIND_LABEL[it.kind] + '. Tocar para cambiar.', onclick: () => { it.kind = it.kind === 'debit' ? 'credit' : 'debit'; renderPreview(warnings); } }, KIND_LABEL[it.kind]);
        ul.append(el('li', { class: 'lg-pv-item' + (dup ? ' is-dup' : '') },
          cb,
          el('label', { class: 'grow', for: cid }, el('span', { class: 't', text: it.row.desc || '(sin descripción)' }), el('span', { class: 's' }, U.dateText(it.row.date) + (it.row.number ? ' · N.º ' + it.row.number : ''), ' ', tag)),
          el('span', { class: 'lg-side' }, el('span', { class: 'lg-amt num ' + (it.kind === 'debit' ? 'neg' : 'pos'), text: (it.kind === 'debit' ? '−' : '+') + money(amt) }), kindBtn)));
      });
      setKids(out,
        el('p', { class: 'lg-pv-sum', text: sum }),
        warnings && warnings.length ? el('ul', { class: 'lg-warn small' }, warnings.map((w) => el('li', { text: w }))) : null,
        items.length ? ul : null);
      updateBtn();
    }
    function doImport() {
      if (busy) return;
      const rows = importable().map(toRow);
      if (!rows.length) return;
      busy = true; updateBtn();
      let res;
      try { res = importMovements(engine, L.id, rows, { skipDuplicates: true, monthDates: monthChk.checked }); }
      catch (e) { console.error('[ledger]', e); err.textContent = e.message || String(e); busy = false; updateBtn(); return; }
      if (res.added) ctx.changed([L.sid]);
      if (res.error) {
        err.textContent = 'Se importaron ' + res.added + ' y se detuvo: ' + res.error;
        busy = false; updateBtn();
        if (res.added) toastUndo('Se importaron ' + res.added + ' movimientos.', () => undoRows(res.rows, 'Importación deshecha'));
        return;
      }
      handle.close();
      const msg = 'Importados ' + res.added + (res.added === 1 ? ' movimiento' : ' movimientos') + (res.skipped ? ' · ' + res.skipped + ' duplicados omitidos' : '') + (res.balanceAfter !== null ? ' · nuevo saldo ' + money(res.balanceAfter) : '') + '.';
      if (res.added) toastUndo(msg, () => undoRows(res.rows, 'Importación deshecha')); else ctx.toast('No se importó nada: ' + (res.skipped ? 'todo eran duplicados.' : 'no había líneas válidas.'), { type: 'warn', ms: 5000 });
    }
    let deb = null;
    ta.addEventListener('input', () => { clearTimeout(deb); deb = later(analyze, 250); });
    monthChk.addEventListener('change', analyze);
    const body = el('div', { class: 'lg-paste-body' },
      el('div', { class: 'lg-scroll' },
        el('p', { class: 'small muted', id: ids.ta + '-h', text: 'Copia las filas del portal del banco y pégalas aquí. Reconozco fechas dd/mm/aaaa o aaaa-mm-dd e importes con $, comas y paréntesis; con una sola columna de importe, el signo decide si es débito o crédito.' }),
        el('div', { class: 'field' }, el('label', { for: ids.ta, text: 'Texto del banco · ' + L.chip }), ta),
        L.dateMode === 'month' ? el('div', { class: 'lg-check' }, monthChk, el('label', { for: ids.month, text: 'Guardar solo el mes (día 1), como en esta cuenta' })) : null,
        el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn', onclick: analyze }, 'Vista previa')),
        out, err),
      el('div', { class: 'lg-foot' }, importBtn));
    const handle = ctx.modal(body, { title: 'Pegar texto del banco', wide: true, onClose: () => { modals.delete(handle); clearTimeout(deb); } });
    if (handle.body) handle.body.classList.add('lg-body');
    if (handle.el) trapFocus(handle.el);
    modals.add(handle);
    later(() => ta.focus(), 30);
    return handle;
  }

  /* ---------- arranque ---------- */
  let initial = ledgerId;
  if (!initial) { try { initial = localStorage.getItem('fx-ledger'); } catch (e) { /* sin almacenamiento */ } }
  select(initial || 'gye');

  return {
    refresh,
    destroy() {
      st.destroyed = true;
      timers.forEach((t) => clearTimeout(t)); timers.clear();
      modals.forEach((m) => { try { m.close(); } catch (e) { /* ya cerrado */ } }); modals.clear();
      listeners.clear();
      root.remove();
    },
  };
}
