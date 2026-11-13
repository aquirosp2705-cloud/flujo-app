#!/usr/bin/env python3
"""
Publica Flujo en GitHub usando la CLI `gh` (ya autenticada) y `git`.

  python tools/publish.py data --owner USUARIO --repo flujo-datos            # repo PRIVADO con tus datos (meta.json + hojas)
  python tools/publish.py app  --owner USUARIO --repo flujo-app              # repo PÚBLICO con la app (sin datos) + GitHub Pages
  añade --dry-run para ver qué se subiría SIN crear ni subir nada.

Reglas de seguridad incorporadas:
  * `data`: sube SOLO meta.json y sheets/*.json (nunca expected.json ni mask_report.txt) y exige que el repo quede PRIVADO.
  * `app`: sube solo una lista blanca de archivos (sin data/, test/, .claude/, tools/*.private.*) y ANTES de subir
    escanea el contenido buscando datos personales (términos de tools/privacy.private.txt, correos, cuentas largas,
    números de tarjeta). Si encuentra algo, se detiene y lo lista.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

APP_ALLOW = ['index.html', 'manifest.webmanifest', 'sw.js', 'LICENSE', 'README.md', '.nojekyll']
APP_DIRS = ['css', 'js', 'vendor', 'icons']
APP_TOOLS = ['tools/convert.py', 'tools/publish.py']
SKIP_NAMES = {'__pycache__', '.DS_Store', 'Thumbs.db'}
SAFE_EXAMPLES = {'0012345678', '1234567890', '0123456789', '1234567890123456'}   # números de ejemplo ficticios en comentarios


def run(cmd, cwd=None, check=True, capture=True):
    r = subprocess.run(cmd, cwd=cwd, text=True, encoding='utf8', capture_output=capture)
    if check and r.returncode != 0:
        raise SystemExit('ERROR al ejecutar: %s\n%s\n%s' % (' '.join(cmd), r.stdout, r.stderr))
    return r


def need_gh():
    r = run(['gh', 'auth', 'status'], check=False)
    if r.returncode != 0:
        raise SystemExit('gh no está autenticado. Ejecuta: gh auth login')


def stage_data(stage):
    src = os.path.join(ROOT, 'data')
    if not os.path.isfile(os.path.join(src, 'meta.json')):
        raise SystemExit('No existe data/meta.json. Ejecuta primero tools/convert.py')
    os.makedirs(os.path.join(stage, 'sheets'))
    shutil.copy2(os.path.join(src, 'meta.json'), os.path.join(stage, 'meta.json'))
    n = 0
    for f in sorted(os.listdir(os.path.join(src, 'sheets'))):
        if re.fullmatch(r's\d\d\.json', f):
            shutil.copy2(os.path.join(src, 'sheets', f), os.path.join(stage, 'sheets', f)); n += 1
    with open(os.path.join(stage, 'README.md'), 'w', encoding='utf8') as fh:
        fh.write('# Datos de Flujo (PRIVADO)\n\nEste repositorio guarda los datos de la app Flujo: `meta.json` y una hoja por archivo en `sheets/`.\n'
                 'Lo modifica la app automáticamente (cada cambio es un commit: sirve de historial para deshacer). No lo edites a mano ni lo hagas público.\n')
    return n


def stage_app(stage):
    os.makedirs(stage, exist_ok=True)
    files = []
    for f in APP_ALLOW:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p):
            shutil.copy2(p, os.path.join(stage, f)); files.append(f)
    for d in APP_DIRS:
        src = os.path.join(ROOT, d)
        if not os.path.isdir(src):
            continue
        for base, dirs, names in os.walk(src):
            dirs[:] = [x for x in dirs if x not in SKIP_NAMES]
            for n in names:
                if n in SKIP_NAMES or '.private.' in n:
                    continue
                rel = os.path.relpath(os.path.join(base, n), ROOT)
                os.makedirs(os.path.dirname(os.path.join(stage, rel)), exist_ok=True)
                shutil.copy2(os.path.join(base, n), os.path.join(stage, rel)); files.append(rel.replace('\\', '/'))
    for t in APP_TOOLS:
        p = os.path.join(ROOT, t)
        if os.path.isfile(p):
            os.makedirs(os.path.join(stage, 'tools'), exist_ok=True)
            shutil.copy2(p, os.path.join(stage, t)); files.append(t)
    open(os.path.join(stage, '.nojekyll'), 'w').close()
    return sorted(set(files))


def privacy_scan(stage):
    terms = []
    tf = os.path.join(ROOT, 'tools', 'privacy.private.txt')
    if os.path.isfile(tf):
        terms = [l.strip() for l in open(tf, encoding='utf8') if l.strip() and not l.startswith('#')]
    generic = [
        (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'), 'correo electrónico'),
        (re.compile(r'(?<![\w.])\d{9,}(?![\w.])'), 'número largo (cuenta / cédula / tarjeta)'),
    ]
    hits = []
    for base, _, names in os.walk(stage):
        for n in names:
            p = os.path.join(base, n)
            rel = os.path.relpath(p, stage).replace('\\', '/')
            if rel.startswith('vendor/') or n.lower().endswith(('.png', '.jpg', '.ico', '.svg')) or n == 'LICENSE':
                continue                      # librerías de terceros e imágenes: no son código propio
            try:
                text = open(p, encoding='utf8').read()
            except Exception:
                continue
            low = text.lower()
            for t in terms:
                if t.lower() in low:
                    hits.append((rel, 'término privado «%s»' % t))
            for rx, label in generic:
                for m in rx.finditer(text):
                    if m.group(0) in SAFE_EXAMPLES or 'noreply' in m.group(0) or (rel.endswith('.py') and label.startswith('número')):
                        continue
                    hits.append((rel, '%s: %s' % (label, m.group(0)[:40])))
                    break
    return hits


def ensure_identity(stage):
    """Si git no tiene nombre/correo configurados, usa la dirección privada «noreply» de GitHub (no expone tu correo real)."""
    name = run(['git', 'config', '--get', 'user.name'], cwd=stage, check=False).stdout.strip()
    email = run(['git', 'config', '--get', 'user.email'], cwd=stage, check=False).stdout.strip()
    if not name or not email:
        u = json.loads(run(['gh', 'api', 'user']).stdout)
        run(['git', 'config', 'user.name', u['login']], cwd=stage)
        run(['git', 'config', 'user.email', '%s+%s@users.noreply.github.com' % (u['id'], u['login'])], cwd=stage)


def git_commit_push(stage, owner, repo, private, msg):
    run(['git', 'init', '-b', 'main'], cwd=stage)
    ensure_identity(stage)
    run(['git', 'add', '-A'], cwd=stage)
    run(['git', 'commit', '-m', msg, '-m', 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'], cwd=stage)
    vis = '--private' if private else '--public'
    exists = run(['gh', 'repo', 'view', '%s/%s' % (owner, repo)], check=False).returncode == 0
    if exists:
        raise SystemExit('El repositorio %s/%s YA existe; no lo sobrescribo. Bórralo en GitHub o usa otro nombre.' % (owner, repo))
    run(['gh', 'repo', 'create', '%s/%s' % (owner, repo), vis, '--source', '.', '--remote', 'origin', '--push'], cwd=stage)
    info = json.loads(run(['gh', 'repo', 'view', '%s/%s' % (owner, repo), '--json', 'visibility,url']).stdout)
    return info


def update_app(stage, owner, repo, msg):
    """Actualiza un repositorio de app YA publicado: clona, reemplaza los archivos por los preparados y sube solo si hay cambios."""
    clone = tempfile.mkdtemp(prefix='flujo-clone-')
    try:
        run(['gh', 'repo', 'clone', '%s/%s' % (owner, repo), clone])
        for name in os.listdir(clone):
            if name == '.git':
                continue
            p = os.path.join(clone, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
        for name in os.listdir(stage):
            s, d = os.path.join(stage, name), os.path.join(clone, name)
            shutil.copytree(s, d) if os.path.isdir(s) else shutil.copy2(s, d)
        ensure_identity(clone)
        run(['git', 'add', '-A'], cwd=clone)
        if not run(['git', 'status', '--porcelain'], cwd=clone).stdout.strip():
            return None
        run(['git', 'commit', '-m', msg, '-m', 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'], cwd=clone)
        run(['git', 'push', 'origin', 'HEAD'], cwd=clone)
        return run(['git', 'rev-parse', '--short', 'HEAD'], cwd=clone).stdout.strip()
    finally:
        shutil.rmtree(clone, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('what', choices=['data', 'app'])
    ap.add_argument('--owner', required=True)
    ap.add_argument('--repo', required=True)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--update', action='store_true', help='(solo app) actualiza un repositorio ya publicado en lugar de crearlo')
    ap.add_argument('--message', default='Flujo: actualización de la app')
    a = ap.parse_args()
    need_gh()
    stage = tempfile.mkdtemp(prefix='flujo-publish-')
    try:
        if a.what == 'data':
            n = stage_data(stage)
            print('Datos a subir: meta.json + %d hojas  ->  %s/%s (PRIVADO)' % (n, a.owner, a.repo))
            if a.dry_run:
                print('(dry-run) no se subió nada. Preparado en', stage); return
            info = git_commit_push(stage, a.owner, a.repo, True, 'Datos iniciales de Flujo')
            if info['visibility'].upper() != 'PRIVATE':
                raise SystemExit('¡El repositorio quedó %s! Cámbialo a privado de inmediato.' % info['visibility'])
            print('Listo (PRIVADO):', info['url'])
        else:
            files = stage_app(stage)
            print('Archivos de la app (%d):' % len(files))
            for f in files: print('  ', f)
            hits = privacy_scan(stage)
            if hits:
                print('\nSE ENCONTRARON POSIBLES DATOS PERSONALES. No se publica:')
                for rel, why in hits: print('  %-40s %s' % (rel, why))
                raise SystemExit(2)
            print('\nEscaneo de privacidad: sin hallazgos.')
            if a.dry_run:
                print('(dry-run) no se subió nada.'); return
            if a.update:
                sha = update_app(stage, a.owner, a.repo, a.message)
                print('Sin cambios que subir.' if sha is None else 'Actualización subida (commit %s). GitHub Pages la publica en 1-2 min.' % sha)
                return
            info = git_commit_push(stage, a.owner, a.repo, False, 'Flujo: app web')
            r = run(['gh', 'api', '-X', 'POST', 'repos/%s/%s/pages' % (a.owner, a.repo), '-f', 'source[branch]=main', '-f', 'source[path]=/'], check=False)
            print('Pages:', 'activado' if r.returncode == 0 else ('ya estaba activo o falló: ' + (r.stderr or r.stdout).strip()[:200]))
            print('Repositorio:', info['url'])
            print('App (puede tardar 1-2 min en estar en línea): https://%s.github.io/%s/' % (a.owner, a.repo))
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    main()
