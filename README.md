# Flujo — tus finanzas personales en cualquier dispositivo

Flujo es una aplicación web (PWA) que reemplaza un libro de Excel de finanzas personales: conserva **todas las hojas con sus fórmulas vivas**
y añade pantallas pensadas para el día a día (registrar un movimiento bancario, ver el resumen, buscar). Funciona en Windows, Mac, Linux,
Android y iPhone/iPad desde el navegador, se puede **instalar como aplicación** y **trabaja sin internet**.

No necesita Excel, Microsoft 365 ni ningún plan de pago: la app es gratuita (GitHub Pages) y tus datos viven en **un repositorio privado de tu propia cuenta de GitHub**.

## Cómo se usa

| Pantalla | Para qué sirve |
|---|---|
| **Resumen** | Saldos de tus cuentas, provisiones, variación contra el mes anterior y gráfico de patrimonio. |
| **Movimientos** | Elige una cuenta, mira sus últimos movimientos y agrega uno nuevo (la app escribe en la primera fila libre sin romper fórmulas). |
| **Anotar** (el botón +) | Lista de tus hojas (cuentas y tarjetas): eliges una y **se abre esa hoja en la primera fila libre**, lista para escribir el movimiento. Es la misma lista que sale al pulsar «+ Movimiento». |
| **Hojas** | Las hojas de tu libro, con las mismas fórmulas: edita celdas, copia y pega, rellena hacia abajo, deshaz. |
| **Buscar** | Busca un texto o valor en todas las hojas a la vez. |
| **Ajustes** | Sincronización con GitHub, **código de conexión** para enlazar otro dispositivo, exportar a Excel (.xlsx), respaldo (.json), tema claro/oscuro, instalar la app. |

Al instalar la app (Android, Windows, Mac), mantener pulsado o hacer clic derecho en su ícono ofrece atajos: *Anotar un movimiento* (abre la lista de hojas) y *Ver el resumen*.

En una hoja: toca una celda para seleccionarla, vuelve a tocar (o doble clic / F2) para editar. `Ctrl+Z` deshace, `Ctrl+D` rellena hacia abajo,
el cuadrito azul de la esquina de la selección arrastra fórmulas, y la barra inferior muestra suma y promedio de lo seleccionado.

## Puesta en marcha (una sola vez)

1. **Datos privados.** Crea (o deja que el script cree) un repositorio **privado** en tu GitHub, por ejemplo `flujo-datos`, con los archivos generados por `tools/convert.py`.
2. **App pública.** Publica este repositorio en GitHub Pages (Settings → Pages → rama `main`, carpeta raíz). Queda en `https://TU-USUARIO.github.io/flujo-app/`.
3. **Token de acceso** (uno por dispositivo, se guarda solo en ese dispositivo):
   GitHub → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens* → *Generate new token* →
   *Repository access: Only select repositories* → `flujo-datos` → *Permissions → Repository permissions → Contents: Read and write* → generar y copiar.
4. Abre la app → **Ajustes → Sincronización**, escribe tu usuario, el repositorio (`flujo-datos`) y pega el token → *Probar conexión* → *Descargar todo desde GitHub*.

Atajo: abre la app con `?owner=TU-USUARIO&repo=flujo-datos` al final de la dirección y esos campos ya vienen rellenos (el token nunca va en el enlace).

### Usar la app en otro dispositivo (celular, otro computador)

El token solo se crea **una vez**. Los demás dispositivos se enlazan con un **código de conexión**, sin volver a entrar a GitHub:

1. En un dispositivo que ya está conectado: **Ajustes → Usar en otro dispositivo → Crear código de conexión**. La pantalla muestra una *clave* de 12 letras y números y un *código* largo.
2. Envíate el **código** (WhatsApp a ti mismo, correo…) con «Copiar código», «Copiar enlace» o «Compartir». La **clave no se envía**: se lee de la pantalla.
3. En el dispositivo nuevo abre la app (la misma dirección) → **Ya tengo un código de conexión** → pega el código, escribe la clave y pulsa **Conectar este dispositivo**. La app te muestra a qué cuenta se va a conectar y pide confirmar antes de seguir.
4. Listo: se descargan tus datos y ya puedes anotar movimientos. Con el enlace («Copiar enlace») el código llega relleno y solo escribes la clave.

El código está cifrado (AES-256-GCM, clave derivada con PBKDF2 de 600 000 rondas): sin la clave no sirve. Para cortar el acceso de un dispositivo, borra el token en GitHub.

Después, cada cambio se guarda en el dispositivo y se sube a GitHub a los pocos segundos; en tus otros dispositivos se baja al abrir la app.
Si editas lo mismo en dos dispositivos a la vez, la app te muestra el conflicto y tú eliges qué versión conservar. Como cada cambio es un *commit*, el historial de GitHub sirve de copia de seguridad.

## Privacidad

* El código de la app es público; **tus datos no**: están en el repositorio privado y en el almacenamiento del navegador de tus dispositivos.
* El token solo se guarda en tu dispositivo y solo se envía a `api.github.com`. El código de conexión viaja cifrado y la clave nunca viaja con él; ninguno de los dos se guarda en el dispositivo.
* Al convertir el Excel, los números de tarjeta de crédito se enmascaran (quedan solo los últimos 4 dígitos).

## Para desarrolladores

```bash
python -m http.server 8765          # sirve la carpeta; abre http://localhost:8765/
python tools/convert.py "Flujo.xlsx" --out data --catalog tools/catalog.private.json    # Excel -> data/
python tools/publish.py data --owner USUARIO --repo flujo-datos --dry-run               # simula la publicación
python tools/drop_sheets.py --data COPIA_DE_LOS_DATOS --catalog tools/catalog.private.json --dry-run   # quita hojas que no se usan
```

`data/` (local, ignorada por git) trae la conversión del libro con solo las hojas que usa la app; son también los datos de prueba de `test/`. Si en una conversión nueva del Excel no quieres todas las hojas, `tools/drop_sheets.py` las quita de una **copia** de
los datos —las hojas con `"hide": true` en el catálogo privado, o las que indiques con `--name`— y convierte en valores fijos las pocas fórmulas que dependían de ellas;
esa copia es la que se sube al repositorio privado. Al abrir la app, cada dispositivo suelta las hojas que `meta.json` ya no lista.

* `js/engine.js` — modelo de hojas y motor de cálculo (HyperFormula) con compatibilidad Excel: `SUMIF` con rangos de distinto tamaño, `VALUE("300,00")`, año bisiesto de 1900, comparaciones con acento. Carga diferida de las hojas "finales".
* `js/grid.js` — cuadrícula virtualizada tipo hoja de cálculo (teclado, ratón, táctil, portapapeles, relleno, deshacer).
* `js/format.js` — formatos de número de Excel (SSF) y conversión de lo que se teclea.
* `js/store.js`, `js/sync-github.js`, `js/settings-ui.js` — almacenamiento local (IndexedDB), sincronización con GitHub y su pantalla de ajustes.
* `js/pairing.js` — código de conexión para enlazar dispositivos (PBKDF2-SHA256 + AES-256-GCM con WebCrypto; formato documentado en el encabezado del archivo).
* `tools/` — `convert.py` (Excel → datos), `drop_sheets.py` (quitar hojas), `publish.py` (publicar app y datos), `make_icons.py`.
* `js/ledger.js`, `js/dashboard.js`, `js/quick.js` — movimientos bancarios, resumen y capturas rápidas.
* `js/export.js` — exportación a `.xlsx` y respaldo `.json`. `js/pwa.js` + `sw.js` — instalación y modo sin conexión.
* `test/` — páginas de prueba que se abren en el navegador (`test/verify.html` compara el motor con los valores calculados por Excel: 28 901 de 28 908 fórmulas iguales, 99,98 %).

### Diferencias conocidas con Excel
Cinco celdas antiguas de la hoja de tarjetas de consumo (por ejemplo, una resta entre un texto «9-12» que Excel interpreta como fecha) no coinciden con el valor que Excel había guardado.
Una fórmula de `SUMIF` cuyo rango ampliado generaba una referencia circular se recorta al tamaño de su rango de suma (mismo resultado numérico).

## Licencia

GPL-3.0 (ver `LICENSE`). Incluye [HyperFormula](https://hyperformula.handsontable.com/) (GPL-3.0), [SSF](https://github.com/SheetJS/ssf) y [SheetJS Community](https://sheetjs.com/) (Apache-2.0); sus licencias están en `vendor/`.
