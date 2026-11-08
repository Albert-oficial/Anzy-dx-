const assert = require('assert');
const { execFileSync } = require('child_process');
const V = require('../lib/voz');
(async () => {
  let n = 0; const ok = (m) => { n++; console.log('  ✔', m); };
  // 1. preparación de texto
  const t = V.prepararTextoParaVoz('¡Hola! 😊 *Mira* este enlace https://ejemplo.com/x?a=1 y _esto_:\n- uno\n- dos\n1. tres\n```code```\nFin...');
  assert(!/[*_😊]|https|```|^-/.test(t), t); assert(/Hola/.test(t) && /uno/.test(t) && /Fin/.test(t)); ok('texto preparado: ' + JSON.stringify(t));
  // 2. recorte por oraciones
  const largo = 'Primera frase corta. '.repeat(10) + 'Esta es otra oración bastante más larga que las anteriores, para probar. ';
  const r = V.recortarParaVoz(largo, 100);
  assert(r.hablado.length <= 100 && /[.]$/.test(r.hablado) && r.resto.length > 0 && (r.hablado + ' ' + r.resto).replace(/\s+/g, ' ').trim() === largo.replace(/\s+/g, ' ').trim()); ok('recorte en oración completa, sin perder texto');
  const una = V.recortarParaVoz('palabra '.repeat(40), 50); assert(una.hablado.length <= 50 && !/palab$/.test(una.hablado) && una.hablado.endsWith('palabra')); ok('una oración enorme se corta en espacio, no a mitad de palabra');
  assert.deepStrictEqual(V.recortarParaVoz('Hola.', 100), { hablado: 'Hola.', resto: '' });
  // 3. instrucciones naturales
  const voz = ['Quiero que desde ahora me hables con tu voz', 'Ya no me escribas, respóndeme hablando', 'Activa el modo de voz', 'Quiero escucharte', 'Háblame a partir de ahora', 'Desde ahora quiero escucharte, no leer tus respuestas'];
  const txt = ['Vuelve a escribirme', 'Ya no me mandes audios', 'Prefiero que me respondas por texto', 'Desactiva el modo de voz', 'Mejor vuelve a escribirme, estoy ocupado'];
  const nada = ['Hola, ¿cómo estás?', '¿Tienes modo de voz?', 'Mi abuela tenía una voz hermosa', 'Escribe un poema sobre la voz del mar', 'No me gusta mi voz en los audios', 'quiero escuchar música', '¿Puedes hablarme en inglés?', 'Activa el modo de voz y vuelve a escribirme'];
  voz.forEach(x => assert.strictEqual(V.detectarCambioModoVoz(x), 'voz', x)); txt.forEach(x => assert.strictEqual(V.detectarCambioModoVoz(x), 'texto', x)); nada.forEach(x => assert.strictEqual(V.detectarCambioModoVoz(x), null, x));
  ok(`instrucciones naturales: ${voz.length} a voz, ${txt.length} a texto, ${nada.length} ambiguas/sin cambio`);
  assert(V.podriaSerInstruccionDeModo('Oye, me da pereza leer; ¿podrías contarme todo oyéndote de ahora en adelante?') && V.podriaSerInstruccionDeModo('Mi abuela tenía una voz hermosa') && !V.podriaSerInstruccionDeModo('Ayúdame a escribir un correo') && !V.podriaSerInstruccionDeModo('Hola, ¿cómo estás?')); ok('pre-filtro para consultar a la IA: frases con sabor de instrucción sí; charla normal no');
  // 4. conversión REAL mp3 -> ogg/opus
  const mp3 = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1 << 24 });
  assert(V.esMp3Valido(mp3)); assert(!V.esMp3Valido(Buffer.alloc(5000))); assert(!V.esMp3Valido(Buffer.from('hola')));
  const ogg = await V.convertirMp3AOpus(mp3);
  require('fs').writeFileSync('/tmp/prueba_voz.ogg', ogg);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '/tmp/prueba_voz.ogg']).toString());
  assert.strictEqual(info.streams[0].codec_name, 'opus'); assert(Math.abs(parseFloat(info.format.duration) - 3) < 0.3, info.format.duration); assert.strictEqual(info.format.format_name, 'ogg');
  ok(`conversión real a Ogg/Opus (${ogg.length} bytes, ${parseFloat(info.format.duration).toFixed(2)} s, ${info.streams[0].sample_rate} Hz, ${info.streams[0].channels} canal)`);
  await assert.rejects(V.convertirMp3AOpus(Buffer.from('esto no es audio '.repeat(200))), /ffmpeg/); ok('audio dañado -> error controlado');
  await assert.rejects(V.convertirMp3AOpus(mp3, '/ruta/que/no/existe/ffmpeg'), /ffmpeg/); ok('ffmpeg ausente -> error controlado');
  // 5. cliente ElevenLabs con respuestas simuladas
  process.env.ELEVENLABS_API_KEY = 'clave-secreta-falsa-123'; delete process.env.ELEVENLABS_VOICE_ID;
  const llamadas = []; let guion = [];
  const resp = (status, cuerpo, tipo = 'application/json', extra = {}) => ({ ok: status < 300, status, headers: { get: (h) => ({ 'content-type': tipo, ...extra }[h.toLowerCase()] ?? null) }, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)), json: async () => cuerpo, arrayBuffer: async () => (Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(String(cuerpo))) });
  const fetchFalso = async (url, o) => { llamadas.push({ url, o }); const f = guion.shift(); if (!f) throw new Error('sin guion'); return typeof f === 'function' ? f() : f; };
  const c = V.crearClienteElevenLabs({ fetchFn: fetchFalso });
  assert(c.configurado());
  guion = [resp(200, mp3, 'audio/mpeg')];
  const salida = await c.sintetizar('Hola, ¿cómo estás?');
  assert(salida.equals(mp3)); const l = llamadas[0]; const cuerpo = JSON.parse(l.o.body);
  assert(l.url.includes('/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=mp3_44100_128') && l.o.headers['xi-api-key'] === 'clave-secreta-falsa-123' && cuerpo.model_id === 'eleven_multilingual_v2' && !('language_code' in cuerpo) && cuerpo.voice_settings.stability === 0.45);
  ok('petición correcta: endpoint, cabecera de clave, modelo por defecto, sin language_code en multilingual_v2');
  process.env.ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5'; process.env.ELEVENLABS_VOICE_ID = 'ABCDEFGHIJ1234567890';
  guion = [resp(200, mp3, 'audio/mpeg')]; await c.sintetizar('Hola'); assert.strictEqual(JSON.parse(llamadas.at(-1).o.body).language_code, 'es'); assert(llamadas.at(-1).url.includes('ABCDEFGHIJ1234567890')); ok('con flash_v2_5 envía language_code=es y usa ELEVENLABS_VOICE_ID');
  delete process.env.ELEVENLABS_MODEL_ID; delete process.env.ELEVENLABS_VOICE_ID;
  // errores
  const prueba = async (g, esperado) => { guion = g; llamadas.length = 0; try { await c.sintetizar('Hola'); assert.fail('debió fallar'); } catch (e) { assert.strictEqual(e.categoriaVoz, esperado, `${e.message} -> ${e.categoriaVoz}`); assert(!e.message.includes('clave-secreta-falsa')); } return llamadas.length; };
  assert.strictEqual(await prueba([resp(402, { detail: { status: 'payment_required', code: 'paid_plan_required', message: 'Free users cannot use library voices via the API.' } })], 'plan'), 1);
  assert.strictEqual(await prueba([resp(401, { detail: { status: 'quota_exceeded', message: 'You have 5 credits remaining' } })], 'cuota'), 1);
  assert.strictEqual(await prueba([resp(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })], 'autenticacion'), 1);
  assert.strictEqual(await prueba([resp(404, { detail: { status: 'voice_not_found', message: 'x' } })], 'voz_no_encontrada'), 1);
  assert.strictEqual(await prueba([resp(500, 'boom'), resp(503, 'boom')], 'servidor'), 2);
  assert.strictEqual(await prueba([resp(200, '<html>', 'text/html'), resp(200, '<html>', 'text/html')], 'respuesta_invalida'), 2);
  assert.strictEqual(await prueba([resp(200, Buffer.alloc(100), 'audio/mpeg'), resp(200, Buffer.alloc(100), 'audio/mpeg')], 'respuesta_invalida'), 2);
  assert.strictEqual(await prueba([resp(200, mp3.subarray(0, 3000), 'audio/mpeg', { 'content-length': String(mp3.length) }), resp(200, mp3.subarray(0, 3000), 'audio/mpeg', { 'content-length': String(mp3.length) })], 'respuesta_invalida'), 2);
  ok('errores: 402 plan, cuota, clave inválida, voz inexistente, 5xx (1 reintento), tipo inesperado, audio vacío/incompleto (1 reintento) — sin filtrar la clave');
  guion = [resp(500, 'boom'), resp(200, mp3, 'audio/mpeg')]; llamadas.length = 0; assert((await c.sintetizar('Hola')).equals(mp3) && llamadas.length === 2); ok('un fallo temporal y luego éxito -> 2 llamadas');
  delete process.env.ELEVENLABS_API_KEY; assert(!c.configurado()); await assert.rejects(c.sintetizar('Hola'), (e) => e.categoriaVoz === 'sin_clave'); process.env.ELEVENLABS_API_KEY = 'clave-secreta-falsa-123'; ok('sin ELEVENLABS_API_KEY -> error claro, sin llamar a la red');
  // listarVoces
  guion = [resp(200, { voices: [{ voice_id: 'v1', name: 'Sarah', category: 'premade', labels: { gender: 'female', accent: 'american', age: 'young' }, verified_languages: [{ language: 'es' }] }, { voice_id: 'v2', name: 'Roger', labels: { gender: 'male' } }] })];
  const vs = await c.listarVoces(); assert.strictEqual(vs.length, 2); assert(vs[0].espanol && vs[0].genero === 'female' && !vs[1].espanol); ok('listarVoces interpreta nombre, id, género y español verificado');
  // 6. cola y caché
  const cola = V.crearColaPorClave(); const orden = [];
  await Promise.all([cola('a', async () => { await new Promise(r => setTimeout(r, 60)); orden.push(1); }), cola('a', async () => { orden.push(2); }), cola('b', async () => { orden.push('b'); }), cola('a', async () => { throw new Error('x'); }).catch(() => orden.push('err')), cola('a', async () => { orden.push(3); })]);
  assert.deepStrictEqual(orden.filter(x => typeof x === 'number'), [1, 2, 3]); assert(orden.indexOf('b') < orden.indexOf(1)); ok('cola por chat: mismo chat en orden (aunque una falle), chats distintos en paralelo');
  const ca = V.crearCacheAudio(2); const k = (x) => ca.clave('v', 'm', x); ca.set(k('a'), Buffer.from('1')); ca.set(k('b'), Buffer.from('2')); ca.set(k('c'), Buffer.from('3'));
  assert(!ca.get(k('a')) && ca.get(k('c'))); ok('caché LRU acotada');
  console.log(`\nvoz: ${n} grupos de comprobaciones OK`);
})().catch(e => { console.error('FALLÓ', e); process.exit(1); });
