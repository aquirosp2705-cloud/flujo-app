/* invest.js — tarjeta «Inversiones» del Resumen: total invertido y total por banco.
 *
 * Este archivo NO contiene datos de la persona: los bancos, los montos y los rótulos se leen de las celdas.
 * Lo único que se conoce es la POSICIÓN de unos pocos rótulos de la hoja de pólizas (s05):
 *   - una póliza es una fila con constantes en monto (C), tasa (H), fecha de inicio (I) y días (K): la misma regla del
 *     formulario «Renovar póliza» (quick.js · listPolicies), para que la tarjeta y el formulario vean las mismas pólizas
 *   - el rótulo «por banco» (columna A) separa el bloque «RESUMEN POLIZAS» (arriba) del detalle por banco (abajo):
 *     las pólizas de arriba son el «total invertido»; lo que tiene valores propios debajo (ahorros a plazo) se muestra aparte
 *   - el rótulo «total invertido» (columna B) trae la cifra de la hoja, que se usa de control contra la suma de las pólizas
 *   - CONSOL (s01) L24 «inversiones» (lo que cuenta el patrimonio), L26 «inversiones out» y L27 «total polizas» explican
 *     por qué el patrimonio muestra menos que el total invertido
 *
 * Patrimonio (v30, pedido de la usuaria): patrimonio = bancos menos provisiones + TODAS las inversiones (el «total invertido»).
 *   migratePatrimonio cambia una sola vez CONSOL L24 («total pólizas − inversiones out») por el total invertido, y L27 («total
 *   pólizas» = L24 + L26) por el total de la hoja de pólizas, para que la celda de control de esa hoja siga en cero.
 *
 * API:  readInvestments(engine, {today}) -> datos · renderInvest(host, engine, opts) -> datos (o null si no hay pólizas)
 *       migratePatrimonio(engine) -> celdas cambiadas o null
 *       duePolicies(engine, {today, days}) -> pólizas que vencen en 5 días o menos · showDueAlert(ctx, lista, opts) -> aviso al abrir la app
 */
import { listPolicies } from './quick.js';
import { el, money, dateText } from './ui.js';
import { todaySerial } from './format.js';

export const SID = 's05';              // hoja de pólizas
const CONSOL = 's01';
const EPS = 0.005;
const SCAN_LAST = 130;                 // se buscan los rótulos hasta esta fila (base 0)
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round2 = (x) => Math.round(x * 100) / 100;
const plural = (n, one, many) => (n === 1 ? one : many);

const val = (eng, sid, r, c) => { try { const v = eng.value(sid, r, c); return v === undefined ? null : v; } catch (e) { return null; } };
const num = (eng, sid, r, c) => { const v = val(eng, sid, r, c); return isNum(v) ? v : null; };
const txt = (eng, sid, r, c) => { const v = val(eng, sid, r, c); return typeof v === 'string' ? v.trim() : ''; };
function findRow(eng, sid, col, re, from = 0, to = SCAN_LAST) {
  for (let r = from; r <= to; r++) if (re.test(txt(eng, sid, r, col))) return r;
  return -1;
}

/** «en 21 días» · «hoy» · «mañana» · «hace 3 días» */
export function whenText(daysLeft) {
  if (!isNum(daysLeft)) return '';
  if (daysLeft < 0) return 'hace ' + (-daysLeft) + ' ' + plural(-daysLeft, 'día', 'días');
  if (daysLeft === 0) return 'hoy';
  if (daysLeft === 1) return 'mañana';
  return 'en ' + daysLeft + ' días';
}
/** «Vence 07/12/2026 (en 21 días)» · «Venció 05/11/2026 (hace 11 días)» */
export function dueLine(due, daysLeft) {
  return (isNum(daysLeft) && daysLeft < 0 ? 'Venció ' : 'Vence ') + dateText(due) + ' (' + whenText(daysLeft) + ')';
}

/**
 * Lee las inversiones.
 * @returns {{ok:boolean, total:number|null, sum:number, sheetTotal:number|null, mismatch:number|null, count:number,
 *   banks:Array<{name:string, amount:number, share:number|null, count:number, next:{due:number,daysLeft:number,level:string}|null}>,
 *   savings:{amount:number,count:number,banks:string[]}|null, next:{due:number,daysLeft:number,bank:string}|null,
 *   patrimonio:null|{inversiones:number,fuera:number,total:number,labels:{inv:string,out:string,tot:string},diff:number}}}
 */
export function readInvestments(eng, opts = {}) {
  const today = isNum(opts.today) ? opts.today : todaySerial();
  const out = { ok: false, total: null, sum: 0, sheetTotal: null, mismatch: null, count: 0, banks: [], savings: null, next: null, patrimonio: null };
  let sheet = null;
  try { sheet = eng && typeof eng.sheet === 'function' ? eng.sheet(SID) : null; } catch (e) { sheet = null; }
  if (!sheet) return out;
  let all;
  try { all = listPolicies(eng, { today }); } catch (e) { return out; }
  const split = findRow(eng, SID, 0, /^por\s+banco$/i, 30);                       // A81: debajo empieza el detalle por banco
  const main = all.filter((p) => split < 0 || p.row < split);
  const extra = all.filter((p) => split >= 0 && p.row >= split);
  if (!main.length) return out;

  const byBank = new Map();
  for (const p of main) {
    const name = String(p.bank || '').trim() || 'Sin banco', k = name.toLowerCase().replace(/\s+/g, ' ');
    let b = byBank.get(k);
    if (!b) { b = { name, amount: 0, count: 0, next: null }; byBank.set(k, b); }
    b.amount += p.amount; b.count++;
    if (!b.next || p.due < b.next.due) b.next = { due: p.due, daysLeft: p.daysLeft, level: p.level };
  }
  const sum = round2(main.reduce((a, p) => a + p.amount, 0));
  out.banks = [...byBank.values()].map((b) => ({ ...b, amount: round2(b.amount), share: sum > EPS ? b.amount / sum : null })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'es'));
  out.sum = sum; out.count = main.length; out.ok = true;
  const first = main.reduce((a, p) => (!a || p.due < a.due ? p : a), null);
  out.next = first ? { due: first.due, daysLeft: first.daysLeft, bank: String(first.bank || '').trim() } : null;

  const rowTot = findRow(eng, SID, 1, /^total\s+invertido$/i);
  out.sheetTotal = rowTot >= 0 ? num(eng, SID, rowTot, 2) : null;
  out.total = isNum(out.sheetTotal) ? out.sheetTotal : sum;
  out.mismatch = isNum(out.sheetTotal) && Math.abs(out.sheetTotal - sum) > EPS ? round2(sum - out.sheetTotal) : null;

  if (extra.length) {
    const names = [];
    for (const p of extra) { const n = String(p.bank || '').trim(); if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n); }
    out.savings = { amount: round2(extra.reduce((a, p) => a + p.amount, 0)), count: extra.length, banks: names };
  }

  // por qué el patrimonio de CONSOL cuenta menos que el total invertido: L24 inversiones · L26 inversiones out · L27 total pólizas
  const inv = num(eng, CONSOL, 23, 11), fuera = num(eng, CONSOL, 25, 11), tot = num(eng, CONSOL, 26, 11);
  if (isNum(inv) && isNum(fuera) && isNum(tot)) {
    out.patrimonio = {
      inversiones: inv, fuera, total: tot,
      labels: { inv: txt(eng, CONSOL, 23, 10) || 'inversiones', out: txt(eng, CONSOL, 25, 10) || 'inversiones out', tot: txt(eng, CONSOL, 26, 10) || 'total pólizas' },
      diff: round2(tot - (sum + (out.savings ? out.savings.amount : 0))),
      full: Math.abs(inv - sum) < EPS,                       // el patrimonio cuenta todas las inversiones (v30)
    };
  }
  return out;
}

/* ================================================================== patrimonio con todas las inversiones (v30) */
/**
 * Una sola vez: CONSOL L24 («inversiones» del patrimonio) deja de ser «total pólizas − inversiones out» y pasa a ser el «total
 * invertido» de la hoja de pólizas; L27 («total pólizas», que era L24 + L26) pasa a leer el total de la hoja de pólizas, así su
 * celda de control sigue en cero. Solo actúa si L24 todavía tiene la fórmula vieja (se reconoce por su forma, no por el valor).
 * Los meses ya cerrados no cambian (son valores). @returns {{cells:string[], before:number|null, after:number|null}|null}
 */
export function migratePatrimonio(eng) {
  let sh = null;
  try { sh = eng && typeof eng.sheet === 'function' ? eng.sheet(SID) : null; } catch (e) { sh = null; }
  if (!sh || !eng.sheet(CONSOL)) return null;
  const name = String(sh.name);
  const esc = name.replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "''");
  const ref = "'?" + esc + "'?!\\$?";
  const OLD24 = new RegExp('^=\\+?' + ref + 'C\\$?(\\d+)-' + ref + 'D\\$?(\\d+)$', 'i');
  const OLD27 = /^=\+?\$?L\$?24\+\$?L\$?26$/i;
  const raw24 = eng.raw(CONSOL, 23, 11), raw27 = eng.raw(CONSOL, 26, 11);
  const m = typeof raw24 === 'string' ? OLD24.exec(raw24.replace(/\s+/g, '')) : null;
  if (!m) return null;
  const rowTot = findRow(eng, SID, 1, /^total\s+invertido$/i);
  if (rowTot < 0 || num(eng, SID, rowTot, 2) === null) return null;
  const q = "'" + name.replace(/'/g, "''") + "'!";
  const before = num(eng, CONSOL, 23, 11);
  const cells = ['L24'];
  eng.set(CONSOL, 23, 11, '=+' + q + 'C' + (rowTot + 1));
  if (typeof raw27 === 'string' && OLD27.test(raw27.replace(/\s+/g, ''))) { eng.set(CONSOL, 26, 11, '=+' + q + 'C' + m[1]); cells.push('L27'); }
  return { cells, before, after: num(eng, CONSOL, 23, 11) };
}

/* ================================================================== aviso al abrir la app: pólizas por vencer */
export const ALERT_DAYS = 5;          // se avisa cuando faltan 5 días o menos (y si ya venció)

/** Pólizas que vencen dentro de `days` días o que ya vencieron, de la más próxima a la más lejana. [] si no hay hoja de pólizas. */
export function duePolicies(eng, { today, days = ALERT_DAYS } = {}) {
  const t = isNum(today) ? today : todaySerial();
  try {
    if (!eng || typeof eng.sheet !== 'function' || !eng.sheet(SID)) return [];
    return listPolicies(eng, { today: t }).filter((p) => p.daysLeft <= days);
  } catch (e) { console.warn('[pólizas]', e); return []; }
}

/**
 * Ventana «Pólizas por vencer». opts.onRenew = abrir «Renovar póliza»; opts.days = días del aviso.
 * @returns {object|null} el modal (o null si no hay nada que avisar)
 */
export function showDueAlert(ctx, list, opts = {}) {
  if (!list || !list.length || !ctx || typeof ctx.modal !== 'function') return null;
  const days = isNum(opts.days) ? opts.days : ALERT_DAYS;
  const n = list.length, late = list.filter((p) => p.daysLeft < 0).length, soon = n - late;
  const lead = late === n ? (n === 1 ? 'Esta póliza ya venció:' : 'Estas ' + n + ' pólizas ya vencieron:')
    : late ? late + ' ' + plural(late, 'póliza ya venció', 'pólizas ya vencieron') + ' y ' + soon + ' ' + plural(soon, 'vence', 'vencen') + ' en ' + days + ' días o menos:'
      : (n === 1 ? 'Esta póliza vence en ' + days + ' días o menos:' : 'Estas ' + n + ' pólizas vencen en ' + days + ' días o menos:');
  const title = late === n ? (n === 1 ? 'Póliza vencida' : 'Pólizas vencidas') : late ? 'Pólizas vencidas y por vencer' : (n === 1 ? 'Póliza por vencer' : 'Pólizas por vencer');
  const uid = 'pa' + Date.now().toString(36);
  const total = round2(list.reduce((a, p) => a + p.amount, 0));
  const ul = el('ul', { class: 'pa-list', role: 'list', id: uid + '-l' }, ...list.map((p) => el('li', { class: 'pa-item ' + (p.daysLeft < 0 ? 'late' : p.daysLeft <= 1 ? 'now' : 'soon') },
    el('span', { class: 'pa-t' }, el('b', { text: [p.bank, p.dest].map((x) => String(x || '').trim()).filter(Boolean).join(' · ') || 'Póliza de la fila ' + p.rowNumber }),
      el('span', { class: 'pa-m', text: dueLine(p.due, p.daysLeft) })),
    el('span', { class: 'pa-a', text: money(p.amount) }))));
  let dlg = null;
  const close = () => { if (dlg) dlg.close(); };
  const okBtn = el('button', { class: 'btn', type: 'button', text: 'Entendido', autofocus: true, onclick: close });
  const renew = typeof opts.onRenew === 'function' ? el('button', { class: 'btn primary', type: 'button', text: 'Renovar póliza', onclick: () => { close(); opts.onRenew(); } }) : null;
  const body = el('div', { class: 'pa' },
    el('p', { class: 'pa-lead', id: uid + '-p', text: lead }), ul,
    n > 1 ? el('p', { class: 'pa-total small', text: 'Total: ' + money(total) }) : null,
    el('p', { class: 'small muted', text: 'Te lo recordaré cada vez que abras Flujo mientras falten ' + days + ' días o menos. Cuando la renueves, actualízala en «Renovar póliza» y el aviso se va solo.' }),
    el('div', { class: 'row end pa-actions' }, okBtn, renew));
  dlg = ctx.modal(body, { title, sheet: false });
  try { dlg.el.setAttribute('role', 'alertdialog'); dlg.el.setAttribute('aria-describedby', uid + '-p ' + uid + '-l'); dlg.el.classList.add('pa-dlg'); } catch (e) { /* nada */ }
  return dlg;
}

/** Dibuja la tarjeta en `host` (un <section class="card db-invest">). Devuelve los datos leídos, o null si no hay pólizas (host queda oculto). */
export function renderInvest(host, eng, opts = {}) {
  host.replaceChildren();
  let d = null;
  try { d = readInvestments(eng, { today: opts.today }); } catch (e) { console.warn('[invest]', e); d = null; }
  if (!d || !d.ok) { host.hidden = true; return null; }
  host.hidden = false;
  const title = opts.title || 'Pólizas';

  host.append(el('div', { class: 'db-card-head' }, el('h2', { id: 'db-inv-h', text: 'Inversiones' }),
    el('span', { class: 'db-inv-total', 'aria-label': 'Total invertido ' + money(d.total), text: money(d.total) })));
  const sub = d.count + ' ' + plural(d.count, 'póliza', 'pólizas') + ' en ' + d.banks.length + ' ' + plural(d.banks.length, 'banco', 'bancos') +
    (d.next ? ' · próximo vencimiento: ' + dateText(d.next.due) + ' (' + whenText(d.next.daysLeft) + ')' : '');
  host.append(el('p', { class: 'db-inv-sub small muted', text: sub }));

  const ul = el('ul', { class: 'db-inv-grid', 'aria-label': 'Inversiones por banco' });
  for (const b of d.banks) {
    const pct = b.share === null ? null : Math.round(b.share * 100);
    ul.append(el('li', { class: 'db-inv-bank' },
      el('span', { class: 'db-inv-name', text: b.name }),
      el('span', { class: 'db-inv-amt', text: money(b.amount) }),
      pct === null ? null : el('span', { class: 'db-share', role: 'img', 'aria-label': pct + '% del total invertido' }, el('i', { style: { width: Math.max(2, b.share * 100).toFixed(1) + '%' } })),
      el('span', { class: 'db-bank-note', text: (pct === null ? '' : pct + '% del total · ') + b.count + ' ' + plural(b.count, 'póliza', 'pólizas') }),
      b.next ? el('span', { class: 'db-bank-note db-inv-due ' + (b.next.level === 'late' ? 'late' : b.next.level === 'due' ? 'due' : ''), text: dueLine(b.next.due, b.next.daysLeft) }) : null));
  }
  host.append(ul);

  if (d.mismatch !== null) {
    host.append(el('p', { class: 'db-inv-warn small', role: 'status', text: 'Ojo: las pólizas por banco suman ' + money(d.sum) + ', pero la hoja dice «total invertido» ' + money(d.sheetTotal) + ' (diferencia ' + money(d.mismatch, { sign: true }) + '). Revisa la hoja.' }));
  }
  if (d.savings && d.savings.amount > EPS) {
    host.append(el('p', { class: 'db-inv-note small muted', text: 'Además hay ' + money(d.savings.amount) + ' en ahorros a plazo' + (d.savings.banks.length ? ' (' + d.savings.banks.join(', ') + ')' : '') + ' que no entran en el total invertido; con ellos son ' + money(d.total + d.savings.amount) + '.' }));
  }

  const p = d.patrimonio;
  if (p && p.full) {
    host.append(el('p', { class: 'db-inv-note small muted', text: 'El patrimonio cuenta todas tus inversiones (' + money(p.inversiones) + ')' +
      (d.savings && d.savings.amount > EPS ? '; los ' + money(d.savings.amount) + ' de ahorros a plazo no entran.' : '.') }));
    if (Math.abs(p.diff) > EPS) host.append(el('p', { class: 'db-inv-warn small', role: 'status', text: 'Ojo: el total pólizas de CONSOL no coincide con la hoja de pólizas (diferencia ' + money(p.diff, { sign: true }) + ').' }));
  } else if (p) {
    const rows = [['Total invertido (pólizas por banco)', d.total, '']];
    if (d.savings && d.savings.amount > EPS) rows.push(['Ahorros a plazo', d.savings.amount, '+']);
    rows.push(['Total pólizas (CONSOL «' + p.labels.tot + '»)', p.total, '=']);
    rows.push(['Fuera del patrimonio (CONSOL «' + p.labels.out + '»)', -p.fuera, '−']);
    rows.push(['Lo que cuenta el patrimonio (CONSOL «' + p.labels.inv + '»)', p.inversiones, '=']);
    const table = el('table', { class: 't db-inv-table' }, el('caption', { class: 'db-sr', text: 'De las pólizas a las inversiones del patrimonio' }),
      el('tbody', {}, ...rows.map(([t, v, op], i) => el('tr', { class: i === rows.length - 1 || op === '=' ? 'tot' : '' }, el('th', { scope: 'row', text: (op && op !== '=' ? op + ' ' : '') + t }), el('td', { class: 'r', text: money(v) })))));
    const det = el('details', { class: 'db-inv-details' }, el('summary', { text: '¿Por qué el patrimonio cuenta ' + money(p.inversiones) + ' de inversiones?' }),
      el('p', { class: 'small muted', text: 'El patrimonio de la hoja CONSOL no incluye ' + money(p.fuera) + ' de las pólizas (los guarda aparte como «' + p.labels.out + '»). Por eso cuenta menos que el total invertido.' }),
      el('div', { class: 'db-inv-scroll' }, table));
    if (Math.abs(p.diff) > EPS) det.append(el('p', { class: 'db-inv-warn small', role: 'status', text: 'Ojo: el total pólizas de CONSOL no coincide con la hoja de pólizas (diferencia ' + money(p.diff, { sign: true }) + ').' }));
    host.append(det);
  }

  if (typeof opts.openSheet === 'function') {
    host.append(el('div', { class: 'row end' }, el('button', { class: 'btn ghost', type: 'button', onclick: () => opts.openSheet(SID), text: 'Ver hoja ' + title })));
  }
  return d;
}
