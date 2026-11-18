# Flujo — tus finanzas personales en cualquier dispositivo

Flujo es una aplicación web (PWA) que reemplaza un libro de Excel de finanzas personales: conserva **todas las hojas con sus fórmulas vivas**
y añade pantallas pensadas para el día a día (registrar un movimiento bancario, ver el resumen, buscar). Funciona en Windows, Mac, Linux,
Android y iPhone/iPad desde el navegador, se puede **instalar como aplicación** y **trabaja sin internet**.

No necesita Excel, Microsoft 365 ni ningún plan de pago: la app es gratuita (GitHub Pages) y tus datos viven en **un repositorio privado de tu propia cuenta de GitHub**.

## Cómo se usa

| Pantalla | Para qué sirve |
|---|---|
| **Resumen** | Saldos de tus cuentas, **inversiones (total y total por banco, con sus vencimientos)**, provisiones, variación contra el mes anterior y gráfico de patrimonio. El botón **«Cerrar mes»** hace el cierre completo de CONSOL (ver abajo). |
| **Movimientos** | Elige una cuenta, mira sus últimos movimientos y agrega uno nuevo (la app escribe en la primera fila libre sin romper fórmulas). |
| **Anotar** (el botón +) | Lista de tus hojas (cuentas y tarjetas): eliges una y **se abre esa hoja en la primera fila libre**, lista para escribir el movimiento. Es la misma lista que sale al pulsar «+ Movimiento». |
| **Hojas** | Las hojas de tu libro, con las mismas fórmulas: edita celdas, copia y pega, rellena hacia abajo, deshaz. |
| **Archivo por mes** (dentro de Hojas) | Una copia de TODAS tus hojas tal como estaban al cerrar cada mes (con los valores que veías, sin fórmulas). Se consulta en solo lectura, con selector de hoja y botón para descargar el Excel. «Guardar el estado de hoy» crea la copia del mes a mano; al cerrar el mes se guarda sola. Se guarda en el dispositivo y se sube a `archivo/AAAA-MM.json.gz` de tu repositorio privado, así la ves también desde el celular. Si un mismo mes tiene dos versiones distintas (la de este dispositivo y otra en GitHub), la app no pisa ninguna: puedes verlas y elegir cuál conservar, y un reemplazo hecho sin conexión tampoco pisa lo que otro dispositivo haya cambiado mientras tanto. Los archivos no van dentro del respaldo (.json): ya están en GitHub. |
| **Ingresos y egresos** (botón del Resumen) | Lo que entró y salió en un mes en tus bancos y tarjetas, **agrupado por rubro**, con los movimientos de cada rubro, flechas para ir de un mes a otro y **«Descargar Excel»** (hojas Resumen y Detalle). Sale sola al terminar «Cerrar mes». |
| **Buscar** | Busca un texto o valor en todas las hojas a la vez. |
| **Ajustes** | Sincronización con GitHub, **código de conexión** para enlazar otro dispositivo, exportar a Excel (.xlsx), respaldo (.json), tema claro/oscuro, instalar la app. |

Al instalar la app (Android, Windows, Mac), mantener pulsado o hacer clic derecho en su ícono ofrece atajos: *Anotar un movimiento* (abre la lista de hojas) y *Ver el resumen*.

### Cerrar el mes

En el Resumen, **«Cerrar mes»** hace lo que hacías a mano en CONSOL: guarda el archivo del mes (copia de todas las hojas), fija como valores la columna del mes que se cierra, abre la columna del mes siguiente, pasa «Mes anterior» al mes cerrado (bancos y patrimonio), actualiza la fecha de CONSOL y prepara la fila de resumen de la lista de ingresos. **Al cerrar diciembre abre el año nuevo** como los anteriores: archiva el año como valores, reinicia el bloque del año, corre el comparativo de diciembres y crea el resumen del año nuevo.

Al terminar sale el **resumen de ingresos y egresos del mes por rubro** (ver abajo, v26).

Antes de escribir nada muestra una **vista previa** en lenguaje sencillo, con avisos y la lista celda por celda (antes → después). Es una sola operación: si algo no cuadra no se cambia nada, y después puedes usar **«Deshacer»** (también desde el Resumen, aunque hayas cerrado la app). Se puede cerrar cualquier día del mes; si todavía no termina, la vista previa lo avisa y pide confirmar.

### Si el navegador borra los datos de la app

Tus datos siguen en GitHub. Al conectar, la app ofrece guardar el token en el administrador de contraseñas del navegador; si después los datos desaparecen, al abrir la app se reconecta sola (o con el botón «Usar el token guardado en el navegador») y baja todo de GitHub. Conectar por primera vez ya trae los datos en un solo paso.

**Cerrar Flujo** (menú lateral y Ajustes → Este dispositivo) guarda y sube lo pendiente y cierra la ventana (si no pudo guardar en este dispositivo, avisa y NO cierra). La app se abre en una sola ventana: en un mismo navegador solo puede haber una ventana o pestaña de Flujo a la vez; si abres una segunda, avisa y espera a que cierres la otra (así una ventana vieja no pisa lo que guardó la nueva, por ejemplo un cierre de mes).

**Fórmulas como en Excel:** un `+` o `-` al principio empieza una fórmula (`+H2050+E2051`); mientras la escribes, un clic en otra celda (o una flecha) inserta su dirección, arrastrar inserta un rango y Mayús+clic lo extiende. Otro clic seguido cambia la celda apuntada.

**Conexión siempre a la vista:** si el dispositivo no está conectado a GitHub (o GitHub ya no acepta el token), sale un aviso rojo arriba con «Conectar ahora». Para reconectar sin crear otro token, pega tu código de conexión; si de verdad hace falta uno nuevo, Ajustes trae «Crear un token nuevo en GitHub», que abre el formulario ya lleno (solo falta elegir el repositorio flujo-datos).

**Funciones en español:** escribe las fórmulas como en tu Excel en español: `=SUMAR.SI(C:C;A5;D:D)`, `=SI(A1>0;"sí";"no")`, `=BUSCARV(A1;B:C;2;FALSO)`, `=REDONDEAR(A1*1,15;2)`; sirven `;` o `,` entre argumentos, mayúsculas o minúsculas, y los nombres en inglés también. Al editar una celda la fórmula se muestra en español con `;`. Por dentro se guarda en inglés (`=SUMIF(C:C,A5,D:D)`, el mismo formato del archivo de Excel), así que la exportación a Excel y todas las demás fórmulas no cambian. Se traducen unas 200 funciones (`js/formula-es.js`); una que no esté en la tabla se escribe tal cual.

**Negrita y colores (para conciliar):** en la barra de la hoja, «N» (o Ctrl+B) pone o quita negrita, «A ▾» cambia el color de la letra, el cuadro amarillo ▾ el relleno y «Sin color» los quita; el formato de número se conserva. Todo se guarda y se sincroniza, y «Deshacer» (Ctrl+Z) lo revierte en orden. En el celular la barra se abre con el botón de herramientas.

**Formatos al anotar:** lo que tecleas en una celda sin formato toma el formato de la celda de arriba en esa columna (como Excel): las fechas quedan como fechas del estilo de la columna y los montos como dólares con centavos. Se guarda el valor completo; solo cambia cómo se muestra.

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
* `js/invest.js` — tarjeta «Inversiones» del Resumen: lee las pólizas de la hoja de pólizas y suma el total invertido y el total por banco (con los ahorros a plazo aparte y la explicación de por qué el patrimonio cuenta menos).
* `js/close.js` — cierre de mes completo de CONSOL (sin interfaz): `planClose` (calcula y valida sin escribir), `applyClose` (escribe en una sola tanda y verifica; si algo falla restaura todo) y `undoClose`; descubre los bloques anuales y los resúmenes por su estructura, así que sirve también para 2027 en adelante. Pruebas: `test/close-test.html`.
* `js/recover.js` — guarda y recupera el token con el administrador de contraseñas del navegador (Credential Management API) y arma el diagnóstico de almacenamiento. Pruebas: `test/recover-test.html`.
* `js/archive.js` — archivo mensual: congela las hojas como valores, las comprime (gzip), las guarda en IndexedDB y las sube a `archivo/` del repositorio privado; trae la pantalla de lista y el visor de solo lectura (`css/archive.css`). Pruebas: `test/archive-test.html`.
* `js/export.js` — exportación a `.xlsx` y respaldo `.json`. `js/pwa.js` + `sw.js` — instalación y modo sin conexión.
* `test/` — páginas de prueba que se abren en el navegador (`test/verify.html` compara el motor con los valores calculados por Excel: 28 901 de 28 908 fórmulas iguales, 99,98 %).

### Diferencias conocidas con Excel
Cinco celdas antiguas de la hoja de tarjetas de consumo (por ejemplo, una resta entre un texto «9-12» que Excel interpreta como fecha) no coinciden con el valor que Excel había guardado.
Una fórmula de `SUMIF` cuyo rango ampliado generaba una referencia circular se recorta al tamaño de su rango de suma (mismo resultado numérico).

## Licencia

GPL-3.0 (ver `LICENSE`). Incluye [HyperFormula](https://hyperformula.handsontable.com/) (GPL-3.0), [SSF](https://github.com/SheetJS/ssf) y [SheetJS Community](https://sheetjs.com/) (Apache-2.0); sus licencias están en `vendor/`.

## Celdas de la fórmula encendidas (v20)
Al editar una celda con fórmula (doble clic, F2, Enter o en la barra de fórmulas), cada celda o rango de **esta hoja**
que usa la fórmula se enciende con un recuadro de color (como Excel). Se actualiza al escribir y se apaga al terminar.
Las referencias a otras hojas no se marcan.

## Clave única para los otros dispositivos (v22)

En el computador donde Flujo ya está conectado: **Ajustes → «Clave única para tus otros dispositivos»**, escribe tu clave
dos veces y pulsa «Crear acceso con mi clave». Se descarga `acceso.json`: la conexión con GitHub cifrada con esa clave
(PBKDF2-SHA256 de 2 000 000 rondas + AES-256-GCM, formato «FLUJO2.…» en `js/pairing.js`). Ese archivo se publica junto
con la app (`tools/publish.py` lo incluye y comprueba que tenga exactamente la forma esperada y que nada lleve un token en
claro). Desde entonces, en el iPhone, el iPad o cualquier otro dispositivo, la pantalla de primer uso pide **solo la clave**:
la abre, prueba la conexión, la guarda en el dispositivo y baja los datos. No importan mayúsculas, tildes ni espacios.

- La clave nunca sale del dispositivo donde se escribe; `acceso.json` es público, por eso se exige una clave larga
  (mínimo 12 caracteres; mejor una frase de 3 o 4 palabras que no tenga que ver con la persona).
- Si el token de GitHub vence o se cambia, hay que crear la clave única de nuevo y volver a publicar `acceso.json`.
- El código de conexión de siempre sigue disponible («¿Tienes un código de conexión? Úsalo aquí»).
- Pruebas: `_e2e/clave_unica_e2e.py` (32) y `_e2e/ios_reabrir_e2e.py` (10: conectar en la app del ícono, cerrar y abrir).

- v23: si el dispositivo ya tiene la conexión guardada pero no datos (se cerró la app en plena primera descarga), al abrir
  termina de bajar todo sin volver a pedir la clave (`resumeDownload` en js/app.js).
- v24: en el celular (≤ 640 px) la fila de la hoja muestra siempre ↶ Deshacer, ↷ Rehacer, Negrita, color de letra, relleno y
  «Sin color»; el resto de herramientas sigue detrás de «⋯» (`_e2e/movil_herramientas_e2e.py`, 17).
- v25 (revisión): la clave nueva exige 3 palabras y 16 letras (o 20 seguidas) y rechaza palabras típicas; la puntuación de iOS
  (’ “ ” —) cuenta como la simple y los accesos ya creados siguen abriendo; sin señal se ofrece «Reintentar»; acceso.json no
  pasa por la caché del service worker; Ajustes avisa si cambiaste el token después de crear la clave y que **crear otra
  clave no anula la anterior** (los accesos viejos quedan en el historial público: para cortar el acceso hay que cambiar el
  token en GitHub). `tools/publish.py --update` se detiene si el sitio tiene acceso.json y la carpeta no (`--quitar-acceso`
  para apagarla a propósito) y revisa en bytes que ningún archivo lleve un token en claro.
- Ojo: todas las apps de `<usuario>.github.io` comparten el mismo origen (almacenamiento del navegador y llavero). Para
  aislar Flujo del todo convendría servirla desde un dominio propio o una cuenta de GitHub dedicada.

## Aviso de pólizas y resumen por rubro (v26)
- **Aviso de pólizas**: al abrir la app (y si queda abierta y vuelve a primer plano otro día), si una póliza de la hoja de
  pólizas vence en **5 días o menos** o ya venció, sale una ventana con cada póliza (banco · destino, monto, «Vence dd/mm/aaaa
  (en N días)») y el total, con «Entendido» y «Renovar póliza». Usa la misma lista que el formulario «Renovar póliza»
  (`listPolicies`); al renovarla el aviso desaparece solo (`duePolicies` / `showDueAlert` en js/invest.js).
- **Ingresos y egresos del mes** (js/rubros.js, `summarizeMonth`): cuentas bancarias (concepto = descripción), tarjeta de
  consumos (rubro = columna B; si C es un número es la cuota de una compra diferida) y la hoja de tarjeta + cuenta de ahorros
  (la cuenta se lee como un banco; la zona de la tarjeta no tiene fechas: los consumos de un mes son los anotados después del
  pago del mes anterior y hasta el pago de ese mes, ubicando los pagos por monto en la cuenta; lo anotado después del pago va
  al mes siguiente). El mes de cada fila (`assignMonths`; también fechas escritas como texto: «nov26», «mzo-27»): **en los
  bancos manda la fecha que escribiste** (v28: si cambias la fecha de un movimiento, pasa a ese mes) y, si está anotado entre
  movimientos de otro mes, sale en «Para revisar» en los dos meses; solo un año mal tipeado (2025 por 2026), una fecha a más
  de 2 meses del bloque o una fila sin fecha cuentan en el mes del bloque donde están. En la tarjeta de consumos cuenta el corte
  donde está la fila (las cuotas copiadas conservan el mes de compra). Así ninguna fila cae en dos meses. Un ajuste grande de la tarjeta
  (columna E, más de $10) va a «Ajustes de la tarjeta» y no deforma el rubro de la fila.
  **No suman** (para no contar dos veces): pagos de tarjeta desde un banco, dinero entre tus cuentas (palabras como «de bol»,
  «a produb» o el mismo monto que sale de una y entra en otra) y pólizas. Comisiones pequeñas pegadas a un egreso van a
  «Comisiones bancarias». Pantalla `#/rubros/AAAA-MM`; ventana automática al cerrar el mes; Excel con hojas Resumen y Detalle.
- El aviso de pólizas espera si al abrir hay otra ventana (por ejemplo, el atajo «Anotar») y se revisa también cada 5 minutos
  y al volver el foco, por si la app queda abierta de un día para otro.
- Pruebas: `test/rubros-test.html` (135 con 8 meses de datos reales: `?data=` apunta a una copia local; incluye casos de
  `assignMonths`) y `_e2e/rubros_e2e.py` (33: aviso al abrir con el reloj en 03/12, pantalla, cierre de noviembre con la
  ventana y el Excel, celular y pantalla ancha). `close-test.html` y `dashboard-test.html` montan el Resumen con
  `closeSummary: false` (no abren la ventana del resumen al cerrar).

## Bordes en la hoja (v27)
En la barra de la hoja, junto a los colores, el botón **Bordes ▾** (también a la vista en el celular) pone rayas finas como en
Excel sobre lo seleccionado: **Raya abajo** (borde inferior del rango), **Raya arriba**, **Raya arriba y abajo**, **Todos los
bordes**, **Contorno** (solo el borde exterior) y **Sin bordes** (quita también la raya de la celda vecina que toca lo
seleccionado). Se guarda en el estilo de cada celda (`bd`), se deshace con ↶ o Ctrl+Z, se sincroniza y sale en el Excel
descargado. En solo lectura (visor del archivo mensual) el botón no aparece. Prueba: `_e2e/bordes_e2e.py` (24).

## Excel con formato (v21)
«Descargar Excel» (y el Excel de un mes archivado) sale con negrita, cursiva, subrayado, tachado, tamaño y color de
letra, relleno, bordes, alineación, ajuste de texto y sangría, además de los formatos de número. SheetJS Community no
escribe estilos: `applyCellStyles` (js/export.js) cambia xl/styles.xml y el `s=""` de cada celda dentro del zip. Las
celdas vacías con relleno o borde también salen. Si el coloreado fallara, el archivo se entrega igual, sin colores
(`report.stylesError`). Prueba: `_e2e/excel_formato_e2e.py`.
