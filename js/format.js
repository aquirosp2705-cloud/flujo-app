/* format.js — formato de valores (SSF) y estilos de celda -> CSS.
 * Requiere vendor/ssf.js cargado antes (global `SSF`, ya con meses/días en español).
 */
import { toEnglish } from './formula-es.js';

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

/* ---------------------------------------------------------------- v39: lo que se teclea, como en el Excel en español de la usuaria
 * (cada regla se comprobó tecleando en Excel real; test/input-test.html dice qué casos y dónde la app se aparta a propósito). */
const MONTH3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTH_ALIAS = { set: 'sep', mzo: 'mar', myo: 'may' };                          // v39: «set» (septiembre) y, como los anota ella, «mzo» (marzo) y «myo» (mayo)
// v39: mes en letras, abreviado o completo, con o sin punto y en mayúsculas o minúsculas: «nov», «Nov.», «noviembre», «sept», «set»
const MONTH_TXT = '(ene(?:ro)?|feb(?:rero)?|mar(?:zo)?|mzo|abr(?:il)?|may(?:o)?|myo|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:t|tiembre)?|set(?:iembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?)\\.?';
const DATE_SEP = '\\s*(?:[-\\/]\\s*)?';                                               // v39: entre las partes, guion, barra, espacio o nada: «15-nov», «15/nov», «15 nov», «15nov»
const RE_DAY_MONTH = new RegExp('^(\\d{1,2})' + DATE_SEP + MONTH_TXT + '(?:' + DATE_SEP + '(\\d{2}|\\d{4}))?$', 'i');   // v39: «15-nov», «15 nov 2026», «15nov26»
const RE_MONTH_YEAR = new RegExp('^' + MONTH_TXT + DATE_SEP + '(\\d{2}|\\d{4})$', 'i');                                  // v39: «nov-26», «nov2026», «Nov.26», «noviembre 2026»
// v39: negativo entre paréntesis, con el «$» fuera o dentro y el «%» dentro o fuera: «(300)», «($300.00)», «$(300.00)», «(1,234.50)», «(10%)», «(300)%»
const RE_PAREN = /^(\$?)\s*\(\s*(\$?)\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+|\d+,\d+)\s*(%?)\s*\)\s*(%?)$/;
const monthOf = (name) => { const k = name.slice(0, 3).toLowerCase(); return MONTH3.indexOf(MONTH_ALIAS[k] || k) + 1; };
/** v39: año tecleado. Con 2 dígitos, como Excel: 00–29 → 2000–2029 y 30–99 → 1930–1999; con 4, tal cual. */
const typedYear = (txt) => (txt.length > 2 ? +txt : (+txt <= 29 ? 2000 + +txt : 1900 + +txt));
/** v39: año en curso (o el de opts.today, un número de serie, para que las pruebas no dependan del reloj). */
const yearNow = (opts) => (opts && Number.isFinite(opts.today) ? serialToDate(opts.today).getUTCFullYear() : new Date().getFullYear());
/**
 * v39: número de serie de Excel del día `d` del mes `mo` (1–12) del año `y`; null si ese día no existe («31/11», «29/2» de un año no
 * bisiesto: Excel los deja como texto) o si el año queda fuera de 1900–`maxY`.
 */
function dateSerial(y, mo, d, maxY = 9999) {
  if (!(y >= 1900 && y <= maxY && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const ms = Date.UTC(y, mo - 1, d);
  if (new Date(ms).getUTCDate() !== d) return null;
  const n = Math.round((ms - Date.UTC(1899, 11, 30)) / 86400000);
  return n < 61 ? n - 1 : n;                                                          // Excel cuenta un 29-feb-1900 que no existió: antes de marzo de 1900 su número es uno menos
}

/**
 * Convierte lo que el usuario teclea en contenido crudo para el motor.
 * "=..." fórmula | "'texto" texto literal | 123 / 1,5 / 12% / (300) / 13/11/2026 / 15-nov / nov-26 / TRUE -> tipos nativos | resto texto.
 * @param {object} [st]   estilo de la celda (st.nf = formato de número)
 * @param {object} [opts] v39: today = número de serie de «hoy» (pruebas); dateCell = true trata la celda como de fecha aunque todavía
 *                        no tenga formato (para «15/11» en una fila nueva de una columna de fechas)
 * @returns {{raw:*, nf?:string}} nf = formato sugerido si la celda no tenía (p. ej. fechas)
 */
export function parseInput(text, st, opts) {
  if (text === null || text === undefined) return { raw: null };
  let s = String(text);
  if (s === '') return { raw: null };
  if (s[0] === '=') return { raw: toEnglish(s) };         // «=SUMAR.SI(A:A;"x";B:B)» se guarda como «=SUMIF(A:A,"x",B:B)»
  if (s[0] === "'") return { raw: s.slice(1) };
  const t = s.trim();
  if (/^(true|verdadero)$/i.test(t)) return { raw: true };
  if (/^(false|falso)$/i.test(t)) return { raw: false };
  let m;
  // v39: negativos entre paréntesis, como en Excel: «(300)», «($300.00)», «$(300.00)», «$ (300)», «(1,234.50)», «(10%)». Antes quedaban como texto y el saldo de la hoja pasaba a #VALUE!
  if ((m = RE_PAREN.exec(t)) && !(m[1] && m[2]) && !(m[4] && m[5])) {
    const cur = m[1] || m[2], pct = m[4] || m[5];
    const comma = /^\d+,\d+$/.test(m[3]) && !/^\d{1,3}(?:,\d{3})+$/.test(m[3]);       // «(1,5)» = -1.5, igual que «1,5» = 1.5 (sin «$», como allí)
    if (!(cur && (pct || comma))) {
      let n = parseFloat(comma ? m[3].replace(',', '.') : m[3].replace(/,/g, ''));
      if (pct) n /= 100;
      return { raw: n === 0 ? 0 : -n };
    }
  }
  if ((m = /^([-+]?)\s*\$?\s*([-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d+(?:\.\d*)?|[-+]?\.\d+)\s*(%?)$/.exec(t))) {
    let n = parseFloat(m[2].replace(/,/g, '')); if (m[1] === '-') n = -n;             // v39: con dos signos («+-5», «--5») salía NaN y el saldo pasaba a #NUM!; ahora valen -5 y 5, como la fórmula que hace Excel
    if (m[3]) n /= 100;
    return { raw: n };
  }
  if ((m = /^([-+]?\d+),(\d+)\s*(%?)$/.exec(t))) { let n = parseFloat(m[1] + '.' + m[2]); if (m[3]) n /= 100; return { raw: n }; }   // 1,5 -> 1.5
  const dateNf = !!(st && st.nf && isDateFormat(st.nf));                           // v39: la celda ya tiene formato de fecha (se respeta: no se sugiere otro)
  if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/.exec(t))) {           // dd/mm/aaaa
    const serial = dateSerial(typedYear(m[3]), +m[2], +m[1]);                       // v39: año de 2 dígitos como Excel (30–99 = 1930–1999); un día que no existe («31/11/2026») ya no se corre al mes siguiente: queda como texto
    if (serial !== null) return { raw: serial, nf: dateNf ? undefined : 'dd/mm/yyyy' };
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) {
    const serial = dateSerial(+m[1], +m[2], +m[3]);                                 // v39: «2026-02-30» no existe: queda como texto (antes se guardaba como 2 de marzo)
    if (serial !== null) return { raw: serial, nf: dateNf ? undefined : 'dd/mm/yyyy' };
  }
  // v39: fechas con el mes en letras, siempre (como Excel): «15-nov», «15 nov», «15-nov-26», «15 nov 2026»; sin año = el año en curso.
  // El año de 4 dígitos solo vale entre 1900 y 2099: «nov1826» y «nov2126» (así anota ella el 18 y el 21 de noviembre de 2026) siguen siendo texto.
  if ((m = RE_DAY_MONTH.exec(t))) {
    const serial = dateSerial(m[3] ? typedYear(m[3]) : yearNow(opts), monthOf(m[2]), +m[1], 2099);
    if (serial !== null) return { raw: serial, nf: dateNf ? undefined : (m[3] ? 'd-mmm-yy' : 'd-mmm') };
  }
  if ((m = RE_MONTH_YEAR.exec(t))) {                                                // v39: mes y año («nov-26», «nov26», «nov2026», «noviembre 2026», «Nov.26») = día 1 de ese mes
    const serial = dateSerial(typedYear(m[2]), monthOf(m[1]), 1, 2099);
    if (serial !== null) return { raw: serial, nf: dateNf ? undefined : 'mmm-yy' };
  }
  // v39: día y mes solo con números («15/11», «15-11») = fecha del año en curso SOLO en una celda que ya tiene formato de fecha;
  // en las demás siguen siendo texto: las cuotas «9-12» o «3/12» de las columnas de notas no deben volverse fechas.
  if ((dateNf || (opts && opts.dateCell)) && (m = /^(\d{1,2})\s*[\/\-]\s*(\d{1,2})$/.exec(t))) {
    const serial = dateSerial(yearNow(opts), +m[2], +m[1]);
    if (serial !== null) return { raw: serial, nf: dateNf ? undefined : 'd-mmm' };
  }
  // como en Excel, un «+» o «-» al principio que no es un número empieza una fórmula: «+H2050+E2051», «-A1», «+SUM(A1:A3)», «+5*2»
  if (/^[+-]\s*(?:\(|\$?[A-Za-z]{1,3}\$?\d|[A-Za-z][A-Za-z0-9.]*\(|\d)/.test(t) && !/\d\s+\d/.test(t)) return { raw: toEnglish('=' + t) };
  return { raw: s };
}

/** Número de serie de Excel <-> Date (UTC, solo parte de fecha) */
export const serialToDate = (n) => new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
export const dateToSerial = (d) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
export const todaySerial = () => dateToSerial(new Date());
