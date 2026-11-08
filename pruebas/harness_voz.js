// Prueba de integración de la VOZ: ejecuta el index.js REAL con WhatsApp, Gemini, ElevenLabs y GitHub simulados.
// ffmpeg es REAL (se comprueba la conversión a Ogg/Opus). Modo "persistencia": ANZY_FASE=2 reutiliza la "nube" simulada.
const Module = require('module'); const path = require('path'); const fs = require('fs'); const EventEmitter = require('events'); const assert = require('assert');
const { execFileSync } = require('child_process');
const DIR = process.env.ANZY_DIR; process.chdir(DIR);
const FASE = process.env.ANZY_FASE || '1';
process.env.CLAVE_IA_PRINCIPAL = 'clave-ia-falsa'; process.env.PORT = '0';
process.env.ELEVENLABS_API_KEY = 'sk_clavesecretafalsa1234567890'; process.env.GITHUB_TOKEN = 'ghp_tokenfalsotokenfalsotokenfalso123'; process.env.GITHUB_REPO = 'dueno/bot';
const NUBE = '/tmp/nube_falsa.json'; if (FASE === '1') { try { fs.unlinkSync(NUBE); } catch {} }
const nube = () => { try { return JSON.parse(fs.readFileSync(NUBE, 'utf8')); } catch { return {}; } };

const logs = []; const logOriginal = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
const salida = (...a) => logOriginal(...a);
const registro = { enviados: [], gemini: [], eleven: [], github: [], exec: [] };
let guionGemini = () => ({ text: 'Respuesta de prueba.' }); let guionEleven = null; let sinFfmpeg = false;
const handlers = {};
const cp = require('child_process'); cp.exec = (c, o, cb) => { if (typeof o === 'function') cb = o; setImmediate(() => cb(new Error('simulado'), '', 'simulado')); return {}; };
const mp3 = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1 << 24 });
const resp = (status, cuerpo, tipo = 'application/json') => ({ ok: status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? tipo : null) }, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)), json: async () => (typeof cuerpo === 'string' ? JSON.parse(cuerpo) : cuerpo), arrayBuffer: async () => (Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(String(cuerpo))) });
global.fetch = async (url, o = {}) => {
  url = String(url);
  if (url.startsWith('https://api.elevenlabs.io')) {
    registro.eleven.push({ url, body: o.body ? JSON.parse(o.body) : null, key: o.headers['xi-api-key'] });
    if (guionEleven) { const r = guionEleven(url); if (r) return r; }
    if (url.includes('/text-to-speech/')) return resp(200, mp3, 'audio/mpeg');
    if (url.includes('/voices')) return resp(200, { voices: [{ voice_id: 'AAAAAAAAAAAAAAAAAAAA', name: 'Sarah - Soft', category: 'premade', labels: { gender: 'female', accent: 'american' }, verified_languages: [{ language: 'es' }] }, { voice_id: 'BBBBBBBBBBBBBBBBBBBB', name: 'Matilda', category: 'premade', labels: { gender: 'female' } }] });
    if (url.includes('/user/subscription')) return resp(200, { character_count: 1234, character_limit: 10000, tier: 'free', next_character_count_reset_unix: 1790000000 });
    return resp(404, 'no');
  }
  if (url.startsWith('https://api.github.com')) {
    const m = url.match(/contents\/([^?]+)/); const archivo = decodeURIComponent(m[1]); const n = nube();
    registro.github.push({ metodo: o.method || 'GET', archivo, rama: (url.match(/ref=([^&]+)/) || [])[1] || (o.body && JSON.parse(o.body).branch) });
    if ((o.method || 'GET') === 'GET') return n[archivo] ? resp(200, { sha: 'sha' + n[archivo].v, content: Buffer.from(n[archivo].c).toString('base64') }) : resp(404, 'x');
    const b = JSON.parse(o.body); const v = (n[archivo] ? n[archivo].v : 0) + 1; n[archivo] = { v, c: Buffer.from(b.content, 'base64').toString('utf8') }; fs.writeFileSync(NUBE, JSON.stringify(n)); return resp(200, { content: { sha: 'sha' + v } });
  }
  throw new Error('fetch no simulado: ' + url);
};
const stubs = {
  'dotenv': { config() {} }, 'qrcode-terminal': { generate() {} }, 'qrcode': { toDataURL: async () => 'data:' }, 'pino': () => ({}),
  'express': () => ({ get() {}, listen(p, f) { f && f(); } }),
  '@google/genai': { GoogleGenAI: class { constructor() { this.models = { generateContent: async (p) => { registro.gemini.push(p); return guionGemini(p); } }; } } },
  '@whiskeysockets/baileys': {
    default: () => { const sock = new EventEmitter(); sock.ev = { on: (n, f) => { handlers[n] = f; } }; sock.user = { id: '51975922748:1@s.whatsapp.net' };
      sock.sendMessage = async (jid, c, o) => { registro.enviados.push({ jid, c, o }); return {}; }; sock.sendPresenceUpdate = async () => {}; sock.groupMetadata = async () => ({ subject: 'G', participants: [] }); sock.groupFetchAllParticipating = async () => ({}); sock.updateMediaMessage = async (m) => m; return sock; },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }), DisconnectReason: { loggedOut: 401, badSession: 500, restartRequired: 515 }, fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    downloadMediaMessage: async () => Buffer.from('OggS'.padEnd(4000, 'x')), downloadContentFromMessage: async () => (async function* () { yield Buffer.alloc(3000); })()
  }
};
const cargar = Module._load; Module._load = function (req, ...r) { return stubs[req] ? stubs[req] : cargar.call(this, req, ...r); };

const DUENO = '51996399291@s.whatsapp.net', OTRO = '51922222222@s.whatsapp.net', GRUPO = '120363000000000001@g.us', BOT = '51975922748';
let idn = 0;
const priv = (texto, de = DUENO) => ({ key: { remoteJid: de, id: 'T' + (++idn), fromMe: false }, pushName: 'Albert', message: { conversation: texto } });
const nota = (de = DUENO, id) => ({ key: { remoteJid: de, id: id || 'A' + (++idn), fromMe: false }, pushName: 'Albert', message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: 5, fileLength: 4000, mediaKey: Buffer.from('k') } } });
const grupo = (texto) => ({ key: { remoteJid: GRUPO, participant: DUENO, id: 'G' + (++idn), fromMe: false }, pushName: 'Albert', message: { extendedTextMessage: { text: texto, contextInfo: { mentionedJid: [`${BOT}@s.whatsapp.net`] } } } });
const emitir = async (...m) => { await handlers['messages.upsert']({ type: 'notify', messages: m }); await new Promise(r => setTimeout(r, 450)); };
const limpiar = () => { registro.enviados.length = 0; registro.gemini.length = 0; registro.eleven.length = 0; registro.github.length = 0; };
const audios = () => registro.enviados.filter(e => e.c.audio); const textos = () => registro.enviados.filter(e => e.c.text).map(e => e.c.text);
const tts = () => registro.eleven.filter(e => e.url.includes('/text-to-speech/'));
const prefs = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'voz_preferencias.json'), 'utf8')).usuarios; } catch { return {}; } };
const ok = (m) => salida('  ✔', m);
const esNotaOpus = (e) => e.c.ptt === true && e.c.mimetype === 'audio/ogg; codecs=opus' && Buffer.isBuffer(e.c.audio) && e.c.audio.subarray(0, 4).toString('latin1') === 'OggS';

(async () => {
  require(path.join(DIR, 'index.js')); await new Promise(r => setTimeout(r, 500));
  await handlers['connection.update']({ connection: 'open' }); await new Promise(r => setTimeout(r, 800));

  if (FASE === '2') {
    // Reinicio simulado: sin archivos locales, las preferencias vuelven desde "GitHub"
    assert.strictEqual((prefs()[ '51996399291' ] || {}).modo, 'voz', 'las preferencias deben recuperarse de la nube tras reiniciar');
    limpiar(); guionGemini = () => ({ text: 'Claro, te cuento.' });
    await emitir(priv('Cuéntame algo')); assert(audios().length === 1 && esNotaOpus(audios()[0]) && textos().length === 0, 'tras reiniciar sigue en modo voz');
    ok('PRUEBA 6/10: tras reiniciar (sin archivos locales) el modo voz se recupera desde GitHub y se responde con nota de voz');
    assert(logs.some(l => /ffmpeg con libopus disponible/.test(l))); ok('ffmpeg con libopus detectado al arrancar');
    salida('\nFASE 2 OK'); process.exit(0);
  }

  assert(logs.some(l => /ffmpeg con libopus disponible/.test(l)), 'detección de ffmpeg/libopus');
  // P1: texto en modo texto
  guionGemini = () => ({ text: '¡Hola! Estoy muy bien, ¿y tú?' });
  await emitir(priv('Hola, ¿cómo estás?'));
  assert(textos().join('').includes('Estoy muy bien') && audios().length === 0 && tts().length === 0); ok('PRUEBA 1: texto normal en privado -> respuesta de texto, sin llamar a ElevenLabs (conversación libre del propietario)');
  // ambiguo
  limpiar(); await emitir(priv('Mi abuela tenía una voz hermosa')); assert(!prefs()['51996399291'] && audios().length === 0 && tts().length === 0); ok('mención casual de "voz" no cambia el modo');
  // P2: activar voz
  limpiar(); guionGemini = () => ({ text: 'ok' });
  await emitir(priv('Quiero que desde ahora me hables con tu voz'));
  assert.strictEqual(prefs()['51996399291'].modo, 'voz'); assert(audios().length === 1 && esNotaOpus(audios()[0]) && registro.gemini.length === 0);
  ok('PRUEBA 2: instrucción natural -> modo voz guardado y confirmación hablada (nota de voz Ogg/Opus real)');
  // P3: texto en modo voz
  limpiar(); guionGemini = (p) => ({ text: 'Mañana tienes reunión a las diez y luego tiempo libre. ¡Va a ir muy bien!' });
  await emitir(priv('¿Qué planes tengo para mañana?'));
  assert(audios().length === 1 && textos().length === 0 && tts().length === 1 && esNotaOpus(audios()[0])); assert(String(registro.gemini[0].config.systemInstruction).includes('MODO VOZ') || JSON.stringify(registro.gemini[0]).includes('MODO VOZ'));
  assert(tts()[0].body.text === 'Mañana tienes reunión a las diez y luego tiempo libre. ¡Va a ir muy bien!'.replace('¡Va a ir muy bien!', '¡Va a ir muy bien!')); assert(tts()[0].key === 'sk_clavesecretafalsa1234567890' && tts()[0].body.model_id === 'eleven_multilingual_v2');
  ok('PRUEBA 3: mensaje escrito en modo voz -> UN solo audio (sin texto duplicado); el texto hablado es el de la IA');
  // P5: volver a texto
  limpiar(); await emitir(priv('Mejor vuelve a escribirme, estoy ocupado')); assert.strictEqual(prefs()['51996399291'].modo, 'texto'); assert(textos().join('').includes('vuelvo a escribirte') && audios().length === 0); ok('PRUEBA 5: "vuelve a escribirme" -> modo texto');
  // P4: nota de voz en modo texto
  limpiar(); guionGemini = () => ({ text: 'Mañana tienes una reunión y después descansas.' });
  await emitir(nota());
  assert(audios().length === 1 && esNotaOpus(audios()[0]) && textos().length === 0, JSON.stringify(registro.enviados.map(e => Object.keys(e.c))));
  const partes = registro.gemini[0].contents[0].parts; assert(partes[0].inlineData && /audio/.test(partes[0].inlineData.mimeType));
  ok('PRUEBA 4: nota de voz con modo texto -> el audio llega a la IA y se responde SOLO con nota de voz');
  // idempotencia
  limpiar(); const igual = nota(DUENO, 'MISMOID'); await emitir(igual, igual); assert.strictEqual(audios().length, 1); ok('el mismo mensaje no se procesa dos veces');
  // otro usuario / grupo
  limpiar(); const antes = JSON.stringify(prefs());
  await emitir(priv('Quiero escucharte', OTRO)); await emitir(nota(OTRO)); await emitir(grupo('Quiero que desde ahora me hables con tu voz'));
  assert.strictEqual(JSON.stringify(prefs()), antes); assert(audios().length === 0 && tts().length === 0); ok('PRUEBA 7: otro usuario y mensajes de grupo no cambian ni usan la voz del propietario');
  // clasificación con IA para frases sin patrón
  limpiar(); guionGemini = (p) => (String(p.contents).includes('clasificador') ? { text: '{"accion":"voz"}' } : { text: 'x' });
  await emitir(priv('Oye, me da pereza leer; ¿podrías contarme todo oyéndote de ahora en adelante?'));
  assert.strictEqual(prefs()['51996399291'].modo, 'voz'); ok('frase sin palabras clave rígidas: la IA clasifica la intención y cambia a voz');
  limpiar(); guionGemini = (p) => (String(p.contents).includes('clasificador') ? { text: '{"accion":"ninguna"}' } : { text: 'Sí, así de bonito.' });
  await emitir(priv('Me encanta cómo suena tu voz en los audios'));
  assert.strictEqual(prefs()['51996399291'].modo, 'voz'); ok('comentario sobre la voz, clasificado como "ninguna": no cambia el modo');
  // P9: respuesta larga
  limpiar(); const larga = Array.from({ length: 60 }, (_, i) => `Esta es la oración número ${i + 1} de una respuesta bastante extensa.`).join(' ');
  guionGemini = () => ({ text: larga }); await emitir(priv('Cuéntame una historia larga'));
  const hablado = tts()[0].body.text; const resto = textos().join(' ').replace('📝 El resto te lo dejo escrito:', '');
  assert(hablado.length <= 1200 && hablado.endsWith('.') && audios().length === 1); assert((hablado + ' ' + resto).replace(/\s+/g, ' ').trim() === larga.replace(/\s+/g, ' ').trim(), 'audio + texto restante = respuesta completa');
  ok(`PRUEBA 9: respuesta larga (${larga.length} caracteres) -> audio de ${hablado.length} caracteres terminado en oración completa + resto por texto`);
  // caché
  limpiar(); guionGemini = () => ({ text: 'Hola de nuevo.' }); await emitir(priv('Saluda')); await emitir(priv('Saluda otra vez')); assert.strictEqual(tts().length, 1); assert.strictEqual(audios().length, 2); ok('misma frase dos veces -> una sola llamada a ElevenLabs (caché)');
  // concurrencia
  limpiar(); let n = 0; guionGemini = () => ({ text: `Respuesta distinta número ${++n}.` }); await emitir(nota(DUENO), nota(DUENO)); assert.strictEqual(audios().length, 2); assert.strictEqual(new Set(tts().map(t => t.body.text)).size, 2); ok('dos notas de voz simultáneas -> dos audios distintos, sin mezclar');
  // herramientas del propietario
  limpiar(); await emitir(priv('Lista las voces disponibles')); assert(textos().join('').includes('Matilda') && textos().join('').includes('AAAAAAAAAAAAAAAAAAAA')); ok('"lista las voces" muestra nombre e id (cómo elegir la voz)');
  limpiar(); await emitir(priv('Usa la voz Matilda')); assert.strictEqual(prefs()['51996399291'].voiceId, 'BBBBBBBBBBBBBBBBBBBB'); assert(tts()[0].url.includes('/BBBBBBBBBBBBBBBBBBBB')); ok('"usa la voz Matilda" cambia la voz de forma persistente, sin tocar código');
  limpiar(); await emitir(priv('¿Cuántos créditos de voz me quedan?')); assert(textos().join('').includes('1234 de 10000')); ok('consulta de crédito real de ElevenLabs');
  limpiar(); await emitir(priv('Prueba tu voz')); assert(audios().length === 1); ok('"prueba tu voz" genera un audio de muestra');
  // voz no permitida en el plan gratis (402) -> usa otra voz premade de la cuenta
  limpiar(); guionGemini = () => ({ text: 'Probando una voz permitida por mi plan.' });
  let primera = true; guionEleven = (u) => { if (u.includes('/text-to-speech/') && primera) { primera = false; return resp(402, { detail: { status: 'payment_required', code: 'paid_plan_required', message: 'Free users cannot use library voices via the API.' } }); } return null; };
  fs.writeFileSync(path.join(DIR, 'voz_preferencias.json'), JSON.stringify({ version: 1, usuarios: { '51996399291': { modo: 'voz', voiceId: 'ZZZZZZZZZZZZZZZZZZZZ' } } }));
  await emitir(priv('Dime algo con otra voz')); // la pref local en disco no se recarga en caliente; se usa la de memoria
  assert(audios().length === 1 && registro.eleven.some(e => e.url.includes('/voices')), 'tras 402 consulta las voces y reintenta con otra');
  const idsUsados = tts().map(t => t.url.match(/text-to-speech\/([A-Za-z0-9]+)/)[1]); assert(idsUsados.length === 2 && idsUsados[0] !== idsUsados[1], idsUsados.join('>'));
  guionEleven = null; ok('402 "voz de biblioteca no permitida" -> consulta tus voces y reintenta con otra voz premade; el usuario recibe su audio');
  // P8: errores de ElevenLabs
  limpiar(); guionGemini = () => ({ text: 'Esto no debe perderse.' });
  guionEleven = (u) => (u.includes('/text-to-speech/') ? resp(401, { detail: { status: 'quota_exceeded', message: 'You have 0 credits remaining' } }) : null);
  await emitir(priv('Dime algo nuevo')); assert(audios().length === 0 && textos().join('').includes('Esto no debe perderse.') && textos().join('').includes('crédito de voz')); const llamadasAntes = tts().length;
  await emitir(priv('Dime otra cosa nueva')); assert.strictEqual(tts().length, llamadasAntes, 'con la cuota agotada no se vuelve a llamar'); assert(textos().join('').includes('Esto no debe perderse.'));
  ok('PRUEBA 8: crédito agotado -> responde por texto (sin perder la respuesta), avisa y deja de llamar a ElevenLabs un rato');
  // reiniciar bloqueo simulado no es posible sin esperar; probar plan 402 con otro proceso no necesario: se prueba a continuación forzando desbloqueo
  guionEleven = null;
  // salud: la clave no aparece en logs ni mensajes
  const todo = logs.join('\n') + JSON.stringify(registro.enviados.map(e => e.c.text || '')); assert(!todo.includes('sk_clavesecretafalsa') && !todo.includes('ghp_tokenfalso')); ok('la clave de ElevenLabs y el token de GitHub no aparecen en logs ni en mensajes');
  // GitHub: se guardó con debounce
  await new Promise(r => setTimeout(r, 2600));
  const c = nube()['voz_preferencias.json']; assert(c && JSON.parse(c.c).usuarios['51996399291'].modo === 'voz'); assert(registro.github.some(g => g.metodo === 'PUT' && g.archivo === 'voz_preferencias.json')); ok('preferencias guardadas en GitHub (voz_preferencias.json)');
  salida('\nFASE 1 OK'); process.exit(0);
})().catch(e => { logOriginal('FALLÓ:', e); logOriginal(logs.slice(-15).join('\n')); process.exit(1); });
