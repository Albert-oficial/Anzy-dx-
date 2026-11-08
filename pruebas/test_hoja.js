const fs = require('fs');
const { renderizarHoja, componerPaginasSVG } = require('../lib/hoja');
const datos = {
  titulo: 'Tarea de Matemática — Álgebra y geometría',
  subtitulo: 'Resuelta por Anzy · Ejercicios 1 a 6',
  pie: 'Anzy v3.4.0',
  ejercicios: [
    { numero: 1, enunciado: 'Calcula: 12 × (3 + 4) − 5^2', pasos: ['Resolvemos el paréntesis: 3 + 4 = 7', 'Multiplicamos: 12 * 7 = 84', 'Potencia: 5^2 = 25', 'Restamos: 84 - 25 = 59'], respuesta: '59', verificacion: 'ok' },
    { numero: 2, enunciado: 'Resuelve la ecuación 2x + 3 = 11', pasos: ['Restamos 3 a ambos lados: 2x = 8', 'Dividimos entre 2: x = 4', 'Comprobación: 2*4 + 3 = 11 ✔'], respuesta: 'x = 4', verificacion: 'ok' },
    { numero: 3, enunciado: 'Grafica f(x) = x^2 - 4 e indica los cortes con el eje x.', pasos: ['Raíces: x^2 - 4 = 0 → x = ±2', 'Vértice en (0, -4)'], respuesta: 'Cortes en x = -2 y x = 2; vértice (0, -4)',
      grafico: { tipo: 'funcion', titulo: 'f(x) = x² − 4', funciones: [{ expr: 'x^2-4', etiqueta: 'y = x^2 - 4' }], xmin: -5, xmax: 5, puntos: [{ x: -2, y: 0, etiqueta: '(-2, 0)' }, { x: 2, y: 0, etiqueta: '(2, 0)' }, { x: 0, y: -4, etiqueta: '(0, -4)' }] }, verificacion: 'ok' },
    { numero: 4, enunciado: 'Un triángulo rectángulo tiene catetos 3 cm y 4 cm. Halla la hipotenusa y dibújalo.', pasos: ['Teorema de Pitágoras: h^2 = 3^2 + 4^2', 'h^2 = 9 + 16 = 25', 'h = sqrt(25) = 5'], respuesta: 'h = 5 cm',
      grafico: { tipo: 'plano', titulo: 'Triángulo ABC', puntos: [{ nombre: 'A', x: 0, y: 0, etiqueta: 'A(0, 0)' }, { nombre: 'B', x: 4, y: 0, etiqueta: 'B(4, 0)' }, { nombre: 'C', x: 0, y: 3, etiqueta: 'C(0, 3)' }], poligonos: [['A', 'B', 'C']], segmentos: [{ desde: 'A', hasta: 'B', etiqueta: '4 cm' }, { desde: 'A', hasta: 'C', etiqueta: '3 cm' }, { desde: 'B', hasta: 'C', etiqueta: '5 cm' }] }, verificacion: 'ok' },
    { numero: 5, enunciado: 'Área de un círculo de radio 3 cm (usa π).', pasos: ['A = π × r^2', 'A = π × 3^2 = 9π ≈ 28,27'], respuesta: 'A ≈ 28,27 cm²', grafico: { tipo: 'circulo', radio: 3, etiqueta: 'r = 3 cm' }, verificacion: 'ok' },
    { numero: 6, enunciado: 'Ventas por mes (tabla): enero 12, febrero 18, marzo 9, abril 15. Haz un gráfico de barras.', pasos: ['Cada barra representa las ventas del mes.'], respuesta: 'Mayor venta: febrero (18)', grafico: { tipo: 'barras', categorias: ['Ene', 'Feb', 'Mar', 'Abr'], valores: [12, 18, 9, 15] }, verificacion: 'revisar' }
  ],
  advertencias: ['El ejercicio 7 de la foto no se leía con claridad, por eso no lo resolví.']
};
(async () => {
  const t0 = Date.now();
  const r = await renderizarHoja(datos);
  console.log('páginas:', r.paginas.length, 'truncado:', r.truncado, 'ms:', Date.now() - t0, 'bytes:', r.paginas.map(b => b.length));
  r.paginas.forEach((b, i) => fs.writeFileSync(`/tmp/hoja_${i + 1}.png`, b));
  const meta = await require('sharp')(r.paginas[0]).metadata();
  console.log('formato', meta.format, meta.width + 'x' + meta.height);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
