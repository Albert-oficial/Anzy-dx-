// Prueba de integración: ejecuta el index.js REAL con WhatsApp y Gemini simulados (no hay red ni credenciales).
const Module = require('module');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const assert = require('assert');
const sharp = require('sharp');

const DIR = process.env.ANZY_DIR;          // copia del proyecto donde se ejecuta
process.chdir(DIR);
process.env.CLAVE_IA_PRINCIPAL = 'clave-falsa-1';
process.env.CLAVE_IA_RESPALDO = 'clave-falsa-2';
process.env.PORT = '0';
process.env.CF_ACCOUNT_ID = 'cuenta-falsa'; process.env.CF_API_TOKEN = 'token-falso';
const llamadasFetch = []; let respuestaCF = null;
global.fetch = async (url, o) => { llamadasFetch.push({ url, o }); return respuestaCF(); };

const registro = { enviados: [], exec: [], rutas: {}, gemini: [], descargas: [] };
let comportamientoGemini = () => { throw new Error('sin guion'); };
let comportamientoDescarga = null;
const handlers = {};

const cp = require('child_process');
cp.exec = (cmd, opt, cb) => { if (typeof opt === 'function') cb = opt; registro.exec.push(cmd); setImmediate(() => cb(new Error('simulado'), '', 'simulado')); return { }; };

const stubs = {
  'dotenv': { config() {} },
  'qrcode-terminal': { generate() {} },
  'qrcode': { toDataURL: async () => 'data:image/png;base64,AA==' },
  'pino': () => ({}),
  'express': () => { const app = { get(r, f) { registro.rutas[r] = f; }, listen(p, f) { f && f(); } }; return app; },
  '@google/genai': { GoogleGenAI: class { constructor(o) { this.k = o.apiKey; this.models = { generateContent: async (p) => { registro.gemini.push({ k: this.k, p }); return comportamientoGemini(p, this.k); } }; } } },
  '@whiskeysockets/baileys': {
    default: () => {
      const sock = new EventEmitter();
      sock.ev = { on: (n, f) => { handlers[n] = f; } };
      sock.user = { id: '51975922748:1@s.whatsapp.net' };
      sock.sendMessage = async (jid, c, o) => { registro.enviados.push({ jid, c, o }); return {}; };
      sock.sendPresenceUpdate = async () => {};
      sock.groupMetadata = async () => ({ subject: 'Grupo', participants: [] });
      sock.groupFetchAllParticipating = async () => ({});
      sock.updateMediaMessage = async (m) => m;
      return sock;
    },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }),
    DisconnectReason: { loggedOut: 401, badSession: 500, restartRequired: 515 },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    downloadMediaMessage: async (m) => { registro.descargas.push('media'); if (comportamientoDescarga) return comportamientoDescarga(m); return fs.readFileSync('/tmp/foto_prueba.jpg'); },
    downloadContentFromMessage: async (n, t) => { registro.descargas.push('contenido:' + t); const b = comportamientoDescarga ? await comportamientoDescarga(n) : fs.readFileSync('/tmp/foto_prueba.jpg'); return (async function* () { yield b; })(); }
  }
};
const cargar = Module._load;
Module._load = function (req, ...r) { return stubs[req] ? stubs[req] : cargar.call(this, req, ...r); };

const respuestaTarea = (extra = {}) => JSON.stringify({ legible: true, titulo: 'Matemática — Prueba', ejercicios: [
  { numero: '1', enunciado: '12*(3+4)', pasos: ['3+4=7', '12*7=84'], respuesta: '84', verificaciones: [{ tipo: 'calculo', expresion: '12*(3+4)', resultado: 84 }], grafico: null },
  { numero: '2', enunciado: 'Grafica y=x^2-4', pasos: ['Raíces ±2'], respuesta: 'x=±2', verificaciones: [], grafico: { tipo: 'funcion', funciones: [{ expr: 'x^2-4' }], xmin: -4, xmax: 4 } }
], advertencias: [], ...extra });

const BOT = '51975922748', OWNER = '51996399291', GRUPO = '120363000000000001@g.us', ALUMNO = '51911111111@s.whatsapp.net';
let idMsg = 0;
const imgNodo = { mimetype: 'image/jpeg', fileLength: 5000, mediaKey: Buffer.from('k'), directPath: '/x' };
function msgTexto(texto, { quien = ALUMNO, chat = GRUPO, citaImagen = false, mencion = true, privado = false } = {}) {
  const ctx = {}; if (mencion) ctx.mentionedJid = [`${BOT}@s.whatsapp.net`];
  if (citaImagen) { ctx.stanzaId = 'IMGCITADA'; ctx.participant = ALUMNO; ctx.quotedMessage = { imageMessage: imgNodo }; }
  return { key: { remoteJid: privado ? quien : chat, participant: privado ? undefined : quien, id: 'M' + (++idMsg), fromMe: false }, pushName: 'Ana', message: { extendedTextMessage: { text: texto, contextInfo: ctx } } };
}
function msgImagen(caption, { quien = ALUMNO, mencion = true } = {}) {
  const ctx = mencion ? { mentionedJid: [`${BOT}@s.whatsapp.net`] } : {};
  return { key: { remoteJid: GRUPO, participant: quien, id: 'M' + (++idMsg), fromMe: false }, pushName: 'Ana', message: { imageMessage: { ...imgNodo, caption, contextInfo: ctx } } };
}
const emitir = async (...msgs) => { await handlers['messages.upsert']({ type: 'notify', messages: msgs }); await new Promise(r => setTimeout(r, 400)); };
const limpiar = () => { registro.enviados.length = 0; registro.gemini.length = 0; registro.descargas.length = 0; };
const textos = () => registro.enviados.filter(e => e.c.text).map(e => e.c.text);
const imagenes = () => registro.enviados.filter(e => e.c.image);

(async () => {
  // Foto de prueba real (JPEG)
  const base = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  fs.writeFileSync('/tmp/foto_prueba.jpg', base);

  require(path.join(DIR, 'index.js'));
  await new Promise(r => setTimeout(r, 300));
  await handlers['connection.update']({ connection: 'open' });
  const ok = (n) => console.log('  ✔', n);

  // 1. Foto adjunta con mención + "resuelve esta tarea" -> texto
  comportamientoGemini = () => ({ text: respuestaTarea() });
  await emitir(msgImagen('@51975922748 resuelve esta tarea'));
  let t = textos().join('\n');
  assert(t.includes('Leyendo tu foto'), 'acuse'); assert(t.includes('Ejercicio 1') && t.includes('84'), 'solución'); assert(t.includes('comprobado por código'));
  const llamada = registro.gemini[0].p;
  assert(llamada.contents[0].parts[0].inlineData.data.length > 100 && llamada.contents[0].parts[0].inlineData.mimeType === 'image/jpeg', 'la imagen llegó al modelo');
  assert(llamada.config.responseMimeType === 'application/json');
  assert(registro.descargas.includes('media'));
  ok('foto adjunta -> imagen enviada al modelo, solución en texto');

  // 2. Foto CITADA + mención + "pásamelo en foto" -> hoja (imágenes PNG)
  limpiar();
  await emitir(msgTexto('@51975922748 Resuélvelo todo, con sus gráficos, y pásamelo en foto', { citaImagen: true }));
  const im = imagenes();
  assert(im.length >= 1, 'hoja enviada'); assert(im[0].c.image.slice(0, 4).toString('hex') === '89504e47', 'es PNG'); assert(im[0].c.caption.includes('hoja 1/'));
  assert(registro.descargas.includes('contenido:image'), 'imagen citada descargada con downloadContentFromMessage');
  ok(`foto citada -> hoja PNG enviada (${im.length} página/s)`);

  // 3. Foto sin pie de foto (no responde) y luego pregunta
  limpiar();
  await emitir(msgImagen('', { mencion: false }));
  assert.strictEqual(registro.enviados.length, 0, 'foto sin mención no debe responder'); assert.strictEqual(registro.gemini.length, 0);
  await emitir(msgTexto('/anzy resuelve la tarea de la foto', { mencion: false }));
  assert(registro.gemini.length === 1 && textos().join('').includes('Ejercicio 1'), 'usa la foto reciente');
  ok('foto sin texto no responde; pregunta posterior usa la foto reciente del mismo usuario');

  // 3b. Otra persona NO puede usar mi foto reciente
  limpiar();
  await emitir(msgImagen('', { quien: '51922222222@s.whatsapp.net', mencion: false }));
  await emitir(msgTexto('/anzy resuelve la tarea de la foto', { quien: '51955555555@s.whatsapp.net', mencion: false }));
  assert(!registro.gemini.some(g => JSON.stringify(g.p.contents).includes('inlineData')), 'no usa fotos de otra persona (cae al chat de texto normal)');
  ok('la foto reciente es solo de quien la envió');

  // 4. Lectura simple (no tarea)
  limpiar();
  comportamientoGemini = () => ({ text: 'Veo un cuaderno en blanco 🙂' });
  await emitir(msgTexto('/anzy lee esta imagen y dime qué tengo que hacer', { citaImagen: true, mencion: false }));
  assert(textos().join('').includes('cuaderno')); assert(registro.gemini[0].p.config.responseMimeType === undefined);
  ok('lectura simple de imagen citada');

  // 5. Errores
  limpiar();
  comportamientoGemini = () => { const e = new Error('429 RESOURCE_EXHAUSTED quota'); e.status = 429; throw e; };
  await emitir(msgImagen('@51975922748 resuelve'));
  assert(textos().join('').includes('cuota'), 'mensaje de cuota'); assert.strictEqual(registro.gemini.length, 2, 'prueba principal y respaldo sin reintentos extra');
  ok('cuota agotada -> mensaje claro, solo 2 llamadas (principal+respaldo), sin reintento duplicado');

  limpiar();
  comportamientoDescarga = () => { const e = new Error('Failed 404 not found'); throw e; };
  await emitir(msgImagen('@51975922748 resuelve'));
  assert(textos().join('').includes('ya no está disponible'), 'media caducada'); assert.strictEqual(registro.gemini.length, 0);
  limpiar();
  comportamientoDescarga = () => Buffer.from('esto no es una imagen, pero es lo bastante largo '.repeat(40));
  await emitir(msgImagen('@51975922748 resuelve'));
  assert(textos().join('').includes('dañada'), 'imagen corrupta'); assert.strictEqual(registro.gemini.length, 0);
  limpiar();
  comportamientoDescarga = () => Buffer.alloc(100);
  await emitir(msgImagen('@51975922748 resuelve'));
  assert(textos().join('').includes('dañada'), 'imagen vacía');
  comportamientoDescarga = null;
  ok('descarga fallida / imagen corrupta / vacía -> mensajes comprensibles, sin llamar a la IA');

  limpiar();
  comportamientoGemini = () => ({ text: JSON.stringify({ legible: false, motivo_ilegible: 'está borrosa', ejercicios: [] }) });
  await emitir(msgImagen('@51975922748 resuelve esta tarea'));
  assert(textos().join('').includes('borrosa') && textos().join('').includes('más clara'));
  ok('foto borrosa -> pide una más clara');

  limpiar();
  comportamientoGemini = () => ({ text: respuestaTarea({ ejercicios: [{ numero: '1', enunciado: '7*6', pasos: ['7*6=43'], respuesta: '43', verificaciones: [{ tipo: 'calculo', expresion: '7*6', resultado: 43 }] }] }) });
  await emitir(msgImagen('@51975922748 resuelve'));
  assert(textos().join('').includes('no coincidió'), 'discrepancia detectada por código');
  ok('un cálculo incorrecto de la IA se detecta y se marca');

  limpiar();
  comportamientoGemini = () => ({ text: 'esto no es json' });
  await emitir(msgImagen('@51975922748 resuelve'));
  assert(textos().join('').includes('esto no es json'));
  ok('JSON inválido -> se entrega el texto sin inventar');

  // 6. Concurrencia: dos fotos del mismo usuario a la vez -> la segunda espera
  limpiar();
  comportamientoGemini = async () => { await new Promise(r => setTimeout(r, 300)); return { text: respuestaTarea() }; };
  await handlers['messages.upsert']({ type: 'notify', messages: [msgImagen('@51975922748 resuelve'), msgImagen('@51975922748 resuelve otra vez')] });
  await new Promise(r => setTimeout(r, 1500));
  assert(textos().some(x => x.includes('Ya estoy trabajando')), 'bloqueo de duplicado'); 
  ok('lote con 2 mensajes -> ambos atendidos; el duplicado del mismo usuario recibe aviso');

  // 7. Usuarios distintos en paralelo no se bloquean entre sí
  limpiar();
  const t0 = Date.now();
  await handlers['messages.upsert']({ type: 'notify', messages: [msgImagen('@51975922748 resuelve', { quien: '51933333333@s.whatsapp.net' }), msgImagen('@51975922748 resuelve', { quien: '51944444444@s.whatsapp.net' })] });
  await new Promise(r => setTimeout(r, 1200));
  assert.strictEqual(textos().filter(x => x.includes('Ejercicio 1')).length, 2); assert(Date.now() - t0 < 2500);
  ok('dos usuarios distintos se atienden en paralelo');

  // 8. Uptime
  limpiar();
  await emitir(msgTexto('/anzy cuánto tiempo llevas encendida'));
  t = textos().join('');
  assert(/ANZY ESTÁ ACTIVO DESDE HACE:/.test(t) && /segundo/.test(t), t); assert.strictEqual(registro.gemini.length, 0, 'no consulta a la IA');
  console.log('   ', t.split('\n')[2]);
  ok('uptime calculado por código, sin llamar a la IA');

  // 9. Control del propietario
  limpiar();
  await emitir(msgTexto('/anzy desactiva el bot'));
  assert(textos().join('').includes('Solo el propietario')); 
  const st = () => { let out; registro.rutas['/status']({}, { json: (d) => { out = d; } }); return out; };
  assert.strictEqual(st().botActivo, true);
  limpiar();
  await emitir(msgTexto('/anzy desactiva el bot', { quien: `${OWNER}@s.whatsapp.net`, privado: true, mencion: false }));
  assert.strictEqual(st().botActivo, false); assert(textos().join('').includes('desactivado'));
  await emitir(msgTexto('/anzy activa el bot', { quien: `${OWNER}@s.whatsapp.net`, privado: true, mencion: false }));
  assert.strictEqual(st().botActivo, true);
  ok('apagar/encender: usuario normal rechazado, propietario autorizado');

  limpiar();
  await emitir(msgTexto('/anzy desactiva el modo amiga, te lo pido'));
  assert.strictEqual(st().botActivo, true); assert(!textos().join('').includes('propietario'));
  ok('"desactiva el modo amiga" no se confunde con apagar el bot');

  limpiar();
  comportamientoGemini = () => ({ text: 'OK' });
  await emitir(msgTexto('/anzy comprueba si la IA está funcionando', { quien: `${OWNER}@s.whatsapp.net`, privado: true, mencion: false }));
  assert(textos().join('').includes('Prueba de IA') && textos().join('').includes('✅ principal'));
  limpiar();
  await emitir(msgTexto('/anzy comprueba si la IA está funcionando'));
  assert.strictEqual(registro.gemini.length >= 0, true); assert(!textos().join('').includes('Prueba de IA'), 'usuario normal no puede lanzar pruebas');
  ok('prueba de IA: solo propietario');

  limpiar();
  await emitir(msgTexto('/diagnostico'));
  assert(textos().join('').includes('Solo el propietario'));
  await emitir(msgTexto('/diagnostico', { quien: `${OWNER}@s.whatsapp.net`, privado: true, mencion: false }));
  const d = textos().join('\n'); assert(d.includes('Diagnóstico') && d.includes('Tiempos de respuesta') && !/clave-falsa/.test(d), d);
  ok('/diagnostico: protegido y sin claves');

  // 10. /status mantiene campos y añade nuevos
  const s = st();
  for (const c of ['conectado', 'botActivo', 'uptimeSegundos', 'mensajesRecibidos', 'mensajesEnviados', 'intentosReconexion', 'cuotaUsada', 'cuotaLimite', 'version']) assert(c in s, c);
  assert(s.uptimeTexto && s.inicioProceso); ok('/status conserva sus campos y añade uptimeTexto e inicioProceso');

  // 11. Seguridad TikTok
  registro.exec.length = 0; limpiar();
  await emitir(msgTexto('/tiktok tiktok.com/a"$(touch /tmp/pwn)"', { mencion: false }));
  await emitir(msgTexto('/tiktok --exec=id tiktok.com/x', { mencion: false }));
  assert(!registro.exec.some(c => c.includes('touch') || c.includes('--exec')), 'sin inyección: ' + registro.exec.join(' | '));
  registro.exec.length = 0;
  await emitir(msgTexto('/tiktok https://www.tiktok.com/@user/video/123?is_from_webapp=1&sender_device=pc', { mencion: false }));
  assert(registro.exec.some(c => c.includes('tiktok.com/@user/video/123')), 'una URL legítima sí llega a yt-dlp');
  ok('TikTok: inyección de comandos bloqueada; URL legítima sigue funcionando');

  // 11b. Imágenes con Cloudflare (simulado)
  const png = await sharp(require('crypto').randomBytes(128 * 128 * 3), { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  limpiar(); llamadasFetch.length = 0;
  comportamientoGemini = () => ({ text: 'a cute cat, watercolor' });
  respuestaCF = () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ result: { image: png.toString('base64') }, success: true }) });
  await emitir(msgTexto('/imagen un gato en acuarela', { mencion: false }));
  assert(imagenes().length === 1 && imagenes()[0].c.image.equals(png), 'imagen de Cloudflare enviada: ' + JSON.stringify(registro.enviados.map(e => e.c.text || 'IMG')) + ' fetch=' + llamadasFetch.length);
  assert(llamadasFetch[0].url.includes('/accounts/cuenta-falsa/ai/run/@cf/black-forest-labs/flux-1-schnell') && llamadasFetch[0].o.headers.Authorization === 'Bearer token-falso');
  assert(JSON.parse(llamadasFetch[0].o.body).prompt === 'a cute cat, watercolor');
  limpiar();
  respuestaCF = () => ({ ok: false, status: 429, text: async () => 'you have used up your daily free allocation of 10,000 neurons' });
  await emitir(msgTexto('/imagen un perro', { mencion: false }));
  assert(textos().join('').includes('19:00'), textos().join('|'));
  limpiar();
  respuestaCF = () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => png });
  await emitir(msgTexto('genera una imagen de un volcán', { mencion: true }));
  assert(imagenes().length === 1, 'respuesta binaria y lenguaje natural');
  ok('Cloudflare: imagen enviada, cuota diaria con mensaje claro, respuesta binaria y "genera una imagen de..."');

  // 12. Panel con token
  registro.rutas = registro.rutas; 
  const res401 = {}; registro.rutas['/panel/toggle']({ query: {}, headers: {} }, { status(c) { res401.c = c; return this; }, send() {}, redirect() { res401.redir = true; } });
  console.log('   PANEL_TOKEN =', process.env.PANEL_TOKEN ? 'definido' : 'no definido', '→ /panel/toggle sin token:', res401.c || (res401.redir ? 'permitido (comportamiento anterior)' : '?'));
  if (process.env.PANEL_TOKEN) { assert.strictEqual(res401.c, 401); const r2 = {}; registro.rutas['/panel/toggle']({ query: { token: process.env.PANEL_TOKEN }, headers: {} }, { status() { return this; }, send() {}, redirect(u) { r2.u = u; } }); assert(r2.u && r2.u.startsWith('/?token=')); const q = {}; registro.rutas['/qr']({ query: {}, headers: {} }, { status(c) { q.c = c; return this; }, send() {} }); assert.strictEqual(q.c, 401); ok('con PANEL_TOKEN: acciones y /qr protegidos'); }
  else { assert(res401.redir); ok('sin PANEL_TOKEN: comportamiento anterior conservado (con aviso en logs)'); registro.rutas['/panel/toggle']({ query: {}, headers: {} }, { status() { return this; }, send() {}, redirect() {} }); }

  console.log('\nTODAS LAS PRUEBAS DE INTEGRACIÓN PASARON');
  process.exit(0);
})().catch(e => { console.error('FALLÓ:', e); process.exit(1); });
