#!/usr/bin/env python3
"""
Convierte un libro de Excel (.xlsx) al formato de datos de FlujoWeb.

Salida (carpeta --out, por defecto ./data):
  meta.json            hojas, estilos, nombres definidos
  sheets/sNN.json      una hoja por archivo: celdas (valores/fórmulas), formatos, anchos, combinadas, notas
  expected.json        valores calculados por Excel en cada celda con fórmula (para verificar el motor)
  mask_report.txt      lista de celdas enmascaradas (números de tarjeta) -- SOLO local, no se sube

Uso:
  python tools/convert.py "Flujo NOV26.xlsx" --out data [--no-mask]

Formato de una hoja (sNN.json):
  { "id","name","hidden","rows","cols","freeze":[fila,col]|null,"tabColor",
    "colWidths":{col:px}, "hiddenCols":[...], "hiddenRows":[...],
    "merges":["A1:B2"], "notes":[[r,c,"texto"]],
    "cells":[[r,c,valor,formula_sin_igual]],      # r,c base 0; valor=None si hay fórmula
    "fmt":[[c,r0,r1,estilo]] }                   # estilos por columna en tramos (RLE), indexan meta.styles
Las fechas se guardan como número de serie de Excel (el formato de celda decide cómo se ven).
"""
import argparse, json, os, re, sys, datetime, colorsys
import openpyxl
from openpyxl.utils import get_column_letter, range_boundaries
from openpyxl.utils.datetime import to_excel
from openpyxl.styles.colors import COLOR_INDEX

CARD_RE = re.compile(r'(?<!\d)(?:\d[ -]?){14,15}\d(?!\d)')  # 15-16 dígitos (con espacios o guiones opcionales)


def theme_palette(wb):
    """Colores del tema del libro (índices 0..9 en el orden que usa Excel: lt1, dk1, lt2, dk2, accent1-6)."""
    xml = getattr(wb, 'loaded_theme', None)
    if isinstance(xml, bytes):
        xml = xml.decode('utf8', 'ignore')
    default = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']
    if not xml:
        return default
    out = []
    for tag in ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']:
        m = re.search(r'<a:%s>.*?(?:srgbClr val="([0-9A-Fa-f]{6})"|lastClr="([0-9A-Fa-f]{6})")' % tag, xml, re.S)
        out.append((m.group(1) or m.group(2)).upper() if m else default[len(out)])
    return out


def apply_tint(hex6, tint):
    if not tint:
        return hex6
    r, g, b = [int(hex6[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = l * (1 + tint) if tint < 0 else l * (1 - tint) + tint
    r, g, b = colorsys.hls_to_rgb(h, max(0, min(1, l)), s)
    return '%02X%02X%02X' % (round(r * 255), round(g * 255), round(b * 255))


def color_hex(c, palette):
    """openpyxl Color -> '#rrggbb' o None (sin color / automático)."""
    if c is None:
        return None
    try:
        t = c.type
        if t == 'rgb':
            rgb = c.rgb
            if isinstance(rgb, str) and len(rgb) >= 6:
                return '#' + rgb[-6:].lower()
            return None
        if t == 'theme':
            idx = c.theme
            if idx is None or idx >= len(palette):
                return None
            return '#' + apply_tint(palette[idx], c.tint or 0).lower()
        if t == 'indexed':
            idx = c.indexed
            if idx in (64, 65) or idx is None:
                return None
            return '#' + COLOR_INDEX[idx][-6:].lower()
    except Exception:
        return None
    return None


def luhn_ok(digits):
    s = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        s += d
    return s % 10 == 0


def mask_card_text(s):
    """Reemplaza números de 15-16 dígitos por ************1234. Devuelve (nuevo, [últimos4...])."""
    hits = []

    def rep(m):
        digits = re.sub(r'\D', '', m.group(0))
        if len(digits) not in (15, 16):
            return m.group(0)
        hits.append(digits[-4:])
        return '*' * (len(digits) - 4) + digits[-4:]

    return CARD_RE.sub(rep, s), hits


CVV_RE = re.compile(r'\b(COD|CVV2?|CVC)\b(\s*[:.#]?\s*)\d{3,4}\b', re.I)
CRED_WORDS_RE = re.compile(r'(cajero|compras\s*web|\bclave\b|\bpassword\b|contrase[ñn]a|\bpin\b)', re.I)
EXPIRY_RE = re.compile(r'^\s*(V/\s*\d{2}-\d{2})\b')


def redact_secrets(s):
    """Códigos de seguridad (CVV) y líneas con usuarios/claves/PIN no se copian jamás a la nube.
    Devuelve (nuevo_texto, [motivos])."""
    why = []
    n = CVV_RE.sub(lambda m: m.group(1) + m.group(2) + '***', s)
    if n != s:
        why.append('código de seguridad')
    if CRED_WORDS_RE.search(n) and re.search(r'\d{2,}', n):
        m = EXPIRY_RE.match(n)
        n = (m.group(1) + ' ' if m else '') + '[credenciales omitidas]'
        why.append('credenciales')
    return n, why


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('--out', default='data')
    ap.add_argument('--no-mask', action='store_true', help='NO enmascarar números de tarjeta')
    ap.add_argument('--catalog', default=None, help='JSON con el catálogo de hojas (grupo, nombre corto, descripción); se guarda en meta.json')
    ap.add_argument('--redact', default=None, help='JSON {hoja: "*" | ["A1:B2", ...]}: celdas con claves/PIN/tarjetas de coordenadas que NO se copian (quedan como "[omitido]")')
    args = ap.parse_args()

    redact_rules = {}
    if args.redact:
        with open(args.redact, encoding='utf8') as fh:
            for sheet_name, rules in json.load(fh).items():
                if rules == '*':
                    redact_rules[sheet_name] = '*'
                else:
                    redact_rules[sheet_name] = [range_boundaries(x if ':' in x else x + ':' + x) for x in rules]   # (c0, r0, c1, r1) base 1

    def is_redacted(title, r1, c1):
        rule = redact_rules.get(title)
        if rule is None:
            return False
        if rule == '*':
            return True
        return any(a <= c1 <= cc and b <= r1 <= rr for (a, b, cc, rr) in rule)

    out = args.out
    os.makedirs(os.path.join(out, 'sheets'), exist_ok=True)

    wf = openpyxl.load_workbook(args.xlsx)                  # fórmulas
    wv = openpyxl.load_workbook(args.xlsx, data_only=True)  # valores calculados por Excel
    palette = theme_palette(wf)
    base_font_sz = 11
    try:
        base_font_sz = wf._fonts[0].sz or 11
    except Exception:
        pass

    styles = [{}]  # estilo 0 = por defecto
    style_key = {json.dumps({}, sort_keys=True): 0}
    style_cache = {}

    def style_id(cell):
        sa = getattr(cell, '_style', None)
        if sa is None:  # celda combinada (MergedCell): sin estilo propio
            return 0
        key = (sa.fontId, sa.fillId, sa.borderId, sa.numFmtId, sa.alignmentId)
        if key in style_cache:
            return style_cache[key]
        st = {}
        nf = cell.number_format
        if sa.numFmtId == 14:
            nf = 'dd/mm/yyyy'  # formato corto de fecha del sistema (Ecuador)
        if nf and nf != 'General':
            st['nf'] = nf
        f = cell.font
        if f is not None:
            if f.b:
                st['b'] = 1
            if f.i:
                st['i'] = 1
            if f.u:
                st['u'] = 1
            if f.strike:
                st['s'] = 1
            col = color_hex(f.color, palette)
            if col and col not in ('#000000',):
                st['fc'] = col
            if f.sz and abs(f.sz - base_font_sz) > 0.01:
                st['sz'] = f.sz
        fl = cell.fill
        if fl is not None and fl.fill_type == 'solid':
            bg = color_hex(fl.fgColor, palette)
            if bg and bg not in ('#ffffff',):
                st['bg'] = bg
        al = cell.alignment
        if al is not None:
            if al.horizontal and al.horizontal not in ('general',):
                st['h'] = al.horizontal
            if al.vertical and al.vertical in ('top', 'center'):
                st['v'] = al.vertical
            if al.wrap_text:
                st['w'] = 1
            if al.indent:
                st['ind'] = int(al.indent)
        bd = cell.border
        if bd is not None:
            sides = ''
            for ch, side in (('t', bd.top), ('b', bd.bottom), ('l', bd.left), ('r', bd.right)):
                if side is not None and side.style:
                    sides += ch
            if sides:
                st['bd'] = sides
        k = json.dumps(st, sort_keys=True)
        sid = style_key.get(k)
        if sid is None:
            sid = len(styles)
            styles.append(st)
            style_key[k] = sid
        style_cache[key] = sid
        return sid

    def to_serial(v):
        if isinstance(v, datetime.datetime):
            return to_excel(v)
        if isinstance(v, datetime.date):
            return to_excel(datetime.datetime(v.year, v.month, v.day))
        if isinstance(v, datetime.time):
            return (v.hour * 3600 + v.minute * 60 + v.second) / 86400.0
        if isinstance(v, datetime.timedelta):
            return v.total_seconds() / 86400.0
        return v

    def clean(v):
        v = to_serial(v)
        if isinstance(v, float) and v == int(v) and abs(v) < 1e15:
            return int(v)
        return v

    mask_log = []
    expected = {}
    sheets_meta = []
    stats = []

    for idx, ws in enumerate(wf.worksheets):
        sid = 's%02d' % (idx + 1)
        wsv = wv[ws.title]
        cells = []
        notes = []
        fmt_cols = {}   # col -> lista de (row, style)
        exp = []
        max_r = max_c = 0
        for row in ws.iter_rows():
            for c in row:
                r0, c0 = c.row - 1, c.column - 1
                sty = style_id(c)
                if sty:
                    fmt_cols.setdefault(c0, []).append((r0, sty))
                    max_r = max(max_r, r0 + 1)
                    max_c = max(max_c, c0 + 1)
                v = c.value
                if v is None:
                    continue
                max_r = max(max_r, r0 + 1)
                max_c = max(max_c, c0 + 1)
                if c.comment:
                    notes.append([r0, c0, c.comment.text.strip()])
                if isinstance(v, str) and v.startswith('=') and c.data_type == 'f':
                    cells.append([r0, c0, None, v[1:]])
                    cv = wsv.cell(c.row, c.column).value
                    exp.append([r0, c0, clean(cv)])
                    continue
                if not isinstance(v, (str, int, float, bool)):
                    v = to_serial(v)
                if is_redacted(ws.title, c.row, c.column):
                    mask_log.append('%s!%s omitido por seguridad (clave / PIN / tarjeta de coordenadas)' % (ws.title, c.coordinate))
                    cells.append([r0, c0, '[omitido]'])
                    continue
                if isinstance(v, str):
                    if not args.no_mask:
                        nv, hits = mask_card_text(v)
                        if hits:
                            mask_log.append('%s!%s texto -> terminaciones %s' % (ws.title, c.coordinate, ','.join(hits)))
                            v = nv
                        nv, why = redact_secrets(v)
                        if why:
                            mask_log.append('%s!%s texto -> %s omitido(s)' % (ws.title, c.coordinate, ' y '.join(why)))
                            v = nv
                else:
                    if not args.no_mask and isinstance(v, (int, float)) and not isinstance(v, bool):
                        iv = int(v) if float(v) == int(v) else None
                        if iv is not None and 10 ** 14 <= abs(iv) < 10 ** 16:
                            s = str(abs(iv))
                            mask_log.append('%s!%s número -> terminación %s' % (ws.title, c.coordinate, s[-4:]))
                            v = '*' * (len(s) - 4) + s[-4:]
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        v = clean(v)
                cells.append([r0, c0, v])

        # tramos de formato por columna (RLE)
        fmt = []
        for c0, lst in fmt_cols.items():
            lst.sort()
            start = prev = None
            cur = None
            for r0, s in lst:
                if cur is not None and s == cur and r0 == prev + 1:
                    prev = r0
                    continue
                if cur is not None:
                    fmt.append([c0, start, prev, cur])
                start, prev, cur = r0, r0, s
            if cur is not None:
                fmt.append([c0, start, prev, cur])

        # anchos de columna
        colw = {}
        hidden_cols = []
        for key, d in ws.column_dimensions.items():
            try:
                mn, mx = d.min, d.max
                if mn is None:
                    continue
                for ci in range(mn, min(mx, mn + 200) + 1):
                    if d.width:
                        colw[ci - 1] = round(d.width * 7 + 5)
                    if d.hidden:
                        hidden_cols.append(ci - 1)
            except Exception:
                pass
        hidden_rows = [r - 1 for r, d in ws.row_dimensions.items() if d.hidden]
        merges = [str(m) for m in ws.merged_cells.ranges]
        freeze = None
        if ws.freeze_panes:
            try:
                mc, mr, _, _ = range_boundaries(ws.freeze_panes + ':' + ws.freeze_panes)
                freeze = [mr - 1, mc - 1]
            except Exception:
                pass
        tab = None
        try:
            tab = color_hex(ws.sheet_properties.tabColor, palette)
        except Exception:
            pass

        sheet_obj = {
            'id': sid, 'name': ws.title, 'hidden': ws.sheet_state != 'visible',
            'rows': max_r, 'cols': max_c, 'freeze': freeze, 'tabColor': tab,
            'gridlines': bool(ws.sheet_view.showGridLines) if ws.sheet_view.showGridLines is not None else True,
            'colWidths': colw, 'hiddenCols': sorted(set(hidden_cols)), 'hiddenRows': hidden_rows,
            'merges': merges, 'notes': notes, 'cells': cells, 'fmt': fmt,
        }
        with open(os.path.join(out, 'sheets', sid + '.json'), 'w', encoding='utf8') as fh:
            json.dump(sheet_obj, fh, ensure_ascii=False, separators=(',', ':'))
        expected[sid] = exp
        sheets_meta.append({'id': sid, 'name': ws.title, 'hidden': sheet_obj['hidden'], 'file': 'sheets/%s.json' % sid,
                            'tabColor': tab, 'rows': max_r, 'cols': max_c})
        stats.append((sid, ws.title, len(cells), sum(1 for x in cells if len(x) > 3), len(fmt), os.path.getsize(os.path.join(out, 'sheets', sid + '.json'))))

    names = {}
    try:
        for nm, dn in wf.defined_names.items():
            if nm.startswith('Z_') or '.wvu.' in nm:
                continue
            names[nm] = dn.attr_text
    except Exception as e:
        print('aviso nombres definidos:', e)

    meta = {'version': 1, 'source': os.path.basename(args.xlsx), 'sheets': sheets_meta, 'styles': styles, 'names': names,
            'epoch': '1899-12-30'}
    if args.catalog:
        with open(args.catalog, encoding='utf8') as fh:
            meta['catalog'] = json.load(fh)
    with open(os.path.join(out, 'meta.json'), 'w', encoding='utf8') as fh:
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(out, 'expected.json'), 'w', encoding='utf8') as fh:
        json.dump(expected, fh, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(out, 'mask_report.txt'), 'w', encoding='utf8') as fh:
        fh.write('\n'.join(mask_log) + '\n')

    print('Hojas: %d | estilos únicos: %d | nombres definidos: %s' % (len(sheets_meta), len(styles), list(names)))
    for sid, name, n, nf, nfmt, size in stats:
        print('  %s %-18s celdas=%6d fórmulas=%6d tramos_fmt=%5d  %7.0f KB' % (sid, repr(name), n, nf, nfmt, size / 1024))
    print('Enmascarados: %d (detalle en %s/mask_report.txt)' % (len(mask_log), out))


if __name__ == '__main__':
    main()
