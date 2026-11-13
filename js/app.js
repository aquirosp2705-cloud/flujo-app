/* app.js — arranque, navegación y pantallas base de Flujo.
 * Los módulos grandes (store, sync-github, settings-ui, ledger, dashboard, export, pwa) se cargan de forma opcional:
 * si alguno falta, la app sigue funcionando sin esa pieza. */
import { Engine, loadBundle } from './engine.js';
import { SheetGrid } from './grid.js';
import * as ui from './ui.js';
import * as catalog from './catalog.js';
import { todaySerial } from './format.js';

const { el, toast } = ui;
const $ = (s, r = document) => r.querySelector(s);
const optional = async (p) => { try { return await import(p); } catch (e) { console.warn('[módulo opcional no disponible]', p, e.message); return null; } };
const VERSION = '1.0.0';

const state = { engine: null, store: null, sync: null, saver: null, mods: {}, screenObj: null, grid: null, showHidden: false, saveStatus: 'idle', online: navigator.onLine };

/* ------------------------------------------------------------------ contexto compartido con los módulos */
const ctx = {
  get engine() { return state.engine; }, get store() { return state.store; }, get sync() { return state.sync; }, get saver() { return state.saver; },
  ui, catalog, today: todaySerial,
  toast, confirm: ui.confirmDialog, modal: ui.openModal, busy: ui.busy,
  navigate(route) { location.hash = '#/' + String(route).replace(/^#?\/?/, ''); },
  openSheet(sid, { r, c, end } = {}) {
    const q = new URLSearchParams(); if (r != null) q.set('r', r); if (c != null) q.set('c', c); if (end) q.set('end', 1);
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

async function boot() {
  applyTheme();
  setBoot('Cargando módulos…', 5);
  const names = ['store', 'sync-github', 'settings-ui', 'ledger', 'dashboard', 'quick', 'export', 'pwa'];
  const mods = await Promise.all(names.map((n) => optional('./' + n + '.js')));
  names.forEach((n, i) => { state.mods[n] = mods[i]; });
  if (state.mods.pwa && state.mods.pwa.initPwa) {
    // avisos de «Instalar la app» y «Hay una versión nueva — Actualizar»; antes de recargar se guardan los cambios pendientes
    try { state.mods.pwa.initPwa({ offlineNotice: false, beforeReload: async () => { if (state.saver) await state.saver.flush(); } }); } catch (e) { console.warn(e); }
  }
  let bundle = null;
  if (state.mods.store) {
    try { state.store = new state.mods.store.Store(); await state.store.open(); bundle = await state.store.loadBundle(); }
    catch (e) { console.error(e); state.store = null; toast('No se pudo abrir el almacenamiento local: ' + e.message, { type: 'error', ms: 8000 }); }
  }
  const S = state.mods['sync-github'];
  if (state.store && S) { try { state.sync = await S.GithubSync.fromStore(state.store); } catch (e) { console.warn('[sync] no disponible', e); } }
  if (bundle && syncOn() && navigator.onLine) bundle = await preSync(bundle);     // trae lo que otro dispositivo haya guardado ANTES de armar el motor
  if (!bundle) bundle = await firstRun();
  await startWithBundle(bundle);
}

/** Al abrir la app: si hay GitHub configurado, baja primero los cambios de otros dispositivos (máx. 9 s; si falla, se sigue con lo local). */
async function preSync(bundle) {
  setBoot('Buscando cambios en GitHub…', 20);
  try {
    const res = await state.sync.pullAll({ timeoutMs: 9000 });          // el propio módulo aborta la descarga a los 9 s (así no escribe tarde sobre un motor ya armado)
    if (res && res.conflicts && res.conflicts.length) state.startConflicts = res.conflicts;
    if (res && res.changed) { const b = await state.store.loadBundle(); if (b) return b; }
  } catch (e) { console.warn('[sync] no se pudo consultar GitHub al iniciar:', e && e.message); }
  return bundle;
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
  const finish = async (bundle) => { if (state.store) { try { await state.store.replaceAll(bundle); } catch (e) { console.warn(e); } } extra.innerHTML = ''; $('.bar', $('#boot')).hidden = false; resolve(bundle); };
  const gh = el('div', { class: 'card', style: { textAlign: 'left', marginTop: '14px' } });
  extra.append(
    el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } },
      el('button', { class: 'btn primary', text: 'Traer desde GitHub', onclick: () => { gh.hidden = !gh.hidden; } }),
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
        return el('span', {}, f, el('button', { class: 'btn', text: 'Cargar un respaldo (.json)', onclick: () => f.click() }));
      })()),
    gh);
  gh.hidden = true;
  const S = state.mods['sync-github'], U = state.mods['settings-ui'];
  if (S && U && state.store) {
    if (!state.sync) state.sync = new S.GithubSync(state.store, {});
    U.mountSyncSettings(gh, { store: state.store, sync: state.sync, engine: null, onBundleReplaced: (b) => finish(b) });
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
      state.saver = new St.AutoSaver(state.engine, state.store, { delayMs: 1500, onStatus: (s, info) => { state.saveStatus = s; updatePill(); if (s === 'saved') afterSaved(); } });
    } catch (e) { console.warn('AutoSaver no disponible', e); }
  }
  if (S && state.store && !state.sync) { try { state.sync = new S.GithubSync(state.store, {}); } catch (e) { console.warn(e); } }
  $('#boot').remove(); $('#app').hidden = false;
  $('#side-ver').textContent = 'Versión ' + VERSION;
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => { state.online = true; updatePill(); autoSync(); });
  window.addEventListener('offline', () => { state.online = false; updatePill(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoSync(); });
  setInterval(() => { if (document.visibilityState === 'visible') autoSync(); }, 5 * 60 * 1000);
  $('#syncPill').addEventListener('click', onPill);
  if (!state.store) toast('Sin almacenamiento local: los cambios NO se guardarán al cerrar.', { type: 'warn', ms: 8000 });
  await route();
  updatePill();
  if (state.startConflicts && state.startConflicts.length) toast('Hay ' + state.startConflicts.length + ' hoja(s) en conflicto con GitHub: revisa Ajustes → Sincronización.', { type: 'warn', ms: 9000 });
  if (syncOn()) autoPush();
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
  pushTimer = setTimeout(() => autoPush(), 15000);                  // se sube unos segundos después del último cambio
}
async function autoPush() {
  if (!syncOn() || !state.online || state.pushing) return;
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
  if (!syncOn() || !state.online || checking || state.pushing) return;
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
async function autoSync() { await checkRemote(); await autoPush(); }
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
    else t = 'Sincronizado';
  }
  pill.className = 'pill ' + cls; txt.textContent = t;
}
setInterval(() => { if (state.engine) updatePill(); }, 5000);

/* ------------------------------------------------------------------ tema */
function applyTheme() {
  let t = 'auto'; try { t = localStorage.getItem('fx-theme') || 'auto'; } catch (e) { /* */ }
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}
function setTheme(t) { try { localStorage.setItem('fx-theme', t); } catch (e) { /* */ } applyTheme(); }

/* ------------------------------------------------------------------ navegación */
const TITLES = { resumen: 'Resumen', mov: 'Movimientos', reg: 'Registrar', hojas: 'Hojas', hoja: 'Hoja', buscar: 'Buscar', ajustes: 'Ajustes' };
function parseHash() {
  const h = location.hash.replace(/^#\/?/, ''); const [path, qs] = h.split('?'); const parts = path.split('/');
  return { name: parts[0] || 'resumen', arg: parts.slice(1).join('/') || null, q: new URLSearchParams(qs || '') };
}
let routeToken = 0;
async function route() {
  if (!state.engine) return;
  const { name, arg, q } = parseHash();
  const token = ++routeToken;
  if (state.screenObj) { try { state.screenObj.destroy && state.screenObj.destroy(); } catch (e) { console.warn(e); } }
  state.screenObj = null; state.grid = null;
  const host = $('#screens'); host.innerHTML = '';
  const view = el('div', { class: 'view', style: { display: 'contents' } }); host.append(view);   // contenedor propio de esta ruta
  const key = SCREENS[name] ? name : 'resumen';
  $('#app').classList.toggle('route-hoja', key === 'hoja' || (key === 'resumen' && !state.mods.dashboard));
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === (key === 'hoja' ? 'hojas' : key)));
  $('#title').textContent = TITLES[key];
  document.title = TITLES[key] + ' · Flujo';
  let obj = null;
  try { obj = (await SCREENS[key](view, arg, q)) || null; }
  catch (e) { console.error(e); view.append(el('div', { class: 'screen' }, el('div', { class: 'card' }, el('h2', { text: 'Algo salió mal' }), el('p', { class: 'muted', text: String(e && e.message || e) })))); }
  if (token !== routeToken) { try { obj && obj.destroy && obj.destroy(); } catch (e) { /* */ } view.remove(); return; }   // el usuario ya navegó a otra pantalla
  state.screenObj = obj;
}

/* ------------------------------------------------------------------ pantallas */
const SCREENS = {
  async resumen(host) {
    const D = state.mods.dashboard;
    if (D && D.mount) { const wrap = el('div', { class: 'screen' }); host.append(wrap); return D.mount(wrap, ctx); }
    return openGridIn(host, 'CONSOL', new URLSearchParams());
  },
  async mov(host, arg) {
    const L = state.mods.ledger;
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    if (L && L.mount) return L.mount(wrap, ctx, { ledgerId: arg });
    wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Movimientos' }), el('p', { class: 'muted', text: 'La captura rápida de movimientos aún no está disponible en esta versión. Usa la pestaña Hojas.' })));
  },
  async reg(host, arg) {
    const Q = state.mods.quick;
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    if (arg && Q && Q.mountForm) {                                  // #/reg/<formId>: formulario de captura
      $('#title').textContent = 'Registrar';
      return Q.mountForm(wrap, ctx, arg);
    }
    wrap.append(el('div', { class: 'card' }, el('h2', { text: '¿Qué quieres registrar?' }),
      el('ul', { class: 'list' }, el('li', { style: { cursor: 'pointer' }, onclick: () => ctx.navigate('mov') },
        el('div', { class: 'grow' }, el('div', { class: 't', text: '🏦  Movimiento bancario' }), el('div', { class: 's', text: 'Depósito, retiro, pago o transferencia en tus cuentas' })),
        el('span', { class: 'muted', html: '&rsaquo;' })))));
    if (Q && Q.mountHub) { const hub = el('div', { style: { marginTop: '12px' } }); wrap.append(hub); return Q.mountHub(hub, ctx); }
    return {};
  },
  async hojas(host) {
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    const render = () => {
      wrap.innerHTML = '';
      const hiddenCount = state.engine.sheets.filter((s) => s.hidden).length;
      for (const g of catalog.groupSheets(state.engine.sheets, { showHidden: state.showHidden })) {
        const card = el('div', { class: 'card' }, el('h2', { text: g.group.icon + '  ' + g.group.title }));
        const ul = el('ul', { class: 'list' });
        for (const { sheet, info } of g.items) {
          ul.append(el('li', { onclick: () => ctx.openSheet(sheet.id, { end: info.end }), style: { cursor: 'pointer' } },
            el('div', { class: 'grow' }, el('div', { class: 't', text: info.short }), el('div', { class: 's', text: info.desc || sheet.name.trim() })),
            sheet.hidden ? el('span', { class: 'badge', text: 'oculta' }) : null,
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
  async buscar(host) {
    const wrap = el('div', { class: 'screen' }); host.append(wrap);
    const input = el('input', { type: 'search', placeholder: 'Buscar en todas las hojas (texto, valores, fórmulas)…', 'aria-label': 'Buscar', autofocus: true });
    const out = el('div', { style: { marginTop: '12px' } });
    wrap.append(el('div', { class: 'field' }, input), out);
    const run = async () => {
      const qv = input.value.trim(); out.innerHTML = '';
      if (qv.length < 2) { out.append(el('p', { class: 'empty', text: 'Escribe al menos 2 letras.' })); return; }
      if (state.engine.sheets.some((s) => !s.loaded)) {           // la primera búsqueda carga todas las hojas
        out.append(el('div', { class: 'empty' }, el('div', { class: 'spin' }), 'Preparando la búsqueda en todas las hojas…'));
        await state.engine.ensureAllAsync();
        if (input.value.trim() !== qv) return; out.innerHTML = '';
      }
      const res = state.engine.search(qv, { max: 200 });
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
  for (const s of eng.sheets) { if (s.hidden && s.id !== sh.id && !state.showHidden) continue; select.append(el('option', { value: s.id, text: catalog.infoFor(s).short + (s.hidden ? ' (oculta)' : ''), selected: s.id === sh.id })); }
  select.addEventListener('change', () => { const info = catalog.infoFor(eng.sheet(select.value)); ctx.openSheet(select.value, { end: info.end }); });
  const bar = el('div', { class: 'sheetbar' }, el('button', { class: 'btn ghost', 'aria-label': 'Volver a Hojas', html: '&lsaquo; Hojas', onclick: () => ctx.navigate('hojas') }), select);
  const gwrap = el('div', { class: 'sheetwrap' });
  wrap.append(bar, gwrap); host.append(wrap);
  const grid = new SheetGrid(gwrap, eng, { onChange: () => ctx.changed([sh.id], 'grid'), onFind: () => ctx.navigate('buscar'), onToast: (m) => toast(m) });
  const info = catalog.infoFor(sh);
  const r = q.get('r'), c = q.get('c');
  if (host.isConnected) $('#title').textContent = info.short;
  grid.open(sh.id, { end: q.get('end') === '1' || (r == null && info.end), r: r != null ? +r : undefined, c: c != null ? +c : undefined });
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
  if (S && U && state.store) {
    if (!state.sync) state.sync = new S.GithubSync(state.store, {});
    U.mountSyncSettings(syncBox, { store: state.store, sync: state.sync, engine: eng, autosaver: state.saver, onBundleReplaced: () => { toast('Datos reemplazados. Recargando…', { type: 'ok' }); setTimeout(() => location.reload(), 800); } });
  } else syncBox.append(el('p', { class: 'muted', text: 'El módulo de sincronización no está disponible.' }));
  wrap.append(syncCard);

  // exportar
  const expCard = el('div', { class: 'card' }, el('h2', { text: 'Exportar y respaldo' }),
    el('p', { class: 'small muted', text: 'Tu información es tuya: descárgala cuando quieras como libro de Excel o como respaldo completo de Flujo.' }));
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
    el('p', { class: 'small muted', text: 'Hojas: ' + eng.sheets.length + ' · motor listo en ' + ((state.buildMs || 0) / 1000).toFixed(1) + ' s · versión ' + VERSION }));
  if (state.store) dev.append(el('div', { class: 'row' },
    el('button', { class: 'btn danger', text: 'Borrar datos de este dispositivo', onclick: async () => {
      if (await ui.confirmDialog('Se borrarán los datos guardados en este dispositivo (no los de GitHub). ¿Continuar?', { ok: 'Borrar', danger: true })) { await state.store.clearAll(); location.reload(); }
    } })));
  wrap.append(dev);

  // acerca de
  wrap.append(el('div', { class: 'card' }, el('h2', { text: 'Acerca de' }),
    el('p', { class: 'small muted', html: 'Flujo reemplaza tu libro de Excel con una app que funciona en cualquier dispositivo. Motor de cálculo: HyperFormula (GPL-3.0). Formatos de número: SSF (Apache-2.0). Código de la app bajo GPL-3.0.' })));
  return {};
}

boot().catch((e) => {
  console.error(e);
  const m = $('#boot-msg'); if (m) { m.textContent = 'No se pudo iniciar: ' + (e && e.message || e); m.style.color = 'var(--neg)'; }
});
