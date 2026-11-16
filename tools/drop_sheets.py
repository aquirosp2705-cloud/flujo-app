#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""drop_sheets.py — quita hojas de un conjunto de datos de Flujo (meta.json + sheets/sNN.json).

Qué hace
  1. Borra el archivo de cada hoja indicada y la quita de meta.json (lista de hojas y catálogo).
  2. Las fórmulas de las hojas que se quedan y que apuntan a una hoja borrada (o a un nombre definido que apuntaba a
     ella) se convierten en valores fijos: el mismo valor que mostraban, para que no se rompan (#REF!).
     Los valores salen de expected.json (los que calculó Excel al convertir el libro).
  3. Los ids de las hojas que se quedan NO cambian (s05 sigue siendo s05); solo quedan huecos en la numeración.
  4. Las hojas sin referencias a las borradas no se reescriben (siguen idénticas byte a byte).
  La tabla de estilos de meta.json no se compacta: los estilos que solo usaban las hojas borradas quedan sin uso.

Uso
  python tools/drop_sheets.py --data DIR --catalog tools/catalog.private.json     # borra las hojas con "hide": true
  python tools/drop_sheets.py --data DIR --name "Hoja A" --name "Hoja B" --expected data/expected.json
  python tools/drop_sheets.py --data DIR --sid s09 --sid s11 --dry-run              # solo informa, no escribe

DIR es una carpeta con meta.json y sheets/ (la carpeta data/ o una copia del repositorio privado de datos). Si DIR tiene
expected.json se usa para congelar valores y también se le quitan las hojas borradas.
"""
import argparse
import json
import os
import re
import sys


def load_json(path):
    with open(path, encoding='utf8', newline='') as fh:
        text = fh.read()
    return text, json.loads(text)


def dumps(obj):
    # mismo formato que tools/convert.py: compacto, sin escapar acentos y sin salto de línea final
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def write_text(path, text):
    with open(path, 'w', encoding='utf8', newline='') as fh:
        fh.write(text)


def a1(r, c):
    s, c = '', c + 1
    while c:
        c, rem = divmod(c - 1, 26)
        s = chr(65 + rem) + s
    return s + str(r + 1)


def sheet_ref(name):
    """'Nombre con espacios'!  o  NOMBRE!  (Excel solo deja sin comillas los nombres simples)"""
    quoted = re.escape(name.replace("'", "''"))
    return re.compile(r"(?:'%s'|(?<![\w.'])%s)\s*!" % (quoted, re.escape(name)), re.I)


def name_ref(name):
    return re.compile(r"(?<![\w.'!])%s(?![\w(!'])" % re.escape(name), re.I)


def main():
    ap = argparse.ArgumentParser(description='Quita hojas de un conjunto de datos de Flujo y congela las fórmulas que dependían de ellas.')
    ap.add_argument('--data', required=True, help='carpeta con meta.json y sheets/')
    ap.add_argument('--catalog', help='catálogo privado (JSON): se borran las hojas con "hide": true')
    ap.add_argument('--name', action='append', default=[], help='nombre exacto de la hoja a borrar (se puede repetir)')
    ap.add_argument('--sid', action='append', default=[], help='id de la hoja a borrar, p. ej. s09 (se puede repetir)')
    ap.add_argument('--expected', help='expected.json con los valores de Excel (por omisión, el de --data si existe)')
    ap.add_argument('--dry-run', action='store_true', help='solo informar: no escribe ni borra nada')
    a = ap.parse_args()

    data = a.data
    meta_path = os.path.join(data, 'meta.json')
    if not os.path.exists(meta_path):
        sys.exit('No existe %s' % meta_path)
    _, meta = load_json(meta_path)
    sheets = meta['sheets']
    by_name = {s['name']: s for s in sheets}
    by_id = {s['id']: s for s in sheets}

    names = list(a.name)
    if a.catalog:
        with open(a.catalog, encoding='utf8') as fh:
            cat = json.load(fh)
        names += [k for k, v in cat.items() if isinstance(v, dict) and v.get('hide')]
    drop = {}
    for n in names:
        if n not in by_name:
            sys.exit('No existe la hoja «%s» en %s' % (n, meta_path))
        drop[by_name[n]['id']] = by_name[n]
    for i in a.sid:
        if i not in by_id:
            sys.exit('No existe la hoja con id %s en %s' % (i, meta_path))
        drop[i] = by_id[i]
    if not drop:
        sys.exit('No se indicó ninguna hoja: usa --catalog, --name o --sid.')
    if len(drop) >= len(sheets):
        sys.exit('No se pueden borrar todas las hojas.')
    keep = [s for s in sheets if s['id'] not in drop]
    drop_names = [s['name'] for s in drop.values()]
    print('Hojas que se borran (%d): %s' % (len(drop), ', '.join('%s=%s' % (s['id'], s['name'].strip()) for s in drop.values())))
    print('Hojas que se quedan (%d): %s' % (len(keep), ', '.join('%s=%s' % (s['id'], s['name'].strip()) for s in keep)))

    # ---- valores calculados por Excel (para congelar fórmulas)
    exp_path = a.expected or (os.path.join(data, 'expected.json') if os.path.exists(os.path.join(data, 'expected.json')) else None)
    expected = None
    if exp_path:
        with open(exp_path, encoding='utf8') as fh:
            expected = json.load(fh)

    def expected_value(sid, r, c):
        if expected is None:
            return False, None
        for x in expected.get(sid, []):
            if x[0] == r and x[1] == c:
                return True, x[2]
        return True, None            # Excel no guardó valor: la fórmula daba vacío

    # ---- nombres definidos que apuntaban a una hoja borrada
    sheet_pats = [sheet_ref(n) for n in drop_names]
    dead_names = {nm: tg for nm, tg in (meta.get('names') or {}).items() if isinstance(tg, str) and any(p.search(tg) for p in sheet_pats)}
    name_pats = [name_ref(nm) for nm in dead_names]
    if dead_names:
        print('Nombres definidos que se quitan:', ', '.join('%s -> %s' % kv for kv in dead_names.items()))

    # ---- fórmulas de las hojas que se quedan con referencias a las borradas
    lowered = [n.lower() for n in drop_names] + [n.lower() for n in dead_names]
    plan = []        # (sheet, obj, [(cell, valor_congelado, formula)])
    missing_values = False
    for s in keep:
        path = os.path.join(data, s['file'])
        text, obj = load_json(path)
        low = text.lower()
        if not any(n in low for n in lowered):
            continue
        hits = []
        for cell in obj['cells']:
            f = cell[3] if len(cell) > 3 else None
            if f and (any(p.search(f) for p in sheet_pats) or any(p.search(f) for p in name_pats)):
                hits.append(cell)
        if not hits:
            continue
        rows = []
        for cell in hits:
            known, v = expected_value(s['id'], cell[0], cell[1])
            if not known:
                missing_values = True
            rows.append((cell, v, cell[3]))
        plan.append((s, obj, rows))

    total = sum(len(r) for _, _, r in plan)
    print('\nFórmulas de hojas que se quedan y dependen de hojas borradas: %d' % total)
    for s, _, rows in plan:
        for cell, v, f in rows:
            print('  %s!%s  =%s   ->  valor fijo %r' % (s['name'].strip(), a1(cell[0], cell[1]), f, v))
    if missing_values:
        sys.exit('\nNo hay expected.json para saber qué valor mostraban esas celdas. Pasa --expected data/expected.json.')

    if a.dry_run:
        print('\n(--dry-run: no se escribió nada)')
        return

    # ---- aplicar
    for s, obj, rows in plan:
        frozen = {(cell[0], cell[1]): v for cell, v, _ in rows}
        out = []
        for cell in obj['cells']:
            k = (cell[0], cell[1])
            if k in frozen:
                if frozen[k] is not None:          # un valor vacío deja la celda sin contenido
                    out.append([cell[0], cell[1], frozen[k]])
            else:
                out.append(cell)
        obj['cells'] = out
        write_text(os.path.join(data, s['file']), dumps(obj))
    for s in drop.values():
        p = os.path.join(data, s['file'])
        if os.path.exists(p):
            os.remove(p)
    meta['sheets'] = keep
    cat = meta.get('catalog')
    if isinstance(cat, dict):
        for n in drop_names:
            cat.pop(n, None)
    for nm in dead_names:
        meta['names'].pop(nm, None)
    write_text(meta_path, dumps(meta))
    if expected is not None and exp_path and os.path.abspath(os.path.dirname(exp_path)) == os.path.abspath(data):
        for sid in drop:
            expected.pop(sid, None)
        write_text(exp_path, dumps(expected))
    print('\nListo: %d hoja(s) borrada(s), %d fórmula(s) convertidas en valor, %d hoja(s) reescritas.' % (len(drop), total, len(plan)))


if __name__ == '__main__':
    main()
