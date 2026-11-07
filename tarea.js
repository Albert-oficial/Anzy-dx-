'use strict';
// Lógica pura (sin red ni WhatsApp) para resolver tareas a partir de fotos:
//  - detectar qué quiere la persona,
//  - construir el prompt estructurado,
//  - interpretar la respuesta JSON del modelo de visión,
//  - verificar cálculos por código,
//  - dar formato de texto para WhatsApp.

const { verificarItem, embellecerMatematica } = require('./matematica');

// ── Intención del usuario ───────────────────────────────────────────────────
const RE_TAREA = /\b(resuelv\w*|resolver|resu[eé]lve\w*|resoluci[oó]n|soluci[oó]n\w*|tarea|ejercicios?|problemas?|calcul\w*|procedimientos?|desarroll\w*|grafic\w*|gr[aá]ficos?|demuestra|simplific\w*|factoriz\w*|deriv\w*|integra\w*|despeja\w*|ecuaci[oó]n\w*|halla\w*|determina\w*|responde\w*\s+(las|todas|las\s+preguntas)|contesta\w*)/i;
const RE_HOJA = [
  /\b(p[aá]sa(me)?(lo|la|los|las|melo|mela|melos|melas)?|env[ií]a(me)?(lo|la|los|las|melo|mela)?|dame(lo|la|los|las)?|entr[eé]ga(me)?(lo|la)?|hazme|haz|crea(me)?|genera(me)?|quiero|necesito)\b[^.\n]{0,70}\b(en\s+(una\s+)?(foto|fotograf[ií]a|imagen|hoja)|una\s+(foto|fotograf[ií]a|imagen|hoja))\b/i,
  /\b(foto|fotograf[ií]a|imagen|hoja)\b[^.\n]{0,50}\b(resuelt[ao]s?|con\s+(las\s+)?(respuestas?|soluci[oó]n(es)?)|con\s+(sus\s+)?(respectivas\s+)?(respuestas?|gr[aá]ficos?)|con\s+las\s+preguntas)\b/i,
  /\ben\s+(foto|imagen)\b/i
];
const RE_LEER = /\b(lee|leer|l[eé]eme|transcrib\w*|qu[eé]\s+dice|qu[eé]\s+tengo\s+que\s+hacer|extrae|de\s+qu[eé]\s+trata|describe|descr[ií]beme|qu[eé]\s+(es|hay|ves|significa)|traduce\w*)\b/i;
const RE_IMAGEN_RECIENTE = [
  /\b(imagen|foto|fotograf[ií]a|captura|tarea|ejercicios?|hoja|p[aá]gina|cuaderno|libro|pregunta)\b/i,
  /\b(resuelve|resu[eé]lve|resolver|lee|l[eé]e|explica|expl[ií]came|ay[uú]dame)\b[^.\n]{0,25}\b(esto|esta|este|estos|estas|eso|todo)\b/i
];

function detectarIntencionImagen(texto) {
  const t = String(texto || '');
  const hoja = RE_HOJA.some(r => r.test(t));
  const tarea = hoja || RE_TAREA.test(t);
  const leer = !tarea && RE_LEER.test(t);
  return { tarea, hoja, leer };
}

function refiereAImagenReciente(texto) {
  const t = String(texto || '');
  return RE_IMAGEN_RECIENTE.some(r => r.test(t));
}

// ── Prompt estructurado ─────────────────────────────────────────────────────
const ESQUEMA_RESPUESTA = `{
  "legible": true,
  "motivo_ilegible": "solo si legible=false: qué falla (borrosa, cortada, oscura...) y qué foto pedir",
  "titulo": "título breve de la tarea, p. ej. 'Matemática — Ecuaciones'",
  "ejercicios": [
    {
      "numero": "1",
      "enunciado": "texto exacto del ejercicio tal como se lee en la foto",
      "pasos": ["Paso 1 con la operación intermedia", "Paso 2 ..."],
      "respuesta": "respuesta final breve",
      "verificaciones": [
        { "tipo": "calculo", "expresion": "12*(3+4)", "resultado": 84 },
        { "tipo": "ecuacion", "ecuacion": "2*x+3=11", "variable": "x", "valor": 4 }
      ],
      "grafico": null,
      "datos_faltantes": null,
      "lectura_dudosa": false
    }
  ],
  "advertencias": ["cualquier ejercicio que no pudiste leer o resolver, y por qué"]
}`;

const GUIA_GRAFICOS = `GRÁFICOS (campo "grafico", opcional; usa null si no hace falta). El bot los dibuja por código, tú solo describes los datos:
- Función: {"tipo":"funcion","titulo":"...","funciones":[{"expr":"x^2-4","etiqueta":"y = x^2 - 4"}],"xmin":-5,"xmax":5,"puntos":[{"x":2,"y":0,"etiqueta":"(2, 0)"}]}
- Plano / geometría con coordenadas: {"tipo":"plano","titulo":"...","puntos":[{"nombre":"A","x":0,"y":0,"etiqueta":"A(0, 0)"}],"poligonos":[["A","B","C"]],"segmentos":[{"desde":"A","hasta":"B","etiqueta":"4 cm"}]}
  (para figuras sin coordenadas dadas, elige coordenadas coherentes con las medidas del enunciado)
- Círculo: {"tipo":"circulo","radio":3,"centro":[0,0],"etiqueta":"r = 3 cm"}
- Barras / tablas: {"tipo":"barras","titulo":"...","categorias":["Ene","Feb"],"valores":[12,18]}
En "expr" usa solo números, x, + - * / ^ ( ), sqrt(), abs(), sin(), cos(), tan(), ln(), log(), pi. Respeta ejes, escalas, unidades, puntos e intersecciones del enunciado.`;

function construirPromptTarea(instruccionUsuario, { solicitaGraficos = false } = {}) {
  const instruccion = String(instruccionUsuario || '').trim() || 'Resuelve todos los ejercicios de la imagen.';
  return `Eres un tutor experto. La imagen adjunta contiene una tarea, ejercicios o preguntas. Trabaja SOLO con lo que se ve en la imagen.

INSTRUCCIÓN DE LA PERSONA: "${instruccion}"

REGLAS:
1. Identifica y numera los ejercicios conservando la numeración original de la imagen. Si la persona pide solo algunos (p. ej. "solo el ejercicio 5"), resuelve únicamente esos.
2. Lee el enunciado con exactitud. NO inventes números, datos ni símbolos que no se vean con claridad. Si algo es ilegible o dudoso, pon "lectura_dudosa": true y explícalo en "advertencias" en lugar de adivinar.
3. Si faltan datos para resolver, no inventes: describe qué falta en "datos_faltantes" y deja "respuesta" vacía.
4. Si la foto está borrosa, cortada, muy oscura o no contiene ejercicios, devuelve "legible": false con "motivo_ilegible" explicando qué foto necesitas.
5. Muestra las operaciones intermedias en "pasos" (cada paso una línea corta) y una "respuesta" final clara con unidades.
6. Escribe en español, salvo que la persona pida otro idioma.
7. Notación matemática en texto plano: potencias con ^ (x^2), raíces con sqrt(), fracciones como a/b, multiplicación con *, sin LaTeX ni símbolos $ ni \\( \\).
8. En "verificaciones" incluye, cuando se pueda, las cuentas numéricas clave para que el programa las compruebe (solo aritmética con números: + - * / ^ ( ) sqrt(); para ecuaciones, la ecuación y el valor hallado de la variable). Si no hay cuentas comprobables, usa una lista vacía.
9. ${solicitaGraficos ? 'La persona pidió gráficos: incluye "grafico" en cada ejercicio donde tenga sentido (funciones, geometría, estadística).' : 'Incluye "grafico" solo cuando el ejercicio lo pida o ayude claramente a entenderlo.'}

${GUIA_GRAFICOS}

FORMATO DE SALIDA: responde ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después, sin bloques de código) con esta estructura:
${ESQUEMA_RESPUESTA}`;
}

// ── Interpretación de la respuesta ──────────────────────────────────────────
function extraerJSON(texto) {
  if (!texto || typeof texto !== 'string') return null;
  let t = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const intentos = [t];
  const ini = t.indexOf('{'), fin = t.lastIndexOf('}');
  if (ini !== -1 && fin > ini) intentos.push(t.slice(ini, fin + 1));
  for (const candidato of intentos) { try { const obj = JSON.parse(candidato); if (obj && typeof obj === 'object') return obj; } catch { /* siguiente */ } }
  return null;
}

const MAX_EJERCICIOS = 40, MAX_PASOS = 30, MAX_TEXTO = 1200;
function texto(v, max = MAX_TEXTO) { return (v == null ? '' : String(v)).replace(/\u0000/g, '').trim().slice(0, max); }

function normalizarResultado(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const legible = obj.legible !== false;
  const ejercicios = (Array.isArray(obj.ejercicios) ? obj.ejercicios : []).slice(0, MAX_EJERCICIOS).map((e, i) => ({
    numero: texto(e && e.numero != null ? e.numero : i + 1, 12) || String(i + 1),
    enunciado: texto(e && e.enunciado),
    pasos: (Array.isArray(e && e.pasos) ? e.pasos : []).slice(0, MAX_PASOS).map(p => texto(p, 600)).filter(Boolean),
    respuesta: texto(e && e.respuesta, 600),
    verificaciones: Array.isArray(e && e.verificaciones) ? e.verificaciones.slice(0, 12) : [],
    grafico: e && e.grafico && typeof e.grafico === 'object' ? e.grafico : null,
    datosFaltantes: texto(e && e.datos_faltantes, 400),
    lecturaDudosa: !!(e && e.lectura_dudosa)
  })).filter(e => e.enunciado || e.pasos.length || e.respuesta || e.datosFaltantes);
  return {
    legible,
    motivoIlegible: texto(obj.motivo_ilegible, 400),
    titulo: texto(obj.titulo, 120) || 'Tarea resuelta',
    ejercicios,
    advertencias: (Array.isArray(obj.advertencias) ? obj.advertencias : []).slice(0, 12).map(a => texto(a, 400)).filter(Boolean)
  };
}

// Comprueba por código las verificaciones. Marca cada ejercicio: 'ok' | 'revisar' | 'sin'.
function verificarEjercicios(resultado) {
  let comprobadas = 0, discrepancias = 0;
  for (const e of resultado.ejercicios) {
    let ok = 0, mal = 0;
    for (const v of e.verificaciones) {
      const r = verificarItem(v);
      if (r.ok === true) ok++;
      else if (r.ok === false) mal++;
    }
    comprobadas += ok + mal; discrepancias += mal;
    e.verificacion = mal > 0 ? 'revisar' : (ok > 0 ? 'ok' : 'sin');
    e.verificacionesOk = ok; e.verificacionesMal = mal;
  }
  return { comprobadas, discrepancias };
}

// Datos para lib/hoja.js
function datosParaHoja(resultado, { pie, subtitulo } = {}) {
  const advertencias = [...resultado.advertencias];
  for (const e of resultado.ejercicios) {
    if (e.datosFaltantes) advertencias.push(`Ejercicio ${e.numero}: faltan datos (${e.datosFaltantes}).`);
    if (e.lecturaDudosa) advertencias.push(`Ejercicio ${e.numero}: parte del enunciado no se leía con claridad; confirma los datos.`);
  }
  return {
    titulo: resultado.titulo,
    subtitulo,
    pie,
    ejercicios: resultado.ejercicios.map(e => ({
      numero: e.numero, enunciado: e.enunciado, pasos: e.pasos,
      respuesta: e.respuesta || (e.datosFaltantes ? 'No se puede resolver con los datos de la foto' : ''),
      verificacion: e.verificacion, grafico: e.grafico
    })),
    advertencias
  };
}

// ── Texto para WhatsApp ─────────────────────────────────────────────────────
function formatearSolucionTexto(resultado, limite = 3200) {
  const bloques = [];
  bloques.push(`📚 *${embellecerMatematica(resultado.titulo)}*`);
  for (const e of resultado.ejercicios) {
    const lineas = [`*Ejercicio ${e.numero}*`];
    if (e.enunciado) lineas.push(`_${embellecerMatematica(e.enunciado)}_`);
    e.pasos.forEach((p, i) => lineas.push(`${i + 1}. ${embellecerMatematica(p)}`));
    if (e.respuesta) lineas.push(`✅ *Respuesta:* ${embellecerMatematica(e.respuesta)}`);
    if (e.datosFaltantes) lineas.push(`❓ Faltan datos: ${e.datosFaltantes}`);
    if (e.lecturaDudosa) lineas.push('⚠️ Parte del enunciado no se leía bien; confirma los datos.');
    if (e.verificacion === 'revisar') lineas.push('⚠️ La comprobación automática no coincidió: revisa este resultado.');
    else if (e.verificacion === 'ok') lineas.push('🧮 Cálculo comprobado por código.');
    bloques.push(lineas.join('\n'));
  }
  if (resultado.advertencias.length) bloques.push('⚠️ *Avisos:*\n' + resultado.advertencias.map(a => `• ${a}`).join('\n'));

  const mensajes = [];
  let actual = '';
  for (const b of bloques) {
    const bloque = b.length > limite ? b.slice(0, limite - 1) + '…' : b;
    if (actual && (actual.length + bloque.length + 2) > limite) { mensajes.push(actual); actual = bloque; }
    else actual = actual ? `${actual}\n\n${bloque}` : bloque;
  }
  if (actual) mensajes.push(actual);
  return mensajes;
}

module.exports = {
  detectarIntencionImagen, refiereAImagenReciente, construirPromptTarea, extraerJSON, normalizarResultado,
  verificarEjercicios, datosParaHoja, formatearSolucionTexto
};
