'use strict';
// Compone "hojas" de tarea resuelta como SVG (texto convertido a vectores, sin depender de
// fuentes del servidor) y las convierte a PNG con sharp. Todo ocurre en memoria: no crea archivos
// temporales, así que no hay nada que limpiar ni fugas de disco.
//
// Entrada esperada (la produce lib/tarea.js):
// { titulo, subtitulo, ejercicios:[{ numero, enunciado, pasos:[], respuesta, verificacion:'ok'|'revisar'|'sin',
//   grafico? }], advertencias:[], pie }

const FUENTE = require('./fuente_vectorial');
const { evaluar, formatearNumero, embellecerMatematica } = require('./matematica');

const PAGINA = { w: 1240, h: 1754, margen: 90, pie: 70 };
const COLOR = { tinta: '#1d1d1f', gris: '#5b5b66', titulo: '#b3124f', linea: '#e3c5d3', ok: '#2e7d32', okFondo: '#e8f5e9', aviso: '#b45f06', avisoFondo: '#fff4e0', ejes: '#333333', rejilla: '#e6e6ee' };
const MAX_PAGINAS_DEFECTO = 15;

// ── Texto vectorial ─────────────────────────────────────────────────────────
function limpiarTexto(t) {
  return String(t == null ? '' : t)
    .replace(/\r/g, '')
    .replace(/\t/g, '    ')
    .replace(/[\u200B-\u200F\uFE00-\uFE0F\u2060\uFEFF]/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, (c) => (c === '\u2714' || c === '\u2713' || c === '\u2718' || c === '\u2717' || c === '\u26A0') ? c : '');
}

function glifo(negrita, ch) {
  const tabla = (negrita ? FUENTE.b : FUENTE.r);
  return tabla.g[ch] || tabla.g['?'];
}
function anchoTexto(texto, tam, negrita) {
  const tabla = negrita ? FUENTE.b : FUENTE.r;
  let u = 0;
  for (const ch of texto) u += (tabla.g[ch] || tabla.g['?']).w;
  return u * tam / tabla.upm;
}
function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Contexto de página: acumula los glifos usados para declararlos una sola vez en <defs>.
function nuevoContexto() { return { usados: new Set() }; }

function textoSVG(ctx, texto, x, yBase, tam, { negrita = false, color = COLOR.tinta, anchor = 'start' } = {}) {
  const tabla = negrita ? FUENTE.b : FUENTE.r;
  const k = tam / tabla.upm;
  const pref = negrita ? 'b' : 'r';
  let cursor = 0;
  const usos = [];
  for (const ch of texto) {
    const g = tabla.g[ch] || tabla.g['?'];
    const clave = tabla.g[ch] ? ch : '?';
    if (g.d) {
      const id = `${pref}${clave.codePointAt(0).toString(16)}`;
      ctx.usados.add(`${negrita ? 'b' : 'r'}|${clave}`);
      usos.push(`<use xlink:href="#${id}" x="${cursor}"/>`);
    }
    cursor += g.w;
  }
  if (!usos.length) return '';
  let x0 = x;
  if (anchor === 'middle') x0 = x - (cursor * k) / 2;
  else if (anchor === 'end') x0 = x - cursor * k;
  return `<g transform="translate(${x0.toFixed(1)} ${yBase.toFixed(1)}) scale(${k.toFixed(5)} ${(-k).toFixed(5)})" fill="${color}">${usos.join('')}</g>`;
}

function defsGlifos(ctx) {
  const partes = [];
  for (const clave of ctx.usados) {
    const [pref, ch] = [clave[0], clave.slice(2)];
    const tabla = pref === 'b' ? FUENTE.b : FUENTE.r;
    const g = tabla.g[ch];
    if (g && g.d) partes.push(`<path id="${pref}${ch.codePointAt(0).toString(16)}" d="${g.d}"/>`);
  }
  return `<defs>${partes.join('')}</defs>`;
}

function envolverLinea(texto, tam, negrita, anchoMax) {
  const lineas = [];
  const parrafos = limpiarTexto(texto).split('\n');
  for (const parrafo of parrafos) {
    const palabras = parrafo.split(/ +/).filter((p, i, a) => p.length || a.length === 1);
    let actual = '';
    const empujar = () => { lineas.push(actual); actual = ''; };
    for (let palabra of palabras) {
      // Partir palabras más anchas que la línea (URLs, cadenas largas)
      while (anchoTexto(palabra, tam, negrita) > anchoMax) {
        if (actual) empujar();
        let corte = palabra.length;
        while (corte > 1 && anchoTexto(palabra.slice(0, corte), tam, negrita) > anchoMax) corte--;
        lineas.push(palabra.slice(0, corte));
        palabra = palabra.slice(corte);
      }
      const candidata = actual ? `${actual} ${palabra}` : palabra;
      if (anchoTexto(candidata, tam, negrita) <= anchoMax) actual = candidata;
      else { empujar(); actual = palabra; }
    }
    lineas.push(actual);
  }
  return lineas;
}

// ── Átomos de maquetación ───────────────────────────────────────────────────
// Un átomo = { h, dibujar(ctx, x, y) → svg, conSiguiente?: bool }
function atomosTexto(texto, opc) {
  const { tam = 34, negrita = false, color = COLOR.tinta, anchoMax, prefijo = '', sangria = 0, interlineado = 1.42 } = opc;
  const anchoPrefijo = prefijo ? anchoTexto(prefijo, tam, negrita) : 0;
  const lineas = envolverLinea(texto, tam, negrita, anchoMax - sangria - anchoPrefijo);
  const alto = Math.round(tam * interlineado);
  return lineas.map((linea, i) => ({
    h: alto,
    dibujar: (ctx, x, y) => {
      let s = '';
      const yBase = y + tam * 1.02;
      if (i === 0 && prefijo) s += textoSVG(ctx, prefijo, x + sangria, yBase, tam, { negrita, color });
      s += textoSVG(ctx, linea, x + sangria + anchoPrefijo, yBase, tam, { negrita, color });
      return s;
    }
  }));
}

function atomoEspacio(h) { return { h, espacio: true, dibujar: () => '' }; }

function atomoEncabezadoEjercicio(numero, anchoMax) {
  const h = 62;
  return {
    h, conSiguiente: true,
    dibujar: (ctx, x, y) => {
      const etiqueta = `Ejercicio ${numero}`;
      const w = anchoTexto(etiqueta, 34, true) + 44;
      return `<rect x="${x}" y="${y}" width="${w.toFixed(1)}" height="${h - 10}" rx="14" fill="${COLOR.titulo}"/>` +
        textoSVG(ctx, etiqueta, x + 22, y + 38, 34, { negrita: true, color: '#ffffff' }) +
        `<line x1="${(x + w + 16).toFixed(1)}" y1="${y + 26}" x2="${x + anchoMax}" y2="${y + 26}" stroke="${COLOR.linea}" stroke-width="3"/>`;
    }
  };
}

function atomosCaja(lineasAtomos, { fondo, borde, padding = 20 }) {
  // Caja con fondo: se maqueta como un único átomo para que no se parta entre páginas.
  const hContenido = lineasAtomos.reduce((a, b) => a + b.h, 0);
  const h = hContenido + padding * 2;
  return [{
    h,
    dibujar: (ctx, x, y, ancho) => {
      let s = `<rect x="${x}" y="${y}" width="${ancho}" height="${h}" rx="14" fill="${fondo}" stroke="${borde}" stroke-width="3"/>`;
      let cy = y + padding;
      for (const a of lineasAtomos) { s += a.dibujar(ctx, x + padding, cy); cy += a.h; }
      return s;
    }
  }];
}

// ── Gráficos ────────────────────────────────────────────────────────────────
function ticksBonitos(min, max, objetivo = 8) {
  const rango = max - min;
  if (!(rango > 0)) return [min];
  const crudo = rango / objetivo;
  const pot = Math.pow(10, Math.floor(Math.log10(crudo)));
  const f = crudo / pot;
  const paso = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pot;
  const ticks = [];
  for (let v = Math.ceil(min / paso - 1e-9) * paso; v <= max + 1e-9; v += paso) ticks.push(Math.abs(v) < paso * 1e-9 ? 0 : Number(v.toFixed(10)));
  return ticks;
}

const PALETA = ['#b3124f', '#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a', '#00838f'];

function numeroValido(v) { return typeof v === 'number' && Number.isFinite(v); }

// Marco de coordenadas común. Devuelve helpers de transformación.
function crearMarco(ancho, alto, xmin, xmax, ymin, ymax, { equilibrar = false } = {}) {
  const margen = { i: 70, d: 30, s: 30, b: 60 };
  let aw = ancho - margen.i - margen.d, ah = alto - margen.s - margen.b;
  if (equilibrar) {
    const escala = Math.min(aw / (xmax - xmin), ah / (ymax - ymin));
    const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
    xmin = cx - aw / escala / 2; xmax = cx + aw / escala / 2;
    ymin = cy - ah / escala / 2; ymax = cy + ah / escala / 2;
  }
  const X = (x) => margen.i + ((x - xmin) / (xmax - xmin)) * aw;
  const Y = (y) => margen.s + (1 - (y - ymin) / (ymax - ymin)) * ah;
  return { X, Y, xmin, xmax, ymin, ymax, margen, aw, ah };
}

function dibujarEjes(ctx, m, { unidadX = '', unidadY = '' } = {}) {
  let s = '';
  const tx = ticksBonitos(m.xmin, m.xmax, Math.max(4, Math.round(m.aw / 75))), ty = ticksBonitos(m.ymin, m.ymax, Math.max(3, Math.round(m.ah / 65)));
  for (const v of tx) s += `<line x1="${m.X(v).toFixed(1)}" y1="${m.Y(m.ymin).toFixed(1)}" x2="${m.X(v).toFixed(1)}" y2="${m.Y(m.ymax).toFixed(1)}" stroke="${COLOR.rejilla}" stroke-width="1.5"/>`;
  for (const v of ty) s += `<line x1="${m.X(m.xmin).toFixed(1)}" y1="${m.Y(v).toFixed(1)}" x2="${m.X(m.xmax).toFixed(1)}" y2="${m.Y(v).toFixed(1)}" stroke="${COLOR.rejilla}" stroke-width="1.5"/>`;
  const ejeY = (m.xmin <= 0 && m.xmax >= 0) ? m.X(0) : m.X(m.xmin);
  const ejeX = (m.ymin <= 0 && m.ymax >= 0) ? m.Y(0) : m.Y(m.ymin);
  s += `<line x1="${m.X(m.xmin).toFixed(1)}" y1="${ejeX.toFixed(1)}" x2="${m.X(m.xmax).toFixed(1)}" y2="${ejeX.toFixed(1)}" stroke="${COLOR.ejes}" stroke-width="2.5"/>`;
  s += `<line x1="${ejeY.toFixed(1)}" y1="${m.Y(m.ymin).toFixed(1)}" x2="${ejeY.toFixed(1)}" y2="${m.Y(m.ymax).toFixed(1)}" stroke="${COLOR.ejes}" stroke-width="2.5"/>`;
  for (const v of tx) {
    if (v === 0 && m.xmin < 0 && m.xmax > 0) continue;
    s += `<line x1="${m.X(v).toFixed(1)}" y1="${(ejeX - 5).toFixed(1)}" x2="${m.X(v).toFixed(1)}" y2="${(ejeX + 5).toFixed(1)}" stroke="${COLOR.ejes}" stroke-width="2"/>`;
    s += textoSVG(ctx, formatearNumero(v) + unidadX, m.X(v), Math.min(ejeX + 28, m.Y(m.ymin) + 26), 20, { anchor: 'middle', color: COLOR.gris });
  }
  for (const v of ty) {
    if (v === 0 && m.ymin < 0 && m.ymax > 0) continue;
    s += `<line x1="${(ejeY - 5).toFixed(1)}" y1="${m.Y(v).toFixed(1)}" x2="${(ejeY + 5).toFixed(1)}" y2="${m.Y(v).toFixed(1)}" stroke="${COLOR.ejes}" stroke-width="2"/>`;
    s += textoSVG(ctx, formatearNumero(v) + unidadY, Math.max(ejeY - 10, m.margen.i - 6), m.Y(v) + 7, 20, { anchor: 'end', color: COLOR.gris });
  }
  s += textoSVG(ctx, 'x', m.X(m.xmax) - 4, ejeX - 10, 22, { negrita: true, color: COLOR.ejes, anchor: 'end' });
  s += textoSVG(ctx, 'y', ejeY + 12, m.Y(m.ymax) + 20, 22, { negrita: true, color: COLOR.ejes });
  return s;
}

function limitar(v, a, b) { return Math.min(Math.max(v, a), b); }

function graficoFuncion(spec, ancho, alto) {
  const funciones = (Array.isArray(spec.funciones) ? spec.funciones : [spec.funcion ? { expr: spec.funcion } : null]).filter(f => f && f.expr).slice(0, 5);
  if (!funciones.length) throw new Error('gráfico de función sin expresión');
  let xmin = numeroValido(spec.xmin) ? spec.xmin : -10, xmax = numeroValido(spec.xmax) ? spec.xmax : 10;
  if (!(xmax > xmin)) { xmin = -10; xmax = 10; }
  const N = 500;
  const series = funciones.map(f => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = xmin + (xmax - xmin) * i / N;
      let y = NaN; try { y = evaluar(f.expr, { x }); } catch { y = NaN; }
      pts.push([x, Number.isFinite(y) ? y : NaN]);
    }
    return pts;
  });
  let ymin = spec.ymin, ymax = spec.ymax;
  if (!numeroValido(ymin) || !numeroValido(ymax) || !(ymax > ymin)) {
    const ys = series.flat().map(p => p[1]).filter(Number.isFinite).sort((a, b) => a - b);
    if (!ys.length) throw new Error('la función no produjo valores graficables');
    const lo = ys[Math.floor(ys.length * 0.02)], hi = ys[Math.ceil(ys.length * 0.98) - 1];
    const pad = (hi - lo || 2) * 0.12;
    ymin = lo - pad; ymax = hi + pad;
    for (const p of (spec.puntos || [])) if (numeroValido(p.y)) { ymin = Math.min(ymin, p.y - pad / 2); ymax = Math.max(ymax, p.y + pad / 2); }
  }
  const m = crearMarco(ancho, alto, xmin, xmax, ymin, ymax);
  return { marco: m, dibujar: (ctx) => {
    let s = dibujarEjes(ctx, m, spec);
    series.forEach((pts, idx) => {
      const color = PALETA[idx % PALETA.length];
      let tramo = [];
      const cerrar = () => { if (tramo.length > 1) s += `<polyline fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" points="${tramo.join(' ')}"/>`; tramo = []; };
      let prev = null;
      for (const [x, y] of pts) {
        if (!Number.isFinite(y)) { cerrar(); prev = null; continue; }
        if (prev !== null && Math.abs(y - prev) > (m.ymax - m.ymin) * 2) cerrar(); // asíntotas
        tramo.push(`${m.X(x).toFixed(1)},${m.Y(limitar(y, m.ymin - (m.ymax - m.ymin), m.ymax + (m.ymax - m.ymin))).toFixed(1)}`);
        prev = y;
      }
      cerrar();
      const etiqueta = funciones[idx].etiqueta || ('y = ' + funciones[idx].expr);
      s += textoSVG(ctx, embellecerMatematica(etiqueta), m.margen.i + 14, m.margen.s + 26 + idx * 26, 22, { negrita: true, color });
    });
    for (const p of (spec.puntos || [])) {
      if (!numeroValido(p.x) || !numeroValido(p.y)) continue;
      s += `<circle cx="${m.X(p.x).toFixed(1)}" cy="${m.Y(p.y).toFixed(1)}" r="7" fill="#ffffff" stroke="${COLOR.titulo}" stroke-width="4"/>`;
      if (p.etiqueta) s += textoSVG(ctx, embellecerMatematica(String(p.etiqueta)), m.X(p.x) + 12, m.Y(p.y) - 12, 20, { negrita: true, color: COLOR.titulo });
    }
    return s;
  } };
}

function graficoPlano(spec, ancho, alto) {
  const puntos = (spec.puntos || []).filter(p => numeroValido(p.x) && numeroValido(p.y)).slice(0, 40);
  if (!puntos.length) throw new Error('gráfico de plano sin puntos válidos');
  const porNombre = new Map(puntos.map((p, i) => [String(p.nombre || p.etiqueta || i), p]));
  const buscar = (ref) => (typeof ref === 'number' ? puntos[ref] : porNombre.get(String(ref)));
  const xs = puntos.map(p => p.x), ys = puntos.map(p => p.y);
  let xmin = Math.min(...xs, 0), xmax = Math.max(...xs, 0), ymin = Math.min(...ys, 0), ymax = Math.max(...ys, 0);
  const padX = (xmax - xmin || 2) * 0.18, padY = (ymax - ymin || 2) * 0.18;
  xmin -= padX; xmax += padX; ymin -= padY; ymax += padY;
  const m = crearMarco(ancho, alto, xmin, xmax, ymin, ymax, { equilibrar: spec.equilibrar !== false });
  return { marco: m, dibujar: (ctx) => {
    let s = dibujarEjes(ctx, m, spec);
    (spec.poligonos || []).slice(0, 6).forEach((poli, idx) => {
      const pts = (Array.isArray(poli) ? poli : []).map(buscar).filter(Boolean);
      if (pts.length >= 3) s += `<polygon points="${pts.map(p => `${m.X(p.x).toFixed(1)},${m.Y(p.y).toFixed(1)}`).join(' ')}" fill="${PALETA[idx % PALETA.length]}22" stroke="${PALETA[idx % PALETA.length]}" stroke-width="4" stroke-linejoin="round"/>`;
    });
    for (const seg of (spec.segmentos || []).slice(0, 40)) {
      const a = buscar(Array.isArray(seg) ? seg[0] : seg.desde), b = buscar(Array.isArray(seg) ? seg[1] : seg.hasta);
      if (!a || !b) continue;
      s += `<line x1="${m.X(a.x).toFixed(1)}" y1="${m.Y(a.y).toFixed(1)}" x2="${m.X(b.x).toFixed(1)}" y2="${m.Y(b.y).toFixed(1)}" stroke="#1565c0" stroke-width="4"/>`;
      const etq = Array.isArray(seg) ? seg[2] : seg.etiqueta;
      if (etq) s += textoSVG(ctx, embellecerMatematica(String(etq)), (m.X(a.x) + m.X(b.x)) / 2 + 8, (m.Y(a.y) + m.Y(b.y)) / 2 - 8, 21, { negrita: true, color: '#1565c0' });
    }
    for (const f of (spec.funciones || []).slice(0, 3)) {
      if (!f || !f.expr) continue;
      const pts = [];
      for (let i = 0; i <= 300; i++) { const x = m.xmin + (m.xmax - m.xmin) * i / 300; try { const y = evaluar(f.expr, { x }); if (Number.isFinite(y)) pts.push(`${m.X(x).toFixed(1)},${m.Y(limitar(y, m.ymin - 5, m.ymax + 5)).toFixed(1)}`); } catch { /* se omite */ } }
      if (pts.length > 1) s += `<polyline fill="none" stroke="#6a1b9a" stroke-width="4" points="${pts.join(' ')}"/>`;
    }
    for (const p of puntos) {
      s += `<circle cx="${m.X(p.x).toFixed(1)}" cy="${m.Y(p.y).toFixed(1)}" r="7" fill="${COLOR.titulo}"/>`;
      const nombre = p.etiqueta || p.nombre;
      if (nombre) s += textoSVG(ctx, embellecerMatematica(String(nombre)), m.X(p.x) + 12, m.Y(p.y) - 12, 22, { negrita: true, color: COLOR.tinta });
    }
    return s;
  } };
}

function graficoCirculo(spec, ancho, alto) {
  const r = Number(spec.radio);
  if (!(r > 0)) throw new Error('círculo sin radio válido');
  const [cx, cy] = Array.isArray(spec.centro) ? spec.centro.map(Number) : [0, 0];
  const m = crearMarco(ancho, alto, cx - r * 1.5, cx + r * 1.5, cy - r * 1.5, cy + r * 1.5, { equilibrar: true });
  return { marco: m, dibujar: (ctx) => {
    let s = dibujarEjes(ctx, m, spec);
    const rpx = Math.abs(m.X(cx + r) - m.X(cx));
    s += `<circle cx="${m.X(cx).toFixed(1)}" cy="${m.Y(cy).toFixed(1)}" r="${rpx.toFixed(1)}" fill="${COLOR.titulo}18" stroke="${COLOR.titulo}" stroke-width="4"/>`;
    s += `<circle cx="${m.X(cx).toFixed(1)}" cy="${m.Y(cy).toFixed(1)}" r="6" fill="${COLOR.titulo}"/>`;
    if (spec.mostrarRadio !== false) {
      s += `<line x1="${m.X(cx).toFixed(1)}" y1="${m.Y(cy).toFixed(1)}" x2="${(m.X(cx) + rpx).toFixed(1)}" y2="${m.Y(cy).toFixed(1)}" stroke="#1565c0" stroke-width="4"/>`;
      s += textoSVG(ctx, embellecerMatematica(spec.etiqueta || `r = ${formatearNumero(r)}`), m.X(cx) + rpx / 2, m.Y(cy) - 12, 22, { negrita: true, color: '#1565c0', anchor: 'middle' });
    }
    return s;
  } };
}

function graficoBarras(spec, ancho, alto) {
  const cats = (spec.categorias || []).map(String).slice(0, 14);
  const vals = (spec.valores || []).map(Number).slice(0, cats.length);
  if (!cats.length || vals.length !== cats.length || vals.some(v => !Number.isFinite(v))) throw new Error('gráfico de barras con datos inválidos');
  const vmax = Math.max(...vals, 0) || 1, vmin = Math.min(...vals, 0);
  const m = crearMarco(ancho, alto, 0, cats.length, vmin < 0 ? vmin * 1.15 : 0, vmax * 1.15);
  return { marco: m, dibujar: (ctx) => {
    let s = '';
    for (const v of ticksBonitos(m.ymin, m.ymax, 6)) {
      s += `<line x1="${m.X(0).toFixed(1)}" y1="${m.Y(v).toFixed(1)}" x2="${m.X(cats.length).toFixed(1)}" y2="${m.Y(v).toFixed(1)}" stroke="${COLOR.rejilla}" stroke-width="1.5"/>`;
      s += textoSVG(ctx, formatearNumero(v), m.margen.i - 10, m.Y(v) + 7, 20, { anchor: 'end', color: COLOR.gris });
    }
    s += `<line x1="${m.X(0).toFixed(1)}" y1="${m.Y(0).toFixed(1)}" x2="${m.X(cats.length).toFixed(1)}" y2="${m.Y(0).toFixed(1)}" stroke="${COLOR.ejes}" stroke-width="2.5"/>`;
    cats.forEach((c, i) => {
      const x0 = m.X(i + 0.18), x1 = m.X(i + 0.82), y0 = m.Y(0), y1 = m.Y(vals[i]);
      s += `<rect x="${x0.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${Math.abs(y1 - y0).toFixed(1)}" fill="${PALETA[i % PALETA.length]}" rx="4"/>`;
      s += textoSVG(ctx, formatearNumero(vals[i]), (x0 + x1) / 2, Math.min(y0, y1) - 8, 20, { anchor: 'middle', negrita: true });
      s += textoSVG(ctx, c.length > 12 ? c.slice(0, 11) + '…' : c, (x0 + x1) / 2, m.Y(m.ymin) + 28, 19, { anchor: 'middle', color: COLOR.gris });
    });
    return s;
  } };
}

function atomoGrafico(spec, anchoMax, { ratio = 0.6, maxAncho = 800 } = {}) {
  const ancho = Math.min(anchoMax, maxAncho);
  const alto = Math.round(ancho * ratio);
  let g;
  switch (String(spec.tipo || '').toLowerCase()) {
    case 'funcion': g = graficoFuncion(spec, ancho, alto); break;
    case 'plano': case 'puntos': case 'geometria': g = graficoPlano(spec, ancho, alto); break;
    case 'circulo': g = graficoCirculo(spec, ancho, alto); break;
    case 'barras': g = graficoBarras(spec, ancho, alto); break;
    default: throw new Error(`tipo de gráfico no soportado: ${spec.tipo}`);
  }
  const titulo = spec.titulo ? embellecerMatematica(String(spec.titulo)) : null;
  const hTitulo = titulo ? 40 : 0;
  const h = alto + hTitulo + 16;
  return { h, dibujar: (ctx, x, y, anchoDisp) => {
    const dx = x + Math.max(0, (anchoDisp - ancho) / 2);
    let s = `<rect x="${dx}" y="${y}" width="${ancho}" height="${h - 8}" rx="14" fill="#ffffff" stroke="${COLOR.linea}" stroke-width="3"/>`;
    if (titulo) s += textoSVG(ctx, titulo, dx + ancho / 2, y + 30, 24, { negrita: true, color: COLOR.tinta, anchor: 'middle' });
    s += `<g transform="translate(${dx} ${y + hTitulo})">${g.dibujar(ctx)}</g>`;
    return s;
  } };
}

// ── Maquetación de la hoja (diseño en tarjetas) ─────────────────────────────
const ACENTOS = [
  { c: '#d81b60', claro: '#fde4ee' }, { c: '#1e88e5', claro: '#e3f1fd' }, { c: '#43a047', claro: '#e6f4e7' },
  { c: '#fb8c00', claro: '#fff1de' }, { c: '#8e24aa', claro: '#f3e5f6' }, { c: '#00acc1', claro: '#e0f6f9' }
];

function altoLineas(n, tam, inter = 1.32) { return n * Math.round(tam * inter); }

function atomoAviso(texto, anchoMax) {
  return atomosCaja(atomosTexto(embellecerMatematica(texto), { tam: 26, color: COLOR.aviso, anchoMax: anchoMax - 40, prefijo: '⚠ ', interlineado: 1.3 }), { fondo: COLOR.avisoFondo, borde: COLOR.aviso, padding: 16 });
}

// Tarjeta completa de un ejercicio: pregunta exacta, pasos cortos, gráfico al lado y respuesta destacada.
function atomoTarjetaEjercicio(ej, indice, anchoMax) {
  const ac = ACENTOS[indice % ACENTOS.length];
  const pad = 24, tamPregunta = 28, tamPaso = 28, tamResp = 34, radioBadge = 30;
  const interior = anchoMax - pad * 2;

  // Pregunta (texto exacto del ejercicio)
  const anchoPregunta = interior - (radioBadge * 2 + 34) - 20;
  const lineasPregunta = envolverLinea(embellecerMatematica(ej.enunciado || `Ejercicio ${ej.numero}`), tamPregunta, false, anchoPregunta);
  const hBanda = Math.max(radioBadge * 2 + 24, altoLineas(lineasPregunta.length, tamPregunta) + 28);

  // Gráfico (a la derecha de los pasos, si hay)
  let graf = null, avisoGraf = null;
  if (ej.grafico) {
    try { graf = atomoGrafico(ej.grafico, Math.round(interior * 0.46), { ratio: 0.78, maxAncho: 470 }); }
    catch (err) { avisoGraf = `No pude dibujar el gráfico (${err.message}).`; }
  }
  const anchoPasos = graf ? interior - Math.round(interior * 0.46) - 22 : interior;

  // Pasos resumidos
  const pasos = (Array.isArray(ej.pasos) ? ej.pasos : []).slice(0, 8).map((p, i) => ({ i, lineas: envolverLinea(embellecerMatematica(p), tamPaso, false, anchoPasos - 46) }));
  let hPasos = 0; for (const p of pasos) hPasos += altoLineas(p.lineas.length, tamPaso) + 8;
  const hCuerpo = Math.max(hPasos, graf ? graf.h : 0);

  // Respuesta destacada
  const textoResp = ej.respuesta || 'No se puede resolver con los datos de la foto';
  const lineasResp = envolverLinea(embellecerMatematica(textoResp), tamResp, true, interior - 60 - anchoTexto('Respuesta: ', tamResp, true) - ((ej.verificacion === 'ok' || ej.verificacion === 'revisar') ? 170 : 0));
  const hResp = altoLineas(lineasResp.length, tamResp, 1.3) + 34;

  const lineasAviso = (ej.verificacion === 'revisar' || avisoGraf) ? envolverLinea(embellecerMatematica(avisoGraf || 'La comprobación automática no coincidió: revisa este resultado.'), 22, false, interior - 20) : [];
  const hAviso = lineasAviso.length ? altoLineas(lineasAviso.length, 22, 1.3) + 10 : 0;

  const h = pad + hBanda + 16 + (hCuerpo || 0) + (hCuerpo ? 16 : 0) + hResp + hAviso + pad;

  return { h, dibujar: (ctx, x, y, anchoDisp) => {
    const w = anchoDisp || anchoMax;
    let s = `<rect x="${x + 4}" y="${y + 7}" width="${w}" height="${h}" rx="26" fill="#000000" opacity="0.07"/>`;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="#ffffff" stroke="${ac.c}" stroke-opacity="0.35" stroke-width="3"/>`;
    s += `<rect x="${x}" y="${y + 26}" width="12" height="${h - 52}" rx="6" fill="${ac.c}"/>`;
    // Banda de la pregunta
    const yb = y + pad;
    s += `<rect x="${x + pad}" y="${yb}" width="${interior}" height="${hBanda}" rx="20" fill="${ac.claro}"/>`;
    s += `<circle cx="${x + pad + radioBadge + 14}" cy="${yb + hBanda / 2}" r="${radioBadge}" fill="${ac.c}"/>`;
    s += textoSVG(ctx, String(ej.numero), x + pad + radioBadge + 14, yb + hBanda / 2 + 12, String(ej.numero).length > 2 ? 24 : 34, { negrita: true, color: '#ffffff', anchor: 'middle' });
    const altoTexto = altoLineas(lineasPregunta.length, tamPregunta);
    let ty = yb + (hBanda - altoTexto) / 2;
    for (const l of lineasPregunta) { s += textoSVG(ctx, l, x + pad + radioBadge * 2 + 34, ty + tamPregunta * 1.02, tamPregunta, { color: COLOR.tinta }); ty += Math.round(tamPregunta * 1.32); }
    // Cuerpo: pasos + gráfico
    let cy = yb + hBanda + 16;
    let py = cy;
    for (const p of pasos) {
      s += `<circle cx="${x + pad + 15}" cy="${py + tamPaso * 0.62}" r="15" fill="${ac.c}"/>`;
      s += textoSVG(ctx, String(p.i + 1), x + pad + 15, py + tamPaso * 0.62 + 7, 18, { negrita: true, color: '#ffffff', anchor: 'middle' });
      let ly = py;
      for (const l of p.lineas) { s += textoSVG(ctx, l, x + pad + 46, ly + tamPaso * 1.02, tamPaso, { color: COLOR.tinta }); ly += Math.round(tamPaso * 1.32); }
      py += altoLineas(p.lineas.length, tamPaso) + 8;
    }
    if (graf) s += graf.dibujar(ctx, x + pad + anchoPasos + 22, cy, interior - anchoPasos - 22);
    cy += hCuerpo + (hCuerpo ? 16 : 0);
    // Respuesta
    const colorResp = ej.respuesta ? ac.c : COLOR.aviso;
    s += `<rect x="${x + pad}" y="${cy}" width="${interior}" height="${hResp}" rx="20" fill="${colorResp}"/>`;
    let ry = cy + 17;
    const prefijo = 'Respuesta: ';
    const anchoPref = anchoTexto(prefijo, tamResp, true);
    lineasResp.forEach((l, k) => {
      if (k === 0) s += textoSVG(ctx, prefijo, x + pad + 30, ry + tamResp * 1.02, tamResp, { negrita: true, color: '#ffffffcc' });
      s += textoSVG(ctx, l, x + pad + 30 + anchoPref, ry + tamResp * 1.02, tamResp, { negrita: true, color: '#ffffff' });
      ry += Math.round(tamResp * 1.3);
    });
    if (ej.verificacion === 'ok' || ej.verificacion === 'revisar') {
      const ok = ej.verificacion === 'ok';
      const etiqueta = ok ? '✔ Verificado' : '⚠ Revisar';
      const wp = anchoTexto(etiqueta, 20, true) + 30;
      s += `<rect x="${x + pad + interior - wp - 18}" y="${cy + hResp / 2 - 16}" width="${wp}" height="32" rx="16" fill="#ffffff"/>`;
      s += textoSVG(ctx, etiqueta, x + pad + interior - wp - 18 + 15, cy + hResp / 2 + 7, 20, { negrita: true, color: ok ? COLOR.ok : COLOR.aviso });
    }
    cy += hResp;
    if (lineasAviso.length) { let ay = cy + 8; for (const l of lineasAviso) { s += textoSVG(ctx, l, x + pad + 10, ay + 22 * 1.02, 22, { color: COLOR.aviso }); ay += Math.round(22 * 1.3); } }
    return s;
  } };
}

function construirAtomos(datos, anchoMax) {
  const atomos = [];
  datos.ejercicios.forEach((ej, i) => { atomos.push(atomoEspacio(10)); atomos.push(atomoTarjetaEjercicio(ej, i, anchoMax)); atomos.push(atomoEspacio(12)); });
  for (const adv of (datos.advertencias || [])) { atomos.push(...atomoAviso(adv, anchoMax)); atomos.push(atomoEspacio(10)); }
  return atomos;
}

function paginar(atomos, altoUtil, altoCabeceraPrimera) {
  const paginas = [[]];
  let y = altoCabeceraPrimera;
  for (let i = 0; i < atomos.length; i++) {
    const a = atomos[i];
    const siguiente = a.conSiguiente ? atomos[i + 1] : null;
    const necesario = a.h + (siguiente ? siguiente.h : 0);
    let actual = paginas[paginas.length - 1];
    if (y + necesario > altoUtil && actual.length > 0) {
      paginas.push([]); y = 0; actual = paginas[paginas.length - 1];
    }
    if (a.espacio && actual.length === 0 && paginas.length > 1) continue; // sin espacios al inicio de página
    actual.push({ a, y });
    y += a.h;
  }
  return paginas;
}

function componerPaginasSVG(datos, opciones = {}) {
  const { w, h, margen, pie } = PAGINA;
  const anchoMax = w - margen * 2;
  const maxPaginas = opciones.maxPaginas || MAX_PAGINAS_DEFECTO;
  const atomos = construirAtomos(datos, anchoMax);

  // Cabecera: banner con degradado (solo en la primera página)
  const tituloAtomos = atomosTexto(embellecerMatematica(datos.titulo || 'Tarea resuelta'), { tam: 46, negrita: true, color: '#ffffff', anchoMax: anchoMax - 60, interlineado: 1.2 });
  const subAtomos = datos.subtitulo ? atomosTexto(embellecerMatematica(datos.subtitulo), { tam: 24, color: '#ffffffd9', anchoMax: anchoMax - 60 }) : [];
  const altoBanner = 34 + tituloAtomos.reduce((a, b) => a + b.h, 0) + subAtomos.reduce((a, b) => a + b.h, 0) + 30;
  const altoCab = altoBanner + 22;
  const nEjercicios = datos.ejercicios.length;
  const cabecera = [];
  void cabecera;

  const altoUtil = h - margen - pie;
  const alturaPrimera = altoCab; // se mide desde margen superior
  const paginas = paginar(atomos, altoUtil - margen, alturaPrimera);
  const truncado = paginas.length > maxPaginas;
  const usadas = paginas.slice(0, maxPaginas);

  const svgs = usadas.map((items, idxPagina) => {
    const ctx = nuevoContexto();
    let cuerpo = '';
    if (idxPagina === 0) {
      cuerpo += `<rect x="${margen}" y="${margen}" width="${anchoMax}" height="${altoBanner}" rx="30" fill="url(#gBanner)"/>`;
      cuerpo += `<circle cx="${w - margen - 40}" cy="${margen + 20}" r="110" fill="#ffffff" opacity="0.10"/><circle cx="${w - margen - 150}" cy="${margen + altoBanner - 10}" r="70" fill="#ffffff" opacity="0.08"/>`;
      let cy = margen + 28;
      for (const a of tituloAtomos) { cuerpo += a.dibujar(ctx, margen + 30, cy); cy += a.h; }
      for (const a of subAtomos) { cuerpo += a.dibujar(ctx, margen + 30, cy); cy += a.h; }
      const chip = `${nEjercicios} ejercicio${nEjercicios === 1 ? '' : 's'}`;
      const wc = anchoTexto(chip, 22, true) + 36;
      cuerpo += `<rect x="${w - margen - wc - 24}" y="${margen + altoBanner - 52}" width="${wc}" height="34" rx="17" fill="#ffffff" opacity="0.95"/>`;
      cuerpo += textoSVG(ctx, chip, w - margen - wc - 24 + 18, margen + altoBanner - 52 + 24, 22, { negrita: true, color: '#b3124f' });
    }
    for (const { a, y } of items) cuerpo += a.dibujar(ctx, margen, margen + y, anchoMax);
    const textoPie = `Hoja ${idxPagina + 1} de ${usadas.length}${truncado ? '+' : ''}`;
    cuerpo += `<line x1="${margen}" y1="${h - pie}" x2="${w - margen}" y2="${h - pie}" stroke="${COLOR.linea}" stroke-width="2"/>`;
    cuerpo += textoSVG(ctx, `${datos.pie || 'YEYMI AI'}`, margen, h - pie + 38, 22, { negrita: true, color: COLOR.titulo });
    cuerpo += textoSVG(ctx, textoPie, w - margen, h - pie + 38, 22, { color: COLOR.gris, anchor: 'end' });
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs><linearGradient id="gBanner" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6a1b9a"/><stop offset="1" stop-color="#d81b60"/></linearGradient></defs><rect width="${w}" height="${h}" fill="#fbf8fc"/>${defsGlifos(ctx)}${cuerpo}</svg>`;
  });
  return { svgs, truncado, totalPaginas: paginas.length };
}

async function renderizarHoja(datos, opciones = {}) {
  let sharp;
  try { sharp = require('sharp'); }
  catch (err) { const e = new Error('La librería "sharp" no está instalada (npm install sharp).'); e.codigo = 'SHARP_NO_DISPONIBLE'; throw e; }
  if (!datos || !Array.isArray(datos.ejercicios) || datos.ejercicios.length === 0) throw new Error('No hay ejercicios para dibujar.');
  const { svgs, truncado, totalPaginas } = componerPaginasSVG(datos, opciones);
  const buffers = [];
  for (const svg of svgs) {
    buffers.push(await sharp(Buffer.from(svg), { density: 72 }).png({ compressionLevel: 7 }).toBuffer());
  }
  return { paginas: buffers, truncado, totalPaginas };
}

module.exports = { renderizarHoja, componerPaginasSVG, anchoTexto, envolverLinea, PAGINA, MAX_PAGINAS_DEFECTO };
