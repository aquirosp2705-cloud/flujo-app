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
  if (typeof code === 'string' && code.length <= MAX_INPUT && code.includes(PREFIX2)) {          // pegaron el acceso de la clave única
    const RE2 = /FLUJO2\.[A-Za-z0-9_-]+/;
    const cands = [];
    const word = code.split(/\s+/).find((w) => w.includes(PREFIX2));                      // el acceso suelto, con texto alrededor
    const m1 = word && RE2.exec(word);
    if (m1) cands.push(m1[0]);
    const m2 = RE2.exec(code.replace(/[\s​-‍⁠﻿]+/g, ''));              // partido en varias líneas
    if (m2 && !cands.includes(m2[0])) cands.push(m2[0]);
    let last = new PairingError('FORMAT', MSG2.garbled);
    for (const c of cands) {
      try { return await openPersonalCode(c, key); }
      catch (e) { if (!(e instanceof PairingError) || (e.code !== 'FORMAT' && e.code !== 'KEY')) throw e; if (e.code === 'KEY' || last.code !== 'KEY') last = e; }
    }
    throw last;
  }
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

/* ------------------------------------------------------------------------------------------------ clave única (v22) */
/*
 * «Clave única»: la persona elige UNA clave y la escribe una vez en un dispositivo conectado; con ella se cifra la conexión
 * y el resultado («FLUJO2.…») se publica con la app en acceso.json. En cualquier otro dispositivo basta escribir esa clave.
 * Como acceso.json es PÚBLICO, la clave elegida debe ser larga (passwordProblem) y la derivación es más cara que la del
 * código de conexión (2 000 000 rondas, guardadas en el propio código para poder subirlas en el futuro).
 *
 *   código2 = "FLUJO2." + base64url( iteraciones (4 bytes, big-endian) ‖ sal (16) ‖ iv (12) ‖ cifrado ‖ etiqueta (16) )
 *   clave AES = PBKDF2-HMAC-SHA256( normalizePassword(clave), sal, iteraciones ) → 256 bits ; AES-256-GCM
 *   AAD = «flujoweb-clave-unica-v2» ‖ iteraciones (4 bytes)        contenido: el mismo JSON {o, r, b, t, c} que FLUJO1
 *   acceso.json = {"formato":"flujo-acceso-1","creado":ISO,"codigo":"FLUJO2.…"}
 */
const PREFIX2 = 'FLUJO2.';
const AAD2 = new TextEncoder().encode('flujoweb-clave-unica-v2');
export const PERSONAL_ITERATIONS = 2000000;
const ITER2_MIN = 600000, ITER2_MAX = 10000000;
export const PASSWORD_MIN = 16;            // con al menos 3 palabras; una sola «palabra» necesita PASSWORD_ONE_WORD
const PASSWORD_MAX = 128;
export const PASSWORD_ONE_WORD = 20;
export const ACCESS_FORMAT = 'flujo-acceso-1';

const MSG2 = {
  empty: 'Escribe tu clave.',
  wrong: 'Esa no es tu clave. Revísala (no importan mayúsculas, tildes ni espacios) y vuelve a intentarlo.',
  garbled: 'El acceso publicado está dañado. Créalo de nuevo en el dispositivo donde ya usas Flujo.',
  short: 'Muy corta: usa al menos ' + PASSWORD_MIN + ' letras o números. Lo mejor es una frase de 3 o 4 palabras que no tenga que ver contigo.',
  long: 'Muy larga: usa como máximo ' + PASSWORD_MAX + ' caracteres.',
  digits: 'Solo números es fácil de adivinar: usa palabras (por ejemplo una frase de 3 o 4 palabras).',
  weak: 'Es demasiado fácil de adivinar (repite o sigue en orden los mismos caracteres). Usa una frase de 3 o 4 palabras.',
  words: 'Usa al menos 3 palabras separadas por espacios (o 20 letras seguidas). Lo mejor: 4 palabras sin relación entre sí, que no tengan que ver contigo.',
  common: 'Es demasiado fácil de adivinar: evita palabras como contraseña, clave, Flujo, nombres de ciudades, «te amo» o números seguidos. Usa 4 palabras sin relación entre sí.',
  invalid: 'Tu clave abrió el acceso, pero lo que contiene no es válido. Crea la clave única de nuevo en el computador donde usas Flujo.',
  unsupported: 'Este navegador no permite usar la clave única. Abre Flujo en un navegador actualizado (Safari, Chrome, Edge o Firefox).'
};

/** Puntuación «inteligente» (iOS, Word): comillas curvas, primas y rayas → su forma simple. */
const TYPO = [[/[\u2018\u2019\u201A\u201B\u2032\u0060]/gu, "'"], [/[\u201C\u201D\u201E\u201F\u2033]/gu, '"'], [/[\u2010-\u2015\u2212]/gu, '-']];

/** La clave tal como cuenta: sin tildes ni diacríticos («ñ»→«n»), en minúsculas, con la puntuación tipográfica unificada
 *  (’ → ', “ ” → ", — – → -) y sin espacios ni caracteres invisibles o de formato. */
export function normalizePassword(text) {
  let s = String(text == null ? '' : text).normalize('NFKD').replace(/\p{M}+/gu, '');
  for (const [rx, to] of TYPO) s = s.replace(rx, to);
  s = s.toLowerCase();
  return s.replace(/[\s\p{Cf}]+/gu, '');
}

/** La normalización de v22 (sin unificar la puntuación): al abrir se prueba también, para que ningún acceso ya creado deje de abrir. */
function normalizePasswordV22(text) {
  let s = String(text == null ? '' : text).normalize('NFKD').replace(/\p{M}+/gu, '');
  s = s.toLowerCase();
  return s.replace(/[\s­​-‍⁠﻿]+/gu, '');
}

/** null si la clave sirve como clave única; si no, el motivo (texto para la persona). */
export function passwordProblem(text) {
  const s = normalizePassword(text);
  const chars = [...s];
  if (!chars.length) return MSG2.empty;
  if (chars.length < PASSWORD_MIN) return MSG2.short;
  if (chars.length > PASSWORD_MAX) return MSG2.long;
  if (/^\d+$/.test(s)) return MSG2.digits;
  if (new Set(chars).size < 5) return MSG2.weak;
  const words = String(text).trim().split(/\s+/).filter((w) => normalizePassword(w).length >= 2);
  if (words.length < 3 && chars.length < PASSWORD_ONE_WORD) return MSG2.words;
  let rest = s;                                                    // sin palabras de contraseña típicas ni números seguidos, ¿queda algo?
  for (const w of COMMON) rest = rest.split(w).join('');
  rest = rest.replace(/\d{3,}/g, '');
  if ([...rest].length < 10) return MSG2.common;
  let seq = true;
  for (let i = 1; i < chars.length && seq; i++) seq = Math.abs(chars[i].codePointAt(0) - chars[i - 1].codePointAt(0)) <= 1;
  if (seq) return MSG2.weak;
  return null;
}

/** Trozos típicos de contraseñas fáciles (ya normalizados: sin tildes ni espacios). */
const COMMON = ['contrasena', 'password', 'clave', 'flujo', 'teamo', 'amor', 'hola', 'ecuador', 'quito', 'guayaquil', 'cuenca',
  'qwerty', 'asdf', 'zxcv', '1qaz', '2wsx', '3edc', 'abc', 'dios', 'familia', 'secreto', 'admin', 'usuario'];

const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function derivePersonalKey(subtle, normalized, salt, iterations, usage) {
  const material = await subtle.importKey('raw', new TextEncoder().encode(normalized), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** true si el texto es un acceso de clave única («FLUJO2.…»). */
export function isPersonalCode(text) { return typeof text === 'string' && text.startsWith(PREFIX2); }

/**
 * Cifra la conexión con la clave única. La clave debe pasar passwordProblem (si no, lanza KEY con el motivo).
 * @returns {Promise<string>} «FLUJO2.…»
 */
export async function createPersonalCode(cfg, password, { iterations = PERSONAL_ITERATIONS } = {}) {
  const c = webcrypto();
  const { owner, repo, branch, token } = cfg || {};
  const bad = badField(owner, repo, branch, token, { owner: MSG.badOwner, repo: MSG.badRepo, branch: MSG.badBranch, token: MSG.badToken });
  if (bad) throw new PairingError('INVALID', bad);
  const problem = passwordProblem(password);
  if (problem) throw new PairingError('KEY', problem);
  const it = Math.floor(iterations);
  if (!(it >= ITER2_MIN && it <= ITER2_MAX)) throw new PairingError('INVALID', 'Número de rondas fuera de rango.');
  const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const head = u32(it);
  const aes = await derivePersonalKey(c.subtle, normalizePassword(password), salt, it, 'encrypt');
  const plain = new TextEncoder().encode(JSON.stringify({ o: owner, r: repo, b: branch, t: token, c: new Date().toISOString() }));
  let sealed;
  try {
    sealed = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: concat(AAD2, head), tagLength: TAG_BYTES * 8 }, aes, plain));
  } finally { wipe(plain); }
  return PREFIX2 + toBase64url(concat(head, salt, iv, sealed));
}

/**
 * Abre un acceso «FLUJO2.…» con la clave única.
 * @returns {Promise<{owner:string, repo:string, branch:string, token:string, createdAt:string}>}
 * @throws {PairingError} FORMAT (no es un acceso o está dañado) · KEY (clave vacía o equivocada) · INVALID · UNSUPPORTED
 */
export async function openPersonalCode(code, password) {
  let c;
  try { c = webcrypto(); } catch (_) { throw new PairingError('UNSUPPORTED', MSG2.unsupported); }
  const text = typeof code === 'string' ? code.trim() : '';
  if (!isPersonalCode(text) || text.length > MAX_INPUT) throw new PairingError('FORMAT', MSG2.garbled);
  const body = text.slice(PREFIX2.length);
  const bytes = fromBase64url(body);
  if (!bytes || bytes.length < 4 + SALT_BYTES + IV_BYTES + TAG_BYTES + 1 || toBase64url(bytes) !== body) throw new PairingError('FORMAT', MSG2.garbled);
  const it = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  if (!(it >= ITER2_MIN && it <= ITER2_MAX)) throw new PairingError('FORMAT', MSG2.garbled);
  const pw = normalizePassword(password);
  if (!pw) throw new PairingError('KEY', MSG2.empty);
  const head = bytes.slice(0, 4);
  const salt = bytes.slice(4, 4 + SALT_BYTES);
  const iv = bytes.slice(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
  const sealed = bytes.slice(4 + SALT_BYTES + IV_BYTES);
  const tryKey = async (k) => {
    try {
      const aes = await derivePersonalKey(c.subtle, k, salt, it, 'decrypt');
      return new Uint8Array(await c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: concat(AAD2, head), tagLength: TAG_BYTES * 8 }, aes, sealed));
    } catch (_) { return null; }
  };
  let plain = await tryKey(pw);
  const old = normalizePasswordV22(password);
  if (!plain && old && old !== pw) plain = await tryKey(old);          // accesos creados con v22-v24 y una clave con ’ “ — o similares
  if (!plain) throw new PairingError('KEY', MSG2.wrong);
  let obj;
  try { obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); }
  catch (_) { throw new PairingError('INVALID', MSG2.invalid); }
  finally { wipe(plain); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new PairingError('INVALID', MSG2.invalid);
  const { o, r, b, t, c: created } = obj;
  const bad = badField(o, r, b, t, { owner: MSG2.invalid, repo: MSG2.invalid, branch: MSG2.invalid, token: MSG2.invalid });
  if (bad || typeof created !== 'string' || created.length > 40 || Number.isNaN(Date.parse(created))) throw new PairingError('INVALID', MSG2.invalid);
  return { owner: o, repo: r, branch: b, token: t, createdAt: new Date(created).toISOString() };
}

/** Texto de acceso.json para un código2 recién creado. */
export function accessFileText(code, createdAt = new Date().toISOString()) {
  return JSON.stringify({ formato: ACCESS_FORMAT, creado: createdAt, codigo: code }, null, 2) + '\n';
}

/** Lee acceso.json (texto u objeto ya parseado) → {code, createdAt}, o null si no es un acceso válido. Nunca lanza. */
export function parseAccessFile(input) {
  try {
    const o = typeof input === 'string' ? JSON.parse(input) : input;
    if (!o || typeof o !== 'object' || o.formato !== ACCESS_FORMAT) return null;
    const code = typeof o.codigo === 'string' ? o.codigo.trim() : '';
    if (!isPersonalCode(code) || code.length > MAX_INPUT || !/^FLUJO2\.[A-Za-z0-9_-]+$/.test(code)) return null;
    const createdAt = typeof o.creado === 'string' && o.creado.length <= 40 && !Number.isNaN(Date.parse(o.creado)) ? new Date(o.creado).toISOString() : null;
    return { code, createdAt };
  } catch (_) { return null; }
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
