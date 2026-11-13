/* format.js — formato de valores (SSF) y estilos de celda -> CSS.
 * Requiere vendor/ssf.js cargado antes (global `SSF`, ya con meses/días en español).
 */

const cssCache = new Map();

/** CSS inline (sin alineación por tipo) para un objeto de estilo de meta.styles[]. */
export function styleCss(st) {
  if (!st) return '';
  let key = st.__css;
  if (key !== undefined) return key;
  let s = '';
  if (st.b) s += 'font-weight:700;';
  if (st.i) s += 'font-style:italic;';
  if (st.u || st.s) s += 'text-decoration:' + [st.u ? 'underline' : '', st.s ? 'line-through' : ''].filter(Boolean).join(' ') + ';';
  if (st.fc) s += 'color:' + st.fc + ';';
  if (st.bg) s += 'background:' + st.bg + ';';
  if (st.sz) s += 'font-size:' + Math.round(st.sz * 1.2) / 1.2 + 'px;';
  if (st.h) s += 'text-align:' + ({ left: 'left', right: 'right', center: 'center', centerContinuous: 'center', justify: 'justify', fill: 'left' }[st.h] || 'left') + ';';
  if (st.v) s += 'vertical-align:' + (st.v === 'center' ? 'middle' : st.v) + ';';
  if (st.w) s += 'white-space:normal;word-break:break-word;';
  if (st.ind) s += 'padding-left:' + (st.ind * 8) + 'px;';
  if (st.bd) {
    for (const ch of st.bd) s += 'border-' + { t: 'top', b: 'bottom', l: 'left', r: 'right' }[ch] + ':1px solid #777;';
  }
  Object.defineProperty(st, '__css', { value: s, enumerable: false });   // no se serializa
  return s;
}

const DATE_NF = /(?<![\\_*"\[])[dmyhs](?![^\[]*\])/i;

export function isDateFormat(nf) {
  if (!nf || nf === 'General') return false;
  const t = nf.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(t) && !/^[#0?.,%$\s\-()_*"E+]*$/i.test(t);
}

/**
 * @param {*} value  número | texto | booleano | null | {error}
 * @param {object} st estilo (puede ser {}).
 * @returns {{t:string, k:'num'|'txt'|'err'|'bool'|'empty', color?:string}}
 */
export function fmtCell(value, st) {
  if (value === null || value === undefined || value === '') return { t: '', k: 'empty' };
  if (typeof value === 'object' && value.error) return { t: value.error, k: 'err' };
  if (typeof value === 'boolean') return { t: value ? 'VERDADERO' : 'FALSO', k: 'bool' };
  if (typeof value === 'string') return { t: value, k: 'txt' };
  const nf = st && st.nf;
  if (!nf || nf === 'General') return { t: general(value), k: 'num' };
  let t;
  try { t = SSF.format(nf, value); } catch (e) { t = general(value); }
  if (typeof t !== 'string') t = String(t);
  // los formatos contables usan "* " para rellenar: queda un espacio doble que no aporta nada
  t = t.replace(/\s{2,}/g, ' ').trim();
  const out = { t, k: 'num' };
  if (value < 0 && /\[Red\]/i.test(nf)) out.color = '#c00000';
  return out;
}

export function general(n) {
  if (Number.isInteger(n)) return String(n);
  const a = Math.abs(n);
  if (a >= 1e11 || (a < 1e-9 && a > 0)) return n.toExponential(5).replace('e+', 'E+').replace('e-', 'E-');
  let s = n.toPrecision(11);
  if (s.indexOf('e') >= 0) return String(+s);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Texto para la barra de fórmulas cuando la celda tiene un valor numérico/fecha (lo que Excel muestra al editar). */
export function editText(value, st) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    const nf = st && st.nf;
    if (nf && isDateFormat(nf)) {
      try {
        const hasTime = /h|s/i.test(nf.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''));
        return SSF.format(hasTime ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy', value);
      } catch (e) { /* cae al número */ }
    }
    if (nf && /%/.test(nf) && !/"[^"]*%[^"]*"/.test(nf)) return general(value * 100) + '%';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * Convierte lo que el usuario teclea en contenido crudo para el motor.
 * "=..." fórmula | "'texto" texto literal | 123 / 1,5 / 12% / 13/11/2026 / TRUE -> tipos nativos | resto texto.
 * @returns {{raw:*, nf?:string}} nf = formato sugerido si la celda no tenía (p. ej. fechas)
 */
export function parseInput(text, st) {
  if (text === null || text === undefined) return { raw: null };
  let s = String(text);
  if (s === '') return { raw: null };
  if (s[0] === '=') return { raw: s };
  if (s[0] === "'") return { raw: s.slice(1) };
  const t = s.trim();
  if (/^(true|verdadero)$/i.test(t)) return { raw: true };
  if (/^(false|falso)$/i.test(t)) return { raw: false };
  let m;
  if ((m = /^([-+]?)\s*\$?\s*([-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d+(?:\.\d+)?|[-+]?\.\d+)\s*(%?)$/.exec(t))) {
    let n = parseFloat((m[1] + m[2]).replace(/,/g, ''));
    if (m[3]) n /= 100;
    return { raw: n };
  }
  if ((m = /^([-+]?\d+),(\d+)\s*(%?)$/.exec(t))) { let n = parseFloat(m[1] + '.' + m[2]); if (m[3]) n /= 100; return { raw: n }; }   // 1,5 -> 1.5
  if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/.exec(t))) {           // dd/mm/aaaa
    let d = +m[1], mo = +m[2], y = +m[3]; if (y < 100) y += 2000;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const serial = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
      return { raw: serial, nf: (st && st.nf && isDateFormat(st.nf)) ? undefined : 'dd/mm/yyyy' };
    }
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) {
    const serial = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
    return { raw: serial, nf: (st && st.nf && isDateFormat(st.nf)) ? undefined : 'dd/mm/yyyy' };
  }
  return { raw: s };
}

/** Número de serie de Excel <-> Date (UTC, solo parte de fecha) */
export const serialToDate = (n) => new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
export const dateToSerial = (d) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
export const todaySerial = () => dateToSerial(new Date());
