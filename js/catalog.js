/* catalog.js — agrupación de hojas para la pantalla "Hojas".
 * El catálogo (nombre exacto de hoja -> {group, short, desc, end, ledger}) NO vive en el código: viaja dentro de
 * meta.json (campo `catalog`, que se genera con tools/convert.py --catalog tools/catalog.private.json) para que el
 * repositorio público de la app no contenga datos personales. Si falta, las hojas caen en el grupo "Otras". */
export const GROUPS = [
  { id: 'tablero', title: 'Tablero', icon: '◧' },
  { id: 'bancos', title: 'Cuentas bancarias', icon: '🏦' },
  { id: 'tarjetas', title: 'Tarjetas de crédito', icon: '💳' },
  { id: 'credito', title: 'Préstamos, inversiones y pólizas', icon: '📈' },
  { id: 'servicios', title: 'Servicios y hogar', icon: '💡' },
  { id: 'viajes', title: 'Viajes', icon: '✈️' },
  { id: 'otras', title: 'Otras', icon: '📄' },
];

let CATALOG = {};
export function setCatalog(c) { CATALOG = c || {}; }
export const getCatalog = () => CATALOG;

export function infoFor(sheet) {
  const c = CATALOG[sheet.name];
  return { group: c ? c.group : 'otras', short: c && c.short ? c.short : sheet.name.trim(), desc: c ? (c.desc || '') : '', end: !!(c && c.end), ledger: !!(c && c.ledger) };
}

/** Devuelve [{group, items:[{sheet, info}]}] respetando el orden de GROUPS y el del libro dentro de cada grupo. */
export function groupSheets(sheets, { showHidden = false } = {}) {
  const out = GROUPS.map((g) => ({ group: g, items: [] }));
  const byId = Object.fromEntries(out.map((o) => [o.group.id, o]));
  for (const s of sheets) {
    if (s.hidden && !showHidden) continue;
    const info = infoFor(s);
    (byId[info.group] || byId.otras).items.push({ sheet: s, info });
  }
  return out.filter((o) => o.items.length);
}
