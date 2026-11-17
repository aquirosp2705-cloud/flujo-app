/* settings-ui.js — panel «Sincronización con GitHub» + respaldo local de FlujoWeb.
 *
 *   import { mountSyncSettings } from './settings-ui.js';
 *   const ui = mountSyncSettings(document.getElementById('ajustes-sync'), {
 *     store, sync, engine,                         // obligatorios: store, sync; engine es opcional pero recomendado
 *     autosaver,                                   // opcional: si se pasa, se usa su flush() antes de sincronizar
 *     onBundleReplaced: (bundle, info) => { … }    // se llama tras descargar/restaurar/usar la versión remota
 *   });                                            // bundle = {meta, sheetDatas} leído del Store; info = {reason, changed?}
 *   ui.refresh();  ui.destroy();
 *
 * Código de conexión (enlazar otro dispositivo SIN crear un token nuevo; ver js/pairing.js):
 *   - Opciones extra de mountSyncSettings: pairing (false = sin la tarjeta del código), pairingCode (texto que llegó por un
 *     enlace «#conectar=…»: se pega en el cuadro «Código» y el foco pasa a «Clave»).
 *   - Dispositivo ya conectado: tarjeta «Usar en otro dispositivo» (crea código + clave y los muestra; no se guardan en ningún lado).
 *     Dispositivo sin conexión: bloque «Ya tengo un código de conexión». Ambos abren el código, MUESTRAN a qué cuenta y
 *     repositorio se va a conectar y piden confirmación; la conexión se prueba ANTES de guardar nada.
 *   - mountPairingJoin(contenedor, {store, sync, onBundleReplaced, code}): solo el bloque «Ya tengo un código de conexión»
 *     (pantalla de primer uso). Devuelve lo mismo que mountSyncSettings más ui.setPairingCode(código).
 *
 * Clases CSS con prefijo "fx-" (ver css/sync.css). Todo el texto dinámico se inserta con textContent (sin innerHTML).
 * El token nunca se vuelve a escribir en el DOM: el campo queda vacío tras guardar (vacío = conservar el guardado).
 * El código y la clave que se crean solo viven en memoria mientras la tarjeta está abierta: no van a ningún almacenamiento ni a la consola.
 */

import { AutoSaver, StoreError, Store, KV } from './store.js';
import { GithubError, GithubSync } from './sync-github.js';
import { PairingError, newKey, formatKey, createCode, openCode, linkFor } from './pairing.js';

/** recover.js (token guardado en el administrador de contraseñas del navegador) se carga solo cuando hace falta; si falla, la conexión con GitHub sigue igual. */
let recoverPromise = null;
const loadRecover = () => (recoverPromise || (recoverPromise = import('./recover.js').catch(() => null)));

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleString('es-EC', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return String(iso); }
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(s >= 0)) return '';
  if (s < 60) return 'hace unos segundos';
  if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
  return 'hace ' + Math.round(s / 86400) + ' d';
};
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const KIND = { pull: 'descarga', push: 'subida de cambios', initial: 'carga inicial', resolve: 'resolución de conflicto' };

let uidCounter = 0;

/** Formulario de GitHub para un token fine-grained ya lleno: nombre, 1 año, permiso Contents de lectura y escritura (el repositorio se elige a mano). */
const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=FlujoWeb&description=Datos+de+Flujo&expires_in=365&contents=write&metadata=read';

/** Solo el bloque «Ya tengo un código de conexión» (pantalla de primer uso, sin ninguna otra tarjeta de ajustes). */

export function mountPairingJoin(containerEl, opts = {}) {
  const { code = null, pairingCode = null, ...rest } = opts || {};
  return mountSyncSettings(containerEl, { ...rest, pairingCode: pairingCode || code, only: 'join' });
}

export function mountSyncSettings(containerEl, { store, sync, engine = null, autosaver = null, onBundleReplaced = null, pairing = true, pairingCode = null, only = null } = {}) {
  if (!containerEl) throw new TypeError('mountSyncSettings: falta el contenedor.');
  if (!store || !sync) throw new TypeError('mountSyncSettings: faltan store y sync.');
  const uid = 'fx' + (++uidCounter);
  const joinOnly = only === 'join';                 // solo el bloque «Ya tengo un código de conexión»
  const withPairing = joinOnly || pairing !== false;
  let busy = false;
  let destroyed = false;
  let metaNames = new Map();
  let timer = null;
  let lastTyped = null;          // última conexión tecleada (usuario, repositorio, token); vive en memoria hasta probarla

  /* ------------------------------------------------------------ construcción del DOM */
  const cfg0 = sync.getConfig();
  const ownerIn = h('input', { class: 'fx-input', id: uid + '-owner', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'tu-usuario' });
  const repoIn = h('input', { class: 'fx-input', id: uid + '-repo', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'flujo-datos' });
  const branchIn = h('input', { class: 'fx-input', id: uid + '-branch', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'main' });
  const tokenIn = h('input', { class: 'fx-input fx-input--token', id: uid + '-token', type: 'password', name: 'fx-token', autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false' });
  ownerIn.value = cfg0.owner || '';
  repoIn.value = cfg0.repo || 'flujo-datos';
  branchIn.value = cfg0.branch || 'main';

  const toggleBtn = h('button', { class: 'fx-btn fx-btn--small', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Mostrar el token', text: 'Mostrar' });
  toggleBtn.addEventListener('click', () => {
    const show = tokenIn.type === 'password';
    tokenIn.type = show ? 'text' : 'password';
    toggleBtn.textContent = show ? 'Ocultar' : 'Mostrar';
    toggleBtn.setAttribute('aria-pressed', String(show));
    toggleBtn.setAttribute('aria-label', show ? 'Ocultar el token' : 'Mostrar el token');
  });

  const btn = (text, cls, onClick, extra) => {
    const b = h('button', { class: 'fx-btn ' + (cls || ''), type: 'button', text, ...(extra || {}) });
    b.addEventListener('click', onClick);
    return b;
  };

  const saveBtn = btn('Guardar configuración', '', () => run(doSave), { 'data-fx': 'save' });
  const useSavedBtn = btn('Usar el token guardado en el navegador', 'fx-btn--quiet', () => doUseSaved(), { 'data-fx': 'use-saved', hidden: true });
  const savedNote = h('p', { class: 'fx-note', 'data-fx': 'saved-note', hidden: true },
    h('b', {}, 'Si el navegador borra los datos de la app: '), 'al conectar, tu navegador puede preguntarte si quieres guardar la contraseña «Flujo: datos en GitHub». ',
    'Di que sí: así podrás reconectar con un clic (botón «Usar el token guardado en el navegador») sin crear otro token. Tus datos siguen a salvo en GitHub.');
  const testBtn = btn('Probar conexión', 'fx-btn--primary', () => run(doTest), { 'data-fx': 'test' });
  const forgetBtn = btn('Olvidar token', 'fx-btn--quiet', () => run(doForget), { 'data-fx': 'forget' });
  const pushBtn = btn('Subir cambios', 'fx-btn--primary', () => run(doPush), { 'data-fx': 'push' });
  const pullBtn = btn('Descargar todo desde GitHub', '', () => run(doPull), { 'data-fx': 'pull' });
  const initialBtn = btn('Subir todo (primera vez)', '', () => run(doInitial), { 'data-fx': 'initial' });
  const backupBtn = btn('Descargar respaldo (.json)', '', () => run(doBackup), { 'data-fx': 'backup' });
  const restoreBtn = btn('Restaurar respaldo', '', () => fileIn.click(), { 'data-fx': 'restore' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', class: 'fx-file', 'aria-label': 'Archivo de respaldo a restaurar', tabindex: '-1' });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0];
    if (f) run(() => doRestore(f));
    fileIn.value = '';
  });
  const actionBtns = [saveBtn, testBtn, forgetBtn, pushBtn, pullBtn, initialBtn, backupBtn, restoreBtn, useSavedBtn];

  const msgBox = h('div', { class: 'fx-msg', role: 'status', 'aria-live': 'polite', hidden: true });
  const progBar = h('progress', { class: 'fx-progress__bar', max: '100' });
  const progText = h('span', { class: 'fx-progress__text' });
  const progBox = h('div', { class: 'fx-progress', hidden: true }, progBar, progText);
  const statusList = h('dl', { class: 'fx-status' });
  const conflictsBox = h('div', { class: 'fx-conflicts', 'aria-live': 'polite' });

  const field = (label, input, hint, extraClass) => h('div', { class: 'fx-field ' + (extraClass || '') },
    h('label', { class: 'fx-label', for: input.id }, label), input, hint ? h('span', { class: 'fx-hint' }, hint) : null);

  const steps = [
    ['Entra a ', h('b', {}, 'github.com'), ' e inicia sesión con tu cuenta.'],
    ['Pulsa tu foto de perfil (arriba a la derecha) → ', h('b', {}, 'Settings'), '.'],
    ['En el menú de la izquierda, baja hasta el final y entra a ', h('b', {}, 'Developer settings'), '.'],
    [h('b', {}, 'Personal access tokens'), ' → ', h('b', {}, 'Fine-grained tokens'), ' → botón ', h('b', {}, 'Generate new token'), '.'],
    ['Token name: ', h('b', {}, 'FlujoWeb'), '. Expiration: elige ', h('b', {}, 'Custom'), ' y una fecha a ', h('b', {}, '1 year'), ' (365 días; GitHub te avisa por correo antes de que venza, y cuando venza solo generas otro y lo pegas aquí).'],
    ['Resource owner: tu usuario (o la organización dueña del repositorio).'],
    ['Repository access → ', h('b', {}, 'Only select repositories'), ' y marca SOLO ', h('b', {}, 'flujo-datos'), '. Nunca «All repositories».'],
    ['Permissions → Repository permissions → ', h('b', {}, 'Contents'), ' → Access: ', h('b', {}, 'Read and write'), '. («Metadata: Read-only» se agrega sola.) No actives ningún otro permiso.'],
    ['Pulsa ', h('b', {}, 'Generate token'), ' y copia el valor (empieza con ', h('code', {}, 'github_pat_'), '). GitHub lo muestra una sola vez.'],
    ['Pégalo en el campo «Token» de arriba, escribe tu usuario y pulsa «Probar conexión».']
  ];

  /* ---- código de conexión: crear (dispositivo ya conectado) y pegar (dispositivo nuevo) ---- */
  // El mismo cuadro de avance/mensajes (progBox, msgBox) se muda al lugar donde la persona está trabajando.
  const syncSlot = h('div', { class: 'fx-slot' }, progBox, msgBox);       // «Sincronizar»
  const createSlot = h('div', { class: 'fx-slot' });                       // «Usar en otro dispositivo»
  const joinSlot = h('div', { class: 'fx-slot' });                         // «Ya tengo un código de conexión»
  const useSlot = (slot) => { if (msgBox.parentNode !== slot) slot.append(progBox, msgBox); };
  const sayAt = (slot, kind, text, details) => { useSlot(slot); say(kind, text, details); };

  let issued = null;          // {code, link}: el código recién creado, SOLO en memoria mientras la tarjeta esté abierta
  let pending = null;         // código ya abierto, a la espera de que la persona confirme a qué cuenta se conecta
  let joinOpen = false;       // en un dispositivo ya conectado, el bloque de pegar un código empieza plegado

  // crear
  const keyOut = h('div', { class: 'fx-pair__key', role: 'group', 'aria-label': 'Clave de conexión', tabindex: '-1', 'data-fx': 'pair-key' });
  const codeOut = h('textarea', { class: 'fx-input fx-input--code', id: uid + '-pair-out', readonly: true, rows: '4', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-fx': 'pair-code' });
  codeOut.addEventListener('focus', () => codeOut.select());
  const createBtn = btn('Crear código de conexión', 'fx-btn--primary', () => run(doCreateCode, createSlot), { 'data-fx': 'pair-create' });
  const copyCodeBtn = btn('Copiar código', 'fx-btn--primary', () => doCopy('code'), { 'data-fx': 'pair-copy' });
  const copyLinkBtn = btn('Copiar enlace', '', () => doCopy('link'), { 'data-fx': 'pair-copy-link' });
  const shareBtn = typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? btn('Compartir', '', () => doShare(), { 'data-fx': 'pair-share' }) : null;
  const hideBtn = btn('Ocultar el código', 'fx-btn--quiet', () => { wipePair(); createBtn.focus(); }, { 'data-fx': 'pair-hide' });
  const pasteLink = h('button', { class: 'fx-link', type: 'button', 'aria-expanded': 'false', 'aria-controls': uid + '-join', 'data-fx': 'pair-paste', text: 'Pegar un código de conexión' });
  pasteLink.addEventListener('click', () => setJoinOpen(!joinOpen, true));
  const outBox = h('div', { class: 'fx-pair__out', hidden: true, 'data-fx': 'pair-out' },
    h('p', { class: 'fx-label' }, 'Clave'),
    keyOut,
    h('p', { class: 'fx-hint' }, 'Anótala o léela de esta pantalla: no se guarda en ningún sitio. No la envíes por el mismo chat o correo que el código ni hagas una captura que incluya los dos.'),
    h('label', { class: 'fx-label', for: codeOut.id }, 'Código'),
    codeOut,
    h('div', { class: 'fx-actions' }, copyCodeBtn, copyLinkBtn, shareBtn),
    h('ol', { class: 'fx-steps' },
      h('li', {}, 'Envíate el código por WhatsApp (chat contigo mismo) o por correo.'),
      h('li', {}, 'En el otro dispositivo abre Flujo y busca «Ya tengo un código de conexión».'),
      h('li', {}, 'Pega el código y escribe la clave.')),
    h('p', { class: 'fx-note' }, 'Sin la clave, el código no sirve. Para cortar el acceso de todos los dispositivos enlazados, borra el token en GitHub (Settings → Developer settings → Fine-grained tokens).'),
    h('div', { class: 'fx-actions' }, hideBtn));
  const createBox = joinOnly ? null : h('div', { class: 'fx-create', 'data-fx': 'create' },
    h('h3', { class: 'fx-h3' }, 'Usar en otro dispositivo'),
    h('p', { class: 'fx-pair__lead' }, 'Conecta otro celular o computador con tus mismos datos, sin volver a entrar a GitHub. Aquí obtienes un código y una clave; en el otro dispositivo los escribes.'),
    h('div', { class: 'fx-actions' }, createBtn),
    createSlot,
    outBox,
    h('p', { class: 'fx-pair__alt' }, pasteLink));

  // pegar
  const codeIn = h('textarea', { class: 'fx-input fx-input--code', id: uid + '-pair-code', rows: '3', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'FLUJO1.…', 'data-fx': 'join-code' });
  const keyIn = h('input', { class: 'fx-input fx-input--key', id: uid + '-pair-key', type: 'text', name: 'fx-pair-key', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', maxlength: '30', placeholder: 'XXXX-XXXX-XXXX', 'data-fx': 'join-key' });
  const joinBtn = btn('Conectar este dispositivo', 'fx-btn--primary', () => run(doJoin, joinSlot), { 'data-fx': 'join-go' });
  for (const i of [codeIn, keyIn]) i.addEventListener('input', () => { if (msgBox.parentNode === joinSlot) clearMsg(); });
  keyIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); if (!busy) joinBtn.click(); } });
  const confirmQ = h('p', { class: 'fx-confirm__q', id: uid + '-confirm-q', 'data-fx': 'join-question' });
  const confirmInfo = h('p', { class: 'fx-confirm__info', 'data-fx': 'join-info' });
  const confirmWarn = h('p', { class: 'fx-confirm__warn', 'data-fx': 'join-warn' });
  const yesBtn = btn('Sí, es mi cuenta: conectar', 'fx-btn--primary', () => run(doJoinConfirmed, joinSlot), { 'data-fx': 'join-yes' });
  const noBtn = btn('Cancelar', '', () => { showJoinForm(); keyIn.focus(); }, { 'data-fx': 'join-no' });
  const confirmBox = h('div', { class: 'fx-confirm', role: 'group', 'aria-labelledby': confirmQ.id, tabindex: '-1', hidden: true, 'data-fx': 'join-confirm' },
    confirmQ, confirmInfo, confirmWarn, h('div', { class: 'fx-actions' }, yesBtn, noBtn));
  const codeField = field('Código', codeIn, 'Empieza con FLUJO1. También sirve el enlace completo.');
  const keyField = field('Clave', keyIn, 'Las 12 letras y números que viste en la pantalla del otro dispositivo (por ejemplo ABCD-EFGH-JKMN).');
  for (const [input, fieldEl] of [[codeIn, codeField], [keyIn, keyField]]) {      // la ayuda de cada campo la lee el lector de pantalla
    const hint = fieldEl.querySelector('.fx-hint');
    hint.id = input.id + '-hint';
    input.setAttribute('aria-describedby', hint.id);
  }
  const joinForm = h('div', { class: 'fx-join__form' }, codeField, keyField, h('div', { class: 'fx-actions' }, joinBtn));
  const joinBox = h('div', { class: 'fx-join', id: uid + '-join', 'data-fx': 'join' },
    h(joinOnly ? 'h2' : 'h3', { class: 'fx-h3' }, 'Ya tengo un código de conexión'),         // en la pantalla de primer uso es el título principal
    h('p', { class: 'fx-pair__lead' }, 'Si ya usas Flujo en otro celular o computador: allí abre Ajustes → «Usar en otro dispositivo» y pulsa «Crear código de conexión»; envíate el código por WhatsApp o correo, pégalo aquí y escribe la clave que se ve en esa pantalla. No tienes que volver a entrar a GitHub.'),
    joinForm, confirmBox, joinSlot);
  const pairCard = withPairing ? h('div', { class: 'fx-card fx-pair', 'data-fx': 'pair-card' }, createBox, joinBox) : null;
  actionBtns.push(createBtn, joinBtn, yesBtn, noBtn, pasteLink);

  const root = joinOnly ? h('section', { class: 'fx-sync fx-sync--join', 'aria-label': 'Conectar con un código' }, pairCard) : h('section', { class: 'fx-sync', 'aria-labelledby': uid + '-title' },
    h('h2', { class: 'fx-title', id: uid + '-title' }, 'Sincronización con GitHub'),
    h('p', { class: 'fx-lead' }, 'Tus datos se guardan siempre en este dispositivo. Si quieres, además se copian a un repositorio ',
      h('b', {}, 'privado'), ' de tu cuenta de GitHub para tenerlos iguales en tu computador y tu celular, y con respaldo.'),

    pairCard,

    h('div', { class: 'fx-card' },
      h('h3', { class: 'fx-h3' }, 'Conexión'),
      h('div', { class: 'fx-grid' },
        field('Usuario u organización', ownerIn),
        field('Repositorio', repoIn, 'Debe ser privado. Por omisión: flujo-datos.'),
        field('Rama', branchIn),
        h('div', { class: 'fx-field fx-field--token' },
          h('label', { class: 'fx-label', for: tokenIn.id }, 'Token de acceso'),
          h('div', { class: 'fx-row' }, tokenIn, toggleBtn),
          h('span', { class: 'fx-hint', 'data-fx': 'token-hint' }),
          useSavedBtn,
          h('a', { class: 'fx-btn fx-btn--quiet', 'data-fx': 'new-token', href: NEW_TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Crear un token nuevo en GitHub (abre el formulario ya lleno)'),
          h('span', { class: 'fx-hint' }, 'En GitHub solo falta elegir «Only select repositories» → flujo-datos y pulsar «Generate token». Antes de crear otro, prueba tu código de conexión: no necesita token nuevo.'))),
      h('p', { class: 'fx-note' },
        h('b', {}, 'Seguridad: '), 'el token se guarda solo en este dispositivo (en el almacenamiento del navegador) y únicamente se envía a GitHub. ',
        'No lo compartas ni lo pegues en otros sitios. Para conectar otro dispositivo no hace falta copiarlo: crea un código de conexión en uno que ya esté conectado («Usar en otro dispositivo»). ',
        'Si pierdes un dispositivo, revoca el token en GitHub ',
        '(Settings → Developer settings → Fine-grained tokens).'),
      savedNote,
      h('div', { class: 'fx-actions' }, testBtn, saveBtn, forgetBtn)),

    h('div', { class: 'fx-card' },
      h('h3', { class: 'fx-h3' }, 'Sincronizar'),
      h('div', { class: 'fx-actions' }, pushBtn, pullBtn, initialBtn),
      syncSlot,
      conflictsBox,
      statusList),

    h('details', { class: 'fx-details' },
      h('summary', { class: 'fx-details__summary' }, 'Cómo crear el token'),
      h('div', { class: 'fx-details__body' },
        h('p', {}, h('b', {}, 'Antes: '), 'crea el repositorio privado. En GitHub pulsa «+» (arriba a la derecha) → ', h('b', {}, 'New repository'),
          '. Nombre: ', h('b', {}, 'flujo-datos'), '. Marca ', h('b', {}, 'Private'), '. No hace falta README ni otros archivos (puede quedar vacío). Pulsa ', h('b', {}, 'Create repository'), '.'),
        h('ol', { class: 'fx-steps' }, steps.map((s) => h('li', {}, s))),
        h('p', {}, 'Cuando el token venza (1 año), repite los pasos 4 a 9 y pega el nuevo: no se pierde ningún dato. ',
          'En cada dispositivo (computador, celular…) hay que pegar el token una sola vez. ',
          'Para el segundo dispositivo hay una forma más fácil: en uno que ya esté conectado usa «Usar en otro dispositivo» y no necesitas crear otro token.'))),

    h('div', { class: 'fx-card' },
      h('h3', { class: 'fx-h3' }, 'Respaldo local'),
      h('p', { class: 'fx-note' }, 'Un archivo .json con todas las hojas del libro (no incluye el token ni los archivos mensuales: esos se guardan aparte, en tu GitHub). Restaurarlo reemplaza las hojas de este dispositivo; los archivos mensuales no se tocan.'),
      h('div', { class: 'fx-actions' }, backupBtn, restoreBtn, fileIn)));

  containerEl.append(root);
  loadRecover().then((R) => { if (R && !destroyed && R.credentialsSupported()) { useSavedBtn.hidden = false; savedNote.hidden = false; } });

  /* ------------------------------------------------------------ utilidades de interfaz */
  const nameOf = (id) => (id === 'meta' ? 'meta.json' : (metaNames.get(id) || id).trim());
  const say = (kind, text, details) => {
    msgBox.className = 'fx-msg fx-msg--' + kind;
    msgBox.replaceChildren(h('p', { class: 'fx-msg__text' }, text));
    if (details && details.length) {
      msgBox.append(h('ul', { class: 'fx-checks' }, details.map((d) => {
        const o = typeof d === 'string' ? { ok: null, text: d } : d;
        return h('li', { class: o.ok === true ? 'fx-check fx-check--ok' : o.ok === false ? 'fx-check fx-check--bad' : 'fx-check' }, o.text);
      })));
    }
    msgBox.hidden = false;
    msgBox.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    requestAnimationFrame(() => { try { msgBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) { /* sin scrollIntoView */ } });
  };
  const clearMsg = () => { msgBox.hidden = true; msgBox.replaceChildren(); };
  const explain = (e) => {
    if (e instanceof GithubError || e instanceof StoreError || e instanceof PairingError) {
      let t = e.message;
      if (e.partial && e.partial.pushed && e.partial.pushed.length) t += ' (Antes del error se subieron ' + e.partial.pushed.length + ' hoja(s).)';
      return t;
    }
    return 'Ocurrió un error inesperado: ' + ((e && e.message) || e);
  };
  const onProgress = (p) => {
    if (!p) return;
    progBox.hidden = false;
    if (p.total > 0 && p.phase !== 'tree') progBar.value = Math.min(100, Math.round((100 * (p.done || 0)) / p.total));
    else progBar.removeAttribute('value');
    if (p.message) progText.textContent = p.message;
  };
  const setBusy = (b) => {
    busy = b;
    root.classList.toggle('fx-busy', b);
    root.setAttribute('aria-busy', String(b));
    for (const x of actionBtns) x.disabled = b;
    for (const x of conflictsBox.querySelectorAll('button')) x.disabled = b;
    if (b) { progBox.hidden = false; progBar.removeAttribute('value'); progText.textContent = 'Trabajando…'; } else progBox.hidden = true;
  };
  /** Ejecuta una acción con los botones bloqueados; slot = dónde se muestran el avance y los mensajes (por omisión, «Sincronizar»). */
  async function run(fn, slot = syncSlot) {
    if (busy || destroyed) return;
    useSlot(slot);
    setBusy(true);
    clearMsg();
    try { await fn(); }
    catch (e) { say('error', explain(e)); }
    finally { setBusy(false); try { await refresh(); } catch (_) { /* informativo */ } }
  }

  async function flushLocal() {
    if (autosaver && typeof autosaver.flush === 'function') { await autosaver.flush(); return; }
    if (engine) {
      const tmp = new AutoSaver(engine, store, { listen: false });
      try { await tmp.flush(); } finally { tmp.dispose(); }
    }
  }

  async function replaced(reason, extra) {
    if (typeof onBundleReplaced !== 'function') return;
    const bundle = await store.loadBundle();
    await onBundleReplaced(bundle, { reason, ...(extra || {}) });
  }

  function readFields() {
    let owner = ownerIn.value.trim();
    let repo = repoIn.value.trim();
    const branch = branchIn.value.trim() || 'main';
    const m = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(repo);   // pegaron "usuario/repo" o la URL
    if (m) { owner = m[1]; repo = m[2]; }
    return { owner, repo, branch, token: tokenIn.value.trim() };
  }

  /** Aplica los campos al objeto sync y los guarda. Devuelve false si falta algo o el usuario cancela. */
  async function applyAndSave() {
    const f = readFields();
    if (!f.owner || !f.repo) { say('warn', 'Escribe el usuario (u organización) y el nombre del repositorio.'); return false; }
    const prev = sync.getConfig();
    const changedRepo = !!(prev.owner && prev.repo) && (prev.owner !== f.owner || prev.repo !== f.repo || prev.branch !== f.branch);
    if (changedRepo && !window.confirm('Cambiaste el repositorio de destino (' + prev.owner + '/' + prev.repo + ' → ' + f.owner + '/' + f.repo + ').\n\n' +
      'Se reiniciará el estado de sincronización de este dispositivo (tus datos locales NO se borran) y todo se considerará pendiente de subir al nuevo repositorio.\n\n¿Continuar?')) return false;
    const patch = { owner: f.owner, repo: f.repo, branch: f.branch };
    if (f.token) patch.token = f.token;
    sync.setConfig(patch);
    if (!sync.getConfig().hasToken) { say('warn', 'Falta el token de acceso. Si aún no lo tienes, abre «Cómo crear el token» más abajo.'); return false; }
    await sync.saveConfig();
    lastTyped = f.token ? { owner: f.owner, repo: f.repo, token: f.token } : null;     // se ofrece al navegador solo si la prueba de conexión funciona
    tokenIn.value = '';
    if (tokenIn.type !== 'password') toggleBtn.click();
    ownerIn.value = f.owner; repoIn.value = f.repo; branchIn.value = f.branch;
    return true;
  }

  /* ------------------------------------------------------------ acciones */
  async function doSave() {
    if (await applyAndSave()) say('ok', 'Configuración guardada en este dispositivo.');
  }

  async function doTest() {
    if (!(await applyAndSave())) return;
    onProgress({ message: 'Probando la conexión con GitHub…' });
    const r = await sync.testConnection();
    const details = r.checks.slice();
    for (const w of r.warnings) details.push({ ok: false, text: w });
    if (r.ok) say('ok', r.message, details);
    else say(r.code === 'PUBLIC_REPO' ? 'warn' : 'error', r.message, details);
    if (r.ok && lastTyped) offerSaveToken(lastTyped);          // ya se comprobó que funciona: se ofrece guardarlo en el administrador de contraseñas del navegador
    lastTyped = null;
    // primer uso (este dispositivo aún no tiene datos): conectar ya significa «traer mis datos»; no hace falta otro botón
    if (r.ok && !engine && typeof onBundleReplaced === 'function') await doPull();
  }

  async function doForget() {
    if (!window.confirm('¿Borrar el token de este dispositivo? Tendrás que pegarlo de nuevo para sincronizar. Tus datos locales no se tocan.')) return;
    await sync.clearToken();
    lastTyped = null;
    say('info', 'El token se borró de este dispositivo.');
  }

  /** Ofrece guardar la conexión en el administrador de contraseñas del navegador (sin esperar; si no hay soporte no pasa nada). */
  function offerSaveToken(c) { loadRecover().then((R) => (R ? R.saveToken(c) : null)).catch(() => { /* informativo */ }); }

  /** Botón «Usar el token guardado en el navegador»: el navegador muestra su selector y devuelve usuario, repositorio y token. */
  async function doUseSaved() {
    if (busy || destroyed) return;
    const R = await loadRecover();
    const c = R ? await R.findToken({ silent: false }) : null;
    if (!c) {
      useSlot(syncSlot);
      say('info', 'No encontré un token guardado en este navegador. Pégalo en el campo «Token de acceso» (si ya no lo tienes, crea uno nuevo en GitHub).');
      return;
    }
    await useCredential(c);
  }

  /** Rellena usuario, repositorio y token con una conexión recuperada y la prueba (en el primer uso, además baja los datos). */
  async function useCredential(c) {
    if (destroyed || !c || !c.owner || !c.repo || !c.token) return;
    ownerIn.value = c.owner; repoIn.value = c.repo; tokenIn.value = c.token;
    await run(doTest);
  }

  async function doPush() {
    if (!sync.isConfigured()) { say('warn', 'Primero guarda usuario, repositorio y token (sección «Conexión»).'); return; }
    await flushLocal();
    const res = await sync.pushDirty({ onProgress });
    const lines = [];
    if (res.pushed.length) lines.push({ ok: true, text: 'Subidas: ' + res.pushed.map(nameOf).join(', ') });
    if (res.unchanged.length) lines.push({ ok: null, text: 'Ya estaban iguales en GitHub: ' + res.unchanged.map(nameOf).join(', ') });
    if (res.conflicts.length) {
      say('warn', plural(res.conflicts.length, 'hoja cambió', 'hojas cambiaron') + ' en GitHub y también en este dispositivo: no se sobrescribió nada. Elige qué versión conservar más abajo.', lines);
    } else if (res.pushed.length) {
      say('ok', 'Listo: se ' + (res.pushed.length === 1 ? 'subió 1 hoja' : 'subieron ' + res.pushed.length + ' hojas') + ' a GitHub.', lines);
    } else {
      say('info', 'No había cambios nuevos que subir.', lines);
    }
  }

  async function doPull() {
    if (!sync.isConfigured()) { say('warn', 'Primero guarda usuario, repositorio y token (sección «Conexión»).'); return; }
    await flushLocal();
    const res = await sync.pullAll({ onProgress });
    const details = res.warnings.map((w) => ({ ok: false, text: w }));
    if (res.empty) {
      say('info', 'El repositorio está vacío (todavía no tiene datos). Si los datos están en este dispositivo, usa «Subir todo (primera vez)».', details);
      return;
    }
    if (res.changed) await replaced('pull', { changed: res.downloaded });
    if (res.conflicts.length) say('warn', plural(res.conflicts.length, 'hoja cambió', 'hojas cambiaron') + ' en GitHub y también aquí: no se pisó nada. Elige qué versión conservar más abajo.', details);
    else if (res.changed) say('ok', 'Se descargaron ' + plural(res.downloaded.length, 'archivo', 'archivos') + ' nuevos o modificados (' + res.unchanged + ' sin cambios).', details);
    else say('ok', 'Todo está al día: no había nada nuevo en GitHub.', details);
  }

  async function doInitial() {
    if (!sync.isConfigured()) { say('warn', 'Primero guarda usuario, repositorio y token (sección «Conexión»).'); return; }
    const c = sync.getConfig();
    if (!window.confirm('Se subirán TODOS los datos de este dispositivo (meta.json y todas las hojas) al repositorio privado ' + c.owner + '/' + c.repo + ' (rama ' + c.branch + ').\n\n' +
      'Hazlo solo la primera vez, con el repositorio vacío. ¿Continuar?')) return;
    await flushLocal();
    let res = await sync.initialUpload(undefined, { onProgress });
    if (!res.ok && res.code === 'REMOTE_HAS_DATA') {
      const list = res.differing.map((d) => d.name).slice(0, 8).join(', ');
      if (!window.confirm('El repositorio ya contiene datos DIFERENTES a los de este dispositivo (' + res.differing.length + ' archivo(s): ' + list + ').\n\n' +
        '¿Reemplazarlos con los de ESTE dispositivo? Las versiones anteriores quedan en el historial de GitHub.\n\n(Si prefieres traer lo que hay en GitHub, cancela y usa «Descargar todo desde GitHub».)')) {
        say('info', 'No se sobrescribió nada en GitHub.');
        return;
      }
      res = await sync.initialUpload(undefined, { onProgress, overwrite: true });
    }
    say('ok', 'Carga inicial completa: ' + plural(res.uploaded.length, 'archivo subido', 'archivos subidos') + (res.unchanged.length ? ' (' + res.unchanged.length + ' ya estaban iguales)' : '') + '.');
  }

  async function doResolve(sid, choice) {
    const nm = nameOf(sid);
    const ask = choice === 'local'
      ? 'Se subirá TU versión de «' + nm + '» y reemplazará la que está en GitHub (la anterior queda en el historial de GitHub). ¿Continuar?'
      : 'Se DESCARTARÁN tus cambios locales en «' + nm + '» y se usará la versión de GitHub. ¿Continuar?';
    if (!window.confirm(ask)) return;
    await run(async () => {
      await flushLocal();
      const res = await sync.resolveConflict(sid, choice, { onProgress });
      if (choice === 'remote') {
        await replaced('conflict-remote', { changed: [sid] });
        say('ok', 'Listo: «' + nm + '» ahora es la versión de GitHub.');
      } else {
        const failed = res.pushed && res.pushed.conflicts && res.pushed.conflicts.length;
        say(failed ? 'warn' : 'ok', failed ? 'GitHub volvió a cambiar «' + nm + '» mientras tanto; revisa el conflicto de nuevo.' : 'Listo: tu versión de «' + nm + '» quedó en GitHub.');
      }
    });
  }

  async function doBackup() {
    await flushLocal();
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const a = h('a', { href: url, download: 'flujoweb-respaldo-' + stamp + '.json', hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    say('ok', 'Respaldo generado (' + fmtBytes(blob.size) + '). Guárdalo en un lugar seguro: contiene todas tus hojas (no incluye los archivos mensuales).');
  }

  async function doRestore(file) {
    let parsed;
    try { parsed = Store.parseBackup(await file.text()); }
    catch (e) { say('error', explain(e)); return; }
    const n = parsed.meta.sheets.length;
    if (!window.confirm('Se REEMPLAZARÁN todas las hojas de este dispositivo por las del respaldo «' + file.name + '» (' + n + ' hojas).\n\n' +
      'Los cambios no guardados en pantalla se perderán. Los archivos mensuales de este dispositivo no se tocan. ¿Continuar?')) return;
    if (engine && engine.dirty && typeof engine.dirty.clear === 'function') engine.dirty.clear();   // lo que hay en memoria se descarta a propósito
    await store.replaceAll(parsed);
    let pending = null;
    if (sync.isConfigured()) { try { pending = (await sync.rebuildPending()).pending; } catch (_) { /* sin conexión: no es necesario para restaurar */ } }
    await replaced('restore', {});
    say('ok', 'Respaldo restaurado: ' + plural(n, 'hoja', 'hojas') + '.' + (pending && pending.length ? ' Hay ' + plural(pending.length, 'archivo', 'archivos') + ' distintos de GitHub, pendientes de subir.' : ''));
  }

  /* ------------------------------------------------------------ código de conexión */
  /** Dirección de esta página sin «?…» ni «#…» (base del enlace directo). */
  const pageBase = () => String(location.href).split('#')[0].split('?')[0];

  /** Qué parte de la tarjeta se ve: dispositivo conectado → «Usar en otro dispositivo»; sin conexión → «Ya tengo un código». */
  function syncPairMode() {
    if (!pairCard) return;
    const connected = !joinOnly && sync.isConfigured();
    if (createBox) createBox.hidden = !connected;
    joinBox.classList.toggle('fx-join--below', connected);
    joinBox.hidden = connected ? !joinOpen : false;
    pasteLink.setAttribute('aria-expanded', String(connected && joinOpen));
    if (!connected && issued) wipePair();          // ya no hay token que empaquetar: nada de código ni clave a la vista
  }

  function setJoinOpen(open, focusIt) {
    joinOpen = !!open;
    syncPairMode();
    if (joinOpen && focusIt) (codeIn.value.trim() ? keyIn : codeIn).focus();
  }

  /** Borra de la pantalla (y de la memoria de este módulo) el código y la clave recién creados. */
  function wipePair() {
    issued = null;
    keyOut.textContent = '';
    codeOut.value = '';
    outBox.hidden = true;
    createBtn.textContent = 'Crear código de conexión';
    if (msgBox.parentNode === createSlot) clearMsg();
  }

  /** Crea clave + código con lo guardado en el Store (no con lo que haya escrito en los campos). Nada se guarda en ningún sitio. */
  async function doCreateCode() {
    const saved = await store.getSetting(KV.GITHUB, null);
    if (!saved || !saved.owner || !saved.repo || !saved.token) {
      say('warn', 'Este dispositivo todavía no tiene la conexión guardada. Guarda tu usuario, repositorio y token en «Conexión» y vuelve a intentarlo.');
      return;
    }
    onProgress({ message: 'Creando el código…' });
    const key = newKey();
    const code = await createCode({ owner: saved.owner, repo: saved.repo, branch: saved.branch || 'main', token: saved.token }, key);
    issued = { code, link: linkFor(code, pageBase()) };
    keyOut.textContent = formatKey(key);
    codeOut.value = code;
    outBox.hidden = false;
    createBtn.textContent = 'Crear otro código';
    say('ok', 'Código creado. Anota la clave y envía el código al otro dispositivo.');
    keyOut.focus();
  }

  async function copyText(text) {
    try { if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') { await navigator.clipboard.writeText(text); return true; } } catch (_) { /* plan B */ }
    const ta = h('textarea', { class: 'fx-file', 'aria-hidden': 'true', tabindex: '-1', readonly: true });   // fuera de pantalla y se quita enseguida
    ta.value = text;
    root.append(ta);
    let ok = false;
    try { ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.value = '';
    ta.remove();
    return ok;
  }

  async function doCopy(what) {
    if (!issued) return;
    const ok = await copyText(what === 'link' ? issued.link : issued.code);
    if (ok) {
      sayAt(createSlot, 'ok', what === 'link' ? 'Enlace copiado. Pégalo en la barra de direcciones de Safari o Chrome (no lo abras desde WhatsApp) y escribe la clave.' : 'Código copiado. Pégalo en un mensaje para ti (WhatsApp o correo).');
    } else {
      if (what === 'code') { codeOut.focus(); codeOut.select(); }
      sayAt(createSlot, 'warn', what === 'code'
        ? 'No se pudo copiar solo: el código quedó seleccionado. Cópialo tú (Ctrl+C, o mantén pulsado y elige «Copiar»).'
        : 'No se pudo copiar el enlace. Usa «Copiar código».');
    }
  }

  async function doShare() {
    if (!issued || typeof navigator.share !== 'function') return;
    try { await navigator.share({ title: 'Código de conexión de Flujo', text: 'Código de conexión de Flujo:\n' + issued.code }); }      // solo el código: la clave nunca se comparte
    catch (e) { if (!(e && e.name === 'AbortError')) sayAt(createSlot, 'warn', 'No se pudo abrir el menú de compartir. Usa «Copiar código».'); }
  }

  /** Vuelve al formulario (y suelta de memoria el código ya abierto, que lleva el token). */
  function showJoinForm() {
    yesBtn.textContent = 'Sí, es mi cuenta: conectar';
    if (pending) pending.token = '';
    pending = null;
    confirmBox.hidden = true;
    joinForm.hidden = false;
  }

  /** Paso 1: abre el código con la clave y MUESTRA a qué cuenta y repositorio llevaría. Todavía no cambia nada. */
  async function doJoin() {
    const code = codeIn.value, key = keyIn.value;
    if (!code.trim()) { say('warn', 'Pega el código de conexión en el cuadro «Código».'); codeIn.focus(); return; }
    if (!key.trim()) { say('warn', 'Escribe la clave (12 letras y números) en el cuadro «Clave».'); keyIn.focus(); return; }
    onProgress({ message: 'Abriendo el código…' });
    let opened;
    try { opened = await openCode(code, key); }
    catch (e) {
      say('error', explain(e));
      if (e instanceof PairingError) { if (e.code === 'KEY') { keyIn.focus(); try { keyIn.select(); } catch (_) { /* nada */ } } else codeIn.focus(); }
      return;
    }
    pending = opened;
    const cur = sync.getConfig();
    const lc = (s) => String(s || '').toLowerCase();
    const when = ago(opened.createdAt);
    const label = opened.owner + '/' + opened.repo;
    let nSheets = 0;
    try { nSheets = (await store.listSheetIds()).length; } catch (_) { /* sin dato: no se muestra el aviso */ }
    const connected = sync.isConfigured();
    const sameRepo = connected && lc(cur.owner) === lc(opened.owner) && lc(cur.repo) === lc(opened.repo);
    const otherAccount = connected && lc(cur.owner) !== lc(opened.owner);
    confirmQ.replaceChildren('Conectar con ', h('b', {}, label));
    confirmInfo.textContent = (opened.branch && opened.branch !== 'main' ? 'Rama «' + opened.branch + '». ' : '') + 'Código creado el ' + fmtDate(opened.createdAt) + (when ? ' (' + when + ')' : '') + '.';
    const warn = ['Sigue solo si reconoces esta cuenta de GitHub. Si alguien más te envió este código, tus datos podrían terminar en la cuenta de esa persona.'];
    if (otherAccount) warn.unshift('¡Es OTRA cuenta distinta de la que usas ahora (' + cur.owner + ')! Este dispositivo tiene ' + plural(nSheets, 'hoja', 'hojas') + ' y al conectar se subirán TODAS a ' + label + '.');
    else if (connected && !sameRepo) warn.push('Este dispositivo está conectado ahora con ' + cur.owner + '/' + cur.repo + ': esa conexión se reemplazará.');
    if (!connected && nSheets > 0) warn.push('Este dispositivo ya tiene ' + plural(nSheets, 'hoja', 'hojas') + '. Las que existan en ' + label + ' se reemplazarán por las de allí y las que no estén allí se borrarán de aquí. Antes descarga un respaldo (Ajustes → «Descargar respaldo»).');
    confirmWarn.textContent = warn.join(' ');
    yesBtn.textContent = otherAccount ? 'Sí, cambiar a esta cuenta' : 'Sí, es mi cuenta: conectar';
    joinForm.hidden = true;
    confirmBox.hidden = false;
    confirmBox.focus();
  }

  /** Paso 2 (tras confirmar): prueba la conexión SIN guardar nada, y solo si funciona guarda la configuración y baja todos los datos. */
  async function doJoinConfirmed() {
    const p = pending;
    if (!p) { showJoinForm(); return; }
    const { owner, repo, branch, token } = p;        // copia local: la pantalla puede cerrarse mientras se prueba la conexión y vaciar «pending»
    const label = owner + '/' + repo;
    yesBtn.textContent = 'Conectando…';
    let probe;
    try {          // instancia aparte: un código viejo o ajeno no deja un token malo guardado ni pisa la conexión que ya funcionaba
      onProgress({ message: 'Probando la conexión con GitHub…' });
      probe = await new GithubSync(store, { owner, repo, branch, token, apiBase: sync.getConfig().apiBase }).testConnection();
    } catch (e) { say('error', explain(e)); showJoinForm(); return; }
    if (!probe.ok) {
      let text = probe.message, details = null;
      if (probe.code === 'BAD_TOKEN') text = 'Este código ya no sirve: el permiso de acceso que trae venció o fue cancelado en GitHub. Crea un código nuevo en el dispositivo donde ya usas Flujo.';
      else if (probe.code === 'NOT_FOUND') text = 'No se encontró «' + label + '», o el permiso del código ya no llega hasta él. Crea un código nuevo en el dispositivo donde ya usas Flujo.';
      else if (probe.code !== 'PUBLIC_REPO' && probe.code !== 'NETWORK') { details = probe.checks.slice(); for (const w of probe.warnings) details.push({ ok: false, text: w }); }
      say(probe.code === 'PUBLIC_REPO' ? 'warn' : 'error', text, details);
      showJoinForm();
      return;
    }
    if (destroyed) return;                           // la persona salió de la pantalla: no se cambia nada
    sync.setConfig({ owner, repo, branch, token });
    await sync.saveConfig();                         // el token queda solo en IndexedDB
    offerSaveToken({ owner, repo, token });
    ownerIn.value = owner; repoIn.value = repo; branchIn.value = branch; tokenIn.value = '';
    codeIn.value = ''; keyIn.value = '';             // ya cumplieron su trabajo
    showJoinForm();                                  // suelta la copia en memoria del token
    await flushLocal();
    let res;
    try { res = await sync.pullAll({ onProgress }); }
    catch (e) {
      say('error', 'La conexión con ' + label + ' quedó guardada, pero no se pudieron descargar los datos: ' + explain(e) + ' Vuelve a pegar el código y la clave para reintentar.');
      return;
    }
    const details = [...probe.warnings, ...res.warnings].map((w) => ({ ok: false, text: w }));
    if (res.empty) {
      say('warn', 'Este dispositivo quedó conectado con ' + label + ', pero el repositorio todavía no tiene datos. Súbelos desde el dispositivo donde los tienes (Ajustes → «Subir todo (primera vez)»).', details);
      return;
    }
    if (res.changed) await replaced('pull', { changed: res.downloaded, via: 'pairing' });
    if (res.conflicts.length) say('warn', plural(res.conflicts.length, 'hoja cambió', 'hojas cambiaron') + ' en GitHub y también en este dispositivo: no se pisó nada. Elige qué versión conservar en «Sincronizar».', details);
    else if (res.changed) say('ok', 'Listo: este dispositivo quedó conectado con ' + label + ' y descargó ' + plural(res.downloaded.length, 'archivo', 'archivos') + '.', details);
    else say('ok', 'Listo: este dispositivo quedó conectado con ' + label + '. Todo estaba al día.', details);
  }

  /* ------------------------------------------------------------ estado */
  async function refresh() {
    if (destroyed) return;
    syncPairMode();
    if (joinOnly) return;
    let st, est, meta;
    try { [st, est, meta] = await Promise.all([sync.status(), store.estimate(), store.getMeta()]); }
    catch (_) { return; }
    metaNames = new Map(((meta && meta.sheets) || []).map((s) => [s.id, s.name]));
    const cfg = sync.getConfig();
    const hint = root.querySelector('[data-fx="token-hint"]');
    hint.textContent = cfg.hasToken ? 'Hay un token guardado en este dispositivo. Déjalo vacío para conservarlo, o pega uno nuevo para reemplazarlo.' : 'Aún no hay token guardado.';
    tokenIn.placeholder = cfg.hasToken ? '•••••••• (guardado)' : 'github_pat_…';
    forgetBtn.hidden = !cfg.hasToken;

    const row = (dt, dd, cls) => [h('dt', {}, dt), h('dd', { class: cls || '' }, dd)];
    const items = [];
    items.push(...row('Repositorio', cfg.owner && cfg.repo ? cfg.owner + '/' + cfg.repo + ' · rama ' + cfg.branch : 'Sin configurar'));
    items.push(...row('Última sincronización', st.lastSync ? fmtDate(st.lastSync.at) + ' (' + ago(st.lastSync.at) + ') · ' + (KIND[st.lastSync.kind] || 'sincronización') : 'Nunca'));
    const unsaved = engine && engine.dirty ? [...engine.dirty].filter((s) => s !== 'meta').length : 0;
    const pendText = st.pendingCount
      ? plural(st.pendingCount, 'hoja', 'hojas') + ': ' + st.pendingNames.slice(0, 6).join(', ') + (st.pendingCount > 6 ? ' y ' + (st.pendingCount - 6) + ' más' : '')
      : 'Nada pendiente';
    items.push(...row('Pendiente de subir', pendText + (unsaved ? ' (+ ' + plural(unsaved, 'hoja', 'hojas') + ' con cambios aún no guardados localmente)' : ''), st.pendingCount ? 'fx-status__warn' : ''));
    if (st.lastError) items.push(...row('Último error', st.lastError.message + ' · ' + ago(st.lastError.at), 'fx-status__err'));
    items.push(...row('Almacenamiento local', (store.persisted === true ? 'Persistente (el navegador no lo borra solo)' : store.persisted === false ? 'No garantizado: el navegador podría borrarlo si le falta espacio. Descarga respaldos y sincroniza con GitHub.' : 'Sin comprobar') +
      (est.usage ? ' · usa ' + fmtBytes(est.usage) : ''), store.persisted === false ? 'fx-status__warn' : ''));
    statusList.replaceChildren(...items);

    // conflictos
    const prevScroll = conflictsBox.scrollTop;
    conflictsBox.replaceChildren(...st.conflicts.map((c) => h('div', { class: 'fx-conflict', 'data-sid': c.sid },
      h('div', { class: 'fx-conflict__title' }, '«' + c.name + '» cambió en GitHub y también en este dispositivo'),
      h('p', { class: 'fx-conflict__text' }, 'Elige qué versión conservar. Hasta que decidas no se sube ni se pisa nada de esta hoja.'),
      h('div', { class: 'fx-actions' },
        btn('Quedarme con la mía (reemplaza la de GitHub)', 'fx-btn--primary', () => doResolve(c.sid, 'local'), { 'data-choice': 'local', 'data-sid': c.sid, disabled: busy }),
        btn('Usar la de GitHub (descarta la mía)', '', () => doResolve(c.sid, 'remote'), { 'data-choice': 'remote', 'data-sid': c.sid, disabled: busy })))));
    conflictsBox.scrollTop = prevScroll;
    const cfgOk = sync.isConfigured();
    for (const b of [pushBtn, pullBtn, initialBtn]) b.title = cfgOk ? '' : 'Primero guarda usuario, repositorio y token';
  }

  refresh();
  timer = setInterval(() => { if (!root.isConnected) { api.destroy(); return; } if (!busy) refresh(); }, 5000);
  let evTimer = null;
  const onSaverStatus = () => { clearTimeout(evTimer); evTimer = setTimeout(() => { if (!busy) refresh(); }, 400); };
  if (autosaver && typeof autosaver.addEventListener === 'function') autosaver.addEventListener('status', onSaverStatus);

  const api = {
    el: root,
    refresh,
    /** Llegó un enlace «#conectar=…»: el código queda pegado en «Código», el bloque a la vista y el foco en «Clave». */
    setPairingCode(code) {
      if (!pairCard || destroyed) return;
      codeIn.value = String(code == null ? '' : code);
      keyIn.value = '';
      showJoinForm();
      joinOpen = true;
      syncPairMode();
      setTimeout(() => {       // más tarde: el contenedor puede añadirse al documento justo después de montar
        if (destroyed || !root.isConnected) return;
        try { joinBox.scrollIntoView({ block: 'start' }); } catch (_) { /* sin scrollIntoView */ }     // el título, el código y la clave a la vista
        try { keyIn.focus({ preventScroll: true }); } catch (_) { keyIn.focus(); }
      }, 80);
    },
    /** Usa una conexión recuperada (usuario, repositorio, token): la prueba y, en el primer uso, baja los datos. */
    useCredential,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer); clearTimeout(evTimer);
      if (autosaver && typeof autosaver.removeEventListener === 'function') autosaver.removeEventListener('status', onSaverStatus);
      wipePair();                                        // el código y la clave no sobreviven a la pantalla
      showJoinForm();
      codeIn.value = ''; keyIn.value = '';
      root.remove();
    }
  };
  if (pairingCode) api.setPairingCode(pairingCode);
  return api;
}
