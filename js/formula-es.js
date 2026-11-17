/* formula-es.js — fórmulas en español, como en Excel en español.
 *
 * El motor (HyperFormula) y los datos usan los nombres en inglés (SUMIF, IF, VLOOKUP…) y la coma como separador, igual que el archivo de Excel por dentro.
 * Quien trabaja con Excel en español escribe =SUMAR.SI(C:C;A5;D:D). Este módulo traduce en las dos direcciones:
 *   toEnglish(texto)  lo que se TECLEA o PEGA → lo que se guarda (nombres en inglés y «,» como separador). Acepta nombres en español o en inglés,
 *                     «;» o «,» como separador, y la coma decimal (1,5 → 1.5) cuando se usa «;», fuera de una función o dentro de un paréntesis de agrupar.
 *                     Lo que no reconoce se deja igual.
 *   toSpanish(texto)  lo que se GUARDA → lo que se MUESTRA al editar (nombres en español y «;» como separador; los decimales siguen con punto).
 * Garantía: toEnglish(toSpanish(f)) === f para cualquier fórmula guardada (hay una prueba con todas las fórmulas del libro).
 * Las cadenas entre comillas dobles y los nombres de hoja entre apóstrofos nunca se tocan. Una fórmula con llaves {…} (matriz) solo cambia los nombres.
 */

// nombre en inglés -> nombre en español de Excel
const EN_ES = {
  // matemáticas y trigonometría
  ABS: 'ABS', ACOS: 'ACOS', ACOSH: 'ACOSH', ACOT: 'ACOT', ACOTH: 'ACOTH', ASIN: 'ASENO', ASINH: 'ASENOH', ATAN: 'ATAN', ATAN2: 'ATAN2', ATANH: 'ATANH',
  CEILING: 'MULTIPLO.SUPERIOR', 'CEILING.MATH': 'MULTIPLO.SUPERIOR.MAT', COMBIN: 'COMBINAT', COMBINA: 'COMBINA', COS: 'COS', COSH: 'COSH', COT: 'COT', COTH: 'COTH',
  DEGREES: 'GRADOS', EVEN: 'REDONDEA.PAR', EXP: 'EXP', FACT: 'FACT', FACTDOUBLE: 'FACT.DOBLE', FLOOR: 'MULTIPLO.INFERIOR', 'FLOOR.MATH': 'MULTIPLO.INFERIOR.MAT',
  GCD: 'M.C.D', INT: 'ENTERO', LCM: 'M.C.M', LN: 'LN', LOG: 'LOG', LOG10: 'LOG10', MOD: 'RESIDUO', MROUND: 'REDOND.MULT', ODD: 'REDONDEA.IMPAR', PI: 'PI',
  POWER: 'POTENCIA', PRODUCT: 'PRODUCTO', QUOTIENT: 'COCIENTE', RADIANS: 'RADIANES', RAND: 'ALEATORIO', RANDBETWEEN: 'ALEATORIO.ENTRE', ROUND: 'REDONDEAR',
  ROUNDDOWN: 'REDONDEAR.MENOS', ROUNDUP: 'REDONDEAR.MAS', SERIESSUM: 'SUMA.SERIES', SIGN: 'SIGNO', SIN: 'SENO', SINH: 'SENOH', SQRT: 'RAIZ', SQRTPI: 'RAIZ2PI',
  SUBTOTAL: 'SUBTOTALES', SUM: 'SUMA', SUMIF: 'SUMAR.SI', SUMIFS: 'SUMAR.SI.CONJUNTO', SUMPRODUCT: 'SUMAPRODUCTO', SUMSQ: 'SUMA.CUADRADOS',
  SUMX2MY2: 'SUMAX2MENOSY2', SUMX2PY2: 'SUMAX2MASY2', SUMXMY2: 'SUMAXMENOSY2', TAN: 'TAN', TANH: 'TANH', TRUNC: 'TRUNCAR', ARABIC: 'NUMERO.ARABE', ROMAN: 'NUMERO.ROMANO',
  // lógicas
  AND: 'Y', OR: 'O', NOT: 'NO', XOR: 'XO', IF: 'SI', IFERROR: 'SI.ERROR', IFNA: 'SI.ND', IFS: 'SI.CONJUNTO', SWITCH: 'CAMBIAR', TRUE: 'VERDADERO', FALSE: 'FALSO',
  // información
  ISBLANK: 'ESBLANCO', ISERR: 'ESERR', ISERROR: 'ESERROR', ISEVEN: 'ES.PAR', ISFORMULA: 'ESFORMULA', ISLOGICAL: 'ESLOGICO', ISNA: 'ESNOD', ISNONTEXT: 'ESNOTEXTO',
  ISNUMBER: 'ESNUMERO', ISODD: 'ES.IMPAR', ISREF: 'ESREF', ISTEXT: 'ESTEXTO', NA: 'NOD', TYPE: 'TIPO', N: 'N', COLUMN: 'COLUMNA', COLUMNS: 'COLUMNAS',
  ROW: 'FILA', ROWS: 'FILAS', SHEET: 'HOJA', SHEETS: 'HOJAS',
  // texto
  CHAR: 'CARACTER', CLEAN: 'LIMPIAR', CODE: 'CODIGO', CONCAT: 'CONCAT', CONCATENATE: 'CONCATENAR', EXACT: 'IGUAL', FIND: 'ENCONTRAR', LEFT: 'IZQUIERDA', LEN: 'LARGO',
  LOWER: 'MINUSC', MID: 'EXTRAE', PROPER: 'NOMPROPIO', REPLACE: 'REEMPLAZAR', REPT: 'REPETIR', RIGHT: 'DERECHA', SEARCH: 'HALLAR', SUBSTITUTE: 'SUSTITUIR', T: 'T',
  TEXT: 'TEXTO', TEXTJOIN: 'UNIRCADENAS', TRIM: 'ESPACIOS', UNICHAR: 'UNICAR', UNICODE: 'UNICODE', UPPER: 'MAYUSC', VALUE: 'VALOR',
  // fecha y hora
  DATE: 'FECHA', DATEDIF: 'SIFECHA', DATEVALUE: 'FECHANUMERO', DAY: 'DIA', DAYS: 'DIAS', DAYS360: 'DIAS360', EDATE: 'FECHA.MES', EOMONTH: 'FIN.MES', HOUR: 'HORA',
  ISOWEEKNUM: 'ISO.NUM.DE.SEMANA', MINUTE: 'MINUTO', MONTH: 'MES', NETWORKDAYS: 'DIAS.LAB', 'NETWORKDAYS.INTL': 'DIAS.LAB.INTL', NOW: 'AHORA', SECOND: 'SEGUNDO',
  TIME: 'NSHORA', TIMEVALUE: 'HORANUMERO', TODAY: 'HOY', WEEKDAY: 'DIASEM', WEEKNUM: 'NUM.DE.SEMANA', WORKDAY: 'DIA.LAB', 'WORKDAY.INTL': 'DIA.LAB.INTL',
  YEAR: 'AÑO', YEARFRAC: 'FRAC.AÑO',
  // búsqueda y referencia
  ADDRESS: 'DIRECCION', CHOOSE: 'ELEGIR', FORMULATEXT: 'FORMULATEXTO', HLOOKUP: 'BUSCARH', HYPERLINK: 'HIPERVINCULO', INDEX: 'INDICE', INDIRECT: 'INDIRECTO',
  LOOKUP: 'BUSCAR', MATCH: 'COINCIDIR', OFFSET: 'DESREF', TRANSPOSE: 'TRANSPONER', VLOOKUP: 'BUSCARV',
  // estadística
  AVEDEV: 'DESVPROM', AVERAGE: 'PROMEDIO', AVERAGEA: 'PROMEDIOA', AVERAGEIF: 'PROMEDIO.SI', AVERAGEIFS: 'PROMEDIO.SI.CONJUNTO', CORREL: 'COEF.DE.CORREL',
  COUNT: 'CONTAR', COUNTA: 'CONTARA', COUNTBLANK: 'CONTAR.BLANCO', COUNTIF: 'CONTAR.SI', COUNTIFS: 'CONTAR.SI.CONJUNTO', DEVSQ: 'DESVIA2', FORECAST: 'PRONOSTICO',
  GEOMEAN: 'MEDIA.GEOM', HARMEAN: 'MEDIA.ARMO', INTERCEPT: 'INTERSECCION.EJE', LARGE: 'K.ESIMO.MAYOR', MAX: 'MAX', MAXA: 'MAXA', MAXIFS: 'MAX.SI.CONJUNTO',
  MEDIAN: 'MEDIANA', MIN: 'MIN', MINA: 'MINA', MINIFS: 'MIN.SI.CONJUNTO', MODE: 'MODA', PERCENTILE: 'PERCENTIL', QUARTILE: 'CUARTIL', RANK: 'JERARQUIA',
  SLOPE: 'PENDIENTE', SMALL: 'K.ESIMO.MENOR', STDEV: 'DESVEST', STDEVA: 'DESVESTA', STDEVP: 'DESVESTP', STDEVPA: 'DESVESTPA', VAR: 'VAR', VARA: 'VARA', VARP: 'VARP', VARPA: 'VARPA',
  // finanzas
  CUMIPMT: 'PAGO.INT.ENTRE', CUMPRINC: 'PAGO.PRINC.ENTRE', DB: 'DB', DDB: 'DDB', DOLLARDE: 'MONEDA.DEC', DOLLARFR: 'MONEDA.FRAC', EFFECT: 'INT.EFECTIVO',
  FV: 'VF', FVSCHEDULE: 'VF.PLAN', IPMT: 'PAGOINT', IRR: 'TIR', ISPMT: 'INT.PAGO.DIR', MIRR: 'TIRM', NOMINAL: 'TASA.NOMINAL', NPER: 'NPER', NPV: 'VNA', PDURATION: 'P.DURACION',
  PMT: 'PAGO', PPMT: 'PAGOPRIN', PV: 'VA', RATE: 'TASA', RRI: 'RRI', SLN: 'SLN', SYD: 'SYD', XIRR: 'TIR.NO.PER', XNPV: 'VNA.NO.PER',
  // ingeniería
  BIN2DEC: 'BIN.A.DEC', BIN2HEX: 'BIN.A.HEX', BIN2OCT: 'BIN.A.OCT', DEC2BIN: 'DEC.A.BIN', DEC2HEX: 'DEC.A.HEX', DEC2OCT: 'DEC.A.OCT', HEX2BIN: 'HEX.A.BIN', HEX2DEC: 'HEX.A.DEC',
  HEX2OCT: 'HEX.A.OCT', OCT2BIN: 'OCT.A.BIN', OCT2DEC: 'OCT.A.DEC', OCT2HEX: 'OCT.A.HEX', DELTA: 'DELTA', BASE: 'BASE', DECIMAL: 'CONV.DECIMAL', CONVERT: 'CONVERTIR',
  // más recientes y de matrices
  XLOOKUP: 'BUSCARX', SEQUENCE: 'SECUENCIA', UNIQUE: 'UNICOS', FILTER: 'FILTRAR', SORT: 'ORDENAR', 'VAR.S': 'VAR.S', 'VAR.P': 'VAR.P', 'STDEV.S': 'DESVEST.M', 'STDEV.P': 'DESVEST.P',
  'PERCENTILE.INC': 'PERCENTIL.INC', 'PERCENTILE.EXC': 'PERCENTIL.EXC', 'QUARTILE.INC': 'CUARTIL.INC', 'QUARTILE.EXC': 'CUARTIL.EXC', 'CEILING.PRECISE': 'MULTIPLO.SUPERIOR.EXACTO',
  'FLOOR.PRECISE': 'MULTIPLO.INFERIOR.EXACTO', RSQ: 'COEFICIENTE.R2', SKEW: 'COEFICIENTE.ASIMETRIA', COVAR: 'COVAR', 'NORM.DIST': 'DISTR.NORM.N', 'NORM.INV': 'INV.NORM',
  'NORM.S.DIST': 'DISTR.NORM.ESTAND.N', 'NORM.S.INV': 'INV.NORM.ESTAND',
};

const ES_EN = Object.create(null);       // MAYÚSCULAS en español -> inglés
const EN_ES_U = Object.create(null);     // MAYÚSCULAS en inglés -> español
for (const [en, es] of Object.entries(EN_ES)) { ES_EN[es.toUpperCase()] = en; EN_ES_U[en.toUpperCase()] = es; }
// El motor solo entiende TRUE() y FALSE() como funciones; un TRUE o FALSE suelto da #NAME?. Excel los acepta sueltos (=BUSCARV(A1;B:C;2;FALSO)),
// así que se guardan como TRUE()/FALSE() y se muestran sueltos como VERDADERO/FALSO.
const BOOL_ES = { TRUE: 'TRUE', FALSE: 'FALSE', VERDADERO: 'TRUE', FALSO: 'FALSE' };
const BOOL_EN = { TRUE: 'VERDADERO', FALSE: 'FALSO' };

const IDENT = /^[A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.]*/;
const PART = /[A-Za-zÀ-ÿ0-9_.$!]/;       // carácter que puede ser parte de un nombre o de una referencia (A1, $B$2, Hoja1!C3, SUMAR.SI)
const DIGIT = /\d/;

/**
 * Parte la fórmula en trozos: cadenas "…", nombres de hoja '…', llamadas (nombre seguido de «(»), palabras sueltas y caracteres.
 * Cada trozo es { k: 'str' | 'call' | 'word' | 'ch', v }.
 */
function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {                                                           // cadena: las comillas dobles se duplican dentro
      let j = i + 1;
      while (j < text.length) { if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue; } break; } j++; }
      out.push({ k: 'str', v: text.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (ch === "'") {                                                           // nombre de hoja entre apóstrofos
      const j = text.indexOf("'", i + 1), e = j < 0 ? text.length - 1 : j;
      out.push({ k: 'str', v: text.slice(i, e + 1) }); i = e + 1; continue;
    }
    if (i === 0 || !PART.test(text[i - 1])) {
      const m = IDENT.exec(text.slice(i));
      if (m) { out.push({ k: text[i + m[0].length] === '(' ? 'call' : 'word', v: m[0] }); i += m[0].length; continue; }
    }
    out.push({ k: 'ch', v: ch }); i++;
  }
  return out;
}

const isCh = (t, c) => !!t && t.k === 'ch' && t.v === c;
const isDigit = (t) => !!t && t.k === 'ch' && DIGIT.test(t.v);
/** ¿Lo que hay justo antes del trozo n es un número escrito (…15), y no una referencia como A1 o $B$2? */
function numberBefore(toks, n) {
  let k = n - 1;
  if (!isDigit(toks[k])) return false;
  while (k >= 0 && isDigit(toks[k])) k--;
  const p = toks[k];
  return !!p && p.k === 'ch' && !PART.test(p.v);
}

/** Lo tecleado o pegado → lo que se guarda (inglés, «,»). Si no empieza con «=» se devuelve igual. */
export function toEnglish(text) {
  if (typeof text !== 'string' || text[0] !== '=') return text;
  const toks = tokenize(text);
  const braces = toks.some((t) => isCh(t, '{')), semi = toks.some((t) => isCh(t, ';'));
  const stack = [];                                                             // 'f' = paréntesis de una función, 'g' = paréntesis para agrupar
  let out = '';
  for (let n = 0; n < toks.length; n++) {
    const t = toks[n];
    if (t.k === 'call') { out += ES_EN[t.v.toUpperCase()] || t.v; continue; }
    if (t.k === 'word') { const b = BOOL_ES[t.v.toUpperCase()]; out += b ? b + '()' : t.v; continue; }          // FALSO → FALSE()
    if (t.k !== 'ch') { out += t.v; continue; }
    if (t.v === '(') stack.push(toks[n - 1] && toks[n - 1].k === 'call' ? 'f' : 'g');
    else if (t.v === ')') stack.pop();
    else if (!braces && t.v === ';') { out += ','; continue; }                  // separador de argumentos a la española
    else if (!braces && t.v === ',' && numberBefore(toks, n) && isDigit(toks[n + 1]) && (semi || stack[stack.length - 1] !== 'f')) { out += '.'; continue; }   // 1,5 → 1.5
    out += t.v;
  }
  return out;
}

/** Lo guardado → lo que se muestra al editar (español, «;»). Si no empieza con «=» se devuelve igual. */
export function toSpanish(text) {
  if (typeof text !== 'string' || text[0] !== '=') return text;
  const toks = tokenize(text);
  const braces = toks.some((t) => isCh(t, '{'));
  let out = '';
  for (let n = 0; n < toks.length; n++) {
    const t = toks[n];
    if (t.k === 'call') {
      const up = t.v.toUpperCase();
      if (BOOL_EN[up] && isCh(toks[n + 1], '(') && isCh(toks[n + 2], ')')) { out += BOOL_EN[up]; n += 2; continue; }      // FALSE() → FALSO
      out += EN_ES_U[up] || t.v;
    } else if (t.k === 'word') out += BOOL_EN[t.v.toUpperCase()] || t.v;
    else if (t.k === 'ch' && !braces && t.v === ',') out += ';';
    else out += t.v;
  }
  return out;
}

export const FUNCTION_NAMES = Object.freeze({ ...EN_ES });
