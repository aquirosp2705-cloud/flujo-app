/* ui.js — utilidades de interfaz compartidas: toasts, modales, confirmación, formatos. Sin dependencias. */
import { serialToDate } from './format.js';

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) { if (kid === null || kid === undefined || kid === false) continue; n.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return n;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- formatos ---------- */
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export function money(n, { sign = false, dec = 2 } = {}) {
  if (n === null || n === undefined || n === '' || Number.isNaN(+n)) return '—';
  const v = +n; const a = Math.abs(v);
  const s = '$' + a.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return v < 0 ? '−' + s : (sign && v > 0 ? '+' + s : s);
}
export function dateText(serial) {
  if (serial === null || serial === undefined || typeof serial !== 'number') return '';
  const d = serialToDate(serial);
  return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
}
export function monthText(serial) {
  if (typeof serial !== 'number') return '';
  const d = serialToDate(serial);
  return MONTHS[d.getUTCMonth()] + '-' + String(d.getUTCFullYear()).slice(2);
}
export function dateInputValue(serial) {            // para <input type=date>
  if (typeof serial !== 'number') return '';
  const d = serialToDate(serial);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
export function serialFromInput(v) {                 // 'YYYY-MM-DD' -> serial
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); if (!m) return null;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
}

/* ---------- toasts ---------- */
export function toast(msg, { type = 'info', ms = 3200 } = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = el('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(host); }
  const t = el('div', { class: 'toast ' + type, role: 'status' }, msg);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
}

/* ---------- modal / hoja inferior ---------- */
export function openModal(content, { title = '', onClose = null, wide = false, sheet = true } = {}) {
  const back = el('div', { class: 'modal-back' });
  const box = el('div', { class: 'modal' + (wide ? ' wide' : '') + (sheet ? ' sheet' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Diálogo' });
  const head = el('div', { class: 'modal-head' }, el('h2', { text: title }), el('button', { class: 'icon-btn', 'aria-label': 'Cerrar', html: '&times;', onclick: () => close() }));
  const body = el('div', { class: 'modal-body' });
  if (content) body.append(content.nodeType ? content : document.createTextNode(content));
  box.append(head, body); back.append(box); document.body.append(back);
  document.body.classList.add('modal-open');
  const prev = document.activeElement;
  let closed = false;
  function close(result) {
    if (closed) return; closed = true;
    back.classList.remove('in'); document.removeEventListener('keydown', onKey, true);
    setTimeout(() => { back.remove(); if (!document.querySelector('.modal-back')) document.body.classList.remove('modal-open'); }, 200);
    try { prev && prev.focus && prev.focus(); } catch (e) { /* nada */ }
    if (onClose) onClose(result);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  requestAnimationFrame(() => { back.classList.add('in'); const f = box.querySelector('[autofocus],input,select,textarea,button.primary'); if (f) f.focus(); });
  return { close, el: box, body };
}

export function confirmDialog(message, { ok = 'Aceptar', cancel = 'Cancelar', danger = false, title = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    const done = (v) => { if (decided) return; decided = true; m.close(); resolve(v); };
    const body = el('div', { class: 'confirm' }, el('p', { text: message }),
      el('div', { class: 'row end' }, el('button', { class: 'btn', text: cancel, onclick: () => done(false) }), el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), text: ok, onclick: () => done(true), autofocus: true })));
    const m = openModal(body, { title, onClose: () => { if (!decided) { decided = true; resolve(false); } }, sheet: false });
  });
}

/** Ejecuta fn con un aviso de "trabajando…" bloqueante (para tareas largas) */
export async function busy(message, fn) {
  const note = el('div', { class: 'busy' }, el('div', { class: 'spin' }), el('p', { text: message }));
  const m = openModal(note, { title: '', sheet: false });
  m.el.querySelector('.modal-head').style.display = 'none';
  try { return await fn((txt) => { note.querySelector('p').textContent = txt; }); } finally { m.close(); }
}

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
/** Espera un cuadro de animación, pero no se queda colgado si la pestaña está en segundo plano. */
export const nextFrame = () => new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 60); });
