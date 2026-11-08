const assert = require('assert');
const T = require('../lib/tarea');
const casos = [
  ['Anzy, resuelve esta tarea', { tarea: true, hoja: false, leer: false }],
  ['Resuelve todos los ejercicios y explícame el procedimiento', { tarea: true, hoja: false, leer: false }],
  ['Lee esta imagen y dime qué tengo que hacer', { tarea: false, hoja: false, leer: true }],
  ['Resuélvelo todo, con sus gráficos, y pásamelo en foto', { tarea: true, hoja: true, leer: false }],
  ['Quiero una imagen con las preguntas y sus respectivas respuestas', { tarea: true, hoja: true, leer: false }],
  ['Resuelve solamente el ejercicio 5', { tarea: true, hoja: false, leer: false }],
  ['Haz los gráficos de los ejercicios de geometría', { tarea: true, hoja: false, leer: false }],
  ['Resuelve la tarea completa y pásamela en una fotografía', { tarea: true, hoja: true, leer: false }],
  ['qué opinas de esta foto', { tarea: false, hoja: false, leer: false }],
];
for (const [t, esperado] of casos) assert.deepStrictEqual(T.detectarIntencionImagen(t), esperado, t);
assert(T.refiereAImagenReciente('resuelve la tarea de la foto'));
assert(T.refiereAImagenReciente('lee esto por favor'));
assert(!T.refiereAImagenReciente('cuéntame un chiste'));
assert(!T.refiereAImagenReciente('cuánto es 2+2'));
// JSON
const crudo = '```json\n{"legible":true,"titulo":"T","ejercicios":[{"numero":1,"enunciado":"2+3","pasos":["2+3=5"],"respuesta":"5","verificaciones":[{"tipo":"calculo","expresion":"2+3","resultado":5}]},{"numero":"2","enunciado":"7*6","pasos":["7*6=42"],"respuesta":"43","verificaciones":[{"tipo":"calculo","expresion":"7*6","resultado":43}]}]}\n```';
const obj = T.normalizarResultado(T.extraerJSON(crudo));
const v = T.verificarEjercicios(obj);
assert.strictEqual(obj.ejercicios.length, 2); assert.strictEqual(obj.ejercicios[0].verificacion, 'ok'); assert.strictEqual(obj.ejercicios[1].verificacion, 'revisar');
assert.deepStrictEqual(v, { comprobadas: 2, discrepancias: 1 });
assert.strictEqual(T.extraerJSON('hola, no es json'), null);
assert.deepStrictEqual(T.extraerJSON('texto antes {"a":1} texto después'), { a: 1 });
const msgs = T.formatearSolucionTexto(obj);
assert(msgs.length >= 1 && msgs.join('').includes('Ejercicio 2'));
// mensajes largos se parten
const grande = T.normalizarResultado({ legible: true, titulo: 'G', ejercicios: Array.from({ length: 40 }, (_, i) => ({ numero: i + 1, enunciado: 'x'.repeat(500), pasos: ['y'.repeat(300), 'z'.repeat(300)], respuesta: 'r' })) });
const partes = T.formatearSolucionTexto(grande);
assert(partes.length > 1 && partes.every(p => p.length <= 3300), 'partes ' + partes.map(p => p.length));
console.log('tarea: OK (intenciones, JSON, verificación, troceado en', partes.length, 'mensajes)');
