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
 * Clases CSS con prefijo "fx-" (ver css/sync.css). Todo el texto dinámico se inserta con textContent (sin innerHTML).
 * El token nunca se vuelve a escribir en el DOM: el campo queda vacío tras guardar (vacío = conservar el guardado).
 */

import { AutoSaver, StoreError, Store } from './store.js';
import { GithubError } from './sync-github.js';

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

export function mountSyncSettings(containerEl, { store, sync, engine = null, autosaver = null, onBundleReplaced = null } = {}) {
  if (!containerEl) throw new TypeError('mountSyncSettings: falta el contenedor.');
  if (!store || !sync) throw new TypeError('mountSyncSettings: faltan store y sync.');
  const uid = 'fx' + (++uidCounter);
  let busy = false;
  let destroyed = false;
  let metaNames = new Map();
  let timer = null;

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
  const actionBtns = [saveBtn, testBtn, forgetBtn, pushBtn, pullBtn, initialBtn, backupBtn, restoreBtn];

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

  const root = h('section', { class: 'fx-sync', 'aria-labelledby': uid + '-title' },
    h('h2', { class: 'fx-title', id: uid + '-title' }, 'Sincronización con GitHub'),
    h('p', { class: 'fx-lead' }, 'Tus datos se guardan siempre en este dispositivo. Si quieres, además se copian a un repositorio ',
      h('b', {}, 'privado'), ' de tu cuenta de GitHub para tenerlos iguales en tu computador y tu celular, y con respaldo.'),

    h('div', { class: 'fx-card' },
      h('h3', { class: 'fx-h3' }, 'Conexión'),
      h('div', { class: 'fx-grid' },
        field('Usuario u organización', ownerIn),
        field('Repositorio', repoIn, 'Debe ser privado. Por omisión: flujo-datos.'),
        field('Rama', branchIn),
        h('div', { class: 'fx-field fx-field--token' },
          h('label', { class: 'fx-label', for: tokenIn.id }, 'Token de acceso'),
          h('div', { class: 'fx-row' }, tokenIn, toggleBtn),
          h('span', { class: 'fx-hint', 'data-fx': 'token-hint' }))),
      h('p', { class: 'fx-note' },
        h('b', {}, 'Seguridad: '), 'el token se guarda solo en este dispositivo (en el almacenamiento del navegador) y únicamente se envía a GitHub. ',
        'No lo compartas ni lo pegues en otros sitios. Si pierdes un dispositivo, revoca el token en GitHub ',
        '(Settings → Developer settings → Fine-grained tokens).'),
      h('div', { class: 'fx-actions' }, testBtn, saveBtn, forgetBtn)),

    h('div', { class: 'fx-card' },
      h('h3', { class: 'fx-h3' }, 'Sincronizar'),
      h('div', { class: 'fx-actions' }, pushBtn, pullBtn, initialBtn),
      progBox,
      msgBox,
      conflictsBox,
      statusList),

    h('details', { class: 'fx-details' },
      h('summary', { class: 'fx-details__summary' }, 'Cómo crear el token'),
      h('div', { class: 'fx-details__body' },
        h('p', {}, h('b', {}, 'Antes: '), 'crea el repositorio privado. En GitHub pulsa «+» (arriba a la derecha) → ', h('b', {}, 'New repository'),
          '. Nombre: ', h('b', {}, 'flujo-datos'), '. Marca ', h('b', {}, 'Private'), '. No hace falta README ni otros archivos (puede quedar vacío). Pulsa ', h('b', {}, 'Create repository'), '.'),
        h('ol', { class: 'fx-steps' }, steps.map((s) => h('li', {}, s))),
        h('p', {}, 'Cuando el token venza (1 año), repite los pasos 4 a 9 y pega el nuevo: no se pierde ningún dato. ',
          'En cada dispositivo (computador, celular…) hay que pegar el token una sola vez.'))),

    h('div', { class: 'fx-card' },
      h('h3', { class: 'fx-h3' }, 'Respaldo local'),
      h('p', { class: 'fx-note' }, 'Un archivo .json con todo el libro (no incluye el token). Restaurarlo reemplaza los datos de este dispositivo.'),
      h('div', { class: 'fx-actions' }, backupBtn, restoreBtn, fileIn)));

  containerEl.append(root);

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
  };
  const clearMsg = () => { msgBox.hidden = true; msgBox.replaceChildren(); };
  const explain = (e) => {
    if (e instanceof GithubError || e instanceof StoreError) {
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
  async function run(fn) {
    if (busy || destroyed) return;
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
  }

  async function doForget() {
    if (!window.confirm('¿Borrar el token de este dispositivo? Tendrás que pegarlo de nuevo para sincronizar. Tus datos locales no se tocan.')) return;
    await sync.clearToken();
    say('info', 'El token se borró de este dispositivo.');
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
    say('ok', 'Respaldo generado (' + fmtBytes(blob.size) + '). Guárdalo en un lugar seguro: contiene todos tus datos.');
  }

  async function doRestore(file) {
    let parsed;
    try { parsed = Store.parseBackup(await file.text()); }
    catch (e) { say('error', explain(e)); return; }
    const n = parsed.meta.sheets.length;
    if (!window.confirm('Se REEMPLAZARÁN todos los datos de este dispositivo por los del respaldo «' + file.name + '» (' + n + ' hojas).\n\n' +
      'Los cambios no guardados en pantalla se perderán. ¿Continuar?')) return;
    if (engine && engine.dirty && typeof engine.dirty.clear === 'function') engine.dirty.clear();   // lo que hay en memoria se descarta a propósito
    await store.replaceAll(parsed);
    let pending = null;
    if (sync.isConfigured()) { try { pending = (await sync.rebuildPending()).pending; } catch (_) { /* sin conexión: no es necesario para restaurar */ } }
    await replaced('restore', {});
    say('ok', 'Respaldo restaurado: ' + plural(n, 'hoja', 'hojas') + '.' + (pending && pending.length ? ' Hay ' + plural(pending.length, 'archivo', 'archivos') + ' distintos de GitHub, pendientes de subir.' : ''));
  }

  /* ------------------------------------------------------------ estado */
  async function refresh() {
    if (destroyed) return;
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
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer); clearTimeout(evTimer);
      if (autosaver && typeof autosaver.removeEventListener === 'function') autosaver.removeEventListener('status', onSaverStatus);
      root.remove();
    }
  };
  return api;
}
