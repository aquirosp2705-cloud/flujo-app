/* rubros.js — «Ingresos y egresos del mes»: lo que entró y salió en un mes en los bancos y las tarjetas, agrupado por rubro.
 *
 * Este archivo NO contiene datos de la persona: rubros, conceptos, cuentas y montos se leen de las hojas. Solo se conocen las
 * posiciones de las hojas (ledger.js y quick.js) y unas palabras genéricas de banca («pago», «tc», «transf», «póliza», «nd»…).
 *
 * De dónde sale cada cosa:
 *   - cuentas bancarias (ledger.js): una fila por movimiento; el mes es el de la columna de fecha (número de serie o un texto como
 *     «nov26»); el concepto es la descripción. Lo que entra es ingreso y lo que sale, egreso. Una comisión pequeña (hasta $10) escrita
 *     en negativo en la columna de créditos de una fila que ya es un egreso va a «Comisiones bancarias».
 *   - tarjeta de consumos (quick.js · tcpich): mes (A), rubro (B), detalle (C), monto (D) y ajuste (E). Si C es un número, la fila es
 *     la cuota de una compra diferida: va a «Compras diferidas (cuotas)».
 *   - hoja con tarjeta y cuenta de ahorros (quick.js · produb): la cuenta (A mes, B concepto, D ajuste, E monto con signo) se lee como
 *     un banco. La zona de la tarjeta (G concepto, H monto) NO tiene fechas: sus pagos (montos negativos) se emparejan por monto con los
 *     pagos de la cuenta, que sí tienen mes; los consumos de un mes son los anotados después del pago del mes anterior y hasta el pago
 *     de ese mes (si todavía no hay pago, hasta la última fila); lo anotado después del pago va al mes siguiente.
 *   - el mes de cada fila (assignMonths): en los bancos manda la FECHA que escribiste (si cambias la fecha de un movimiento, pasa a
 *     ese mes; si está anotado entre movimientos de otro mes, se avisa en «Para revisar»); solo un año mal tipeado (2025 por 2026) o
 *     una fila sin fecha toman el mes del bloque donde están. En la tarjeta de consumos cuenta el corte donde está la fila.
 *   - NO suman, para no contar dos veces: los pagos de tarjeta hechos desde un banco (los consumos ya están en egresos), el dinero que
 *     pasa entre tus cuentas (palabras como «de bol», «a produb», «transf de ahorros», o el mismo monto que sale de una cuenta y entra
 *     en otra) y lo que va a pólizas o vuelve de ellas.
 *
 * API:  summarizeMonth(engine, 'AAAA-MM' | serie, opts) -> resumen · monthOf(clave) · monthIndexOfCell(valor) · conceptKey(texto)
 *       renderSummary(resumen, opts) -> nodo · mount(host, ctx, 'AAAA-MM') -> pantalla #/rubros · openSummaryDialog(ctx, 'AAAA-MM', opts)
 *       downloadSummary(resumen) -> descarga .xlsx · SHEETS_USED(engine) -> hojas que hay que cargar antes de resumir
 */
import { el, money, monthText, dateText } from './ui.js';
import { todaySerial } from './format.js';
import * as Ledger from './ledger.js';
import { LAYOUTS, SHEETS as QSHEETS } from './quick.js';
import { infoFor } from './catalog.js';

const EPS = 0.005;
const FEE_MAX = 10;            // una comisión pegada a un egreso no pasa de $10
const STOP_AFTER = 150;        // al leer de abajo hacia arriba, se para tras 150 filas seguidas de meses anteriores
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (v) => (isNum(v) ? v : null);
const r2 = (x) => Ledger.round2(x);
const plural = (n, one, many) => (n === 1 ? one : many);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_NO = {
  ene: 1, enero: 1, jan: 1, feb: 2, febrero: 2, mar: 3, mzo: 3, marzo: 3, abr: 4, abril: 4, apr: 4, may: 5, mayo: 5, jun: 6, junio: 6, jul: 7, julio: 7,
  ago: 8, agosto: 8, aug: 8, sep: 9, sept: 9, set: 9, septiembre: 9, setiembre: 9, oct: 10, octubre: 10, nov: 11, noviembre: 11, dic: 12, diciembre: 12, dec: 12,
};
const cap = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : t; };

/* ===================================================================== meses */
const idxOf = (y, m) => y * 12 + (m - 1);
const idxOfSerial = (n) => { const d = Ledger.fromSerial(n); return idxOf(d.y, d.m); };

/** Mes a partir de 'AAAA-MM' o de un número de serie: {y, m, idx, key, label, name, start, end}; null si no es válido. */
export function monthOf(x) {
  let y, m;
  if (x && typeof x === 'object' && isNum(x.y) && isNum(x.m)) { y = x.y; m = x.m; }
  else if (isNum(x)) { const d = Ledger.fromSerial(x); y = d.y; m = d.m; }
  else { const t = /^(\d{4})-(\d{1,2})$/.exec(String(x ?? '').trim()); if (!t) return null; y = +t[1]; m = +t[2]; }
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12)) return null;
  return { y, m, idx: idxOf(y, m), key: y + '-' + String(m).padStart(2, '0'), label: MESES[m - 1] + ' ' + y, name: MESES[m - 1], start: Ledger.toSerial(y, m, 1), end: Ledger.toSerial(y, m + 1, 1) - 1 };
}
const monthOfIdx = (i) => monthOf({ y: Math.floor(i / 12), m: (i % 12) + 1 });
export const shiftMonth = (key, delta) => { const M = monthOf(key); return M ? monthOfIdx(M.idx + delta) : null; };

/** Mes (año × 12 + mes − 1) de una celda de fecha: número de serie o texto («nov26», «nov-26», «nov 2026», «noviembre de 2026»,
 *  «11/2026», «13/11/2026», «nov1826», «ago 212026»…). null si no se entiende. */
export function monthIndexOfCell(v) {
  if (isNum(v)) return Ledger.isPlausibleSerial(v) ? idxOfSerial(v) : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t || !/\d/.test(t)) return null;
  let m = /^([a-z]{3,10})\.?[\s\-\/.]*(?:de\s+)?(\d{2}|\d{4})$/.exec(t);
  if (m && MES_NO[m[1]]) { const y = m[2].length === 2 ? 2000 + +m[2] : +m[2]; if (y >= 1990 && y <= 2100) return idxOf(y, MES_NO[m[1]]); }
  m = /^(\d{1,2})[\/\-.](\d{4})$/.exec(t);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1990 && +m[2] <= 2100) return idxOf(+m[2], +m[1]);
  m = /^(\d{4})[\/\-.](\d{1,2})$/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1990 && +m[1] <= 2100) return idxOf(+m[1], +m[2]);
  const u = t.replace(/(^|[^a-z])mzo/g, '$1mar');                       // «mzo» (marzo) no lo entiende parseLooseDate
  const s = Ledger.parseLooseDate(u) ?? Ledger.parseLooseDate(u.replace(/\s+/g, ''));
  return s === null ? null : idxOfSerial(s);
}

/* ===================================================================== conceptos */
/** Clave para agrupar conceptos: sin acentos ni mayúsculas, sin cuotas «3/12» ni números al final («dep bol1», «pasaje 2»). */
export function conceptKey(s) {
  let t = String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/\b\d{1,3}\s*\/\s*\d{1,3}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  t = t.replace(/([a-z])\d+$/, '$1').replace(/(\s\d+)+$/, '').trim();
  return t;
}
const isFiller = (t) => /^[x\/\s-]+$/i.test(t);              // «xx», «xxx», «xx/xxx»: separadores, no rubros
const BANKW = '(gye|guayaquil|bol|bolivariano|pich|pichincha|produb|produbanco|ahorros?|ah|cte|corriente)';
const RX_XFER = new RegExp('^(transf|tranf|transferencia|trans|trf|dep|deposito|de|desde|a|al|para|hacia)\\b.*\\b' + BANKW + '\\b|^' + BANKW + '$');
const RX_BANKW = new RegExp('\\b' + BANKW + '\\b');
const RX_XFER_VERB = /^(transf|tranf|transferencia|trans|trf|dep|deposito)\b/;
/** Pista de transferencia en un concepto: 2 = nombra una de tus cuentas, 1 = solo el verbo («dep», «transf»), 0 = nada. */
const xferHint = (key) => (RX_BANKW.test(key) ? 2 : RX_XFER_VERB.test(key) ? 1 : 0);
const RX_CARD = /\b(tc|tarjeta|tarj|visa|mastercard|diners|amex)\b|^(pago|pgo|pag)( (tc|mes|tarjeta))?$|^pagotc$/;
const RX_INV = /\bpoliza|\binversion|\bplazo fijo\b/;
const RX_INT = /\bint\b|\binteres(es)?\b/;
const RX_FEE = /^(nd|n d|nota de debito|comision(es)?( bancarias?)?|cargos?( bancarios?)?)$/;
const RX_PAY = /^(pago|pgo|pag)\b|^pagotc$/;

/** Tipo de un movimiento de banco según su concepto: in | out | fee | card | xfer | inv. */
export function classifyBank(key, dir) {
  if (RX_FEE.test(key)) return dir === 'out' ? 'fee' : 'in';
  if (RX_INV.test(key) && !RX_INT.test(key)) return 'inv';
  if (dir === 'out' && RX_CARD.test(key)) return 'card';
  if (RX_XFER.test(key)) return 'xfer';
  return dir;
}

/* ===================================================================== lectura de las hojas */
/**
 * Mes de cada fila según su bloque. Las hojas se anotan en orden, así que una fila es del mes del bloque donde está:
 *   - el bloque avanza a un mes posterior cercano (hasta 2 meses) si alguna de las 3 filas con fecha que siguen lo confirma, y a uno
 *     lejano solo si las 3 siguientes traen ese mismo mes (o si ya no hay más filas);
 *   - si una racha de filas trae un mismo mes anterior al bloque (la fila de la fecha y las 2 o 3 siguientes), el bloque estaba mal
 *     y vuelve a ese mes;
 *   - una fila sin fecha toma el mes del bloque ('nodate'); una con el mismo mes y otro año (2025 por 2026) es un error de tipeo y
 *     cuenta en el bloque ('year');
 *   - una fila con OTRO MES: en los bancos (trustDates) manda la fecha que escribiste —si cambias la fecha de un movimiento, pasa a
 *     ese mes— y se marca 'own' para avisar, siempre que esté a 2 meses o menos del bloque (más lejos es un error de tipeo: 'month'); en la tarjeta de consumos cuenta en el corte donde está ('month'), porque ahí la columna
 *     del mes es la etiqueta del corte y las cuotas copiadas conservan el mes de compra.
 * Así cada fila cae en un solo mes y una fila suelta no estira ni traba ningún mes.
 * @param {Array<{mi:number|null}>} rows  de arriba hacia abajo; a cada una se le pone em (mes efectivo o null), blk (mes del bloque
 *   donde está anotada) y flag
 * @param {{trustDates?:boolean}} opts
 */
const TRUST_SPAN = 2;          // en los bancos manda la fecha escrita si está a 2 meses o menos del bloque; más lejos es un error de tipeo
export function assignMonths(rows, { trustDates = false } = {}) {
  const dated = [];
  rows.forEach((x, i) => { if (x.mi !== null) dated.push(i); });
  let block = null, k = 0;
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i];
    while (k < dated.length && dated[k] <= i) k++;                      // dated[k]: la siguiente fila con fecha
    x.flag = null;
    if (x.mi === null) { x.em = x.blk = block; if (block !== null) x.flag = 'nodate'; continue; }
    if (block === null || x.mi === block) { block = x.mi; x.em = x.blk = x.mi; continue; }
    const next = dated.slice(k, k + 3).map((j) => rows[j].mi);
    if (x.mi > block) {
      // confirma una fila que trae ese mes o uno posterior, o el mismo mes con el año mal tipeado: la siguiente, o 2 de las 3 siguientes
      const agree = (m) => m >= x.mi || (m - x.mi) % 12 === 0;
      const ok = !next.length || (x.mi - block <= 2 ? agree(next[0]) || next.filter(agree).length >= 2 : next.every((m) => m === x.mi));
      if (ok) { block = x.mi; x.em = x.blk = x.mi; continue; }
    } else if (next.length >= 2 && next.every((m) => m === x.mi)) { block = x.mi; x.em = x.blk = x.mi; continue; }
    x.blk = block;
    if ((x.mi - block) % 12 === 0) { x.em = block; x.flag = 'year'; }
    else if (trustDates && Math.abs(x.mi - block) <= TRUST_SPAN) { x.em = x.mi; x.flag = 'own'; }
    else { x.em = block; x.flag = 'month'; }
  }
  return rows;
}
const ofMonth = (rows, M) => assignMonths(rows).filter((x) => x.em === M.idx);
/** Filas anotadas entre los movimientos de M que, por su fecha, cuentan en otro mes (para avisarlo en «Para revisar»). */
const movedOut = (rows, M) => rows.filter((x) => x.flag === 'own' && x.blk === M.idx && x.em !== M.idx);
const textOf = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : isNum(v) ? String(v) : '');
/** Fecha para mostrar: «nov-26» si es el día 1 (las hojas anotan por mes), «13/11/2026» si es otro día; los textos tal cual. */
const whenOf = (v) => (isNum(v) && Ledger.isPlausibleSerial(v) ? (Ledger.fromSerial(v).d === 1 ? monthText(v) : dateText(v)) : textOf(v));

/** Cuentas de ledger.js. `moved` recibe las filas del bloque de M que, por su fecha, cuentan en otro mes. */
function readBank(eng, src, M, push, moved) {
  const L = src.L, last = Ledger.lastMovementRow(eng, L.id);
  const rows = []; let older = 0;
  for (let r = last; r >= L.firstDataRow; r--) {
    const mv = Ledger.readMovement(eng, L.id, r);
    if (!mv) continue;
    const mi = mv.date !== null ? idxOfSerial(mv.date) : monthIndexOfCell(mv.dateLabel);
    rows.push({ r, mi, mv });
    if (mi !== null && mi < M.idx - 1) { if (++older >= STOP_AFTER) break; } else older = 0;
  }
  rows.reverse();
  assignMonths(rows, { trustDates: true });
  for (const x of movedOut(rows, M)) moved.push({ srcLabel: src.label, r: x.r, concept: x.mv.desc || '', em: x.em, when: whenOf(x.mv.date !== null ? x.mv.date : x.mv.dateLabel) });
  for (const x of rows.filter((y) => y.em === M.idx)) {
    const mv = x.mv;
    const terms = L.terms.map((t) => { const c = mv.amountCells.find((a) => a.col === t.col); return { side: t.side, v: t.effect * (c && isNum(c.value) ? c.value : 0) }; });
    const hasOut = terms.some((t) => t.side === 'debit' && t.v < -EPS);
    let fee = 0, net = 0;
    for (const t of terms) { if (t.side === 'credit' && t.v < -EPS && -t.v <= FEE_MAX && hasOut) fee -= t.v; else net += t.v; }
    const base = { src: src.id, srcLabel: src.label, sid: L.sid, r: x.r, c: L.cols.desc, when: whenOf(mv.date !== null ? mv.date : mv.dateLabel), flag: x.flag || null, blk: x.blk, concept: mv.desc || '', bank: true };
    if (fee > EPS) push(Object.assign({}, base, { kind: 'fee', amount: r2(fee), feeOf: true }));
    net = r2(net);
    if (Math.abs(net) > EPS) { const dir = net > 0 ? 'in' : 'out'; push(Object.assign({}, base, { dir, kind: classifyBank(conceptKey(mv.desc), dir), amount: Math.abs(net) })); }
  }
}

/** Tarjeta de consumos por corte (A mes, B rubro, C detalle o saldo diferido, D monto, E ajuste). */
function readCardTcp(eng, src, M, push) {
  const T = LAYOUTS.tcpich, sid = src.sid, sh = eng.sheet(sid);
  const rows = []; let older = 0;
  for (let r = sh.rows - 1; r >= T.first; r--) {
    const d = num(eng.value(sid, r, T.D)), e = num(eng.value(sid, r, T.E));
    if ((d === null || Math.abs(d) < EPS) && (e === null || Math.abs(e) < EPS)) continue;
    const a = eng.value(sid, r, T.A), mi = monthIndexOfCell(a);
    rows.push({ r, mi, a, d, e, cv: eng.value(sid, r, T.C) });
    if (mi !== null && mi < M.idx - 1) { if (++older >= STOP_AFTER) break; } else older = 0;
  }
  rows.reverse();
  const ADJ = { rubroKey: '_adj', rubroLabel: 'Ajustes de la tarjeta' };
  for (const x of ofMonth(rows, M)) {
    const b = textOf(eng.value(sid, x.r, T.B)), cv = x.cv, c = typeof cv === 'string' ? textOf(cv) : '';
    const dif = isNum(cv) && b && !isFiller(b);                         // cuota de una compra diferida: conserva el mes de compra
    const base = { src: src.id, srcLabel: src.label, sid, r: x.r, c: T.B, when: whenOf(x.a), flag: dif && x.flag !== 'nodate' ? null : x.flag, dir: 'out', kind: 'out' };
    const bigAdj = x.e !== null && Math.abs(x.e) > FEE_MAX;             // un ajuste grande (conciliación) no deforma el rubro de la fila
    const amount = r2((x.d || 0) + (bigAdj ? 0 : x.e || 0));
    if (bigAdj) push(Object.assign({}, base, ADJ, { amount: r2(x.e), concept: 'Ajuste' + (b && !isFiller(b) ? ' (fila de ' + b + ')' : '') }));
    if (Math.abs(amount) < EPS) continue;
    let rubroKey, rubroLabel, concept;
    if (dif) { rubroKey = '_dif'; rubroLabel = 'Compras diferidas (cuotas)'; concept = b; }
    else if (!b || isFiller(b)) {
      if (x.d === null || Math.abs(x.d) < EPS) { rubroKey = ADJ.rubroKey; rubroLabel = ADJ.rubroLabel; concept = c || 'Ajuste'; }
      else { rubroKey = '_none'; rubroLabel = 'Sin rubro'; concept = c || 'Sin detalle'; }
    } else { rubroKey = conceptKey(b) || '_none'; rubroLabel = b; concept = c || b; }
    push(Object.assign({}, base, { amount, concept, rubroKey, rubroLabel }));
  }
}

/** Hoja con la cuenta de ahorros (A, B, D, E) y la tarjeta sin fechas (G, H). */
function readProdub(eng, acc, card, M, push, notes, moved) {
  const P = LAYOUTS.produb, sid = acc.sid, sh = eng.sheet(sid);
  const acct = [];
  for (let r = P.acctFirst; r <= Math.min(P.acctMax, sh.rows - 1); r++) {
    const d = num(eng.value(sid, r, P.D)), e = num(eng.value(sid, r, P.E));
    if (d === null && e === null) continue;
    const a = eng.value(sid, r, P.A), b = textOf(eng.value(sid, r, P.B));
    acct.push({ r, mi: monthIndexOfCell(a), a, b, key: conceptKey(b), d, e });
  }
  assignMonths(acct, { trustDates: true });
  for (const x of movedOut(acct, M)) moved.push({ srcLabel: acc.label, r: x.r, concept: x.b, em: x.em, when: whenOf(x.a) });
  for (const x of acct.filter((y) => y.em === M.idx)) {
    const base = { src: acc.id, srcLabel: acc.label, sid, r: x.r, c: P.B, when: whenOf(x.a), flag: x.flag || null, blk: x.blk, concept: x.b, bank: true };
    let net = x.e || 0;
    if (x.d !== null) { if (x.d < -EPS && -x.d <= FEE_MAX) push(Object.assign({}, base, { kind: 'fee', amount: r2(-x.d), feeOf: Math.abs(x.e || 0) > EPS })); else net += x.d; }
    net = r2(net);
    if (Math.abs(net) > EPS) { const dir = net > 0 ? 'in' : 'out'; push(Object.assign({}, base, { dir, kind: classifyBank(x.key, dir), amount: Math.abs(net) })); }
  }

  // zona de la tarjeta: no tiene fechas; se ubica el mes por sus pagos, emparejados por monto con los pagos de la cuenta (que sí tienen mes)
  let last = -1;
  for (let r = sh.rows - 1; r >= P.cardFirst; r--) { if (textOf(eng.value(sid, r, P.G)) || num(eng.value(sid, r, P.H)) !== null) { last = r; break; } }
  if (last < 0) return;
  const pays = acct.filter((x) => isNum(x.e) && x.e < -EPS && x.em !== null && (RX_CARD.test(x.key) || RX_PAY.test(x.key))).map((x) => ({ amt: r2(-x.e), mi: x.em, used: false }));
  const rows = [];
  let lastMi = -Infinity;
  for (let r = P.cardFirst; r <= last; r++) {
    const h = num(eng.value(sid, r, P.H));
    if (h === null || Math.abs(h) < EPS) continue;
    const g = textOf(eng.value(sid, r, P.G));
    const x = { r, g, h, mi: null, pay: h < -EPS && RX_PAY.test(conceptKey(g)) };
    if (x.pay) {                                                        // en orden: un pago no puede ser de un mes anterior al pago de arriba
      const p = pays.find((y) => !y.used && y.mi >= lastMi && Math.abs(y.amt + h) < EPS);
      if (p) { p.used = true; x.mi = p.mi; lastMi = p.mi; }
    }
    rows.push(x);
  }
  const matched = rows.filter((x) => x.mi !== null);
  const bnd = (mi) => { let b = -1, bm = null; for (const x of matched) if (x.mi <= mi && x.r > b) { b = x.r; bm = x.mi; } return { r: b, mi: bm }; };
  const prev = bnd(M.idx - 1);
  if (!matched.length || prev.r < 0) {
    notes.push({ id: 'produb', level: 'warn', text: card.label + ' no tiene fechas y no se encontró un pago anterior a ' + M.label + ' para ubicar sus consumos: no se incluyó.' });
    return;
  }
  const own = matched.filter((x) => x.mi === M.idx), later = matched.some((x) => x.mi > M.idx);
  const pm = monthOfIdx(prev.mi);
  if (!own.length && later) {                            // en este mes no hubo pago: sus consumos se cuentan con el pago siguiente
    notes.push({ id: 'produb', level: 'info', text: card.label + ' no tiene fechas y en ' + M.name + ' no se registró un pago: sus consumos se cuentan en el mes del pago siguiente.' });
    return;
  }
  const end = own.length ? own[own.length - 1].r : last;  // con pago del mes: hasta ese pago (lo de después es del mes siguiente)
  const consumos = rows.filter((x) => x.r > prev.r && x.r <= end && !x.pay);
  const rango = consumos.length ? ' (filas ' + (consumos[0].r + 1) + (consumos.length > 1 ? ' a ' + (consumos[consumos.length - 1].r + 1) : '') + ')' : '';
  notes.push({ id: 'produb', level: 'info', text: card.label + ' no tiene fechas: se tomaron los consumos anotados después del pago de ' + (pm ? pm.label : 'el mes anterior') +
    (own.length ? ' y hasta el pago de ' + M.name : ' (todavía no hay pago de ' + M.name + ': lo que anotes antes de pagarla también entra)') + rango + '.' });
  for (const x of consumos) push({ src: card.id, srcLabel: card.label, sid, r: x.r, c: P.G, when: '', flag: null, dir: 'out', kind: 'out', amount: r2(x.h), concept: x.g || 'Sin detalle' });
}

/** Hojas que lee el resumen (para cargarlas antes, con aviso de «Cargando…»). */
export function SHEETS_USED(eng) {
  const out = Ledger.listLedgers().map((L) => L.sid).concat([QSHEETS.tcpich, QSHEETS.produb]);
  return out.filter((sid) => eng && eng.sheet && eng.sheet(sid));
}
const shortOf = (eng, sid, fb) => { try { const sh = eng.sheet(sid); return sh ? infoFor(sh).short || String(sh.name).trim() : fb; } catch (e) { return fb; } };

/* ===================================================================== resumen */
/**
 * Resume un mes.
 * @returns {{month, totals:{in,out,net,card,xferOut,xferIn,invOut,invIn}, groups:{in:Group[], out:Group[], card:Group[], xfer:Group[], inv:Group[]},
 *   sources:{id,label,in,out,skip,count}[], entries:Entry[], notes:{id,level,text}[], count:number}}
 *   Group = {key, label, total, count, items:Entry[], sources:string[]}
 */
export function summarizeMonth(eng, month, opts = {}) {
  const M = monthOf(month);
  if (!M) throw new Error('Mes no válido: ' + month);
  const entries = [], notes = [], sources = [], moved = [];
  const push = (e) => entries.push(e);
  const tryRead = (src, fn) => { sources.push(src); try { fn(); } catch (e) { console.warn('[rubros]', src.label, e); notes.push({ id: 'read', level: 'warn', text: 'No se pudo leer ' + src.label + ' (' + ((e && e.message) || e) + ').' }); } };

  for (const L of Ledger.listLedgers()) {
    if (!eng.sheet(L.sid)) continue;
    const src = { id: L.id, sid: L.sid, kind: 'bank', label: L.short || L.title, L };
    tryRead(src, () => readBank(eng, src, M, push, moved));
  }
  if (eng.sheet(QSHEETS.tcpich)) {
    const src = { id: 'tcpich', sid: QSHEETS.tcpich, kind: 'card', label: shortOf(eng, QSHEETS.tcpich, 'Tarjeta de consumos') };
    tryRead(src, () => readCardTcp(eng, src, M, push));
  }
  if (eng.sheet(QSHEETS.produb)) {
    const cardLabel = shortOf(eng, QSHEETS.produb, 'Tarjeta');
    const bankName = cardLabel.replace(/^tarjeta\s+/i, '') || cardLabel;
    const acc = { id: 'produb-cta', sid: QSHEETS.produb, kind: 'bank', label: bankName + ' · Ahorros' };
    const card = { id: 'produb-tc', sid: QSHEETS.produb, kind: 'card', label: cardLabel };
    sources.push(card);
    tryRead(acc, () => readProdub(eng, acc, card, M, push, notes, moved));
  }

  // dinero entre tus cuentas: el mismo monto sale de una y entra en otra, y los conceptos lo sugieren (uno nombra una de tus
  // cuentas, o los dos empiezan con «dep»/«transf»); un pago a una persona y un depósito del mismo monto NO se emparejan
  // 1.º se emparejan entre sí las que ya son transferencias por sus palabras; 2.º una que lo es puede arrastrar a su contraparte del
  // mismo monto si esta tiene alguna pista (p. ej. «Produbanco» −830 frente a «dep guayaquil» +830); y dos que no lo son, si juntas suman 2
  const legs = entries.filter((e) => e.bank && (e.kind === 'in' || e.kind === 'out' || e.kind === 'xfer'));
  const hint = (e) => (e.kind === 'xfer' ? 3 : xferHint(conceptKey(e.concept)));
  const canPair = (o, i) => {
    const ho = hint(o), hi = hint(i);
    if (ho === 3 && hi === 3) return true;
    if (ho === 3) return hi >= 1;
    if (hi === 3) return ho >= 1;
    return ho + hi >= 2;
  };
  for (const pass of [1, 2]) {
    for (const o of legs) {
      if (o.pair || o.dir !== 'out' || (pass === 1 && o.kind !== 'xfer')) continue;
      const i = legs.find((x) => !x.pair && x.dir === 'in' && x.src !== o.src && Math.abs(x.amount - o.amount) < EPS && (pass === 1 ? x.kind === 'xfer' : canPair(o, x)));
      if (i) { o.kind = 'xfer'; i.kind = 'xfer'; o.pair = true; i.pair = true; }
    }
  }

  const groups = { in: [], out: [], card: [], xfer: [], inv: [] };
  const byKey = { in: new Map(), out: new Map(), card: new Map(), xfer: new Map(), inv: new Map() };
  for (const e of entries) {
    const sec = e.kind === 'fee' ? 'out' : e.kind;
    let key, label;
    if (e.kind === 'fee') { key = '_fee'; label = 'Comisiones bancarias'; }
    else if (e.rubroKey) { key = e.rubroKey; label = e.rubroLabel; }
    else {
      key = conceptKey(e.concept) || '_none'; label = e.concept || 'Sin concepto';
      if (sec === 'in' && RX_FEE.test(key)) { key = '_adjb'; label = 'Ajustes bancarios'; }
    }
    const map = byKey[sec];
    let g = map.get(key);
    if (!g) { g = { key, total: 0, count: 0, items: [], forms: new Map(), srcs: new Set() }; map.set(key, g); groups[sec].push(g); }
    const signed = sec === 'xfer' || sec === 'inv' ? (e.dir === 'in' ? e.amount : -e.amount) : e.amount;
    g.total = r2(g.total + signed); g.count++; g.items.push(e); g.srcs.add(e.srcLabel);
    const f = cap(label); g.forms.set(f, (g.forms.get(f) || 0) + 1);
  }
  for (const sec of Object.keys(groups)) {
    for (const g of groups[sec]) {
      g.label = [...g.forms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))[0][0];
      g.sources = [...g.srcs]; delete g.forms; delete g.srcs;
      g.items.sort((a, b) => (a.src === b.src ? a.r - b.r : a.srcLabel.localeCompare(b.srcLabel, 'es')));
    }
    groups[sec].sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.label.localeCompare(b.label, 'es'));
  }

  const sum = (list, f) => r2(list.reduce((a, e) => a + f(e), 0));
  const tIn = sum(groups.in, (g) => g.total), tOut = sum(groups.out, (g) => g.total);
  const xf = entries.filter((e) => e.kind === 'xfer'), iv = entries.filter((e) => e.kind === 'inv');
  const totals = {
    in: tIn, out: tOut, net: r2(tIn - tOut),
    card: sum(groups.card, (g) => g.total),
    xferOut: sum(xf.filter((e) => e.dir === 'out'), (e) => e.amount), xferIn: sum(xf.filter((e) => e.dir === 'in'), (e) => e.amount),
    invOut: sum(iv.filter((e) => e.dir === 'out'), (e) => e.amount), invIn: sum(iv.filter((e) => e.dir === 'in'), (e) => e.amount),
  };

  const bySrc = sources.map((s) => {
    const mine = entries.filter((e) => e.src === s.id);
    return {
      id: s.id, label: s.label, kind: s.kind, count: mine.length,
      in: sum(mine.filter((e) => e.kind === 'in'), (e) => e.amount),
      out: sum(mine.filter((e) => e.kind === 'out' || e.kind === 'fee'), (e) => e.amount),
      skip: sum(mine.filter((e) => e.kind === 'card' || e.kind === 'xfer' || e.kind === 'inv'), (e) => e.amount),
    };
  });
  const empty = bySrc.filter((s) => !s.count).map((s) => s.label);
  if (empty.length && empty.length < bySrc.length) notes.push({ id: 'empty', level: 'info', text: 'Sin movimientos en ' + M.name + ': ' + empty.join(', ') + '.' });
  const flagged = entries.filter((e) => e.flag);
  if (flagged.length) {
    const desc = (e) => e.srcLabel + ' fila ' + (e.r + 1) + (e.when ? ' («' + e.when + '»)' : ' (sin fecha)');
    const yr = flagged.filter((e) => e.flag === 'year'), nd = flagged.filter((e) => e.flag === 'nodate'), mo = flagged.filter((e) => e.flag === 'month');
    const uniq = (list) => [...new Map(list.map((e) => [e.src + ':' + e.r, e])).values()];
    if (yr.length) notes.push({ id: 'year', level: 'warn', text: 'Fecha con otro año, entre movimientos de ' + M.label + ' (se contaron en ' + M.name + '): ' + uniq(yr).map(desc).join('; ') + '.' });
    if (mo.length) notes.push({ id: 'month', level: 'warn', text: 'Fecha de otro mes, entre movimientos de ' + M.label + ' (se contaron en ' + M.name + ', donde están anotados): ' + uniq(mo).map(desc).join('; ') + '.' });
    const own = flagged.filter((e) => e.flag === 'own');
    const blkName = (e) => { const b = e.blk === null || e.blk === undefined ? null : monthOfIdx(e.blk); return b ? ' (anotada entre los de ' + (b.y === M.y ? b.name : b.label) + ')' : ''; };
    if (own.length) notes.push({ id: 'own', level: 'info', text: 'Se cuentan en ' + M.name + ' por su fecha, aunque están anotadas entre movimientos de otro mes: ' + uniq(own).map((e) => e.srcLabel + ' fila ' + (e.r + 1) + ' «' + (e.concept || 'sin concepto') + '»' + blkName(e)).join('; ') + '.' });
    if (nd.length) notes.push({ id: 'nodate', level: 'warn', text: 'Sin fecha, entre movimientos de ' + M.label + ' (se contaron en ' + M.name + '): ' + uniq(nd).map(desc).join('; ') + '.' });
  }
  if (moved.length) {
    notes.push({ id: 'moved', level: 'info', text: 'Anotadas entre los movimientos de ' + M.name + ' pero con fecha de otro mes (se cuentan en ese mes): ' +
      moved.map((x) => { const m = monthOfIdx(x.em); return x.srcLabel + ' fila ' + (x.r + 1) + ' «' + (x.concept || 'sin concepto') + '» → ' + (m ? m.label : x.when); }).join('; ') + '.' });
  }
  return { month: M, totals, groups, sources: bySrc, entries, notes, moved, count: entries.length };
}

/* ===================================================================== pantalla y ventana */
const SECS = {
  in: { title: 'Ingresos', sub: 'Lo que entró a tus cuentas.' },
  out: { title: 'Egresos', sub: 'Lo que salió de tus cuentas y lo que consumiste con las tarjetas.' },
  card: { title: 'Pagos de tarjeta', sub: 'No suman: los consumos de las tarjetas ya están en Egresos.' },
  xfer: { title: 'Entre tus cuentas', sub: 'No suman: es tu dinero pasando de una cuenta a otra.' },
  inv: { title: 'Pólizas e inversiones', sub: 'No suman: es dinero que va a una póliza o vuelve de ella.' },
};
let uid = 0;

function itemRow(e, sec, onOpen) {
  const signed = sec === 'xfer' || sec === 'inv' ? (e.dir === 'in' ? e.amount : -e.amount) : e.amount;
  const meta = [e.when, e.srcLabel].filter(Boolean).join(' · ') + (e.kind === 'fee' && e.concept ? ' · en «' + e.concept + '»' : '');
  const label = e.kind === 'fee' ? 'Comisión' : (e.concept || 'Sin concepto');
  const inner = [el('span', { class: 'rb-it-t' }, el('span', { class: 'rb-it-c', text: cap(label) }), el('span', { class: 'rb-it-m', text: meta })),
    el('span', { class: 'rb-it-a' + (signed < 0 ? ' neg' : ''), text: money(signed, { sign: sec === 'xfer' || sec === 'inv' }) })];
  if (typeof onOpen !== 'function') return el('li', { class: 'rb-it' }, ...inner);
  return el('li', { class: 'rb-it' }, el('button', { type: 'button', class: 'rb-it-btn', title: 'Ver la fila ' + (e.r + 1) + ' en la hoja', onclick: () => onOpen(e) }, ...inner));
}

function groupList(sec, list, onOpen) {
  const max = Math.max(...list.map((g) => Math.abs(g.total)), 0.01);
  const ul = el('ul', { class: 'rb-groups', role: 'list' });
  for (const g of list) {
    const pct = Math.max(1.5, Math.min(100, (Math.abs(g.total) / max) * 100));
    const meta = g.count + ' ' + plural(g.count, 'movimiento', 'movimientos') + ' · ' + g.sources.join(', ');
    const det = el('details', { class: 'rb-g' },
      el('summary', {},
        el('span', { class: 'rb-g-t' }, el('span', { class: 'rb-g-n', text: g.label }), el('span', { class: 'rb-g-m', text: meta })),
        el('span', { class: 'rb-g-a' + (g.total < 0 ? ' neg' : ''), text: money(g.total, { sign: sec === 'xfer' || sec === 'inv' }) }),
        sec === 'in' || sec === 'out' ? el('span', { class: 'rb-bar ' + sec, 'aria-hidden': 'true' }, el('i', { style: { width: pct.toFixed(1) + '%' } })) : null),
      el('ul', { class: 'rb-items', role: 'list' }, ...g.items.map((e) => itemRow(e, sec, onOpen))));
    ul.append(el('li', {}, det));
  }
  return ul;
}

/**
 * Dibuja el resumen.
 * @param {object} S  resultado de summarizeMonth
 * @param {{onOpen?:(entry)=>void}} opts  onOpen: al tocar un movimiento (abrir la hoja en esa fila)
 */
export function renderSummary(S, opts = {}) {
  const root = el('div', { class: 'rb' });
  const t = S.totals, M = S.month;
  if (!S.count) {
    root.append(el('p', { class: 'empty', text: 'No hay movimientos de ' + M.label + ' en tus bancos ni en tus tarjetas.' }));
    if (S.notes.length) root.append(notesBox(S.notes));
    return root;
  }
  const kpi = (cls, k, v, extra) => el('div', { class: 'rb-kpi ' + cls }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }), extra ? el('span', { class: 's', text: extra }) : null);
  root.append(el('div', { class: 'rb-kpis', role: 'group', 'aria-label': 'Totales de ' + M.label },
    kpi('in', 'Ingresos', money(t.in)),
    kpi('out', 'Egresos', money(t.out)),
    kpi(t.net < 0 ? 'net neg' : 'net', t.net < 0 ? 'Faltó' : 'Sobró', money(Math.abs(t.net)), 'ingresos − egresos')));

  for (const sec of ['in', 'out']) {
    const list = S.groups[sec];
    const h = 'rb-h-' + sec + '-' + (++uid);
    const box = el('section', { class: 'rb-sec rb-' + sec, 'aria-labelledby': h },
      el('div', { class: 'rb-sec-h' }, el('h3', { id: h, text: SECS[sec].title + ' por rubro' }), el('span', { class: 'rb-sec-t', text: money(sec === 'in' ? t.in : t.out) })),
      el('p', { class: 'small muted', text: SECS[sec].sub + ' Toca un rubro para ver sus movimientos.' }));
    box.append(list.length ? groupList(sec, list, opts.onOpen) : el('p', { class: 'small muted', text: 'Nada en ' + M.name + '.' }));
    root.append(box);
  }

  const skip = ['card', 'xfer', 'inv'].filter((sec) => S.groups[sec].length);
  if (skip.length) {
    const h = 'rb-h-skip-' + (++uid);
    const box = el('section', { class: 'rb-sec rb-skip', 'aria-labelledby': h },
      el('div', { class: 'rb-sec-h' }, el('h3', { id: h, text: 'No suman' })),
      el('p', { class: 'small muted', text: 'Movimientos que no son ingresos ni egresos de verdad; se muestran para que cuadren tus cuentas.' }));
    for (const sec of skip) {
      const tot = sec === 'card' ? money(t.card) : sec === 'xfer' ? 'salió ' + money(t.xferOut) + ' · entró ' + money(t.xferIn) : 'a pólizas ' + money(t.invOut) + ' · de pólizas ' + money(t.invIn);
      box.append(el('div', { class: 'rb-sub' }, el('div', { class: 'rb-sub-h' }, el('h4', { text: SECS[sec].title }), el('span', { class: 'small muted', text: tot })),
        el('p', { class: 'small muted', text: SECS[sec].sub }), groupList(sec, S.groups[sec], opts.onOpen)));
    }
    root.append(box);
  }

  const rows = S.sources.filter((s) => s.count);
  if (rows.length) {
    const table = el('table', { class: 't rb-src' }, el('caption', { class: 'rb-sr', text: 'Por cuenta y tarjeta' }),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Cuenta o tarjeta' }), el('th', { scope: 'col', class: 'r', text: 'Ingresos' }), el('th', { scope: 'col', class: 'r', text: 'Egresos' }), el('th', { scope: 'col', class: 'r', text: 'No suman' }))),
      el('tbody', {}, ...rows.map((s) => el('tr', {}, el('th', { scope: 'row', text: s.label }), el('td', { class: 'r', text: s.in ? money(s.in) : '—' }), el('td', { class: 'r', text: s.out ? money(s.out) : '—' }), el('td', { class: 'r', text: s.skip ? money(s.skip) : '—' })))));
    root.append(el('section', { class: 'rb-sec' }, el('div', { class: 'rb-sec-h' }, el('h3', { text: 'Por cuenta y tarjeta' })), el('div', { class: 'scrollx' }, table)));
  }
  if (S.notes.length) root.append(notesBox(S.notes));
  return root;
}
function notesBox(notes) {
  return el('section', { class: 'rb-sec rb-notes' }, el('div', { class: 'rb-sec-h' }, el('h3', { text: 'Para revisar' })),
    el('ul', { class: 'rb-note-list' }, ...notes.map((n) => el('li', { class: n.level === 'warn' ? 'warn' : '', 'data-id': n.id, text: n.text }))));
}

/** Filas para Excel: hoja «Resumen» y hoja «Detalle». */
export function summaryToRows(S) {
  const M = S.month, t = S.totals;
  const res = [['Ingresos y egresos de ' + M.label], ['Bancos y tarjetas de Flujo · generado el ' + new Date().toLocaleDateString('es-EC')], [],
    ['Tipo', 'Rubro', 'Monto', 'Movimientos', 'Cuentas o tarjetas']];
  for (const g of S.groups.in) res.push(['Ingreso', g.label, g.total, g.count, g.sources.join(', ')]);
  res.push(['', 'TOTAL INGRESOS', t.in], []);
  for (const g of S.groups.out) res.push(['Egreso', g.label, g.total, g.count, g.sources.join(', ')]);
  res.push(['', 'TOTAL EGRESOS', t.out], [], ['', t.net < 0 ? 'FALTÓ (ingresos − egresos)' : 'SOBRÓ (ingresos − egresos)', t.net], []);
  for (const g of S.groups.card) res.push(['No suma · pago de tarjeta', g.label, g.total, g.count, g.sources.join(', ')]);
  for (const g of S.groups.xfer) res.push(['No suma · entre tus cuentas', g.label, g.total, g.count, g.sources.join(', ')]);
  for (const g of S.groups.inv) res.push(['No suma · pólizas', g.label, g.total, g.count, g.sources.join(', ')]);
  if (S.notes.length) { res.push([], ['Para revisar']); for (const n of S.notes) res.push([n.text]); }
  const kindTxt = { in: 'Ingreso', out: 'Egreso', fee: 'Egreso (comisión)', card: 'No suma · pago de tarjeta', xfer: 'No suma · entre tus cuentas', inv: 'No suma · pólizas' };
  const det = [['Mes o fecha', 'Cuenta o tarjeta', 'Tipo', 'Rubro', 'Concepto', 'Monto', 'Fila de la hoja', 'Nota']];
  for (const sec of ['in', 'out', 'card', 'xfer', 'inv']) {
    for (const g of S.groups[sec]) {
      for (const e of g.items) {
        const signed = sec === 'xfer' || sec === 'inv' ? (e.dir === 'in' ? e.amount : -e.amount) : e.amount;
        det.push([e.when || '', e.srcLabel, kindTxt[e.kind] || e.kind, g.label, e.kind === 'fee' ? 'Comisión' + (e.concept ? ' (' + e.concept + ')' : '') : e.concept, signed, e.r + 1,
          e.flag === 'year' ? 'fecha con otro año' : e.flag === 'month' ? 'fecha de otro mes' : e.flag === 'own' ? 'anotada entre movimientos de otro mes' : e.flag === 'nodate' ? 'sin fecha' : '']);
      }
    }
  }
  return { resumen: res, detalle: det };
}

/** Descarga el resumen como .xlsx (SheetJS se carga solo la primera vez). */
export async function downloadSummary(S) {
  const X = await import('./export.js');
  const XLSX = await X.loadXlsxLib();
  const { resumen, detalle } = summaryToRows(S);
  const money2 = '#,##0.00';
  const ws1 = XLSX.utils.aoa_to_sheet(resumen), ws2 = XLSX.utils.aoa_to_sheet(detalle);
  const fmt = (ws, col, from) => { for (let r = from; ; r++) { const a = XLSX.utils.encode_cell({ r, c: col }); const range = XLSX.utils.decode_range(ws['!ref']); if (r > range.e.r) break; if (ws[a] && typeof ws[a].v === 'number') ws[a].z = money2; } };
  fmt(ws1, 2, 4); fmt(ws2, 5, 1);
  ws1['!cols'] = [{ wch: 26 }, { wch: 34 }, { wch: 14 }, { wch: 12 }, { wch: 40 }];
  ws2['!cols'] = [{ wch: 12 }, { wch: 26 }, { wch: 24 }, { wch: 28 }, { wch: 34 }, { wch: 13 }, { wch: 10 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen');
  XLSX.utils.book_append_sheet(wb, ws2, 'Detalle');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  X.downloadBlob(new Blob([bytes], { type: X.XLSX_MIME }), 'Flujo_ingresos_egresos_' + S.month.key + '.xlsx');
}

/** Carga las hojas que hacen falta (cediendo el hilo) y resume. */
async function compute(ctx, key) {
  const eng = ctx.engine;
  for (const sid of SHEETS_USED(eng)) { const sh = eng.sheet(sid); if (sh && !sh.loaded && eng.loadSheetAsync) await eng.loadSheetAsync(sid); }
  return summarizeMonth(eng, key);
}
const todayKey = (ctx) => monthOf(typeof ctx.today === 'function' ? ctx.today() : todaySerial()).key;

/** Pantalla #/rubros/AAAA-MM (sin mes: el mes de hoy). */
export function mount(host, ctx, arg, q) {
  const M = monthOf(arg) || monthOf(todayKey(ctx));
  const S = { dead: false, data: null };
  const prev = shiftMonth(M.key, -1), next = shiftMonth(M.key, 1), nowKey = todayKey(ctx);
  const go = (k, f) => ctx.navigate('rubros/' + k + (f ? '?f=' + f : ''));
  const title = el('h2', { class: 'rb-title', text: cap(M.label) });
  const dl = el('button', { type: 'button', class: 'btn', text: 'Descargar Excel', disabled: true, onclick: async () => {
    if (!S.data) return;
    dl.disabled = true;
    try { await downloadSummary(S.data); } catch (e) { console.error(e); if (ctx.toast) ctx.toast('No se pudo descargar: ' + ((e && e.message) || e), { type: 'error', ms: 7000 }); }
    finally { dl.disabled = false; }
  } });
  const head = el('div', { class: 'card rb-head' },
    el('div', { class: 'rb-nav' },
      el('button', { type: 'button', class: 'btn ghost rb-arrow', 'data-f': 'prev', 'aria-label': 'Mes anterior (' + prev.label + ')', title: prev.label, onclick: () => go(prev.key, 'prev'), html: '&lsaquo;' }),
      title,
      el('button', { type: 'button', class: 'btn ghost rb-arrow', 'data-f': 'next', 'aria-label': 'Mes siguiente (' + next.label + ')', title: next.label, disabled: next.idx > monthOf(nowKey).idx, onclick: () => go(next.key, 'next'), html: '&rsaquo;' })),
    el('p', { class: 'small muted', text: 'Lo que entró y salió en el mes en tus bancos y tarjetas, agrupado por rubro.' + (M.key === nowKey ? ' El mes está en curso: se actualiza con lo que anotes.' : '') }),
    el('div', { class: 'row' }, dl, M.key !== nowKey ? el('button', { type: 'button', class: 'btn ghost', text: 'Ir al mes de hoy', onclick: () => go(nowKey) }) : null));
  const body = el('div', { class: 'card rb-body' }, el('div', { class: 'empty' }, el('div', { class: 'spin' }), 'Revisando bancos y tarjetas…'));
  host.append(head, body);
  const f = q && typeof q.get === 'function' ? q.get('f') : null;      // se llegó con una flecha: el foco vuelve a ella (teclado y lector de pantalla)
  if (f) { const b = head.querySelector('[data-f="' + (f === 'next' ? 'next' : 'prev') + '"]'); if (b) setTimeout(() => { try { (b.disabled ? head.querySelector('[data-f="prev"]') : b).focus(); } catch (e) { /* nada */ } }, 0); }
  const onOpen = (e) => { if (ctx.openSheet) ctx.openSheet(e.sid, { r: e.r, c: e.c }); };
  async function refresh() {
    try {
      const data = await compute(ctx, M.key);
      if (S.dead) return;
      S.data = data; dl.disabled = !data.count;
      body.replaceChildren(renderSummary(data, { onOpen }));
    } catch (e) {
      console.error(e);
      if (!S.dead) body.replaceChildren(el('p', { class: 'db-err', role: 'alert', text: 'No se pudo armar el resumen: ' + ((e && e.message) || e) }));
    }
  }
  refresh();
  return { refresh, destroy() { S.dead = true; }, state: S };
}

/** Ventana con el resumen de un mes (la abre «Cerrar mes» al terminar). opts.lead = texto de arriba; opts.onClose = al cerrarla. */
export async function openSummaryDialog(ctx, key, opts = {}) {
  const M = monthOf(key);
  if (!M || typeof ctx.modal !== 'function') return null;
  const body = el('div', { class: 'rb-dlg' }, el('div', { class: 'empty' }, el('div', { class: 'spin' }), 'Revisando bancos y tarjetas…'));
  let data = null, dlg = null;
  const dl = el('button', { type: 'button', class: 'btn', text: 'Descargar Excel', disabled: true, onclick: async () => {
    if (!data) return; dl.disabled = true;
    try { await downloadSummary(data); } catch (e) { console.error(e); if (ctx.toast) ctx.toast('No se pudo descargar: ' + ((e && e.message) || e), { type: 'error', ms: 7000 }); }
    finally { dl.disabled = false; }
  } });
  const full = el('button', { type: 'button', class: 'btn ghost', text: 'Ver en pantalla completa', onclick: () => { if (dlg) dlg.close(); ctx.navigate('rubros/' + M.key); } });
  const ok = el('button', { type: 'button', class: 'btn primary', text: 'Listo', onclick: () => dlg && dlg.close() });
  const wrap = el('div', {}, opts.lead ? el('p', { class: 'rb-lead', text: opts.lead }) : null, body, el('div', { class: 'rb-dlg-actions' }, dl, full, ok));
  dlg = ctx.modal(wrap, { title: 'Ingresos y egresos de ' + M.label, wide: true, onClose: typeof opts.onClose === 'function' ? opts.onClose : null });
  try {
    data = await compute(ctx, M.key);
    body.replaceChildren(renderSummary(data, { onOpen: (e) => { if (dlg) dlg.close(); if (ctx.openSheet) ctx.openSheet(e.sid, { r: e.r, c: e.c }); } }));
    dl.disabled = !data.count;
  } catch (e) {
    console.error(e);
    body.replaceChildren(el('p', { class: 'db-err', role: 'alert', text: 'No se pudo armar el resumen: ' + ((e && e.message) || e) }));
  }
  return dlg;
}
