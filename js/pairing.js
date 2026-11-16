/* pairing.js — «código de conexión»: pasa la conexión con GitHub de un dispositivo a otro SIN crear un token nuevo.
 *
 * El dispositivo que ya está conectado empaqueta usuario, repositorio, rama y token en un texto cifrado (el «código»)
 * y muestra aparte una «clave» corta. La persona se manda el código por WhatsApp o correo, lo pega en el otro dispositivo
 * y escribe la clave que vio en la pantalla del primero. El código solo sirve con la clave; la clave nunca viaja con él.
 *
 *   import { newKey, formatKey, createCode, openCode, codeFromHash, linkFor } from './pairing.js';
 *   const key = newKey();                                          // «K7M2Q9XW4TBZ»  (se muestra con formatKey(key): «K7M2-Q9XW-4TBZ»)
 *   const code = await createCode({ owner, repo, branch, token }, key);      // «FLUJO1.…»
 *   const { owner, repo, branch, token, createdAt } = await openCode(code, 'k7m2 q9xw 4tbz');
 *
 * Sin DOM. Solo WebCrypto (crypto.subtle y crypto.getRandomValues), TextEncoder/TextDecoder y btoa/atob. Lo único que se
 * importa son las expresiones regulares de sync-github.js, para validar con las MISMAS reglas con las que ese módulo
 * acepta la configuración (así lo que se empaqueta aquí siempre lo acepta el dispositivo de destino).
 *
 * FORMATO (versión 1) — todo lo que no es el prefijo va cifrado
 *   código      = "FLUJO1." + base64url( sal ‖ iv ‖ cifrado ‖ etiqueta )
 *                 base64url = alfabeto URL de RFC 4648 §5 (A-Z a-z 0-9 - _) SIN relleno «=»; solo se acepta la forma canónica.
 *   sal         = 16 bytes aleatorios, nuevos en cada código
 *   iv          = 12 bytes aleatorios, nuevos en cada código
 *   cifrado     = AES-256-GCM del texto JSON (UTF-8) {"o":usuario,"r":repositorio,"b":rama,"t":token,"c":fecha ISO de creación}
 *   etiqueta    = 16 bytes de autenticación de GCM (la API web los deja al final del cifrado: «cifrado ‖ etiqueta»)
 *   clave AES   = PBKDF2-HMAC-SHA256( clave de 12 caracteres normalizada, en UTF-8 ; sal ; 600000 iteraciones ) → 256 bits
 *   AAD         = bytes UTF-8 de «flujoweb-pairing-v1» (datos adicionales autenticados: atan el cifrado a esta versión)
 *   clave (la que ve la persona) = 12 caracteres del alfabeto Crockford (0-9 A-Z sin I, L, O, U): 60 bits de entropía,
 *                 se muestra agrupada «XXXX-XXXX-XXXX». Al escribirla se tolera minúscula, espacios, guiones y las
 *                 confusiones I/L→1 y O→0 (ver normalizeKey).
 *
 * Qué protege y qué no: quien solo tenga el código (por ejemplo, alguien que lea el chat) debe adivinar 2^60 claves y cada
 * intento cuesta 600000 rondas de HMAC: inviable. Quien tenga código Y clave obtiene el token: por eso la clave se lee de la
 * pantalla y no se envía por el mismo canal. El token es de GitHub «fine-grained», limitado a UN repositorio, y se corta
 * borrándolo en GitHub. El código NO caduca por sí solo (caduca cuando el token venza o se revoque).
 *
 * Regla de oro de este módulo: ningún mensaje de error, ni nada que se escriba en consola, incluye el token ni la clave
 * (de hecho este módulo no escribe nunca en consola).
 */

import { RE_OWNER, RE_REPO, RE_BRANCH, RE_TOKEN } from './sync-github.js';

export class PairingError extends Error {
  /**
   * @param {'UNSUPPORTED'|'FORMAT'|'KEY'|'INVALID'} code
   *   UNSUPPORTED: el navegador no tiene WebCrypto · FORMAT: no es un código de Flujo (vacío, muy largo, otra versión, cortado)
   *   KEY: la clave no es válida o no corresponde, o el código está alterado/incompleto · INVALID: el contenido no cumple las reglas
   * @param {string} message mensaje en español, claro para una persona no técnica, sin secretos
   */
  constructor(code, message) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

const PREFIX = 'FLUJO1.';
const LINK_MARK = '#conectar=';
const AAD = new TextEncoder().encode('flujoweb-pairing-v1');
const ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_INPUT = 2000;                                   // más que esto no puede ser un código (el real mide unos 320 caracteres)
const KEY_LENGTH = 12;
const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  // Crockford: sin I, L, O, U
const RE_KEY = /^[0-9A-HJKMNP-TV-Z]{12}$/;                // el mismo alfabeto, como expresión regular

const MSG = {
  unsupported: 'Este navegador no permite usar códigos de conexión. Abre Flujo desde su dirección https:// en un navegador actualizado ' +
    '(Chrome, Edge, Firefox o Safari), o conecta con un token de GitHub.',
  empty: 'Falta el código. Pégalo completo en el cuadro «Código».',
  tooLong: 'Lo que pegaste es demasiado largo para ser un código de conexión. Copia solo el código (empieza con FLUJO1.).',
  notFlujo: 'Eso no parece un código de conexión de Flujo: debe empezar con «FLUJO1.». Vuelve a copiarlo desde el otro dispositivo.',
  version: 'Este código es de otra versión de Flujo. Actualiza la app (ábrela con internet) y crea un código nuevo en el otro dispositivo.',
  garbled: 'El código está incompleto o tiene caracteres que no corresponden (¿se cortó al copiarlo?). Vuelve a copiarlo completo.',
  keyFormat: 'La clave no es válida: son 12 letras y números (por ejemplo ABCD-EFGH-JKMN). Revisa lo que escribiste.',
  keyWrong: 'No se pudo abrir el código: la clave no corresponde, o el código está incompleto o fue modificado. ' +
    'Revisa la clave y que hayas pegado el código completo.',
  invalidContent: 'El código se abrió, pero lo que contiene no es válido. Crea un código nuevo en el otro dispositivo.',
  badOwner: 'El usuario (u organización) de GitHub guardado en este dispositivo no es válido: no se puede crear el código.',
  badRepo: 'El nombre del repositorio guardado en este dispositivo no es válido: no se puede crear el código.',
  badBranch: 'El nombre de la rama guardada en este dispositivo no es válido: no se puede crear el código.',
  badToken: 'El token guardado en este dispositivo no es válido o falta: no se puede crear el código. Guarda tu conexión de nuevo.'
};

/* ------------------------------------------------------------------------------------------------ utilidades */

function webcrypto() {
  const c = globalThis.crypto;
  if (!c || !c.subtle || typeof c.getRandomValues !== 'function') throw new PairingError('UNSUPPORTED', MSG.unsupported);
  return c;
}

function toBase64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → bytes. Devuelve null si no es base64url válido (caracteres ajenos o largo imposible). */
function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  let bin;
  try { bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)); } catch (_) { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveAesKey(subtle, normalizedKey, salt, usage) {
  const material = await subtle.importKey('raw', new TextEncoder().encode(normalizedKey), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Mismas reglas que sync-github.js (+ tope de largo). Devuelve el mensaje del primer campo malo, o null si todo está bien. */
function badField(owner, repo, branch, token, messages) {
  if (typeof owner !== 'string' || owner.length > 100 || !RE_OWNER.test(owner)) return messages.owner;
  if (typeof repo !== 'string' || !RE_REPO.test(repo)) return messages.repo;
  if (typeof branch !== 'string' || !RE_BRANCH.test(branch)) return messages.branch;
  if (typeof token !== 'string' || !RE_TOKEN.test(token)) return messages.token;
  return null;
}

const wipe = (bytes) => { try { bytes.fill(0); } catch (_) { /* nada que borrar */ } };

/* ------------------------------------------------------------------------------------------------ clave */

/** Clave nueva de 12 caracteres (alfabeto Crockford), sin sesgo: se descartan los bytes que no caben en un múltiplo exacto del alfabeto. */
export function newKey() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new PairingError('UNSUPPORTED', MSG.unsupported);
  const n = KEY_ALPHABET.length;                    // 32
  const limit = 256 - (256 % n);                    // con 32 símbolos el límite es 256 y nunca se rechaza nada; con otro tamaño sí
  let out = '';
  while (out.length < KEY_LENGTH) {
    const buf = new Uint8Array(KEY_LENGTH * 2);
    c.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < KEY_LENGTH; i++) if (buf[i] < limit) out += KEY_ALPHABET[buf[i] % n];
  }
  return out;
}

/** «K7M2Q9XW4TBZ» → «K7M2-Q9XW-4TBZ» (solo para mostrarla; cualquier otra cosa se devuelve igual). */
export function formatKey(key) {
  const k = normalizeKey(key);
  return k ? k.slice(0, 4) + '-' + k.slice(4, 8) + '-' + k.slice(8) : String(key == null ? '' : key);
}

/**
 * Lo que la persona teclea → clave canónica de 12 caracteres, o '' si no sirve.
 * Mayúsculas; sin espacios, guiones ni caracteres invisibles; I y L pasan a 1; O pasa a 0; cualquier otro carácter fuera
 * del alfabeto (por ejemplo la U) o un largo distinto de 12 → ''.
 */
export function normalizeKey(text) {
  let s = String(text == null ? '' : text).toUpperCase();
  s = s.replace(/[\s\-­​-‍‐-―⁠−﻿]/g, '');
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0');
  return RE_KEY.test(s) ? s : '';
}

/* ------------------------------------------------------------------------------------------------ crear */

/**
 * Empaqueta la conexión en un código cifrado con la clave.
 * @param {{owner:string, repo:string, branch:string, token:string}} cfg
 * @param {string} key clave (newKey() o lo que la persona teclee: se normaliza)
 * @returns {Promise<string>} «FLUJO1.…»
 * @throws {PairingError} INVALID (campos que no cumplen las reglas de sync-github.js), KEY (clave inválida), UNSUPPORTED
 */
export async function createCode(cfg, key) {
  const c = webcrypto();
  const { owner, repo, branch, token } = cfg || {};
  const bad = badField(owner, repo, branch, token, { owner: MSG.badOwner, repo: MSG.badRepo, branch: MSG.badBranch, token: MSG.badToken });
  if (bad) throw new PairingError('INVALID', bad);
  const k = normalizeKey(key);
  if (!k) throw new PairingError('KEY', MSG.keyFormat);

  const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const aes = await deriveAesKey(c.subtle, k, salt, 'encrypt');
  const plain = new TextEncoder().encode(JSON.stringify({ o: owner, r: repo, b: branch, t: token, c: new Date().toISOString() }));
  let sealed;
  try {
    sealed = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD, tagLength: TAG_BYTES * 8 }, aes, plain));
  } finally { wipe(plain); }
  const all = new Uint8Array(SALT_BYTES + IV_BYTES + sealed.length);
  all.set(salt, 0);
  all.set(iv, SALT_BYTES);
  all.set(sealed, SALT_BYTES + IV_BYTES);
  return PREFIX + toBase64url(all);
}

/* ------------------------------------------------------------------------------------------------ abrir */

/** Del texto pegado (código suelto, con comillas, partido en líneas o dentro de un enlace) saca «FLUJO1.…» o lanza FORMAT. */
function extractCode(input) {
  if (typeof input !== 'string') throw new PairingError('FORMAT', MSG.empty);
  if (input.length > MAX_INPUT) throw new PairingError('FORMAT', MSG.tooLong);          // rechazo rápido: sin recorrer el texto
  let s = input;
  const at = s.indexOf(LINK_MARK);
  if (at >= 0) s = s.slice(at + LINK_MARK.length);                                      // enlace completo: lo que sigue a «#conectar=»
  s = s.replace(/[\s​-‍⁠﻿]+/g, '');                                  // espacios, saltos de línea e invisibles (correos que parten líneas)
  const first = s.indexOf(PREFIX);                                                      // palabras delante («Mi código es: FLUJO1.…»): se descartan
  if (first > 0) s = s.slice(first);                                                    // (el cuerpo es base64url: nunca contiene «FLUJO1.», ni el punto)
  s = s.replace(/^[^A-Za-z0-9_-]+/, '').replace(/[^A-Za-z0-9_-]+$/, '');                // comillas, paréntesis, punto final… pegados a los lados
  if (!s) throw new PairingError('FORMAT', MSG.empty);
  if (!s.startsWith(PREFIX)) throw new PairingError('FORMAT', /^FLUJO\d+\./.test(s) ? MSG.version : MSG.notFlujo);
  return s;
}

/**
 * Descifra el código con la clave.
 * @param {string} code el código, o un enlace completo que lo contenga
 * @param {string} key la clave tal como la escribió la persona
 * @returns {Promise<{owner:string, repo:string, branch:string, token:string, createdAt:string}>}
 * @throws {PairingError} FORMAT · KEY · INVALID · UNSUPPORTED (ver el constructor)
 */
async function openText(text, key) {
  const c = webcrypto();
  const body = text.slice(PREFIX.length);
  const bytes = fromBase64url(body);
  if (!bytes || bytes.length < SALT_BYTES + IV_BYTES + TAG_BYTES + 1) throw new PairingError('FORMAT', MSG.garbled);   // cortado de forma evidente
  if (toBase64url(bytes) !== body) throw new PairingError('KEY', MSG.keyWrong);          // forma no canónica: alguien tocó el texto
  const k = normalizeKey(key);
  if (!k) throw new PairingError('KEY', MSG.keyFormat);

  const salt = bytes.slice(0, SALT_BYTES);
  const iv = bytes.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const sealed = bytes.slice(SALT_BYTES + IV_BYTES);
  let plain;
  try {
    const aes = await deriveAesKey(c.subtle, k, salt, 'decrypt');
    plain = new Uint8Array(await c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD, tagLength: TAG_BYTES * 8 }, aes, sealed));
  } catch (_) {
    throw new PairingError('KEY', MSG.keyWrong);                                          // GCM no autentica: clave distinta o código alterado
  }
  let obj;
  try { obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); }
  catch (_) { throw new PairingError('INVALID', MSG.invalidContent); }
  finally { wipe(plain); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new PairingError('INVALID', MSG.invalidContent);
  const { o, r, b, t, c: created } = obj;
  const bad = badField(o, r, b, t, { owner: MSG.invalidContent, repo: MSG.invalidContent, branch: MSG.invalidContent, token: MSG.invalidContent });
  if (bad || typeof created !== 'string' || created.length > 40 || Number.isNaN(Date.parse(created))) throw new PairingError('INVALID', MSG.invalidContent);
  return { owner: o, repo: r, branch: b, token: t, createdAt: new Date(created).toISOString() };     // normalizada: nunca texto libre del código
}

/**
 * Candidatos cuando alguien pega el código JUNTO con otro texto (firma del correo, «Clave: …», «gracias»): prefijos del código
 * formados con los fragmentos separados por espacios, del más largo al más corto, cortando en lo que no sea base64url.
 */
function trimmedCandidates(input) {
  if (typeof input !== 'string' || input.length > MAX_INPUT) return [];
  let s = input;
  const at = s.indexOf(LINK_MARK);
  if (at >= 0) s = s.slice(at + LINK_MARK.length);
  s = s.replace(/[​-‍⁠﻿]+/g, '');
  const first = s.indexOf(PREFIX);
  if (first < 0) return [];
  const frags = s.slice(first).split(/\s+/).filter(Boolean).slice(0, 12);
  const out = [];
  let acc = '';
  for (let i = 0; i < frags.length; i++) {
    const f = frags[i].replace(/[^A-Za-z0-9_-]+$/, '');
    if (i > 0 && !/^[A-Za-z0-9_-]+$/.test(f)) break;              // lo que no es base64url corta el código
    acc += f;
    if (i > 0 || acc.length > PREFIX.length) out.push(acc);
  }
  return [...new Set(out)].reverse().slice(0, 8);
}

/**
 * Descifra el código con la clave.
 * @param {string} code el código, o un enlace completo que lo contenga
 * @param {string} key la clave tal como la escribió la persona
 * @returns {Promise<{owner:string, repo:string, branch:string, token:string, createdAt:string}>}
 * @throws {PairingError} FORMAT · KEY · INVALID · UNSUPPORTED (ver el constructor)
 */
export async function openCode(code, key) {
  const first = extractCode(code);
  try { return await openText(first, key); }
  catch (e) {
    if (!(e instanceof PairingError) || (e.code !== 'KEY' && e.code !== 'FORMAT')) throw e;
    for (const alt of trimmedCandidates(code)) {                  // texto extra pegado después del código
      if (alt === first) continue;
      try { return await openText(alt, key); }
      catch (e2) { if (!(e2 instanceof PairingError) || e2.code === 'INVALID' || e2.code === 'UNSUPPORTED') throw e2; }
    }
    throw e;
  }
}

/* ------------------------------------------------------------------------------------------------ enlaces */

/** '#conectar=<código>' → el código; cualquier otra cosa → null. (Los navegadores no mandan el «#…» a ningún servidor.) */
export function codeFromHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(LINK_MARK)) return null;
  let v = hash.slice(LINK_MARK.length);
  try { v = decodeURIComponent(v); } catch (_) { /* se deja como vino */ }
  v = v.trim();
  if (v.length > MAX_INPUT) return null;                                                  // un fragmento absurdamente largo no puede ser un código
  return v || null;
}

/** Enlace directo para abrir Flujo con el código ya puesto: base + '#conectar=' + código. */
export function linkFor(code, base) {
  return String(base == null ? '' : base).split('#')[0] + LINK_MARK + code;
}
