/* quick.js — Capturas rápidas de Flujo: registros periódicos que NO son movimientos bancarios.
 *
 * Formularios: factura de luz, pensión del mes, pago del carro, renovación de pólizas, consumo de tarjeta
 * de crédito y tarjeta/cuenta de ahorros. Cada uno ofrece un API puro (sin interfaz) y testeable:
 *
 *   form.prepare(engine, {today})        -> {ok, nextRow, hints, warnings, ...}   fila de captura y sugerencias
 *   form.preview(engine, values, opts)   -> {ok, errors, warnings, checks, cells}  celdas calculadas, SIN escribir
 *   form.add(engine, values, opts)       -> {ok, row, changes, computed, token}    escribe y devuelve el resultado
 *   form.undoLast(engine)                -> {ok, ...}                              restaura exactamente lo escrito
 *   form.status(engine, opts)            -> {level, text, detail}                  estado para la tarjeta del menú
 *
 * Reglas comunes:
 *  - Filas y columnas BASE 0 (como el motor). `rowNumber` = fila de la hoja en base 1.
 *  - La fila de captura sale del contenido de las columnas de ENTRADA (nunca de "la primera celda vacía").
 *  - Solo se escriben las celdas previstas. Nunca se insertan ni se eliminan filas ni columnas.
 *  - La vista previa se calcula en un motor clon desechable con el MISMO código que escribe, así que lo que se
 *    ve es lo que se guarda.
 *  - Los errores impiden guardar; las advertencias con `confirm:true` piden un "sí" explícito (opts.confirmed).
 *  - Deshacer usa un diario propio: guarda el contenido y el formato previos de cada celda tocada.
 *
 * Los identificadores de hoja (SHEETS) pueden cambiarse con setSheetIds(). Este archivo no contiene datos
 * personales: todo lo que se muestra se lee de las hojas en el momento de usarlo.
 */
import { Engine, colIndex, colLetter } from './engine.js';
import { el, money, dateText, monthText, dateInputValue, serialFromInput } from './ui.js';
import { todaySerial } from './format.js';

/* ================================================================== identificadores de hojas */
export const SHEETS = { luz: 's11', pension: 's16', carro: 's18', poliza: 's05', tcpich: 's03', produb: 's04' };
export function setSheetIds(map) { Object.assign(SHEETS, map || {}); }

/* ================================================================== fechas */
const DAY = 86400000, EPOCH = Date.UTC(1899, 11, 30);
export const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const ymdToSerial = (y, m, d = 1) => Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY);
export function serialToYmd(n) { const t = new Date(EPOCH + Math.floor(n) * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
/** número absoluto de mes (año*12 + mes0): sirve para contar meses entre dos fechas */
export const monthNum = (serial) => { const { y, m } = serialToYmd(serial); return y * 12 + m - 1; };
export const monthStart = (abs) => ymdToSerial(Math.floor(abs / 12), (abs % 12) + 1, 1);
/** primer día del mes que queda k meses después (o antes si k < 0) */
export const addMonths = (serial, k) => monthStart(monthNum(serial) + k);
/** 'nov-2026' */
export const monthLabel = (serial) => { const { y, m } = serialToYmd(serial); return MESES[m - 1] + '-' + y; };
/** valor para <input type=month> ('2026-11') */
export const monthInputValue = (serial) => { const { y, m } = serialToYmd(serial); return y + '-' + String(m).padStart(2, '0'); };
const validYmd = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return null;
  const s = ymdToSerial(y, m, d), back = serialToYmd(s);
  return back.m === m && back.d === d ? s : null;
};
/** 'AAAA-MM' | 'AAAA-MM-DD' | 'MM/AAAA' | serial -> serial del día 1 del mes, o null */
export function parseMonthValue(v) {
  if (typeof v === 'number') { if (!Number.isFinite(v)) return null; const { y, m } = serialToYmd(v); return ymdToSerial(y, m, 1); }
  const s = String(v ?? '').trim(); let m;
  if ((m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s))) return validYmd(+m[1], +m[2], 1);
  if ((m = /^(\d{1,2})[\/-](\d{4})$/.exec(s))) return validYmd(+m[2], +m[1], 1);
  return null;
}
/** 'AAAA-MM-DD' | 'dd/mm/aaaa' | serial -> serial, o null */
export function parseDateValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null;
  const s = String(v ?? '').trim(); let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s))) return validYmd(+m[3], +m[2], +m[1]);
  return null;
}
const MES_ALIAS = {
  ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, mzo: 3, marzo: 3, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, junio: 6,
  jul: 7, julio: 7, ago: 8, agosto: 8, sep: 9, sept: 9, set: 9, septiembre: 9, oct: 10, octubre: 10, nov: 11, noviembre: 11, dic: 12, diciembre: 12,
};
/** texto de mes en español (abreviado o completo, sin importar mayúsculas ni tildes) -> 1..12, o 0 */
export function monthFromText(t) {
  const k = String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\.$/, '');
  return MES_ALIAS[k] || 0;
}

/* ================================================================== números y sumas tecleadas */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const NUMTOK = /\d[\d.,]*|[.,]\d+/g;
function normToken(t) {
  const dot = t.includes('.'), com = t.includes(',');
  if (dot && com) { const dec = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ','; const mil = dec === '.' ? ',' : '.'; return t.split(mil).join('').replace(dec, '.'); }
  if (com) return /^[1-9]\d{0,2}(,\d{3})+$/.test(t) ? t.split(',').join('') : t.replace(',', '.');   // 1,234 = miles; 1,5 = decimal
  if (dot && /^[1-9]\d{0,2}(\.\d{3}){2,}$/.test(t)) return t.split('.').join('');                     // 1.234.567
  return t;
}
/** evaluador aritmético mínimo (sin eval): + - * / paréntesis y signo unario */
function evalArith(s) {
  let i = 0;
  const fail = (m) => { throw new Error(m); };
  const number = () => { const m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(s.slice(i)); if (!m) fail(i >= s.length ? 'La suma está incompleta.' : 'Hay un signo o carácter fuera de lugar.'); i += m[0].length; return parseFloat(m[0]); };
  const factor = () => {
    if (s[i] === '+') { i++; return factor(); }
    if (s[i] === '-') { i++; return -factor(); }
    if (s[i] === '(') { i++; const v = expr(); if (s[i] !== ')') fail('Falta cerrar un paréntesis.'); i++; return v; }
    return number();
  };
  const term = () => {
    let v = factor();
    while (s[i] === '*' || s[i] === '/') { const op = s[i++]; const r = factor(); if (op === '*') v *= r; else { if (r === 0) fail('No se puede dividir entre cero.'); v /= r; } }
    return v;
  };
  const expr = () => { let v = term(); while (s[i] === '+' || s[i] === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
  const v = expr();
  if (i !== s.length) fail('Hay un signo o carácter fuera de lugar.');
  return v;
}
/**
 * Interpreta lo que la usuaria teclea en un campo de monto: un número ("84.01"), una suma ("69.65+34.83+0.71")
 * o una expresión con paréntesis. Admite coma decimal y símbolo $.
 * @returns {{ok:true, value:number, raw:number|string, isExpr:boolean, text:string} | {ok:false, empty?:boolean, error:string}}
 *   `raw` es lo que se guarda en la hoja: el número, o "=69.65+34.83+0.71" cuando es una suma (igual que en Excel).
 */
export function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? { ok: true, value: input, raw: input, isExpr: false, text: String(input) } : { ok: false, error: 'Número no válido.' };
  let s = String(input ?? '').trim();
  if (s === '') return { ok: false, empty: true, error: 'Falta este dato.' };
  s = s.replace(/^=+/, '').replace(/[\s$]/g, '').replace(/[−–—]/g, '-').replace(/÷/g, '/').replace(/×/g, '*').replace(/(?<=[\d)])[xX](?=[\d(])/g, '*');
  if (!/^[0-9+\-*/().,]+$/.test(s)) return { ok: false, error: 'Usa solo números y los signos + − × ÷ ( ).' };
  s = s.replace(NUMTOK, normToken);
  let value;
  try { value = evalArith(s); } catch (e) { return { ok: false, error: e.message }; }
  if (!Number.isFinite(value)) return { ok: false, error: 'El resultado no es un número válido.' };
  const isExpr = /[+\-*/()]/.test(s.replace(/^[+-]/, ''));
  return { ok: true, value, raw: isExpr ? '=' + s : value, isExpr, text: s };
}

/* ================================================================== lectura de celdas */
const a1 = (r, c) => colLetter(c) + (r + 1);
const numAt = (eng, sid, r, c) => { const v = eng.value(sid, r, c); return isNum(v) ? v : null; };
const textAt = (eng, sid, r, c) => { const v = eng.value(sid, r, c); return typeof v === 'string' ? v : ''; };
const filled = (eng, sid, r, c) => { const x = eng.raw(sid, r, c); return !(x === null || x === undefined || x === ''); };
const isFormulaAt = (eng, sid, r, c) => eng.isFormula(sid, r, c);
const COL = new Proxy({}, { get: (_, k) => colIndex(String(k)) });          // COL.K -> 10
const sameRaw = (a, b) => (a === b) || ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === ''));
class QuickError extends Error {}

/** formato de texto de un valor calculado según su `kind` */
export function fmtValue(v, kind) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return '—';
  if (typeof v === 'string') return v;
  switch (kind) {
    case 'usd': return money(v);
    case 'usd5': return (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(5);
    case 'int': return Math.round(v).toLocaleString('en-US');
    case 'num1': return v.toFixed(1);
    case 'num2': return v.toFixed(2);
    case 'pct0': return (v * 100).toFixed(0) + '%';
    case 'pct1': return (v * 100).toFixed(1) + '%';
    case 'pct2': return (v * 100).toFixed(2) + '%';
    case 'date': return dateText(v);
    case 'month': return monthText(v);
    default: return String(v);
  }
}

/* ================================================================== plan de escritura (ejecutable en el motor real o en un clon) */
/* plan = { sid, formId, row, label,
 *          copies: [{r0,c0,r1,c1,dr,dc}],      pegar fórmulas de otra fila (engine.copyPaste; se ajustan las referencias)
 *          writes: [{r,c,raw}],                contenido crudo: número | texto | "=fórmula"
 *          styles: [{r,c,from:[r,c],nf?}],     copiar el formato de otra celda (y opcionalmente cambiar el formato de número)
 *          out:    [{r,c,key,label,kind,primary,before}]   celdas cuyo valor se muestra }                                    */
function touchedOf(plan) {
  const m = new Map();
  for (const w of plan.writes || []) m.set(w.r * 4096 + w.c, { r: w.r, c: w.c });
  for (const k of plan.copies || []) for (let i = 0; i <= k.r1 - k.r0; i++) for (let j = 0; j <= k.c1 - k.c0; j++) m.set((k.dr + i) * 4096 + k.dc + j, { r: k.dr + i, c: k.dc + j });
  for (const s of plan.styles || []) m.set(s.r * 4096 + s.c, { r: s.r, c: s.c });
  return [...m.values()];
}
/**
 * Ejecuta un plan. Las copias de fórmulas van una por una (HyperFormula no permite copiar dentro de un lote) y las
 * escrituras de entradas en un solo lote (un único recálculo). Con dry:true no toca formatos ni toma el diario.
 */
function execute(eng, plan, { dry = false } = {}) {
  const sid = plan.sid, sh = eng.sheet(sid);
  const touched = touchedOf(plan);
  const before = dry ? null : { rows: sh.rows, cols: sh.cols, cells: touched.map(({ r, c }) => ({ r, c, raw: eng.raw(sid, r, c), style: sh.styleAt(r, c) })) };
  let changes = [];
  for (const k of plan.copies || []) changes = changes.concat(eng.copyPaste(sid, k.r0, k.c0, k.r1, k.c1, sid, k.dr, k.dc));
  if ((plan.writes || []).length) {
    const ch = eng.hf.batch(() => { for (const w of plan.writes) eng.set(sid, w.r, w.c, w.raw); });
    changes = changes.concat(eng._changes(ch));
  }
  if (!dry) {
    for (const s of plan.styles || []) {
      let id = sh.styleAt(s.from[0], s.from[1]);
      if (s.nf) id = eng.deriveStyle(id, { nf: s.nf });
      sh.setStyle(s.r, s.c, id);
    }
    eng.dirty.add(sid);
  }
  const after = dry ? null : touched.map(({ r, c }) => ({ r, c, raw: eng.raw(sid, r, c) }));
  return { changes, before, after, touched };
}
function restoreSnapshot(eng, sid, before) {
  const sh = eng.sheet(sid);
  const ch = eng.hf.batch(() => { for (const x of before.cells) eng.set(sid, x.r, x.c, x.raw); });
  for (const x of before.cells) sh.setStyle(x.r, x.c, x.style);
  sh.rows = before.rows; sh.cols = before.cols;
  eng.dirty.add(sid);
  return eng._changes(ch);
}
const uniqSids = (changes, sid) => { const s = new Set([sid]); for (const c of changes || []) s.add(c.sid); return [...s]; };

/* ---------------------------------------------------------------- motor clon desechable (vista previa) */
function cloneEngine(eng, sid, cells, rows, cols) {
  const sh = eng.sheet(sid);
  return new Engine({ sheets: [{ id: sid, name: sh.name }], styles: [{}], names: {} }, { [sid]: { rows, cols, cells, fmt: [] } }, { lazy: false });
}
function disposeEngine(c) { try { c.hf.destroy(); } catch (e) { /* nada */ } }
/** siembra el clon con VALORES (constantes) de un bloque de celdas */
function seedConst(eng, sid, r0, r1, c0, c1, out) {
  for (let r = Math.max(0, r0); r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const v = eng.value(sid, r, c);
    if (v !== null && v !== undefined && typeof v !== 'object') out.push([r, c, v]);
  }
}
/** siembra el clon con el CONTENIDO CRUDO (fórmulas incluidas) de una fila; los vínculos a otras hojas pasan como valor */
function seedRaw(eng, sid, r, c0, c1, out) {
  for (let c = c0; c <= c1; c++) {
    const x = eng.raw(sid, r, c);
    if (x === null || x === undefined || x === '') continue;
    if (typeof x === 'string' && x[0] === '=' && eng.isFormula(sid, r, c)) {
      if (x.includes('!')) { const v = eng.value(sid, r, c); if (v !== null && v !== undefined && typeof v !== 'object') out.push([r, c, v]); }
      else out.push([r, c, null, x.slice(1)]);
    } else out.push([r, c, x]);
  }
}
function readOut(eng, plan, beforeMap) {
  return (plan.out || []).map((o) => {
    const v = eng.value(plan.sid, o.r, o.c);
    const err = v && typeof v === 'object' ? v.error : null;
    const value = err ? null : v;
    const item = { key: o.key, label: o.label, a1: a1(o.r, o.c), r: o.r, c: o.c, kind: o.kind, primary: !!o.primary, value, error: err, text: err ? '—' : fmtValue(value, o.kind) };
    if (beforeMap && o.before) { const b = beforeMap.get(o.key); item.before = b === undefined ? null : b; item.beforeText = fmtValue(item.before, o.kind); }
    return item;
  });
}
const captureBefore = (eng, plan) => { const m = new Map(); for (const o of plan.out || []) if (o.before) { const v = eng.value(plan.sid, o.r, o.c); m.set(o.key, v && typeof v === 'object' ? null : v); } return m; };
/** combina resúmenes "antes" y "después" (listas {key,label,value,kind}) en filas para mostrar */
function mergeSummary(before, after) {
  const bm = new Map((before || []).map((x) => [x.key, x]));
  return (after || []).map((a) => { const b = bm.get(a.key); return { key: a.key, label: a.label, kind: a.kind, before: b ? b.value : null, after: a.value, beforeText: b ? fmtValue(b.value, a.kind) : '—', afterText: fmtValue(a.value, a.kind), tone: a.tone || null }; });
}

/* ================================================================== diario de deshacer */
let TOKEN = 0;
const JOURNAL = new WeakMap();
const journalOf = (eng) => { let j = JOURNAL.get(eng); if (!j) JOURNAL.set(eng, j = []); return j; };
/**
 * Deshace el último registro (del formulario indicado en opts.formId, o de cualquiera). Restaura el contenido y el
 * formato de cada celda tocada. Si alguna celda cambió después del registro, no toca nada y lo explica.
 * @param {{formId?:string, token?:string}} opts
 */
export function undoLast(eng, opts = {}) {
  const j = journalOf(eng);
  let i = j.length - 1;
  if (opts.formId) while (i >= 0 && j[i].formId !== opts.formId) i--;
  if (i < 0) return { ok: false, reason: 'No hay nada que deshacer.' };
  const e = j[i];
  if (opts.token && opts.token !== e.id) return { ok: false, reason: 'Solo se puede deshacer el último registro de este formulario.' };
  const bad = e.after.filter((x) => !sameRaw(eng.raw(e.sid, x.r, x.c), x.raw));
  if (bad.length) return { ok: false, reason: 'La celda ' + a1(bad[0].r, bad[0].c) + ' cambió después de este registro; deshazlo a mano en la hoja.', conflict: bad.map((x) => a1(x.r, x.c)) };
  const changes = restoreSnapshot(eng, e.sid, e.before);
  j.splice(i, 1);
  return { ok: true, formId: e.formId, sid: e.sid, row: e.row, label: e.label, changes, sids: uniqSids(changes, e.sid) };
}
/** ¿hay algo que deshacer? (para mostrar u ocultar el botón) */
export const canUndo = (eng, formId) => journalOf(eng).some((e) => !formId || e.formId === formId);

/* ================================================================== fábrica de formularios */
const withToday = (o) => Object.assign({}, o || {}, { today: isNum(o && o.today) ? o.today : todaySerial() });
const failPrep = (e) => ({ ok: false, error: e && e.message ? e.message : String(e), nextRow: null, hints: {}, warnings: [], debug: e && !(e instanceof QuickError) ? e.stack : undefined });

function checkValues(def, eng, values, opts) {
  let prep;
  const o = values && values.mode ? Object.assign({}, opts, { mode: values.mode }) : opts;     // formularios con modos (tarjeta / cuenta)
  try { prep = def.prepare(eng, o); } catch (e) { prep = failPrep(e); }
  if (!prep.ok) return { prep, errors: [{ field: null, msg: prep.error || 'No se puede registrar en esta hoja.' }], warnings: [], checks: [], parsed: null };
  const v = def.validate(eng, prep, values || {}, opts);
  return { prep, errors: v.errors || [], warnings: v.warnings || [], checks: v.checks || [], parsed: v.parsed || null };
}
function runPreview(def, eng, values, opts) {
  const c = checkValues(def, eng, values, opts);
  const res = { ok: false, errors: c.errors, warnings: c.warnings, checks: c.checks, cells: [], summary: [], writes: [], row: c.prep.nextRow == null ? null : c.prep.nextRow, rowNumber: c.prep.nextRow == null ? null : c.prep.nextRow + 1 };
  if (c.errors.length) return res;
  const plan = def.plan(eng, c.prep, c.parsed, opts);
  const seed = def.seed(eng, c.prep, plan, c.parsed);
  const beforeMap = captureBefore(eng, plan);
  const sumBefore = def.summary ? def.summary(eng, c.prep, plan, c.parsed, 'before') : [];
  const clone = cloneEngine(eng, plan.sid, seed.cells, seed.rows, seed.cols);
  try {
    execute(clone, plan, { dry: true });
    res.cells = readOut(clone, plan, beforeMap);
    if (def.summary) res.summary = mergeSummary(sumBefore, def.summary(clone, c.prep, plan, c.parsed, 'after'));
  } finally { disposeEngine(clone); }
  res.writes = (plan.writes || []).map((w) => ({ a1: a1(w.r, w.c), raw: w.raw }));
  res.copies = (plan.copies || []).map((k) => ({ from: a1(k.r0, k.c0) + (k.c1 > k.c0 ? ':' + a1(k.r1, k.c1) : ''), to: a1(k.dr, k.dc) }));
  res.ok = true;
  return res;
}
function runAdd(def, eng, values, opts) {
  const c = checkValues(def, eng, values, opts);
  if (c.errors.length) return { ok: false, errors: c.errors, warnings: c.warnings };
  const need = c.warnings.filter((w) => w.confirm);
  if (need.length && !opts.confirmed) return { ok: false, needsConfirm: true, errors: [], warnings: c.warnings, confirm: need };
  const plan = def.plan(eng, c.prep, c.parsed, opts);
  const beforeMap = captureBefore(eng, plan);
  const sumBefore = def.summary ? def.summary(eng, c.prep, plan, c.parsed, 'before') : [];
  const exBefore = def.extra ? def.extra(eng, c.prep, plan, c.parsed) : [];
  const res = execute(eng, plan);
  const computed = readOut(eng, plan, beforeMap);
  const summary = def.summary ? mergeSummary(sumBefore, def.summary(eng, c.prep, plan, c.parsed, 'after')) : [];
  const extra = def.extra ? mergeSummary(exBefore, def.extra(eng, c.prep, plan, c.parsed)) : [];
  const label = plan.label || def.title;
  const entry = { id: 'u' + (++TOKEN), formId: def.id, sid: plan.sid, label, row: plan.row == null ? null : plan.row, before: res.before, after: res.after, at: Date.now() };
  journalOf(eng).push(entry);
  const warnings = c.warnings.slice();
  for (const x of computed) if (x.error) warnings.push({ code: 'calc', msg: 'La celda ' + x.a1 + ' da ' + x.error + '. Revísala en la hoja.' });
  return {
    ok: true, formId: def.id, sid: plan.sid, row: entry.row, rowNumber: entry.row == null ? null : entry.row + 1,
    changes: res.changes, sids: uniqSids(res.changes, plan.sid), computed, summary, extra, warnings, token: entry.id, label,
    written: res.touched.map(({ r, c: cc }) => a1(r, cc)),
  };
}
function makeForm(def) {
  const form = {
    id: def.id, title: def.title, desc: def.desc, icon: def.icon, key: def.key,
    get sid() { return SHEETS[def.key]; },
    prepare(eng, opts) { opts = withToday(opts); try { return def.prepare(eng, opts); } catch (e) { return failPrep(e); } },
    preview(eng, values, opts) { opts = withToday(opts); try { return runPreview(def, eng, values, opts); } catch (e) { return { ok: false, errors: [{ field: null, msg: e.message }], warnings: [], checks: [], cells: [], summary: [], writes: [], debug: e.stack }; } },
    add(eng, values, opts) { opts = withToday(opts); return runAdd(def, eng, values, opts); },
    undoLast(eng, opts) { return undoLast(eng, Object.assign({}, opts || {}, { formId: def.id })); },
    status(eng, opts) {
      opts = withToday(opts);
      try { return def.status(eng, opts); } catch (e) { return { level: 'off', text: 'No disponible', detail: e instanceof QuickError ? e.message : 'No se pudo leer la hoja.' }; }
    },
    def,
  };
  return form;
}

/* ================================================================== utilidades de validación compartidas */
const needSheet = (eng, key) => { const sid = SHEETS[key]; if (!eng || !eng.sheet || !eng.sheet(sid)) throw new QuickError('No se encontró la hoja de este formulario (' + sid + ').'); return sid; };
/** lee un campo de monto de `values`; agrega el error a `errors` y devuelve null si no sirve */
function readAmount(values, key, label, errors, opt = {}) {
  const a = parseAmount(values[key]);
  if (!a.ok) { if (a.empty && opt.optional) return null; errors.push({ field: key, msg: a.empty ? 'Falta ' + label + '.' : label + ': ' + a.error }); return null; }
  if (opt.positive && !(a.value > 0)) { errors.push({ field: key, msg: label + ' debe ser mayor que cero.' }); return null; }
  if (opt.nonneg && a.value < 0) { errors.push({ field: key, msg: label + ' no puede ser negativo.' }); return null; }
  return a;
}
const plural = (n, uno, varios) => (n === 1 ? uno : varios);

/* ================================================================== FACTURA DE LUZ (una fila por mes) */
/* Fila de captura = última fila con lectura (K) y consumo (C) + 1, dentro de la tabla mensual. Los verificadores
 * sueltos que hay debajo de la última fila (columnas de entrada) NO cuentan como datos. */
const LUZ = {
  first: 3, last: 64,                                                   // filas 4..65 (base 0: 3..64); desde la 66 hay borradores
  copies: [[3, 3], [5, 9], [11, 12], [16, 17], [20, 21], [23, 23]],    // fórmulas que se copian de la fila anterior: D | F:J | L:M | Q:R | U:V | X
  inputCols: [1, 2, 4, 10, 14, 15, 18, 19],                             // B C E K O P S T
  formulaCols: [3, 5, 6, 7, 8, 9, 11, 12, 16, 17, 20, 21, 23],
  styleCols: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23],
  maxCol: 23,
};
const LUZ_OUT = [
  ['G', 'kWh del período', 'int', true], ['L', 'kWh por día', 'num1', true], ['D', 'Impuestos', 'usd', true], ['F', 'Impuestos sobre consumo', 'pct0', true],
  ['H', 'Costo por kWh sin impuestos', 'usd5', true], ['J', 'Costo por kWh con impuestos', 'usd5', true], ['Q', 'Costo por kWh pagado (neto)', 'usd5', true],
  ['R', 'Subsidio sobre consumo', 'pct1', false], ['U', 'Ahorro solar', 'pct2', true], ['V', 'Consumo sin solar (kWh)', 'int', false],
  ['I', 'Promedio acumulado de costo por kWh', 'usd5', false], ['M', 'Diferencia contra el consumo base', 'num1', false], ['X', 'Neto', 'usd', false],
];
function luzRowMonth(eng, sid, p) {
  for (let j = p, k = 0; j >= LUZ.first; j--, k++) { const b = numAt(eng, sid, j, COL.B); if (b !== null && b > 20000) return addMonths(parseMonthValue(b), k); }
  return null;
}
function luzPrepare(eng, opts) {
  const sid = needSheet(eng, 'luz');
  let p = -1;
  for (let r = LUZ.last; r >= LUZ.first; r--) if (numAt(eng, sid, r, COL.K) !== null && numAt(eng, sid, r, COL.C) !== null) { p = r; break; }
  if (p < 0) throw new QuickError('No se encontró la última factura registrada.');
  const lastMonth = luzRowMonth(eng, sid, p);
  if (lastMonth === null) throw new QuickError('No se pudo saber el mes de la última factura.');
  const r = p + 1;
  if (r > LUZ.last) throw new QuickError('La tabla mensual no tiene filas libres (llega hasta la fila ' + (LUZ.last + 1) + ').');
  const nextMonth = addMonths(lastMonth, 1);
  // meses sin factura: hasta el mes anterior al actual (la planilla del mes en curso aún no llega)
  const count = Math.max(0, monthNum(opts.today) - 1 - monthNum(lastMonth));
  const months = Array.from({ length: count }, (_, i) => addMonths(lastMonth, 1 + i));
  const lf = eng.raw(sid, p, COL.L);
  const dm = typeof lf === 'string' ? /\/\s*(\d+(?:\.\d+)?)\s*\)?\s*$/.exec(lf) : null;
  const kwhs = []; for (let j = Math.max(LUZ.first, p - 5); j <= p; j++) { const g = numAt(eng, sid, j, COL.G); if (g !== null && g > 0) kwhs.push(g); }
  const prev = { row: p, month: lastMonth, C: numAt(eng, sid, p, COL.C), E: numAt(eng, sid, p, COL.E), K: numAt(eng, sid, p, COL.K), O: numAt(eng, sid, p, COL.O), P: numAt(eng, sid, p, COL.P), T: numAt(eng, sid, p, COL.T), G: numAt(eng, sid, p, COL.G), days: dm ? +dm[1] : 30 };
  const warnings = [];
  const over = [...LUZ.inputCols, ...LUZ.formulaCols].filter((c) => filled(eng, sid, r, c)).map((c) => a1(r, c) + (isFormulaAt(eng, sid, r, c) ? ' (' + eng.raw(sid, r, c) + ')' : ''));
  if (over.length) warnings.push({ code: 'overwrite', level: 'info', msg: 'La fila ' + (r + 1) + ' ya tiene contenido (' + over.join(', ') + '); se reemplazará.', cells: over });
  const lacking = LUZ.formulaCols.filter((c) => !isFormulaAt(eng, sid, p, c)).map((c) => colLetter(c));
  if (lacking.length) warnings.push({ code: 'formulas', level: 'warn', msg: 'La fila anterior no tiene fórmula en ' + lacking.join(', ') + '; la fila nueva quedará sin ellas.', cells: lacking });
  const free = LUZ.last - r + 1;
  if (free <= 3) warnings.push({ code: 'capacity', level: 'warn', msg: 'Quedan ' + free + ' ' + plural(free, 'fila libre', 'filas libres') + ' en la tabla mensual.' });
  return {
    ok: true, formId: 'luz', sid, lastRow: p, nextRow: r, month: nextMonth, prev, capacity: free,
    missing: { count, months },
    hints: { days: prev.days, typicalKwh: kwhs.length ? kwhs.reduce((a, b) => a + b, 0) / kwhs.length : null, prev },
    warnings,
  };
}
function luzValidate(eng, prep, v) {
  const errors = [], warnings = [], checks = [], pz = {};
  const m = parseMonthValue(v.month);
  if (m === null) errors.push({ field: 'month', msg: 'Elige el mes de la factura.' });
  else if (m <= prep.prev.month) errors.push({ field: 'month', msg: 'El mes debe ser posterior a ' + monthLabel(prep.prev.month) + ' (último registrado).' });
  else if (m > prep.month) { const n = monthNum(m) - monthNum(prep.month); warnings.push({ code: 'skip', field: 'month', confirm: true, msg: 'Se saltan ' + n + ' ' + plural(n, 'mes', 'meses') + ' (desde ' + monthLabel(prep.month) + '): la tabla es mensual y sin huecos.' }); }
  const C = readAmount(v, 'C', 'el consumo', errors, { positive: true });
  const E = readAmount(v, 'E', 'el total de la planilla', errors, { positive: true });
  const K = readAmount(v, 'K', 'la lectura del medidor', errors, { positive: true });
  const O = readAmount(v, 'O', 'el subsidio', errors, { nonneg: true });
  const P = readAmount(v, 'P', 'el valor de la factura', errors, { positive: true });
  const T = readAmount(v, 'T', 'los kWh generados', errors, { nonneg: true });
  const days = Number(String(v.days ?? '').trim());
  if (String(v.days ?? '').trim() === '' || !Number.isInteger(days) || days < 1 || days > 100) errors.push({ field: 'days', msg: 'Escribe los días del período (un número entero, por ejemplo 30).' });
  else if (days < 27 || days > 33) warnings.push({ code: 'days', field: 'days', msg: 'Los períodos suelen durar entre 28 y 33 días.' });
  if (K && K.value <= prep.prev.K) errors.push({ field: 'K', msg: 'La lectura debe ser mayor que la anterior (' + prep.prev.K + ').' });
  if (K && K.value > prep.prev.K) {
    const g = K.value - prep.prev.K;
    checks.push({ key: 'kwh', ok: true, text: 'Consumo del período: ' + Math.round(g).toLocaleString('en-US') + ' kWh' });
    const typ = prep.hints.typicalKwh;
    if (typ && (g > 3 * typ || g < typ / 3)) warnings.push({ code: 'kwh', field: 'K', msg: 'El consumo del período (' + Math.round(g) + ' kWh) es muy distinto del habitual (~' + Math.round(typ) + ' kWh). Revisa la lectura.' });
  }
  if (E && O && P) {
    const diff = E.value - O.value - P.value;
    const ok = Math.abs(diff) <= 0.5;
    checks.push({ key: 'eop', ok, text: 'Total − subsidio = ' + money(E.value - O.value) + ' · valor de la factura ' + money(P.value) + (ok ? ' · coinciden' : ' · difieren en ' + money(Math.abs(diff))) });
    if (!ok) warnings.push({ code: 'eop', field: 'P', confirm: true, msg: 'Total − subsidio (' + money(E.value - O.value) + ') no coincide con el valor de la factura (' + money(P.value) + '): difieren en ' + money(Math.abs(diff)) + '.' });
  }
  if (errors.length) return { errors, warnings, checks };
  Object.assign(pz, { B: m, C, E, K, O, P, T, days, S: String(v.S || '').trim() || MESES[serialToYmd(m).m - 1] });
  return { errors, warnings, checks, parsed: pz };
}
function luzPlan(eng, prep, pz) {
  const sid = SHEETS.luz, r = prep.nextRow, p = prep.lastRow;
  const writes = [
    { r, c: COL.B, raw: pz.B }, { r, c: COL.C, raw: pz.C.raw }, { r, c: COL.E, raw: pz.E.raw }, { r, c: COL.K, raw: pz.K.raw },
    { r, c: COL.O, raw: pz.O.raw }, { r, c: COL.P, raw: pz.P.raw }, { r, c: COL.S, raw: pz.S }, { r, c: COL.T, raw: pz.T.raw },
    { r, c: COL.L, raw: '=+G' + (r + 1) + '/' + pz.days },                       // se copió con el divisor anterior: aquí van los días reales
  ];
  return {
    sid, formId: 'luz', row: r, label: 'Factura de ' + monthLabel(pz.B),
    copies: LUZ.copies.map(([c0, c1]) => ({ r0: p, c0, r1: p, c1, dr: r, dc: c0 })),
    writes, styles: LUZ.styleCols.map((c) => ({ r, c, from: [p, c] })),
    out: LUZ_OUT.map(([col, label, kind, primary]) => ({ r, c: COL[col], key: col, label, kind, primary })),
  };
}
function luzSeed(eng, prep, plan) {
  const out = [];
  seedConst(eng, plan.sid, LUZ.first, prep.lastRow - 1, 0, LUZ.maxCol, out);
  seedRaw(eng, plan.sid, prep.lastRow, 0, LUZ.maxCol, out);
  return { cells: out, rows: plan.row + 2, cols: LUZ.maxCol + 1 };
}
function luzStatus(eng, opts) {
  const prep = luzPrepare(eng, opts), n = prep.missing.count;
  if (n === 0) return { level: 'ok', text: 'Al día', detail: 'Última factura: ' + monthLabel(prep.prev.month) };
  const first = prep.missing.months[0], last = prep.missing.months[n - 1];
  return { level: n >= 3 ? 'late' : 'warn', text: n === 1 ? 'Falta 1 factura de luz' : 'Faltan ' + n + ' facturas de luz', detail: n === 1 ? monthLabel(first) : monthLabel(first) + ' a ' + monthLabel(last) };
}
const luz = makeForm({
  id: 'luz', key: 'luz', title: 'Factura de luz', icon: '💡',
  desc: 'Registra la planilla del mes: consumo, total, lectura del medidor y subsidio.',
  prepare: luzPrepare, validate: luzValidate, plan: luzPlan, seed: luzSeed, status: luzStatus,
});

/* ================================================================== PENSIÓN DEL MES (una fila por mes, sin plantilla) */
/* Entradas: G año, H mes en texto minúscula, I monto. Se copian de la fila anterior las fórmulas J K L (M vacía) N O.
 * Fila de captura = última fila con contenido en G:I + 1. El cuadro es continuo: el mes nuevo debe ser el siguiente. */
const PEN = { first: 69, G: 6, H: 7, I: 8, formulaFrom: 9, formulaTo: 14, rateRow: 68, rateCol: 10 };
function penMonthOf(eng, sid, r) {
  const v = eng.value(sid, r, PEN.H);
  if (typeof v === 'string') return monthFromText(v);
  if (isNum(v) && v > 20000) return serialToYmd(v).m;
  return 0;
}
/** filas recientes con mes y monto, en orden cronológico: [{r,m,y,amt}] (los años que faltan se infieren hacia atrás) */
function penHistory(eng, sid, from) {
  const rows = [];
  for (let r = from; r >= PEN.first && rows.length < 40; r--) {
    const amt = numAt(eng, sid, r, PEN.I), m = penMonthOf(eng, sid, r);
    if (amt === null || !m) continue;
    rows.push({ r, m, amt, y: numAt(eng, sid, r, PEN.G) });
  }
  for (let i = 1; i < rows.length; i++) if (rows[i].y === null && rows[i - 1].y !== null) rows[i].y = rows[i - 1].y - (rows[i].m > rows[i - 1].m ? 1 : 0);
  return rows.reverse();
}
/**
 * Monto sugerido para un mes. Base = el último mes "normal" (ni marzo ni diciembre). Diciembre = el doble de la base.
 * Marzo = la base + un SBU, que se estima con el aumento del marzo anterior ajustado por el cambio del monto base.
 * Cualquier otro mes = la base. Es solo una sugerencia: la usuaria puede cambiarla.
 */
export function suggestPension(history, month) {
  let base = null;
  for (let i = history.length - 1; i >= 0; i--) if (history[i].m !== 3 && history[i].m !== 12) { base = history[i].amt; break; }
  if (base === null && history.length) base = history[history.length - 1].amt;
  if (base === null) return { base: null, suggested: null, rule: 'igual', sbu: null };
  if (month === 12) return { base, suggested: round2(base * 2), rule: 'doble', sbu: null };
  if (month === 3) {
    for (let i = history.length - 1; i > 0; i--) {
      if (history[i].m === 3 && history[i - 1].m === 2 && history[i - 1].amt > 0) {
        const est = Math.round((history[i].amt - history[i - 1].amt) * (base / history[i - 1].amt));
        if (Number.isFinite(est) && est > 0) return { base, suggested: round2(base + est), rule: 'sbu', sbu: est };
      }
    }
    return { base, suggested: base, rule: 'sbu', sbu: null };
  }
  return { base, suggested: base, rule: 'igual', sbu: null };
}
function penPrepare(eng, opts) {
  const sid = needSheet(eng, 'pension');
  const lastContent = eng.lastRowWithContent(sid, PEN.G, PEN.I);
  const hist = penHistory(eng, sid, lastContent);
  if (!hist.length || lastContent < PEN.first) throw new QuickError('No se encontró el cuadro mensual.');
  const L = hist[hist.length - 1];
  if (L.r !== lastContent) throw new QuickError('La última fila del cuadro (fila ' + (lastContent + 1) + ') no tiene mes y monto; revísala en la hoja.');
  if (L.y === null) throw new QuickError('No se pudo saber el año de la última fila.');
  const lastSerial = ymdToSerial(L.y, L.m, 1), nextSerial = addMonths(lastSerial, 1), nx = serialToYmd(nextSerial);
  const r = lastContent + 1, p = lastContent;
  const count = Math.max(0, monthNum(opts.today) - monthNum(lastSerial));
  const months = Array.from({ length: count }, (_, i) => addMonths(lastSerial, 1 + i));
  const sg = suggestPension(hist, nx.m);
  const warnings = [];
  const over = [PEN.G, PEN.H, PEN.I, ...[9, 10, 11, 12, 13, 14]].filter((c) => filled(eng, sid, r, c)).map((c) => a1(r, c));
  if (over.length) warnings.push({ code: 'overwrite', level: 'info', msg: 'La fila ' + (r + 1) + ' ya tiene contenido (' + over.join(', ') + '); se reemplazará.', cells: over });
  const lacking = [9, 10, 14].filter((c) => !isFormulaAt(eng, sid, p, c)).map((c) => colLetter(c));
  if (lacking.length) warnings.push({ code: 'formulas', level: 'warn', msg: 'La fila anterior no tiene fórmula en ' + lacking.join(', ') + '; la fila nueva quedará sin ellas.', cells: lacking });
  if (numAt(eng, sid, PEN.rateRow, PEN.rateCol) === null) warnings.push({ code: 'rate', level: 'warn', msg: 'No se encontró la tasa anual que usa el acumulado con interés.' });
  return {
    ok: true, formId: 'pension', sid, lastRow: p, nextRow: r,
    last: { y: L.y, m: L.m, amount: L.amt, serial: lastSerial, label: monthLabel(lastSerial) },
    next: { y: nx.y, m: nx.m, serial: nextSerial, label: monthLabel(nextSerial), hText: MESES[nx.m - 1] },
    missing: { count, months },
    hints: { suggested: sg.suggested, base: sg.base, rule: sg.rule, sbu: sg.sbu, previous: L.amt },
    history: hist, warnings,
  };
}
function penValidate(eng, prep, v, opts) {
  const errors = [], warnings = [], checks = [], pz = {};
  const ms = parseMonthValue(v.month);
  if (ms === null) errors.push({ field: 'month', msg: 'Elige el mes de la pensión.' });
  else {
    const diff = monthNum(ms) - monthNum(prep.next.serial);
    if (diff < 0) errors.push({ field: 'month', msg: monthLabel(ms) + ' ya está registrado; el siguiente mes es ' + prep.next.label + '.' });
    else if (diff > 0) errors.push({ field: 'month', msg: 'El cuadro es continuo: el siguiente mes es ' + prep.next.label + '. Registra primero los meses anteriores.' });
    else if (monthNum(ms) > monthNum(opts.today)) warnings.push({ code: 'future', field: 'month', confirm: true, msg: monthLabel(ms) + ' es un mes futuro (aún no empieza).' });
  }
  const A = readAmount(v, 'amount', 'el monto del mes', errors, { positive: true });
  if (A) {
    const s = prep.hints.suggested;
    if (s && Math.abs(A.value - s) / s > 0.5) warnings.push({ code: 'amount', field: 'amount', confirm: true, msg: 'El monto es muy distinto del sugerido (' + money(s) + '). ¿Está bien?' });
    else if (s && Math.abs(A.value - s) > 0.005) checks.push({ key: 'sug', ok: null, text: 'Sugerido: ' + money(s) });
  }
  if (errors.length) return { errors, warnings, checks };
  const m = serialToYmd(ms);
  Object.assign(pz, { y: m.y, m: m.m, hText: MESES[m.m - 1], amount: round2(A.value), serial: ms });
  return { errors, warnings, checks, parsed: pz };
}
function penPlan(eng, prep, pz) {
  const sid = SHEETS.pension, r = prep.nextRow, p = prep.lastRow;
  const outs = [['J', 'Acumulado', 'usd', true], ['K', 'Acumulado con interés', 'usd', true], ['L', 'Interés acumulado', 'usd', true], ['N', 'Meta', 'usd', false], ['O', 'Brecha contra la meta', 'usd', true]];
  return {
    sid, formId: 'pension', row: r, label: 'Pensión de ' + monthLabel(pz.serial),
    copies: [{ r0: p, c0: PEN.formulaFrom, r1: p, c1: PEN.formulaTo, dr: r, dc: PEN.formulaFrom }],
    writes: [{ r, c: PEN.G, raw: pz.y }, { r, c: PEN.H, raw: pz.hText }, { r, c: PEN.I, raw: pz.amount }],
    styles: [PEN.G, PEN.H, PEN.I].map((c) => ({ r, c, from: [p, c] })),
    out: outs.map(([col, label, kind, primary]) => ({ r, c: COL[col], key: col, label, kind, primary })),
  };
}
function penSeed(eng, prep, plan) {
  const out = [], p = prep.lastRow;
  seedConst(eng, plan.sid, PEN.rateRow, PEN.rateRow, PEN.rateCol, PEN.rateCol, out);
  seedConst(eng, plan.sid, p - 1, p - 1, 9, 11, out);
  seedRaw(eng, plan.sid, p, PEN.G, PEN.formulaTo, out);
  return { cells: out, rows: plan.row + 2, cols: 16 };
}
function penStatus(eng, opts) {
  const prep = penPrepare(eng, opts), n = prep.missing.count;
  if (n === 0) return { level: 'ok', text: 'Al día', detail: 'Último mes: ' + prep.last.label };
  if (n === 1) return { level: 'warn', text: 'Pensión de ' + prep.next.label + ' pendiente', detail: 'Último mes: ' + prep.last.label };
  return { level: 'late', text: 'Faltan ' + n + ' meses de pensión', detail: monthLabel(prep.missing.months[0]) + ' a ' + monthLabel(prep.missing.months[n - 1]) };
}
const pension = makeForm({
  id: 'pension', key: 'pension', title: 'Pensión del mes', icon: '📅',
  desc: 'Agrega el mes con su monto y recalcula el acumulado.',
  prepare: penPrepare, validate: penValidate, plan: penPlan, seed: penSeed, status: penStatus,
});

/* ================================================================== PAGO DEL CARRO (registro de pagos dentro de la hoja de préstamos) */
/* Un pago = fecha en S y monto NEGATIVO en V, en la primera fila libre de la zona de pagos. No hay fórmulas por fila: el
 * total (V) suma un rango fijo y el saldo (W) se recalcula solo. No se tocan las demás zonas que comparten esas filas. */
const CAR = { first: 31, last: 72, S: 18, V: 21, W: 22, totalRow: 30, balRow: 30, commitRow: 28, commitCol: 20 };
function carLastRow(eng, sid) {
  const raw = eng.raw(sid, CAR.totalRow, CAR.V);
  const m = typeof raw === 'string' ? /SUM\(\s*V\d+\s*:\s*V(\d+)\s*\)/i.exec(raw) : null;
  return m ? +m[1] - 1 : CAR.last;                                        // última fila que el total alcanza a sumar
}
function carPrepare(eng, opts) {
  const sid = needSheet(eng, 'carro');
  const maxRow = carLastRow(eng, sid);
  let p = -1;
  for (let r = maxRow; r >= CAR.first; r--) if (numAt(eng, sid, r, CAR.S) !== null || numAt(eng, sid, r, CAR.V) !== null) { p = r; break; }
  const r = p < 0 ? CAR.first : p + 1;
  if (r > maxRow) throw new QuickError('La zona de pagos está llena: el total solo suma hasta la fila ' + (maxRow + 1) + '. Amplía ese rango en la hoja.');
  const free = maxRow - r + 1;
  const balance = numAt(eng, sid, CAR.balRow, CAR.W), paid = numAt(eng, sid, CAR.totalRow, CAR.V);
  const lastAmount = p >= 0 && numAt(eng, sid, p, CAR.V) !== null ? Math.abs(numAt(eng, sid, p, CAR.V)) : null;
  const warnings = [];
  const over = [CAR.S, CAR.V].filter((c) => filled(eng, sid, r, c)).map((c) => a1(r, c));
  if (over.length) warnings.push({ code: 'overwrite', level: 'info', msg: 'La fila ' + (r + 1) + ' ya tiene contenido (' + over.join(', ') + '); se reemplazará.', cells: over });
  if (!isFormulaAt(eng, sid, CAR.totalRow, CAR.V) || !isFormulaAt(eng, sid, CAR.balRow, CAR.W)) warnings.push({ code: 'formulas', level: 'warn', msg: 'No se encontraron las fórmulas del total y del saldo de pagos.' });
  if (free <= 3) warnings.push({ code: 'capacity', level: 'warn', msg: 'Quedan ' + free + ' ' + plural(free, 'fila libre', 'filas libres') + ' en la zona de pagos.' });
  return {
    ok: true, formId: 'carro', sid, lastRow: p, nextRow: r, maxRow, capacity: free,
    hints: { balance, paid: paid === null ? null : -paid, total: numAt(eng, sid, CAR.commitRow, CAR.commitCol), lastAmount, lastDate: p >= 0 ? numAt(eng, sid, p, CAR.S) : null },
    warnings,
  };
}
function carValidate(eng, prep, v, opts) {
  const errors = [], warnings = [], checks = [];
  const d = parseDateValue(v.date);
  if (d === null) errors.push({ field: 'date', msg: 'Elige la fecha del pago.' });
  const A = readAmount(v, 'amount', 'el monto del pago', errors, {});
  let amt = null;
  if (A) { amt = Math.abs(round2(A.value)); if (!(amt > 0)) { errors.push({ field: 'amount', msg: 'El monto del pago debe ser mayor que cero.' }); amt = null; } }
  const bal = prep.hints.balance;
  if (amt !== null && bal !== null) {
    checks.push({ key: 'saldo', ok: true, text: 'Saldo: ' + money(bal) + ' → ' + money(round2(bal - amt)) });
    if (amt > bal + 0.005) warnings.push({ code: 'over', field: 'amount', confirm: true, msg: 'El pago (' + money(amt) + ') supera el saldo pendiente (' + money(bal) + ').' });
  }
  if (d !== null && prep.hints.lastDate !== null && d < prep.hints.lastDate) warnings.push({ code: 'order', field: 'date', msg: 'La fecha es anterior al último pago registrado (' + dateText(prep.hints.lastDate) + ').' });
  if (d !== null && d > opts.today + 31) warnings.push({ code: 'future', field: 'date', confirm: true, msg: 'La fecha está más de un mes en el futuro.' });
  if (errors.length) return { errors, warnings, checks };
  return { errors, warnings, checks, parsed: { date: d, amount: amt } };
}
function carPlan(eng, prep, pz) {
  const sid = SHEETS.carro, r = prep.nextRow, p = prep.lastRow >= 0 ? prep.lastRow : CAR.first;
  return {
    sid, formId: 'carro', row: r, label: 'Pago del ' + dateText(pz.date),
    copies: [],
    writes: [{ r, c: CAR.S, raw: pz.date }, { r, c: CAR.V, raw: -pz.amount }],
    styles: [{ r, c: CAR.S, from: [p, CAR.S], nf: 'd-mmm' }, { r, c: CAR.V, from: [p, CAR.V] }],
    out: [
      { r: CAR.balRow, c: CAR.W, key: 'saldo', label: 'Saldo pendiente', kind: 'usd', primary: true, before: true },
      { r: CAR.totalRow, c: CAR.V, key: 'pagos', label: 'Pagos acumulados (negativos)', kind: 'usd', primary: false, before: true },
    ],
  };
}
function carSeed(eng, prep, plan) {
  const out = [];
  seedConst(eng, plan.sid, CAR.first, Math.max(prep.lastRow, CAR.first - 1), CAR.S, CAR.S, out);
  seedConst(eng, plan.sid, CAR.first, Math.max(prep.lastRow, CAR.first - 1), CAR.V, CAR.V, out);
  seedRaw(eng, plan.sid, CAR.totalRow, CAR.V, CAR.W, out);                   // total de pagos (V) y saldo (W)
  seedConst(eng, plan.sid, CAR.commitRow, CAR.commitRow, CAR.commitCol, CAR.commitCol, out);
  return { cells: out, rows: Math.max(prep.maxRow, plan.row) + 3, cols: 26 };
}
function carStatus(eng, opts) {
  const prep = carPrepare(eng, opts), h = prep.hints;
  if (h.balance === null) return { level: 'off', text: 'Sin datos', detail: 'No se pudo leer el saldo.' };
  if (h.balance <= 0.005) return { level: 'ok', text: 'Sin saldo pendiente', detail: h.lastDate !== null ? 'Último pago ' + dateText(h.lastDate) : '' };
  const ago = h.lastDate !== null ? opts.today - h.lastDate : null;
  return { level: ago !== null && ago > 45 ? 'warn' : 'info', text: 'Saldo ' + money(h.balance), detail: h.lastDate !== null ? 'Último pago ' + dateText(h.lastDate) + (ago > 0 ? ' (hace ' + ago + ' días)' : '') : 'Sin pagos registrados' };
}
const carro = makeForm({
  id: 'carro', key: 'carro', title: 'Pago del carro', icon: '🚗',
  desc: 'Registra un pago y mira el saldo pendiente antes y después.',
  prepare: carPrepare, validate: carValidate, plan: carPlan, seed: carSeed, status: carStatus,
});

/* ================================================================== RENOVAR PÓLIZA (se sobrescribe la MISMA fila; nunca se insertan ni se borran filas) */
/* Una póliza es una fila con CONSTANTES en monto (C), tasa en fracción (H), fecha de inicio (I) y días (K). El
 * vencimiento (J = I + K) y los intereses (E, F) son fórmulas de la fila y se recalculan solos. Las filas "espejo" que
 * leen esas celdas por referencia (resúmenes por banco, totales) tienen fórmulas, por eso no se confunden con pólizas. */
const POL = { first: 16, last: 105, A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, H: 7, I: 8, J: 9, K: 10, L: 11 };
const round8 = (x) => Math.round(x * 1e8) / 1e8;
/** lista las pólizas de la hoja, ordenadas por vencimiento: [{row,bank,dest,amount,rate,start,days,due,daysLeft,level,...}] */
export function listPolicies(eng, opts = {}) {
  const sid = needSheet(eng, 'poliza'), today = isNum(opts.today) ? opts.today : todaySerial();
  const out = [];
  for (let r = POL.first; r <= POL.last; r++) {
    const C = eng.raw(sid, r, POL.C), H = eng.raw(sid, r, POL.H), I = eng.raw(sid, r, POL.I), K = eng.raw(sid, r, POL.K);
    if (![C, H, I, K].every((x) => typeof x === 'number')) continue;
    if (!(C > 0 && H > 0 && H < 1 && I > 30000 && I < 80000 && Number.isInteger(K) && K >= 1)) continue;
    const due = numAt(eng, sid, r, POL.J) ?? I + K;
    const dl = due - today;
    out.push({
      row: r, rowNumber: r + 1,
      bank: textAt(eng, sid, r, POL.A) || textAt(eng, sid, r - 1, POL.A), dest: textAt(eng, sid, r, POL.D) || textAt(eng, sid, r, POL.B),
      amount: C, rate: H, start: I, days: K, due, daysLeft: dl,
      level: dl < 0 ? 'late' : dl <= 7 ? 'due' : dl <= 60 ? 'soon' : 'ok',
      interestTerm: numAt(eng, sid, r, POL.E), interestMonth: numAt(eng, sid, r, POL.F),
    });
  }
  return out.sort((a, b) => a.due - b.due || a.row - b.row);
}
function polPrepare(eng, opts) {
  const sid = needSheet(eng, 'poliza');
  const policies = listPolicies(eng, opts);
  if (!policies.length) throw new QuickError('No se encontraron pólizas en la hoja.');
  const exp = policies.filter((p) => p.daysLeft < 0), up = policies.filter((p) => p.daysLeft >= 0);
  const alerts = {
    expired: exp.length, oldestExpired: exp.length ? Math.min(...exp.map((p) => p.due)) : null,
    within7: up.filter((p) => p.daysLeft <= 7).length, within60: up.filter((p) => p.daysLeft <= 60).length,
    next: up.length ? { row: up[0].row, due: up[0].due, daysLeft: up[0].daysLeft } : null,
  };
  const defaults = {};
  for (const p of policies) defaults[p.row] = { amount: p.amount, rate: round8(p.rate * 100), start: p.due, days: p.days };
  const warnings = [];
  if (alerts.expired) warnings.push({ code: 'expired', level: 'warn', msg: alerts.expired + ' ' + plural(alerts.expired, 'póliza ya venció', 'pólizas ya vencieron') + ' y espera' + (alerts.expired === 1 ? '' : 'n') + ' renovación.' });
  return { ok: true, formId: 'poliza', sid, nextRow: null, policies, alerts, hints: { defaults }, warnings };
}
function polValidate(eng, prep, v, opts) {
  const errors = [], warnings = [], checks = [];
  const pol = prep.policies.find((p) => p.row === Number(v.row));
  if (!pol) errors.push({ field: 'row', msg: 'Elige la póliza que vas a renovar.' });
  const A = readAmount(v, 'amount', 'el monto', errors, { positive: true });
  const R = readAmount({ rate: String(v.rate ?? '').replace(/%/g, '') }, 'rate', 'la tasa', errors, { positive: true });
  const start = parseDateValue(v.start);
  if (start === null) errors.push({ field: 'start', msg: 'Elige la fecha de inicio.' });
  const days = Number(String(v.days ?? '').trim());
  if (String(v.days ?? '').trim() === '' || !Number.isInteger(days) || days < 1 || days > 5000) errors.push({ field: 'days', msg: 'Escribe los días del plazo (un número entero).' });
  if (R) {
    if (R.value >= 100) errors.push({ field: 'rate', msg: 'La tasa se escribe en porcentaje anual (por ejemplo 4.25).' });
    else if (R.value < 0.5 || R.value > 25) warnings.push({ code: 'rate', field: 'rate', confirm: true, msg: 'La tasa (' + R.value + '%) parece fuera de lo normal. Se escribe en porcentaje anual, por ejemplo 4.25.' });
  }
  if (errors.length || !pol) return { errors, warnings, checks };
  const frac = round8(R.value / 100), amount = round2(A.value);
  const due = start + days;
  checks.push({ key: 'due', ok: true, text: 'Nuevo vencimiento: ' + dateText(due) });
  if (start < pol.start) warnings.push({ code: 'earlier', field: 'start', confirm: true, msg: 'La nueva fecha de inicio (' + dateText(start) + ') es anterior a la actual (' + dateText(pol.start) + ').' });
  if (due < opts.today) warnings.push({ code: 'expired', field: 'days', confirm: true, msg: 'Con estos datos la póliza ya estaría vencida (' + dateText(due) + ').' });
  const writes = [];
  if (amount !== pol.amount) writes.push({ c: POL.C, raw: amount });
  if (frac !== pol.rate) writes.push({ c: POL.H, raw: frac });
  if (start !== pol.start) writes.push({ c: POL.I, raw: start });
  if (days !== pol.days) writes.push({ c: POL.K, raw: days });
  if (!writes.length) { errors.push({ field: null, msg: 'No hay cambios: los datos son iguales a los actuales.' }); return { errors, warnings, checks }; }
  return { errors, warnings, checks, parsed: { pol, amount, frac, start, days, due, writes } };
}
function polPlan(eng, prep, pz) {
  const sid = SHEETS.poliza, r = pz.pol.row;
  const outs = [[POL.E, 'Interés del plazo', 'usd', true], [POL.F, 'Interés mensual', 'usd', true], [POL.J, 'Vencimiento', 'date', true], [POL.L, 'Siguiente vencimiento', 'date', false]]
    .filter(([c]) => isFormulaAt(eng, sid, r, c));
  return {
    sid, formId: 'poliza', row: r, label: 'Póliza de la fila ' + (r + 1),
    copies: [], writes: pz.writes.map((w) => ({ r, c: w.c, raw: w.raw })), styles: [],
    out: outs.map(([c, label, kind, primary]) => ({ r, c, key: colLetter(c), label, kind, primary, before: true })),
  };
}
function polSeed(eng, prep, plan, pz) {
  const out = [];
  seedRaw(eng, plan.sid, plan.row, 0, POL.L, out);
  return { cells: out, rows: plan.row + 2, cols: POL.L + 1 };
}
/** totales de la hoja que cambian con una renovación (se leen en el motor real, antes y después) */
function polExtra(eng) {
  const sid = SHEETS.poliza, out = [];
  const t1 = numAt(eng, sid, 40, POL.C), t2 = numAt(eng, sid, 101, POL.C);
  if (t1 !== null) out.push({ key: 'inv', label: 'Total invertido', value: t1, kind: 'usd' });
  if (t2 !== null) out.push({ key: 'banco', label: 'Total por banco', value: t2, kind: 'usd' });
  return out;
}
function polStatus(eng, opts) {
  const prep = polPrepare(eng, opts), a = prep.alerts;
  if (a.expired) return { level: 'late', text: a.expired + ' ' + plural(a.expired, 'póliza vencida', 'pólizas vencidas'), detail: 'Venció ' + dateText(a.oldestExpired) };
  if (a.next && a.next.daysLeft <= 60) return { level: a.next.daysLeft <= 7 ? 'late' : 'warn', text: 'Vence ' + dateText(a.next.due), detail: a.within60 > 1 ? a.within60 + ' pólizas vencen en 60 días' : 'En ' + a.next.daysLeft + ' días' };
  return { level: 'ok', text: 'Sin vencimientos próximos', detail: a.next ? 'Próximo: ' + dateText(a.next.due) : '' };
}
const poliza = makeForm({
  id: 'poliza', key: 'poliza', title: 'Renovar póliza', icon: '🏦',
  desc: 'Actualiza monto, tasa, inicio y plazo de una póliza y revisa los vencimientos.',
  prepare: polPrepare, validate: polValidate, plan: polPlan, seed: polSeed, extra: polExtra, status: polStatus,
});

/* ================================================================== CONSUMO DE TARJETA DE CRÉDITO (hoja de consumos por corte) */
/* Solo se escriben A:E (mes, categoría, detalle o saldo diferido, monto, ajuste) en la primera fila libre. F:H son fórmulas
 * del renglón y del acumulado del corte: ya vienen prellenadas en unas filas y, pasadas esas, se copian de la fila anterior.
 * NUNCA se insertan ni se borran filas: los bloques de cálculo de la derecha y las otras hojas usan filas absolutas. */
const TCP = { first: 1, A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7 };
/** etiquetas de relleno como "xx", "xxx" o "xx/xxx/xxxx" (separadores de tramos): no son categorías */
const isFiller = (t) => /^[x\/\s-]+$/i.test(t);
const normText = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** fila donde empieza el corte abierto: la que reinicia el acumulado H (su fórmula no lee la H de la fila anterior) */
function tcpCutStart(eng, sid, p) {
  for (let r = p; r >= Math.max(TCP.first, p - 600); r--) {
    const f = eng.raw(sid, r, TCP.H);
    if (typeof f === 'number') return r;
    if (typeof f === 'string' && f[0] === '=' && !/H\d+/i.test(f)) return r;
  }
  return null;
}
/** categorías usadas en las últimas filas, de más a menos frecuentes (se conserva la escritura más usada de cada una) */
function tcpCategories(eng, sid, p) {
  const groups = new Map();
  for (let r = p; r >= Math.max(TCP.first, p - 400); r--) {
    const t = textAt(eng, sid, r, TCP.B);
    if (!t.trim() || isFiller(t.trim())) continue;
    const k = normText(t), g = groups.get(k) || { n: 0, forms: new Map() };
    g.n++; g.forms.set(t.trim(), (g.forms.get(t.trim()) || 0) + 1); groups.set(k, g);
  }
  const index = new Map(), list = [];
  for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
    const best = [...g.forms].sort((a, b) => b[1] - a[1])[0][0];
    index.set(k, best); list.push(best);
  }
  return { list: list.slice(0, 60), index };
}
function tcpPrepare(eng, opts) {
  const sid = needSheet(eng, 'tcpich'), sh = eng.sheet(sid);
  let p = -1;
  for (let r = Math.max(sh.rows - 1, TCP.first); r >= TCP.first; r--) if (filled(eng, sid, r, TCP.B) || filled(eng, sid, r, TCP.D)) { p = r; break; }
  if (p < 0) throw new QuickError('No se encontró el último consumo registrado.');
  if (!isFormulaAt(eng, sid, p, TCP.H)) throw new QuickError('La última fila no tiene la fórmula del acumulado (H).');
  const r = p + 1, tpl = [TCP.F, TCP.G, TCP.H].every((c) => isFormulaAt(eng, sid, r, c));
  const start = tcpCutStart(eng, sid, p), acc = numAt(eng, sid, p, TCP.H);
  let deferred = 0, count = 0;
  if (start !== null) for (let j = start; j <= p; j++) { const c = numAt(eng, sid, j, TCP.C); if (c !== null) deferred += c; if (filled(eng, sid, j, TCP.B) || filled(eng, sid, j, TCP.D)) count++; }
  const cats = tcpCategories(eng, sid, p);
  const warnings = [];
  const over = [0, 1, 2, 3, 4].filter((c) => filled(eng, sid, r, c)).map((c) => a1(r, c));
  if (over.length) warnings.push({ code: 'overwrite', level: 'info', msg: 'La fila ' + (r + 1) + ' ya tiene contenido (' + over.join(', ') + '); se reemplazará.', cells: over });
  if (start === null) warnings.push({ code: 'cut', level: 'info', msg: 'No se pudo identificar dónde empieza el corte abierto; no se mostrará la deuda del corte.' });
  return {
    ok: true, formId: 'tcpich', sid, lastRow: p, nextRow: r, hasTemplate: tpl,
    cut: { start, accumulated: acc, deferred, debt: acc === null ? null : acc + deferred, count },
    categories: cats.list, catIndex: cats.index, hints: { month: monthStart(monthNum(opts.today)) }, warnings,
  };
}
function tcpValidate(eng, prep, v, opts) {
  const errors = [], warnings = [], checks = [];
  const m = parseMonthValue(v.month);
  if (m === null) errors.push({ field: 'month', msg: 'Elige el mes del consumo.' });
  else if (Math.abs(monthNum(m) - monthNum(opts.today)) > 2) warnings.push({ code: 'month', field: 'month', confirm: true, msg: 'El mes (' + monthLabel(m) + ') está lejos del mes actual.' });
  const B = String(v.B ?? '').trim();
  if (!B) errors.push({ field: 'B', msg: 'Escribe la categoría o el comercio.' });
  else if (B.length > 60) errors.push({ field: 'B', msg: 'La categoría es demasiado larga (máximo 60 letras).' });
  else {
    const ex = prep.catIndex.get(normText(B));
    if (ex && ex.toLowerCase() !== B.toLowerCase()) warnings.push({ code: 'category', field: 'B', suggest: ex, msg: 'Se parece a la categoría «' + ex + '». Usa la misma escritura para que sume en las tablas por categoría.' });
  }
  const kind = v.cKind === 'diferido' ? 'diferido' : 'detalle';
  let C = null;
  if (kind === 'diferido') C = readAmount(v, 'C', 'el saldo diferido pendiente', errors, { nonneg: true });
  else {
    const t = String(v.C ?? '').trim();
    if (t) {
      if (/^[\s$\d.,+\-*/()=]+$/.test(t) && parseAmount(t).ok) warnings.push({ code: 'detail-number', field: 'C', confirm: true, msg: 'El detalle parece un número. Si es el saldo diferido pendiente de una cuota, elige «Saldo diferido»; así como está se guardará como texto.' });
      C = { text: t };
    }
  }
  const D = readAmount(v, 'D', 'el monto del consumo', errors, {});
  if (D && D.value === 0) errors.push({ field: 'D', msg: 'El monto del consumo no puede ser cero.' });
  if (D && D.value < 0) warnings.push({ code: 'negative', field: 'D', confirm: true, msg: 'El monto es negativo: los consumos suelen ser positivos (un reverso sí va en negativo).' });
  const E = readAmount(v, 'E', 'el ajuste', errors, { optional: true });
  if (E && Math.abs(E.value) > 10) warnings.push({ code: 'adjust', field: 'E', confirm: true, msg: 'El ajuste (' + money(E.value) + ') es grande; suele ser una comisión o un descuento pequeño. ¿Está bien?' });
  if (errors.length) return { errors, warnings, checks };
  return { errors, warnings, checks, parsed: { month: m, B, kind, C, D, E } };
}
function tcpPlan(eng, prep, pz) {
  const sid = SHEETS.tcpich, r = prep.nextRow, p = prep.lastRow;
  const cRaw = pz.C ? (pz.kind === 'diferido' ? pz.C.raw : pz.C.text) : null;
  return {
    sid, formId: 'tcpich', row: r, label: 'Consumo de ' + monthLabel(pz.month),
    copies: prep.hasTemplate ? [] : [{ r0: p, c0: TCP.F, r1: p, c1: TCP.H, dr: r, dc: TCP.F }],
    writes: [{ r, c: TCP.A, raw: pz.month }, { r, c: TCP.B, raw: pz.B }, { r, c: TCP.C, raw: cRaw }, { r, c: TCP.D, raw: pz.D.raw }, { r, c: TCP.E, raw: pz.E ? pz.E.raw : null }],
    styles: [0, 1, 2, 3, 4].map((c) => (c === 0 ? { r, c, from: [p, c], nf: 'mmm-yy' } : { r, c, from: [p, c] })),
    out: [['H', 'Acumulado del corte (columna H)', 'usd'], ['F', 'Total del renglón (columna F)', 'usd'], ['G', 'Total del renglón (columna G)', 'usd']].map(([col, label, kind]) => ({ r, c: COL[col], key: col, label, kind, primary: false })),
  };
}
function tcpSeed(eng, prep, plan) {
  const out = [], sid = plan.sid, p = prep.lastRow;
  seedConst(eng, sid, p - 1, p - 1, TCP.H, TCP.H, out);              // acumulado de la fila anterior a la última
  seedConst(eng, sid, p, p, TCP.D, TCP.E, out);                      // monto y ajuste de la última fila
  seedRaw(eng, sid, p, TCP.F, TCP.H, out);                           // fórmulas F:H de la última fila
  if (prep.hasTemplate) seedRaw(eng, sid, plan.row, TCP.F, TCP.H, out);   // plantilla ya prellenada en la fila nueva
  if (prep.cut.start !== null) seedConst(eng, sid, prep.cut.start, p, TCP.C, TCP.C, out);   // saldos diferidos del corte
  return { cells: out, rows: plan.row + 2, cols: 8 };
}
function tcpSummary(eng, prep, plan, pz, phase) {
  const sid = plan.sid, last = phase === 'before' ? prep.lastRow : plan.row;
  const acc = numAt(eng, sid, last, TCP.H);
  const out = [{ key: 'acum', label: 'Acumulado del corte', value: acc, kind: 'usd' }];
  if (prep.cut.start !== null) {
    let def = 0;
    for (let j = prep.cut.start; j <= last; j++) { const c = numAt(eng, sid, j, TCP.C); if (c !== null) def += c; }
    out.push({ key: 'diferidos', label: 'Saldo diferido pendiente', value: def, kind: 'usd' }, { key: 'deuda', label: 'Deuda del corte (consumos + diferidos)', value: acc === null ? null : acc + def, kind: 'usd' });
  }
  return out;
}
function tcpStatus(eng, opts) {
  const prep = tcpPrepare(eng, opts), c = prep.cut;
  if (c.start === null || c.debt === null) return { level: 'info', text: 'Fila ' + (prep.nextRow + 1) + ' libre', detail: '' };
  return { level: 'info', text: 'Deuda del corte ' + money(c.debt), detail: c.count + ' ' + plural(c.count, 'consumo', 'consumos') + ' en el corte abierto' };
}
const tcpich = makeForm({
  id: 'tcpich', key: 'tcpich', title: 'Consumo de tarjeta de crédito', icon: '💳',
  desc: 'Anota un consumo del corte abierto y mira el acumulado y la deuda del corte.',
  prepare: tcpPrepare, validate: tcpValidate, plan: tcpPlan, seed: tcpSeed, summary: tcpSummary, status: tcpStatus,
});

/* ================================================================== TARJETA Y CUENTA DE AHORROS (dos zonas en la misma hoja) */
/* Modo "tarjeta": concepto (G) y monto con signo (H: + consumo, − pago); la deuda acumulada (I) es fórmula.
 * Modo "cuenta": mes (A), concepto (B), monto con signo (E: + entra, − sale) y ajuste opcional (D); el saldo (F) es fórmula.
 * La libreta de la cuenta comparte filas y columna F con otra tabla, por eso solo puede crecer hasta la fila PRB.acctMax.
 * No se tocan los bloques de cálculo ni la tabla pegada de la derecha. */
const PRB = { cardFirst: 65, acctFirst: 62, acctMax: 165, A: 0, B: 1, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8 };
function prbCounts(eng, sid, col, from, to) {
  const g = new Map();
  for (let r = to; r >= from; r--) {
    const t = textAt(eng, sid, r, col).trim();
    if (!t || isFiller(t)) continue;
    const k = normText(t), x = g.get(k) || { n: 0, forms: new Map() };
    x.n++; x.forms.set(t, (x.forms.get(t) || 0) + 1); g.set(k, x);
  }
  return [...g].sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([, x]) => [...x.forms].sort((a, b) => b[1] - a[1])[0][0]);
}
/** pagos de la cuenta (monto negativo, concepto con "pago") que no tienen su par (monto negativo con "pago") en la tarjeta */
function prbUnpaired(eng, sid, acctLast, cardLast) {
  const pays = [], cardPays = [];
  for (let r = PRB.cardFirst; r <= acctLast; r++) { const e = numAt(eng, sid, r, PRB.E); if (e !== null && e < 0 && /pago/i.test(textAt(eng, sid, r, PRB.B))) pays.push({ row: r, amount: -e, month: numAt(eng, sid, r, PRB.A) }); }
  for (let r = PRB.cardFirst; r <= cardLast; r++) { const h = numAt(eng, sid, r, PRB.H); if (h !== null && h < 0 && /pago/i.test(textAt(eng, sid, r, PRB.G))) cardPays.push({ amount: -h, used: false }); }
  const out = [];
  for (const p of pays) { const m = cardPays.find((c) => !c.used && Math.abs(c.amount - p.amount) < 0.005); if (m) m.used = true; else out.push(p); }
  return out;
}
function prbPrepare(eng, opts) {
  const sid = needSheet(eng, 'produb'), sh = eng.sheet(sid);
  const mode = opts.mode === 'cuenta' ? 'cuenta' : 'tarjeta';
  let cp = -1;
  for (let r = Math.max(sh.rows - 1, PRB.cardFirst); r >= PRB.cardFirst; r--) if (filled(eng, sid, r, PRB.G) || filled(eng, sid, r, PRB.H)) { cp = r; break; }
  if (cp < 0) throw new QuickError('No se encontró el último consumo de la tarjeta.');
  if (!isFormulaAt(eng, sid, cp, PRB.I)) throw new QuickError('La última fila de la tarjeta no tiene la fórmula del saldo (I).');
  let ap = -1;
  for (let r = PRB.acctMax; r >= PRB.acctFirst; r--) if (filled(eng, sid, r, PRB.A) || filled(eng, sid, r, PRB.B) || filled(eng, sid, r, PRB.E)) { ap = r; break; }
  if (ap < 0) throw new QuickError('No se encontró el último movimiento de la cuenta.');
  if (!isFormulaAt(eng, sid, ap, PRB.F)) throw new QuickError('La última fila de la cuenta no tiene la fórmula del saldo (F).');
  const cr = cp + 1, ar = ap + 1, full = ar > PRB.acctMax, free = Math.max(0, PRB.acctMax - ar + 1);
  const warnings = [];
  const cOver = [PRB.G, PRB.H].filter((c) => filled(eng, sid, cr, c)).map((c) => a1(cr, c));
  const aOver = full ? [] : [PRB.A, PRB.B, PRB.D, PRB.E, PRB.F].filter((c) => filled(eng, sid, ar, c)).map((c) => a1(ar, c));
  const over = mode === 'cuenta' ? aOver : cOver;
  if (over.length) warnings.push({ code: 'overwrite', level: 'info', msg: 'La fila ' + ((mode === 'cuenta' ? ar : cr) + 1) + ' ya tiene contenido (' + over.join(', ') + '); se reemplazará.', cells: over });
  if (mode === 'cuenta' && full) warnings.push({ code: 'full', level: 'warn', msg: 'La libreta de la cuenta no tiene filas libres: llega hasta la fila ' + (PRB.acctMax + 1) + ' porque debajo hay datos de otra tabla.' });
  else if (mode === 'cuenta' && free <= 5) warnings.push({ code: 'capacity', level: 'warn', msg: 'Quedan ' + free + ' ' + plural(free, 'fila libre', 'filas libres') + ' en la libreta de la cuenta.' });
  const unpaired = prbUnpaired(eng, sid, ap, cp);
  if (unpaired.length) warnings.push({ code: 'unpaired', level: 'warn', msg: (unpaired.length === 1 ? 'Un pago de la cuenta' : unpaired.length + ' pagos de la cuenta') + ' no aparece' + (unpaired.length === 1 ? '' : 'n') + ' registrado' + (unpaired.length === 1 ? '' : 's') + ' en la tarjeta: ' + unpaired.map((u) => money(u.amount) + (u.month ? ' (' + monthLabel(u.month) + ')' : '')).join(', ') + '.', unpaired });
  return {
    ok: true, formId: 'produb', sid, mode, nextRow: mode === 'cuenta' ? (full ? null : ar) : cr,
    card: { lastRow: cp, nextRow: cr, hasTemplate: isFormulaAt(eng, sid, cr, PRB.I), debt: numAt(eng, sid, cp, PRB.I), concepts: prbCounts(eng, sid, PRB.G, Math.max(PRB.cardFirst, cp - 120), cp) },
    account: { lastRow: ap, nextRow: full ? null : ar, full, free, balance: numAt(eng, sid, ap, PRB.F), concepts: prbCounts(eng, sid, PRB.B, Math.max(PRB.acctFirst, ap - 80), ap), month: numAt(eng, sid, ap, PRB.A) },
    unpaired, hints: { month: monthStart(monthNum(opts.today)) }, warnings,
  };
}
function prbValidate(eng, prep, v, opts) {
  const errors = [], warnings = [], checks = [];
  const mode = v.mode === 'cuenta' ? 'cuenta' : 'tarjeta';
  if (mode === 'tarjeta') {
    const G = String(v.G ?? '').trim();
    if (!G) errors.push({ field: 'G', msg: 'Escribe el concepto del consumo o del pago.' });
    const H = readAmount(v, 'H', 'el monto', errors, {});
    if (H && H.value === 0) errors.push({ field: 'H', msg: 'El monto no puede ser cero.' });
    if (H && G && H.value > 0 && /pago/i.test(G)) warnings.push({ code: 'sign', field: 'H', confirm: true, msg: 'Un pago de la tarjeta se registra con monto negativo. ¿Seguro que es positivo?' });
    if (errors.length) return { errors, warnings, checks };
    return { errors, warnings, checks, parsed: { mode, G, H } };
  }
  if (prep.account.nextRow === null) errors.push({ field: null, msg: 'La libreta de la cuenta no tiene filas libres: llega hasta la fila ' + (PRB.acctMax + 1) + '.' });
  const m = parseMonthValue(v.A);
  if (m === null) errors.push({ field: 'A', msg: 'Elige el mes del movimiento.' });
  else if (Math.abs(monthNum(m) - monthNum(opts.today)) > 2) warnings.push({ code: 'month', field: 'A', confirm: true, msg: 'El mes (' + monthLabel(m) + ') está lejos del mes actual.' });
  const B = String(v.B ?? '').trim();
  if (!B) errors.push({ field: 'B', msg: 'Escribe el concepto del movimiento.' });
  const E = readAmount(v, 'E', 'el monto', errors, {});
  if (E && E.value === 0) errors.push({ field: 'E', msg: 'El monto no puede ser cero.' });
  const D = readAmount(v, 'D', 'el ajuste', errors, { optional: true });
  if (E && B && E.value > 0 && /pago/i.test(B)) warnings.push({ code: 'sign', field: 'E', confirm: true, msg: 'Un pago sale de la cuenta: se registra con monto negativo. ¿Seguro que es positivo?' });
  const alsoCard = (v.alsoCard === true || v.alsoCard === 'true' || v.alsoCard === 'on') && E !== null && E.value < 0;
  if (errors.length) return { errors, warnings, checks };
  return { errors, warnings, checks, parsed: { mode, month: m, B, E, D, alsoCard } };
}
function prbPlan(eng, prep, pz) {
  const sid = SHEETS.produb;
  const plan = { sid, formId: 'produb', copies: [], writes: [], styles: [], out: [] };
  const cardRow = (G, hRaw) => {
    const r = prep.card.nextRow, p = prep.card.lastRow;
    plan.writes.push({ r, c: PRB.G, raw: G }, { r, c: PRB.H, raw: hRaw });
    if (!prep.card.hasTemplate) plan.copies.push({ r0: p, c0: PRB.I, r1: p, c1: PRB.I, dr: r, dc: PRB.I });
    plan.styles.push({ r, c: PRB.G, from: [p, PRB.G] }, { r, c: PRB.H, from: [p, PRB.H] });
    plan.out.push({ r, c: PRB.I, key: 'I', label: 'Deuda acumulada de la tarjeta (columna I)', kind: 'usd', primary: false });
    return r;
  };
  if (pz.mode === 'cuenta') {
    const r = prep.account.nextRow, p = prep.account.lastRow;
    plan.row = r; plan.label = 'Movimiento de ' + monthLabel(pz.month);
    plan.copies.push({ r0: p, c0: PRB.F, r1: p, c1: PRB.F, dr: r, dc: PRB.F });
    plan.writes.push({ r, c: PRB.A, raw: pz.month }, { r, c: PRB.B, raw: pz.B }, { r, c: PRB.D, raw: pz.D ? pz.D.raw : null }, { r, c: PRB.E, raw: pz.E.raw });
    for (const c of [PRB.A, PRB.B, PRB.D, PRB.E]) plan.styles.push(c === PRB.A ? { r, c, from: [p, c], nf: 'mmm-yy' } : { r, c, from: [p, c] });
    plan.out.push({ r, c: PRB.F, key: 'F', label: 'Saldo de la cuenta (columna F)', kind: 'usd', primary: false });
    if (pz.alsoCard) plan.cardRow = cardRow('pago', round2(pz.E.value));
  } else {
    plan.label = pz.G.slice(0, 40);
    plan.row = cardRow(pz.G, pz.H.raw);
  }
  return plan;
}
function prbSeed(eng, prep, plan, pz) {
  const out = [], sid = plan.sid;
  const seedAcct = () => {
    const p = prep.account.lastRow, r = prep.account.nextRow;
    seedConst(eng, sid, p - 1, p - 1, PRB.F, PRB.F, out); seedConst(eng, sid, p, p, PRB.D, PRB.E, out); seedRaw(eng, sid, p, PRB.F, PRB.F, out);
    return r;
  };
  const seedCard = () => {
    const p = prep.card.lastRow, r = prep.card.nextRow;
    seedConst(eng, sid, p - 1, p - 1, PRB.I, PRB.I, out); seedConst(eng, sid, p, p, PRB.H, PRB.H, out); seedRaw(eng, sid, p, PRB.I, PRB.I, out);
    if (prep.card.hasTemplate) seedRaw(eng, sid, r, PRB.I, PRB.I, out);
    return r;
  };
  let rows = 0;
  if (pz.mode === 'cuenta') { rows = seedAcct() + 2; if (pz.alsoCard) rows = Math.max(rows, seedCard() + 2); }
  else rows = seedCard() + 2;
  return { cells: out, rows, cols: 10 };
}
function prbSummary(eng, prep, plan, pz, phase) {
  const sid = plan.sid, out = [];
  if (pz.mode === 'cuenta') out.push({ key: 'saldo', label: 'Saldo de la cuenta', value: numAt(eng, sid, phase === 'before' ? prep.account.lastRow : plan.row, PRB.F), kind: 'usd' });
  if (pz.mode === 'tarjeta' || pz.alsoCard) {
    const cardRowAfter = pz.mode === 'tarjeta' ? plan.row : plan.cardRow;
    out.push({ key: 'deuda', label: 'Deuda de la tarjeta', value: numAt(eng, sid, phase === 'before' ? prep.card.lastRow : cardRowAfter, PRB.I), kind: 'usd' });
  }
  return out;
}
function prbStatus(eng, opts) {
  const prep = prbPrepare(eng, opts), n = prep.unpaired.length;
  return {
    level: n ? 'warn' : 'info',
    text: 'Tarjeta ' + money(prep.card.debt) + ' · cuenta ' + money(prep.account.balance),
    detail: n ? (n === 1 ? '1 pago de la cuenta sin registrar en la tarjeta' : n + ' pagos de la cuenta sin registrar en la tarjeta') : (prep.account.full ? 'La libreta de la cuenta está llena' : ''),
  };
}
const produb = makeForm({
  id: 'produb', key: 'produb', title: 'Tarjeta y cuenta de ahorros', icon: '🧾',
  desc: 'Consumos y pagos de la tarjeta, o movimientos de la cuenta que la paga.',
  prepare: prbPrepare, validate: prbValidate, plan: prbPlan, seed: prbSeed, summary: prbSummary, status: prbStatus,
});

/* ================================================================== registro de formularios */
export { luz, pension, carro, poliza, tcpich, produb };
export const FORMS = [luz, pension, carro, poliza, tcpich, produb];
export const API = Object.fromEntries(FORMS.map((f) => [f.id, f]));
export const getForm = (id) => API[id] || null;
/** cambia el título o la descripción de un formulario (p. ej. con nombres propios que no deben vivir en el código) */
export function setFormInfo(id, patch) { const f = API[id]; if (f) Object.assign(f, patch || {}); }
/** título y descripción a mostrar: los del formulario, o los de `quick` en el catálogo de la hoja (meta.catalog[hoja].quick) */
export function formInfo(form, eng) {
  let title = form.title, desc = form.desc;
  try {
    const sh = eng && eng.sheet && eng.sheet(form.sid), q = sh && eng.meta && eng.meta.catalog && eng.meta.catalog[sh.name] && eng.meta.catalog[sh.name].quick;
    if (q && q.title) title = q.title;
    if (q && q.desc) desc = q.desc;
  } catch (e) { /* se usan los textos por omisión */ }
  return { title, desc };
}

/* ================================================================== INTERFAZ: menú "Registrar" y formularios */
/* mountHub(el, ctx)            -> {destroy(), refresh()}   tarjetas con el estado de cada formulario
 * mountForm(el, ctx, formId)   -> {destroy(), refresh()}   formulario en la misma pantalla (no modal)
 * ctx = {engine, changed(sids), navigate(ruta), openSheet(sid,{r,c}), toast, confirm, modal, ui, today()}  (ver app.js) */
const STATUS_ICON = { ok: '✓', warn: '!', late: '!', info: '•', off: '–', load: '…' };
function renderStatus(node, s) {
  node.className = 'qk-st qk-st-' + (s.level || 'info');
  node.replaceChildren(
    el('i', { class: 'qk-dot', 'aria-hidden': 'true', text: STATUS_ICON[s.level] || '•' }),
    el('span', { class: 'qk-st-t' }, el('b', { text: s.text }), s.detail ? el('small', { text: s.detail }) : null),
  );
}
const todayOf = (ctx) => (typeof ctx.today === 'function' ? ctx.today() : todaySerial());

/* ---------------------------------------------------------------- menú */
export function mountHub(host, ctx) {
  let dead = false, token = 0;
  const root = el('div', { class: 'qk-hub' });
  host.append(root);
  const cards = new Map();
  root.append(el('header', { class: 'qk-hub-head' },
    el('h2', { text: 'Registrar' }),
    el('p', { class: 'muted', text: 'Registros periódicos que no son movimientos del banco. Elige uno y se anota en la fila correcta de su hoja.' })));
  const grid = el('div', { class: 'qk-grid' });
  for (const f of FORMS) {
    const info = formInfo(f, ctx.engine);
    const st = el('span', { class: 'qk-st qk-st-load' }, el('i', { class: 'qk-dot', 'aria-hidden': 'true', text: '…' }), el('span', { class: 'qk-st-t' }, el('b', { text: 'Calculando…' })));
    const card = el('button', { class: 'qk-card', type: 'button', 'data-form': f.id, onclick: () => ctx.navigate('registrar/' + f.id) },
      el('span', { class: 'qk-ico', 'aria-hidden': 'true', text: f.icon }),
      el('span', { class: 'qk-card-body' }, el('span', { class: 'qk-card-title', text: info.title }), el('span', { class: 'qk-card-desc', text: info.desc }), st),
      el('span', { class: 'qk-chev', 'aria-hidden': 'true', html: '&rsaquo;' }));
    grid.append(card); cards.set(f.id, { card, st });
  }
  root.append(grid);
  async function paint(silent) {
    const my = ++token, eng = ctx.engine;
    if (!eng) return;
    const today = todayOf(ctx);
    for (const f of FORMS) {
      const c = cards.get(f.id), sh = eng.sheet(f.sid);
      if (!sh) { renderStatus(c.st, { level: 'off', text: 'No disponible', detail: 'Falta la hoja de este formulario' }); c.card.disabled = true; continue; }
      if (!sh.loaded && eng.loadSheetAsync) { if (!silent) renderStatus(c.st, { level: 'load', text: 'Calculando…' }); await eng.loadSheetAsync(f.sid); }
      if (dead || my !== token) return;
      renderStatus(c.st, f.status(eng, { today }));
    }
  }
  const t = document.getElementById('title'); if (t) t.textContent = 'Registrar';
  paint(false);
  return { destroy() { dead = true; root.remove(); }, refresh() { paint(true); } };
}

/* ---------------------------------------------------------------- especificación de pantalla de cada formulario */
const hasMonthInput = (() => { let r = null; return () => { if (r === null) { try { const i = document.createElement('input'); i.setAttribute('type', 'month'); r = i.type === 'month'; } catch (e) { r = false; } } return r; }; })();
const numStr = (v) => (v === null || v === undefined || !Number.isFinite(+v) ? '' : String(round2(+v)));
const fmtInt = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US'));
const prevText = (label, v, fmt = money) => (v === null || v === undefined ? '' : label + ': ' + fmt(v) + '.');
const pensionHelp = (h) => {
  if (h.rule === 'doble') return 'Diciembre: el doble del monto base (' + money(h.base) + ' × 2).';
  if (h.rule === 'sbu') return h.sbu ? 'Marzo: monto base + un SBU (estimado ' + money(h.sbu) + ').' : 'Marzo: se suma un SBU al monto base; no hay un marzo anterior para estimarlo.';
  return 'Sugerido: igual al mes anterior (' + money(h.base) + ').';
};
const levelText = { late: 'Vencida', due: 'Vence pronto', soon: 'Próxima', ok: 'Vigente' };
const polBadge = (p) => (p.daysLeft < 0 ? 'Venció ' + dateText(p.due) : 'Vence ' + dateText(p.due) + ' · ' + (p.daysLeft === 0 ? 'hoy' : 'en ' + p.daysLeft + ' ' + plural(p.daysLeft, 'día', 'días')));

const UI = {
  luz: {
    save: 'Guardar factura',
    defaults: (p) => ({ month: monthInputValue(p.month), days: String(p.hints.days) }),
    band: (p) => {
      const out = ['Se escribirá en la fila ' + (p.nextRow + 1) + ' · último mes registrado: ' + monthLabel(p.prev.month) + '.'];
      if (p.missing.count) out.push({ level: p.missing.count >= 3 ? 'late' : 'warn', text: (p.missing.count === 1 ? 'Falta 1 factura: ' : 'Faltan ' + p.missing.count + ' facturas: ') + monthLabel(p.missing.months[0]) + (p.missing.count > 1 ? ' a ' + monthLabel(p.missing.months[p.missing.count - 1]) : '') + '.' });
      return out;
    },
    fields: (S, p) => [
      { key: 'month', type: 'month', label: 'Mes de la factura', help: 'Siguiente mes del cuadro: ' + monthLabel(p.month) + '.' },
      { key: 'C', type: 'money', ops: true, unit: '$', label: 'Consumo (USD)', ph: 'p. ej. 60+30+0.5', help: prevText('Mes anterior', p.prev.C) },
      { key: 'E', type: 'money', ops: true, unit: '$', label: 'Total de la planilla (USD)', ph: 'p. ej. 50+30+0.5', help: prevText('Mes anterior', p.prev.E) },
      { key: 'K', type: 'money', ops: true, label: 'Lectura neta del medidor', ph: 'p. ej. 25000-4000', help: 'Lectura anterior: ' + fmtInt(p.prev.K) + '. Puede ser una resta.' },
      { key: 'O', type: 'money', ops: true, unit: '$', label: 'Subsidio o descuento (USD)', ph: 'p. ej. 30+0.5', help: prevText('Mes anterior', p.prev.O) },
      { key: 'P', type: 'money', ops: true, unit: '$', label: 'Valor de la factura (a pagar)', ph: 'p. ej. 50', help: prevText('Mes anterior', p.prev.P) },
      { key: 'T', type: 'money', ops: true, unit: 'kWh', label: 'Energía generada por los paneles', ph: 'p. ej. 100', help: prevText('Mes anterior', p.prev.T, (v) => fmtInt(v) + ' kWh') },
      { key: 'days', type: 'int', unit: 'días', label: 'Días del período', ph: '30', help: 'El mes anterior usó ' + p.hints.days + ' días. Se usa para el consumo por día.' },
    ],
  },
  pension: {
    save: 'Guardar pensión',
    defaults: (p) => ({ month: monthInputValue(p.next.serial), amount: numStr(p.hints.suggested) }),
    band: (p) => ['Se escribirá en la fila ' + (p.nextRow + 1) + ' · último mes registrado: ' + p.last.label + '.'].concat(p.missing.count ? [{ level: p.missing.count >= 2 ? 'late' : 'warn', text: p.missing.count === 1 ? 'Pendiente: ' + p.next.label + '.' : 'Faltan ' + p.missing.count + ' meses: ' + monthLabel(p.missing.months[0]) + ' a ' + monthLabel(p.missing.months[p.missing.count - 1]) + '.' }] : []),
    fields: (S, p) => [
      { key: 'month', type: 'month', label: 'Mes', help: 'Siguiente mes del cuadro: ' + p.next.label + '.' },
      { key: 'amount', type: 'money', ops: true, unit: '$', label: 'Monto del mes (USD)', ph: 'p. ej. 1000', help: pensionHelp(p.hints) },
    ],
  },
  carro: {
    save: 'Guardar pago',
    defaults: (p, S) => ({ date: S.today ? dateInputValue(S.today) : '', amount: numStr(p.hints.lastAmount) }),
    band: (p) => ['Se escribirá en la fila ' + (p.nextRow + 1) + ' · quedan ' + p.capacity + ' ' + plural(p.capacity, 'fila libre', 'filas libres') + '.', 'Saldo pendiente: ' + money(p.hints.balance) + (p.hints.paid !== null ? ' · pagado: ' + money(p.hints.paid) : '') + '.'],
    fields: (S, p) => [
      { key: 'date', type: 'date', label: 'Fecha del pago', help: p.hints.lastDate !== null ? 'Último pago: ' + dateText(p.hints.lastDate) + '.' : '' },
      { key: 'amount', type: 'money', ops: true, unit: '$', label: 'Monto pagado (USD)', ph: 'p. ej. 250', help: prevText('Pago anterior', p.hints.lastAmount) },
    ],
  },
  poliza: {
    save: 'Guardar renovación',
    picker: true,
    defaults: (p, S) => {
      const row = S.values.row != null && p.policies.some((x) => x.row === Number(S.values.row)) ? Number(S.values.row) : p.policies[0].row, d = p.hints.defaults[row];
      return { row, amount: numStr(d.amount), rate: String(d.rate), start: dateInputValue(d.start), days: String(d.days) };
    },
    band: (p) => {
      const a = p.alerts, out = [];
      if (a.expired) out.push({ level: 'late', text: a.expired + ' ' + plural(a.expired, 'póliza venció', 'pólizas vencieron') + ' y espera' + (a.expired === 1 ? '' : 'n') + ' renovación.' });
      if (a.within60) out.push({ level: a.within7 ? 'late' : 'warn', text: a.within60 + ' ' + plural(a.within60, 'póliza vence', 'pólizas vencen') + ' en los próximos 60 días.' });
      if (!out.length) out.push('Sin vencimientos en los próximos 60 días.');
      return out;
    },
    fields: (S, p) => [
      { key: 'amount', type: 'money', ops: true, unit: '$', label: 'Nuevo monto (USD)', ph: 'p. ej. 10000' },
      { key: 'rate', type: 'money', unit: '%', label: 'Tasa anual (%)', ph: 'p. ej. 4.25', help: 'Se guarda en fracción (4.25 → 0.0425).' },
      { key: 'start', type: 'date', label: 'Fecha de inicio', help: 'Por omisión, el vencimiento de la póliza actual.' },
      { key: 'days', type: 'int', unit: 'días', label: 'Plazo en días', ph: '30' },
    ],
  },
  tcpich: {
    save: 'Guardar consumo',
    defaults: (p, S) => ({ month: monthInputValue(p.hints.month), cKind: S.values.cKind || 'detalle' }),
    band: (p) => {
      const out = ['Se escribirá en las columnas A a E de la fila ' + (p.nextRow + 1) + (p.hasTemplate ? '.' : ' (las columnas F a H se copiarán de la fila anterior).')];
      if (p.cut.start !== null && p.cut.debt !== null) out.push('Corte abierto desde la fila ' + (p.cut.start + 1) + ' · acumulado ' + money(p.cut.accumulated) + ' · deuda del corte ' + money(p.cut.debt) + '.');
      return out;
    },
    fields: (S, p) => {
      const dif = S.values.cKind === 'diferido';
      return [
        { key: 'month', type: 'month', label: 'Mes del consumo', help: 'Se guarda el primer día del mes.' },
        { key: 'B', type: 'text', list: p.categories, label: 'Categoría o comercio', ph: 'Elige o escribe', help: 'Escríbela igual que en consumos anteriores: las tablas por categoría comparan el texto exacto.' },
        { key: 'cKind', type: 'seg', label: 'La columna C es', options: [['detalle', 'Detalle'], ['diferido', 'Saldo diferido']] },
        dif ? { key: 'C', type: 'money', ops: true, unit: '$', label: 'Saldo diferido pendiente (USD)', ph: 'p. ej. 100-25', help: 'Lo que queda por pagar después de la cuota de este mes.' }
          : { key: 'C', type: 'text', label: 'Detalle (opcional)', ph: 'p. ej. nombre del comercio', help: 'Texto libre. Un número aquí se tomaría como saldo diferido.' },
        { key: 'D', type: 'money', ops: true, unit: '$', label: dif ? 'Cuota o monto del mes (USD)' : 'Monto del consumo (USD)', ph: 'p. ej. 42.48+6.01' },
        { key: 'E', type: 'money', ops: true, unit: '$', label: 'Ajuste (opcional)', ph: 'p. ej. 0.31', help: 'Comisión, IVA o interés (+); descuento o reverso (−).' },
      ];
    },
  },
  produb: {
    save: 'Guardar',
    defaults: (p, S) => ({ mode: S.values.mode || 'tarjeta', A: monthInputValue(p.hints.month) }),
    band: (p, S) => (S.values.mode === 'cuenta'
      ? [p.account.nextRow === null ? { level: 'late', text: 'La libreta de la cuenta está llena.' } : 'Se escribirá en la fila ' + (p.account.nextRow + 1) + ' · saldo de la cuenta ' + money(p.account.balance) + ' · quedan ' + p.account.free + ' ' + plural(p.account.free, 'fila libre', 'filas libres') + '.']
      : ['Se escribirá en la fila ' + (p.card.nextRow + 1) + ' · deuda de la tarjeta ' + money(p.card.debt) + '.']),
    fields: (S, p) => {
      const cuenta = S.values.mode === 'cuenta';
      const mode = { key: 'mode', type: 'seg', label: '¿Qué vas a registrar?', options: [['tarjeta', 'Tarjeta'], ['cuenta', 'Cuenta de ahorros']] };
      if (!cuenta) return [mode,
        { key: 'G', type: 'text', list: p.card.concepts, label: 'Concepto', ph: 'p. ej. compra en línea', help: 'Consumo o pago de la tarjeta.' },
        { key: 'H', type: 'money', ops: true, unit: '$', label: 'Monto (USD)', ph: 'p. ej. 25.50 o -100', help: 'Positivo = consumo. Negativo = pago o crédito.' }];
      const showPair = /pago/i.test(String(S.values.B || '')) && parseAmount(S.values.E).ok && parseAmount(S.values.E).value < 0;
      return [mode,
        { key: 'A', type: 'month', label: 'Mes del movimiento', help: 'Se guarda el primer día del mes.' },
        { key: 'B', type: 'text', list: p.account.concepts, label: 'Concepto', ph: 'p. ej. depósito' },
        { key: 'E', type: 'money', ops: true, unit: '$', label: 'Monto con signo (USD)', ph: 'p. ej. 100 o -50', help: 'Positivo = entra dinero. Negativo = sale (pago, retiro).' },
        { key: 'D', type: 'money', ops: true, unit: '$', label: 'Ajuste o impuesto (opcional)', ph: 'p. ej. -0.31', help: 'Con signo; entra en el saldo.' },
        showPair ? { key: 'alsoCard', type: 'check', label: 'También registrar este pago en la tarjeta (monto negativo)' } : null].filter(Boolean);
    },
  },
};

/* ---------------------------------------------------------------- formulario */
export function mountForm(host, ctx, formId) {
  const form = getForm(formId), spec = UI[formId];
  const root = el('div', { class: 'qk-form' });
  host.append(root);
  if (!form || !spec) {
    root.append(el('div', { class: 'card' }, el('h2', { text: 'Formulario no encontrado' }), el('p', { class: 'muted', text: 'Ese registro no existe en esta versión.' }), el('button', { class: 'btn', type: 'button', text: 'Volver a Registrar', onclick: () => ctx.navigate('registrar') })));
    return { destroy() { root.remove(); }, refresh() {} };
  }
  const S = { dead: false, prep: null, values: {}, touched: new Set(), showErrors: false, preview: null, last: null, saving: false, today: undefined, refreshes: 0, sig: '', timer: 0 };
  const els = { inputs: {}, defs: {}, help: {}, err: {}, live: {} };
  const eng = () => ctx.engine;
  const info = formInfo(form, ctx.engine);
  const optsNow = () => { const o = { today: S.today }; if (formId === 'produb') o.mode = S.values.mode || 'tarjeta'; return o; };
  const collect = () => Object.assign({}, S.values);

  /* ----- esqueleto ----- */
  els.save = el('button', { class: 'btn primary qk-save', type: 'button', text: spec.save, onclick: () => save(false) });
  els.view = el('button', { class: 'btn ghost qk-view', type: 'button', text: 'Ver hoja', onclick: () => { const r = S.prep && S.prep.ok ? (S.values.row != null && formId === 'poliza' ? Number(S.values.row) : S.prep.nextRow) : null; ctx.openSheet(form.sid, r != null ? { r, c: 0 } : {}); } });
  els.band = el('div', { class: 'qk-band', role: 'status' });
  els.picker = el('div', { class: 'qk-picker' });
  els.fields = el('form', { class: 'qk-fields', novalidate: true, 'aria-label': info.title, onsubmit: (e) => { e.preventDefault(); save(false); } });
  els.notes = el('div', { class: 'qk-notes' });
  els.preview = el('section', { class: 'card qk-preview', 'aria-live': 'polite', 'aria-label': 'Vista previa de lo que se guardará' });
  els.last = el('section', { class: 'qk-last', hidden: true, 'aria-label': 'Último registro guardado' });
  els.bar = el('div', { class: 'qk-bar' }, els.save, els.view);
  els.loading = el('div', { class: 'empty' }, el('div', { class: 'spin' }), 'Preparando la hoja…');
  root.append(
    el('button', { class: 'btn ghost qk-back', type: 'button', onclick: () => ctx.navigate('registrar') }, '‹ Registrar'),
    el('header', { class: 'qk-title' }, el('span', { class: 'qk-ico big', 'aria-hidden': 'true', text: form.icon }), el('div', {}, el('h2', { text: info.title }), el('p', { class: 'muted small', text: info.desc }))),
    els.loading, els.band, els.picker, els.fields, els.notes, els.preview, els.last, els.bar);
  els.save.disabled = true;
  const tt = document.getElementById('title'); if (tt) tt.textContent = info.title;

  /* ----- campos ----- */
  function insertAtCaret(input, ch) {
    input.focus();
    const a = input.selectionStart == null ? input.value.length : input.selectionStart, b = input.selectionEnd == null ? a : input.selectionEnd;
    input.setRangeText(ch, a, b, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function buildField(f) {
    const id = 'qk-' + formId + '-' + f.key;
    els.defs[f.key] = f;
    const help = els.help[f.key] = el('div', { class: 'qk-help', id: id + '-h', text: f.help || '' });
    const err = els.err[f.key] = el('div', { class: 'qk-err', id: id + '-e', role: 'alert' });
    const live = els.live[f.key] = el('div', { class: 'qk-live', id: id + '-l' });
    const wrap = el('div', { class: 'field qk-field', 'data-key': f.key });
    if (f.type === 'seg') {
      const grp = el('div', { class: 'seg qk-seg', role: 'radiogroup', 'aria-label': f.label });
      for (const [val, text] of f.options) grp.append(el('button', { type: 'button', role: 'radio', 'aria-checked': S.values[f.key] === val ? 'true' : 'false', class: S.values[f.key] === val ? 'on' : '', 'data-val': val, text, onclick: () => { S.values[f.key] = val; S.touched.add(f.key); onChange(f.key, true); } }));
      els.inputs[f.key] = grp;
      wrap.append(el('div', { class: 'qk-lbl', id: id + '-lbl', text: f.label }), grp);
      return wrap;
    }
    if (f.type === 'check') {
      const cb = el('input', { type: 'checkbox', id, 'data-key': f.key });
      cb.checked = S.values[f.key] === true;
      cb.addEventListener('change', () => { S.values[f.key] = cb.checked; S.touched.add(f.key); onChange(f.key, false); });
      els.inputs[f.key] = cb;
      wrap.classList.add('qk-check');
      wrap.append(el('label', { for: id }, cb, el('span', { text: f.label })));
      return wrap;
    }
    const attrs = { id, name: f.key, autocomplete: 'off', 'data-key': f.key, 'aria-describedby': [id + '-h', id + '-l', id + '-e'].join(' '), enterkeyhint: 'next', placeholder: f.ph || '' };
    let input;
    if (f.type === 'month') input = hasMonthInput() ? el('input', Object.assign(attrs, { type: 'month' })) : el('input', Object.assign(attrs, { type: 'text', inputmode: 'numeric', placeholder: 'AAAA-MM' }));
    else if (f.type === 'date') input = el('input', Object.assign(attrs, { type: 'date' }));
    else if (f.type === 'int') input = el('input', Object.assign(attrs, { type: 'text', inputmode: 'numeric', pattern: '[0-9]*' }));
    else if (f.type === 'money') input = el('input', Object.assign(attrs, { type: 'text', inputmode: 'decimal', autocapitalize: 'none', spellcheck: 'false' }));
    else {
      input = el('input', Object.assign(attrs, { type: 'text', autocapitalize: 'sentences' }));
      if (f.list && f.list.length) { const dl = el('datalist', { id: id + '-dl' }); for (const o of f.list) dl.append(el('option', { value: o })); input.setAttribute('list', id + '-dl'); wrap.append(dl); }
    }
    els.inputs[f.key] = input;
    const v = S.values[f.key]; if (v !== undefined && v !== null) input.value = String(v);
    input.addEventListener('input', () => { S.values[f.key] = input.value; S.touched.add(f.key); onChange(f.key, false); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const all = [...els.fields.querySelectorAll('input:not([type=checkbox]),button.qk-seg-b')], i = all.indexOf(input);
      (all[i + 1] || els.save).focus();
    });
    const row = el('div', { class: 'qk-inp' });
    if (f.unit === '$') row.append(el('span', { class: 'qk-unit', 'aria-hidden': 'true', text: '$' }));
    row.append(input);
    if (f.unit && f.unit !== '$') row.append(el('span', { class: 'qk-unit end', 'aria-hidden': 'true', text: f.unit }));
    if (f.ops) {
      row.append(el('button', { type: 'button', class: 'qk-op', tabindex: '-1', 'aria-label': 'Insertar signo más', onclick: () => insertAtCaret(input, '+'), text: '+' }),
        el('button', { type: 'button', class: 'qk-op', tabindex: '-1', 'aria-label': 'Insertar signo menos', onclick: () => insertAtCaret(input, '-'), text: '−' }));
    }
    wrap.append(el('label', { for: id, text: f.label }), row, help, live, err);
    return wrap;
  }
  function renderFields() {
    els.inputs = {}; els.defs = {}; els.help = {}; els.err = {}; els.live = {};
    const defs = spec.fields(S, S.prep);
    els.fields.replaceChildren(...defs.map(buildField));
    S.sig = JSON.stringify(defs.map((f) => [f.key, f.type, f.label, f.unit || '']));
    updateLive(); updateFieldMessages();
  }
  function rerenderFields() {
    const a = document.activeElement, key = a && a.getAttribute ? a.getAttribute('data-key') : null;
    const pos = a && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null;
    renderFields();
    const n = key && els.inputs[key];
    if (n && n.focus) { n.focus(); if (pos && n.setSelectionRange) { try { n.setSelectionRange(pos[0], pos[1]); } catch (e) { /* tipos sin selección */ } } }
  }
  function setInput(key, v) {
    S.values[key] = v;
    const n = els.inputs[key]; if (!n) return;
    if (n.type === 'checkbox') n.checked = v === true; else if (n.tagName === 'INPUT') n.value = v == null ? '' : String(v);
  }
  function applyDefaults(force) {
    const d = spec.defaults(S.prep, S) || {};
    for (const [k, v] of Object.entries(d)) if (force || !S.touched.has(k)) setInput(k, v);
  }
  function updateLive() {
    for (const [key, node] of Object.entries(els.live)) {
      const f = els.defs[key], inp = els.inputs[key];
      if (!f || f.type !== 'money' || !inp) { node.textContent = ''; continue; }
      const a = parseAmount(inp.value);
      node.textContent = a.ok && a.isExpr ? '= ' + (f.unit === 'kWh' ? fmtInt(a.value) + ' kWh' : f.unit === '%' ? a.value + '%' : money(a.value)) : '';
    }
  }
  function updateFieldMessages() {
    const errs = new Map(((S.preview && S.preview.errors) || []).filter((e) => e.field).map((e) => [e.field, e.msg]));
    for (const [key, node] of Object.entries(els.err)) {
      const show = (S.touched.has(key) || S.showErrors) && errs.has(key);
      node.textContent = show ? errs.get(key) : '';
      const inp = els.inputs[key]; if (inp && inp.setAttribute) inp.setAttribute('aria-invalid', show ? 'true' : 'false');
    }
  }
  function onChange(key, structural) {
    if (formId === 'produb' && key === 'mode') { refresh(); return; }
    if (structural) { rerenderFields(); }
    else {
      const sig = JSON.stringify(spec.fields(S, S.prep).map((f) => [f.key, f.type, f.label, f.unit || '']));
      if (sig !== S.sig) rerenderFields();
    }
    updateLive();
    schedule();
  }
  const schedule = () => { clearTimeout(S.timer); S.timer = setTimeout(() => { if (!S.dead) renderPreview(); }, 120); };

  /* ----- selector de póliza ----- */
  function renderPicker() {
    els.picker.replaceChildren();
    if (!spec.picker || !S.prep.policies) return;
    const sel = Number(S.values.row);
    const ul = el('ul', { class: 'qk-pol', role: 'list' });
    for (const p of S.prep.policies) {
      const on = p.row === sel;
      ul.append(el('li', {}, el('button', { type: 'button', class: 'qk-pol-item' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: () => selectPolicy(p.row) },
        el('span', { class: 'qk-pol-main' }, el('b', { text: [p.bank, p.dest].filter(Boolean).join(' · ') || 'Póliza de la fila ' + p.rowNumber }), el('small', { text: money(p.amount) + ' · ' + round2(p.rate * 100) + '% · ' + p.days + ' días' })),
        el('span', { class: 'qk-badge qk-lv-' + p.level, text: polBadge(p) }))));
    }
    els.picker.append(el('h3', { class: 'qk-sub', text: '¿Qué póliza renuevas?' }), ul);
  }
  function selectPolicy(row) {
    S.values.row = row;
    for (const k of ['amount', 'rate', 'start', 'days']) S.touched.delete(k);
    const d = S.prep.hints.defaults[row];
    setInput('amount', numStr(d.amount)); setInput('rate', String(d.rate)); setInput('start', dateInputValue(d.start)); setInput('days', String(d.days));
    renderPicker(); updateLive(); schedule();
  }

  /* ----- banda superior ----- */
  function renderBand() {
    const lines = spec.band(S.prep, S) || [];
    const nodes = lines.map((l) => (typeof l === 'string' ? el('div', { class: 'qk-bl', text: l }) : el('div', { class: 'qk-bl qk-bl-' + l.level, text: l.text })));
    for (const w of S.prep.warnings || []) nodes.push(el('div', { class: 'qk-bw qk-bw-' + (w.level || 'info') }, el('span', { class: 'qk-bw-i', 'aria-hidden': 'true', text: w.level === 'warn' ? '!' : 'i' }), el('span', { text: w.msg })));
    els.band.replaceChildren(...nodes);
  }

  /* ----- vista previa ----- */
  const cellList = (cells) => el('dl', { class: 'qk-dl' }, ...cells.flatMap((c) => [
    el('dt', { text: c.label }),
    el('dd', { class: c.error ? 'neg' : '' }, c.before !== undefined && c.before !== null && c.beforeText !== c.text ? [el('span', { class: 'qk-was', text: c.beforeText }), el('span', { class: 'qk-arrow', 'aria-label': 'cambia a', text: ' → ' }), el('b', { text: c.text })] : el('b', { text: c.text })),
  ]));
  const summaryList = (rows) => el('dl', { class: 'qk-dl qk-sum' }, ...rows.flatMap((r) => [
    el('dt', { text: r.label }),
    el('dd', {}, el('span', { class: 'qk-was', text: r.beforeText }), el('span', { class: 'qk-arrow', 'aria-label': 'cambia a', text: ' → ' }), el('b', { text: r.afterText })),
  ]));
  function renderNotes(res) {
    const nodes = [];
    for (const c of res.checks || []) nodes.push(el('div', { class: 'qk-chk' + (c.ok === false ? ' bad' : c.ok ? ' good' : '') }, el('span', { class: 'qk-bw-i', 'aria-hidden': 'true', text: c.ok === false ? '!' : c.ok ? '✓' : 'i' }), el('span', { text: c.text })));
    for (const w of res.warnings || []) {
      const row = el('div', { class: 'qk-bw qk-bw-' + (w.confirm ? 'warn' : 'info') }, el('span', { class: 'qk-bw-i', 'aria-hidden': 'true', text: w.confirm ? '!' : 'i' }), el('span', { text: w.msg }));
      if (w.suggest && w.field) row.append(el('button', { type: 'button', class: 'btn qk-use', text: 'Usar «' + w.suggest + '»', onclick: () => { setInput(w.field, w.suggest); S.touched.add(w.field); onChange(w.field, false); } }));
      nodes.push(row);
    }
    els.notes.replaceChildren(...nodes);
  }
  function renderPreview() {
    if (S.dead || !S.prep || !S.prep.ok) return;
    const res = form.preview(eng(), collect(), optsNow());
    S.preview = res; updateFieldMessages();
    const box = els.preview;
    const title = spec.previewTitle ? spec.previewTitle(S, res) : (formId === 'poliza' ? 'Cómo quedará la póliza' : res.rowNumber ? 'Así quedará la fila ' + res.rowNumber : 'Resultado');
    box.replaceChildren(el('h3', { text: title }));
    if (!res.ok) {
      box.append(el('p', { class: 'muted qk-hint', text: S.touched.size || S.showErrors ? 'Completa o corrige los datos marcados para ver el resultado.' : 'Llena los datos y aquí verás cómo quedará.' }));
      if (S.showErrors && res.errors.length) box.append(el('ul', { class: 'qk-errs' }, ...res.errors.map((e) => el('li', { text: e.msg }))));
      renderNotes(res); return;
    }
    if (res.summary.length) box.append(summaryList(res.summary));
    const prim = res.cells.filter((c) => c.primary), sec = res.cells.filter((c) => !c.primary);
    if (prim.length) box.append(cellList(prim));
    if (sec.length) box.append(el('details', { class: 'qk-more' }, el('summary', { text: 'Ver ' + (prim.length ? 'las demás celdas' : 'las celdas') + ' calculadas (' + sec.length + ')' }), cellList(sec)));
    box.append(el('p', { class: 'qk-small muted', text: 'Escribe en: ' + res.writes.map((w) => w.a1).join(', ') + (res.copies.length ? ' · fórmulas copiadas a ' + res.copies.map((k) => k.to).join(', ') : '') + '.' }));
    renderNotes(res);
  }

  /* ----- guardar y deshacer ----- */
  async function save(confirmed) {
    if (S.saving || !S.prep || !S.prep.ok) return;
    S.saving = true; S.showErrors = true;
    els.save.disabled = true; els.save.textContent = 'Guardando…';
    await ui_nextFrame();
    try {
      let res = form.add(eng(), collect(), Object.assign(optsNow(), { confirmed }));
      if (!res.ok && res.needsConfirm) {
        els.save.disabled = false; els.save.textContent = spec.save;
        const yes = await ctx.confirm(res.confirm.map((w) => w.msg).join(' '), { title: 'Revisa este dato', ok: 'Guardar de todos modos', cancel: 'Corregir' });
        if (!yes) { renderPreview(); return; }
        els.save.disabled = true; els.save.textContent = 'Guardando…'; await ui_nextFrame();
        res = form.add(eng(), collect(), Object.assign(optsNow(), { confirmed: true }));
      }
      if (!res.ok) {
        renderPreview();
        const bad = (res.errors || [])[0];
        if (bad) { ctx.toast(bad.msg, { type: 'error' }); const n = bad.field && els.inputs[bad.field]; if (n && n.focus) n.focus(); }
        return;
      }
      afterSaved(res);
    } catch (e) {
      console.error(e); ctx.toast('No se pudo guardar: ' + (e && e.message || e), { type: 'error', ms: 7000 });
    } finally { S.saving = false; els.save.disabled = !(S.prep && S.prep.ok); els.save.textContent = spec.save; }
  }
  function afterSaved(res) {
    S.last = res; S.values = {}; S.touched.clear(); S.showErrors = false; S.preview = null;
    const n0 = S.refreshes;
    ctx.changed([res.sid || form.sid]);
    if (S.refreshes === n0) refresh();
    renderLast(res);
    const undoBtn = el('button', { class: 'qk-toast-btn', type: 'button', text: 'Deshacer', onclick: () => undo(res.token) });
    ctx.toast(el('span', {}, res.label + ' guardado' + (res.rowNumber ? ' en la fila ' + res.rowNumber : '') + '. ', undoBtn), { type: 'ok', ms: 10000 });
  }
  function undo(token) {
    const r = form.undoLast(eng(), { token });
    if (!r.ok) { ctx.toast(r.reason, { type: 'warn', ms: 6000 }); return false; }
    S.last = null; els.last.hidden = true; els.last.replaceChildren();
    ctx.changed([r.sid || form.sid]);
    ctx.toast('Se deshizo el registro.', { type: 'ok' });
    return true;
  }
  function renderLast(res) {
    const shown = (res.summary && res.summary.length ? res.summary.map((s) => ({ label: s.label, text: s.afterText, beforeText: s.beforeText, before: s.before })) : []).concat(res.computed.filter((c) => c.primary));
    els.last.replaceChildren(
      el('h3', { class: 'qk-sub', text: '✓ ' + res.label + ' guardado' + (res.rowNumber ? ' (fila ' + res.rowNumber + ')' : '') }),
      shown.length ? cellList(shown) : null,
      (res.extra && res.extra.length) ? summaryList(res.extra) : null,
      (res.warnings || []).filter((w) => w.code === 'calc').length ? el('p', { class: 'neg small', text: res.warnings.filter((w) => w.code === 'calc').map((w) => w.msg).join(' ') }) : null,
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn', text: 'Deshacer', onclick: () => undo(res.token) }),
        res.row != null ? el('button', { type: 'button', class: 'btn ghost', text: 'Ver en la hoja', onclick: () => ctx.openSheet(res.sid, { r: res.row, c: 0 }) }) : null));
    els.last.hidden = false;
  }
  const ui_nextFrame = () => new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 60); });

  /* ----- ciclo de vida ----- */
  function renderBlocked() {
    els.loading.hidden = true;
    els.band.replaceChildren(el('div', { class: 'qk-bw qk-bw-warn' }, el('span', { class: 'qk-bw-i', 'aria-hidden': 'true', text: '!' }), el('span', { text: S.prep.error || 'No se puede registrar en esta hoja.' })));
    for (const n of [els.picker, els.fields, els.notes, els.preview]) n.replaceChildren();
    els.save.disabled = true;
  }
  function refresh() {
    if (S.dead || !eng()) return;
    S.refreshes++;
    S.today = todayOf(ctx);
    S.prep = form.prepare(eng(), optsNow());
    if (!S.prep.ok) { renderBlocked(); return; }
    els.loading.hidden = true;
    if (!S.values.mode && formId === 'produb') S.values.mode = 'tarjeta';
    applyDefaults(false);
    renderBand(); renderPicker();
    const sig = JSON.stringify(spec.fields(S, S.prep).map((f) => [f.key, f.type, f.label, f.unit || '']));
    if (!els.fields.childElementCount || sig !== S.sig) renderFields();
    else for (const [k, v] of Object.entries(S.values)) { const n = els.inputs[k]; if (n && n.tagName === 'INPUT' && n.type !== 'checkbox' && n.value !== String(v ?? '')) n.value = String(v ?? ''); }
    updateLive();
    els.save.disabled = S.saving;
    renderPreview();
  }
  (async () => {
    try { if (eng() && eng().loadSheetAsync && eng().sheet(form.sid) && !eng().sheet(form.sid).loaded) await eng().loadSheetAsync(form.sid); } catch (e) { console.warn(e); }
    if (!S.dead) refresh();
  })();
  return {
    refresh,
    destroy() { S.dead = true; clearTimeout(S.timer); root.remove(); },
    /* para pruebas */ state: S, els,
  };
}
