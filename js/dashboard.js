/* dashboard.js — pantalla «Resumen» (tablero principal) de Flujo.
 *
 * Presenta el tablero consolidado del libro (hoja CONSOL, sid "s01") como tarjetas y un gráfico SVG hecho a mano.
 * Este archivo NO contiene datos de la persona: aquí solo se conoce la POSICIÓN de cada bloque; todas las
 * etiquetas (bancos, provisiones, rótulos de bloques) y cifras se leen de las celdas en tiempo de ejecución.
 *
 * Mapa de CONSOL (A1; el motor usa filas/columnas base 0):
 *   J4:J7    rótulos de la tabla de bancos (tres bancos y la fila de provisión)
 *   K4:K6    saldos (=C3:C5)          L7  provisión (=SUM(C8:C17))
 *   M4:M7    «Mes actual» (=K+L)      N4:N7  «Mes anterior» (se digita al cerrar el mes)     O4:O7  variación (=M-N)
 *   K9:O9    totales de la tabla      M10    control (=M9-D22, debe dar 0)
 *   D22/H3   flujo del mes (acumulado de C3:C22) = total «Mes actual»     H2 monto aparte (rótulo F2)     H4 = H1:H3
 *   A8:C17   líneas de provisión (A etiqueta, C monto); L7 suma C8:C17
 *   L21/M21/O21  mes en curso / mes anterior / diciembre base (fechas tipeadas, día 1 de cada mes)
 *   K22:K24 rótulos del patrimonio; L22:L25 actual · M22:M25 mes anterior · N22:N25 variación · O22:O25 diciembre base · P22:P25 acumulado
 *   Bloques anuales de patrimonio (columna R = diciembre previo; S..AD = ene..dic):
 *       2024: fechas fila 41 · partes filas 42:44 · total fila 45
 *       2025: fechas fila 48 · partes filas 49:51 · total fila 52 (totales tipeados, no SUM)
 *       2026: fechas fila 28 · partes filas 29:31 · total fila 32 (la columna del mes en curso es «viva»)
 *   Las filas 6, 10 y 15 (inicio de mes) y 8, 12 y 17 (MES = variación) de AF:AQ resumen estos bloques;
 *   aquí se recalculan a partir de los totales para no depender de celdas que aún no tienen sentido (mes sin cerrar).
 *
 * API pública:
 *   mount(host, ctx, opts?) -> { destroy(), refresh() }
 *   readSummary(engine, opts?)        saldos por banco, provisión, disponible, flujo, mes anterior, variaciones, controles
 *   readProvisions(engine)            líneas de provisión (A8:C17) y líneas libres
 *   readNetWorthSeries(engine, opts?) patrimonio mensual por año (2024..2026) + serie continua + estadísticas
 *   setProvisionAmount / addProvision / planCloseMonth / closeMonth / restoreMonth   escrituras en el motor (sin tocar la interfaz)
 *   describeSeries(series)            resumen textual (accesibilidad) · niceTicks / fmtAxis   utilidades del gráfico
 */
import { a1ToAddr, colLetter } from './engine.js';
import { el, money, monthText } from './ui.js';
import { parseInput, serialToDate, todaySerial } from './format.js';

export const SID = 's01';                      // hoja CONSOL
const EPS = 0.005;                             // tolerancia de "cero" para dinero (medio centavo)
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const GENERIC_PARTS = ['Bancos', 'Gastos', 'Inversiones'];   // rótulos genéricos si las celdas Q29:Q31 están vacías

/** Cuentas del tablero. `row` = fila de la tabla de bancos de CONSOL (K:O); sin `row` la cuenta no suma al disponible. */
export const ACCOUNTS = [
  { id: 'gye', sid: 's02', row: 4 },
  { id: 'bol', sid: 's07', row: 5 },
  { id: 'pich', sid: 's06', row: 6 },
  { id: 'gye-ah', sid: 's10', row: null, balanceCol: 6, dataCols: [0, 5] },   // saldo = columna G de la última fila con datos (A:F)
];
const PROV = { first: 7, last: 16, amountCol: 2, labelCol: 0 };               // A8:C17 en base 0
const PREV_COL = 13;                                                         // columna N («Mes anterior»)
const PREV_ROWS = [3, 4, 5, 6];                                              // filas 4..7 en base 0
export const NETWORTH_BLOCKS = [
  { year: 2024, partRows: [42, 43, 44], totalRow: 45, dateRow: 41 },
  { year: 2025, partRows: [49, 50, 51], totalRow: 52, dateRow: 48 },
  { year: 2026, partRows: [29, 30, 31], totalRow: 32, dateRow: 28 },
];
const FIRST_MONTH_COL = 18;                                                  // columna S = enero; R (17) = diciembre previo

/* ================================================================== lectura segura de celdas */
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pctOf = (delta, base) => (isNum(delta) && isNum(base) && Math.abs(base) > EPS ? delta / Math.abs(base) : null);
const serialOf = (y, m, d = 1) => Math.round((Date.UTC(y, m, d) - Date.UTC(1899, 11, 30)) / 86400000);
const monthIdx = (serial) => { const d = serialToDate(serial); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const labelOf = (y, m) => MONTHS[m] + '-' + String(y).slice(2);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const plural = (n, one, many) => (n === 1 ? one : many);

/** Lector de celdas de una hoja: nunca lanza; acumula las celdas con error. */
function makeReader(engine, sid = SID) {
  const errors = [], seen = new Set();
  let sheet = null;
  try { sheet = engine && typeof engine.sheet === 'function' ? engine.sheet(sid) : null; } catch (e) { sheet = null; }
  const get = (a1) => {
    if (!sheet) return null;
    const p = a1ToAddr(a1);
    try {
      const v = engine.value(sid, p.r, p.c);
      if (v && typeof v === 'object' && v.error) { if (!seen.has(a1)) { seen.add(a1); errors.push({ cell: a1, error: v.error }); } return null; }
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      return v === undefined ? null : v;
    } catch (e) { return null; }
  };
  return {
    missing: !sheet, sheet, errors,
    val: get,
    num: (a1) => { const x = get(a1); return isNum(x) ? x : null; },
    txt: (a1) => { const x = get(a1); return typeof x === 'string' ? x.trim() : ''; },
    raw: (a1) => { if (!sheet) return null; const p = a1ToAddr(a1); try { return engine.raw(sid, p.r, p.c); } catch (e) { return null; } },
  };
}

/* ================================================================== resumen (tabla de bancos y flujo) */
function monthInfo(R, today) {
  const cur = R.num('L21'), prev = R.num('M21'), base = R.num('O21');
  let behind = null;
  if (isNum(cur) && isNum(today)) behind = monthIdx(today) - monthIdx(cur);          // >0: la hoja va atrasada respecto al calendario
  return {
    current: cur, previous: prev, base,
    currentLabel: isNum(cur) ? monthText(cur) : '', previousLabel: isNum(prev) ? monthText(prev) : '', baseLabel: isNum(base) ? monthText(base) : '',
    today: isNum(today) ? today : null, todayLabel: isNum(today) ? monthText(today) : '',
    behind,
  };
}

/** Nombre de la hoja de una cuenta (último recurso para rotular una tarjeta). */
function sheetTitle(engine, sid) { try { const sh = engine.sheet(sid); return sh ? String(sh.name).trim() : ''; } catch (e) { return ''; } }

/** Saldo de una cuenta que CONSOL no suma: columna de saldo en la última fila con datos tecleados. */
function readExtraAccount(engine, acc, names) {
  const out = { id: acc.id, sid: acc.sid, name: names[acc.id] || '', saldo: null, row: -1, counted: false, previous: null, variation: null, variationPct: null, share: null, missing: false };
  try {
    const sh = engine.sheet(acc.sid);
    if (!sh) { out.missing = true; out.name = out.name || acc.id; return out; }
    if (!out.name) {
      const t = engine.value(acc.sid, 0, 0);                                         // título de la hoja (A1)
      out.name = typeof t === 'string' && t.trim() ? t.trim().toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : sh.name.trim();
    }
    const row = engine.lastConstRow(acc.sid, acc.dataCols[0], acc.dataCols[1]);
    out.row = row;
    if (row >= 0) { const v = engine.value(acc.sid, row, acc.balanceCol); out.saldo = isNum(v) ? v : null; }
  } catch (e) { out.missing = true; }
  return out;
}

/**
 * Lee el tablero. Todos los importes son number | null (null = vacío, texto o error; los errores quedan en `errors`).
 * @param {object} engine  motor de cálculo
 * @param {{today?:number, names?:Object<string,string>}} opts  today = número de serie de hoy; names = {idCuenta: nombre}: para las cuentas de la tabla de CONSOL
 *        solo se usa si la celda del rótulo (J4:J6) está vacía; para las demás cuentas tiene prioridad sobre el título de su hoja
 */
export function readSummary(engine, opts = {}) {
  const R = makeReader(engine);
  const today = isNum(opts.today) ? opts.today : todaySerial();
  const names = opts.names || {};
  const out = {
    ok: !R.missing, empty: true, sheetName: R.sheet ? String(R.sheet.name).trim() : '',
    month: monthInfo(R, today), banks: [], others: [], provision: null, totals: null,
    available: null, flow: null, extra: { label: '', amount: null }, nowTotal: null,
    control: { diff: null, ok: null }, patrimonio: null, errors: R.errors, warnings: [],
  };
  if (R.missing) { out.warnings.push({ code: 'nosheet', level: 'error', text: 'No encuentro la hoja de resumen (CONSOL) en este libro.' }); return out; }

  const variationOf = (n, actual, previous) => {
    if (!isNum(previous)) return null;
    const o = R.num('O' + n);
    return o !== null ? o : (isNum(actual) ? actual - previous : null);
  };
  out.banks = ACCOUNTS.filter((a) => a.row).map((a) => {
    const n = a.row, actual = R.num('M' + n), previous = R.num('N' + n), variation = variationOf(n, actual, previous);
    return { id: a.id, sid: a.sid, row: n, name: R.txt('J' + n) || names[a.id] || sheetTitle(engine, a.sid) || a.id, saldo: R.num('K' + n), provision: R.num('L' + n), actual, previous, variation, variationPct: pctOf(variation, previous), share: null, counted: true };
  });
  const pActual = R.num('M7'), pPrev = R.num('N7'), pVar = variationOf(7, pActual, pPrev);
  out.provision = { row: 7, name: R.txt('J7') || 'Provisión', provision: R.num('L7'), actual: pActual, previous: pPrev, variation: pVar, variationPct: pctOf(pVar, pPrev) };
  const tActual = R.num('M9'), tPrev = R.num('N9'), tVar = variationOf(9, tActual, tPrev);
  out.totals = { saldos: R.num('K9'), provision: R.num('L9'), actual: tActual, previous: tPrev, variation: tVar, variationPct: pctOf(tVar, tPrev) };

  const sumSaldos = out.totals.saldos;                                            // K9: nunca se inventa un total parcial si falta o tiene error
  for (const b of out.banks) b.share = isNum(sumSaldos) && sumSaldos > EPS && isNum(b.saldo) && b.saldo >= 0 ? b.saldo / sumSaldos : null;

  const d22 = R.num('D22');
  out.available = out.totals.actual !== null ? out.totals.actual : d22;
  out.flow = R.num('H3') !== null ? R.num('H3') : d22;
  out.extra = { label: R.txt('F2'), amount: R.num('H2') };
  out.nowTotal = R.num('H4');
  const diff = R.num('M10');
  out.control = { diff, ok: diff === null ? null : Math.abs(diff) < EPS };

  const parts = [22, 23, 24].map((n) => ({ label: R.txt('K' + n), actual: R.num('L' + n), previous: R.num('M' + n), variation: R.num('N' + n), base: R.num('O' + n), ytd: R.num('P' + n) }));
  out.patrimonio = { actual: R.num('L25'), previous: R.num('M25'), variation: R.num('N25'), base: R.num('O25'), ytd: R.num('P25'), ytdAlt: R.num('H17'), parts };

  out.others = ACCOUNTS.filter((a) => !a.row).map((a) => readExtraAccount(engine, a, names));
  out.empty = [out.available, out.totals.saldos, ...out.banks.map((b) => b.actual)].every((v) => v === null);

  // ---- avisos (no bloquean nada: solo orientan) ----
  if (R.errors.length) {
    const list = R.errors.slice(0, 4).map((e) => e.cell + ' ' + e.error).join(', ');
    out.warnings.push({ code: 'errors', level: 'error', text: `Hay ${R.errors.length} ${plural(R.errors.length, 'celda', 'celdas')} con error en ${out.sheetName} (${list}${R.errors.length > 4 ? '…' : ''}). Abre la hoja para revisarlas.` });
  }
  if (out.control.ok === false) out.warnings.push({ code: 'control', level: 'warn', text: `La tabla de bancos no cuadra con el flujo del mes (diferencia ${money(diff)}). Revisa la hoja ${out.sheetName}.` });
  if (out.month.behind !== null && out.month.behind > 0) out.warnings.push({ code: 'month', level: 'warn', text: `La hoja ${out.sheetName} sigue en ${out.month.currentLabel}, pero hoy ya es ${out.month.todayLabel}. Cuando cierres el mes, actualiza también las fechas de la hoja.` });
  return out;
}

/* ================================================================== provisiones (A8:C17) */
function safeRaw(engine, r, c) { try { return engine.raw(SID, r, c); } catch (e) { return null; } }
const blank = (x) => x === null || x === undefined || x === '';

/** Líneas de provisión: las que tienen etiqueta o monto, y las filas libres (para agregar). */
export function readProvisions(engine) {
  const R = makeReader(engine);
  const out = { ok: !R.missing, items: [], free: [], total: null, sum: null, previous: null, variation: null, errors: R.errors };
  if (R.missing) return out;
  let sum = 0, any = false;
  for (let r = PROV.first; r <= PROV.last; r++) {
    const row = r + 1, labelA1 = 'A' + row, amountA1 = 'C' + row;
    const rawA = safeRaw(engine, r, PROV.labelCol), rawC = safeRaw(engine, r, PROV.amountCol);
    if (blank(rawA) && blank(rawC)) { out.free.push(r); continue; }
    const v = R.val(amountA1), amount = isNum(v) ? v : null;
    if (amount !== null) { sum += amount; any = true; }
    let isFormula = false; try { isFormula = engine.isFormula(SID, r, PROV.amountCol); } catch (e) { /* nada */ }
    out.items.push({ r, row, label: R.txt(labelA1), amount, raw: rawC, isFormula, a1: amountA1, labelA1, error: R.errors.some((e) => e.cell === amountA1) ? R.errors.find((e) => e.cell === amountA1).error : null });
  }
  out.sum = any ? sum : null;
  out.total = R.num('L7');
  out.previous = R.num('N7');
  out.variation = isNum(out.previous) && isNum(out.total) ? out.total - out.previous : null;
  return out;
}

/** Texto tecleado -> contenido crudo. '' = vaciar; número (con coma o punto decimal) o fórmula que empiece con "=". */
export function parseAmountInput(text) {
  const s = String(text === null || text === undefined ? '' : text).trim();
  if (s === '') return { ok: true, raw: null };
  const p = parseInput(s, null);
  if (isNum(p.raw)) return { ok: true, raw: p.raw };
  if (typeof p.raw === 'string' && p.raw[0] === '=' && p.raw.length > 1) return { ok: true, raw: p.raw };
  return { ok: false, error: 'Escribe un número (por ejemplo -100 o 250.50) o una fórmula que empiece con =.' };
}

/** Escribe el monto de una línea de provisión (fila r base 0 dentro de A8:C17). Si la fórmula no calcula, deja la celda como estaba. */
export function setProvisionAmount(engine, r, text) {
  if (!Number.isInteger(r) || r < PROV.first || r > PROV.last) return { ok: false, error: 'Esa fila no es una línea de provisión.' };
  const parsed = parseAmountInput(text);
  if (!parsed.ok) return parsed;
  let before;
  try { before = engine.raw(SID, r, PROV.amountCol); } catch (e) { return { ok: false, error: 'No encuentro la hoja de resumen.' }; }
  const changes = engine.set(SID, r, PROV.amountCol, parsed.raw);
  const v = engine.value(SID, r, PROV.amountCol);
  if (v && typeof v === 'object' && v.error) {
    engine.set(SID, r, PROV.amountCol, before === undefined ? null : before);
    return { ok: false, error: 'La fórmula no se pudo calcular (' + v.error + '). No se guardó.' };
  }
  return { ok: true, r, row: r + 1, before, after: parsed.raw, changes };
}

/** Agrega una provisión en la primera línea libre de A8:C17 (etiqueta en A, monto en C). */
export function addProvision(engine, label, amountText) {
  const name = String(label === null || label === undefined ? '' : label).trim();
  if (!name) return { ok: false, error: 'Escribe un nombre para la provisión.' };
  const parsed = parseAmountInput(amountText);
  if (!parsed.ok) return parsed;
  if (parsed.raw === null) return { ok: false, error: 'Escribe el monto.' };
  const info = readProvisions(engine);
  if (!info.ok) return { ok: false, error: 'No encuentro la hoja de resumen.' };
  if (!info.free.length) return { ok: false, error: 'No quedan líneas libres en la lista de provisiones de la hoja.' };
  const r = info.free[0];
  engine.set(SID, r, PROV.labelCol, name);
  const changes = engine.set(SID, r, PROV.amountCol, parsed.raw);
  const v = engine.value(SID, r, PROV.amountCol);
  if (v && typeof v === 'object' && v.error) {
    engine.set(SID, r, PROV.amountCol, null); engine.set(SID, r, PROV.labelCol, null);
    return { ok: false, error: 'La fórmula no se pudo calcular (' + v.error + '). No se guardó.' };
  }
  return { ok: true, r, row: r + 1, changes };
}

/** Quita una línea agregada con addProvision (vacía etiqueta y monto). Solo para deshacer. */
export function clearProvisionLine(engine, r) {
  if (!Number.isInteger(r) || r < PROV.first || r > PROV.last) return { ok: false };
  engine.set(SID, r, PROV.labelCol, null);
  engine.set(SID, r, PROV.amountCol, null);
  return { ok: true };
}

/* ================================================================== cerrar mes: «Mes actual» -> «Mes anterior» (N4:N7) */
/** Prepara el cierre sin escribir. ok:false si no se puede; noop:true si «Mes anterior» ya es igual a «Mes actual». */
export function planCloseMonth(engine) {
  const R = makeReader(engine);
  if (R.missing) return { ok: false, reason: 'No encuentro la hoja de resumen.' };
  const rows = PREV_ROWS.map((r) => {
    const n = r + 1;
    return { r, row: n, label: R.txt('J' + n), actual: R.num('M' + n), previous: R.num('N' + n), previousRaw: safeRaw(engine, r, PREV_COL) };
  });
  const headers = { actual: R.txt('M2') || 'Mes actual', previous: R.txt('N2') || 'Mes anterior' };
  if (rows.some((x) => x.actual === null)) return { ok: false, reason: `No se puede cerrar: «${headers.actual}» tiene celdas vacías o con error.`, rows, headers };
  const noop = rows.every((x) => x.previous !== null && Math.abs(x.previous - x.actual) < 1e-9);
  return { ok: true, noop, rows, headers, totalActual: R.num('M9'), totalPrevious: R.num('N9'), monthLabel: isNum(R.num('L21')) ? monthText(R.num('L21')) : '' };
}

/** Copia los valores actuales de «Mes actual» (M4:M7) a «Mes anterior» (N4:N7). Devuelve lo previo para poder deshacer. */
export function closeMonth(engine) {
  const plan = planCloseMonth(engine);
  if (!plan.ok) return plan;
  const before = plan.rows.map((x) => (x.previousRaw === undefined ? null : x.previousRaw));
  const changes = engine.setMatrix(SID, PREV_ROWS[0], PREV_COL, plan.rows.map((x) => [x.actual]));
  return { ok: true, plan, before, changes };
}

/** Restaura N4:N7 con lo que devolvió closeMonth(...).before. */
export function restoreMonth(engine, before) {
  return engine.setMatrix(SID, PREV_ROWS[0], PREV_COL, PREV_ROWS.map((_, i) => [before && before[i] !== undefined ? before[i] : null]));
}

/* ================================================================== patrimonio mes a mes */
/**
 * Serie mensual del patrimonio (bancos + gastos provisionados + inversiones) de los bloques anuales de CONSOL.
 * Un mes cuenta si tiene total numérico y no es un cero sin componentes (columna futura aún vacía).
 * @returns {{ok:boolean, years:object[], flat:object[], labels:string[], stats:object, errors:object[]}}
 */
export function readNetWorthSeries(engine, opts = {}) {
  const R = makeReader(engine);
  const out = { ok: !R.missing, years: [], flat: [], labels: GENERIC_PARTS.slice(), stats: { count: 0, latest: null, previous: null, monthDelta: null, monthDeltaPct: null, ytd: null, yearAgo: null, yearDelta: null, min: null, max: null }, current: null, errors: R.errors };
  if (R.missing) return out;
  out.labels = [R.txt('Q29'), R.txt('Q30'), R.txt('Q31')].map((t, i) => cap(t) || GENERIC_PARTS[i]);
  const cur = R.num('L21');
  const curIdx = isNum(cur) ? monthIdx(cur) : monthIdx(isNum(opts.today) ? opts.today : todaySerial());
  out.current = { serial: cur, idx: curIdx };
  let carry = null;
  for (const b of NETWORTH_BLOCKS) {
    const openTotal = R.num('R' + b.totalRow);
    const opening = isNum(openTotal) ? { serial: serialOf(b.year - 1, 11), label: labelOf(b.year - 1, 11), total: openTotal } : null;
    let prevTotal = opening ? openTotal : carry;
    const months = [];
    for (let m = 0; m < 12; m++) {
      const col = colLetter(FIRST_MONTH_COL + m);
      const total = R.num(col + b.totalRow);
      const parts = b.partRows.map((row) => R.num(col + row));
      if (total === null) continue;
      if (total === 0 && parts.every((p) => p === null || p === 0)) continue;       // columna futura sin cerrar
      const delta = isNum(prevTotal) ? total - prevTotal : null;
      const item = { year: b.year, month: m, key: b.year + '-' + String(m + 1).padStart(2, '0'), idx: b.year * 12 + m, serial: serialOf(b.year, m), label: labelOf(b.year, m), short: MONTHS[m], total, parts, delta, deltaPct: pctOf(delta, prevTotal), live: b.year * 12 + m === curIdx, source: col + b.totalRow };
      months.push(item); out.flat.push(item);
      prevTotal = total; carry = total;
    }
    if (months.length) {
      const last = months[months.length - 1];
      out.years.push({ year: b.year, opening, months, last, change: opening ? last.total - opening.total : null });
    }
  }
  out.flat.sort((a, c) => a.idx - c.idx);
  const f = out.flat;
  if (f.length) {
    const latest = f[f.length - 1], yr = out.years.find((y) => y.year === latest.year);
    const ago = f.find((x) => x.idx === latest.idx - 12) || null;
    out.stats = {
      count: f.length, latest, previous: f.length > 1 ? f[f.length - 2] : null,
      monthDelta: latest.delta, monthDeltaPct: latest.deltaPct,
      ytd: yr && yr.opening ? latest.total - yr.opening.total : null, yearBase: yr && yr.opening ? yr.opening : null,
      yearAgo: ago, yearDelta: ago ? latest.total - ago.total : null,
      min: f.reduce((a, x) => (x.total < a.total ? x : a), f[0]), max: f.reduce((a, x) => (x.total > a.total ? x : a), f[0]),
    };
  }
  return out;
}

/** Resumen textual del gráfico (para lectores de pantalla y para el pie visible). */
export function describeSeries(series) {
  const s = series && series.stats;
  if (!s || !s.count) return 'Patrimonio mes a mes: todavía no hay meses cerrados para graficar.';
  const f = series.flat, parts = [];
  parts.push(`Patrimonio mes a mes, de ${f[0].label} a ${s.latest.label} (${s.count} ${plural(s.count, 'mes', 'meses')}).`);
  parts.push(`Último dato: ${s.latest.label}, ${money(s.latest.total)}${s.latest.live ? ' (mes en curso)' : ''}.`);
  if (isNum(s.monthDelta)) parts.push(`Cambio frente al mes anterior: ${money(s.monthDelta, { sign: true })}.`);
  if (isNum(s.ytd)) parts.push(`En lo que va de ${s.latest.year}: ${money(s.ytd, { sign: true })}.`);
  if (s.yearAgo) parts.push(`Hace un año (${s.yearAgo.label}): ${money(s.yearAgo.total)}.`);
  if (s.count > 2) parts.push(`Mínimo: ${s.min.label}, ${money(s.min.total)}. Máximo: ${s.max.label}, ${money(s.max.total)}.`);
  return parts.join(' ');
}

/* ================================================================== utilidades del gráfico (puras) */
const trim1 = (x) => String(Math.round(x * 10) / 10);
/** Etiqueta compacta de eje: $250k · $1.2M · $80. Con `step` (paso entre marcas) evita redondeos engañosos: pasos pequeños -> importe completo ($9,250). */
export function fmtAxis(v, step) {
  if (!isNum(v)) return '';
  const a = Math.abs(v), sg = v < 0 ? '−' : '', fine = isNum(step) && step > 0;
  if (a >= 1e6 && (!fine || step % 1e5 === 0)) return sg + '$' + trim1(a / 1e6) + 'M';
  if (a >= 1e3 && (!fine || step % 100 === 0)) return sg + '$' + trim1(a / 1e3) + 'k';
  return sg + '$' + Math.round(a).toLocaleString('en-US');
}
/** Marcas "bonitas" para un eje: devuelve {ticks, lo, hi, step} cubriendo [min,max]. */
export function niceTicks(min, max, count = 4) {
  if (!isNum(min) || !isNum(max)) return { ticks: [0, 1], lo: 0, hi: 1, step: 1 };
  if (min === max) { const pad = Math.max(Math.abs(min) * 0.05, 1); min -= pad; max += pad; }
  const raw = (max - min) / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step, ticks = [];
  for (let k = Math.round(lo / step); k * step <= hi + step / 1e6; k++) ticks.push(k * step);
  return { ticks, lo, hi, step };
}

/* ================================================================== DOM / SVG auxiliares */
const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'text') n.textContent = v; else n.setAttribute(k, v === true ? '' : v); }
  for (const kid of kids.flat()) if (kid) n.append(kid);
  return n;
}
const ICONS = {
  up: 'M5 1.5 9.3 8.5H.7z', down: 'M5 8.5.7 1.5h8.6z', flat: 'M1 5h8',
  plus: 'M12 5v14M5 12h14', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4', sheet: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16',
  lock: 'M5 4h14v16H5zM9 2v4M15 2v4M5 9h14M9 14.5l2 2 4-4.5', edit: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3', chev: 'M9 6l6 6-6 6', check: 'M5 12.5l4.5 4.5L19 7', close: 'M6 6l12 12M18 6L6 18',
};
function icon(name, size = 16) {
  const filled = name === 'up' || name === 'down';
  return sv('svg', { viewBox: filled || name === 'flat' ? '0 0 10 10' : '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'db-ico' },
    sv('path', { d: ICONS[name], fill: filled ? 'currentColor' : 'none', stroke: filled ? 'none' : 'currentColor', 'stroke-width': name === 'flat' ? 1.8 : 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}
const signWord = (d) => (Math.abs(d) < EPS ? 'sin cambio' : d > 0 ? 'sube' : 'baja');

/** Pastilla de variación: flecha + importe con signo (+ porcentaje). Nunca depende solo del color. */
function chip(delta, { pct = null, versus = '', hero = false, short = false, suffix = '' } = {}) {
  if (!isNum(delta)) return null;
  const flat = Math.abs(delta) < EPS, up = delta > 0;
  const cls = 'db-chip ' + (hero ? 'on-hero ' : '') + (flat ? 'flat' : up ? 'pos' : 'neg');
  const label = `${cap(signWord(delta))}${flat ? '' : ' ' + money(Math.abs(delta))}${suffix ? ' ' + suffix : ''}${versus ? ' frente a ' + versus : ''}`;
  return el('span', { class: cls, 'aria-label': label }, icon(flat ? 'flat' : up ? 'up' : 'down', 10),
    el('span', { text: flat ? 'Sin cambio' : money(delta, { sign: true }) }),
    !short && pct !== null && !flat ? el('span', { class: 'db-chip-pct', text: '(' + (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct * 100).toFixed(1) + '%)' }) : null,
    suffix ? el('span', { class: 'db-chip-sfx', text: suffix }) : null);
}

/* ================================================================== gráfico de patrimonio (SVG hecho a mano) */
let chartUid = 0;
function yearSlot(year, latest) { return Math.min(Math.max(latest - year, 0), 2) + 1; }       // 1 = año más reciente (color de marca), 2, 3

function createNetWorthChart(host, hooks = {}) {
  const uid = ++chartUid;
  const st = { mode: 'all', series: null, pinned: null, W: 0, geom: null, emitted: null };
  const plot = el('div', { class: 'db-plot' });
  const tip = el('div', { class: 'db-tip', 'aria-hidden': 'true', hidden: true });
  const live = el('div', { class: 'db-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const legend = el('div', { class: 'db-legend', hidden: true });
  const fig = el('figure', { class: 'db-fig', tabindex: '0', role: 'group', 'aria-label': 'Gráfico del patrimonio mes a mes. Con las flechas izquierda y derecha recorres los meses.' }, plot, legend, live);
  plot.append(tip);
  host.append(fig);
  let svg = null, ro = null;

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

  /* ---- modelo de datos según la vista ---- */
  function model() {
    const s = st.series;
    if (!s || !s.flat.length) return null;
    if (st.mode === 'all') {
      const min = s.flat[0].idx, max = s.flat[s.flat.length - 1].idx, n = max - min + 1;
      const slots = Array.from({ length: n }, () => null);
      for (const m of s.flat) slots[m.idx - min] = m;
      return { kind: 'all', n, min, slots, lines: [{ key: 'all', cls: 's1', points: slots, label: '' }] };
    }
    const latest = s.years[s.years.length - 1].year;
    const lines = s.years.slice().reverse().map((y) => {
      const points = Array.from({ length: 12 }, () => null);
      for (const m of y.months) points[m.month] = m;
      return { key: String(y.year), year: y.year, cls: 's' + yearSlot(y.year, latest), points, label: String(y.year) };
    });
    return { kind: 'year', n: 12, lines, latest };
  }

  /* ---- dibujo ---- */
  function render() {
    const M = model();
    const W = Math.max(240, Math.round(plot.clientWidth || host.clientWidth || 320));
    st.W = W;
    if (svg) svg.remove();
    tip.hidden = true;
    if (!M) { svg = null; st.geom = null; legend.hidden = true; emit(null); return; }
    const compact = W < 480, H = compact ? 250 : 300;
    const mT = 30, mR = 12, mL = 46, mB = M.kind === 'all' ? 48 : 28;
    const pw = W - mL - mR, ph = H - mT - mB, padX = 8;
    const vals = [];
    for (const ln of M.lines) for (const p of ln.points) if (p) vals.push(p.total);
    const vmin = Math.min(...vals), vmax = Math.max(...vals), span = (vmax - vmin) || Math.abs(vmax) || 1;
    const nt = niceTicks(vmin - span * 0.04, vmax + span * 0.06, ph > 190 ? 5 : 4);
    const X = (i) => mL + padX + (pw - 2 * padX) * (M.n === 1 ? 0.5 : i / (M.n - 1));
    const Y = (v) => mT + ph - ((v - nt.lo) / ((nt.hi - nt.lo) || 1)) * ph;
    st.geom = { M, X, Y, mL, mT, pw, ph, W, H, padX };

    const title = 'Patrimonio mes a mes';
    svg = sv('svg', { class: 'db-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-labelledby': `dbt${uid} dbd${uid}`, focusable: 'false' },
      sv('title', { id: 'dbt' + uid, text: title }), sv('desc', { id: 'dbd' + uid, text: describeSeries(st.series) }));
    const g = (cls, ...kids) => sv('g', { class: cls }, ...kids);

    // rejilla horizontal + etiquetas del eje Y (hairlines sólidas y discretas)
    const grid = g('db-grid'), yl = g('db-ticks');
    for (const t of nt.ticks) {
      const y = Y(t);
      grid.append(sv('line', { x1: mL, x2: W - mR, y1: y, y2: y, class: 'db-gl' }));
      yl.append(sv('text', { x: mL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'db-tx', text: fmtAxis(t, nt.step) }));
    }
    svg.append(grid, yl);
    svg.append(sv('line', { x1: mL, x2: W - mR, y1: mT + ph, y2: mT + ph, class: 'db-axis' }));

    // eje X
    const xl = g('db-xticks');
    if (M.kind === 'all') {
      const pxPer = (pw - 2 * padX) / Math.max(1, M.n - 1);
      const step = [1, 2, 3, 6, 12].find((k) => k * pxPer >= 24) || 12;
      let lastYear = null, yStart = 0;
      const yearSpans = [];
      M.slots.forEach((m, i) => {
        const absIdx = M.min + i, mo = ((absIdx % 12) + 12) % 12, yr = Math.floor(absIdx / 12);
        if (lastYear === null) { lastYear = yr; yStart = i; }
        if (yr !== lastYear) { yearSpans.push({ year: lastYear, a: yStart, b: i - 1 }); lastYear = yr; yStart = i; }
        if (mo % step === 0) {
          const x = X(i), end = x > W - mR - 14;
          xl.append(sv('line', { x1: x, x2: x, y1: mT + ph, y2: mT + ph + 4, class: 'db-axis' }),
            sv('text', { x: end ? x + 4 : x, y: mT + ph + 16, 'text-anchor': end ? 'end' : 'middle', class: 'db-tx', text: MONTHS[mo] }));
        }
      });
      yearSpans.push({ year: lastYear, a: yStart, b: M.n - 1 });
      for (const sp of yearSpans) {
        const x0 = X(sp.a), x1 = X(sp.b);
        xl.append(sv('text', { x: (x0 + x1) / 2, y: mT + ph + 34, 'text-anchor': 'middle', class: 'db-tx db-yr', text: String(sp.year) }));
        if (sp.a > 0) { const xs = (X(sp.a - 1) + X(sp.a)) / 2; grid.append(sv('line', { x1: xs, x2: xs, y1: mT, y2: mT + ph + 4, class: 'db-gl db-sep' })); }
      }
    } else {
      const pxPer = (pw - 2 * padX) / 11, step = [1, 2, 3, 6].find((k) => k * pxPer >= 24) || 6;
      for (let i = 0; i < 12; i += step) xl.append(sv('text', { x: X(i), y: mT + ph + 17, 'text-anchor': 'middle', class: 'db-tx', text: MONTHS[i] }));
    }
    svg.append(xl);

    // líneas, área, puntos
    const pts = g('db-marks');
    const showEvery = M.kind === 'year';
    const latestLine = M.lines[0];
    for (const ln of M.lines) {
      const segs = []; let cur = [];
      ln.points.forEach((p, i) => { if (p) cur.push({ x: X(i), y: Y(p.total), p, i }); });
      if (cur.length) segs.push(cur);
      const d = segs.map((sg) => sg.map((q, k) => (k ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1)).join('')).join('');
      if (M.kind === 'all' && segs.length) {
        const sg = segs[0];
        pts.append(sv('path', { d: d + `L${sg[sg.length - 1].x.toFixed(1)} ${mT + ph}L${sg[0].x.toFixed(1)} ${mT + ph}Z`, class: 'db-area ' + ln.cls }));
      }
      pts.append(sv('path', { d, class: 'db-line ' + ln.cls, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', fill: 'none' }));
      for (const q of segs[0] || []) {
        const m = q.p, last = q === segs[0][segs[0].length - 1];
        const yearEnd = M.kind === 'all' && m.month === 11 && !last;
        if (showEvery || last || yearEnd) pts.append(sv('circle', { cx: q.x, cy: q.y, r: last ? 5 : 4, class: 'db-dot ' + ln.cls + (m.live ? ' live' : '') }));
      }
    }
    svg.append(pts);

    // etiquetas directas, pocas y con halo: cierre de cada año y último dato
    const lbl = g('db-lbls');
    const compactMoney = (v) => (Math.abs(v) >= 1000 ? (v < 0 ? '−' : '') + '$' + (Math.abs(v) / 1000).toFixed(1) + 'k' : money(v, { dec: 0 }));
    const labelPoint = (q, anchor) => {
      const above = q.y - 11 >= mT - 8;
      const x = anchor === 'end' ? q.x + 4 : clamp(q.x, mL + 22, W - mR - 22);
      lbl.append(sv('text', { x, y: above ? q.y - 11 : q.y + 20, 'text-anchor': anchor, class: 'db-dl', text: compactMoney(q.p.total) }));
    };
    const endAnchor = (q) => (q.x > W - mR - 40 ? 'end' : 'middle');
    const pointsOf = (ln) => { const o = []; ln.points.forEach((p, i) => { if (p) o.push({ x: X(i), y: Y(p.total), p }); }); return o; };
    if (M.kind === 'all') {
      const all = pointsOf(M.lines[0]), lastQ = all[all.length - 1];
      for (const q of all) if (q.p.month === 11 && q !== lastQ) labelPoint(q, 'middle');
      if (lastQ) labelPoint(lastQ, endAnchor(lastQ));
    } else if (latestLine) {
      const q = pointsOf(latestLine);
      if (q.length) labelPoint(q[q.length - 1], endAnchor(q[q.length - 1]));
    }
    svg.append(lbl);

    // guía vertical + puntos activos + zona sensible
    svg.append(sv('line', { class: 'db-cross', y1: mT, y2: mT + ph, x1: 0, x2: 0, style: 'display:none' }), sv('g', { class: 'db-act' }));
    const hit = sv('rect', { class: 'db-hit', x: mL, y: mT - 6, width: pw, height: ph + 12, fill: 'transparent' });
    svg.append(hit);
    plot.insertBefore(svg, tip);
    bindPointer(hit);

    // leyenda: solo con 2 o más series
    legend.replaceChildren();
    if (M.kind === 'year') {
      legend.hidden = false;
      for (const ln of M.lines) legend.append(el('span', { class: 'db-key' }, el('i', { class: 'db-keyline ' + ln.cls }), ln.label));
    } else legend.hidden = true;

    if (st.pinned !== null && st.pinned < M.n) show(st.pinned, false); else { st.pinned = null; emit(null); }
  }

  /* ---- interacción ---- */
  const hasData = (i) => st.geom.M.lines.some((ln) => ln.points[i]);
  /** Posición más cercana (solo entre las que tienen datos) a la coordenada X del puntero: el usuario apunta a un mes, no a una línea. */
  function idxAt(e) {
    const { M, X, W } = st.geom, r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * (W / (r.width || W));                       // coordenada en el espacio del SVG
    let best = -1, bd = Infinity;
    for (let i = 0; i < M.n; i++) { if (!hasData(i)) continue; const d = Math.abs(X(i) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function bindPointer(hit) {
    let dragging = false;
    hit.addEventListener('pointerdown', (e) => {
      const i = idxAt(e); if (i < 0) return;
      dragging = true;
      try { hit.setPointerCapture(e.pointerId); } catch (err) { /* nada */ }
      st.pinned = e.pointerType === 'mouse' && st.pinned === i ? null : i;       // ratón: clic fija/suelta; táctil: siempre fija
      show(i, false);
    });
    hit.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' && !dragging) return;                        // táctil: solo mientras se desliza el dedo
      const i = idxAt(e); if (i < 0) return;
      if (dragging) st.pinned = i;
      show(i, false);
    });
    const end = () => { dragging = false; };
    hit.addEventListener('pointerup', end); hit.addEventListener('pointercancel', end);
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !dragging) show(st.pinned, false); });
  }

  /** Avisa al exterior qué mes está activo (solo vista continua); evita repetir el mismo. */
  function emit(m) { if (st.emitted === m) return; st.emitted = m; if (hooks.onActive) { try { hooks.onActive(m); } catch (e) { console.warn(e); } } }
  function show(i, announce) {
    const gm = st.geom; if (!gm || !svg) return;
    const cross = svg.querySelector('.db-cross'), act = svg.querySelector('.db-act');
    if (i === null || i === undefined || i < 0) { cross.style.display = 'none'; act.replaceChildren(); tip.hidden = true; emit(null); return; }
    const { M, X, Y } = gm, x = X(i);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
    act.replaceChildren();
    const rows = [];
    let yTop = Infinity, yBot = -Infinity;
    for (const ln of M.lines) {
      const p = ln.points[i]; if (!p) continue;
      const y = Y(p.total); yTop = Math.min(yTop, y); yBot = Math.max(yBot, y);
      act.append(sv('circle', { cx: x, cy: y, r: 5, class: 'db-dot ' + ln.cls }));
      rows.push({ ln, p });
    }
    if (!rows.length) { cross.style.display = 'none'; tip.hidden = true; emit(null); return; }
    emit(M.kind === 'all' ? rows[0].p : null);
    // contenido del globo: los valores van primero, las etiquetas después (el desglose va en el encabezado de la tarjeta y en la tabla)
    tip.replaceChildren();
    if (M.kind === 'all') {
      const p = rows[0].p;
      tip.append(el('div', { class: 'db-tip-h', text: p.label + (p.live ? ' · en curso' : '') }), el('div', { class: 'db-tip-v', text: money(p.total) }));
      if (isNum(p.delta)) tip.append(el('div', { class: 'db-tip-d' }, chip(p.delta, { short: true, suffix: p.live ? 'este mes' : 'en el mes' })));
    } else {
      tip.append(el('div', { class: 'db-tip-h', text: cap(MONTHS_LONG[i]) }));
      for (const { ln, p } of rows) tip.append(el('div', { class: 'db-tip-r' }, el('i', { class: 'db-keyline ' + ln.cls }), el('span', { class: 'db-tip-v sm', text: money(p.total) }), el('span', { class: 'db-tip-sub', text: ln.label + (p.live ? ' · en curso' : '') })));
    }
    tip.hidden = false;
    // posición del globo: encima de los puntos, si no cabe debajo, y si tampoco al costado de la guía (nunca tapa los puntos activos)
    const tw = tip.offsetWidth, th = tip.offsetHeight, G = 12, pad = 2;
    let left = clamp(x - tw / 2, 4, gm.W - tw - 4), top;
    if (yTop - th - G >= pad) top = yTop - th - G;
    else if (yBot + G + th <= gm.H - pad - 18) top = yBot + G + 2;
    else {
      const roomRight = gm.W - pad - (x + G), roomLeft = x - G - pad;
      left = roomRight >= tw || roomRight >= roomLeft ? Math.min(x + G, gm.W - tw - pad) : Math.max(x - G - tw, pad);
      top = clamp((yTop + yBot) / 2 - th / 2, pad, gm.H - th - pad);
    }
    tip.style.left = Math.round(left) + 'px'; tip.style.top = Math.round(top) + 'px';
    if (announce && rows.length) live.textContent = M.kind === 'all' ? `${rows[0].p.label}: ${money(rows[0].p.total)}${isNum(rows[0].p.delta) ? ', ' + money(rows[0].p.delta, { sign: true }) + ' frente al mes anterior' : ''}` : `${cap(MONTHS_LONG[i])}: ` + rows.map((r) => `${r.ln.label} ${money(r.p.total)}`).join(', ');
  }

  fig.addEventListener('keydown', (e) => {
    const gm = st.geom; if (!gm) return;
    const n = gm.M.n; const idxs = []; for (let i = 0; i < n; i++) if (hasData(i)) idxs.push(i);
    if (!idxs.length) return;
    let pos = st.pinned === null ? -1 : idxs.indexOf(st.pinned);
    if (e.key === 'ArrowRight') pos = pos < 0 ? idxs.length - 1 : Math.min(pos + 1, idxs.length - 1);
    else if (e.key === 'ArrowLeft') pos = pos < 0 ? idxs.length - 1 : Math.max(pos - 1, 0);
    else if (e.key === 'Home') pos = 0; else if (e.key === 'End') pos = idxs.length - 1;
    else if (e.key === 'Escape') { st.pinned = null; show(null); return; } else return;
    e.preventDefault();
    st.pinned = idxs[pos]; show(st.pinned, true);
  });
  const outside = (e) => { if (st.pinned !== null && !fig.contains(e.target)) { st.pinned = null; show(null); } };
  document.addEventListener('pointerdown', outside, true);

  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { const w = Math.round(plot.clientWidth); if (w && Math.abs(w - st.W) >= 1) render(); }); ro.observe(plot); }

  return {
    el: fig,
    update(series) { st.series = series; render(); },
    setMode(mode) { st.mode = mode; st.pinned = null; render(); },
    get mode() { return st.mode; },
    destroy() { document.removeEventListener('pointerdown', outside, true); if (ro) ro.disconnect(); fig.remove(); },
  };
}

/* ================================================================== pantalla */
let ledgerPromise = null;
function loadLedger() {
  if (!ledgerPromise) ledgerPromise = import('./ledger.js').then((m) => m || null).catch(() => null);
  return ledgerPromise;
}
function ledgerEntry(L, id) {
  if (!L || !L.LEDGERS) return null;
  const all = L.LEDGERS;
  if (Array.isArray(all)) return all.find((x) => x && x.id === id) || null;
  return all[id] || null;
}

/**
 * Monta el Resumen en `host`.
 * @param {HTMLElement} host
 * @param {object} ctx  contexto de la app (engine, changed, navigate, openSheet, toast, confirm, today, catalog…)
 * @param {{ledger?:object|false}} opts  opts.ledger inyecta el módulo de movimientos (pruebas); false = no cargarlo
 * @returns {{destroy():void, refresh():void}}
 */
export function mount(host, ctx, opts = {}) {
  const root = el('div', { class: 'db' });
  host.append(root);
  const S = { mode: 'all', tableOpen: false, active: null, editing: null, adding: false, undo: null, undoTimer: 0, ledger: opts.ledger || null, noLedger: opts.ledger === false, recentId: null, destroyed: false, refreshes: 0 };
  let D = null, chart = null;

  const secBanners = el('div', { class: 'db-banners' });
  const secDate = el('p', { class: 'db-date' });
  const secHero = el('section', { class: 'db-hero', 'aria-labelledby': 'db-hero-l' });
  const secActions = el('div', { class: 'db-actions', role: 'group', 'aria-label': 'Accesos rápidos' });
  const secBanks = el('section', { class: 'db-banks', 'aria-labelledby': 'db-banks-h' });
  const secProv = el('section', { class: 'card db-prov', 'aria-labelledby': 'db-prov-h' });
  const secChart = el('section', { class: 'card db-chart', 'aria-labelledby': 'db-chart-h' });
  const secRecent = el('section', { class: 'card db-recent', 'aria-labelledby': 'db-recent-h', hidden: true });
  const top = el('div', { class: 'db-top' }, secHero, secActions, secBanks);                 // móvil: en este orden; escritorio: ver las áreas de la cuadrícula en el CSS
  const main = el('div', { class: 'db-main' }, secProv, secChart, secRecent);
  root.append(secDate, secBanners, top, main);

  const eng = () => ctx.engine;
  const notify = (type, msg, ms) => { try { ctx.toast(msg, { type, ms }); } catch (e) { /* nada */ } };

  /* ---- datos ---- */
  /** Nombres según el catálogo del libro (si lo hay): reemplazan al título de la hoja y rellenan rótulos vacíos de la tabla de CONSOL. */
  function accountNames() {
    const names = {};
    for (const a of ACCOUNTS) {
      try {
        const sh = eng().sheet(a.sid), short = sh && ctx.catalog && ctx.catalog.infoFor ? ctx.catalog.infoFor(sh).short : '';
        if (short && sh && short !== String(sh.name).trim()) names[a.id] = short;   // si el catálogo no tiene nombre, infoFor devuelve el de la hoja: se ignora
      } catch (e) { /* sin catálogo: readSummary usa el título de la hoja */ }
    }
    return names;
  }
  /** Saldo y movimiento del mes de una cuenta, según el módulo de movimientos (si está cargado). */
  function ledgerExtras(id, today) {
    const L = S.ledger;
    if (!L || typeof L.ledgerInfo !== 'function') return null;
    try {
      const info = L.ledgerInfo(eng(), id, { today });
      return info ? { balance: isNum(info.balance) ? info.balance : null, month: info.month && isNum(info.month.amount) ? { amount: info.month.amount, count: info.month.count || 0 } : null } : null;
    } catch (e) { return null; }
  }
  function snapshot() {
    const today = typeof ctx.today === 'function' ? ctx.today() : undefined;
    const summary = readSummary(eng(), { today, names: accountNames() });
    for (const o of summary.others) { const x = ledgerExtras(o.id, today); if (x) { if (x.balance !== null) o.saldo = x.balance; o.month = x.month; } }
    return { summary, prov: readProvisions(eng()), series: readNetWorthSeries(eng(), { today }) };
  }

  /* ---- navegación ---- */
  function openMov(a) {
    const L = S.ledger, known = L && (!L.LEDGERS || ledgerEntry(L, a.id));
    if (ctx.navigate && (known || !L)) ctx.navigate('mov/' + a.id);
    else if (ctx.openSheet) ctx.openSheet(a.sid, { end: true });
  }

  /* ---- avisos ---- */
  function renderBanners() {
    secBanners.replaceChildren();
    const s = D.summary;
    if (S.undo) {
      secBanners.append(el('div', { class: 'banner db-banner ok', role: 'status' }, el('span', { class: 'grow', text: S.undo.text }),
        el('button', { class: 'btn', type: 'button', text: 'Deshacer', onclick: () => { const u = S.undo; clearUndo(); try { u.run(); } catch (e) { console.warn(e); } afterWrite(); notify('ok', 'Cambio deshecho'); } })));
    }
    for (const w of s.warnings) {
      if (w.code === 'nosheet') continue;
      secBanners.append(el('div', { class: 'banner db-banner ' + (w.level === 'error' ? 'err' : 'warn'), role: w.level === 'error' ? 'alert' : 'status' },
        el('span', { class: 'grow', text: w.text }),
        w.code === 'errors' || w.code === 'control' ? el('button', { class: 'btn', type: 'button', text: 'Ver hoja', onclick: () => ctx.openSheet && ctx.openSheet(SID) }) : null));
    }
  }
  function setUndo(text, run) {
    clearUndo();
    S.undo = { text, run };
    S.undoTimer = setTimeout(() => { S.undo = null; if (!S.destroyed && D) renderBanners(); }, 45000);
  }
  function clearUndo() { clearTimeout(S.undoTimer); S.undo = null; }

  /* ---- cabecera con la fecha ---- */
  function renderDate() {
    const t = D.summary.month.today;
    secDate.replaceChildren();
    if (!isNum(t)) return;
    const d = serialToDate(t);
    secDate.append(el('span', { text: cap(DAYS[d.getUTCDay()]) + ' ' + d.getUTCDate() + ' de ' + MONTHS_LONG[d.getUTCMonth()] }));
    if (D.summary.month.currentLabel) secDate.append(el('span', { class: 'db-date-m', text: 'Mes en curso: ' + D.summary.month.currentLabel }));
  }

  /* ---- tarjeta destacada: Disponible hoy ---- */
  function renderHero() {
    const s = D.summary, t = s.totals;
    secHero.replaceChildren();
    if (!s.ok) {
      secHero.append(el('h2', { id: 'db-hero-l', class: 'db-hero-label', text: 'Resumen no disponible' }), el('p', { class: 'db-hero-note', text: 'Este libro no tiene la hoja de resumen (CONSOL), por eso no se pueden calcular los saldos.' }),
        el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', text: 'Ver hojas', onclick: () => ctx.navigate && ctx.navigate('hojas') })));
      return;
    }
    const prevLabel = s.month.previousLabel || 'el mes anterior';
    const value = s.available;
    secHero.append(
      el('div', { class: 'db-hero-top' }, el('h2', { id: 'db-hero-l', class: 'db-hero-label', text: 'Disponible hoy' }), s.month.currentLabel ? el('span', { class: 'db-hero-month', text: s.month.currentLabel }) : null),
      el('div', { class: 'db-hero-value' + (value === null ? ' none' : '') + (value !== null && money(value).length > 11 ? ' long' : ''), text: value === null ? '—' : money(value) }),
      el('p', { class: 'db-hero-sub', text: 'Bancos menos provisiones' }));
    if (value === null) {
      secHero.append(el('p', { class: 'db-hero-note', text: s.empty ? 'Aún no hay cifras en la tabla de bancos.' : 'No se pudo calcular el total.' }));
    } else {
      const flat = isNum(t.variation) && Math.abs(t.variation) < EPS;               // «Mes anterior» = «Mes actual»: se acaba de cerrar el mes
      const c = chip(t.variation, { pct: t.variationPct, versus: flat ? '' : prevLabel, hero: true });
      secHero.append(el('div', { class: 'db-hero-delta' }, c || el('span', { class: 'db-hero-note', text: 'Sin mes anterior para comparar' }), c ? el('span', { class: 'db-hero-vs', text: flat ? 'desde el último cierre' : 'frente a ' + prevLabel }) : null));
    }
    const prov = t.provision;
    secHero.append(el('div', { class: 'db-hero-split' },
      el('div', {}, el('span', { class: 'k', text: 'En bancos' }), el('span', { class: 'v', text: money(t.saldos) })),
      el('div', {}, el('span', { class: 'k', text: 'Provisiones' }), el('span', { class: 'v', text: money(prov) }))));
    if (isNum(t.saldos) && t.saldos > EPS && isNum(prov) && prov < 0) {
      const pct = Math.min(100, Math.abs(prov) / t.saldos * 100);
      secHero.append(el('div', { class: 'db-meter', role: 'img', 'aria-label': `Provisiones: ${pct.toFixed(0)}% de lo que hay en bancos` }, el('i', { style: { width: pct.toFixed(1) + '%' } })),
        el('p', { class: 'db-hero-note', text: `El ${pct.toFixed(0)}% de lo que hay en bancos está apartado en provisiones` }));
    }
    if (isNum(s.extra.amount) && Math.abs(s.extra.amount) > EPS && isNum(s.nowTotal)) {
      secHero.append(el('p', { class: 'db-hero-note', text: `Con ${s.extra.label || 'otros fondos'} ${money(s.extra.amount)}: ${money(s.nowTotal)}` }));
    }
  }

  /* ---- accesos rápidos ---- */
  function renderActions() {
    secActions.replaceChildren();
    const s = D.summary;
    const b = (cls, ic, text, onclick, extra = {}) => el('button', Object.assign({ class: 'btn ' + cls, type: 'button', onclick }, extra), icon(ic, 18), el('span', { text }));
    secActions.append(
      b('primary', 'plus', 'Movimiento', () => ctx.navigate('mov'), { 'aria-label': 'Agregar movimiento' }),
      b('', 'sheet', 'Ver hoja ' + (s.ok ? s.sheetName : 'CONSOL'), () => ctx.openSheet(SID)),
      b('', 'search', 'Buscar', () => ctx.navigate('buscar')),
      b('', 'lock', 'Cerrar mes', onCloseMonth, { disabled: !s.ok || s.empty, title: 'Copia «Mes actual» a «Mes anterior»' }));
  }

  async function onCloseMonth() {
    try {
      const plan = planCloseMonth(eng());
      if (!plan.ok) { notify('warn', plan.reason); return; }
      if (plan.noop) { notify('info', `«${plan.headers.previous}» ya es igual a «${plan.headers.actual}»: no hay nada que cerrar.`); return; }
      const msg = `Se copiarán los valores de «${plan.headers.actual}» a «${plan.headers.previous}» (bancos y provisión). ` +
        `El total anterior pasará de ${money(plan.totalPrevious)} a ${money(plan.totalActual)} y las variaciones quedarán en cero. ` +
        `Las fechas y el patrimonio mensual de la hoja no se modifican.`;
      const ok = await ctx.confirm(msg, { ok: 'Cerrar mes', title: 'Cerrar mes' });
      if (!ok || S.destroyed) return;
      const res = closeMonth(eng());
      if (!res.ok) { notify('error', res.reason || 'No se pudo cerrar el mes.'); return; }
      setUndo(`Listo: «${plan.headers.previous}» ahora tiene los valores de «${plan.headers.actual}».`, () => restoreMonth(eng(), res.before));
      afterWrite();
      notify('ok', 'Mes cerrado');
    } catch (e) { console.error(e); notify('error', 'No se pudo cerrar el mes: ' + ((e && e.message) || e)); }
  }

  /* ---- bancos ---- */
  function bankCard(b, counted) {
    const s = D.summary, prevLabel = s.month.previousLabel || 'el mes anterior';
    const val = b.saldo;
    const a = ACCOUNTS.find((x) => x.id === b.id);
    const children = [
      el('span', { class: 'db-bank-name', text: b.name }),
      el('span', { class: 'db-bank-value' + (val === null ? ' none' : ''), text: val === null ? '—' : money(val) }),
    ];
    if (counted) {
      const c = chip(b.variation, { pct: b.variationPct, versus: prevLabel, short: true });
      children.push(el('span', { class: 'db-bank-delta' }, c || el('span', { class: 'db-bank-note', text: 'Sin mes anterior' })));
      if (b.share !== null) {
        const pct = Math.round(b.share * 100);
        children.push(el('span', { class: 'db-share', role: 'img', 'aria-label': pct + '% de lo que hay en bancos' }, el('i', { style: { width: Math.max(2, b.share * 100).toFixed(1) + '%' } })), el('span', { class: 'db-bank-note', text: pct + '% de los bancos' }));
      }
    } else {
      if (b.month) children.push(el('span', { class: 'db-bank-delta' }, b.month.count > 0 ? chip(b.month.amount, { short: true, suffix: 'este mes' }) : el('span', { class: 'db-bank-note', text: 'Sin movimientos este mes' })));
      children.push(el('span', { class: 'db-bank-note', text: 'No suma al disponible' }));
    }
    children.push(el('span', { class: 'db-bank-go', 'aria-hidden': 'true' }, icon('chev', 16)));
    const label = `${b.name}: ${val === null ? 'sin saldo' : money(val)}${counted && isNum(b.variation) ? ', ' + signWord(b.variation) + (Math.abs(b.variation) < EPS ? '' : ' ' + money(Math.abs(b.variation))) + ' frente a ' + prevLabel : ''}. Abrir movimientos`;
    return el('a', { class: 'card db-bank' + (counted ? '' : ' alt'), href: '#/mov/' + b.id, 'aria-label': label, onclick: (e) => { e.preventDefault(); openMov(a || b); } }, children);
  }
  function renderBanks() {
    secBanks.replaceChildren();
    const s = D.summary;
    if (!s.ok) return;
    secBanks.append(el('div', { class: 'db-sec-head' }, el('h2', { id: 'db-banks-h', text: 'Bancos' }), el('span', { class: 'db-sec-note', text: 'Toca una cuenta para ver sus movimientos' })));
    const grid = el('div', { class: 'db-banks-grid' });
    for (const b of s.banks) grid.append(bankCard(b, true));
    for (const o of s.others) if (!o.missing) grid.append(bankCard(o, false));
    if (!grid.childNodes.length) grid.append(el('p', { class: 'empty', text: 'Sin cuentas para mostrar.' }));
    secBanks.append(grid);
  }

  /* ---- provisiones ---- */
  function renderProv() {
    if (S.editing || S.adding) return;                                         // no pisar lo que se está tecleando
    secProv.replaceChildren();
    const p = D.prov;
    if (!p.ok) { secProv.hidden = true; return; }
    secProv.hidden = false;
    const head = el('div', { class: 'db-card-head' }, el('h2', { id: 'db-prov-h', text: 'Provisiones' }),
      el('span', { class: 'db-card-total' + (p.total === null ? ' none' : ''), text: p.total === null ? '—' : money(p.total) }));
    secProv.append(head);
    if (!p.items.length) secProv.append(el('p', { class: 'empty', text: 'Aún no hay provisiones. Agrega la primera.' }));
    else {
      const ul = el('ul', { class: 'list db-prov-list' });
      for (const it of p.items) ul.append(provRow(it));
      secProv.append(ul);
    }
    const foot = el('div', { class: 'db-prov-foot' });
    if (p.free.length) foot.append(el('button', { class: 'btn ghost', type: 'button', onclick: () => { S.adding = true; renderProvAdd(foot); } }, icon('plus', 16), el('span', { text: 'Agregar provisión' })));
    else foot.append(el('span', { class: 'muted small', text: 'La lista está llena (A8:C17).' }));
    if (isNum(p.previous) && isNum(p.variation)) foot.append(el('span', { class: 'db-prov-prev small muted' }, 'Mes anterior ' + money(p.previous) + ' ', chip(p.variation, { short: true })));
    secProv.append(foot);
    if (p.total !== null && p.sum !== null && Math.abs(p.total - p.sum) > EPS) secProv.append(el('p', { class: 'small muted', text: 'Nota: el total de la hoja difiere de la suma de la lista en ' + money(p.total - p.sum) + '.' }));
  }
  function provRow(it) {
    const name = it.label || 'Sin nombre';
    const amountTxt = it.error ? it.error : it.amount === null ? 'Sin monto' : money(it.amount);
    const btn = el('button', { class: 'db-amt' + (it.amount === null ? ' none' : '') + (it.error ? ' bad' : ''), type: 'button', 'aria-label': `Editar el monto de ${name}: ${amountTxt}`, onclick: () => startEdit(it, li) },
      el('span', { text: amountTxt }), icon('edit', 14));
    const li = el('li', { class: 'db-prov-row' },
      el('div', { class: 'grow' }, el('div', { class: 't', text: name }), el('div', { class: 's' }, it.a1, it.isFormula ? el('span', { class: 'badge db-fx', text: 'fórmula' }) : null)),
      btn);
    return li;
  }
  function startEdit(it, li) {
    if (S.editing) return;
    S.editing = it.r;
    const name = it.label || 'Sin nombre';
    const input = el('input', { type: 'text', inputmode: it.isFormula ? 'text' : 'decimal', autocomplete: 'off', enterkeyhint: 'done', spellcheck: 'false', 'aria-label': 'Monto de ' + name, value: it.raw === null || it.raw === undefined ? '' : String(it.raw), placeholder: 'Ej.: -100.00' });
    const err = el('p', { class: 'db-err small', role: 'alert', hidden: true });
    const save = () => {
      const res = setProvisionAmount(eng(), it.r, input.value);
      if (!res.ok) { err.textContent = res.error; err.hidden = false; input.focus(); return; }
      S.editing = null;
      setUndo(`Monto de «${name}» actualizado.`, () => setProvisionAmount(eng(), it.r, res.before === null || res.before === undefined ? '' : String(res.before)));
      afterWrite();
      notify('ok', 'Provisión actualizada');
    };
    const cancel = () => { S.editing = null; renderProv(); };
    const form = el('form', { class: 'db-edit', novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
      input,
      it.isFormula ? null : el('button', { class: 'btn', type: 'button', text: '±', title: 'Cambiar el signo', 'aria-label': 'Cambiar el signo', onclick: () => { const t = input.value.trim(); input.value = t.startsWith('-') ? t.slice(1) : '-' + t; input.focus(); } }),
      el('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Guardar' }, icon('check', 18), el('span', { text: 'Guardar' })),
      el('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Cancelar', onclick: cancel }, icon('close', 18)));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
    li.classList.add('editing');
    li.replaceChildren(el('div', { class: 'db-edit-wrap' }, el('div', { class: 't', text: name }),
      it.isFormula ? el('p', { class: 'small muted', text: 'Esta línea es una fórmula de la hoja. Puedes editarla; si escribes un número, la reemplazas.' }) : null, form, err));
    input.focus(); input.select();
  }
  function renderProvAdd(foot) {
    const nameIn = el('input', { type: 'text', autocomplete: 'off', 'aria-label': 'Nombre de la provisión', placeholder: 'Nombre de la provisión', maxlength: 60 });
    const amtIn = el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Monto', placeholder: 'Monto (ej.: -100.00)' });
    const err = el('p', { class: 'db-err small', role: 'alert', hidden: true });
    const done = () => { S.adding = false; renderProv(); };
    const form = el('form', { class: 'db-add', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const res = addProvision(eng(), nameIn.value, amtIn.value);
      if (!res.ok) { err.textContent = res.error; err.hidden = false; return; }
      S.adding = false;
      setUndo(`Provisión «${nameIn.value.trim()}» agregada.`, () => clearProvisionLine(eng(), res.r));
      afterWrite(); notify('ok', 'Provisión agregada');
    } },
      nameIn, amtIn,
      el('button', { class: 'btn', type: 'button', text: '±', title: 'Cambiar el signo', 'aria-label': 'Cambiar el signo', onclick: () => { const t = amtIn.value.trim(); amtIn.value = t.startsWith('-') ? t.slice(1) : '-' + t; amtIn.focus(); } }),
      el('button', { class: 'btn primary', type: 'submit' }, icon('check', 18), el('span', { text: 'Agregar' })),
      el('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Cancelar', onclick: done }, icon('close', 18)));
    foot.replaceChildren(form, err);
    nameIn.focus();
  }

  /* ---- gráfico ---- */
  /** Encabezado del gráfico: cifra del mes activo (o el último), cambios y desglose. Mismo formato siempre para que la altura no cambie. */
  function chartSummary(active) {
    const st = D.series.stats, box = el('div', { class: 'db-stats' });
    if (!st.count) return box;
    const m = active || st.latest, yr = D.series.years.find((y) => y.year === m.year);
    const ytd = yr && yr.opening ? m.total - yr.opening.total : null;
    box.append(el('div', { class: 'db-stat' }, el('span', { class: 'k', text: 'Patrimonio ' + m.label + (m.live ? ' · en curso' : '') }), el('span', { class: 'v', text: money(m.total) })));
    const chips = el('div', { class: 'db-stat-chips' });
    if (isNum(m.delta)) chips.append(chip(m.delta, { short: true, suffix: m.live ? 'este mes' : 'en el mes' }));
    if (isNum(ytd)) chips.append(chip(ytd, { short: true, suffix: 'en ' + m.year }));
    if (chips.childNodes.length) box.append(chips);
    const parts = el('div', { class: 'db-stat-parts' });
    m.parts.forEach((v, k) => { if (v !== null) parts.append(el('span', {}, el('span', { class: 'k', text: D.series.labels[k] + ' ' }), el('span', { class: 'v', text: money(v) }))); });
    if (parts.childNodes.length) box.append(parts);
    return box;
  }
  /** Lectura del mes activo en el encabezado (al deslizar o recorrer con el teclado); null = volver al último mes. */
  function onActiveMonth(m) {
    S.active = m;
    const sum = secChart.querySelector('.db-chart-sum'); if (!sum || !D) return;
    if (m && !sum.style.minHeight) sum.style.minHeight = sum.offsetHeight + 'px';         // congela la altura: el gráfico no debe moverse bajo el dedo
    sum.replaceChildren(chartSummary(m));
    if (!m) sum.style.minHeight = '';
  }
  function renderChart() {
    const first = !chart;
    if (first) {
      secChart.replaceChildren();
      const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Vista del gráfico' });
      for (const [v, l] of [['all', 'Continuo'], ['year', 'Por año']]) seg.append(el('button', { type: 'button', class: v === S.mode ? 'on' : '', 'aria-pressed': String(v === S.mode), text: l, onclick: (e) => { S.mode = v; seg.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === e.currentTarget); x.setAttribute('aria-pressed', String(x === e.currentTarget)); }); chart.setMode(v); } }));
      secChart.append(el('div', { class: 'db-card-head' }, el('h2', { id: 'db-chart-h', text: 'Patrimonio mes a mes' }), seg), el('div', { class: 'db-chart-sum' }));
      const holder = el('div', { class: 'db-chart-holder' });
      secChart.append(holder, el('p', { class: 'db-hint' }, el('span', { class: 'mouse', text: 'Pasa el cursor sobre el gráfico para ver cada mes.' }), el('span', { class: 'touch', text: 'Toca o desliza el dedo sobre el gráfico para ver cada mes.' })), el('div', { class: 'db-tablewrap' }));
      chart = createNetWorthChart(holder, { onActive: onActiveMonth });
    }
    const sum = secChart.querySelector('.db-chart-sum'), series = D.series;
    S.active = null; sum.style.minHeight = '';
    sum.replaceChildren(chartSummary(null));
    const hint = secChart.querySelector('.db-hint'), wrap = secChart.querySelector('.db-tablewrap'), holder = secChart.querySelector('.db-chart-holder');
    if (!series.ok || !series.flat.length) {
      holder.hidden = true; hint.hidden = true; wrap.replaceChildren();
      sum.replaceChildren(el('p', { class: 'empty', text: series.ok ? 'Todavía no hay meses cerrados para graficar.' : 'No encuentro los bloques de patrimonio mensual.' }));
      chart.update(null);
      return;
    }
    holder.hidden = false; hint.hidden = false;
    chart.update(series);
    // tabla alternativa (misma información que el gráfico)
    const open = wrap.querySelector('details') ? wrap.querySelector('details').open : S.tableOpen;
    const table = el('table', { class: 't db-table' }, el('caption', { class: 'db-sr', text: 'Patrimonio por mes' }),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Mes' }), ...series.labels.map((l) => el('th', { scope: 'col', class: 'r', text: l })), el('th', { scope: 'col', class: 'r', text: 'Patrimonio' }), el('th', { scope: 'col', class: 'r', text: 'Cambio' }))),
      el('tbody', {}, ...series.flat.slice().reverse().map((m) => el('tr', {}, el('th', { scope: 'row', text: m.label + (m.live ? ' (en curso)' : '') }),
        ...m.parts.map((v) => el('td', { class: 'r', text: v === null ? '—' : money(v) })), el('td', { class: 'r strong', text: money(m.total) }), el('td', { class: 'r', text: isNum(m.delta) ? money(m.delta, { sign: true }) : '—' })))));
    const det = el('details', { class: 'db-details' }, el('summary', { text: 'Ver como tabla' }), el('div', { class: 'scrollx' }, table));
    det.open = open; det.addEventListener('toggle', () => { S.tableOpen = det.open; });
    wrap.replaceChildren(det);
  }

  /* ---- últimos movimientos (opcional: solo si existe el módulo de movimientos) ---- */
  function normMovement(m) {
    if (!m || typeof m !== 'object') return null;
    const pick = (...ks) => { for (const k of ks) if (m[k] !== undefined && m[k] !== null && m[k] !== '') return m[k]; return null; };
    const concept = pick('concept', 'concepto', 'desc', 'description', 'detalle', 'text', 'label');
    let amount = pick('amount', 'monto', 'importe', 'value', 'valor');
    if (amount === null) { const cr = pick('credit', 'credito', 'haber'), db = pick('debit', 'debito', 'debe'); if (cr !== null || db !== null) amount = (+cr || 0) - (+db || 0); }
    const date = pick('date', 'fecha', 'd');
    if (concept === null && amount === null) return null;
    return { date: isNum(date) ? date : null, concept: concept === null ? '' : String(concept), amount: isNum(+amount) && amount !== null ? +amount : null, balance: pick('balance', 'saldo') };
  }
  function recentOf(id) {
    const L = S.ledger;
    if (!L || typeof L.listMovements !== 'function') return null;
    try {
      let list = L.listMovements(eng(), id, { limit: 6 });
      if (!Array.isArray(list)) return null;
      list = list.map(normMovement).filter(Boolean);
      if (list.length > 1 && isNum(list[0].date) && isNum(list[list.length - 1].date) && list[0].date < list[list.length - 1].date) list = list.slice().reverse();   // más reciente primero
      return list.slice(0, 5);
    } catch (e) { console.warn('[dashboard] listMovements:', e); return null; }
  }
  function renderRecent() {
    secRecent.replaceChildren();
    if (!S.ledger || typeof S.ledger.listMovements !== 'function' || !D.summary.ok) { secRecent.hidden = true; return; }
    const known = (id) => !S.ledger.LEDGERS || !!ledgerEntry(S.ledger, id);        // sin registro de cuentas: se asumen todas
    const ids = ACCOUNTS.map((a) => a.id).filter(known);
    if (!ids.length) { secRecent.hidden = true; return; }
    if (!S.recentId || !ids.includes(S.recentId)) S.recentId = ids[0];
    const all = [...D.summary.banks, ...D.summary.others];
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Cuenta' });
    for (const id of ids) { const b = all.find((x) => x.id === id); chips.append(el('button', { type: 'button', class: 'chip' + (id === S.recentId ? ' on' : ''), 'aria-pressed': String(id === S.recentId), text: b ? b.name : id, onclick: () => { S.recentId = id; renderRecent(); } })); }
    const list = recentOf(S.recentId);
    secRecent.append(el('div', { class: 'db-card-head' }, el('h2', { id: 'db-recent-h', text: 'Últimos movimientos' })), chips);
    if (!list || !list.length) secRecent.append(el('p', { class: 'empty', text: 'Sin movimientos recientes.' }));
    else {
      const ul = el('ul', { class: 'list db-recent-list' });
      for (const m of list) ul.append(el('li', {}, el('div', { class: 'grow' }, el('div', { class: 't', text: m.concept || 'Sin concepto' }), el('div', { class: 's', text: isNum(m.date) ? ymd(m.date) : '' })),
        el('span', { class: 'num strong' + (isNum(m.amount) ? (m.amount < 0 ? ' neg' : ' pos') : ''), text: m.amount === null ? '—' : money(m.amount, { sign: true }) })));
      secRecent.append(ul);
    }
    secRecent.append(el('div', { class: 'row end' }, el('button', { class: 'btn ghost', type: 'button', onclick: () => ctx.navigate('mov/' + S.recentId) }, el('span', { text: 'Ver todos' }), icon('chev', 16))));
    secRecent.hidden = false;
  }
  const ymd = (serial) => { const d = serialToDate(serial); return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear(); };

  /* ---- ciclo de vida ---- */
  function renderAll() {
    D = snapshot();
    const ok = D.summary.ok;
    renderDate(); renderBanners(); renderHero(); renderActions();
    top.classList.toggle('solo', !ok);
    secBanks.hidden = !ok;
    renderBanks(); renderProv();
    secChart.hidden = !ok;
    if (ok) renderChart();
    renderRecent();
  }
  function refresh() { if (S.destroyed) return; S.refreshes++; renderAll(); }
  function afterWrite() {
    const before = S.refreshes;
    try { ctx.changed([SID]); } catch (e) { console.warn(e); }
    if (S.refreshes === before) refresh();                                       // por si el contexto no refresca solo
  }

  try { renderAll(); } catch (e) {
    console.error(e);
    root.append(el('div', { class: 'card' }, el('h2', { text: 'No se pudo mostrar el resumen' }), el('p', { class: 'muted', text: String((e && e.message) || e) })));
  }
  if (!S.ledger && !S.noLedger) loadLedger().then((m) => { if (m && !S.destroyed) { S.ledger = m; if (D) { D = snapshot(); renderBanks(); renderRecent(); } } });

  return {
    refresh,
    destroy() { S.destroyed = true; clearUndo(); if (chart) chart.destroy(); root.remove(); },
  };
}
