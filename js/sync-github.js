/* sync-github.js — sincronización de FlujoWeb con un repositorio PRIVADO de GitHub (API REST, solo fetch, sin librerías).
 *
 * Diseño del repositorio de datos:   meta.json  +  sheets/sNN.json   (rama main, carpeta raíz)
 * Estado en el Store (kv):  github {owner,repo,branch,token} · pendingPush [ids] · remoteShas {id: sha git} · rev {id: n}
 *                           lastSync · syncConflicts · syncLastError          (ver KV en store.js)
 * "id" = id de hoja ("s14") o 'meta' para meta.json.
 *
 * Reglas de seguridad
 *   - El token solo existe en IndexedDB (kv 'github') y en memoria dentro de un WeakMap privado de este módulo:
 *     no es propiedad del objeto (console.log(sync) no lo muestra), nunca va en URL, ni en mensajes de error, ni en consola.
 *   - Se niega a SUBIR datos a un repositorio público (salvo config.allowPublic = true).
 *
 * Conflictos: un archivo está en conflicto si en GitHub cambió respecto al sha base que guardamos (remoteShas) Y la hoja
 * local también cambió. En ese caso NUNCA se sobrescribe: se devuelve {conflicts:[{sid,name}]} y se resuelve con
 * resolveConflict(sid, 'local' | 'remote').
 */

import { KV } from './store.js';

export const API_VERSION = '2022-11-28';
export const DEFAULT_API_BASE = 'https://api.github.com';
const META_ID = 'meta';
const secrets = new WeakMap();   // instancia → {token}

/* ================================================================ bytes / UTF-8 / base64 / sha */

const _enc = new TextEncoder();
export const utf8Encode = (s) => _enc.encode(s);
/** Decodifica UTF-8 estricto (lanza si hay bytes inválidos). Quita el BOM si lo hubiera. */
export const utf8Decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** Base64 seguro para archivos grandes: por trozos múltiplos de 3 bytes (sin relleno intermedio, sin reventar la pila). */
export function bytesToBase64(bytes) {
  const CH = 3 * 8192;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CH) {
    parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)))));
  }
  return parts.join('');
}

/** Base64 → bytes (tolera saltos de línea, como los que mete GitHub cada 60 caracteres). */
export function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const toHex = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16); return s; };

/** SHA-1 puro en JS (respaldo para contextos no seguros donde no existe crypto.subtle). Devuelve hex. */
export function sha1HexFallback(bytes) {
  const ml = bytes.length;
  const total = ((ml + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(ml / 0x20000000));
  dv.setUint32(total - 4, ((ml % 0x20000000) * 8) >>> 0);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Huella git de un archivo (sha1 de "blob <largo>\0<contenido>"): la misma que GitHub llama sha de un blob. */
export async function gitBlobSha(bytes, { forceFallback = false } = {}) {
  const head = _enc.encode('blob ' + bytes.length + '\0');
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && !forceFallback) {
    try { return toHex(new Uint8Array(await subtle.digest('SHA-1', all))); } catch (_) { /* cae al respaldo */ }
  }
  return sha1HexFallback(all);
}

/** Serialización canónica de un archivo de datos (compacta, sin salto de línea final). */
export const serializeJSON = (obj) => JSON.stringify(obj);

async function encodeFile(obj) {
  const text = serializeJSON(obj);
  const bytes = utf8Encode(text);
  return { text, bytes, sha: await gitBlobSha(bytes) };
}

export const pathFromId = (id) => (id === META_ID ? 'meta.json' : 'sheets/' + id + '.json');
export const idFromPath = (p) => {
  if (p === 'meta.json') return META_ID;
  const m = /^sheets\/([A-Za-z0-9_-]+)\.json$/.exec(p);
  return m ? m[1] : null;
};

/* ================================================================ errores */

export class GithubError extends Error {
  /**
   * @param {string} code  BAD_TOKEN, NOT_FOUND, NO_WRITE, PUBLIC_REPO, NETWORK, RATE_LIMIT, CONFLICT, CORRUPT, …
   * @param {string} message mensaje en español, listo para mostrar al usuario (sin secretos)
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
    this.status = extra.status != null ? extra.status : null;
    this.retryAfterSec = extra.retryAfterSec != null ? extra.retryAfterSec : null;
    this.githubMessage = extra.githubMessage || null;   // texto original de GitHub (inglés), solo para diagnóstico
    this.remoteSha = extra.remoteSha || null;
    this.partial = null;                                // resultado parcial si la operación falló a medias
  }
}

const MSG_PUBLIC = 'El repositorio de datos es PÚBLICO: cualquiera podría leer tus finanzas. Por seguridad no se suben datos a un repositorio público. ' +
  'Hazlo privado en GitHub: repositorio → Settings → General → Danger Zone → Change repository visibility → Make private.';

const RE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
const RE_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const RE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
const RE_TOKEN = /^[\x21-\x7E]{4,255}$/;

function normApiBase(v) {
  const s = String(v || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(s); } catch (_) { throw new GithubError('INVALID_CONFIG', 'La dirección de la API de GitHub no es válida.'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new GithubError('INVALID_CONFIG', 'La dirección de la API debe ser https:// (http:// solo se admite en localhost).');
  }
  // el token solo viaja a GitHub: ningún otro servidor remoto (salvo localhost, para pruebas)
  if (!local && u.hostname !== 'api.github.com') throw new GithubError('INVALID_CONFIG', 'Solo se admite api.github.com (o localhost para pruebas).');
  return s;
}

const sleepRaw = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (ms) => (ms >= 90000 ? Math.round(ms / 60000) + ' min' : Math.max(1, Math.round(ms / 1000)) + ' s');

function orderIds(ids, meta) {
  const order = new Map(((meta && meta.sheets) || []).map((s, i) => [s.id, i + 1]));
  order.set(META_ID, 0);                                  // meta primero: las hojas pueden depender de estilos nuevos
  return [...ids].sort((a, b) => ((order.has(a) ? order.get(a) : 1e6) - (order.has(b) ? order.get(b) : 1e6)) || (a < b ? -1 : a > b ? 1 : 0));
}

async function runPool(items, limit, worker) {
  let next = 0;
  let failure = null;
  const run = async () => {
    while (!failure && next < items.length) {
      const idx = next++;
      try { await worker(items[idx], idx); } catch (e) { failure = failure || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  if (failure) throw failure;
}

/* ================================================================ GithubSync */

export class GithubSync {
  /**
   * @param {import('./store.js').Store} store
   * @param {object} [config]
   * @param {string} [config.owner] usuario u organización
   * @param {string} [config.repo]  nombre del repositorio (p. ej. 'flujo-datos')
   * @param {string} [config.branch='main']
   * @param {string} [config.token] token de acceso fino (Contents: Read and write) — se guarda solo en IndexedDB
   * @param {string} [config.apiBase='https://api.github.com'] (solo pruebas: un servidor local http://127.0.0.1:<puerto>)
   * @param {boolean} [config.allowPublic=false] permitir subir a un repo público (NO recomendado)
   * @param {number} [config.retries=4] @param {number} [config.backoffMs=600] @param {number} [config.putDelayMs=1000]
   * @param {number} [config.timeoutMs=60000] @param {number} [config.concurrency=4] @param {number} [config.maxRateWaitMs=120000]
   */
  constructor(store, config = {}) {
    if (!store) throw new TypeError('GithubSync necesita un Store.');
    this.store = store;
    this._cfg = {
      owner: '', repo: '', branch: 'main', apiBase: DEFAULT_API_BASE, allowPublic: false,
      // putDelayMs: GitHub pide ≥1 s entre escrituras consecutivas para no activar sus límites secundarios
      retries: 4, backoffMs: 600, putDelayMs: 1000, timeoutMs: 60000, concurrency: 4, maxRateWaitMs: 120000
    };
    secrets.set(this, { token: '' });
    this._chain = Promise.resolve();
    this._repoCache = null;
    this.setConfig(config);
  }

  /** Crea la instancia con la configuración guardada en el Store (la que se guardó con saveConfig()). */
  static async fromStore(store, overrides = {}) {
    const saved = (await store.getSetting(KV.GITHUB, null)) || {};
    return new GithubSync(store, { ...saved, ...overrides });
  }

  /* ---- configuración ---- */

  /** Configuración SIN el token: {owner, repo, branch, apiBase, hasToken}. */
  getConfig() {
    const { owner, repo, branch, apiBase } = this._cfg;
    return { owner, repo, branch, apiBase, hasToken: !!secrets.get(this).token };
  }

  /** Cambia la configuración (solo los campos presentes). token: texto = nuevo token, '' = olvidar, undefined/null = no tocar. */
  setConfig(p = {}) {
    const c = this._cfg;
    for (const k of ['owner', 'repo', 'branch']) if (p[k] != null) c[k] = String(p[k]).trim();
    if (!c.branch) c.branch = 'main';
    if (p.apiBase != null) c.apiBase = normApiBase(p.apiBase);
    if (p.allowPublic != null) c.allowPublic = !!p.allowPublic;
    for (const k of ['retries', 'backoffMs', 'putDelayMs', 'timeoutMs', 'concurrency', 'maxRateWaitMs']) {
      if (p[k] != null && Number.isFinite(+p[k])) c[k] = +p[k];
    }
    if (p.token != null) {
      const t = String(p.token).trim();
      if (t && !RE_TOKEN.test(t)) throw new GithubError('INVALID_CONFIG', 'El token tiene caracteres no válidos (revisa que lo copiaste completo, sin espacios ni saltos de línea).');
      if (t && globalThis.isSecureContext === false) throw new GithubError('INSECURE', 'Por seguridad el token solo se acepta en páginas https:// (o localhost).');
      secrets.get(this).token = t;
    }
    this._repoCache = null;
    return this.getConfig();
  }

  isConfigured() {
    const c = this._cfg;
    return !!(c.owner && c.repo && secrets.get(this).token);
  }

  /** Guarda la configuración (incluido el token) en IndexedDB. Si cambió el repositorio, reinicia el estado de sincronización. */
  async saveConfig() {
    const { owner, repo, branch } = this._cfg;
    const token = secrets.get(this).token;
    // Configuración + reinicio del estado de sincronización en UNA transacción: nunca queda "repo nuevo con shas del repo viejo".
    const changedRepo = await this.store.tx(['kv'], 'readwrite', async (t) => {
      const prev = await t.get('kv', KV.GITHUB);
      const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();     // GitHub no distingue mayúsculas
      const changed = !!prev && !(same(prev.owner, owner) && same(prev.repo, repo) && (prev.branch || 'main') === branch);
      const ops = [t.put('kv', KV.GITHUB, { owner, repo, branch, token })];
      if (changed) ops.push(t.put('kv', KV.REMOTE_SHAS, {}), t.del('kv', KV.CONFLICTS), t.del('kv', KV.LAST_SYNC), t.del('kv', KV.LAST_ERROR));
      await Promise.all(ops);
      return changed;
    }, { durability: 'strict', action: 'guardar la configuración' });
    if (changedRepo) await this.rebuildPending();       // repo nuevo: todo lo local se considera pendiente de subir
    this._repoCache = null;
  }

  /** Olvida el token (memoria e IndexedDB); conserva usuario/repositorio/rama. */
  async clearToken() {
    secrets.get(this).token = '';
    const { owner, repo, branch } = this._cfg;
    await this.store.setSetting(KV.GITHUB, { owner, repo, branch, token: '' });
    this._repoCache = null;
  }

  /** Nunca incluye el token (JSON.stringify(sync) es seguro). */
  toJSON() { const { owner, repo, branch } = this._cfg; return { owner, repo, branch, hasToken: !!secrets.get(this).token }; }

  /* ---- utilidades internas ---- */

  _redact(s) {
    const t = secrets.get(this).token;
    return t && t.length >= 4 && typeof s === 'string' ? s.split(t).join('[token]') : s;
  }

  _err(code, message, extra) {
    const e = new GithubError(code, this._redact(message), extra);
    if (e.githubMessage) e.githubMessage = this._redact(e.githubMessage);
    return e;
  }

  _requireConfig() {
    const { owner, repo, branch } = this._cfg;
    if (!owner || !repo || !secrets.get(this).token) throw this._err('NO_CONFIG', 'Falta configurar el usuario, el repositorio y el token de GitHub.');
    if (!RE_OWNER.test(owner)) throw this._err('INVALID_CONFIG', 'El usuario/organización de GitHub no es válido (solo letras, números y guiones).');
    if (!RE_REPO.test(repo)) throw this._err('INVALID_CONFIG', 'El nombre del repositorio no es válido (solo letras, números, puntos, guiones y guiones bajos).');
    if (!RE_BRANCH.test(branch)) throw this._err('INVALID_CONFIG', 'El nombre de la rama no es válido.');
  }

  _repoPath() { return '/repos/' + encodeURIComponent(this._cfg.owner) + '/' + encodeURIComponent(this._cfg.repo); }
  _contentsPath(path) { return this._repoPath() + '/contents/' + path.split('/').map(encodeURIComponent).join('/'); }

  _backoff(attempt) {
    return Math.min(8000, this._cfg.backoffMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
  }

  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(this._err('ABORTED', 'Operación cancelada.')); return; }
      const onAbort = () => { clearTimeout(t); reject(this._err('ABORTED', 'Operación cancelada.')); };
      const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Serializa las operaciones de esta instancia y, si hay Web Locks, también entre pestañas del mismo Store. */
  _locked(fn) {
    const run = () => {
      const locks = globalThis.navigator && navigator.locks;
      if (locks && typeof locks.request === 'function') return locks.request('flujoweb-sync:' + this.store.dbName, { mode: 'exclusive' }, fn);
      return fn();
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  async _tracked(fn) {
    try {
      const r = await fn();
      await this._recordOk(r);
      return r;
    } catch (e) {
      await this._recordError(e);
      throw e;
    }
  }

  async _recordOk(r) {
    if (!r || r.ok === false) return;
    const kind = r.kind;
    try {
      await this.store.tx(['kv'], 'readwrite', (t) => Promise.all([
        t.put('kv', KV.LAST_SYNC, { at: new Date().toISOString(), kind, ...(r.summary || {}) }), t.del('kv', KV.LAST_ERROR)
      ]));
    } catch (_) { /* informativo */ }
  }

  async _recordError(e) {
    if (!e || e.code === 'ABORTED') return;
    try { await this.store.setSetting(KV.LAST_ERROR, { code: e.code || 'ERROR', message: e.message, status: e.status || null, gh: e.githubMessage || null, at: new Date().toISOString() }); } catch (_) { /* informativo */ }
  }

  /* ---- HTTP ---- */

  _headers(token, o) {
    const h = { Authorization: 'Bearer ' + token, Accept: o.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION };
    if (o.body !== undefined) h['Content-Type'] = 'application/json';
    return h;
  }

  /**
   * Una llamada a la API con reintentos (red, 5xx, límites 403/429 con Retry-After). 409/422 NO se reintentan aquí:
   * las decide quien llama (necesitan volver a mirar el sha remoto).
   * @returns {{status:number, headers:Headers, json:any, bytes:Uint8Array|null}}
   */
  async _api(method, path, o = {}) {
    const token = secrets.get(this).token;
    if (!token) throw this._err('NO_CONFIG', 'Falta el token de GitHub.');
    // Plan B para navegadores que rechazan la cabecera Cache-Control de «no-store» en CORS (WebKit/Gecko): ?_=hora evita la caché de 60 s
    const mkUrl = () => {
      const qs = new URLSearchParams({ ...(o.query || {}), ...(this._bust && method === 'GET' ? { _: String(Date.now()) } : {}) }).toString();
      return this._cfg.apiBase + path + (qs ? '?' + qs : '');
    };
    const maxRetries = o.retries != null ? o.retries : this._cfg.retries;
    const as = o.as || 'json';
    let attempt = 0;
    for (;;) {
      if (o.signal && o.signal.aborted) throw this._err('ABORTED', 'Operación cancelada.');
      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, this._cfg.timeoutMs);
      const onAbort = () => ac.abort();
      if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { clearTimeout(timer); if (o.signal) o.signal.removeEventListener('abort', onAbort); };
      let res, data = null, errBody = null;
      try {
        res = await fetch(mkUrl(), {
          method,
          headers: this._headers(token, o),
          body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          ...(this._bust ? {} : { cache: 'no-store' }),   // GitHub responde con max-age=60: sin esto veríamos árboles/shas viejos
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: ac.signal
        });
        if (res.ok) {
          if (as === 'bytes') data = new Uint8Array(await res.arrayBuffer());
          else { const txt = await res.text(); try { data = txt ? JSON.parse(txt) : null; } catch (_) { throw this._err('BAD_RESPONSE', 'GitHub devolvió una respuesta que no se pudo leer.', { status: res.status }); } }
        } else {
          const txt = await res.text();
          try { errBody = txt ? JSON.parse(txt) : null; } catch (_) { errBody = null; }
        }
      } catch (e) {
        cleanup();
        if (o.signal && o.signal.aborted) throw this._err('ABORTED', 'Operación cancelada.');
        if (e instanceof GithubError) throw e;
        if (e instanceof TypeError && !this._bust) { this._bust = true; continue; }       // un único reintento sin la opción no-store
        if (attempt < maxRetries) { attempt++; await this._sleep(this._backoff(attempt), o.signal); continue; }
        throw timedOut
          ? this._err('TIMEOUT', 'GitHub tardó demasiado en responder. Revisa tu conexión e inténtalo de nuevo; tus cambios siguen guardados en este dispositivo.')
          : this._err('NETWORK', 'No se pudo conectar con GitHub (sin internet, o la conexión se cortó). Tus cambios siguen guardados en este dispositivo; inténtalo de nuevo cuando haya conexión.');
      }
      cleanup();
      if (res.ok) return { status: res.status, headers: res.headers, json: as === 'json' ? data : null, bytes: as === 'bytes' ? data : null };

      const st = res.status;
      const gh = errBody && typeof errBody.message === 'string' ? errBody.message : '';
      if (st === 401) {
        throw this._err('BAD_TOKEN', 'GitHub rechazó el token: es inválido, fue revocado o venció. Genera uno nuevo (ver «Cómo crear el token») y pégalo de nuevo.', { status: st, githubMessage: gh });
      }
      const rl = st === 429 || (st === 403 && (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit|abuse|too many/i.test(gh)));
      if (rl) {
        const waitMs = this._retryWaitMs(res);
        if (waitMs <= this._cfg.maxRateWaitMs && attempt < maxRetries) { attempt++; await this._sleep(waitMs + 200, o.signal); continue; }
        throw this._err('RATE_LIMIT', 'GitHub limitó temporalmente las peticiones. Vuelve a intentarlo en ' + wait(waitMs) + '.',
          { status: st, retryAfterSec: Math.ceil(waitMs / 1000), githubMessage: gh });
      }
      if (st >= 500) {
        if (attempt < maxRetries) { attempt++; await this._sleep(this._backoff(attempt), o.signal); continue; }
        throw this._err('SERVER', 'GitHub tuvo un problema temporal (error ' + st + '). Inténtalo de nuevo en unos minutos.', { status: st, githubMessage: gh });
      }
      throw this._httpError(st, gh, res, o.ctx);
    }
  }

  _retryWaitMs(res) {
    const ra = res.headers.get('retry-after');
    if (ra) {
      const n = Number(ra);
      if (Number.isFinite(n)) return Math.max(0, n) * 1000;
      const d = Date.parse(ra);
      if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
    }
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.headers.get('x-ratelimit-remaining') === '0' && reset) return Math.max(1000, reset * 1000 - Date.now());
    return 60000;
  }

  _httpError(st, gh, res, ctx) {
    const extra = { status: st, githubMessage: gh };
    const why = gh ? ' (GitHub dice: «' + gh.replace(/\s+/g, ' ').slice(0, 140) + '»)' : '';     // el texto real de GitHub ayuda a diagnosticar el primer uso
    if (/repository is empty|repo(sitory)? is empty/i.test(gh)) return this._err('EMPTY_REPO', 'El repositorio está vacío (todavía no tiene ningún archivo).', extra);
    switch (st) {
      case 403:
        if (res.headers.get('x-github-sso')) return this._err('SSO', 'La organización dueña del repositorio exige autorizar este token. Genera el token de nuevo eligiendo esa organización como «Resource owner» y pide a un administrador que lo apruebe si hace falta.' + why, extra);
        if (/not accessible|resource not accessible|must have|permission/i.test(gh)) {
          return this._err('NO_PERMISSION', 'El token no tiene permiso suficiente. Debe estar creado para ESTE repositorio con «Contents: Read and write». Genera un token nuevo siguiendo «Cómo crear el token».' + why, extra);
        }
        return this._err('FORBIDDEN', 'GitHub negó el acceso (403). Revisa que el token sea de este repositorio y tenga «Contents: Read and write»; si probaste muchas veces con un token incorrecto, espera unos minutos.' + why, extra);
      case 404:
        if (ctx === 'repo') return this._err('NOT_FOUND', 'No se encontró el repositorio «' + this._cfg.owner + '/' + this._cfg.repo + '», o el token no tiene acceso a él. Revisa el nombre y que el token se creó para ESE repositorio.', extra);
        if (ctx === 'tree' || ctx === 'put') return this._err('BRANCH_MISSING', 'No se encontró la rama «' + this._cfg.branch + '» en el repositorio (o el token no la puede ver). Revisa el nombre de la rama.', extra);
        return this._err('NOT_FOUND', 'GitHub no encontró lo solicitado (404).', extra);
      case 409: return this._err('HTTP_409', 'GitHub rechazó el cambio por un conflicto (409): el archivo cambió mientras se subía.' + why, extra);
      case 422: return this._err('HTTP_422', 'GitHub rechazó la solicitud (422): ' + (/sha/i.test(gh) ? 'falta o no coincide la versión del archivo.' : 'datos no válidos.') + why, extra);
      default: return this._err('HTTP_' + st, 'GitHub respondió con un error inesperado (' + st + ').' + why, extra);
    }
  }

  /** Información del repo (cacheada 15 s): {private, defaultBranch, canPush, fullName}. */
  async _repoInfo({ signal, force = false } = {}) {
    const key = this._cfg.owner + '/' + this._cfg.repo;
    const c = this._repoCache;
    if (!force && c && c.key === key && Date.now() - c.at < 15000) return c.info;
    const r = await this._api('GET', this._repoPath(), { ctx: 'repo', signal });
    const j = r.json || {};
    const perms = j.permissions;
    const info = {
      fullName: j.full_name || key, private: j.private === true, defaultBranch: j.default_branch || 'main',
      canPush: perms ? !!(perms.push || perms.admin || perms.maintain) : null
    };
    this._repoCache = { key, at: Date.now(), info };
    return info;
  }

  /** Exige repo privado y permiso de escritura (antes de subir nada). */
  async _assertWritable({ signal } = {}) {
    const info = await this._repoInfo({ signal, force: true });
    if (info.private !== true && !this._cfg.allowPublic) throw this._err('PUBLIC_REPO', MSG_PUBLIC);
    if (info.canPush === false) throw this._err('NO_WRITE', 'El token no tiene permiso de escritura en este repositorio. Genera uno con «Contents: Read and write».');
    return info;
  }

  /** Árbol recursivo de la rama: {empty, files: Map(id → {path, sha, size}), truncated}. Repo vacío → empty:true. */
  async _getTree({ signal } = {}) {
    try {
      const r = await this._api('GET', this._repoPath() + '/git/trees/' + encodeURIComponent(this._cfg.branch), { query: { recursive: '1' }, ctx: 'tree', signal });
      const j = r.json || {};
      const files = new Map();
      for (const e of j.tree || []) {
        if (e.type !== 'blob') continue;
        const id = idFromPath(e.path);
        if (id) files.set(id, { path: e.path, sha: e.sha, size: e.size });
      }
      return { empty: false, files, truncated: !!j.truncated };
    } catch (e) {
      if (e instanceof GithubError && e.code === 'EMPTY_REPO') return { empty: true, files: new Map(), truncated: false };
      throw e;
    }
  }

  /** Descarga un blob por sha, verifica su huella y lo decodifica como UTF-8. */
  async _getBlobText(id, sha, { signal } = {}) {
    const path = pathFromId(id);
    for (let attempt = 0; ; attempt++) {
      const r = await this._api('GET', this._repoPath() + '/git/blobs/' + encodeURIComponent(sha), { accept: 'application/vnd.github.raw+json', as: 'bytes', ctx: 'blob', signal });
      let bytes = r.bytes;
      let got = await gitBlobSha(bytes);
      if (got !== sha) {                                   // por si el servidor ignoró el tipo "raw" y devolvió el sobre JSON/base64
        try {
          const env = JSON.parse(utf8Decode(bytes));
          if (env && env.encoding === 'base64' && typeof env.content === 'string') { bytes = base64ToBytes(env.content); got = await gitBlobSha(bytes); }
        } catch (_) { /* no era un sobre */ }
      }
      if (got === sha) {
        try { return utf8Decode(bytes); }
        catch (_) { throw this._err('CORRUPT', 'El archivo «' + path + '» de GitHub no es texto UTF-8 válido.'); }
      }
      if (attempt >= 2) throw this._err('CORRUPT', 'El archivo «' + path + '» llegó dañado desde GitHub (la huella no coincide). Inténtalo de nuevo.');
      await this._sleep(this._backoff(attempt + 1), signal);
    }
  }

  _parseRemote(id, text) {
    let obj;
    try { obj = JSON.parse(text); } catch (_) { throw this._err('CORRUPT', 'El archivo «' + pathFromId(id) + '» de GitHub no es un JSON válido.'); }
    const ok = id === META_ID ? obj && typeof obj === 'object' && Array.isArray(obj.sheets) : obj && typeof obj === 'object' && Array.isArray(obj.cells);
    if (!ok) throw this._err('CORRUPT', 'El archivo «' + pathFromId(id) + '» de GitHub no tiene el formato esperado.');
    return obj;
  }

  /* ---- estado local ---- */

  async _loadState() {
    await this.store.foldPending();       // integra un posible guardado de emergencia (pagehide) de la sesión anterior
    return this.store.tx(['kv'], 'readonly', async (t) => {
      const [remoteShas, pending, revs, conflicts, lastSync, lastError] = await Promise.all([
        t.get('kv', KV.REMOTE_SHAS), t.get('kv', KV.PENDING), t.get('kv', KV.REV), t.get('kv', KV.CONFLICTS), t.get('kv', KV.LAST_SYNC), t.get('kv', KV.LAST_ERROR)
      ]);
      return { remoteShas: remoteShas || {}, pending: new Set(pending || []), revs: revs || {}, conflicts: conflicts || {}, lastSync: lastSync || null, lastError: lastError || null };
    });
  }

  async _nameMap() {
    const meta = await this.store.getMeta();
    const m = new Map([[META_ID, 'meta.json']]);
    for (const s of (meta && meta.sheets) || []) m.set(s.id, s.name);
    return m;
  }

  _conflictList(conflicts, names) {
    return Object.values(conflicts || {}).map((c) => ({ sid: c.id, name: (names.get(c.id) || c.id).trim(), remoteSha: c.remoteSha || null, detectedAt: c.detectedAt || null }));
  }

  async _localSha(id) {
    const { obj } = await this.store.getWithRev(id);
    return obj ? (await encodeFile(obj)).sha : null;
  }

  /** Tras subir `id` con éxito: fija el sha base y, si la hoja no cambió mientras se subía, la quita de pendientes. */
  async _markPushed(id, sha, rev) {
    await this.store.tx(['kv'], 'readwrite', async (t) => {
      const [shas0, revs, pend0, conf0] = await Promise.all([t.get('kv', KV.REMOTE_SHAS), t.get('kv', KV.REV), t.get('kv', KV.PENDING), t.get('kv', KV.CONFLICTS)]);
      const shas = { ...(shas0 || {}), [id]: sha };
      const pend = new Set(pend0 || []);
      if (((revs || {})[id] || 0) === rev) pend.delete(id);
      const conf = { ...(conf0 || {}) };
      delete conf[id];
      await Promise.all([t.put('kv', KV.REMOTE_SHAS, shas), t.put('kv', KV.PENDING, [...pend]), t.put('kv', KV.CONFLICTS, conf)]);
    }, { durability: 'strict' });
  }

  async _setBase(id, sha) {
    await this.store.tx(['kv'], 'readwrite', async (t) => {
      const [shas0, conf0] = await Promise.all([t.get('kv', KV.REMOTE_SHAS), t.get('kv', KV.CONFLICTS)]);
      const shas = { ...(shas0 || {}) };
      if (sha) shas[id] = sha; else delete shas[id];
      const conf = { ...(conf0 || {}) };
      delete conf[id];
      await Promise.all([t.put('kv', KV.REMOTE_SHAS, shas), t.put('kv', KV.CONFLICTS, conf)]);
    });
  }

  async _addConflict(id, remoteSha) {
    await this.store.tx(['kv'], 'readwrite', async (t) => {
      const conf = { ...((await t.get('kv', KV.CONFLICTS)) || {}) };
      conf[id] = { id, remoteSha: remoteSha || null, detectedAt: new Date().toISOString() };
      await t.put('kv', KV.CONFLICTS, conf);
    });
  }

  /* ---- API pública ---- */

  /**
   * Comprueba que el token ve el repo, que es PRIVADO y que se puede escribir. Nunca lanza: devuelve el diagnóstico.
   * @returns {Promise<{ok:boolean, code:string, message:string, warnings:string[], checks:{ok:boolean,text:string}[],
   *   repo:object|null, private:boolean|null, public:boolean|null, canWrite:boolean|null, empty:boolean|null, branchExists:boolean|null}>}
   */
  async testConnection({ signal } = {}) {
    const r = { ok: false, code: '', message: '', warnings: [], checks: [], repo: null, private: null, public: null, canWrite: null, empty: null, branchExists: null };
    const check = (ok, text) => r.checks.push({ ok, text });
    try {
      this._requireConfig();
      const { owner, repo, branch } = this._cfg;
      const info = await this._repoInfo({ signal, force: true });
      r.repo = { fullName: info.fullName, private: info.private, defaultBranch: info.defaultBranch };
      r.private = info.private;
      r.public = !info.private;
      check(true, 'El token puede ver el repositorio ' + info.fullName + '.');
      if (info.private) check(true, 'El repositorio es privado.');
      else { check(false, 'El repositorio es PÚBLICO.'); r.warnings.push(MSG_PUBLIC); }

      let canWrite = info.canPush === false ? false : null;      // null = aún sin comprobar de verdad
      let tree = null;
      try { tree = await this._getTree({ signal }); }
      catch (e) {
        if (e instanceof GithubError && (e.code === 'BRANCH_MISSING' || e.code === 'NO_PERMISSION' || e.code === 'FORBIDDEN')) {
          if (e.code === 'BRANCH_MISSING') { r.branchExists = false; r.empty = false; check(false, 'La rama «' + branch + '» no existe.'); r.code = 'BRANCH_MISSING'; r.message = e.message; }
          else { r.code = 'NO_PERMISSION'; r.message = e.message; check(false, 'El token no puede leer el contenido del repositorio.'); }
        } else throw e;
      }
      if (tree) {
        r.empty = tree.empty; r.branchExists = !tree.empty;
        check(true, tree.empty ? 'El repositorio está vacío: listo para la carga inicial.' : 'La rama «' + branch + '» existe y se puede leer.');
        if (!tree.empty && !tree.files.has(META_ID)) r.warnings.push('El repositorio no está vacío pero no contiene meta.json: no parece un repositorio de datos de FlujoWeb.');
        if (tree.empty && info.defaultBranch && info.defaultBranch !== branch) {
          r.code = 'BRANCH_MISSING';
          r.message = 'El repositorio está vacío y su rama por defecto es «' + info.defaultBranch + '»: escribe ese nombre en «Rama».';
        }
      }

      // Prueba de escritura real (la información de permisos del repo no refleja los permisos del token fino): un blob suelto.
      if (canWrite !== false && tree && !tree.empty) {
        try {
          await this._api('POST', this._repoPath() + '/git/blobs', { body: { content: 'flujoweb-probe', encoding: 'utf-8' }, ctx: 'probe', retries: 1, signal });
          canWrite = true;
        } catch (e) {
          if (e instanceof GithubError && (e.code === 'NO_PERMISSION' || e.code === 'FORBIDDEN')) canWrite = false;
          else if (e instanceof GithubError && ['BAD_TOKEN', 'NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'ABORTED'].includes(e.code)) throw e;
          /* otros códigos: la prueba no es concluyente */
        }
      }
      r.canWrite = canWrite;
      if (canWrite === true) check(true, 'El token tiene permiso de escritura (Contents: Read and write).');
      else if (canWrite === false) check(false, 'El token NO tiene permiso de escritura.');
      else check(true, 'El permiso de escritura se confirmará en la primera subida (el repositorio está vacío y no se puede probar antes).');

      if (r.code) { r.ok = false; return r; }
      if (canWrite === false) { r.code = 'NO_WRITE'; r.message = 'El token no tiene permiso de escritura en este repositorio. Genera uno con «Contents: Read and write» (ver «Cómo crear el token»).'; return r; }
      if (!info.private) { r.code = 'PUBLIC_REPO'; r.message = MSG_PUBLIC; return r; }
      r.ok = true; r.code = 'OK';
      r.message = 'Conexión correcta: repositorio privado ' + owner + '/' + repo + ', rama «' + branch + '»' + (r.empty ? ' (vacío: haz la carga inicial)' : '') +
        (canWrite === true ? ', con permiso de escritura.' : '. El permiso de escritura se confirmará al subir.');
      return r;
    } catch (e) {
      const ge = e instanceof GithubError ? e : this._err('ERROR', 'No se pudo comprobar la conexión: ' + (e && e.message ? e.message : 'error desconocido') + '.');
      r.ok = false; r.code = ge.code; r.message = ge.message;
      check(false, ge.message);
      return r;
    }
  }

  /** Cuántas hojas hay pendientes de subir, conflictos, última sincronización y último error. */
  async status() {
    const [st, meta] = await Promise.all([this._loadState(), this.store.getMeta()]);
    const names = new Map([[META_ID, 'meta.json']]);
    for (const s of (meta && meta.sheets) || []) names.set(s.id, s.name);
    const pending = orderIds(st.pending, meta);
    return {
      configured: this.isConfigured(),
      pending,
      pendingCount: pending.length,
      pendingNames: pending.map((id) => (names.get(id) || id).trim()),
      conflicts: this._conflictList(st.conflicts, names),
      lastSync: st.lastSync,
      lastError: st.lastError,
      hasBase: Object.keys(st.remoteShas).length > 0
    };
  }

  async getConflicts() { return (await this.status()).conflicts; }

  /**
   * Baja de GitHub solo lo que cambió (compara los sha del árbol con los guardados). Las hojas con cambios locales que
   * también cambiaron en GitHub NO se tocan: se devuelven como conflictos.
   * @param {{onProgress?:Function, signal?:AbortSignal, timeoutMs?:number, force?:boolean}} [opts]
   *   force: ignora los sha guardados (revisa todo) · timeoutMs: plazo máximo; al vencer se cancela SIN escribir nada (error TIMEOUT)
   * @returns {Promise<{ok:true, empty:boolean, downloaded:string[], adopted:string[], unchanged:number, changed:boolean,
   *   conflicts:{sid:string,name:string}[], warnings:string[], missingRemote:string[]}>}
   */
  pullAll(opts = {}) { return this._locked(() => this._tracked(() => this._guard(opts, (o) => this._pull(o)))); }

  /**
   * Sube cada hoja pendiente con PUT /contents (una por una, meta primero). Si GitHub cambió esa hoja desde nuestra base y
   * la local también cambió, no sobrescribe: la devuelve en conflicts.
   * @returns {Promise<{ok:true, pushed:string[], unchanged:string[], conflicts:{sid:string,name:string}[], skipped:string[], total:number}>}
   */
  pushDirty(opts = {}) { return this._locked(() => this._tracked(() => this._guard(opts, (o) => this._push(o)))); }

  /**
   * Sube meta.json + todas las hojas (repo vacío o sin esas hojas). Si el repo ya tiene archivos DISTINTOS no los pisa y
   * devuelve {ok:false, code:'REMOTE_HAS_DATA', differing} salvo que se pase {overwrite:true}.
   * @param {{meta:object, sheetDatas:object}} [bundle] por omisión, lo guardado en el Store
   */
  initialUpload(bundle, opts = {}) { return this._locked(() => this._tracked(() => this._guard(opts, (o) => this._initial(bundle, o)))); }

  /** Resuelve un conflicto: 'local' = mi versión pisa la de GitHub (y se sube); 'remote' = descarto lo mío y uso la de GitHub. */
  resolveConflict(sid, choice, opts = {}) { return this._locked(() => this._tracked(() => this._guard(opts, (o) => this._resolve(sid, choice, o)))); }

  /**
   * Plazo máximo opcional (opts.timeoutMs) para pullAll/pushDirty/initialUpload/resolveConflict: al vencer se CANCELA la operación
   * (error TIMEOUT) antes de confirmar nada en el Store. Sirve para no dejar una descarga "colgada" que termine de escribir
   * más tarde, cuando la aplicación ya arrancó con los datos anteriores. También acepta opts.signal (AbortSignal propio).
   */
  async _guard(opts, fn) {
    opts = opts || {};
    if (!opts.timeoutMs) return fn(opts);
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, opts.timeoutMs);
    const user = opts.signal;
    const onUser = () => ac.abort();
    if (user) { if (user.aborted) ac.abort(); else user.addEventListener('abort', onUser, { once: true }); }
    try { return await fn({ ...opts, signal: ac.signal }); }
    catch (e) {
      if (timedOut && e instanceof GithubError && e.code === 'ABORTED') {
        throw this._err('TIMEOUT', 'La operación tardó más de ' + Math.max(1, Math.round(opts.timeoutMs / 1000)) + ' s y se canceló. No se cambió nada en este dispositivo.');
      }
      throw e;
    } finally { clearTimeout(timer); if (user) user.removeEventListener('abort', onUser); }
  }

  /** Recalcula qué hojas están realmente pendientes comparando la huella local con la base remota (útil tras restaurar un respaldo). */
  rebuildPending(opts = {}) { return this._locked(() => this._rebuildPending(opts)); }

  /* ---- pull ---- */

  async _pull({ onProgress, signal, force = false } = {}) {
    this._requireConfig();
    const prog = (o) => { try { if (onProgress) onProgress(o); } catch (_) { /* un callback ajeno no debe romper la sincronización */ } };
    const warnings = [];
    prog({ phase: 'tree', done: 0, total: 0, message: 'Consultando GitHub…' });
    const info = await this._repoInfo({ signal, force: true });
    if (info.private !== true) warnings.push(MSG_PUBLIC);     // descargar no se bloquea, pero se avisa
    const tree = await this._getTree({ signal });
    if (tree.truncated) warnings.push('La lista de archivos de GitHub vino truncada: puede faltar alguno.');
    const st = await this._loadState();
    const names = await this._nameMap();
    if (tree.empty) {
      return { ok: true, kind: 'pull', summary: { downloaded: 0, empty: true }, empty: true, downloaded: [], adopted: [], unchanged: 0, changed: false, conflicts: this._conflictList(st.conflicts, names), warnings, missingRemote: [] };
    }

    const have = await this.store.tx(['meta', 'sheets'], 'readonly', async (t) => ({ meta: (await t.get('meta', 'meta')) !== undefined, sheets: new Set(await t.keys('sheets')) }));
    const plan = { download: [], adopt: [], conflict: [], unchanged: 0 };
    for (const [id, f] of tree.files) {
      const base = st.remoteShas[id];
      const haveLocal = id === META_ID ? have.meta : have.sheets.has(id);
      if (!haveLocal) { plan.download.push({ id, sha: f.sha, size: f.size, hadLocal: false }); continue; }
      if (f.sha === base && !(force && !st.pending.has(id))) { plan.unchanged++; continue; }
      if (st.pending.has(id)) {
        const mine = await this._localSha(id);
        if (mine === f.sha) { plan.adopt.push({ id, sha: f.sha }); continue; }                    // misma versión en ambos lados
        if (mine === base) { plan.download.push({ id, sha: f.sha, size: f.size, hadLocal: true }); continue; } // "pendiente" pero sin cambios reales
        plan.conflict.push({ id, remoteSha: f.sha });
        continue;
      }
      plan.download.push({ id, sha: f.sha, size: f.size, hadLocal: true });
    }

    // Descarga (hasta 4 en paralelo). Todo se confirma junto al final: o se aplica un estado remoto consistente o nada.
    const downloaded = [];
    let done = 0;
    const total = plan.download.length;
    prog({ phase: 'download', done: 0, total, message: total ? 'Descargando ' + total + ' archivo(s)…' : 'Todo está al día.' });
    await runPool(plan.download, this._cfg.concurrency, async (item) => {
      const text = await this._getBlobText(item.id, item.sha, { signal });
      const obj = this._parseRemote(item.id, text);
      downloaded.push({ ...item, obj });
      done++;
      prog({ phase: 'download', done, total, id: item.id, name: (names.get(item.id) || item.id).trim(), message: 'Descargado ' + done + ' de ' + total });
    });

    if (signal && signal.aborted) throw this._err('ABORTED', 'Operación cancelada.');       // cancelado antes de confirmar: no se escribe nada
    prog({ phase: 'commit', done: total, total, message: 'Guardando en este dispositivo…' });
    const out = await this.store.tx(['meta', 'sheets', 'kv'], 'readwrite', async (t) => {
      const [shas0, pend0, revs0, conf0] = await Promise.all([t.get('kv', KV.REMOTE_SHAS), t.get('kv', KV.PENDING), t.get('kv', KV.REV), t.get('kv', KV.CONFLICTS)]);
      const shas = { ...(shas0 || {}) };
      const revs = { ...(revs0 || {}) };
      const pend = new Set(pend0 || []);
      const conf = { ...(conf0 || {}) };
      const written = [];
      const late = [];
      const puts = [];
      const now = new Date().toISOString();
      for (const d of downloaded) {
        if (((revs[d.id] || 0) !== (st.revs[d.id] || 0)) && d.hadLocal) { late.push({ id: d.id, remoteSha: d.sha }); continue; }   // se editó mientras se descargaba
        puts.push(d.id === META_ID ? t.put('meta', 'meta', d.obj) : t.put('sheets', d.id, d.obj));
        revs[d.id] = (revs[d.id] || 0) + 1;
        shas[d.id] = d.sha;
        pend.delete(d.id);
        delete conf[d.id];
        written.push(d.id);
      }
      const adopted = [];
      for (const a of plan.adopt) {
        shas[a.id] = a.sha;
        if ((revs[a.id] || 0) === (st.revs[a.id] || 0)) { pend.delete(a.id); adopted.push(a.id); }
        delete conf[a.id];
      }
      for (const c of [...plan.conflict, ...late]) conf[c.id] = { id: c.id, remoteSha: c.remoteSha, detectedAt: (conf[c.id] && conf[c.id].detectedAt) || now };
      for (const id of Object.keys(conf)) if (!pend.has(id)) delete conf[id];       // un conflicto solo tiene sentido para una hoja pendiente
      puts.push(t.put('kv', KV.REMOTE_SHAS, shas), t.put('kv', KV.REV, revs), t.put('kv', KV.PENDING, [...pend]), t.put('kv', KV.CONFLICTS, conf));
      await Promise.all(puts);
      return { written, adopted, conf };
    }, { durability: 'strict', action: 'guardar lo descargado' });

    const names2 = await this._nameMap();
    const meta2 = await this.store.getMeta();
    const missingRemote = ((meta2 && meta2.sheets) || []).filter((s) => !tree.files.has(s.id)).map((s) => s.id);
    if (missingRemote.length) warnings.push('En GitHub faltan ' + missingRemote.length + ' hoja(s) de las que lista meta.json (aún no se han subido): ' + missingRemote.slice(0, 4).map((id) => (names2.get(id) || id).trim()).join(', ') + (missingRemote.length > 4 ? '…' : '') + '.');
    prog({ phase: 'done', done: total, total, message: 'Listo.' });
    return {
      ok: true, kind: 'pull', summary: { downloaded: out.written.length, conflicts: Object.keys(out.conf).length },
      empty: false, downloaded: out.written, adopted: out.adopted, unchanged: plan.unchanged, changed: out.written.length > 0,
      conflicts: this._conflictList(out.conf, names2), warnings, missingRemote
    };
  }

  /* ---- subida de un archivo ---- */

  /**
   * PUT /contents con control de sha. Ante 409/422 vuelve a mirar el sha remoto: si es el mismo que enviamos es una carrera
   * pasajera (reintenta con backoff); si cambió de verdad, lanza CONFLICT (no sobrescribe).
   * @param {string} id @param {{bytes:Uint8Array, sha:string}} enc @param {{sha?:string, empty?:boolean, message:string, info:object, signal?:AbortSignal}} o
   */
  async _putFile(id, enc, { sha, empty, message, info, signal }) {
    const path = pathFromId(id);
    const b64 = bytesToBase64(enc.bytes);
    let sent = sha || null;
    for (let attempt = 0; ; attempt++) {
      const body = { message, content: b64 };
      if (sent) body.sha = sent;
      if (!(empty && info && info.defaultBranch === this._cfg.branch)) body.branch = this._cfg.branch;   // repo vacío: el 1.er commit crea la rama por omisión
      if (empty) this._branchBornAt = Date.now();
      try {
        const r = await this._api('PUT', this._contentsPath(path), { body, ctx: 'put', signal });
        const j = r.json || {};
        const newSha = j.content && j.content.sha;
        if (!newSha) throw this._err('BAD_RESPONSE', 'GitHub no confirmó el archivo subido (' + path + ').');
        if (newSha !== enc.sha) throw this._err('CORRUPT', 'GitHub guardó «' + path + '» con una huella distinta a la enviada (posible corrupción). Vuelve a intentarlo.');
        return { sha: newSha, commit: j.commit && j.commit.sha, created: r.status === 201 };
      } catch (e) {
        // 404 pasajero justo después de que el primer commit creó la rama: se espera y se reintenta
        if (e instanceof GithubError && e.status === 404 && this._branchBornAt && Date.now() - this._branchBornAt < 30000 && attempt < 3) { await this._sleep(this._backoff(attempt + 1), signal); continue; }
        if (!(e instanceof GithubError) || (e.status !== 409 && e.status !== 422)) throw e;
        if (attempt >= 3) throw this._err('REJECTED', 'GitHub no aceptó la subida de «' + path + '» tras varios intentos (error ' + e.status + '). Inténtalo de nuevo en unos minutos.' + (e.githubMessage ? ' [' + String(e.githubMessage).slice(0, 120) + ']' : ''), { status: e.status, githubMessage: e.githubMessage });
        const fresh = await this._getTree({ signal });
        const cur = fresh.files.get(id);
        if (cur && cur.sha === enc.sha) return { sha: cur.sha, commit: null, created: false, adopted: true };   // ya está igual en GitHub
        if (!cur) { sent = null; continue; }                                                                    // el archivo desapareció: crear
        if (cur.sha === sent) { await this._sleep(this._backoff(attempt + 1), signal); continue; }              // carrera pasajera: reintentar
        throw this._err('CONFLICT', '«' + path + '» cambió en GitHub desde la última sincronización.', { status: e.status, remoteSha: cur.sha });
      }
    }
  }

  /* ---- push ---- */

  async _push({ onProgress, signal, only } = {}) {
    this._requireConfig();
    const prog = (o) => { try { if (onProgress) onProgress(o); } catch (_) { /* ver _pull */ } };
    const info = await this._assertWritable({ signal });
    const st = await this._loadState();
    const meta = await this.store.getMeta();
    const names = await this._nameMap();
    const result = { ok: true, kind: 'push', pushed: [], unchanged: [], conflicts: [], skipped: [], total: 0 };
    let ids = orderIds(st.pending, meta);
    if (only) ids = ids.filter((i) => only.includes(i));
    const known = [];
    ids = ids.filter((id) => { if (st.conflicts[id]) { known.push(id); return false; } return true; });
    result.skipped.push(...known);                       // conflictos sin resolver: no se tocan
    result.total = ids.length;
    if (!ids.length) { result.conflicts = this._conflictList(st.conflicts, names); result.summary = { pushed: 0 }; return result; }

    prog({ phase: 'tree', done: 0, total: ids.length, message: 'Consultando GitHub…' });
    const tree = await this._getTree({ signal });
    let empty = tree.empty;
    const iso = new Date().toISOString();
    try {
      for (let i = 0; i < ids.length; i++) {
        if (signal && signal.aborted) throw this._err('ABORTED', 'Operación cancelada.');
        const id = ids[i];
        const name = (names.get(id) || id).trim();
        prog({ phase: 'upload', done: i, total: ids.length, id, name, message: 'Subiendo ' + (i + 1) + ' de ' + ids.length + ': ' + name });
        const local = await this.store.getWithRev(id);
        if (!local.obj) { await this.store.writeBatch({ unmarkPending: [id] }); result.skipped.push(id); continue; }   // pendiente de una hoja que ya no existe
        const enc = await encodeFile(local.obj);
        const remote = tree.files.get(id);
        const base = st.remoteShas[id];
        if (remote && remote.sha === enc.sha) { await this._markPushed(id, enc.sha, local.rev); result.unchanged.push(id); continue; }   // ya idéntico
        if (remote && remote.sha !== base) { await this._addConflict(id, remote.sha); result.conflicts.push(id); continue; }              // cambió en GitHub y aquí
        let out;
        try {
          out = await this._putFile(id, enc, { sha: remote ? remote.sha : undefined, empty, message: 'Flujo: ' + name + ' · ' + iso, info, signal });
        } catch (e) {
          if (e instanceof GithubError && e.code === 'CONFLICT') { await this._addConflict(id, e.remoteSha); result.conflicts.push(id); continue; }
          throw e;
        }
        empty = false;
        await this._markPushed(id, out.sha, local.rev);
        (out.adopted ? result.unchanged : result.pushed).push(id);
        if (i < ids.length - 1 && this._cfg.putDelayMs > 0) await this._sleep(this._cfg.putDelayMs, signal);
      }
    } catch (e) {
      if (e instanceof GithubError) e.partial = { pushed: result.pushed.slice(), unchanged: result.unchanged.slice(), conflicts: result.conflicts.slice() };
      throw e;
    }
    const st2 = await this._loadState();
    result.conflicts = this._conflictList(st2.conflicts, await this._nameMap());
    result.summary = { pushed: result.pushed.length, conflicts: result.conflicts.length };
    prog({ phase: 'done', done: ids.length, total: ids.length, message: 'Listo.' });
    return result;
  }

  /* ---- carga inicial ---- */

  async _initial(bundle, { onProgress, signal, overwrite = false } = {}) {
    this._requireConfig();
    const prog = (o) => { try { if (onProgress) onProgress(o); } catch (_) { /* ver _pull */ } };
    const info = await this._assertWritable({ signal });
    if (!bundle) bundle = await this.store.loadBundle();
    if (!bundle || !bundle.meta || !Array.isArray(bundle.meta.sheets)) throw this._err('NO_DATA', 'No hay datos locales para subir.');
    const { meta, sheetDatas } = bundle;
    const list = [{ id: META_ID, obj: meta, name: 'meta.json' }];
    for (const s of meta.sheets) {
      const obj = sheetDatas && sheetDatas[s.id];
      if (!obj) throw this._err('NO_DATA', 'Falta la hoja «' + s.name + '» en los datos que se van a subir.');
      list.push({ id: s.id, obj, name: String(s.name).trim() });
    }
    prog({ phase: 'tree', done: 0, total: list.length, message: 'Consultando GitHub…' });
    const tree = await this._getTree({ signal });
    for (const f of list) {
      Object.assign(f, await encodeFile(f.obj));
      const r = tree.files.get(f.id);
      f.remoteSha = r ? r.sha : null;
    }
    const same = list.filter((f) => f.remoteSha === f.sha);
    const differing = list.filter((f) => f.remoteSha && f.remoteSha !== f.sha);
    if (differing.length && !overwrite) {
      return {
        ok: false, code: 'REMOTE_HAS_DATA', uploaded: [], unchanged: same.map((f) => f.id), conflicts: [],
        differing: differing.map((f) => ({ sid: f.id, name: f.name })),
        message: 'El repositorio ya contiene ' + differing.length + ' archivo(s) distintos a los de este dispositivo. No se sobrescribió nada.'
      };
    }
    const todo = list.filter((f) => f.remoteSha !== f.sha);
    const iso = new Date().toISOString();
    const uploaded = [];
    let empty = tree.empty;
    try {
      for (let i = 0; i < todo.length; i++) {
        if (signal && signal.aborted) throw this._err('ABORTED', 'Operación cancelada.');
        const f = todo[i];
        prog({ phase: 'upload', done: i, total: todo.length, id: f.id, name: f.name, message: 'Subiendo ' + (i + 1) + ' de ' + todo.length + ': ' + f.name });
        const out = await this._putFile(f.id, f, { sha: f.remoteSha || undefined, empty, message: 'Flujo: carga inicial (' + f.name + ') · ' + iso, info, signal });
        empty = false;
        await this._setBase(f.id, out.sha);
        uploaded.push(f.id);
        if (i < todo.length - 1 && this._cfg.putDelayMs > 0) await this._sleep(this._cfg.putDelayMs, signal);
      }
    } catch (e) {
      if (e instanceof GithubError) e.partial = { uploaded: uploaded.slice() };
      throw e;
    }
    for (const f of same) await this._setBase(f.id, f.sha);
    await this._rebuildPending({ ids: list.map((f) => f.id) });
    prog({ phase: 'done', done: todo.length, total: todo.length, message: 'Listo.' });
    return { ok: true, kind: 'initial', summary: { uploaded: uploaded.length }, uploaded, unchanged: same.map((f) => f.id), conflicts: [], total: list.length };
  }

  /* ---- conflictos ---- */

  async _resolve(sid, choice, { onProgress, signal, push = true } = {}) {
    if (choice !== 'local' && choice !== 'remote') throw new TypeError("resolveConflict: la opción debe ser 'local' o 'remote'.");
    this._requireConfig();
    const names = await this._nameMap();
    const tree = await this._getTree({ signal });
    const remote = tree.files.get(sid);
    if (choice === 'remote') {
      if (!remote) throw this._err('NOT_FOUND', 'La hoja «' + (names.get(sid) || sid).trim() + '» ya no existe en GitHub: no hay versión remota que usar.');
      const text = await this._getBlobText(sid, remote.sha, { signal });
      const obj = this._parseRemote(sid, text);
      await this.store.tx(['meta', 'sheets', 'kv'], 'readwrite', async (t) => {
        const [shas0, pend0, revs0, conf0] = await Promise.all([t.get('kv', KV.REMOTE_SHAS), t.get('kv', KV.PENDING), t.get('kv', KV.REV), t.get('kv', KV.CONFLICTS)]);
        const shas = { ...(shas0 || {}), [sid]: remote.sha };
        const revs = { ...(revs0 || {}), [sid]: (((revs0 || {})[sid]) || 0) + 1 };
        const pend = new Set(pend0 || []); pend.delete(sid);
        const conf = { ...(conf0 || {}) }; delete conf[sid];
        await Promise.all([
          sid === META_ID ? t.put('meta', 'meta', obj) : t.put('sheets', sid, obj),
          t.put('kv', KV.REMOTE_SHAS, shas), t.put('kv', KV.REV, revs), t.put('kv', KV.PENDING, [...pend]), t.put('kv', KV.CONFLICTS, conf)
        ]);
      }, { durability: 'strict', action: 'guardar lo descargado' });
      return { ok: true, kind: 'resolve', summary: { choice }, sid, choice, replaced: true, pushed: null };
    }
    // 'local': la base pasa a ser la versión actual de GitHub y se mantiene pendiente → al subir pisa la remota.
    await this.store.tx(['kv'], 'readwrite', async (t) => {
      const [shas0, pend0, conf0] = await Promise.all([t.get('kv', KV.REMOTE_SHAS), t.get('kv', KV.PENDING), t.get('kv', KV.CONFLICTS)]);
      const shas = { ...(shas0 || {}) };
      if (remote) shas[sid] = remote.sha; else delete shas[sid];
      const pend = new Set(pend0 || []); pend.add(sid);
      const conf = { ...(conf0 || {}) }; delete conf[sid];
      await Promise.all([t.put('kv', KV.REMOTE_SHAS, shas), t.put('kv', KV.PENDING, [...pend]), t.put('kv', KV.CONFLICTS, conf)]);
    });
    const pushed = push ? await this._push({ onProgress, signal, only: [sid] }) : null;
    return { ok: true, kind: 'resolve', summary: { choice }, sid, choice, replaced: false, pushed };
  }

  /* ---- recalcular pendientes ---- */

  async _rebuildPending({ ids } = {}) {
    await this.store.foldPending();
    const snap = await this.store.tx(['meta', 'sheets', 'kv'], 'readonly', async (t) => {
      const [meta, keys, vals, shas, revs] = await Promise.all([t.get('meta', 'meta'), t.keys('sheets'), t.all('sheets'), t.get('kv', KV.REMOTE_SHAS), t.get('kv', KV.REV)]);
      return { meta, keys, vals, shas: shas || {}, revs: revs || {} };
    });
    const local = new Map();
    if (snap.meta) local.set(META_ID, snap.meta);
    snap.keys.forEach((k, i) => local.set(k, snap.vals[i]));
    const targets = ids ? ids.filter((id) => local.has(id)) : [...local.keys()];
    const want = new Map();
    for (const id of targets) want.set(id, (await encodeFile(local.get(id))).sha !== snap.shas[id]);   // fuera de la transacción (hash asíncrono)
    const pend = await this.store.tx(['kv'], 'readwrite', async (t) => {
      const [revs, pend0, conf0] = await Promise.all([t.get('kv', KV.REV), t.get('kv', KV.PENDING), t.get('kv', KV.CONFLICTS)]);
      const pend = new Set(pend0 || []);
      for (const id of targets) {
        if (((revs || {})[id] || 0) !== (snap.revs[id] || 0)) continue;       // cambió mientras calculábamos: no tocar
        if (want.get(id)) pend.add(id); else pend.delete(id);
      }
      if (!ids) for (const id of [...pend]) if (!local.has(id)) pend.delete(id);   // pendientes de hojas que ya no existen
      const conf = { ...(conf0 || {}) };
      for (const id of Object.keys(conf)) if (!pend.has(id)) delete conf[id];      // un conflicto solo tiene sentido para una hoja pendiente
      await Promise.all([t.put('kv', KV.PENDING, [...pend]), t.put('kv', KV.CONFLICTS, conf)]);
      return [...pend];
    });
    return { ok: true, pending: pend };
  }
}
