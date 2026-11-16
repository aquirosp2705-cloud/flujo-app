/* archive.js — ARCHIVO MENSUAL de Flujo: una copia «congelada» de TODAS las hojas por mes, consultable desde cualquier dispositivo.
 *
 * Qué es un archivo: lo que la persona veía en cada hoja en ese momento, pero SIN fórmulas (cada fórmula se reemplaza por su valor;
 * los errores quedan como texto '#DIV/0!', y funciones como HOY() quedan fijas). Va en un solo JSON
 *   {formato:'flujoweb-archivo', version:1, mes:'AAAA-MM', etiqueta:'noviembre 2026', creado:ISO, origen:'cierre'|'manual',
 *    resumen:{disponible, patrimonio}|null, hojas:[{id,name,hidden,tabColor,rows,cols}], estilos:[…], catalogo:{…}, datos:{sNN:{…}}}
 * comprimido con gzip (CompressionStream; si el navegador no lo tiene se guarda sin comprimir y al leer se detecta por los bytes 1f 8b).
 * Cada hoja de `datos` tiene el mismo formato que engine.exportSheet() (filas, columnas, anchos, combinadas, notas, formatos…), con
 * las celdas como [fila, columna, valor] y un campo extra `fin` (última fila tecleada, para «Ir al final»).
 *
 * Dónde se guarda
 *   - En este dispositivo: IndexedDB, almacén 'kv' ya existente, claves «_arch:AAAA-MM» (los bytes) y «_arch:index» (el índice
 *     {clave: {etiqueta, creado, bytes, origen, subido, comprimido, sha, resumen, …}}). Todo lo que empieza con «_» queda fuera de los
 *     respaldos (Store.exportAll) y de la restauración (Store.replaceAll).
 *   - En GitHub (repositorio PRIVADO): archivo/AAAA-MM.json.gz (o .json). Lo suben GithubSync.archivePut y lo bajan archiveGet/archiveList.
 *     Si no hay GitHub o no hay red: se guarda aquí, queda «pendiente de subir» y se sube sola después (app.js llama a uploadPending()).
 *   - El archivo NO incluye el token, ni el usuario/repositorio, ni la configuración de sincronización: solo hojas, estilos y catálogo.
 *
 * API para otros módulos (app.js la deja en ctx.archive; es null si este módulo no cargó):
 *   snapshot({key, label, source, replace, upload, onProgress, signal}) → Promise<{ok, key, label, bytes, uploaded, pending, replaced, warning?, error?, code?}>
 *       NUNCA lanza. ok:true = ya hay una copia verificada y confirmada en IndexedDB (aunque no haya subido todavía: uploaded:false + warning).
 *       ok:false = no se creó nada (code: NO_ENGINE, NO_STORE, BAD_KEY, EXISTS, QUOTA, VERIFY, ERROR…; error en español): el cierre de mes debe abortar.
 *       Si la clave ya existe y no se pasa replace:true devuelve {ok:false, code:'EXISTS'} sin escribir (antes: has(key) / info(key) para preguntar).
 *       key por omisión: source 'cierre' → keyForClose() (mes de CONSOL L21, ¡léelo ANTES de escribir en CONSOL!); 'manual' → keyForToday().
 *       Tras guardar intenta subir a GitHub con plazo (25 s); upload:false lo omite (queda pendiente y se sube solo).
 *   has(key) → Promise<boolean> · info(key) → Promise<elemento|null> · list({remote, force}) → Promise<[{key, label, createdAt, bytes, where:'github'|'local'|'ambos',
 *       source, resumen?, pending, conflict, uploadError, …}]> (más reciente primero) · listDetailed() → {items, remote:{configured, tried, ok, offline, error}}
 *   open(key) → Promise<{meta, sheetDatas, info}> (listo para new Engine(meta, sheetDatas), p. ej. con createViewerEngine); rechaza con ArchiveError
 *   uploadPending() · resolveConflict(key, 'local'|'remote') · pendingCount() · unsyncedCount() · count() · keyForToday() · keyForClose()
 *   addEventListener('change', e => e.detail.what: 'saved' | 'uploaded' | 'conflict' | 'error')
 * Pantalla: mount(host, ctx, arg, q) → #/archivo (lista) y #/archivo/AAAA-MM[?hoja=sNN] (visor de solo lectura).
 *
 * Privacidad: nada del contenido se escribe en la consola; los mensajes de error no llevan datos.
 */
import { Engine, a1ToAddr } from './engine.js';
import { SheetGrid } from './grid.js';
import { el, money } from './ui.js';
import { serialToDate, dateToSerial } from './format.js';
import { ARCHIVE_PREFIX, ARCHIVE_INDEX_KEY } from './store.js';
import { gitBlobSha, isGzipBytes, utf8Encode, utf8Decode, RE_ARCHIVE_KEY } from './sync-github.js';

export const ARCHIVE_FORMAT = 'flujoweb-archivo';
export const ARCHIVE_VERSION = 1;
const MAX_UNPACKED = 200 * 1024 * 1024;          // tope de seguridad al descomprimir (un archivo real pesa unos pocos MB)
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_ABBR = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const pad2 = (n) => String(n).padStart(2, '0');

/* ================================================================== claves y etiquetas */

export const isValidKey = (k) => typeof k === 'string' && RE_ARCHIVE_KEY.test(k);
/** '2026-11' → 'noviembre 2026' */
export function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key));
  return m && MONTHS[+m[2] - 1] ? MONTHS[+m[2] - 1] + ' ' + m[1] : String(key);
}
/** '2026-11' → 'NOV26' (como se llamaba cada libro mensual de Excel: «Flujo NOV26») */
export function monthShort(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key));
  return m && MONTHS_ABBR[+m[2] - 1] ? MONTHS_ABBR[+m[2] - 1] + m[1].slice(2) : String(key);
}
/** Mes (AAAA-MM) de una fecha local; por omisión, hoy. */
export function keyFromDate(d = new Date()) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
/** Mes (AAAA-MM) de un número de serie de Excel. */
export function keyFromSerial(n) { const d = serialToDate(n); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1); }
/** Mes en curso de la hoja CONSOL (celda L21, una fecha del día 1 de ese mes), o null si no se puede leer. */
export function consolMonthKey(engine) {
  try {
    const sh = engine.sheet('s01') || engine.sheet('CONSOL');
    if (!sh) return null;
    const p = a1ToAddr('L21');
    const v = engine.value(sh.id, p.r, p.c);
    return typeof v === 'number' && Number.isFinite(v) && v > 1 ? keyFromSerial(v) : null;
  } catch (e) { return null; }
}

/* ================================================================== errores */

export class ArchiveError extends Error {
  /** @param {string} code NO_ENGINE, NO_STORE, BAD_KEY, EXISTS, CORRUPT, NEWER, NOT_ARCHIVE, NO_GZIP, NOT_FOUND, OFFLINE, VERIFY, ABORTED… @param {string} message español, sin datos */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** ¿Un error nuestro (ArchiveError, StoreError, GithubError)? Esos traen su mensaje ya en español y sin datos; cualquier otro (TypeError, errores de librerías…) no se muestra tal cual. */
const isKnownError = (e) => e instanceof ArchiveError || !!(e && (e.name === 'StoreError' || e.name === 'GithubError'));
const errText = (e, fallback = 'Ocurrió un error inesperado.') => (isKnownError(e) && typeof e.message === 'string' && e.message ? e.message : fallback);
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Cede el hilo para que la interfaz pueda pintar («Guardando hoja 3 de 11…»). En segundo plano usa un mensaje (los temporizadores se frenan a 1 s). */
function tick() {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (!hidden && typeof requestAnimationFrame === 'function') {
    return new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 50); });
  }
  if (typeof MessageChannel === 'function') {
    return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
  }
  return new Promise((r) => setTimeout(r, 0));
}

/** Ejecuta fn(signal) con plazo: al vencer cancela (AbortController) y devuelve TIMED_OUT. Los errores de fn se propagan. */
const TIMED_OUT = Symbol('timeout');
function withTimeout(fn, ms) {
  const ac = new AbortController();
  let timer = 0;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { ac.abort(); resolve(TIMED_OUT); }, ms); });
  const run = Promise.resolve().then(() => fn(ac.signal));
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

/* ================================================================== compresión y formato del archivo */

const hasBlobStream = () => typeof Blob === 'function' && !!Blob.prototype && typeof Blob.prototype.stream === 'function';
export const canCompress = () => typeof CompressionStream === 'function' && hasBlobStream();
export const canDecompress = () => typeof DecompressionStream === 'function' && hasBlobStream();

async function readStream(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (limit && n > limit) { try { await reader.cancel(); } catch (_) { /* nada */ } throw new ArchiveError('CORRUPT', 'El archivo es demasiado grande o está dañado.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export const gzipBytes = (bytes) => readStream(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')));
export const gunzipBytes = (bytes) => readStream(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_UNPACKED);

/**
 * Objeto del archivo → bytes. Con gzip si el navegador puede (compress:true); si no, JSON en UTF-8 sin comprimir.
 * @returns {Promise<{bytes:Uint8Array, compressed:boolean, rawBytes:number}>}
 */
export async function encodeArchive(obj, { compress = true } = {}) {
  const raw = utf8Encode(JSON.stringify(obj));
  if (compress && canCompress()) {
    try { return { bytes: await gzipBytes(raw), compressed: true, rawBytes: raw.length }; }
    catch (_) { /* si falla la compresión se guarda sin comprimir */ }
  }
  return { bytes: raw, compressed: false, rawBytes: raw.length };
}

/** Valida la estructura de un archivo ya leído. Lanza ArchiveError con un mensaje en español. */
export function validateArchive(obj) {
  if (!obj || typeof obj !== 'object' || obj.formato !== ARCHIVE_FORMAT) throw new ArchiveError('NOT_ARCHIVE', 'El archivo no es un archivo mensual de Flujo.');
  if (!(obj.version >= 1)) throw new ArchiveError('NOT_ARCHIVE', 'El archivo no es un archivo mensual de Flujo (falta la versión).');
  if (obj.version > ARCHIVE_VERSION) throw new ArchiveError('NEWER', 'Este archivo se creó con una versión más nueva de Flujo. Actualiza la aplicación para poder abrirlo.');
  if (!isValidKey(obj.mes)) throw new ArchiveError('CORRUPT', 'El archivo está dañado (no tiene un mes válido).');
  if (!Array.isArray(obj.hojas) || !obj.hojas.length || !Array.isArray(obj.estilos) || !obj.datos || typeof obj.datos !== 'object') {
    throw new ArchiveError('CORRUPT', 'El archivo está dañado o incompleto (faltan hojas o estilos).');
  }
  for (const h of obj.hojas) {
    const d = h && obj.datos[h.id];
    if (!d || !Array.isArray(d.cells)) throw new ArchiveError('CORRUPT', 'El archivo está dañado: falta el contenido de la hoja «' + String((h && h.name) || (h && h.id) || '?').trim() + '».');
  }
  return obj;
}

/** Bytes (gzip o JSON) → objeto del archivo validado. Detecta el formato por los bytes mágicos 1f 8b. */
export async function decodeArchive(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new ArchiveError('CORRUPT', 'El archivo está vacío o dañado.');
  let raw = bytes;
  if (isGzipBytes(bytes)) {
    if (!canDecompress()) throw new ArchiveError('NO_GZIP', 'Este navegador no puede abrir archivos comprimidos. Actualiza el navegador (Chrome, Edge, Firefox o Safari recientes) e inténtalo de nuevo.');
    try { raw = await gunzipBytes(bytes); }
    catch (e) { throw e instanceof ArchiveError ? e : new ArchiveError('CORRUPT', 'El archivo está dañado (no se pudo descomprimir).'); }
  }
  let obj;
  try { obj = JSON.parse(utf8Decode(raw)); }
  catch (_) { throw new ArchiveError('CORRUPT', 'El archivo está dañado (no se pudo leer su contenido).'); }
  return validateArchive(obj);
}

/* ================================================================== instantánea («congelar» las hojas) */

const errorText = (v) => (v && typeof v.value === 'string' && v.value ? v.value : '#ERROR!');

/** Valor calculado → lo que se guarda en el archivo: número, texto o booleano; un error queda como texto ('#DIV/0!'); vacío = null (no se guarda). */
function frozenValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return errorText(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return '#NUM!';
  return v;
}

/**
 * Una hoja sin fórmulas: mismo formato que engine.exportSheet(), con cada celda como [fila, columna, valor] y `fin` = última fila tecleada.
 * Lo TECLEADO se guarda tal cual (con todos sus decimales); cada FÓRMULA se reemplaza por el valor que mostraba (número, texto o booleano;
 * un error queda como texto '#DIV/0!'; lo vacío no se guarda). Las celdas que solo existen como resultado de una fórmula de matriz
 * (no salen en exportSheet) también se guardan con su valor. Requiere la hoja ya cargada en el motor. No modifica nada.
 */
export function freezeSheet(engine, sh) {
  const base = engine.exportSheet(sh.id);                      // todo menos el contenido de las celdas
  const vals = engine.hf.getSheetValues(sh.hfId);              // valores calculados de toda la hoja
  const cells = [];
  const seen = new Set();
  for (const cell of base.cells) {
    const r = cell[0], c = cell[1];
    seen.add(r * 4096 + c);
    const isFormula = cell.length > 3 && cell[3] !== null && cell[3] !== undefined;
    const v = isFormula ? frozenValue(vals[r] && vals[r][c] !== undefined ? vals[r][c] : engine.value(sh.id, r, c)) : frozenValue(cell[2]);
    if (v !== null) cells.push([r, c, v]);
  }
  let extra = false;
  for (let r = 0; r < vals.length; r++) {
    const row = vals[r];
    for (let c = 0; c < row.length; c++) {
      if (seen.has(r * 4096 + c)) continue;
      const v = frozenValue(row[c]);
      if (v !== null) { cells.push([r, c, v]); extra = true; }
    }
  }
  if (extra) cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = { ...base, cells };
  const fin = engine.lastConstRow(sh.id);
  if (fin >= 0) out.fin = fin;
  return out;
}

const catShort = (cat, sh) => ((cat && cat[sh.name] && cat[sh.name].short) || String(sh.name).trim());

/** Cifras clave del tablero (Resumen), si el módulo del Resumen está y la hoja se puede leer. Nunca lanza. */
async function readResumen(engine, today) {
  try {
    const D = await import('./dashboard.js');
    if (!D || typeof D.readSummary !== 'function') return null;
    const s = D.readSummary(engine, { today });
    if (!s || !s.ok) return null;
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const out = { disponible: num(s.available), patrimonio: num(s.patrimonio && s.patrimonio.actual) };
    return out.disponible === null && out.patrimonio === null ? null : out;
  } catch (e) { return null; }
}

/**
 * Crea la instantánea de TODAS las hojas del motor (carga primero las diferidas). Trabaja hoja por hoja cediendo el hilo.
 * No escribe nada ni toca la base de datos; solo lee el motor (cargar una hoja diferida vacía el historial de «Deshacer»).
 * @param {object} engine
 * @param {{key:string, label?:string, source?:'cierre'|'manual', onProgress?:Function, signal?:AbortSignal, now?:Date, resumen?:boolean}} o
 * @returns {Promise<object>} el objeto del archivo (ver cabecera)
 */
export async function buildSnapshot(engine, { key, label, source = 'manual', onProgress, signal, now = new Date(), resumen = true } = {}) {
  if (!engine || !Array.isArray(engine.sheets) || !engine.sheets.length) throw new ArchiveError('NO_ENGINE', 'Las hojas todavía no están cargadas: espera un momento y vuelve a intentarlo.');
  if (!isValidKey(key)) throw new ArchiveError('BAD_KEY', 'El mes del archivo no es válido (debe ser AAAA-MM, por ejemplo 2026-11).');
  const sheets = engine.sheets;
  const cat = (engine.meta && engine.meta.catalog) || {};
  const prog = (o) => { try { if (onProgress) onProgress(o); } catch (_) { /* un callback ajeno no debe romper el archivo */ } };
  const check = () => { if (signal && signal.aborted) throw new ArchiveError('ABORTED', 'Se canceló el guardado del archivo.'); };

  const lazy = sheets.filter((s) => !s.loaded);                // 1) hojas diferidas: hay que cargarlas para tener sus valores
  for (let i = 0; i < lazy.length; i++) {
    check();
    prog({ phase: 'load', done: i, total: lazy.length, name: catShort(cat, lazy[i]), message: 'Preparando las hojas… (' + (i + 1) + ' de ' + lazy.length + ')' });
    await tick();
    engine.ensureLoaded(lazy[i].id);
  }

  const datos = {};                                             // 2) congelar cada hoja
  for (let i = 0; i < sheets.length; i++) {
    check();
    const sh = sheets[i];
    prog({ phase: 'freeze', done: i, total: sheets.length, name: catShort(cat, sh), message: 'Guardando la hoja ' + (i + 1) + ' de ' + sheets.length + ': ' + catShort(cat, sh) });
    await tick();
    datos[sh.id] = freezeSheet(engine, sh);
  }
  check();
  prog({ phase: 'summary', done: sheets.length, total: sheets.length, message: 'Terminando…' });
  const res = resumen ? await readResumen(engine, dateToSerial(now)) : null;
  return {
    formato: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, mes: key, etiqueta: label || monthLabel(key), creado: now.toISOString(), origen: source === 'cierre' ? 'cierre' : 'manual',
    resumen: res,
    hojas: sheets.map((s) => ({ id: s.id, name: s.name, hidden: !!s.hidden, tabColor: s.tabColor || null, rows: datos[s.id].rows, cols: datos[s.id].cols })),
    estilos: engine.styles,
    catalogo: cat,
    datos,
  };
}

/** Comprueba que lo leído de vuelta coincide con lo creado (misma cantidad de hojas y celdas, y mismos extremos). */
function assertSameShape(a, b) {
  const bad = () => new ArchiveError('VERIFY', 'La copia que se acaba de guardar no coincide con las hojas originales, así que no se usó. No se cambió nada: inténtalo de nuevo.');
  if (a.mes !== b.mes || a.hojas.length !== b.hojas.length || a.estilos.length !== b.estilos.length) throw bad();
  for (const h of a.hojas) {
    const x = a.datos[h.id].cells, y = b.datos[h.id] && b.datos[h.id].cells;
    if (!y || x.length !== y.length) throw bad();
    if (x.length && (JSON.stringify(x[0]) !== JSON.stringify(y[0]) || JSON.stringify(x[x.length - 1]) !== JSON.stringify(y[y.length - 1]))) throw bad();
  }
}

/* ================================================================== motor del visor (solo constantes) */

/**
 * Motor propio para mirar un archivo: solo constantes (no hay fórmulas ni nombres), independiente del motor vivo y de IndexedDB.
 * Las hojas se cargan una por una al abrirlas (loadSheetAsync). «Ir al final» usa la última fila tecleada que se guardó (`fin`).
 */
export function createViewerEngine(bundle) {
  const eng = new Engine(bundle.meta, bundle.sheetDatas);
  const fin = {};
  for (const [sid, d] of Object.entries(bundle.sheetDatas)) if (d && Number.isInteger(d.fin)) fin[sid] = d.fin;
  const base = eng.lastConstRow.bind(eng);
  eng.lastConstRow = (sid, c0 = 0, c1 = null) => (c0 === 0 && c1 === null && Object.prototype.hasOwnProperty.call(fin, sid) ? fin[sid] : base(sid, c0, c1));
  return eng;
}

/** Libera la memoria de un motor del visor. */
export function destroyViewerEngine(eng) {
  try { if (eng && eng.hf && typeof eng.hf.destroy === 'function') eng.hf.destroy(); } catch (_) { /* ya liberado */ }
}

/** Del objeto del archivo al {meta, sheetDatas} que entiende `new Engine(...)`. */
export function archiveToBundle(arc) {
  const meta = { version: 1, source: 'archivo', epoch: '1899-12-30', sheets: arc.hojas.map((h) => ({ ...h })), styles: arc.estilos, names: {}, catalog: arc.catalogo || {} };
  return { meta, sheetDatas: arc.datos };
}

/* ================================================================== almacén local (IndexedDB, kv) */

class LocalArchive {
  constructor(getStore) { this.getStore = getStore; }
  _s() {
    const s = this.getStore();
    if (!s) throw new ArchiveError('NO_STORE', 'Este dispositivo no permite guardar datos locales, así que no se puede usar el archivo mensual. Abre Flujo en una ventana normal del navegador (no privada).');
    return s;
  }
  hasStore() { return !!this.getStore(); }

  /** {clave: entrada}. Con verify, descarta las entradas cuyos bytes ya no están. */
  async readIndex({ verify = false } = {}) {
    return this._s().tx(['kv'], 'readonly', async (t) => {
      const idx = (await t.get('kv', ARCHIVE_INDEX_KEY)) || {};
      if (!verify) return idx;
      const keys = new Set(await t.keys('kv'));
      const out = {};
      for (const [k, e] of Object.entries(idx)) if (keys.has(ARCHIVE_PREFIX + k)) out[k] = e;
      return out;
    }, { action: 'leer el archivo mensual' });
  }

  async getBytes(key) {
    const v = await this._s().tx(['kv'], 'readonly', (t) => t.get('kv', ARCHIVE_PREFIX + key), { action: 'leer el archivo mensual' });
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
  }

  /** Guarda bytes + entrada del índice en UNA transacción. Sin replace, si la clave ya existe no escribe nada. @returns {{exists:boolean, prev:object|null}} */
  async put(key, bytes, entry, { replace = false } = {}) {
    return this._s().tx(['kv'], 'readwrite', async (t) => {
      const idx = { ...((await t.get('kv', ARCHIVE_INDEX_KEY)) || {}) };
      const prev = idx[key] || null;
      if (prev && !replace) return { exists: true, prev };
      idx[key] = entry;
      await Promise.all([t.put('kv', ARCHIVE_PREFIX + key, bytes), t.put('kv', ARCHIVE_INDEX_KEY, idx)]);
      return { exists: false, prev };
    }, { durability: 'strict', action: 'guardar el archivo mensual' });
  }

  /** Cambia campos de varias entradas a la vez; cada cambio solo se aplica si la entrada sigue siendo la misma (`creado`). */
  async patchMany(list) {
    if (!list.length) return 0;
    return this._s().tx(['kv'], 'readwrite', async (t) => {
      const idx = { ...((await t.get('kv', ARCHIVE_INDEX_KEY)) || {}) };
      let n = 0;
      for (const { key, guard, patch } of list) {
        const e = idx[key];
        if (!e || (guard != null && e.creado !== guard)) continue;
        idx[key] = { ...e, ...patch };
        n++;
      }
      if (n) await t.put('kv', ARCHIVE_INDEX_KEY, idx);
      return n;
    }, { durability: 'strict', action: 'actualizar el archivo mensual' });
  }
  patch(key, guard, patch) { return this.patchMany([{ key, guard, patch }]); }

  async remove(key) {
    return this._s().tx(['kv'], 'readwrite', async (t) => {
      const idx = { ...((await t.get('kv', ARCHIVE_INDEX_KEY)) || {}) };
      delete idx[key];
      await Promise.all([t.del('kv', ARCHIVE_PREFIX + key), t.put('kv', ARCHIVE_INDEX_KEY, idx)]);
    }, { durability: 'strict', action: 'quitar el archivo mensual' });
  }
}

/** Entrada del índice a partir del contenido de un archivo (para el que se baja de GitHub). */
function entryFromArchive(arc, bytes, sha, extra = {}) {
  return {
    etiqueta: arc.etiqueta || monthLabel(arc.mes), creado: arc.creado || new Date().toISOString(), bytes: bytes.length, origen: arc.origen === 'cierre' ? 'cierre' : 'manual',
    subido: false, comprimido: isGzipBytes(bytes), sha, resumen: arc.resumen || null, hojas: arc.hojas.length, reemplazar: false, conflicto: false, ultimoError: null, ...extra,
  };
}

/* ================================================================== administrador del archivo (lo que ve el resto de la app) */

const STOP_CODES = new Set(['NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'BAD_TOKEN', 'NO_CONFIG', 'NO_PERMISSION', 'FORBIDDEN', 'NO_WRITE', 'PUBLIC_REPO', 'SERVER',
  'NOT_FOUND', 'BRANCH_MISSING', 'INVALID_CONFIG', 'INSECURE', 'SSO']);

export class Archive extends EventTarget {
  /**
   * @param {{getEngine:Function, getStore:Function, getSync:Function, now?:Function, uploadTimeoutMs?:number, listTimeoutMs?:number}} deps
   *   getEngine() → Engine vivo · getStore() → Store (IndexedDB) · getSync() → GithubSync (o null) · now() → Date (pruebas)
   */
  constructor({ getEngine, getStore, getSync, now, uploadTimeoutMs = 25000, listTimeoutMs = 12000 } = {}) {
    super();
    const fn = (x) => (typeof x === 'function' ? x : () => x || null);
    this._getEngine = fn(getEngine);
    this._getStore = fn(getStore);
    this._getSync = fn(getSync);
    this._now = typeof now === 'function' ? now : () => new Date();
    this._uploadTimeoutMs = uploadTimeoutMs;
    this._listTimeoutMs = listTimeoutMs;
    this._local = new LocalArchive(() => this._getStore());
    this._snapChain = Promise.resolve();
    this._uploading = null;
    this._remoteCache = null;       // {at, map, list}
  }

  _emit(what, key) { try { this.dispatchEvent(new CustomEvent('change', { detail: { what, key } })); } catch (_) { /* sin CustomEvent */ } }
  _syncReady() { const s = this._getSync(); return !!(s && typeof s.isConfigured === 'function' && s.isConfigured()); }

  /** Mes de hoy (AAAA-MM). */
  keyForToday() { return keyFromDate(this._now()); }
  /** Mes del cierre: el mes en curso de CONSOL (L21); si no se puede leer, el de hoy. */
  keyForClose() { const e = this._getEngine(); return (e && consolMonthKey(e)) || this.keyForToday(); }
  monthLabel(key) { return monthLabel(key); }

  /* ---------------------------------------------------------------- crear */

  /**
   * Crea el archivo de un mes y lo guarda en este dispositivo; después intenta subirlo a GitHub (con plazo).
   * Nunca lanza: devuelve {ok:false, error, code} si no se pudo CREAR/GUARDAR (el cierre de mes debe abortar). Que no se pueda subir
   * (sin red, sin GitHub) NO es un fallo: queda pendiente y se sube solo.
   * @param {{key?:string, label?:string, source?:'cierre'|'manual', replace?:boolean, upload?:boolean, onProgress?:Function, signal?:AbortSignal}} [opts]
   *   key por omisión: con source 'cierre' el mes en curso de CONSOL (L21); con 'manual' el mes de hoy.
   *   Si la clave ya existe y no se pasa replace:true devuelve {ok:false, code:'EXISTS', exists:true} sin escribir nada.
   * @returns {Promise<{ok:boolean, key:string|null, label?:string, bytes?:number, rawBytes?:number, compressed?:boolean, uploaded?:boolean, pending?:boolean,
   *   replaced?:boolean, conflict?:boolean, warning?:string, resumen?:object|null, error?:string, code?:string}>}
   */
  snapshot(opts = {}) {
    const run = () => this._snapshot(opts || {});
    const p = this._snapChain.then(run, run);
    this._snapChain = p.catch(() => {});
    return p;
  }

  async _snapshot({ key, label, source, replace = false, upload = true, onProgress, signal } = {}) {
    const fail = (code, error, extra = {}) => ({ ok: false, key: key || null, code, error, ...extra });
    try {
      const engine = this._getEngine();
      if (!engine) return fail('NO_ENGINE', 'Las hojas todavía no están cargadas: espera un momento y vuelve a intentarlo.');
      if (!this._getStore()) return fail('NO_STORE', 'Este dispositivo no permite guardar datos locales, así que no se puede crear el archivo. Abre Flujo en una ventana normal del navegador (no privada).');
      source = source === 'cierre' ? 'cierre' : 'manual';
      if (key == null || key === '') key = source === 'cierre' ? this.keyForClose() : this.keyForToday();
      if (!isValidKey(key)) return fail('BAD_KEY', 'El mes del archivo no es válido (debe ser AAAA-MM, por ejemplo 2026-11).');
      label = typeof label === 'string' && label.trim() ? label.trim() : monthLabel(key);
      const prog = (o) => { try { if (onProgress) onProgress(o); } catch (_) { /* nada */ } };

      const before = (await this._local.readIndex())[key] || null;       // aviso rápido, antes de trabajar
      if (before && !replace) return fail('EXISTS', 'Ya existe un archivo de ' + monthLabel(key) + '. Para reemplazarlo hay que confirmarlo.', { exists: true, existing: before });

      const now = this._now();
      const arc = await buildSnapshot(engine, { key, label, source, onProgress, signal, now });
      prog({ phase: 'encode', message: 'Comprimiendo el archivo…' });
      await tick();
      const enc = await encodeArchive(arc);
      const back = await decodeArchive(enc.bytes);                         // comprobación: lo guardado se lee igual que lo creado
      assertSameShape(arc, back);
      const sha = await gitBlobSha(enc.bytes);

      prog({ phase: 'save', message: 'Guardando en este dispositivo…' });
      const entry = {
        etiqueta: label, creado: arc.creado, bytes: enc.bytes.length, origen: arc.origen, subido: false, comprimido: enc.compressed, sha,
        resumen: arc.resumen, hojas: arc.hojas.length, reemplazar: !!replace, conflicto: false, ultimoError: null,
      };
      const put = await this._local.put(key, enc.bytes, entry, { replace: !!replace });
      if (put.exists) return fail('EXISTS', 'Ya existe un archivo de ' + monthLabel(key) + ' (se creó mientras se preparaba este). Para reemplazarlo hay que confirmarlo.', { exists: true, existing: put.prev });
      this._remoteCache = null;
      this._emit('saved', key);

      const out = {
        ok: true, key, label, bytes: enc.bytes.length, rawBytes: enc.rawBytes, compressed: enc.compressed, uploaded: false, pending: false, replaced: !!put.prev,
        resumen: arc.resumen, source,
      };
      if (upload === false) { out.pending = this._syncReady(); return out; }
      prog({ phase: 'upload', message: 'Subiendo a GitHub…' });
      const up = await this._tryUpload(key);
      Object.assign(out, up);
      return out;
    } catch (e) {
      const unexpected = 'No se pudo crear el archivo por un error inesperado. Inténtalo de nuevo; si se repite, descarga un respaldo en Ajustes → Exportar y respaldo.';
      return fail(e && e.code && typeof e.code === 'string' ? e.code : 'ERROR', errText(e, unexpected), isKnownError(e) ? {} : { detail: String((e && e.message) || e) });
    }
  }

  /** Intenta subir con plazo (snapshot no debe quedarse esperando a una red lenta). @returns {{uploaded:boolean, pending:boolean, conflict?:boolean, warning?:string}} */
  async _tryUpload(key) {
    let r;
    try { r = await withTimeout((signal) => this._uploadOne(key, { signal }), this._uploadTimeoutMs); }
    catch (e) { r = { status: 'error', error: e }; }
    if (r === TIMED_OUT) r = { status: 'timeout' };
    switch (r.status) {
      case 'uploaded': return { uploaded: true, pending: false };
      case 'no-config': return { uploaded: false, pending: false, warning: 'Se guardó en este dispositivo. Para verlo también desde otros dispositivos, configura GitHub en Ajustes → Sincronización: se subirá solo.' };
      case 'offline': return { uploaded: false, pending: true, warning: 'Se guardó en este dispositivo. No hay conexión a internet: se subirá a GitHub solo cuando vuelva.' };
      case 'timeout': case 'aborted': return { uploaded: false, pending: true, warning: 'Se guardó en este dispositivo. GitHub tardó demasiado en responder: se volverá a intentar solo.' };
      case 'conflict': return { uploaded: false, pending: false, conflict: true, warning: 'Se guardó en este dispositivo, pero en GitHub ya había otro archivo de ' + monthLabel(key) + ' distinto. No se sobrescribió: en Archivo puedes elegir cuál conservar.' };
      case 'error': return { uploaded: false, pending: true, warning: 'Se guardó en este dispositivo, pero no se pudo subir a GitHub: ' + errText(r.error, 'error desconocido') + ' Se volverá a intentar solo.' };
      default: return { uploaded: false, pending: false };
    }
  }

  /** Sube UN archivo local a GitHub y actualiza su estado en el índice. @returns {{status:'uploaded'|'no-config'|'offline'|'missing'|'conflict'|'aborted'|'error', error?:Error}} */
  async _uploadOne(key, { signal } = {}) {
    const sync = this._getSync();
    if (!sync || typeof sync.archivePut !== 'function' || !sync.isConfigured()) return { status: 'no-config' };
    if (offline()) return { status: 'offline' };
    const entry = (await this._local.readIndex())[key];
    const bytes = entry ? await this._local.getBytes(key) : null;
    if (!entry || !bytes) return { status: 'missing' };
    try {
      const r = await sync.archivePut(key, bytes, { replace: !!entry.reemplazar, signal });
      await this._local.patch(key, entry.creado, { subido: true, conflicto: false, reemplazar: false, ultimoError: null, sha: r.sha || entry.sha, subidoEn: new Date().toISOString() });
      this._remoteCache = null;
      this._emit('uploaded', key);
      return { status: 'uploaded', result: r };
    } catch (e) {
      const code = e && e.code;
      if (code === 'ABORTED') return { status: 'aborted', error: e };
      if (code === 'EXISTS') {
        await this._local.patch(key, entry.creado, { conflicto: true, remoteSha: e.remoteSha || null, ultimoError: null }).catch(() => {});
        this._emit('conflict', key);
        return { status: 'conflict', error: e };
      }
      await this._local.patch(key, entry.creado, { ultimoError: { code: code || 'ERROR', message: errText(e), at: new Date().toISOString() } }).catch(() => {});
      this._emit('error', key);
      return { status: 'error', error: e };
    }
  }

  /**
   * Sube los archivos que están pendientes (guardados aquí y aún no en GitHub). Sin nada pendiente no usa la red.
   * @returns {Promise<{ok:true, uploaded:string[], failed:{key:string,error:string,code:string}[], conflicts:string[], remaining:number, skipped:string|null}>}
   *   skipped: 'no-config' | 'offline' | 'no-store' | null
   */
  uploadPending(opts = {}) {
    if (this._uploading) return this._uploading;
    this._uploading = this._uploadPending(opts || {}).finally(() => { this._uploading = null; });
    return this._uploading;
  }

  async _uploadPending({ onProgress, signal } = {}) {
    const res = { ok: true, uploaded: [], failed: [], conflicts: [], remaining: 0, skipped: null };
    if (!this._local.hasStore()) { res.skipped = 'no-store'; return res; }
    const idx = await this._local.readIndex();
    const pend = Object.keys(idx).filter((k) => !idx[k].subido && !idx[k].conflicto).sort().reverse();
    res.remaining = pend.length;
    if (!pend.length) return res;
    if (!this._syncReady()) { res.skipped = 'no-config'; return res; }
    if (offline()) { res.skipped = 'offline'; return res; }
    for (let i = 0; i < pend.length; i++) {
      if (signal && signal.aborted) break;
      const key = pend[i];
      try { if (onProgress) onProgress({ done: i, total: pend.length, key, message: 'Subiendo el archivo de ' + monthLabel(key) + '…' }); } catch (_) { /* nada */ }
      const r = await this._uploadOne(key, { signal });
      if (r.status === 'uploaded') res.uploaded.push(key);
      else if (r.status === 'conflict') res.conflicts.push(key);
      else if (r.status === 'error') {
        res.failed.push({ key, error: errText(r.error), code: (r.error && r.error.code) || 'ERROR' });
        if (r.error && STOP_CODES.has(r.error.code)) break;                 // un problema de red/token/permiso afectaría a todos
      } else if (r.status === 'offline' || r.status === 'aborted') break;
    }
    const after = await this._local.readIndex();
    res.remaining = Object.keys(after).filter((k) => !after[k].subido && !after[k].conflicto).length;
    return res;
  }

  /** Cuántos archivos están guardados aquí y sin subir (sin contar los que esperan una decisión por conflicto). */
  async pendingCount() {
    if (!this._local.hasStore()) return 0;
    const idx = await this._local.readIndex();
    return Object.values(idx).filter((e) => !e.subido && !e.conflicto).length;
  }
  /** Cuántos archivos hay guardados aquí y NO están en GitHub (pendientes y en conflicto): los que se perderían al borrar los datos del dispositivo. */
  async unsyncedCount() {
    if (!this._local.hasStore()) return 0;
    return Object.values(await this._local.readIndex()).filter((e) => !e.subido).length;
  }
  /** Cuántos archivos hay en este dispositivo. */
  async count() { return this._local.hasStore() ? Object.keys(await this._local.readIndex()).length : 0; }

  /**
   * Dos versiones del mismo mes (la de este dispositivo y otra distinta en GitHub): 'local' = la mía reemplaza a la de GitHub;
   * 'remote' = descarto la mía y me quedo con la de GitHub.
   * @returns {Promise<{ok:boolean, error?:string, code?:string}>}
   */
  async resolveConflict(key, choice) {
    try {
      if (!isValidKey(key)) throw new ArchiveError('BAD_KEY', 'El mes del archivo no es válido.');
      if (choice !== 'local' && choice !== 'remote') throw new ArchiveError('BAD_CHOICE', 'Opción no válida.');
      const idx = await this._local.readIndex();
      const e = idx[key];
      if (!e) throw new ArchiveError('NOT_FOUND', 'No hay un archivo de ' + monthLabel(key) + ' en este dispositivo.');
      if (choice === 'local') {
        await this._local.patch(key, e.creado, { conflicto: false, reemplazar: true, subido: false, ultimoError: null });
        const r = await this._uploadOne(key);
        if (r.status === 'uploaded') return { ok: true };
        if (r.status === 'error') throw r.error;
        if (r.status === 'conflict') throw new ArchiveError('EXISTS', 'En GitHub el archivo de ' + monthLabel(key) + ' cambió otra vez mientras tanto. Vuelve a abrir la lista y elige de nuevo.');
        if (r.status === 'no-config') throw new ArchiveError('NO_CONFIG', 'GitHub no está configurado en este dispositivo.');
        return { ok: true, pending: true, warning: 'Quedó pendiente: se subirá cuando haya conexión.' };
      }
      const sync = this._getSync();
      if (!sync || !sync.isConfigured()) throw new ArchiveError('NO_CONFIG', 'GitHub no está configurado en este dispositivo.');
      if (offline()) throw new ArchiveError('OFFLINE', 'Ahora no hay conexión a internet. Inténtalo de nuevo cuando vuelva.');
      const got = await sync.archiveGet(key);
      const arc = await decodeArchive(got.bytes);
      await this._local.put(key, got.bytes, entryFromArchive(arc, got.bytes, got.sha, { subido: true, subidoEn: new Date().toISOString() }), { replace: true });
      this._remoteCache = null;
      this._emit('saved', key);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e), code: (e && e.code) || 'ERROR' };
    }
  }

  /* ---------------------------------------------------------------- consultar */

  /** ¿Hay un archivo de ese mes (en este dispositivo o, si ya se consultó, en GitHub)? */
  async has(key) {
    if (!isValidKey(key)) return false;
    if (this._local.hasStore() && (await this._local.readIndex())[key]) return true;
    return !!(this._remoteCache && this._remoteCache.map.has(key));
  }

  /** El elemento de lista de un mes (solo lo guardado en este dispositivo), o null. */
  async info(key) {
    if (!isValidKey(key) || !this._local.hasStore()) return null;
    const e = (await this._local.readIndex())[key];
    return e ? this._item(key, e, null, { configured: this._syncReady(), ok: false }) : null;
  }

  _item(key, e, r, remote) {
    const where = e && r ? 'ambos' : r ? 'github' : e ? (e.subido && !remote.ok ? 'ambos' : 'local') : 'local';
    return {
      key, label: (e && e.etiqueta) || monthLabel(key), createdAt: (e && e.creado) || null, bytes: e ? e.bytes : (r ? r.size : null),
      where, source: (e && e.origen) || null, resumen: (e && e.resumen) || null,
      pending: !!(e && !e.subido && !e.conflicto), conflict: !!(e && e.conflicto), uploadError: (e && e.ultimoError && e.ultimoError.message) || null,
      local: !!e, remote: !!r, sheets: (e && e.hojas) || null, compressed: e ? !!e.comprimido : (r ? r.gz : null),
    };
  }

  /** Lista de GitHub con plazo y caché corta. Devuelve {map, list} o lanza. */
  async _remoteList({ force = false } = {}) {
    const c = this._remoteCache;
    if (!force && c && Date.now() - c.at < 15000) return c;
    const sync = this._getSync();
    const list = await withTimeout((signal) => sync.archiveList({ signal }), this._listTimeoutMs);
    if (list === TIMED_OUT) throw new ArchiveError('TIMEOUT', 'GitHub tardó demasiado en responder.');
    this._remoteCache = { at: Date.now(), list, map: new Map(list.map((x) => [x.key, x])), truncated: !!list.truncated };
    return this._remoteCache;
  }

  /**
   * Une lo guardado aquí con lo que hay en GitHub.
   * @param {{remote?:boolean, force?:boolean}} [o] remote:false = solo este dispositivo (sin red) · force = ignora la caché de 15 s
   * @returns {Promise<{items:object[], remote:{configured:boolean, tried:boolean, ok:boolean, offline:boolean, error:string|null, at:number|null}}>}
   */
  async listDetailed({ remote = true, force = false } = {}) {
    const info = { configured: this._syncReady(), tried: false, ok: false, offline: false, error: null, at: null };
    let idx = this._local.hasStore() ? await this._local.readIndex({ verify: true }) : {};
    let rmap = null;
    if (remote && info.configured) {
      if (offline()) { info.offline = true; info.error = 'Sin conexión: se muestran los archivos guardados en este dispositivo.'; }
      else {
        info.tried = true;
        try { const rc = await this._remoteList({ force }); rmap = rc.map; info.ok = true; info.at = rc.at; info.truncated = rc.truncated; }
        catch (e) { info.error = errText(e, 'No se pudo consultar GitHub.'); }
      }
    }
    if (rmap && this._local.hasStore()) idx = await this._reconcile(idx, rmap, { complete: !info.truncated });
    const keys = new Set([...Object.keys(idx), ...(rmap ? [...rmap.keys()] : [])]);
    const items = [...keys].sort().reverse().map((k) => this._item(k, idx[k] || null, rmap ? rmap.get(k) || null : null, info));
    return { items, remote: info };
  }

  /** @returns {Promise<object[]>} ver listDetailed (solo los elementos) */
  async list(opts = {}) { return (await this.listDetailed(opts)).items; }

  /** Pone al día el índice local según lo que hay en GitHub (quién está subido, quién cambió, quién quedó pendiente). Devuelve el índice nuevo. */
  async _reconcile(idx, rmap, { complete = true } = {}) {
    const patches = [];
    const refresh = [];
    const next = { ...idx };
    const apply = (key, patch) => { patches.push({ key, guard: idx[key].creado, patch }); next[key] = { ...idx[key], ...patch }; };
    for (const [key, e] of Object.entries(idx)) {
      const r = rmap.get(key);
      if (r) {
        if (r.sha === e.sha) { if (!e.subido || e.conflicto || e.reemplazar) apply(key, { subido: true, conflicto: false, reemplazar: false, ultimoError: null }); }
        else if (e.subido) refresh.push(key);                                 // GitHub tiene una versión más nueva de algo que ya estaba sincronizado
        else if (!e.reemplazar && !e.conflicto) apply(key, { conflicto: true, remoteSha: r.sha });
      } else if (complete) {
        if (e.subido || e.conflicto) apply(key, { subido: false, conflicto: false });   // GitHub ya no lo tiene: vuelve a quedar pendiente
      }
    }
    try { await this._local.patchMany(patches); } catch (_) { /* se vuelve a intentar en la próxima consulta */ }
    for (const key of refresh) {
      const r = rmap.get(key);
      try {
        const got = await withTimeout((signal) => this._getSync().archiveGet(key, { sha: r.sha, signal }), this._listTimeoutMs);
        if (got === TIMED_OUT) continue;
        const arc = await decodeArchive(got.bytes);
        const entry = entryFromArchive(arc, got.bytes, got.sha, { subido: true, subidoEn: new Date().toISOString() });
        await this._local.put(key, got.bytes, entry, { replace: true });
        next[key] = entry;
        this._emit('saved', key);
      } catch (_) { /* se queda con la copia de este dispositivo; se reintenta en la próxima consulta */ }
    }
    return next;
  }

  /* ---------------------------------------------------------------- abrir */

  /**
   * Abre el archivo de un mes: de este dispositivo o, si solo está en GitHub, lo descarga y guarda una copia local.
   * @returns {Promise<{meta:object, sheetDatas:object, info:{key:string,label:string,createdAt:string,source:string,resumen:object|null,bytes:number,where:string}}>}
   *   meta/sheetDatas se pasan a createViewerEngine() (o a new Engine(meta, sheetDatas)).
   * @throws {ArchiveError} con mensaje en español (NOT_FOUND, OFFLINE, CORRUPT, NEWER…)
   */
  async open(key, { onProgress, signal } = {}) {
    if (!isValidKey(key)) throw new ArchiveError('BAD_KEY', 'El mes del archivo no es válido.');
    const label = monthLabel(key);
    const prog = (m) => { try { if (onProgress) onProgress({ message: m }); } catch (_) { /* nada */ } };
    let bytes = null, entry = null, arc = null, fromRemote = false, remoteSha = null;
    if (this._local.hasStore()) {
      entry = (await this._local.readIndex())[key] || null;
      bytes = entry ? await this._local.getBytes(key) : null;
      if (bytes) {
        try { arc = await decodeArchive(bytes); }
        catch (e) { if (!(this._syncReady() && !offline())) throw new ArchiveError(e.code || 'CORRUPT', 'La copia de ' + label + ' guardada en este dispositivo está dañada. ' + errText(e)); bytes = null; }
      }
    }
    if (!arc) {
      const sync = this._getSync();
      if (!sync || !sync.isConfigured()) throw new ArchiveError('NOT_FOUND', 'No hay un archivo de ' + label + ' en este dispositivo.');
      if (offline()) throw new ArchiveError('OFFLINE', 'Este archivo solo está en GitHub y ahora no hay conexión a internet. Conéctate e inténtalo de nuevo.');
      prog('Descargando el archivo de ' + label + ' desde GitHub…');
      let got;
      try { got = await sync.archiveGet(key, { signal }); }
      catch (e) { throw new ArchiveError((e && e.code) || 'ERROR', errText(e, 'No se pudo descargar el archivo.'), { cause: e }); }
      bytes = got.bytes; remoteSha = got.sha; fromRemote = true;
      arc = await decodeArchive(bytes);
      if (this._local.hasStore()) {
        try {
          await this._local.put(key, bytes, entryFromArchive(arc, bytes, remoteSha, { subido: true, subidoEn: new Date().toISOString() }), { replace: true });
          this._emit('saved', key);
        } catch (_) { /* si no cabe en este dispositivo, igual se puede mirar */ }
      }
    }
    if (arc.mes !== key) throw new ArchiveError('CORRUPT', 'El archivo no corresponde a ' + label + '.');
    const b = archiveToBundle(arc);
    const where = fromRemote ? 'ambos' : (entry && entry.subido ? 'ambos' : 'local');
    return { ...b, info: { key, label: arc.etiqueta || label, createdAt: arc.creado, source: arc.origen, resumen: arc.resumen || null, bytes: bytes.length, where } };
  }
}

/** Crea el administrador del archivo. deps: {getEngine, getStore, getSync} (funciones o valores). */
export function createArchive(deps) { return new Archive(deps); }

/* ================================================================== pantalla «Archivo» */

const fmtBytes = (n) => (n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
function fmtWhen(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
}
function fmtWhenTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return fmtWhen(iso) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function unavailable(wrap, text) {
  wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Archivo' }), el('p', { class: 'muted', text })));
  return { destroy() { } };
}

/**
 * Pantalla «Archivo». mount(host, ctx, arg, q): sin arg → lista de cierres; con arg 'AAAA-MM' → visor de solo lectura.
 * @returns {{destroy:Function, refresh?:Function}}
 */
export function mount(host, ctx, arg, q) {
  const A = ctx && ctx.archive;
  if (!A) return unavailable(host, 'El archivo mensual no está disponible en esta versión.');
  return arg ? mountViewer(host, ctx, A, arg, q || new URLSearchParams()) : mountList(host, ctx, A);
}

/* ---------------------------------------------------------------- lista */
function mountList(wrap, ctx, A) {
  let dead = false, seq = 0, busy = false;
  const listCard = el('div', { class: 'card arc-card' });
  const actCard = el('div', { class: 'card arc-card' });
  wrap.append(listCard, actCard);
  const body = el('div', { class: 'arc-body', 'aria-live': 'polite' });
  const note = el('p', { class: 'small muted arc-note', role: 'status' });
  listCard.append(el('h2', { text: 'Cierres guardados' }), body, note);

  const btnToday = el('button', { class: 'btn primary arc-btn', type: 'button' });
  const btnClose = el('button', { class: 'btn arc-btn', type: 'button', hidden: true });
  const btnUp = el('button', { class: 'btn arc-btn', type: 'button', hidden: true });
  const help = el('p', { class: 'small muted arc-help', text: 'El archivo guarda una copia de todas tus hojas tal como están hoy (con los valores que ves, sin fórmulas). Se sube a tu repositorio privado de GitHub para poder consultarlo desde el celular o la computadora.' });
  actCard.append(el('h2', { text: 'Guardar un archivo' }), el('div', { class: 'arc-actions' }, btnToday, btnClose, btnUp), help);

  const todayKey = A.keyForToday();
  btnToday.textContent = 'Guardar el estado de hoy como archivo de ' + monthLabel(todayKey);
  const closeKey = A.keyForClose();
  if (closeKey !== todayKey) {
    btnClose.hidden = false;
    btnClose.textContent = 'Guardarlo como archivo de ' + monthLabel(closeKey) + ' (el mes de la hoja de resumen)';
  }
  const emptyText = () => 'Todavía no hay cierres guardados. El primero se crea al cerrar ' + (MONTHS[+(closeKey.slice(5)) - 1] || 'noviembre') + '.';

  const chip = (cls, text) => el('span', { class: 'arc-chip ' + cls, text });
  const whereChip = (it, configured) => {
    if (it.conflict) return chip('warn', 'Distinto al de GitHub');
    if (it.where === 'github' || it.where === 'ambos') return chip('ok', '☁ GitHub');
    if (it.pending && configured) return chip('warn', 'Pendiente de subir');
    return chip('mute', 'Solo en este dispositivo');
  };

  const conflictDialog = (it) => {
    let m = null;
    const act = async (fn) => { if (m) m.close(); await fn(); };
    const choice = (text, cls, fn) => el('button', { class: 'btn arc-btn ' + (cls || ''), type: 'button', text, onclick: () => act(fn) });
    const run = async (choiceKey, msg) => {
      const r = await ctx.busy(msg, () => A.resolveConflict(it.key, choiceKey));
      if (!r.ok) ctx.toast(r.error || 'No se pudo completar.', { type: 'error', ms: 8000 });
      else ctx.toast(r.warning || 'Listo', { type: r.warning ? 'warn' : 'ok' });
      refresh({ remote: true, force: true });
    };
    m = ctx.modal(el('div', { class: 'arc-conflict' },
      el('p', { text: 'Hay dos versiones del archivo de ' + it.label + ': la de este dispositivo (guardada el ' + fmtWhen(it.createdAt) + ') y otra distinta en GitHub, hecha en otro dispositivo. No se sobrescribió ninguna. ¿Cuál quieres conservar?' }),
      choice('Ver la de este dispositivo', '', async () => ctx.navigate('archivo/' + it.key)),
      choice('Usar la de GitHub (descartar la de este dispositivo)', '', () => run('remote', 'Bajando el archivo de GitHub…')),
      choice('Subir la de este dispositivo y reemplazar la de GitHub', 'danger', () => run('local', 'Subiendo el archivo a GitHub…'))),
    { title: 'Dos versiones del mismo mes', sheet: false });
  };

  const row = (it, configured) => {
    const open = () => (it.conflict ? conflictDialog(it) : ctx.navigate('archivo/' + it.key));
    const meta = [];
    if (it.createdAt) meta.push('Guardado el ' + fmtWhen(it.createdAt));
    if (it.bytes != null) meta.push(fmtBytes(it.bytes));
    const sum = [];
    if (it.resumen && typeof it.resumen.disponible === 'number') sum.push(el('span', { class: 'arc-fig', text: 'Disponible ' + money(it.resumen.disponible) }));
    if (it.resumen && typeof it.resumen.patrimonio === 'number') sum.push(el('span', { class: 'arc-fig', text: 'Patrimonio ' + money(it.resumen.patrimonio) }));
    const li = el('li', {
      class: 'arc-item', tabindex: '0', role: 'button', 'data-key': it.key, 'aria-label': 'Abrir el archivo de ' + it.label,
      onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    },
    el('div', { class: 'arc-main' },
      el('div', { class: 'arc-name', text: it.label }),
      meta.length ? el('div', { class: 'arc-meta', text: meta.join(' · ') }) : null,
      sum.length ? el('div', { class: 'arc-sum' }, ...sum) : null,
      el('div', { class: 'arc-chips' }, whereChip(it, configured), it.source ? chip('mute', it.source === 'cierre' ? 'Cierre del mes' : 'Hecho a mano') : null),
      it.uploadError && it.pending ? el('div', { class: 'arc-err', text: 'No se pudo subir: ' + it.uploadError }) : null),
    el('span', { class: 'arc-go', 'aria-hidden': 'true', html: '&rsaquo;' }));
    return li;
  };

  const render = (res, { loadingRemote = false } = {}) => {
    const configured = res.remote.configured;
    body.innerHTML = '';
    if (!res.items.length) {
      if (loadingRemote) body.append(el('div', { class: 'empty' }, el('div', { class: 'spin' }), 'Consultando GitHub…'));      // todavía no se sabe si hay algo en GitHub
      else if (configured && !res.remote.ok) body.append(el('p', { class: 'empty arc-empty', text: 'No hay archivos guardados en este dispositivo.' }));   // GitHub no se pudo consultar: no se afirma que no haya nada
      else body.append(el('p', { class: 'empty arc-empty', text: emptyText() }));
    }
    else { const ul = el('ul', { class: 'arc-list' }); for (const it of res.items) ul.append(row(it, configured)); body.append(ul); }
    note.textContent = loadingRemote ? (res.items.length ? 'Consultando GitHub…' : '') : (res.remote.error ? (res.remote.offline ? res.remote.error : 'No se pudo consultar GitHub: ' + res.remote.error + ' Se muestran los archivos de este dispositivo.') : '');
    note.classList.toggle('arc-warn', !!res.remote.error && !loadingRemote);
    const pend = res.items.filter((i) => i.pending).length;
    btnUp.hidden = !(configured && pend > 0);
    btnUp.textContent = 'Subir pendientes (' + pend + ')';
  };

  async function refresh({ remote = true, force = false } = {}) {
    const my = ++seq;
    try {
      const local = await A.listDetailed({ remote: false });
      if (dead || my !== seq) return;
      render(local, { loadingRemote: remote && local.remote.configured });
      if (!remote) return;
      const full = await A.listDetailed({ remote: true, force });
      if (dead || my !== seq) return;
      render(full);
      if (full.remote.ok && full.items.some((i) => i.pending)) await A.uploadPending();        // lo pendiente se sube solo (el evento 'change' repinta)
    } catch (e) {
      if (!dead) { body.innerHTML = ''; note.textContent = 'No se pudo leer el archivo: ' + errText(e); note.classList.add('arc-warn'); }
    }
  }

  async function doSnapshot(key) {
    if (busy) return;
    busy = true;
    try {
      const label = monthLabel(key);
      let replace = false;
      if (await A.has(key)) {
        const ex = await A.info(key);
        const when = ex && ex.createdAt ? ' (guardado el ' + fmtWhen(ex.createdAt) + ')' : '';
        const ok = await ctx.confirm('Ya existe un archivo de ' + label + when + '. ¿Reemplazarlo con el estado de hoy? No se puede deshacer.', { ok: 'Reemplazar', danger: true, title: 'Reemplazar el archivo' });
        if (!ok) return;
        replace = true;
      }
      const res = await ctx.busy('Guardando el archivo de ' + label + '…', (setText) => A.snapshot({ key, source: 'manual', replace, onProgress: (p) => { if (p && p.message) setText(p.message); } }));
      if (!res.ok) ctx.toast(res.error || 'No se pudo guardar el archivo.', { type: 'error', ms: 9000 });
      else if (res.uploaded) ctx.toast('Archivo de ' + label + ' guardado y subido a GitHub', { type: 'ok' });
      else ctx.toast(res.warning || 'Archivo de ' + label + ' guardado', { type: res.warning ? 'warn' : 'ok', ms: 7000 });
    } catch (e) { ctx.toast('No se pudo guardar el archivo: ' + errText(e), { type: 'error', ms: 9000 }); }
    finally { busy = false; if (!dead) refresh({ remote: true, force: true }); }
  }

  btnToday.addEventListener('click', () => doSnapshot(todayKey));
  btnClose.addEventListener('click', () => doSnapshot(closeKey));
  btnUp.addEventListener('click', async () => {
    const r = await ctx.busy('Subiendo los archivos pendientes…', (setText) => A.uploadPending({ onProgress: (p) => p && p.message && setText(p.message) }));
    if (r.skipped === 'offline') ctx.toast('No hay conexión a internet: se subirán cuando vuelva.', { type: 'warn' });
    else if (r.skipped === 'no-config') ctx.toast('Falta configurar GitHub en Ajustes → Sincronización.', { type: 'warn' });
    else if (r.failed.length) ctx.toast('No se pudo subir: ' + r.failed[0].error, { type: 'error', ms: 9000 });
    else if (r.conflicts.length) ctx.toast('Hay un mes con dos versiones distintas: ábrelo para elegir cuál conservar.', { type: 'warn', ms: 8000 });
    else ctx.toast(r.uploaded.length ? 'Archivos subidos a GitHub' : 'No había nada pendiente', { type: 'ok' });
    refresh({ remote: true, force: true });
  });

  let t = 0;
  const onChange = () => { clearTimeout(t); t = setTimeout(() => { if (!dead) refresh({ remote: false }); }, 80); };
  A.addEventListener('change', onChange);
  body.append(el('div', { class: 'empty' }, el('div', { class: 'spin' }), 'Buscando los archivos…'));
  refresh({ remote: true, force: true });                     // al abrir la pantalla siempre se consulta GitHub de nuevo (sin la caché de 15 s)
  return { destroy() { dead = true; clearTimeout(t); A.removeEventListener('change', onChange); }, refresh() { refresh({ remote: false }); } };
}

/* ---------------------------------------------------------------- visor */
function mountViewer(wrap, ctx, A, key, q) {
  let dead = false, eng = null, grid = null, token = 0;
  const pending = new Set();        // cargas de hoja en curso: el motor no se libera hasta que terminen (soltarlo antes haría fallar la carga)
  const api = {
    destroy() {
      dead = true;
      try { if (grid) grid.destroy(); } catch (_) { /* nada */ }
      grid = null;
      const e = eng; eng = null;
      const release = () => destroyViewerEngine(e);
      if (pending.size) Promise.all([...pending].map((p) => p.catch(() => { }))).then(release, release); else release();
    },
  };
  const label = monthLabel(key);
  const back = () => ctx.navigate('archivo');
  wrap.classList.add('flush');
  if (!isValidKey(key)) { wrap.classList.remove('flush'); unavailable(wrap, 'Ese mes no es válido.'); return api; }
  const loading = el('div', { class: 'empty arc-loading' }, el('div', { class: 'spin' }), el('span', { class: 'arc-loading-t', text: 'Abriendo el archivo de ' + label + '…' }));
  wrap.append(loading);
  document.title = 'Archivo · ' + label + ' · Flujo';

  const showError = (text) => {
    wrap.classList.remove('flush');
    wrap.innerHTML = '';
    wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Archivo · ' + label }), el('p', { class: 'neg', role: 'alert', text }),
      el('div', { class: 'row' }, el('button', { class: 'btn arc-btn', type: 'button', text: '‹ Archivo', onclick: back }))));
  };
  A.open(key, { onProgress: (p) => { if (!dead && p && p.message) { const s = loading.querySelector('.arc-loading-t'); if (s) s.textContent = p.message; } } })
    .then((bundle) => { if (dead) return; loading.remove(); build(bundle); })
    .catch((e) => { if (!dead) showError(errText(e, 'No se pudo abrir el archivo.')); });

  function build(bundle) {
    try { eng = createViewerEngine(bundle); }
    catch (e) { showError('No se pudo preparar el archivo: ' + errText(e)); return; }
    const cat = bundle.meta.catalog || {};
    const shortOf = (sh) => catShort(cat, sh);
    const hiddenOf = (sh) => !!sh.hidden || !!(cat[sh.name] && cat[sh.name].hide);
    const select = el('select', { 'aria-label': 'Cambiar de hoja' });
    const hid = el('optgroup', { label: 'Hojas ocultas' });
    for (const sh of eng.sheets) (hiddenOf(sh) ? hid : select).append(el('option', { value: sh.id, text: shortOf(sh) }));
    if (hid.children.length) select.append(hid);

    const status = el('div', { class: 'arc-status', hidden: true, role: 'status' }, el('div', { class: 'spin' }), 'Cargando la hoja…');
    const gwrap = el('div', { class: 'sheetwrap arc-grid' });
    const btnXlsx = el('button', { class: 'btn arc-btn arc-xlsx', type: 'button', text: 'Descargar Excel (.xlsx)' });
    const info = bundle.info || {};
    const sub = [];
    if (info.createdAt) sub.push('Guardado el ' + fmtWhenTime(info.createdAt));
    if (info.source) sub.push(info.source === 'cierre' ? 'Cierre del mes' : 'Hecho a mano');
    wrap.append(el('div', { class: 'arc-view', role: 'region', 'aria-label': 'Archivo de ' + label + ', solo lectura' },
      el('div', { class: 'arc-bar' }, el('button', { class: 'btn ghost arc-back', type: 'button', text: '‹ Archivo', 'aria-label': 'Volver a la lista de archivos', onclick: back }), select),
      el('div', { class: 'arc-info' },
        el('span', { class: 'arc-title', text: 'Archivo · ' + label }), el('span', { class: 'arc-ro', text: 'Solo lectura' }),
        sub.length ? el('span', { class: 'arc-sub', text: sub.join(' · ') }) : null, btnXlsx),
      status, gwrap));

    grid = new SheetGrid(gwrap, eng, { readOnly: true, onChange() { }, onFind: null, onToast: (m) => ctx.toast(m) });
    grid.setReadOnly(true);

    async function openSheet(sid, first) {
      const my = ++token;
      const e = eng;
      if (!e) return;
      const sh = e.sheet(sid) || e.sheets[0];
      if (!sh.loaded) {                                         // carga por hoja, bajo demanda (ágil en el celular)
        status.hidden = false;
        const p = e.loadSheetAsync(sh.id);
        pending.add(p);
        try { await p; } finally { pending.delete(p); }
        status.hidden = true;
      }
      if (dead || my !== token || !grid) return;
      grid.open(sh.id, { end: !!(cat[sh.name] && cat[sh.name].end) });
      select.value = sh.id;
      if (!first) { try { history.replaceState(null, '', '#/archivo/' + key + '?hoja=' + sh.id); } catch (_) { /* nada */ } }
    }
    const openSafe = (sid, first) => openSheet(sid, first).catch((e) => { if (!dead) { status.hidden = true; ctx.toast('No se pudo abrir la hoja: ' + errText(e), { type: 'error', ms: 8000 }); } });
    select.addEventListener('change', () => openSafe(select.value, false));
    btnXlsx.addEventListener('click', async () => {
      const e = eng;
      if (!e) return;
      try {
        await ctx.busy('Generando el libro de Excel…', async (setText) => {
          const X = await import('./export.js');
          await X.downloadXlsx(e, { filename: 'Flujo_' + monthShort(key) + '.xlsx', onProgress: (p) => { if (p && p.sheet) setText('Hoja ' + (p.done + 1) + ' de ' + p.total + ': ' + String(p.sheet).trim()); } });
        });
        ctx.toast('Excel generado', { type: 'ok' });
      } catch (err) { ctx.toast('No se pudo exportar: ' + ((err && err.message) || 'error desconocido'), { type: 'error', ms: 8000 }); }
    });
    const want = q.get('hoja');
    const first = (want && eng.sheet(want)) || eng.sheets.find((s) => !hiddenOf(s)) || eng.sheets[0];
    openSafe(first.id, true);
  }
  return api;
}
