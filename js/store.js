/* store.js — almacenamiento local (IndexedDB) y guardado automático de FlujoWeb.
 *
 * Base de datos "flujoweb" (versión 1), tres almacenes (claves "fuera de línea", sin keyPath):
 *   meta   → una sola entrada, clave fija 'meta'  (contenido de meta.json)
 *   sheets → clave = id de hoja ("s01"…)          (contenido de sNN.json)
 *   kv     → ajustes y estado de sincronización   (ver KV)
 *
 * Contiene:
 *   - Store      acceso asíncrono a IndexedDB (transacciones atómicas, errores de cuota / modo privado en español).
 *   - AutoSaver  guarda en IndexedDB SOLO las hojas modificadas del Engine (debounce) y registra en kv 'pendingPush'
 *                qué hojas faltan por subir a GitHub (sobrevive al cierre de la app).
 *
 * Notas de diseño (condiciones de carrera):
 *   - Cada escritura de hoja incrementa un contador de revisión local (kv 'rev'). La sincronización lo usa para saber si
 *     una hoja cambió MIENTRAS se subía/bajaba y así no marcarla como sincronizada ni pisarla por error.
 *   - Hoja + pendingPush + rev se escriben en UNA sola transacción: nunca quedan inconsistentes si se cierra la app.
 *   - Dentro de una transacción (store.tx) solo se puede esperar (await) a peticiones de IndexedDB, no a fetch ni timers.
 *
 * El token de GitHub vive únicamente en kv 'github' (lo escribe sync-github.js). exportAll() NUNCA lo incluye.
 */

export const DB_NAME = 'flujoweb';
const DB_VERSION = 1;
const STORE_NAMES = ['meta', 'sheets', 'kv'];

/** Claves del almacén "kv" que usa la sincronización (reservadas: no se exportan ni se restauran como "ajustes"). */
export const KV = Object.freeze({
  GITHUB: 'github',           // {owner, repo, branch, token}
  PENDING: 'pendingPush',     // ['s14', 'meta', …]  hojas modificadas aquí que aún no están en GitHub
  REMOTE_SHAS: 'remoteShas',  // {id: sha git del archivo en GitHub en la última sincronización}
  REV: 'rev',                 // {id: contador de revisión local}
  PENDING_URGENT: 'pendingUrgent', // ids guardados en emergencia (pagehide); foldPending() los integra en pendingPush
  LAST_SYNC: 'lastSync',      // {at, kind, …}
  CONFLICTS: 'syncConflicts', // {id: {id, remoteSha, detectedAt}}
  LAST_ERROR: 'syncLastError' // {code, message, at}
});
const RESERVED_KEYS = new Set(Object.values(KV));

/* ------------------------------------------------------------------ errores */

export class StoreError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Convierte un error de IndexedDB (DOMException…) en un StoreError con mensaje claro en español. */
export function explainStorageError(err, action = 'guardar los datos') {
  if (err instanceof StoreError) return err;
  const name = (err && err.name) || '';
  const text = String((err && err.message) || '');
  if (name === 'QuotaExceededError' || (err && err.code === 22) || /quota/i.test(text)) {
    return new StoreError('QUOTA',
      'No hay espacio suficiente en este dispositivo para ' + action + '. Libera espacio de almacenamiento ' +
      '(o descarga un respaldo y borra datos del navegador que no uses) y vuelve a intentarlo.', err);
  }
  if (name === 'SecurityError') {
    return new StoreError('DENIED',
      'El navegador bloqueó el acceso al almacenamiento local. Revisa que no estén bloqueados los datos/cookies del sitio ' +
      'y que no estés en una ventana privada.', err);
  }
  if (name === 'InvalidStateError') {
    return new StoreError('PRIVATE',
      'No se pudo usar el almacenamiento local. Suele ocurrir en ventanas privadas/incógnito o si el navegador lo tiene ' +
      'desactivado: abre la aplicación en una ventana normal.', err);
  }
  if (name === 'VersionError') {
    return new StoreError('VERSION',
      'La base de datos local es de una versión más nueva que esta aplicación. Actualiza la aplicación (recarga la página).', err);
  }
  if (name === 'DataCloneError') {
    return new StoreError('DATA', 'No se pudo ' + action + ': los datos contienen valores que no se pueden almacenar.', err);
  }
  if (name === 'NotFoundError') {
    return new StoreError('NOT_FOUND', 'La base de datos local está dañada o incompleta. Recarga la página; si persiste, restaura un respaldo.', err);
  }
  if (name === 'AbortError' || name === 'TransactionInactiveError') {
    return new StoreError('ABORTED', 'La operación de almacenamiento local se interrumpió. Inténtalo de nuevo.', err);
  }
  return new StoreError('UNKNOWN', 'No se pudo ' + action + (name ? ' (' + name + ')' : '') + '. Inténtalo de nuevo.', err);
}

/* -------------------------------------------------------------- utilidades IDB */

const rq = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Vista "prometificada" de una transacción: cada método devuelve una promesa ligada a una petición IDB. */
function txApi(tx) {
  const os = (n) => tx.objectStore(n);
  return {
    get: (n, key) => rq(os(n).get(key)),
    put: (n, key, value) => rq(os(n).put(value, key)),
    del: (n, key) => rq(os(n).delete(key)),
    clear: (n) => rq(os(n).clear()),
    keys: (n) => rq(os(n).getAllKeys()),
    all: (n) => rq(os(n).getAll())
  };
}

const lastRev = (revs, id) => (revs && revs[id]) || 0;

/* -------------------------------------------------------------------- Store */

export class Store {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dbName='flujoweb']  nombre de la base (las pruebas usan otros nombres para simular otro dispositivo)
   * @param {boolean} [opts.persist=true]      pedir almacenamiento persistente (navigator.storage.persist) al abrir
   * @param {IDBFactory} [opts.idb]            fábrica de IndexedDB (inyectable en pruebas)
   */
  constructor({ dbName = DB_NAME, persist = true, idb = globalThis.indexedDB } = {}) {
    this.dbName = dbName;
    this.persisted = null;          // null = aún no consultado; true/false según el navegador
    this.persistedPromise = null;
    this._wantPersist = !!persist;
    this._idb = idb || null;
    this._dbh = null;
    this._opening = null;
    this._probed = false;
  }

  /* ---- apertura ---- */

  _open() {
    if (this._dbh) return Promise.resolve(this._dbh);
    if (this._opening) return this._opening;
    const idb = this._idb;
    if (!idb) {
      return Promise.reject(new StoreError('NO_IDB',
        'Este navegador no permite guardar datos locales (IndexedDB no está disponible). Usa un navegador actualizado y fuera del modo privado.'));
    }
    const p = new Promise((resolve, reject) => {
      let req;
      try { req = idb.open(this.dbName, DB_VERSION); }
      catch (e) { reject(explainStorageError(e, 'abrir el almacenamiento local')); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const n of STORE_NAMES) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch (_) { /* ya cerrada */ } if (this._dbh === db) this._dbh = null; };
        db.onclose = () => { if (this._dbh === db) this._dbh = null; };
        this._dbh = db;
        resolve(db);
      };
      req.onerror = () => reject(explainStorageError(req.error, 'abrir el almacenamiento local'));
      req.onblocked = () => reject(new StoreError('BLOCKED',
        'Hay otra pestaña de FlujoWeb abierta con una versión anterior de la base de datos. Ciérrala y vuelve a intentarlo.'));
    });
    this._opening = p.finally(() => { this._opening = null; });
    return this._opening;
  }

  /** Abre la base (la crea si hace falta), comprueba que se puede escribir y pide almacenamiento persistente. */
  async open() {
    await this._open();
    if (!this._probed) {
      // Sondeo de escritura: en ventanas privadas antiguas (Safari/Firefox) abrir funciona pero escribir falla.
      await this.tx(['kv'], 'readwrite', async (t) => {
        await t.put('kv', '__probe', 1);
        await t.del('kv', '__probe');
      }, { action: 'abrir el almacenamiento local' });
      this._probed = true;
    }
    if (this._wantPersist && !this.persistedPromise) this.persistedPromise = this.requestPersistence();
    return this;
  }

  close() {
    if (this._dbh) { try { this._dbh.close(); } catch (_) { /* nada */ } }
    this._dbh = null;
  }

  /** Pide al navegador que no borre estos datos por falta de espacio. Devuelve true/false (nunca lanza). */
  async requestPersistence() {
    try {
      const s = globalThis.navigator && navigator.storage;
      if (!s || !s.persist) return (this.persisted = false);
      if (s.persisted && await s.persisted()) return (this.persisted = true);
      this.persisted = !!(await s.persist());
    } catch (_) { this.persisted = false; }
    return this.persisted;
  }

  /** {usage, quota, persisted} en bytes (0 si el navegador no informa). */
  async estimate() {
    try {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0, persisted: this.persisted };
    } catch (_) { return { usage: 0, quota: 0, persisted: this.persisted }; }
  }

  static deleteDatabase(name, idb = globalThis.indexedDB) {
    return new Promise((resolve, reject) => {
      const r = idb.deleteDatabase(name);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(explainStorageError(r.error, 'borrar la base de datos'));
      r.onblocked = () => resolve(false);
    });
  }

  /* ---- transacciones ---- */

  /**
   * Ejecuta `work(t)` dentro de UNA transacción atómica sobre los almacenes `names`.
   * `t` ofrece: get/put/del/clear/keys/all (promesas). Dentro de `work` solo se debe esperar a esas promesas.
   * Si `work` lanza, la transacción se cancela por completo. Resuelve con lo que devuelva `work` (tras confirmarse).
   * @param {string[]} names @param {'readonly'|'readwrite'} mode @param {(t:object)=>Promise<any>|any} work
   * @param {{durability?:'strict'|'relaxed'|'default', action?:string}} [opts]
   */
  tx(names, mode, work, opts = {}) {
    const exec = (db, canRetry) => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(names, mode, opts.durability ? { durability: opts.durability } : undefined); }
      catch (e) {
        if (canRetry && e && e.name === 'InvalidStateError') {          // conexión cerrada por el navegador: reabrir una vez
          if (this._dbh === db) this._dbh = null;
          this._open().then((d) => exec(d, false)).then(resolve, reject);
          return;
        }
        reject(explainStorageError(e, opts.action));
        return;
      }
      let result;
      let failure = null;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(explainStorageError(failure || tx.error || new DOMException('Transacción cancelada', 'AbortError'), opts.action));
      let p;
      try { p = Promise.resolve(work(txApi(tx))); } catch (e) { p = Promise.reject(e); }
      p.then((r) => { result = r; }, (e) => { failure = e; try { tx.abort(); } catch (_) { /* ya abortada */ } });
    });
    return this._dbh ? exec(this._dbh, true) : this._open().then((db) => exec(db, true));
  }

  /* ---- lectura ---- */

  /** ¿Hay datos de libro guardados localmente? (existe meta) */
  async hasData() {
    const m = await this.tx(['meta'], 'readonly', (t) => t.get('meta', 'meta'), { action: 'leer los datos' });
    return m !== undefined;
  }

  /** @returns {Promise<{meta:object, sheetDatas:Object<string,object>}|null>} null si aún no hay datos. */
  async loadBundle() {
    const r = await this.tx(['meta', 'sheets'], 'readonly', async (t) => {
      const meta = await t.get('meta', 'meta');
      if (!meta) return null;
      const [keys, vals] = await Promise.all([t.keys('sheets'), t.all('sheets')]);
      return { meta, keys, vals };
    }, { action: 'leer los datos' });
    if (!r) return null;
    const sheetDatas = {};
    r.keys.forEach((k, i) => { sheetDatas[k] = r.vals[i]; });
    const missing = (r.meta.sheets || []).map((s) => s.id).filter((id) => !sheetDatas[id]);
    if (missing.length) {
      const e = new StoreError('INCOMPLETE',
        'Los datos locales están incompletos (faltan ' + missing.length + ' hoja(s): ' + missing.slice(0, 5).join(', ') +
        (missing.length > 5 ? '…' : '') + '). Usa «Descargar todo desde GitHub» o restaura un respaldo.');
      e.missing = missing;
      throw e;
    }
    return { meta: r.meta, sheetDatas };
  }

  async getMeta() { return (await this.tx(['meta'], 'readonly', (t) => t.get('meta', 'meta'), { action: 'leer los datos' })) || null; }
  async getSheet(sid) { return (await this.tx(['sheets'], 'readonly', (t) => t.get('sheets', sid), { action: 'leer una hoja' })) || null; }
  async listSheetIds() { return this.tx(['sheets'], 'readonly', (t) => t.keys('sheets'), { action: 'leer los datos' }); }

  /** Hoja o meta junto con su contador de revisión, leídos en la misma transacción (lectura consistente). */
  async getWithRev(id) {
    return this.tx(['meta', 'sheets', 'kv'], 'readonly', async (t) => {
      const [obj, revs] = await Promise.all([
        id === 'meta' ? t.get('meta', 'meta') : t.get('sheets', id),
        t.get('kv', KV.REV)
      ]);
      return { obj: obj === undefined ? null : obj, rev: lastRev(revs, id) };
    }, { action: 'leer los datos' });
  }

  /* ---- escritura ---- */

  /**
   * Escritura atómica de varias cosas a la vez (una sola transacción).
   * @param {object} p
   * @param {object} [p.meta]                 meta.json completo
   * @param {Object<string,object>} [p.sheets] {sid: objeto de hoja}
   * @param {Object<string,any>} [p.kv]       ajustes a escribir
   * @param {string[]} [p.delKv]              ajustes a borrar
   * @param {boolean|string[]} [p.markPending] true = marcar como pendientes de subir todo lo escrito; o lista de ids ('meta' incluido)
   * @param {string[]} [p.unmarkPending]      ids a quitar de pendientes
   * @returns {Promise<string[]>} ids escritos
   */
  async writeBatch({ meta, sheets, kv, delKv, markPending = false, unmarkPending } = {}) {
    const entries = sheets ? Object.entries(sheets) : [];
    const ids = [];
    if (meta) ids.push('meta');
    for (const [sid] of entries) ids.push(sid);
    const pendIds = markPending === true ? ids : (Array.isArray(markPending) ? markPending : []);
    await this.tx(['meta', 'sheets', 'kv'], 'readwrite', async (t) => {
      const puts = [];
      if (meta) puts.push(t.put('meta', 'meta', meta));
      for (const [sid, obj] of entries) puts.push(t.put('sheets', sid, obj));
      if (kv) for (const [k, v] of Object.entries(kv)) puts.push(t.put('kv', k, v));
      if (delKv) for (const k of delKv) puts.push(t.del('kv', k));
      if (ids.length || pendIds.length || (unmarkPending && unmarkPending.length)) {
        const [revs0, pend0, urgent] = await Promise.all([t.get('kv', KV.REV), t.get('kv', KV.PENDING), t.get('kv', KV.PENDING_URGENT)]);
        const revs = { ...(revs0 || {}) };
        for (const id of ids) revs[id] = lastRev(revs, id) + 1;
        const pend = new Set(pend0 || []);
        for (const id of pendIds) pend.add(id);
        if (urgent && urgent.length) {                          // integra lo guardado en emergencia por un pagehide anterior
          for (const id of urgent) { pend.add(id); revs[id] = lastRev(revs, id) + 1; }
          puts.push(t.del('kv', KV.PENDING_URGENT));
        }
        for (const id of unmarkPending || []) pend.delete(id);
        puts.push(t.put('kv', KV.REV, revs), t.put('kv', KV.PENDING, [...pend]));
      }
      await Promise.all(puts);
    }, { durability: 'strict', action: 'guardar los datos' });
    return ids;
  }

  /**
   * Escritura de EMERGENCIA (pagehide / visibilitychange 'hidden'): UNA transacción cuyas escrituras se encolan todas de
   * forma síncrona, sin lecturas ni esperas intermedias. Así el navegador puede confirmarla aunque la página se cierre
   * justo después (una transacción con "leer y luego escribir" se aborta si la página muere entre las dos fases).
   * No actualiza 'pendingPush' ni 'rev' (eso exigiría leer antes): deja los ids en 'pendingUrgent' y foldPending() los integra.
   * @param {{meta?:object, sheets?:Object<string,object>, pendingIds:string[]}} p
   */
  writeUrgent({ meta, sheets, pendingIds }) {
    const entries = sheets ? Object.entries(sheets) : [];
    return this.tx(['meta', 'sheets', 'kv'], 'readwrite', (t) => {
      const puts = [];
      if (meta) puts.push(t.put('meta', 'meta', meta));
      for (const [sid, obj] of entries) puts.push(t.put('sheets', sid, obj));
      puts.push(t.put('kv', KV.PENDING_URGENT, pendingIds));
      return Promise.all(puts);
    }, { durability: 'strict', action: 'guardar los datos' });
  }

  /** Integra 'pendingUrgent' en 'pendingPush' (y sube la revisión de esas hojas). Devuelve true si había algo. */
  async foldPending() {
    const u = await this.getSetting(KV.PENDING_URGENT, null);
    if (!u || !u.length) return false;
    await this.tx(['kv'], 'readwrite', async (t) => {
      const [pend0, urgent, revs0] = await Promise.all([t.get('kv', KV.PENDING), t.get('kv', KV.PENDING_URGENT), t.get('kv', KV.REV)]);
      if (!urgent || !urgent.length) return;
      const pend = new Set(pend0 || []);
      const revs = { ...(revs0 || {}) };
      for (const id of urgent) { pend.add(id); revs[id] = lastRev(revs, id) + 1; }
      await Promise.all([t.put('kv', KV.PENDING, [...pend]), t.put('kv', KV.REV, revs), t.del('kv', KV.PENDING_URGENT)]);
    }, { action: 'guardar los datos' });
    return true;
  }

  /** Guarda una hoja (por omisión la marca como pendiente de subir a GitHub). */
  saveSheet(sid, obj, { markPending = true } = {}) {
    return this.writeBatch({ sheets: { [sid]: obj }, markPending: markPending ? [sid] : false });
  }

  saveMeta(meta, { markPending = true } = {}) {
    return this.writeBatch({ meta, markPending: markPending ? ['meta'] : false });
  }

  /**
   * Valida un respaldo/bundle (texto JSON u objeto) y devuelve {meta, sheetDatas, settings}.
   * Acepta tanto el formato de exportAll() como un bundle simple {meta, sheetDatas}.
   */
  static parseBackup(input) {
    let o = input;
    if (typeof input === 'string') {
      try { o = JSON.parse(input); }
      catch (_) { throw new StoreError('BACKUP_INVALID', 'El archivo no es un respaldo válido de FlujoWeb (no es un JSON legible).'); }
    }
    if (!o || typeof o !== 'object') throw new StoreError('BACKUP_INVALID', 'El archivo no es un respaldo válido de FlujoWeb.');
    const { meta, sheetDatas } = o;
    if (!meta || typeof meta !== 'object' || !Array.isArray(meta.sheets) || !meta.sheets.length) {
      throw new StoreError('BACKUP_INVALID', 'El respaldo no contiene la lista de hojas (meta).');
    }
    if (!sheetDatas || typeof sheetDatas !== 'object') throw new StoreError('BACKUP_INVALID', 'El respaldo no contiene los datos de las hojas.');
    const bad = meta.sheets.filter((s) => !s || !s.id || !sheetDatas[s.id] || !Array.isArray(sheetDatas[s.id].cells)).map((s) => (s && s.name) || (s && s.id) || '?');
    if (bad.length) {
      throw new StoreError('BACKUP_INVALID', 'Al respaldo le faltan o tiene dañadas ' + bad.length + ' hoja(s): ' + bad.slice(0, 5).join(', ') + (bad.length > 5 ? '…' : '') + '.');
    }
    return { meta, sheetDatas, settings: o.settings && typeof o.settings === 'object' ? o.settings : null };
  }

  /**
   * Reemplaza TODOS los datos locales (meta + hojas) en una sola transacción: o queda todo nuevo o todo como estaba.
   * No toca el token ni el estado de sincronización (salvo marcar revisiones nuevas).
   * Después de restaurar un respaldo conviene llamar a GithubSync.rebuildPending().
   * @param {{meta:object, sheetDatas:Object<string,object>}|string} input
   * @param {{markPending?:boolean}} [opts] markPending: marcar todo como pendiente de subir
   */
  async replaceAll(input, { markPending = false } = {}) {
    const { meta, sheetDatas, settings } = Store.parseBackup(input);
    const ids = ['meta', ...Object.keys(sheetDatas)];
    await this.tx(['meta', 'sheets', 'kv'], 'readwrite', async (t) => {
      await Promise.all([t.clear('meta'), t.clear('sheets')]);
      const puts = [t.put('meta', 'meta', meta)];
      for (const [sid, obj] of Object.entries(sheetDatas)) puts.push(t.put('sheets', sid, obj));
      if (settings) for (const [k, v] of Object.entries(settings)) if (!RESERVED_KEYS.has(k) && k[0] !== '_') puts.push(t.put('kv', k, v));
      const [revs0, pend0, urgent] = await Promise.all([t.get('kv', KV.REV), t.get('kv', KV.PENDING), t.get('kv', KV.PENDING_URGENT)]);
      const revs = { ...(revs0 || {}) };
      for (const id of ids) revs[id] = lastRev(revs, id) + 1;
      puts.push(t.put('kv', KV.REV, revs));
      const alive = new Set(ids);
      const pend = new Set([...(pend0 || []), ...(urgent || [])].filter((id) => alive.has(id)));   // pendientes de hojas que ya no existen: fuera
      if (urgent) puts.push(t.del('kv', KV.PENDING_URGENT));
      if (markPending) for (const id of ids) pend.add(id);
      puts.push(t.put('kv', KV.PENDING, [...pend]));
      await Promise.all(puts);
    }, { durability: 'strict', action: 'guardar los datos' });
  }

  /* ---- ajustes (kv) ---- */

  async getSetting(key, def = undefined) {
    const v = await this.tx(['kv'], 'readonly', (t) => t.get('kv', key), { action: 'leer un ajuste' });
    return v === undefined ? def : v;
  }
  async setSetting(key, value) {
    if (value === undefined) return this.delSetting(key);
    await this.tx(['kv'], 'readwrite', (t) => t.put('kv', key, value), { action: 'guardar un ajuste' });
  }
  async delSetting(key) {
    await this.tx(['kv'], 'readwrite', (t) => t.del('kv', key), { action: 'borrar un ajuste' });
  }

  /** Hojas pendientes de subir a GitHub (ids; 'meta' = meta.json). */
  async getPending() { await this.foldPending(); return (await this.getSetting(KV.PENDING, [])) || []; }

  /* ---- respaldo ---- */

  /**
   * Instantánea completa para respaldo: { format, version, exportedAt, meta, sheetDatas, settings }.
   * NO incluye el token ni el estado interno de sincronización. Se puede devolver a replaceAll().
   */
  async exportAll() {
    const snap = await this.tx(['meta', 'sheets', 'kv'], 'readonly', async (t) => {
      const [meta, sk, sv, kk, kvv] = await Promise.all([t.get('meta', 'meta'), t.keys('sheets'), t.all('sheets'), t.keys('kv'), t.all('kv')]);
      return { meta, sk, sv, kk, kvv };
    }, { action: 'leer los datos para el respaldo' });
    const sheetDatas = {};
    snap.sk.forEach((k, i) => { sheetDatas[k] = snap.sv[i]; });
    const settings = {};
    snap.kk.forEach((k, i) => { if (!RESERVED_KEYS.has(k) && k[0] !== '_') settings[k] = snap.kvv[i]; });
    return { app: 'FlujoWeb', format: 'flujoweb-backup', version: 1, exportedAt: new Date().toISOString(), meta: snap.meta || null, sheetDatas, settings };
  }

  /** Borra todos los datos locales. Con keepSettings:true conserva el almacén kv (token, estado de sincronización, ajustes). */
  async clearAll({ keepSettings = false } = {}) {
    await this.tx(['meta', 'sheets', 'kv'], 'readwrite', async (t) => {
      const ops = [t.clear('meta'), t.clear('sheets')];
      if (!keepSettings) ops.push(t.clear('kv'));
      else ops.push(t.put('kv', KV.PENDING, []), t.put('kv', KV.REMOTE_SHAS, {}), t.del('kv', KV.CONFLICTS), t.del('kv', KV.PENDING_URGENT));
      await Promise.all(ops);
    }, { action: 'borrar los datos' });
  }
}

/* ---------------------------------------------------------------- AutoSaver */

/**
 * Guardado automático del Engine en IndexedDB.
 *
 *   const saver = new AutoSaver(engine, store, { onStatus: (st, info) => … });
 *   // tras cada edición:  saver.markDirty();
 *   await saver.flush();   // guardar ya (p. ej. antes de sincronizar)
 *
 * Estados: 'idle' (nada pendiente) · 'pending' (hay cambios, esperando el retardo) · 'saving' · 'saved' · 'error'.
 * También emite el evento DOM 'status' (CustomEvent con detail {status, info}).
 * Guarda solo las hojas de engine.dirty (usando engine.exportSheet) y las marca en kv 'pendingPush'.
 * Si engine.dirty contiene la cadena 'meta' (o se llama markDirty('meta')) también guarda engine.meta.
 */
export class AutoSaver extends EventTarget {
  /**
   * @param {object} engine  {dirty:Set, exportSheet(sid), meta, sheet?(sid)}
   * @param {Store} store
   * @param {{delayMs?:number, maxWaitMs?:number, onStatus?:Function, listen?:boolean, retryDelaysMs?:number[]}} [opts]
   */
  constructor(engine, store, { delayMs = 1500, maxWaitMs = 15000, onStatus = null, listen = true, retryDelaysMs = [3000, 10000, 30000] } = {}) {
    super();
    this.engine = engine;
    this.store = store;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
    this.retryDelaysMs = retryDelaysMs;
    this.onStatus = onStatus;
    this.status = 'idle';
    this.lastSaved = null;     // {sids, meta, at, ms}
    this.lastError = null;
    this._timer = null;
    this._retryTimer = null;
    this._firstDirtyAt = 0;
    this._metaDirty = false;
    this._saving = null;
    this._again = false;
    this._writes = 0;          // escrituras en curso
    this._pendingKey = '';
    this._failures = 0;
    this._disposed = false;
    this._urgentIds = new Set();   // ids ya escritos por la ruta de emergencia (acumulativo hasta el siguiente guardado normal)
    this._listeners = [];
    // Si la sesión anterior terminó con un guardado de emergencia, integra sus marcas de "pendiente de subir".
    try { Promise.resolve(store.foldPending && store.foldPending()).catch(() => {}); } catch (_) { /* nada */ }
    if (listen && typeof document !== 'undefined' && typeof window !== 'undefined') {
      const hide = () => { if (this._hasWork()) this.flush({ urgent: true }).catch(() => {}); };
      const onVis = () => { if (document.visibilityState === 'hidden') hide(); };
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('pagehide', hide);
      window.addEventListener('freeze', hide);
      this._listeners.push(() => document.removeEventListener('visibilitychange', onVis),
        () => window.removeEventListener('pagehide', hide), () => window.removeEventListener('freeze', hide));
    }
    if (this._hasWork()) this._schedule();
  }

  /** Cambia el engine (p. ej. tras reconstruirlo al descargar datos de GitHub). */
  setEngine(engine) { this.engine = engine; if (this._hasWork()) this._schedule(); }

  /** ¿Hay cambios en memoria sin guardar o un guardado en curso? */
  get hasUnsaved() { return this._hasWork() || !!this._saving; }

  _hasWork() { return this._metaDirty || (this.engine && this.engine.dirty && this.engine.dirty.size > 0); }

  _emit(status, info = {}) {
    this.status = status;
    try { if (typeof this.onStatus === 'function') this.onStatus(status, info); } catch (_) { /* un callback ajeno no debe romper el guardado */ }
    try { this.dispatchEvent(new CustomEvent('status', { detail: { status, info } })); } catch (_) { /* sin CustomEvent */ }
  }

  _pendingInfo() {
    const sids = [...(this.engine.dirty || [])].filter((s) => s !== 'meta');
    return { sids, meta: this._metaDirty || (this.engine.dirty && this.engine.dirty.has('meta')) };
  }

  /**
   * Avisar de que hubo una edición. Sin argumentos basta (las hojas están en engine.dirty).
   * @param {string|string[]} [what] id(s) de hoja a añadir a engine.dirty, o 'meta'
   */
  markDirty(what) {
    if (this._disposed) return;
    if (what !== undefined && what !== null) {
      for (const w of [].concat(what)) {
        if (w === 'meta') this._metaDirty = true;
        else if (!this.engine.dirty.has(w)) this.engine.dirty.add(w);
      }
    }
    this._schedule();
  }

  _schedule() {
    if (this._disposed) return;
    const now = Date.now();
    if (!this._firstDirtyAt) this._firstDirtyAt = now;
    if (this._writes === 0) {                       // durante una escritura el estado sigue siendo 'saving'
      const info = this._pendingInfo();
      const key = info.sids.join(',') + '|' + info.meta;
      if (this.status !== 'pending' || key !== this._pendingKey) { this._pendingKey = key; this._emit('pending', { ...info, delayMs: this.delayMs }); }
    }
    clearTimeout(this._timer);
    const wait = Math.max(0, Math.min(this.delayMs, this._firstDirtyAt + this.maxWaitMs - now));
    this._timer = setTimeout(() => { this.flush().catch(() => {}); }, wait);
  }

  /**
   * Guarda ya lo pendiente. Devuelve una promesa que resuelve cuando todo lo editado ANTES de llamar quedó escrito
   * (o rechaza con StoreError si no se pudo; los cambios siguen marcados para reintentar).
   * @param {{urgent?:boolean}} [o] urgent: empieza ya la escritura aunque haya otra en curso (cierre de página)
   */
  flush({ urgent = false } = {}) {
    clearTimeout(this._timer); this._timer = null;
    if (urgent) return this._saveOnce(true);
    if (this._saving) { this._again = true; return this._saving; }
    const run = async () => {
      let out = null;
      do {
        this._again = false;
        out = (await this._saveOnce()) || out;
      } while (this._again);
      return out;
    };
    // (Tras un fallo NO se reprograma aquí: el reintento lo decide _fail(), o la próxima edición con markDirty().
    //  Si se reprogramara en caso de error, un error de cuota produciría un bucle de reintentos inmediatos.)
    this._saving = run().finally(() => { this._saving = null; });
    return this._saving;
  }

  async _saveOnce(urgent = false) {
    const eng = this.engine;
    const all = [...eng.dirty];
    const wantMeta = this._metaDirty || all.includes('meta');
    const sids = all.filter((s) => s !== 'meta');
    if (!sids.length && !wantMeta) {
      this._firstDirtyAt = 0;
      if (this.status === 'pending') this._emit(this.lastSaved ? 'saved' : 'idle', this.lastSaved || {});
      return null;
    }
    const t0 = Date.now();
    this._emit('saving', { sids, meta: wantMeta });
    // Instantánea SÍNCRONA: se vacía `dirty` ahora (las ediciones que lleguen durante la escritura lo vuelven a llenar).
    for (const s of all) eng.dirty.delete(s);
    this._metaDirty = false;
    this._firstDirtyAt = 0;
    const sheets = {};
    const failed = [];
    for (const sid of sids) {
      try { sheets[sid] = eng.exportSheet(sid); }
      catch (e) { failed.push({ sid, error: e }); eng.dirty.add(sid); }
    }
    const saved = Object.keys(sheets);
    let meta = null;
    if (wantMeta) meta = eng.meta;
    this._writes++;
    try {
      if (saved.length || meta) {
        const pend = saved.slice();
        if (meta) pend.push('meta');
        if (urgent) {
          // Ruta de emergencia: una sola transacción de escrituras ciegas, encoladas ya (ver Store.writeUrgent).
          for (const id of pend) this._urgentIds.add(id);
          await this.store.writeUrgent({ meta: meta || undefined, sheets, pendingIds: [...this._urgentIds] });
        } else {
          await this.store.writeBatch({ meta: meta || undefined, sheets, markPending: pend });
          this._urgentIds.clear();                       // writeBatch integró 'pendingUrgent' en 'pendingPush'
        }
      }
    } catch (e) {
      this._writes--;
      for (const s of saved) eng.dirty.add(s);                 // no se perdió nada: vuelve a quedar pendiente
      if (meta) this._metaDirty = true;
      this._fail(e, sids);
      throw e;
    }
    this._writes--;
    if (failed.length) {
      const e = new StoreError('EXPORT', 'No se pudo preparar la hoja «' + failed[0].sid + '» para guardarla: ' + String((failed[0].error && failed[0].error.message) || failed[0].error), failed[0].error);
      this._fail(e, failed.map((f) => f.sid));
      throw e;
    }
    this._failures = 0; this.lastError = null;
    clearTimeout(this._retryTimer); this._retryTimer = null;
    const info = { sids: saved, meta: !!meta, at: new Date(), ms: Date.now() - t0 };
    this.lastSaved = info;
    if (this._hasWork()) this._schedule();                      // hubo ediciones durante la escritura
    else this._emit('saved', info);
    return info;
  }

  _fail(e, sids) {
    this.lastError = e;
    this._failures++;
    this._emit('error', { error: e, code: e && e.code, message: (e && e.message) || String(e), sids });
    const delay = this.retryDelaysMs[this._failures - 1];
    if (delay != null && !(e && e.code === 'QUOTA') && !this._disposed) {
      clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => { this._retryTimer = null; if (this._hasWork()) this.flush().catch(() => {}); }, delay);
    }
  }

  /** Deja de escuchar eventos y cancela temporizadores (no guarda: llama a flush() antes si hace falta). */
  dispose() {
    this._disposed = true;
    clearTimeout(this._timer); clearTimeout(this._retryTimer);
    this._timer = this._retryTimer = null;
    for (const off of this._listeners) { try { off(); } catch (_) { /* nada */ } }
    this._listeners = [];
  }
}
