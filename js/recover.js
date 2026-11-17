/* recover.js — volver a conectar con GitHub si el navegador borra los datos de la app.
 *
 * Por qué existe: la app guarda los datos y el token en el almacenamiento del sitio (IndexedDB). Algunos navegadores, limpiadores
 * o ajustes pueden borrar ese almacenamiento por su cuenta; entonces la app arranca «de cero» y pide el token otra vez. Los datos
 * siguen a salvo en GitHub, pero hace falta reconectar. Este módulo hace que reconectar sea de un clic (o ninguno):
 *
 *   saveToken()   guarda usuario/repositorio y token en el ADMINISTRADOR DE CONTRASEÑAS del navegador (Credential Management API,
 *                 PasswordCredential; Chrome y Edge). Ese almacén es del navegador, NO del sitio: sobrevive aunque se borren los datos
 *                 del sitio. El propio navegador pide permiso a la persona («¿Guardar contraseña?»).
 *   findToken()   lo recupera (con un clic, o sin clic si el navegador lo permite) para reconectar y bajar los datos de GitHub.
 *   storageReport() / describeReport()  resumen de diagnóstico (almacenamiento protegido, bases de datos del sitio…) para mostrar
 *                 en la pantalla de primer uso y entender qué pasó.
 *
 * Nada de esto envía datos a ningún lado: el token solo viaja entre la app y el administrador de contraseñas del propio navegador.
 * Todas las funciones reciben `env` (por omisión globalThis) para poder probarlas con un navegador simulado.
 */
import { RE_OWNER, RE_REPO, RE_TOKEN } from './sync-github.js';

export const CRED_LABEL = 'Flujo: datos en GitHub';

/** ¿Este navegador tiene administrador de contraseñas accesible desde la página (PasswordCredential)? */
export function credentialsSupported(env = globalThis) {
  const n = env.navigator;
  return !!(env.PasswordCredential && n && n.credentials && typeof n.credentials.get === 'function' && typeof n.credentials.store === 'function' && env.isSecureContext !== false);
}

/** «usuario/repositorio» -> {owner, repo}, o null si no es válido (nunca se acepta nada raro venido del almacén). */
export function parseCredId(id) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(id == null ? '' : id));
  return m && RE_OWNER.test(m[1]) && RE_REPO.test(m[2]) ? { owner: m[1], repo: m[2] } : null;
}

/** Guarda la conexión en el administrador de contraseñas. Nunca lanza. -> {saved, reason?: 'unsupported'|'invalid'|'error'} */
export async function saveToken({ owner, repo, token } = {}, env = globalThis) {
  if (!credentialsSupported(env)) return { saved: false, reason: 'unsupported' };
  const o = String(owner || '').trim(), r = String(repo || '').trim(), t = String(token || '').trim();
  if (!parseCredId(o + '/' + r) || !RE_TOKEN.test(t)) return { saved: false, reason: 'invalid' };
  try {
    await env.navigator.credentials.store(new env.PasswordCredential({ id: o + '/' + r, name: CRED_LABEL, password: t }));
    return { saved: true };
  } catch (e) {
    return { saved: false, reason: 'error' };
  }
}

/**
 * Recupera la conexión guardada. silent:true no muestra nada (solo responde si el navegador lo permite); silent:false muestra el
 * selector del navegador y requiere un clic de la persona. Nunca lanza. -> {owner, repo, token} o null
 */
export async function findToken({ silent = false } = {}, env = globalThis) {
  if (!credentialsSupported(env)) return null;
  try {
    const c = await env.navigator.credentials.get({ password: true, mediation: silent ? 'silent' : 'required' });
    if (!c || c.type !== 'password') return null;
    const id = parseCredId(c.id), t = String(c.password || '').trim();
    return id && RE_TOKEN.test(t) ? { owner: id.owner, repo: id.repo, token: t } : null;
  } catch (e) {
    return null;
  }
}

/** Resumen de diagnóstico del almacenamiento del sitio. Nunca lanza; los datos que el navegador no da quedan en null. */
export async function storageReport(env = globalThis) {
  const n = env.navigator || {};
  const out = { secure: env.isSecureContext !== false, persisted: null, usage: null, quota: null, databases: null, serviceWorkers: null, credentials: credentialsSupported(env) };
  try { if (n.storage && typeof n.storage.persisted === 'function') out.persisted = !!(await n.storage.persisted()); } catch (e) { /* sin dato */ }
  try { if (n.storage && typeof n.storage.estimate === 'function') { const e = await n.storage.estimate(); out.usage = Number.isFinite(e.usage) ? e.usage : null; out.quota = Number.isFinite(e.quota) ? e.quota : null; } } catch (e) { /* sin dato */ }
  try { if (env.indexedDB && typeof env.indexedDB.databases === 'function') out.databases = (await env.indexedDB.databases()).map((d) => ({ name: String(d.name), version: d.version })); } catch (e) { /* sin dato */ }
  try { if (n.serviceWorker && typeof n.serviceWorker.getRegistrations === 'function') out.serviceWorkers = (await n.serviceWorker.getRegistrations()).length; } catch (e) { /* sin dato */ }
  return out;
}

const mb = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB');

/** Líneas de texto (español) para mostrar el resumen. */
export function describeReport(r) {
  const yn = (v) => (v === true ? 'sí' : v === false ? 'no' : 'no se sabe');
  const lines = [];
  lines.push('Almacenamiento protegido contra borrado automático: ' + yn(r.persisted));
  lines.push('Espacio usado por este sitio: ' + (r.usage === null ? 'no se sabe' : mb(r.usage)) + (r.quota ? ' de ' + mb(r.quota) : ''));
  lines.push('Bases de datos guardadas por este sitio: ' + (r.databases === null ? 'no se sabe' : r.databases.length ? r.databases.map((d) => d.name + ' (v' + d.version + ')').join(', ') : 'ninguna'));
  lines.push('Administrador de contraseñas del navegador: ' + (r.credentials ? 'disponible' : 'no disponible en este navegador'));
  return lines;
}
