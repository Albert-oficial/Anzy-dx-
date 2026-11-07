'use strict';
// Evaluador aritmético SEGURO (sin eval / Function). Se usa para:
//  - comprobar por código los cálculos que propone la IA (verificaciones),
//  - evaluar f(x) al dibujar gráficas.
// Soporta: + - * / ^ ** %, paréntesis, × ÷ · , decimales con punto o coma, multiplicación implícita
// (2x, 3(4+1), (a)(b)), constantes pi/π/e, variables (x, y, t...), y funciones comunes.

const MAX_LARGO_EXPRESION = 300;
const MAX_PROFUNDIDAD = 40;

const FUNCIONES = {
  sqrt: Math.sqrt, raiz: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sen: Math.sin,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2, exp: Math.exp,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign
};
const CONSTANTES = { pi: Math.PI, 'π': Math.PI, e: Math.E };

function normalizarEntrada(texto) {
  return String(texto)
    .replace(/[\u2212\u2013\u2014]/g, '-')
    .replace(/[×·∙⋅]/g, '*')
    .replace(/[÷:]/g, '/')
    .replace(/\*\*/g, '^')
    .replace(/√/g, 'sqrt')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizar(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if ((src[j] === '.' || src[j] === ',') && /[0-9]/.test(src[j + 1] || '')) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ t: 'num', v: parseFloat(src.slice(i, j).replace(',', '.')) });
      i = j; continue;
    }
    if (/[A-Za-zπ_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-zπ_0-9]/.test(src[j])) j++;
      const palabra = src.slice(i, j).toLowerCase();
      // Permite "2x" → num, id; y "xy" se trata como un solo identificador desconocido (error claro).
      tokens.push({ t: 'id', v: palabra });
      i = j; continue;
    }
    if ('+-*/^%(),'.includes(c)) { tokens.push({ t: c }); i++; continue; }
    throw new Error(`Carácter no permitido en la expresión: "${c}"`);
  }
  return tokens;
}

function evaluar(expresion, variables = {}) {
  const src = normalizarEntrada(expresion);
  if (!src) throw new Error('Expresión vacía');
  if (src.length > MAX_LARGO_EXPRESION) throw new Error('Expresión demasiado larga');
  const tokens = tokenizar(src);
  let pos = 0;
  const vars = {};
  for (const [k, v] of Object.entries(variables)) vars[String(k).toLowerCase()] = Number(v);

  const mirar = () => tokens[pos];
  const consumir = (tipo) => { const t = tokens[pos]; if (!t || (tipo && t.t !== tipo)) throw new Error('Expresión mal formada'); pos++; return t; };

  // expr := term (('+'|'-') term)*
  function expr(prof) {
    if (prof > MAX_PROFUNDIDAD) throw new Error('Expresión demasiado anidada');
    let valor = term(prof);
    while (mirar() && (mirar().t === '+' || mirar().t === '-')) {
      const op = consumir().t;
      const der = term(prof);
      valor = op === '+' ? valor + der : valor - der;
    }
    return valor;
  }
  // term := unario (('*'|'/'|'%'|implícito) unario)*
  function term(prof) {
    let valor = unario(prof);
    for (;;) {
      const t = mirar();
      if (!t) break;
      if (t.t === '*') { consumir(); valor *= unario(prof); }
      else if (t.t === '/') { consumir(); valor /= unario(prof); }
      else if (t.t === '%') { consumir(); valor %= unario(prof); }
      else if (t.t === 'num' || t.t === 'id' || t.t === '(') { valor *= potencia(prof); } // implícita
      else break;
    }
    return valor;
  }
  // unario := ('-'|'+') unario | potencia      (−2^2 = −4)
  function unario(prof) {
    const t = mirar();
    if (t && t.t === '-') { consumir(); return -unario(prof); }
    if (t && t.t === '+') { consumir(); return unario(prof); }
    return potencia(prof);
  }
  // potencia := primario ('^' unario)?        (asociativa a la derecha)
  function potencia(prof) {
    const base = primario(prof);
    if (mirar() && mirar().t === '^') { consumir(); return Math.pow(base, unario(prof)); }
    return base;
  }
  function primario(prof) {
    const t = mirar();
    if (!t) throw new Error('Expresión incompleta');
    if (t.t === 'num') { consumir(); return t.v; }
    if (t.t === '(') { consumir(); const v = expr(prof + 1); consumir(')'); return v; }
    if (t.t === 'id') {
      consumir();
      if (Object.prototype.hasOwnProperty.call(FUNCIONES, t.v) && mirar() && mirar().t === '(') {
        consumir('(');
        const arg = expr(prof + 1);
        consumir(')');
        return FUNCIONES[t.v](arg);
      }
      if (Object.prototype.hasOwnProperty.call(vars, t.v)) return vars[t.v];
      if (Object.prototype.hasOwnProperty.call(CONSTANTES, t.v)) return CONSTANTES[t.v];
      throw new Error(`Símbolo desconocido: "${t.v}"`);
    }
    throw new Error('Expresión mal formada');
  }

  const resultado = expr(0);
  if (pos < tokens.length) throw new Error('Sobran símbolos en la expresión');
  if (typeof resultado !== 'number' || Number.isNaN(resultado)) throw new Error('El resultado no es un número');
  return resultado;
}

function sonIguales(a, b, tolerancia = 1e-6) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const escala = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tolerancia * escala;
}

function formatearNumero(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

// Verifica un elemento que propone la IA. Formatos admitidos:
//  { tipo:'calculo',  expresion:'12*(3+4)', resultado: 84 }
//  { tipo:'ecuacion', ecuacion:'2*x+3 = 11', variable:'x', valor: 4 }
function verificarItem(item) {
  try {
    if (!item || typeof item !== 'object') return { ok: null, motivo: 'formato' };
    if (item.tipo === 'ecuacion' || (item.ecuacion && !item.expresion)) {
      const partes = String(item.ecuacion || '').split('=');
      if (partes.length !== 2) return { ok: null, motivo: 'ecuación no soportada' };
      const nombre = String(item.variable || 'x').toLowerCase();
      const valor = Number(item.valor);
      if (!Number.isFinite(valor)) return { ok: null, motivo: 'valor no numérico' };
      const izq = evaluar(partes[0], { [nombre]: valor });
      const der = evaluar(partes[1], { [nombre]: valor });
      return { ok: sonIguales(izq, der), izquierda: izq, derecha: der };
    }
    const calculado = evaluar(item.expresion);
    const esperado = Number(String(item.resultado).replace(',', '.'));
    if (!Number.isFinite(esperado)) return { ok: null, motivo: 'resultado no numérico' };
    return { ok: sonIguales(calculado, esperado), calculado, esperado };
  } catch (err) {
    return { ok: null, motivo: err.message };
  }
}

// ── Formato de texto matemático (Unicode) ───────────────────────────────────
const SUPERINDICES = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', 'n': 'ⁿ', 'i': 'ⁱ' };
const SUBINDICES = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋' };

function embellecerMatematica(texto) {
  let t = String(texto == null ? '' : texto);
  t = t.replace(/\^\s*(?:\(\s*([+-]?[0-9]+|n|i)\s*\)|([+-]?[0-9]+|n|i))(?![0-9A-Za-z(])/g, (m, conParentesis, simple) => {
    const exp = conParentesis || simple;
    return [...exp].map(ch => SUPERINDICES[ch] || ch).join('');
  });
  t = t.replace(/\bsqrt\s*\(/gi, '√(').replace(/\braíz\s*\(/gi, '√(').replace(/\braiz\s*\(/gi, '√(');
  t = t.replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/!=/g, '≠').replace(/->/g, '→').replace(/=>/g, '⇒');
  t = t.replace(/\+\/-/g, '±');
  t = t.replace(/(?<=[0-9A-Za-z)\]}])\s*\*\s*(?=[0-9A-Za-z(\[{√π-])/g, ' × ');
  t = t.replace(/\bpi\b/gi, 'π');
  t = t.replace(/\b([A-Za-z])_([0-9]+)\b/g, (m, v, n) => v + [...n].map(ch => SUBINDICES[ch] || ch).join(''));
  return t;
}

module.exports = { evaluar, verificarItem, sonIguales, formatearNumero, embellecerMatematica, normalizarEntrada };
