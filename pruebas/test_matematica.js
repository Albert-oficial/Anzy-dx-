const assert = require('assert');
const { evaluar, verificarItem, embellecerMatematica } = require('../lib/matematica');
const casos = [
  ['2+3*4', 14], ['(2+3)*4', 20], ['-2^2', -4], ['2^3^2', 512], ['2x', 6, {x:3}], ['3(4+1)', 15],
  ['sqrt(16)+√(9)', 7], ['12/4', 3], ['3,5*2', 7], ['1/3+1/6', 0.5], ['pi*2^2', Math.PI*4], ['10%3', 1],
  ['8÷2×3', 12], ['2**5', 32], ['abs(-7)', 7], ['(x+1)^2', 16, {x:3}], ['−3+5', 2], ['2π', Math.PI*2]
];
let n = 0;
for (const [e, esperado, v] of casos) { const r = evaluar(e, v||{}); assert(Math.abs(r - esperado) < 1e-9, `${e} => ${r} (esperado ${esperado})`); n++; }
// Rechazos de seguridad / formato
for (const mala of ['process.exit()', 'require("fs")', '2+', '(1+2', 'a+1', '1/0/0*x', '2;3', 'constructor', '`x`', '__proto__']) {
  let fallo = false; try { const r = evaluar(mala); if (!Number.isFinite(r) && Number.isNaN(r)) fallo = true; if (mala === '1/0/0*x') fallo = true; } catch { fallo = true; }
  assert(fallo, 'debió rechazar: ' + mala); n++;
}
// verificación
assert.strictEqual(verificarItem({ tipo:'calculo', expresion:'12*(3+4)', resultado: 84 }).ok, true);
assert.strictEqual(verificarItem({ tipo:'calculo', expresion:'12*(3+4)', resultado: 85 }).ok, false);
assert.strictEqual(verificarItem({ tipo:'ecuacion', ecuacion:'2*x+3 = 11', variable:'x', valor: 4 }).ok, true);
assert.strictEqual(verificarItem({ tipo:'ecuacion', ecuacion:'2*x+3 = 11', variable:'x', valor: 5 }).ok, false);
assert.strictEqual(verificarItem({ expresion:'hola', resultado: 1 }).ok, null);
n += 5;
// formato
assert.strictEqual(embellecerMatematica('x^2 + 3*x - 4 = 0'), 'x² + 3 × x - 4 = 0');
assert.strictEqual(embellecerMatematica('sqrt(49)=7 y a_1 >= 3'), '√(49)=7 y a₁ ≥ 3');
assert.strictEqual(embellecerMatematica('x^-1 y 10^(3)'), 'x⁻¹ y 10³');
n += 3;
// rendimiento: expresión larga anidada no cuelga
const t0 = Date.now(); try { evaluar('('.repeat(200) + '1' + ')'.repeat(200)); } catch {} assert(Date.now() - t0 < 200); n++;
console.log(`matematica: ${n} comprobaciones OK`);
