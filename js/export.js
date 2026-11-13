/* export.js — exportación de FlujoWeb: libro de Excel (.xlsx real) y copia de seguridad JSON.
 *
 * .xlsx: usa SheetJS Community 0.18.5 (vendor/xlsx.full.min.js, global `XLSX`, Apache-2.0). Se puede cargar con un
 * <script> normal o dejar que `loadXlsxLib()` / `exportWorkbookXlsxAsync()` / `downloadXlsx()` lo carguen bajo demanda
 * desde ../vendor/ (relativo a este módulo, así que funciona bajo un subdirectorio como /flujo-app/).
 *
 * Qué se escribe por hoja del motor:
 *   - valor calculado (v) + fórmula (f, sin "=", sintaxis inglesa/coma del motor, con el prefijo _xlfn. en las
 *     funciones modernas) + formato numérico (z = st.nf de engine.styleOf). Las fechas son números de serie.
 *   - los textos marcados en sheet.textCells ("0012345678", "12/05/2020"...) se escriben como TEXTO, sin fórmula.
 *   - anchos de columna (!cols, atributo width de Excel), columnas y filas ocultas, celdas combinadas (!merges), notas (comentarios),
 *     hojas ocultas (Workbook.Sheets[i].Hidden) y nombres definidos válidos (Workbook.Names).
 *   NO se escriben (la edición Community no los soporta): colores, negritas, bordes, paneles inmovilizados, color de pestaña.
 *
 * Nombre de hoja: Excel limita a 31 caracteres, prohíbe  : \ / ? * [ ]  y apóstrofos en los extremos, y algunas
 * versiones rechazan o recortan espacios al final ("Mi hoja "). Por defecto (trimSheetNames=true) el NOMBRE DE LA
 * PESTAÑA del archivo se recorta y se reescriben las referencias 'Mi hoja '!A1 -> 'Mi hoja'!A1 en las fórmulas
 * y en los nombres definidos; el motor/los datos de la app no se tocan. Con trimSheetNames=false se usa el nombre exacto.
 *
 * Exportar solo algunas hojas: las fórmulas que apuntan a una hoja que NO va en el archivo se escriben como valor
 * (sin fórmula) para que Excel no las marque como corruptas; el recuento queda en opts.report.frozenFormulas.
 *
 * Con el motor actual: las hojas diferidas (lazy) sin cargar se cargan al exportarlas (engine.ensureLoaded, que vacía el
 * historial de deshacer), y los SUMIF con rangos de distinto tamaño que el motor reescribió al cargar vuelven a su texto
 * original de Excel (opts.useOriginalFormulas). La copia JSON no necesita cargar nada: las hojas sin abrir se copian tal cual.
 */
import { colLetter, fixFormulaForHF } from './engine.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const JSON_MIME = 'application/json';
export const BACKUP_FORMAT = 'flujoweb-backup';
export const BACKUP_VERSION = 1;

/* ====================================================================================== nombres de archivo y descarga */
const pad2 = (n) => String(n).padStart(2, '0');

/** "2026-11-13" (fecha local, no UTC: de noche en Ecuador UTC ya es el día siguiente). */
export function dateStamp(d = new Date()) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
/** "Flujo_2026-11-13.xlsx" */
export function xlsxFileName(d = new Date()) { return 'Flujo_' + dateStamp(d) + '.xlsx'; }
/** "Flujo_respaldo_2026-11-13.json" */
export function jsonBackupFileName(d = new Date()) { return 'Flujo_respaldo_' + dateStamp(d) + '.json'; }
/** Nombre sugerido para descargar: suggestedName('xlsx') -> "Flujo_2026-11-13.xlsx"; suggestedName('json') -> "Flujo_respaldo_2026-11-13.json". */
export function suggestedName(ext = 'xlsx', d = new Date()) {
  const e = String(ext).replace(/^\./, '').toLowerCase();
  return e === 'json' ? jsonBackupFileName(d) : 'Flujo_' + dateStamp(d) + '.' + e;
}

/** Descarga un Blob como archivo (a[download]) y libera la URL temporal. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Se revoca con un pequeño retraso: Safari y Firefox necesitan que la descarga arranque antes de soltar la URL.
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

/* ====================================================================================== SheetJS bajo demanda */
let xlsxLoading = null;

/** Devuelve el global XLSX, cargando vendor/xlsx.full.min.js si todavía no está (src opcional para otra ruta). */
export function loadXlsxLib(src) {
  if (globalThis.XLSX && globalThis.XLSX.utils) return Promise.resolve(globalThis.XLSX);
  if (xlsxLoading) return xlsxLoading;
  const url = src || new URL('../vendor/xlsx.full.min.js', import.meta.url).href;
  xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => (globalThis.XLSX && globalThis.XLSX.utils ? resolve(globalThis.XLSX) : reject(new Error('La biblioteca de Excel se cargó pero no se inicializó.')));
    s.onerror = () => { xlsxLoading = null; s.remove(); reject(new Error('No se pudo cargar la biblioteca de Excel (vendor/xlsx.full.min.js).')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

/* ====================================================================================== nombres de hoja */
const SHEET_MAX = 31;
const SHEET_BAD_CHARS = /[\\/?*[\]:]/g;

/** Nombre de pestaña válido para Excel a partir del nombre del motor (ver cabecera del archivo). */
export function excelSheetName(raw, { trim = true } = {}) {
  let n = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(SHEET_BAD_CHARS, '-');
  if (trim) n = n.trim();
  n = n.replace(/^'+/, '').replace(/'+$/, '');                     // sin apóstrofo al inicio ni al final
  if (n.length > SHEET_MAX) {
    n = n.slice(0, SHEET_MAX);
    if (/[\uD800-\uDBFF]$/.test(n)) n = n.slice(0, -1);            // no partir un par sustituto (emoji)
  }
  if (trim) n = n.trim();
  n = n.replace(/'+$/, '');
  if (!n.trim()) n = 'Hoja';
  if (n.toLowerCase() === 'history') n += ' (hoja)';                // nombre reservado por Excel
  return n;
}

/** Map id -> nombre único (sin distinguir mayúsculas) y válido para Excel. */
function assignSheetNames(sheets, trim) {
  const used = new Set();
  const byId = new Map();
  for (const sh of sheets) {
    const base = excelSheetName(sh.name, { trim });
    let cand = base, k = 1;
    while (used.has(cand.toLowerCase())) { k++; const suf = ' (' + k + ')'; cand = base.slice(0, SHEET_MAX - suf.length) + suf; }
    used.add(cand.toLowerCase());
    byId.set(sh.id, cand);
  }
  return byId;
}

/* ====================================================================================== fórmulas */
// Funciones posteriores a Excel 2007 que el formato .xlsx guarda con prefijo _xlfn. (sin él Excel muestra #¿NOMBRE?).
// Lista parcial: las que HyperFormula también implementa y que no usa el libro actual.
const XLFN_FUNCTIONS = new Set(('ACOT ACOTH ARABIC BASE BITAND BITLSHIFT BITOR BITRSHIFT BITXOR CEILING.MATH CEILING.PRECISE CONCAT ' +
  'COMBINA COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL FLOOR.MATH FLOOR.PRECISE FORMULATEXT GAMMA GAUSS IFNA IFS ' +
  'ISFORMULA ISOWEEKNUM MAXIFS MINIFS NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION PERMUTATIONA PERCENTILE.EXC ' +
  'PERCENTILE.INC PHI QUARTILE.EXC QUARTILE.INC RANK.AVG RANK.EQ RRI SEC SECH SHEET SHEETS STDEV.P STDEV.S SWITCH TEXTJOIN ' +
  'UNICHAR UNICODE VAR.P VAR.S XLOOKUP XMATCH XOR').split(' '));
const ERROR_LITERAL = /^#(?:REF!|DIV\/0!|N\/A|NAME\?|NULL!|NUM!|VALUE!|SPILL!|CALC!|GETTING_DATA)/i;
const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0xC0;
const isIdPart = (c) => isIdStart(c) || (c >= 48 && c <= 57) || c === 46;
const quoteSheet = (name) => "'" + name.replace(/'/g, "''") + "'";

/**
 * Adapta una fórmula del motor (sin "=") al archivo .xlsx. No toca textos entre comillas ni errores literales (#REF!).
 *  - reescribe los prefijos de hoja renombrados ('Mi hoja '!A1 -> 'Mi hoja'!A1)
 *  - añade _xlfn. a las funciones modernas
 *  - marca dead=true si la fórmula apunta a una hoja que no va en el archivo o a un nombre definido no exportado
 * @param {string} src
 * @param {{known?:Set<string>, rename?:Map<string,string>, skippedNames?:Set<string>}} [ctx] known/rename con nombres en minúsculas
 * @returns {{f:string, dead:boolean, changed:boolean}}
 */
export function formulaForExcel(src, ctx = {}) {
  const known = ctx.known || null, rename = ctx.rename || null, skipped = ctx.skippedNames || null;
  if (src.charCodeAt(0) === 61) src = src.slice(1);
  const n = src.length;
  let out = '', i = 0, dead = false, changed = false;

  const sheetPrefix = (name, raw) => {
    const key = name.toLowerCase();
    if (known && !known.has(key)) { dead = true; return raw; }
    const nn = rename ? rename.get(key) : undefined;
    if (nn !== undefined) { changed = true; return quoteSheet(nn); }
    return raw;
  };

  while (i < n) {
    const ch = src.charCodeAt(i);
    if (ch === 34) {                                              // "texto"
      let j = i + 1;
      while (j < n) { if (src.charCodeAt(j) === 34) { if (src.charCodeAt(j + 1) === 34) j += 2; else break; } else j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === 39) {                                              // 'Nombre de hoja'!
      let j = i + 1, name = '';
      while (j < n) {
        const cj = src.charCodeAt(j);
        if (cj === 39) { if (src.charCodeAt(j + 1) === 39) { name += "'"; j += 2; continue; } break; }
        name += src[j]; j++;
      }
      if (src.charCodeAt(j + 1) === 33) { out += sheetPrefix(name, src.slice(i, j + 1)) + '!'; i = j + 2; continue; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === 35) {                                              // #REF! y demás errores literales
      const m = ERROR_LITERAL.exec(src.slice(i, i + 13));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (isIdStart(ch)) {                                          // Hoja!A1 | FUNCION( | nombre | A1
      let j = i + 1;
      while (j < n && isIdPart(src.charCodeAt(j))) j++;
      const id = src.slice(i, j), nx = src.charCodeAt(j);
      if (nx === 33) { out += sheetPrefix(id, id) + '!'; i = j + 1; continue; }
      if (nx === 40 && XLFN_FUNCTIONS.has(id.toUpperCase())) { out += '_xlfn.' + id; changed = true; }
      else {
        if (nx !== 40 && skipped && skipped.size && skipped.has(id.toUpperCase())) dead = true;
        out += id;
      }
      i = j; continue;
    }
    out += src[i]; i++;
  }
  return { f: changed ? out : src, dead, changed };
}

/* SUMIF con rangos de distinto tamaño: HyperFormula los rechaza, así que el motor los reescribe al cargar cada hoja
 * (engine.js, fixFormulaForHF) y guarda el texto ORIGINAL de Excel en engine._sumifFixed ({sh,r,c,f} o [sh,r,c,f]).
 * Al exportar se devuelve ese texto original (Excel sí entiende esos SUMIF y la versión recortada podría dar otro
 * resultado al recalcular), salvo que la celda se haya editado después. Si el motor no expone _sumifFixed simplemente
 * se exporta la fórmula del motor. */
const squash = (s) => s.replace(/\s+/g, '').toUpperCase();

/** Map "r|c" -> fórmula original (sin "=") de las celdas de la hoja que el motor reescribió. */
function originalFormulas(engine, sheet) {
  const map = new Map();
  const list = engine && engine._sumifFixed;
  if (Array.isArray(list)) {
    for (const e of list) {
      const sh = Array.isArray(e) ? e[0] : e && e.sh, r = Array.isArray(e) ? e[1] : e && e.r, c = Array.isArray(e) ? e[2] : e && e.c, f = Array.isArray(e) ? e[3] : e && e.f;
      if (sh === sheet && typeof f === 'string') map.set(r + '|' + c, f);
    }
  }
  return map;
}

function restoreOriginal(orig, cur) {
  const c = squash(cur);
  return c === squash(fixFormulaForHF(orig)) || c === squash(fixFormulaForHF(orig, 'truncate')) ? orig : cur;
}

/* ====================================================================================== valores */
const ERR_CODES = { '#NULL!': 0x00, '#DIV/0!': 0x07, '#VALUE!': 0x0F, '#REF!': 0x17, '#NAME?': 0x1D, '#NUM!': 0x24, '#N/A': 0x2A };

/** Error del motor -> celda de error de SheetJS (los errores propios de HyperFormula se acercan al más parecido de Excel). */
function errorCell(code) {
  const e = ERR_CODES[code] !== undefined ? code : (code === '#ERROR!' ? '#NAME?' : '#VALUE!');
  return { t: 'e', v: ERR_CODES[e], w: e };
}

/** Valor del motor (number | string | boolean | null | {error}) -> celda SheetJS sin formato; null si no hay valor. */
function valueToCell(v) {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'number': return Number.isFinite(v) ? { t: 'n', v } : errorCell('#NUM!');
    case 'boolean': return { t: 'b', v };
    case 'string': return { t: 's', v: v.length > 32767 ? v.slice(0, 32767) : v };   // tope de Excel por celda; SheetJS lanza error si se pasa
    default: return v.error ? errorCell(v.error) : { t: 's', v: String(v) };
  }
}

/* ====================================================================================== nombres definidos */
const NAME_OK = /^[A-Za-z_\\\u00C0-\uFFFF][A-Za-z0-9_.\\?\u00C0-\uFFFF]*$/;
const NAME_LOOKS_LIKE_REF = /^(?:[A-Za-z]{1,3}\d+|[Rr](?:\d+)?[Cc](?:\d+)?|[RrCc])$/;

function listDefinedNames(engine) {
  try {
    const hf = engine.hf;
    const out = [];
    for (const name of hf.listNamedExpressions()) {
      const f = hf.getNamedExpressionFormula(name);
      if (typeof f === 'string') out.push([name, f.replace(/^=/, '')]);
    }
    return out;
  } catch (e) { /* si HyperFormula no lo permite, se usa el meta original */ }
  return Object.entries((engine.meta && engine.meta.names) || {});
}

/** [{Name, Ref}] exportables; los no exportables se anotan en ctx.skippedNames (las fórmulas que los usan quedan como valor). */
function buildDefinedNames(engine, ctx, skippedList) {
  const out = [];
  for (const [name, text] of listDefinedNames(engine)) {
    const ok = NAME_OK.test(name) && !NAME_LOOKS_LIKE_REF.test(name) && typeof text === 'string' && text && !/#REF!/i.test(text);
    let ref = null;
    if (ok) { const r = formulaForExcel(text, ctx); if (!r.dead) ref = r.f; }
    if (ref === null) { ctx.skippedNames.add(name.toUpperCase()); skippedList.push(name); continue; }
    out.push({ Name: name, Ref: ref });
  }
  return out;
}

/* ====================================================================================== una hoja */
function buildSheet(engine, sh, ctx, origF) {
  const sid = sh.id;
  const data = engine.exportSheet(sid);
  const ws = {};
  const letters = [];
  const col = (c) => letters[c] || (letters[c] = colLetter(c));
  let maxR = -1, maxC = -1, nCells = 0, nFormulas = 0, nFrozen = 0, nRestored = 0;
  const bump = (r, c) => { if (r > maxR) maxR = r; if (c > maxC) maxC = c; };

  for (const cell of data.cells) {
    const r = cell[0], c = cell[1];
    let fSrc = cell.length > 3 ? cell[3] : null;
    let xc;
    if (fSrc !== null && fSrc !== undefined && fSrc !== '') {
      if (origF) { const o = origF.get(r + '|' + c); if (o !== undefined) { const f2 = restoreOriginal(o, fSrc); if (f2 !== fSrc) { fSrc = f2; nRestored++; } } }
      const tr = formulaForExcel(fSrc, ctx);
      xc = valueToCell(engine.value(sid, r, c));
      if (tr.dead) {                                              // apunta a una hoja/nombre que no va en el archivo
        nFrozen++;
        if (!xc) continue;
      } else {
        if (!xc) xc = { t: 'n' };                                 // sin valor en caché: Excel lo calcula al abrir
        xc.f = tr.f; nFormulas++;
      }
    } else {
      const v = cell[2];
      if (v === null || v === undefined || v === '') continue;    // las cadenas vacías no aportan nada
      xc = valueToCell(v);
      if (!xc) continue;
    }
    const nf = engine.styleOf(sid, r, c).nf;
    if (nf && nf !== 'General') xc.z = nf;
    ws[col(c) + (r + 1)] = xc;
    nCells++; bump(r, c);
  }

  // notas -> comentarios (en celdas sin contenido se crea una celda de texto vacía para colgar la nota)
  for (const [key, text] of sh.notes) {
    const r = Math.floor(key / 4096), c = key % 4096;
    const ref = col(c) + (r + 1);
    let xc = ws[ref];
    if (!xc) { xc = { t: 's', v: '' }; ws[ref] = xc; nCells++; bump(r, c); }
    xc.c = [{ a: 'Flujo', t: String(text) }];
    xc.c.hidden = true;
  }

  // celdas combinadas (se descartan las de una sola celda, que Excel considera corruptas)
  const merges = [];
  for (const m of sh.merges) {
    if (m.r0 === m.r1 && m.c0 === m.c1) continue;
    merges.push({ s: { r: m.r0, c: m.c0 }, e: { r: m.r1, c: m.c1 } });
    bump(m.r1, m.c1);
  }
  if (merges.length) ws['!merges'] = merges;

  // anchos y columnas ocultas. colWidths guarda píxeles = width*7+5 (tools/convert.py); SheetJS con wpx asume otra fuente
  // (MDW=6) y dejaría las columnas ~20 % más anchas en Excel, así que se escribe directamente el atributo width de Excel.
  const cols = [];
  for (const [c, w] of sh.colWidths) if (c >= 0 && c < 16384 && w > 5) cols[c] = { width: Math.round(((w - 5) / 7) * 256) / 256 };
  for (const c of sh.hiddenCols) if (c >= 0 && c < 16384) (cols[c] || (cols[c] = {})).hidden = true;
  if (cols.length) ws['!cols'] = cols;

  // filas ocultas
  const rows = [];
  for (const r of sh.hiddenRows) if (r >= 0 && r < 1048576) rows[r] = { hidden: true };
  if (rows.length) ws['!rows'] = rows;

  if (maxR >= 0) ws['!ref'] = 'A1:' + col(maxC) + (maxR + 1);
  return { ws, nCells, nFormulas, nFrozen, nRestored };
}

/* ====================================================================================== libro completo */
function pickSheets(engine, sheetIds, includeHidden) {
  let list;
  if (sheetIds && sheetIds.length) {
    const seen = new Set();
    list = [];
    for (const key of sheetIds) {
      const sh = engine.sheet(key);
      if (!sh) throw new Error('Hoja desconocida: ' + key);
      if (!seen.has(sh.id)) { seen.add(sh.id); list.push(sh); }
    }
    const order = new Map(engine.sheets.map((s, i) => [s.id, i]));
    list.sort((a, b) => order.get(a.id) - order.get(b.id));       // se respeta el orden del libro
  } else list = engine.sheets.slice();
  if (!includeHidden) list = list.filter((s) => !s.hidden);
  if (!list.length) throw new Error('No hay hojas que exportar.');
  return list;
}

function* buildXlsxSteps(engine, opts) {
  const XLSX = globalThis.XLSX;
  if (!XLSX || !XLSX.utils || !XLSX.write) {
    throw new Error('Falta la biblioteca de Excel: carga vendor/xlsx.full.min.js o usa exportWorkbookXlsxAsync()/downloadXlsx().');
  }
  const t0 = performance.now();
  const { sheetIds, includeHidden = true, trimSheetNames = true, useOriginalFormulas = true, report } = opts;
  const sheets = pickSheets(engine, sheetIds, includeHidden);
  const nameById = assignSheetNames(sheets, trimSheetNames);

  const known = new Set(), rename = new Map(), renamed = [];
  for (const sh of sheets) {
    const key = sh.name.toLowerCase();
    known.add(key);
    const nn = nameById.get(sh.id);
    if (nn !== sh.name) { rename.set(key, nn); renamed.push([sh.name, nn]); }
  }
  const ctx = { known, rename, skippedNames: new Set() };
  const skippedNames = [];
  const names = buildDefinedNames(engine, ctx, skippedNames);

  const wb = XLSX.utils.book_new();
  const stats = [];
  let frozen = 0, restored = 0;
  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    yield { done: i, total: sheets.length, sheet: sh.name };           // antes de procesar la hoja: la interfaz puede mostrar "Hoja X…"
    // El motor carga de forma diferida las hojas que ninguna otra necesita; sin cargarlas no hay valores que exportar.
    // (Cargar una hoja vacía el historial de deshacer del motor.)
    if (sh.loaded === false && typeof engine.ensureLoaded === 'function') engine.ensureLoaded(sh.id);
    const b = buildSheet(engine, sh, ctx, useOriginalFormulas ? originalFormulas(engine, sh) : null);
    XLSX.utils.book_append_sheet(wb, b.ws, nameById.get(sh.id));
    frozen += b.nFrozen; restored += b.nRestored;
    stats.push({ id: sh.id, name: sh.name, exportedName: nameById.get(sh.id), hidden: !!sh.hidden, cells: b.nCells, formulas: b.nFormulas, frozen: b.nFrozen });
  }
  yield { done: sheets.length, total: sheets.length, sheet: null };    // todas listas: falta escribir el archivo

  // Excel exige al menos una hoja visible
  const firstVisible = sheets.findIndex((s) => !s.hidden);
  wb.Workbook = { Sheets: sheets.map((s, i) => ({ Hidden: s.hidden && (firstVisible >= 0 || i > 0) ? 1 : 0 })) };
  if (names.length) wb.Workbook.Names = names;
  wb.Props = { Title: 'Flujo — mis finanzas', Author: 'FlujoWeb', CreatedDate: new Date() };

  let bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
  if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) bytes = Uint8Array.from(bytes);
  const blob = new Blob([bytes], { type: XLSX_MIME });

  if (report && typeof report === 'object') {
    Object.assign(report, {
      sheets: stats, renamed, names: names.map((n) => n.Name), skippedNames,
      cells: stats.reduce((a, s) => a + s.cells, 0), formulas: stats.reduce((a, s) => a + s.formulas, 0),
      frozenFormulas: frozen, restoredFormulas: restored, bytes: blob.size, ms: Math.round(performance.now() - t0),
    });
  }
  return blob;
}

/**
 * Exporta el motor a un libro de Excel real. SÍNCRONA: requiere el global XLSX ya cargado (vendor/xlsx.full.min.js).
 * @param {object} engine  instancia de Engine
 * @param {{sheetIds?:string[], includeHidden?:boolean, trimSheetNames?:boolean, onProgress?:Function, report?:object}} [opts]
 *   sheetIds: ids ("s01") o nombres de las hojas a exportar (por defecto todas, en el orden del libro)
 *   includeHidden (true): incluir las hojas ocultas (siguen ocultas en el archivo)
 *   trimSheetNames (true): recorta espacios en el nombre de la pestaña y reescribe las referencias (ver cabecera)
 *   useOriginalFormulas (true): devuelve el texto original de Excel en los SUMIF que el motor reescribió al cargar
 *   onProgress({done,total,sheet}): se llama antes de procesar cada hoja y una vez más (sheet:null) antes de escribir el archivo
 *   report: objeto que se rellena con el resumen (hojas, renombres, fórmulas congeladas/restauradas, tamaño, ms...)
 * Las hojas diferidas del motor sin cargar se cargan aquí (engine.ensureLoaded), lo que vacía su historial de deshacer.
 * @returns {Blob} .xlsx
 */
export function exportWorkbookXlsx(engine, opts = {}) {
  const it = buildXlsxSteps(engine, opts);
  for (let r = it.next(); ; r = it.next()) {
    if (r.done) return r.value;
    if (opts.onProgress) opts.onProgress(r.value);
  }
}

/** Igual que exportWorkbookXlsx pero carga SheetJS si hace falta y cede el hilo entre hojas (la interfaz no se congela). */
export async function exportWorkbookXlsxAsync(engine, opts = {}) {
  await loadXlsxLib();
  const it = buildXlsxSteps(engine, opts);
  for (let r = it.next(); ; r = it.next()) {
    if (r.done) return r.value;
    if (opts.onProgress) opts.onProgress(r.value);
    await new Promise((res) => setTimeout(res, 0));
  }
}

/** Exporta y descarga "Flujo_YYYY-MM-DD.xlsx" (opts.filename para otro nombre). Devuelve {blob, filename}. */
export async function downloadXlsx(engine, opts = {}) {
  const blob = await exportWorkbookXlsxAsync(engine, opts);
  const filename = opts.filename || xlsxFileName();
  downloadBlob(blob, filename);
  return { blob, filename };
}

/* ====================================================================================== copia de seguridad JSON */
/**
 * Copia completa para restaurar con `new Engine(meta, sheetDatas)`:
 * {formato:'flujoweb-backup', version:1, fecha, meta, sheetDatas}. meta.sheets refleja el estado actual de las hojas.
 * @returns {Blob} application/json
 */
export function exportJsonBackup(engine) {
  const sheetDatas = {};
  for (const sh of engine.sheets) sheetDatas[sh.id] = engine.exportSheet(sh.id);
  const orig = new Map(((engine.meta && engine.meta.sheets) || []).map((m) => [m.id, m]));
  const meta = {
    ...engine.meta,
    styles: engine.styles,
    sheets: engine.sheets.map((sh) => ({
      ...(orig.get(sh.id) || { file: 'sheets/' + sh.id + '.json' }),
      id: sh.id, name: sh.name, hidden: !!sh.hidden, tabColor: sh.tabColor || null,
      rows: sheetDatas[sh.id].rows, cols: sheetDatas[sh.id].cols,
    })),
  };
  const payload = { formato: BACKUP_FORMAT, version: BACKUP_VERSION, fecha: new Date().toISOString(), meta, sheetDatas };
  return new Blob([JSON.stringify(payload)], { type: JSON_MIME });
}

/** Descarga la copia de seguridad JSON. */
export function downloadJsonBackup(engine, filename = jsonBackupFileName()) {
  const blob = exportJsonBackup(engine);
  downloadBlob(blob, filename);
  return { blob, filename };
}

/** Valida una copia de seguridad (texto JSON u objeto) y devuelve {meta, sheetDatas, fecha}; lanza Error en español si no sirve. */
export function parseJsonBackup(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch (e) { throw new Error('El archivo no es un JSON válido.'); }
  }
  // también se aceptan los respaldos de store.exportAll() ({format, exportedAt}), que usan las mismas claves meta/sheetDatas
  if (!obj || (obj.formato !== BACKUP_FORMAT && obj.format !== BACKUP_FORMAT)) throw new Error('El archivo no es una copia de seguridad de Flujo.');
  if (!(obj.version >= 1) || obj.version > BACKUP_VERSION) throw new Error('La copia de seguridad es de una versión más nueva (' + obj.version + '): actualiza la app.');
  const { meta, sheetDatas } = obj;
  if (!meta || !Array.isArray(meta.sheets) || !Array.isArray(meta.styles) || !sheetDatas || typeof sheetDatas !== 'object') {
    throw new Error('La copia de seguridad está incompleta o dañada.');
  }
  for (const sm of meta.sheets) {
    const d = sheetDatas[sm.id];
    if (!d || !Array.isArray(d.cells)) throw new Error('Falta la hoja "' + sm.name + '" en la copia de seguridad.');
  }
  return { meta, sheetDatas, fecha: obj.fecha || obj.exportedAt || null };
}
