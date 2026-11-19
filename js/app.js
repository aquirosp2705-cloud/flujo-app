/* app.js — arranque, navegación y pantallas base de Flujo.
 * Los módulos grandes (store, sync-github, settings-ui, ledger, dashboard, quick, archive, export, pwa) se cargan de forma opcional:
 * si alguno falta, la app sigue funcionando sin esa pieza. */
import { Engine, loadBundle } from './engine.js';
import { SheetGrid } from './grid.js';
import * as ui from './ui.js';
import * as catalog from './catalog.js';
import { todaySerial } from './format.js';

const { el, toast } = ui;
const $ = (s, r = document) => r.querySelector(s);
const optional = async (p) => { try { return await import(p); } catch (e) { console.warn('[módulo opcional no disponible]', p, e.message); return null; } };
const VERSION = '33';

const state = { engine: null, store: null, sync: null, saver: null, archive: null, mods: {}, screenObj: null, grid: null, showHidden: false, saveStatus: 'idle', online: navigator.onLine };

/* ------------------------------------------------------------------ contexto compartido con los módulos */
const ctx = {
  get engine() { return state.engine; }, get store() { return state.store; }, get sync() { return state.sync; }, get saver() { return state.saver; },
  /** Archivo mensual (js/archive.js): snapshot({key,label,source,replace}) · has(key) · list() · open(key) · info(key) · uploadPending() · resolveConflict(key, 'local'|'remote'). null si el módulo no cargó. */
  get archive() { return state.archive; },
  ui, catalog, today: todaySerial,
  toast, confirm: ui.confirmDialog, modal: ui.openModal, busy: ui.busy,
  navigate(route) { location.hash = '#/' + String(route).replace(/^#?\/?/, ''); },
  openSheet(sid, { r, c, end, nuevo } = {}) {
    const q = new URLSearchParams(); if (r != null) q.set('r', r); if (c != null) q.set('c', c); if (end) q.set('end', 1); if (nuevo) q.set('nuevo', 1);
    ctx.navigate('hoja/' + sid + (q.toString() ? '?' + q : ''));
  },
  /** Los módulos llaman a esto después de escribir en el motor. */
  changed(sids = null, src = '') {
    const eng = state.engine;
    for (const s of sids || []) eng.dirty.add(s);
    if (state.saver) state.saver.markDirty(); else if (state.store) scheduleFallbackSave();
    updatePill();
    if (src !== 'grid' && state.screenObj && state.screenObj.refresh) { try { state.screenObj.refresh(); } catch (e) { console.warn(e); } }
  },
};
window.__flujo = { ctx, state };

/* ------------------------------------------------------------------ arranque */
function setBoot(msg, pct) {
  const m = $('#boot-msg'), b = $('#boot-bar');
  if (m) m.textContent = msg; if (b && pct != null) b.style.width = pct + '%';
}

async function tryLocalData() {
  if (new URLSearchParams(location.search).has('nolocal')) return null;      // pruebas: simula un dispositivo nuevo sin carpeta data/
  try {
    const r = await fetch('data/meta.json', { cache: 'no-store' });
    if (!r.ok) return null;
    return await loadBundle('data/');
  } catch (e) { return null; }
}

/** Enlace de conexión «…/#conectar=CÓDIGO»: lo saca de la URL (barra de direcciones e historial: replaceState no añade entradas
 *  ni dispara «hashchange») y devuelve el hash original, o null si la URL no traía uno. El código nunca va en «?…». */
function stripConnectHash() {
  const h = location.hash;
  if (!/^#conectar=/.test(h)) return null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sin historial: no hay más que hacer */ }
  return h;
}
const earlyConnectHash = stripConnectHash();     // en cuanto se evalúa este módulo: antes de cargar nada más

/** Guarda en state.pairingCode el código que llegó por enlace hasta que la pantalla de «Ya tengo un código» lo recoja. Devuelve el código o null. */
function takePairingFromUrl(hash) {
  const h = hash || stripConnectHash();
  if (!h) return null;
  const P = state.mods.pairing;
  let code = null;
  try { code = P && typeof P.codeFromHash === 'function' ? P.codeFromHash(h) : null; } catch (e) { code = null; }
  if (code) state.pairingCode = code;
  return code;
}
/** Entrega (una sola vez) el código que llegó por enlace. */
function takePendingPairing() { const c = state.pairingCode || null; state.pairingCode = null; return c; }

/**
 * Una sola ventana de Flujo a la vez. Dos ventanas con los datos cargados en memoria en momentos distintos se pisarían al guardar: la que lleva más tiempo
 * abierta escribiría sus hojas viejas encima de lo que guardó la otra (por ejemplo, desharía un cierre de mes sin avisar). Se usan Web Locks (Chrome, Edge,
 * Firefox, Safari 15.4+): quien llega después ESPERA el bloqueo, sin límite (al recargar, la página vieja lo suelta un instante después de que la nueva lo
 * pide); si pasan unos segundos sin conseguirlo muestra el aviso «ya está abierto en otra ventana» y arranca sola en cuanto la otra se cierra.
 * Sin Web Locks no se puede vigilar y se sigue como antes; «?multi» (pruebas) lo desactiva.
 */
const WINDOW_LOCK = 'flujoweb-ventana:' + new URL('./', location.href).pathname;
function showAnotherWindowScreen() {
  document.title = 'Flujo — ya está abierto';
  setBoot('Flujo ya está abierto en otra ventana o pestaña.', 0);
  const bar = $('.bar', $('#boot')); if (bar) bar.hidden = true;
  const extra = $('#boot-extra'); if (!extra) return;
  extra.innerHTML = '';
  extra.append(el('p', { class: 'muted small', style: { textAlign: 'left', marginTop: '14px' }, text: 'Solo puede haber una a la vez, para no pisar tus datos: la que se abrió antes guardaría lo suyo encima de los cambios de esta (por ejemplo, desharía un cierre de mes). Cierra la otra (en su menú: Ajustes → «Cerrar Flujo»); esta se abrirá sola en cuanto la cierres.' }));
}
function hideAnotherWindowScreen() {
  document.title = 'Flujo';
  const extra = $('#boot-extra'); if (extra) extra.innerHTML = '';
  const bar = $('.bar', $('#boot')); if (bar) bar.hidden = false;
  setBoot('Cargando módulos…', 5);
}
function claimSingleWindow() {
  if (!navigator.locks || typeof navigator.locks.request !== 'function' || new URLSearchParams(location.search).has('multi')) return Promise.resolve();
  return new Promise((resolve) => {
    let granted = false, shown = false, timer = 0;
    const go = () => { if (granted) return; granted = true; clearTimeout(timer); if (shown) hideAnotherWindowScreen(); resolve(); };
    timer = setTimeout(() => { if (!granted) { shown = true; showAnotherWindowScreen(); } }, 3500);
    try {
      // se concede enseguida si no hay otra ventana, o cuando la otra se cierra; se mantiene mientras esta página siga abierta (el callback nunca termina)
      navigator.locks.request(WINDOW_LOCK, () => { go(); return new Promise(() => { }); }).catch(() => go());      // un error inesperado: se sigue sin vigilancia
    } catch (e) { go(); }
  });
}

async function boot() {
  applyTheme();
  setBoot('Cargando módulos…', 5);
  await claimSingleWindow();
  const names = ['store', 'sync-github', 'settings-ui', 'pairing', 'recover', 'ledger', 'dashboard', 'quick', 'archive', 'export', 'pwa', 'invest', 'rubros'];
  const mods = await Promise.all(names.map((n) => optional('./' + n + '.js')));
  names.forEach((n, i) => { state.mods[n] = mods[i]; });
  takePairingFromUrl(earlyConnectHash);      // el código que traía la URL al abrir (ya quitado de la barra de direcciones)
  if (state.mods.pwa && state.mods.pwa.initPwa) {
    // avisos de «Instalar la app» y «Hay una versión nueva — Actualizar»; antes de recargar se guardan los cambios pendientes
    try {
      state.mods.pwa.initPwa({
        offlineNotice: false,
        beforeReload: async () => { if (state.saver) { await state.saver.flush(); if (state.saver.hasUnsaved) throw new Error('No se pudieron guardar los cambios'); } },
        onReloadBlocked: () => toast('No se pudieron guardar tus cambios en este dispositivo, así que no se actualizó la app todavía (no se pierde nada). Inténtalo de nuevo o descarga un respaldo en Ajustes.', { type: 'error', ms: 12000 }),
      });
    } catch (e) { console.warn(e); }
  }
  let bundle = null;
  if (state.mods.store) {
    try { state.store = new state.mods.store.Store(); await state.store.open(); bundle = await state.store.loadBundle(); }
    catch (e) { console.error(e); state.store = null; toast('No se pudo abrir el almacenamiento local: ' + e.message, { type: 'error', ms: 8000 }); }
  }
  const S = state.mods['sync-github'];
  if (state.store && S) { try { state.sync = await S.GithubSync.fromStore(state.store); applyUrlConfig(); } catch (e) { console.warn('[sync] no disponible', e); state.syncLoadError = e; } }
  if (bundle && syncOn() && navigator.onLine) bundle = await preSync(bundle);     // trae lo que otro dispositivo haya guardado ANTES de armar el motor
  if (!bundle && state.store && syncOn() && navigator.onLine) bundle = await resumeDownload();   // conectado pero sin datos: no se vuelve a pedir la clave
  if (!bundle) bundle = await firstRun();
  if (state.store) {      // hojas que meta.json ya no lista (borradas desde otro dispositivo): se quitan también de este
    try { for (const id of await state.store.pruneOrphans()) delete bundle.sheetDatas[id]; } catch (e) { console.warn('[store] no se pudieron limpiar las hojas borradas:', e); }
  }
  await startWithBundle(bundle);
}

/** Enlace de configuración: ?owner=USUARIO&repo=flujo-datos[&branch=main] rellena esos campos (nunca el token) para no teclearlos en el celular. */
function applyUrlConfig() {
  if (!state.sync || state.sync.isConfigured()) return;
  const q = new URLSearchParams(location.search);
  const ok = (v) => /^[A-Za-z0-9_.-]{1,100}$/.test(v);
  const owner = (q.get('owner') || '').trim(), repo = (q.get('repo') || '').trim(), branch = (q.get('branch') || '').trim();
  const cur = state.sync.getConfig(), patch = {};
  if (owner && ok(owner) && !cur.owner) patch.owner = owner;
  if (repo && ok(repo) && !cur.repo) patch.repo = repo;
  if (branch && ok(branch)) patch.branch = branch;
  if (Object.keys(patch).length) { try { state.sync.setConfig(patch); } catch (e) { console.warn(e); } }
}

/** Al abrir la app: si hay GitHub configurado, baja primero los cambios de otros dispositivos (máx. 9 s; si falla, se sigue con lo local). */
async function preSync(bundle) {
  setBoot('Buscando cambios en GitHub…', 20);
  try {
    const res = await state.sync.pullAll({ timeoutMs: 9000 });          // el propio módulo aborta la descarga a los 9 s (así no escribe tarde sobre un motor ya armado)
    if (res && res.conflicts && res.conflicts.length) state.startConflicts = res.conflicts;
    // bajó lo último sin conflictos: este dispositivo puede hacer ajustes únicos del libro (p. ej. el patrimonio) sin pisar a otro
    state.presyncOk = !!(res && res.ok !== false && !(res.conflicts && res.conflicts.length) && !res.timedOut && !res.aborted && (!res.failed || !res.failed.length));
    if (res && res.changed) { const b = await state.store.loadBundle(); if (b) return b; }
  } catch (e) { console.warn('[sync] no se pudo consultar GitHub al iniciar:', e && e.message); }
  return bundle;
}

/** El dispositivo ya está conectado pero no tiene datos: la primera descarga se cortó (p. ej. se cerró la app en el iPhone mientras bajaba).
 *  Se baja todo con la conexión guardada en vez de volver a la pantalla de primer uso (que pediría la clave otra vez). */
async function resumeDownload() {
  setBoot('Este dispositivo ya está conectado: descargando tus datos…', 20);
  try {
    const res = await state.sync.pullAll({
      timeoutMs: 180000,
      onProgress: (p) => { if (p && p.total > 0 && p.phase !== 'tree') setBoot('Descargando tus datos… ' + Math.min(100, Math.round((100 * (p.done || 0)) / p.total)) + '%', 20 + Math.round((15 * (p.done || 0)) / p.total)); },
    });
    if (res && res.conflicts && res.conflicts.length) state.startConflicts = res.conflicts;
    const b = await state.store.loadBundle();
    if (b) return b;
  } catch (e) { console.warn('[sync] no se pudo descargar con la conexión guardada:', e && e.message); }
  return null;
}

async function firstRun() {
  setBoot('Buscando datos…', 15);
  const local = await tryLocalData();
  if (local) { if (state.store) { try { await state.store.replaceAll(local); } catch (e) { console.warn(e); } } return local; }
  return new Promise((resolve) => showOnboarding(resolve));
}

function showOnboarding(resolve) {
  $('#boot-msg').textContent = 'Primera vez en este dispositivo: trae tus datos.';
  $('.bar', $('#boot')).hidden = true;
  const extra = $('#boot-extra'); extra.innerHTML = '';
  let joinUi = null;
  // si pegan un enlace «#conectar=…» con esta pantalla ya abierta, el código se coloca solo en el bloque «Ya tengo un código»
  const onHash = () => { if (takePairingFromUrl() && joinUi && joinUi.setPairingCode) joinUi.setPairingCode(takePendingPairing()); };
  window.addEventListener('hashchange', onHash);
  const finish = async (bundle) => {
    if (state.store) { try { await state.store.replaceAll(bundle); } catch (e) { console.warn(e); } }
    window.removeEventListener('hashchange', onHash);
    try { if (joinUi) joinUi.destroy(); } catch (e) { /* ya no se ve: solo se suelta lo escrito */ }
    extra.innerHTML = ''; $('.bar', $('#boot')).hidden = false; resolve(bundle);
  };
  const S = state.mods['sync-github'], U = state.mods['settings-ui'], R = state.mods.recover;
  const canSync = !!(S && U && state.store);
  const P = state.mods.pwa, iosHelp = !!(P && P.needsIosInstallHelp && P.needsIosInstallHelp());
  const gh = el('div', { class: 'card', style: { textAlign: 'left', marginTop: '14px' } });
  const joinHost = el('div', { style: { textAlign: 'left', marginTop: '14px' } });     // «Ya tengo un código de conexión»: la opción principal
  extra.append(...[
    iosHelp ? el('div', { class: 'banner', style: { textAlign: 'left', marginTop: '14px' }, text: 'En iPhone o iPad: mejor toca Compartir → «Añadir a pantalla de inicio» y abre Flujo desde su ícono (Safari borra los datos de las páginas que no están instaladas). Si entras aquí y luego la instalas, la app del ícono empieza vacía: ahí vuelves a escribir tu clave.' }) : null,
    el('p', { class: 'muted small', style: { textAlign: 'left', margin: '14px 0 0' }, text: 'Si ya usabas Flujo en este navegador y ves esta pantalla, es posible que el navegador haya borrado los datos de la app. Tus datos siguen a salvo en GitHub: conecta tu cuenta y se recuperan.' }),
    canSync ? joinHost : null,
    canSync ? el('p', { class: 'muted small', style: { margin: '18px 0 0' }, text: '¿No puedes entrar así? Hay otras formas de traer tus datos (con más pasos):' }) : null,
    el('div', { class: 'row', style: { justifyContent: 'center', marginTop: canSync ? '10px' : '12px' } },
      el('button', { class: canSync ? 'btn' : 'btn primary', text: 'Conectar con mi cuenta de GitHub (más pasos)', onclick: (e) => { gh.hidden = !gh.hidden; e.currentTarget.setAttribute('aria-expanded', String(!gh.hidden)); if (!gh.hidden) gh.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }),
      (() => {
        const f = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
        f.addEventListener('change', async () => {
          const file = f.files[0]; if (!file) return;
          try {
            const obj = JSON.parse(await file.text());
            if (!obj.meta || !obj.sheetDatas) throw new Error('El archivo no es un respaldo de Flujo');
            await finish({ meta: obj.meta, sheetDatas: obj.sheetDatas });
          } catch (e) { toast('No se pudo leer el respaldo: ' + e.message, { type: 'error' }); }
        });
        return el('span', {}, f, el('button', { class: 'btn', text: 'Cargar un respaldo (archivo)', onclick: () => f.click() }));
      })()),
    gh].filter(Boolean));
  gh.hidden = true;
  if (R && typeof R.storageReport === 'function') {      // detalles técnicos para entender qué pasó si los datos desaparecieron
    const diag = el('details', { class: 'muted small', style: { textAlign: 'left', marginTop: '14px' } }, el('summary', { text: 'Detalles técnicos (para saber qué pasó)' }));
    const box = el('div', {}); diag.append(box); extra.append(diag);
    R.storageReport().then((rep) => { box.replaceChildren(...R.describeReport(rep).map((t) => el('p', { style: { margin: '4px 0' }, text: t }))); }).catch(() => { /* sin detalles */ });
  }
  if (canSync) {
    if (!state.sync) state.sync = new S.GithubSync(state.store, {});
    applyUrlConfig();
    const common = { store: state.store, sync: state.sync, onBundleReplaced: (b) => finish(b) };
    if (typeof U.mountPairingJoin === 'function') joinUi = U.mountPairingJoin(joinHost, { ...common, code: takePendingPairing() });
    const ghUi = U.mountSyncSettings(gh, { ...common, engine: null, pairing: false });
    if (R && typeof R.findToken === 'function') {      // si el navegador guardó la conexión en su administrador de contraseñas: reconecta y trae los datos sin pedir nada
      R.findToken({ silent: true }).then((c) => {
        if (!c || !ghUi || typeof ghUi.useCredential !== 'function' || !$('#boot')) return undefined;
        gh.hidden = false;
        $('#boot-msg').textContent = 'Encontré tu conexión guardada en el navegador: trayendo tus datos…';
        return ghUi.useCredential(c);
      }).catch(() => { /* sin conexión guardada: la persona sigue con las opciones de la pantalla */ });
    }
  } else gh.append(el('p', { class: 'muted', text: 'La sincronización con GitHub no está disponible en esta versión.' }));
}

async function startWithBundle(bundle) {
  setBoot('Preparando el motor de cálculo (unos segundos)…', 40);
  await ui.nextFrame(); await ui.nextFrame();
  const t0 = performance.now();
  state.engine = new Engine(bundle.meta, bundle.sheetDatas);
  state.buildMs = performance.now() - t0;
  catalog.setCatalog(bundle.meta.catalog);
  setBoot('Listo', 100);
  const S = state.mods['sync-github'], St = state.mods.store;
  if (St && state.store) {
    try {
      state.saver = new St.AutoSaver(state.engine, state.store, { delayMs: 500, onStatus: (s, info) => { state.saveStatus = s; updatePill(); if (s === 'saved') afterSaved(); } });
    } catch (e) { console.warn('AutoSaver no disponible', e); }
  }
  if (S && state.store && !state.sync) { try { state.sync = new S.GithubSync(state.store, {}); } catch (e) { console.warn(e); } }
  // v30/v31: el patrimonio cuenta las inversiones sin la reserva (una sola vez; se guarda y se sube como un cambio más de CONSOL). Solo en un
  // dispositivo conectado que ACABA de bajar lo último de GitHub sin conflictos: así nunca choca con el mismo cambio hecho en otro
  // dispositivo (el primero que abre lo hace y los demás lo bajan ya hecho).
  const Inv = state.mods.invest;
  if (Inv && Inv.migratePatrimonio && syncOn() && state.presyncOk && navigator.onLine) {
    try { const mig = Inv.migratePatrimonio(state.engine); if (mig) { state.patrimonioMigrado = mig; ctx.changed(['s01']); } }
    catch (e) { console.warn('[patrimonio] no se pudo actualizar la fórmula de inversiones:', e); }
  }
  const Ar = state.mods.archive;                // archivo mensual: ctx.archive (lo usa también el cierre de mes)
  if (Ar && Ar.createArchive) {
    try { state.archive = Ar.createArchive({ getEngine: () => state.engine, getStore: () => state.store, getSync: () => state.sync }); }
    catch (e) { console.warn('[archivo] no disponible:', e && e.message); }
  }
  $('#boot').remove(); $('#app').hidden = false;
  $('#side-ver').textContent = 'Versión ' + VERSION;
  const btnClose = $('#btnClose'); if (btnClose) btnClose.addEventListener('click', closeProgram);
  // llegó un enlace de conexión a un dispositivo que ya tiene datos: se abre Ajustes (donde está el bloque de pegar el código)
  if (state.pairingCode) { try { history.replaceState(null, '', location.pathname + location.search + '#/ajustes'); } catch (e) { /* */ } }
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('online', () => { state.online = true; updatePill(); autoSync(); });
  window.addEventListener('offline', () => { state.online = false; updatePill(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { autoSync(); checkPolicyAlert(); }      // la app quedó abierta y vuelve otro día: se revisan las pólizas
    else if (document.visibilityState === 'hidden') { clearTimeout(pushTimer); autoPush(); }   // el celular se bloquea: se intenta subir lo pendiente antes de que suspenda la app
  });
  setInterval(() => { if (document.visibilityState === 'visible') { autoSync(); checkPolicyAlert(); } }, 5 * 60 * 1000);   // la ventana puede quedar visible de un día a otro
  window.addEventListener('focus', () => checkPolicyAlert());
  $('#syncPill').addEventListener('click', onPill);
  if (!state.store) toast('Sin almacenamiento local: los cambios NO se guardarán al cerrar.', { type: 'warn', ms: 8000 });
  await route();
  updatePill();
  if (state.patrimonioMigrado) toast('Patrimonio actualizado: ahora cuenta tus inversiones sin la reserva' + (typeof state.patrimonioMigrado.after === 'number' ? ' (' + ui.money(state.patrimonioMigrado.after) + ')' : '') + '.', { type: 'ok', ms: 7000 });
  checkPolicyAlert();
  if (state.startConflicts && state.startConflicts.length) toast('Hay ' + state.startConflicts.length + ' hoja(s) en conflicto con GitHub: revisa Ajustes → Sincronización.', { type: 'warn', ms: 9000 });
  if (syncOn()) { autoPush(); autoArchive(); }
}

/* ------------------------------------------------------------------ aviso de pólizas por vencer */
/** Al abrir la app (y al volver a primer plano en otro día): si alguna póliza vence en 5 días o menos, o ya venció, sale una ventana. */
function checkPolicyAlert() {
  const I = state.mods.invest;
  if (!I || !I.duePolicies || !I.showDueAlert || !state.engine || state.closed || state.closing) return;
  const today = ctx.today();
  if (state.policyAlertDay === today) return;
  if (document.querySelector('.modal-back')) return;          // hay otra ventana abierta (p. ej. el atajo «Anotar»): se avisa después, al cerrarla y cambiar de pantalla
  state.policyAlertDay = today;
  let list = [];
  try { list = I.duePolicies(state.engine, { today }); } catch (e) { console.warn('[pólizas]', e); return; }
  if (!list.length) return;
  const Q = state.mods.quick;
  I.showDueAlert(ctx, list, { onRenew: Q && Q.mountForm ? () => ctx.navigate('reg/poliza') : null });
}

/* ------------------------------------------------------------------ cerrar el programa */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tiempo agotado')), ms))]);

/** Pantalla final cuando el navegador no deja que la app cierre su propia pestaña: nada queda corriendo y se explica cómo cerrarla. */
function showClosedScreen(note) {
  document.title = 'Flujo — cerrado';
  document.body.replaceChildren(el('main', { class: 'closed', role: 'status' },
    el('h1', { text: 'Flujo está cerrado' }),
    el('p', { text: 'Tus cambios quedaron guardados.' + (note ? ' ' + note : '') }),
    el('p', { class: 'muted', text: 'Ya puedes cerrar esta pestaña o ventana (Ctrl+W).' }),
    el('button', { class: 'btn primary', type: 'button', text: 'Volver a abrir Flujo', onclick: () => location.reload() })));
}

/**
 * «Cerrar Flujo»: guarda lo pendiente (en este dispositivo y, si hay conexión, en GitHub), deja de trabajar en segundo plano y cierra la ventana.
 * Una ventana de la app instalada se cierra sola; una pestaña normal no puede cerrarla la página (lo impide el navegador): en ese caso queda
 * la pantalla «Flujo está cerrado», sin nada corriendo.
 */
async function closeProgram() {
  if (state.closing || state.closed) return;
  state.closing = true;
  let note = '', unsaved = false;
  try {
    await ui.busy('Guardando tus cambios antes de cerrar…', async () => {
      try { if (state.saver) await state.saver.flush(); } catch (e) { console.warn('[cerrar] guardado local', e); }
      // si lo editado no quedó guardado en este dispositivo (cuota llena, almacenamiento bloqueado…), cerrar lo perdería: no se cierra
      unsaved = !!(state.saver && state.saver.hasUnsaved) || !!(state.engine && state.engine.dirty && state.engine.dirty.size > 0);
      if (unsaved) return;
      if (syncOn() && state.online) {
        try { await withTimeout(state.sync.pushDirty({}), 12000); } catch (e) { console.warn('[cerrar] subida', e && e.message); }
        try { if (state.archive) await withTimeout(state.archive.uploadPending({}), 6000); } catch (e) { /* se sube la próxima vez */ }
      }
      if (syncOn()) {
        try { const st = await state.sync.status(); if (st && st.pendingCount) note = 'Quedan ' + st.pendingCount + (st.pendingCount === 1 ? ' hoja' : ' hojas') + ' por subir a GitHub: se subirán la próxima vez que abras Flujo.'; } catch (e) { /* sin dato */ }
      }
    });
  } catch (e) { console.warn('[cerrar]', e); }
  if (unsaved) {
    state.closing = false;
    toast('No se pudieron guardar tus cambios en este dispositivo, así que NO se cerró Flujo. Inténtalo de nuevo; si sigue igual, descarga un respaldo en Ajustes antes de cerrar.', { type: 'error', ms: 14000 });
    return;
  }
  state.closed = true;           // los temporizadores y los avisos de segundo plano dejan de actuar
  state.closing = false;
  try { window.close(); } catch (e) { /* el navegador no lo permite */ }
  setTimeout(() => { if (!window.closed) showClosedScreen(note); }, 450);
}

/* ------------------------------------------------------------------ guardado y sincronización */
let fbTimer = 0;
function scheduleFallbackSave() {
  clearTimeout(fbTimer);
  fbTimer = setTimeout(async () => {
    try {
      for (const sid of [...state.engine.dirty]) {
        if (sid === 'meta') await state.store.saveMeta(state.engine.meta); else await state.store.saveSheet(sid, state.engine.exportSheet(sid));
        state.engine.dirty.delete(sid);
      }
    } catch (e) { console.warn(e); }
  }, 1500);
}
let pushTimer = 0;
function syncOn() { try { return !!(state.sync && state.sync.isConfigured()); } catch (e) { return false; } }
function afterSaved() {
  if (!syncOn()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => autoPush(), 4000);                   // se sube unos segundos después del último cambio
}
async function autoPush() {
  if (state.closed || !syncOn() || !state.online || state.pushing) return;
  state.pushing = true; updatePill();
  try {
    if (state.saver) await state.saver.flush();
    const res = await state.sync.pushDirty({});
    if (res && res.conflicts && res.conflicts.length) toastConflicts(res.conflicts.length);
  } catch (e) { console.warn('push', e); toast('No se pudo subir a GitHub: ' + (e && e.message || e), { type: 'error' }); }
  finally { state.pushing = false; updatePill(); }
}
/** Mientras la app está abierta: baja lo que otro dispositivo haya guardado. Si llegó algo nuevo hay que recargar (si no, se pisaría con datos viejos). */
let checking = false;
async function checkRemote() {
  if (state.closed || !syncOn() || !state.online || checking || state.pushing) return;
  checking = true;
  try {
    if (state.saver) await state.saver.flush();                      // primero lo mío al almacenamiento local, para que el conflicto se detecte bien
    const res = await state.sync.pullAll({});
    if (res && res.conflicts && res.conflicts.length) toastConflicts(res.conflicts.length);
    if (res && res.changed) showReloadModal();
  } catch (e) { console.warn('pull', e); }
  finally { checking = false; }
}
let lastConflictToast = 0;
function toastConflicts(n) {
  if (Date.now() - lastConflictToast < 8000) return;                // un solo aviso aunque lo detecten la bajada y la subida
  lastConflictToast = Date.now();
  toast('Hay ' + n + ' hoja(s) en conflicto con GitHub: revisa Ajustes → Sincronización.', { type: 'warn', ms: 9000 });
}
function showReloadModal() {
  if (state.reloadShown) return; state.reloadShown = true;
  const body = el('div', {}, el('p', { text: 'Otro dispositivo guardó cambios nuevos y ya se descargaron. Para verlos hay que recargar la app; lo que tú hiciste ya está guardado.' }),
    el('div', { class: 'row end' }, el('button', { class: 'btn primary', text: 'Recargar ahora', onclick: () => location.reload() })));
  ui.openModal(body, { title: 'Hay cambios nuevos', sheet: false, onClose: () => location.reload() });   // cerrar = recargar: seguir editando con datos viejos los pisaría
}
/** Archivos mensuales guardados aquí y aún sin subir (sin red o sin GitHub al crearlos): se suben solos cuando se puede. Sin nada pendiente no usa la red. */
async function autoArchive() {
  const A = state.archive;
  if (state.closed || !A || !syncOn() || !state.online || state.archiving) return;
  state.archiving = true;
  try {
    const r = await A.uploadPending({});
    if (r && r.uploaded && r.uploaded.length) toast('Archivo de ' + r.uploaded.map((k) => A.monthLabel(k)).join(', ') + ' subido a GitHub', { type: 'ok' });
    if (r && r.conflicts && r.conflicts.length) toast('Hay un archivo mensual con dos versiones distintas: revisa Hojas → Archivo por mes.', { type: 'warn', ms: 8000 });
  } catch (e) { console.warn('[archivo] no se pudo subir:', e && e.message); }
  finally { state.archiving = false; }
}
async function autoSync() { await checkRemote(); await autoPush(); await autoArchive(); }
async function onPill() {
  if (!syncOn()) { ctx.navigate('ajustes'); return; }
  await autoSync();
  let st = null; try { st = await state.sync.status(); } catch (e) { /* */ }
  if (st && (st.conflicts || []).length) ctx.navigate('ajustes');            // hay algo que resolver: llévame a donde se resuelve
  else if (st && st.lastError) toast('No se pudo sincronizar: ' + (st.lastError.message || st.lastError.code), { type: 'error', ms: 7000 });
  else toast('Todo sincronizado', { type: 'ok' });
  updatePill();
}
async function updatePill() {
  const pill = $('#syncPill'), txt = $('#syncText'); if (!pill) return;
  let cls = '', t = 'Guardado';
  if (!state.online) { cls = 'warn'; t = 'Sin conexión'; }
  else if (state.saveStatus === 'error') { cls = 'err'; t = 'Error al guardar'; }
  else if (state.saveStatus === 'saving' || state.saveStatus === 'pending' || (state.engine && state.engine.dirty.size)) { cls = 'busy'; t = 'Guardando…'; }
  else if (state.pushing) { cls = 'busy'; t = 'Subiendo…'; }
  else {
    let st = null; try { st = state.sync ? await state.sync.status() : null; } catch (e) { /* */ }
    if (!state.store) { cls = 'err'; t = 'Sin guardar'; }
    else if (st && st.conflicts && st.conflicts.length) { cls = 'err'; t = st.conflicts.length + ' en conflicto'; }
    else if (!syncOn()) { cls = 'warn'; t = 'Solo este equipo'; }
    else if (st && st.pendingCount > 0) { cls = 'warn'; t = st.pendingCount + ' por subir'; }
    else if (st && st.lastError) { cls = 'warn'; t = 'Sin sincronizar'; }
    else {
      let na = 0; try { na = state.archive ? await state.archive.unsyncedCount() : 0; } catch (e) { /* sin dato */ }      // un archivo mensual sin subir (o en conflicto) tampoco está «sincronizado»
      if (na > 0) { cls = 'warn'; t = na === 1 ? '1 archivo por subir' : na + ' archivos por subir'; } else t = 'Sincronizado';
    }
  }
  pill.className = 'pill ' + cls; txt.textContent = t;
  updateConnBanner();
}
setInterval(() => { if (state.engine) updatePill(); }, 5000);

/**
 * Aviso rojo arriba de todas las pantallas cuando este dispositivo NO está conectado a GitHub (o el token ya no sirve):
 * así nunca se trabaja horas sin enterarse de que nada se está subiendo. Un botón lleva a Ajustes para conectar.
 */
let connShown = '';
async function updateConnBanner() {
  const box = $('#connBanner'); if (!box || !state.store) return;
  let text = '';
  if (state.syncLoadError) text = 'No pude leer la conexión con GitHub guardada en este dispositivo: tus cambios solo se guardan aquí. Vuelve a conectar en Ajustes con tu clave única o un código de conexión (no hace falta crear otro token).';
  else if (!syncOn()) {
    let n = 0; try { const st = state.sync ? await state.sync.status() : null; n = (st && st.pendingCount) || 0; } catch (e) { /* sin dato */ }
    text = 'Este dispositivo no está conectado a GitHub: lo que hagas solo se guarda aquí' + (n ? ' (' + n + (n === 1 ? ' hoja sin subir' : ' hojas sin subir') + ')' : '') + '. Conéctalo en Ajustes con tu clave única o un código de conexión (no hace falta crear otro token).';
  } else {
    let st = null; try { st = await state.sync.status(); } catch (e) { /* sin dato */ }
    const code = st && st.lastError && st.lastError.code;
    if (code === 'BAD_TOKEN' || code === 'NO_PERMISSION' || code === 'FORBIDDEN') text = 'GitHub ya no acepta el token de este dispositivo (venció o se borró): nada se está subiendo. En Ajustes entra con tu clave única, un código de conexión o un token nuevo.';
  }
  if (text === connShown) return;
  connShown = text;
  box.innerHTML = '';
  box.hidden = !text;
  if (text) box.append(el('span', { class: 'grow', text }), el('button', { type: 'button', text: 'Conectar ahora', onclick: () => ctx.navigate('ajustes') }));
}
setInterval(() => { if (state.engine) updateConnBanner(); }, 5000);

/* ------------------------------------------------------------------ tema */
function applyTheme() {
  let t = 'auto'; try { t = localStorage.getItem('fx-theme') || 'auto'; } catch (e) { /* */ }
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}
function setTheme(t) { try { localStorage.setItem('fx-theme', t); } catch (e) { /* */ } applyTheme(); }

/* ------------------------------------------------------------------ navegación */
const TITLES = { resumen: 'Resumen', mov: 'Movimientos', reg: 'Anotar', hojas: 'Hojas', hoja: 'Hoja', archivo: 'Archivo', buscar: 'Buscar', ajustes: 'Ajustes', rubros: 'Ingresos y egresos' };
function parseHash() {
  const h = location.hash.replace(/^#\/?/, ''); const [path, qs] = h.split('?'); const parts = path.split('/');
  return { name: parts[0] || 'resumen', arg: parts.slice(1).join('/') || null, q: new URLSearchParams(qs || '') };
}
/** Cambio de «#»: un enlace «#conectar=…» NO es una ruta; se quita de la URL y se lleva el código a Ajustes. */
function onHashChange() {
  if (takePairingFromUrl()) { ctx.navigate('ajustes'); return; }     // navigate() cambia el hash y vuelve a entrar aquí con la ruta normal
  route();
}
let routeToken = 0;
async function route() {
  if (!state.engine || state.closed) return;
  const parsed = parseHash();
  const { arg, q } = parsed;
  const name = ({ registrar: 'reg', movimientos: 'mov' })[parsed.name] || parsed.name;     // los módulos navegan con estos nombres largos
  const token = ++routeToken;
  if (state.screenObj) { try { state.screenObj.destroy && state.screenObj.destroy(); } catch (e) { console.warn(e); } }
  state.screenObj = null; state.grid = null;
  const host = $('#screens'); host.innerHTML = '';
  const view = el('div', { class: 'view', style: { display: 'contents' } }); host.append(view);   // contenedor propio de esta ruta
  const key = SCREENS[name] ? name : 'resumen';
  $('#app').classList.toggle('route-hoja', key === 'hoja' || (key === 'archivo' && !!arg) || (key === 'resumen' && !state.mods.dashboard));   // el visor del archivo también es una hoja: barra superior compacta
  const navKey = key === 'hoja' || key === 'archivo' ? 'hojas' : key === 'rubros' && !document.querySelector('.side [data-nav="rubros"]') ? 'resumen' : key;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === navKey || (key === 'rubros' && a.dataset.nav === 'resumen' && !a.closest('.side'))));
  $('#title').textContent = TITLES[key];
  document.title = TITLES[key] + ' · Flujo';
  let obj = null;
  try { obj = (await SCREENS[key](view, arg, q)) || null; }
  catch (e) { console.error(e); view.append(el('div', { class: 'screen' }, el('div', { class: 'card' }, el('h2', { text: 'Algo salió mal' }), el('p', { class: 'muted', text: String(e && e.message || e) })))); }
  if (token !== routeToken) { try { obj && obj.destroy && obj.destroy(); } catch (e) { /* */ } view.remove(); return; }   // el usuario ya navegó a otra pantalla
  state.screenObj = obj;
  setTimeout(checkPolicyAlert, 0);                                     // aviso de pólizas pendiente (si se difirió por otra ventana); una vez por día
}

/* ------------------------------------------------------------------ pantallas */
/** Hojas donde se anota un movimiento: las cuentas bancarias del módulo de movimientos y las dos tarjetas (formularios de captura). */
function movTargets() {
  const L = state.mods.ledger, Q = state.mods.quick, out = [];
  if (L && L.LEDGERS) for (const d of Object.values(L.LEDGERS)) out.push({ id: d.id, kind: 'ledger', label: d.title || d.short });
  if (Q && Q.mountForm && Q.SHEETS) {
    for (const fid of ['tcpich', 'produb']) {
      const sh = state.engine.sheet(Q.SHEETS[fid]);
      if (sh) out.push({ id: fid, kind: 'form', label: catalog.infoFor(sh).short });
    }
  }
  return out;
}

/** Dónde se escribe el siguiente movimiento de una hoja: {sid, r, c} = fila libre y primera columna de captura (base 0), o null. */
async function entrySpot(t) {
  const eng = state.engine, L = state.mods.ledger, Q = state.mods.quick;
  try {
    if (t.kind === 'ledger' && L && L.ledgerInfo && L.LEDGERS && L.LEDGERS[t.id]) {
      const d = L.LEDGERS[t.id], info = L.ledgerInfo(eng, t.id, { today: ctx.today() });
      if (Number.isInteger(info.nextRow)) return { sid: d.sid, r: info.nextRow, c: d.entry ? d.entry[0] : 0 };
    }
    if (t.kind === 'form' && Q && Q.getForm && Q.SHEETS && Q.SHEETS[t.id]) {
      const sid = Q.SHEETS[t.id];
      if (eng.sheet(sid) && !eng.sheet(sid).loaded && eng.loadSheetAsync) await eng.loadSheetAsync(sid);
      const p = Q.getForm(t.id).prepare(eng, { today: ctx.today() });
      if (p && p.ok) {
        if (t.id === 'produb' && p.card && Number.isInteger(p.card.nextRow)) return { sid, r: p.card.nextRow, c: 6 };   // zona de la tarjeta: columnas G:H
        if (Number.isInteger(p.nextRow)) return { sid, r: p.nextRow, c: 0 };
      }
    }
  } catch (e) { console.warn('[anotar] no se pudo ubicar la fila libre', e); }
  return null;
}
/** «Anotar» en una hoja: se abre la hoja misma, en la primera fila libre, para escribir directo (como en Excel). */
async function openForEntry(t) {
  try { localStorage.setItem('fx-mov-target', t.id); } catch (e) { /* */ }       // al volver a Movimientos se ve esa hoja
  const spot = await entrySpot(t);
  if (spot) ctx.openSheet(spot.sid, { r: spot.r, c: spot.c, nuevo: true }); else ctx.navigate('mov/' + t.id);
}

const SCREENS = {
  async resumen(host) {
    const D = state.mods.dashboard;
    if (D && D.mount) { const wrap = el('div', { class: 'screen' }); host.append(wrap); return D.mount(wrap, ctx); }
    return openGridIn(host, 'CONSOL', new URLSearchParams());
  },
  async mov(host, arg, q) {
    const L = state.mods.ledger, Q = state.mods.quick;
    const wrap = el('div', { class: 'screen mov-screen' }); host.append(wrap);
    if (!L || !L.mount) {
      wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Movimientos' }), el('p', { class: 'muted', text: 'La captura rápida de movimientos aún no está disponible en esta versión. Usa la pestaña Hojas.' })));
      return {};
    }
    // Hojas donde se anota el movimiento: cuentas bancarias y tarjetas (lista desplegable de arriba y lista que sale al pulsar «+»)
    const targets = movTargets();
    let saved = null; try { saved = localStorage.getItem('fx-mov-target'); } catch (e) { /* */ }
    let current = targets.find((t) => t.id === arg) || targets.find((t) => t.id === saved) || targets[0];
    const select = el('select', { id: 'mov-target', 'aria-label': 'Hoja que estás viendo' });
    for (const t of targets) select.append(el('option', { value: t.id, text: t.label, selected: t.id === current.id }));
    wrap.append(el('div', { class: 'field mov-pick' }, el('label', { for: 'mov-target', text: 'Hoja que estás viendo' }), select));
    const body = el('div', { class: 'mov-body' }); wrap.append(body);
    let child = null;
    /** «+ Movimiento»: primero se elige la hoja donde se anota (la que se está viendo sale marcada). */
    const chooseTarget = () => new Promise((resolve) => {
      let modal = null, done = false;
      const finish = (t) => { if (done) return; done = true; if (modal) modal.close(); resolve(t || null); };
      const rows = targets.map((t) => el('button', Object.assign({ type: 'button', class: 'mov-choice' + (t.id === current.id ? ' on' : ''), 'data-target': t.id, onclick: () => finish(t) }, t.id === current.id ? { autofocus: true } : {}),
        el('span', { class: 'mov-choice-ic', 'aria-hidden': 'true', text: t.kind === 'ledger' ? '🏦' : '💳' }),
        el('span', { class: 'mov-choice-t' }, el('b', { text: t.label }), el('small', { text: t.kind === 'ledger' ? 'Cuenta bancaria' : 'Tarjeta de crédito' })),
        t.id === current.id ? el('span', { class: 'badge', text: 'la que estás viendo' }) : el('span', { class: 'muted', 'aria-hidden': 'true', html: '&rsaquo;' })));
      modal = ctx.modal(el('div', { class: 'mov-choose' }, el('p', { class: 'muted', text: 'Elige la hoja donde quieres anotarlo.' }), ...rows),
        { title: '¿En qué hoja anotas el movimiento?', onClose: () => finish(null) });
    });
    const addFlow = async () => { const t = await chooseTarget(); if (t) openForEntry(t); };     // elegida la hoja, se abre la hoja misma
    const show = (t) => {
      if (child && child.destroy) { try { child.destroy(); } catch (e) { console.warn(e); } }
      body.innerHTML = ''; current = t;
      try { localStorage.setItem('fx-mov-target', t.id); } catch (e) { /* */ }
      try { history.replaceState(null, '', '#/mov/' + t.id); } catch (e) { /* */ }
      child = (t.kind === 'ledger' ? L.mount(body, ctx, { ledgerId: t.id, onAdd: addFlow }) : Q.mountForm(body, ctx, t.id)) || null;
      if (t.kind !== 'ledger') body.append(el('div', { class: 'lg-bar' }, el('button', { type: 'button', class: 'btn primary lg-add', 'aria-label': 'Nuevo movimiento', onclick: addFlow }, el('span', { 'aria-hidden': 'true', class: 'lg-plus', text: '+' }), ' Movimiento')));   // las tarjetas también tienen su «+»
      if (wrap.isConnected) $('#title').textContent = TITLES.mov;
    };
    select.addEventListener('change', () => show(targets.find((t) => t.id === select.value)));
    show(current);
    if (q && q.get('nuevo')) {                                         // #/mov?nuevo=1 → lista de hojas · #/mov/<hoja>?nuevo=1 → esa hoja, en la fila libre
      if (arg && current.id === arg) openForEntry(current); else addFlow();
    }
    return { destroy() { if (child && child.destroy) child.destroy(); }, refresh() { if (child && child.refresh) child.refresh(); } };
  },
  async reg(host, arg) {
    const Q = state.mods.quick;
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    if (arg && Q && Q.mountForm) {                                  // #/reg/<formId>: formulario de captura
      $('#title').textContent = 'Registrar';
      return Q.mountForm(wrap, ctx, arg);
    }
    const sheetRows = movTargets().map((t) => el('li', { style: { cursor: 'pointer' }, 'data-target': t.id, onclick: () => openForEntry(t) },
      el('div', { class: 'grow' }, el('div', { class: 't', text: (t.kind === 'ledger' ? '🏦  ' : '💳  ') + t.label }), el('div', { class: 's', text: t.kind === 'ledger' ? 'Depósito, retiro, pago o transferencia' : 'Consumos y pagos de la tarjeta' })),
      el('span', { class: 'muted', html: '&rsaquo;' })));
    wrap.append(el('div', { class: 'card' }, el('h2', { text: '¿En qué hoja anotas el movimiento?' }), el('p', { class: 'muted', text: 'Elige la hoja: se abre en la primera fila libre para que escribas el movimiento.' }), el('ul', { class: 'list mov-sheets' }, ...sheetRows)));
    return {};
  },
  async hojas(host) {
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    /** Tarjeta de arriba: entrada al archivo mensual (copias de todas las hojas, mes a mes). */
    const archiveCard = () => {
      if (!state.archive || !state.mods.archive || !state.mods.archive.mount) return null;
      const sub = el('div', { class: 's', text: 'Una copia de todas las hojas de cada cierre, para consultarla cuando quieras' });
      const card = el('div', { class: 'card arc-entry' }, el('ul', { class: 'list' }, el('li', { class: 'arc-entry-li', 'data-go': 'archivo', style: { cursor: 'pointer' }, role: 'button', tabindex: '0', onclick: () => ctx.navigate('archivo'),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.navigate('archivo'); } } },
      el('span', { class: 'arc-entry-ic', 'aria-hidden': 'true', text: '📅' }),
      el('div', { class: 'grow' }, el('div', { class: 't', text: 'Archivo por mes' }), sub),
      el('span', { class: 'muted', html: '&rsaquo;' }))));
      state.archive.count().then((n) => { if (n > 0 && sub.isConnected) sub.textContent = (n === 1 ? '1 mes guardado' : n + ' meses guardados') + ' · toca para consultarlos'; }).catch(() => { });
      return card;
    };
    const render = () => {
      wrap.innerHTML = '';
      const ac = archiveCard(); if (ac) wrap.append(ac);
      const hiddenCount = state.engine.sheets.filter(catalog.isHiddenSheet).length;
      for (const g of catalog.groupSheets(state.engine.sheets, { showHidden: state.showHidden })) {
        const card = el('div', { class: 'card' }, el('h2', { text: g.group.icon + '  ' + g.group.title }));
        const ul = el('ul', { class: 'list' });
        for (const { sheet, info } of g.items) {
          ul.append(el('li', { onclick: () => ctx.openSheet(sheet.id, { end: info.end }), style: { cursor: 'pointer' } },
            el('div', { class: 'grow' }, el('div', { class: 't', text: info.short }), el('div', { class: 's', text: info.desc || sheet.name.trim() })),
            catalog.isHiddenSheet(sheet) ? el('span', { class: 'badge', text: 'oculta' }) : null,
            el('span', { class: 'muted', html: '&rsaquo;' })));
        }
        card.append(ul); wrap.append(card);
      }
      if (hiddenCount) wrap.append(el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
        el('button', { class: 'btn ghost', text: state.showHidden ? 'Ocultar las ' + hiddenCount + ' hojas ocultas' : 'Mostrar ' + hiddenCount + ' hojas ocultas', onclick: () => { state.showHidden = !state.showHidden; render(); } })));
    };
    render();
  },
  async hoja(host, sid, q) { return openGridIn(host, sid, q); },
  /** Archivo mensual: #/archivo = lista de cierres · #/archivo/AAAA-MM = visor de solo lectura (js/archive.js) */
  async archivo(host, arg, q) {
    const A = state.mods.archive;
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    if (!A || !A.mount || !state.archive) {
      wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Archivo' }), el('p', { class: 'muted', text: 'El archivo mensual no está disponible en esta versión.' })));
      return {};
    }
    return A.mount(wrap, ctx, arg, q);
  },
  async buscar(host) {
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    const input = el('input', { type: 'search', placeholder: 'Buscar en todas las hojas (texto, valores, fórmulas)…', 'aria-label': 'Buscar', autofocus: true });
    const out = el('div', { style: { marginTop: '12px' } });
    wrap.append(el('div', { class: 'field' }, input), out);
    const run = async () => {
      const qv = input.value.trim(); out.innerHTML = '';
      if (qv.length < 2) { out.append(el('p', { class: 'empty', text: 'Escribe al menos 2 letras.' })); return; }
      const scope = state.engine.sheets.filter((s) => state.showHidden || !catalog.isHiddenSheet(s));     // las hojas ocultas no se buscan
      if (scope.some((s) => !s.loaded)) {                           // la primera búsqueda carga las hojas que faltan
        out.append(el('div', { class: 'empty' }, el('div', { class: 'spin' }), 'Preparando la búsqueda en las hojas…'));
        for (const s of scope) if (!s.loaded) await state.engine.loadSheetAsync(s.id);
        if (input.value.trim() !== qv) return; out.innerHTML = '';
      }
      const res = state.engine.search(qv, { max: 200, sids: scope.map((s) => s.id) });
      if (!res.length) { out.append(el('p', { class: 'empty', text: 'Sin resultados.' })); return; }
      const ul = el('ul', { class: 'list' });
      const A1 = (r, c) => { let s = '', n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = ((n - 1 - m) / 26) | 0; } return s + (r + 1); };
      for (const x of res) {
        const info = catalog.infoFor(state.engine.sheet(x.sid));
        ul.append(el('li', { style: { cursor: 'pointer' }, onclick: () => ctx.openSheet(x.sid, { r: x.r, c: x.c }) },
          el('div', { class: 'grow' }, el('div', { class: 't', text: String(x.text).slice(0, 80) }), el('div', { class: 's', text: info.short + ' · ' + A1(x.r, x.c) })), el('span', { class: 'muted', html: '&rsaquo;' })));
      }
      out.append(el('p', { class: 'small muted', text: res.length + (res.length >= 200 ? '+' : '') + ' resultado(s)' }), ul);
    };
    input.addEventListener('input', ui.debounce(run, 250)); run();
    setTimeout(() => input.focus(), 50);
  },
  async ajustes(host) { return screenAjustes(host); },
  /** Ingresos y egresos del mes por rubro: #/rubros = mes de hoy · #/rubros/AAAA-MM (js/rubros.js) */
  async rubros(host, arg, q) {
    const R = state.mods.rubros;
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    if (!R || !R.mount) {
      wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Ingresos y egresos' }), el('p', { class: 'muted', text: 'Este resumen no está disponible en esta versión.' })));
      return {};
    }
    return R.mount(wrap, ctx, arg, q);
  },
};

async function openGridIn(host, sidOrName, q) {
  const eng = state.engine;
  const sh = eng.sheet(sidOrName) || eng.sheets[0];
  if (!sh.loaded) {                                      // hoja diferida: se carga ahora (un par de segundos)
    host.append(el('div', { class: 'screen' }, el('div', { class: 'empty' }, el('div', { class: 'spin' }), 'Cargando la hoja…')));
    await eng.loadSheetAsync(sh.id);
    host.innerHTML = '';
  }
  const wrap = el('div', { class: 'screen flush' });
  const select = el('select', { 'aria-label': 'Cambiar de hoja' });
  for (const s of eng.sheets) { const hid = catalog.isHiddenSheet(s); if (hid && s.id !== sh.id && !state.showHidden) continue; select.append(el('option', { value: s.id, text: catalog.infoFor(s).short + (hid ? ' (oculta)' : ''), selected: s.id === sh.id })); }
  select.addEventListener('change', () => { const info = catalog.infoFor(eng.sheet(select.value)); ctx.openSheet(select.value, { end: info.end }); });
  const nuevo = q.get('nuevo') === '1';                    // llegó desde «Anotar»: viene con la fila libre ya seleccionada
  const bar = el('div', { class: 'sheetbar' }, el('button', { class: 'btn ghost', 'aria-label': nuevo ? 'Volver a Anotar' : 'Volver a Hojas', html: nuevo ? '&lsaquo; Anotar' : '&lsaquo; Hojas', onclick: () => ctx.navigate(nuevo ? 'reg' : 'hojas') }), select);
  const gwrap = el('div', { class: 'sheetwrap' });
  const hint = nuevo && q.get('r') != null ? el('div', { class: 'sheet-hint', role: 'status' }, el('b', { text: 'Fila ' + (+q.get('r') + 1) + ' (la primera libre): ' }), 'escribe ahí el movimiento. El saldo se calcula solo.') : null;
  wrap.append(...[bar, hint, gwrap].filter(Boolean)); host.append(wrap);
  const grid = new SheetGrid(gwrap, eng, { onChange: () => ctx.changed([sh.id], 'grid'), onFind: () => ctx.navigate('buscar'), onToast: (m) => toast(m) });
  const info = catalog.infoFor(sh);
  const r = q.get('r'), c = q.get('c');
  if (host.isConnected) $('#title').textContent = info.short;
  grid.open(sh.id, { end: q.get('end') === '1' || (r == null && info.end), r: r != null ? +r : undefined, c: c != null ? +c : undefined });
  if (nuevo && r != null) grid.showRowLow(+r);              // se ven los movimientos anteriores encima de la fila libre
  state.grid = grid;
  return { destroy() { grid.commitPending(); grid.destroy(); }, refresh() { grid.refresh(); } };
}

/* ------------------------------------------------------------------ ajustes */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src.endsWith(src))) return resolve();
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar ' + src)); document.head.append(s);
  });
}
function screenAjustes(host) {
  const wrap = el('div', { class: 'screen' }); host.append(wrap);
  const eng = state.engine, S = state.mods['sync-github'], U = state.mods['settings-ui'], X = state.mods.export, P = state.mods.pwa;

  // sincronización
  const syncCard = el('div', { class: 'card' });
  const syncBox = el('div'); syncCard.append(syncBox);
  let syncUi = null;
  if (S && U && state.store) {
    if (!state.sync) state.sync = new S.GithubSync(state.store, {});
    syncUi = U.mountSyncSettings(syncBox, { store: state.store, sync: state.sync, engine: eng, autosaver: state.saver, pairingCode: takePendingPairing(), onBundleReplaced: () => { toast('Datos reemplazados. Recargando…', { type: 'ok' }); setTimeout(() => location.reload(), 800); } });
  } else syncBox.append(el('p', { class: 'muted', text: 'El módulo de sincronización no está disponible.' }));
  wrap.append(syncCard);

  // exportar
  const expCard = el('div', { class: 'card' }, el('h2', { text: 'Exportar y respaldo' }),
    el('p', { class: 'small muted', text: 'Tu información es tuya: descárgala cuando quieras como libro de Excel o como respaldo de Flujo con todas las hojas. Los archivos mensuales no van dentro del respaldo: ya se guardan aparte, en tu GitHub.' }));
  const row = el('div', { class: 'row' });
  if (X) {
    row.append(
      el('button', { class: 'btn primary', text: 'Descargar Excel (.xlsx)', onclick: async () => {
        try { await ui.busy('Generando el libro de Excel…', async () => { await X.downloadXlsx(eng, {}); }); toast('Excel generado', { type: 'ok' }); }
        catch (e) { console.error(e); toast('No se pudo exportar: ' + e.message, { type: 'error' }); }
      } }),
      el('button', { class: 'btn', text: 'Descargar respaldo (.json)', onclick: async () => {
        try { await X.downloadJsonBackup(eng); toast('Respaldo generado', { type: 'ok' }); } catch (e) { toast('No se pudo exportar: ' + e.message, { type: 'error' }); }
      } }));
  } else row.append(el('span', { class: 'muted', text: 'La exportación no está disponible en esta versión.' }));
  expCard.append(row); wrap.append(expCard);

  // apariencia
  let cur = 'auto'; try { cur = localStorage.getItem('fx-theme') || 'auto'; } catch (e) { /* */ }
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Tema' });
  for (const [v, l] of [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']]) seg.append(el('button', { class: v === cur ? 'on' : '', text: l, onclick: (e) => { setTheme(v); seg.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); } }));
  wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Apariencia' }), seg));

  // instalar
  if (P && P.installPrompt) {
    const inst = el('div', { class: 'card' }, el('h2', { text: 'Instalar como aplicación' }), el('p', { class: 'small muted', text: 'Ábrela desde el escritorio o la pantalla de inicio, sin barra del navegador y también sin internet.' }));
    inst.append(el('button', { class: 'btn', text: 'Instalar', onclick: async () => { const r = await P.installPrompt(); if (r === false) toast('Usa el menú del navegador: «Instalar aplicación» o «Añadir a pantalla de inicio».', { ms: 7000 }); } }));
    wrap.append(inst);
  }

  // datos de este equipo
  const dev = el('div', { class: 'card' }, el('h2', { text: 'Este dispositivo' }),
    el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', text: 'Cerrar Flujo', title: 'Guarda lo pendiente y cierra la ventana', onclick: closeProgram }),
      el('span', { class: 'small muted', text: 'Guarda lo pendiente y cierra la app para que no quede nada abierto.' })),
    el('p', { class: 'small muted', text: 'Hojas: ' + eng.sheets.length + ' · motor listo en ' + ((state.buildMs || 0) / 1000).toFixed(1) + ' s · versión ' + VERSION }));
  if (state.store) dev.append(el('div', { class: 'row' },
    el('button', { class: 'btn danger', text: 'Borrar datos de este dispositivo', onclick: async () => {
      // lo que todavía no llegó a GitHub (hojas con cambios, archivos mensuales o cambios sin guardar) se perdería con el borrado
      const lost = [];
      try {
        if (syncOn()) {
          const st = await state.sync.status(), n = (st && st.pendingCount) || 0;
          if (n > 0) lost.push(n === 1 ? '1 hoja con cambios que aún no se subió a GitHub (por ejemplo, un cierre de mes hecho sin conexión)' : n + ' hojas con cambios que aún no se subieron a GitHub (por ejemplo, un cierre de mes hecho sin conexión)');
        }
      } catch (e) { /* sin aviso de hojas */ }
      try { const n = state.archive ? await state.archive.unsyncedCount() : 0; if (n > 0) lost.push(n === 1 ? '1 archivo mensual guardado solo en este dispositivo (aún sin subir a GitHub)' : n + ' archivos mensuales guardados solo en este dispositivo (aún sin subir a GitHub)'); } catch (e) { /* sin aviso de archivos */ }
      if ((state.saver && state.saver.hasUnsaved) || (state.engine && state.engine.dirty && state.engine.dirty.size > 0)) lost.push('cambios que ni siquiera se alcanzaron a guardar en este dispositivo');
      let extra = lost.length ? ' Ojo: hay ' + lost.join('; hay ') + '. Todo eso se perdería: espera a que termine de subirse (toca el indicador de sincronización de arriba) o descarga un respaldo antes.' : '';
      if (!syncOn()) extra += ' GitHub no está conectado en este dispositivo, así que esta es la única copia de tus datos: descarga un respaldo antes.';
      if (await ui.confirmDialog('Se borrarán los datos guardados en este dispositivo (no los que ya estén en GitHub).' + extra + ' ¿Continuar?', { ok: 'Borrar', danger: true })) { await state.store.clearAll(); location.reload(); }
    } })));
  wrap.append(dev);

  // acerca de
  wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Acerca de' }),
    el('p', { class: 'small muted', html: 'Flujo reemplaza tu libro de Excel con una app que funciona en cualquier dispositivo. Motor de cálculo: HyperFormula (GPL-3.0). Formatos de número: SSF (Apache-2.0). Código de la app bajo GPL-3.0.' })));
  return { destroy() { if (syncUi && syncUi.destroy) syncUi.destroy(); } };      // al salir de Ajustes se borra de memoria cualquier código/clave que estuviera a la vista
}

boot().catch((e) => {
  console.error(e);
  const m = $('#boot-msg'); if (m) { m.textContent = 'No se pudo iniciar: ' + (e && e.message || e); m.style.color = 'var(--neg)'; }
});
