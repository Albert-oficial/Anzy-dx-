'use strict';
// Voz humanizada con ElevenLabs para el chat privado del propietario.
// Este módulo no conoce a WhatsApp ni a index.js: recibe sus dependencias por parámetro (se puede probar aislado).
// La clave API SOLO se lee de la variable de entorno ELEVENLABS_API_KEY y nunca se imprime.

const { spawn } = require('child_process');
const crypto = require('crypto');

const API_BASE = 'https://api.elevenlabs.io/v1';
// Voz "Sarah" (premade): documentada en proyectos de terceros como accesible con claves del plan gratuito.
// Si tu cuenta no puede usarla, el bot busca otra voz premade femenina disponible o usa ELEVENLABS_VOICE_ID.
const VOZ_PREDETERMINADA = 'EXAVITQu4vr4xnSDxMaL';
const MODELO_PREDETERMINADO = 'eleven_multilingual_v2'; // 29 idiomas (incluye español), límite 10 000 caracteres por solicitud
const LIMITE_CARACTERES_MODELO = { eleven_multilingual_v2: 10000, eleven_flash_v2_5: 40000, eleven_turbo_v2_5: 40000, eleven_v4: 10000, eleven_v4_turbo: 5000 };
const MODELOS_CON_CODIGO_IDIOMA = new Set(['eleven_flash_v2_5', 'eleven_turbo_v2_5']); // solo estos aceptan language_code
const MODELOS_CON_CONTEXTO = new Set(['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5']);

function numeroEnv(nombre, defecto, min, max) {
  const n = parseFloat(process.env[nombre]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defecto;
}

// ── Texto → texto apto para hablar ──────────────────────────────────────────
function prepararTextoParaVoz(texto) {
  let t = String(texto == null ? '' : texto);
  t = t.replace(/```[\s\S]*?```/g, ' ');                       // bloques de código
  t = t.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');               // enlaces (no se pronuncian bien)
  t = t.replace(/@\d{6,}/g, ' ');                                // menciones numéricas de WhatsApp
  t = t.replace(/[*_~`#>|]+/g, '');                              // marcas de formato de WhatsApp/Markdown
  t = t.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, ''); // emojis
  t = t.replace(/^\s*[-•·]\s+/gm, '');                           // viñetas
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');                         // numeración de listas
  t = t.replace(/([:;,])\s*\n+\s*/g, '$1 ');                    // después de dos puntos/coma, sin punto extra
  t = t.replace(/\s*\n+\s*/g, '. ');                             // saltos de línea → pausa
  t = t.replace(/\.{4,}/g, '...').replace(/([.!?¿¡])\s*\.\s+/g, '$1 ');
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
  t = t.replace(/(^|\. )\.\s*/g, '$1');
  return t.trim();
}

// Parte el texto en oraciones completas (sin cortar palabras) y devuelve lo que cabe en el límite + el resto.
function recortarParaVoz(texto, maxCaracteres) {
  const limpio = String(texto || '').trim();
  if (limpio.length <= maxCaracteres) return { hablado: limpio, resto: '' };
  const oraciones = limpio.match(/[^.!?…]+[.!?…]+["')»]*\s*|[^.!?…]+$/g) || [limpio];
  let hablado = '';
  let i = 0;
  for (; i < oraciones.length; i++) {
    if ((hablado + oraciones[i]).length > maxCaracteres) break;
    hablado += oraciones[i];
  }
  if (!hablado) { // una sola oración enorme: se corta en el último espacio, nunca a mitad de palabra
    const corte = limpio.lastIndexOf(' ', maxCaracteres);
    hablado = limpio.slice(0, corte > 0 ? corte : maxCaracteres);
    return { hablado: hablado.trim(), resto: limpio.slice(hablado.length).trim() };
  }
  return { hablado: hablado.trim(), resto: oraciones.slice(i).join('').trim() };
}

// ── Instrucciones en lenguaje natural: cambiar entre texto y voz ────────────
// Devuelve 'voz', 'texto' o null (ambiguo / no es una instrucción → no se cambia nada).
const RE_PIDE_VOZ = [
  /\bquiero\s+(que\s+(me\s+)?(hables|respondas\s+(con\s+(tu\s+)?voz|hablando|por\s+(audio|voz))|contestes\s+(con\s+(tu\s+)?voz|hablando|por\s+audio)|mandes\s+(audios?|notas\s+de\s+voz))|escucharte|o[ií]rte|que\s+me\s+hables)/i,
  /\b(desde|a\s+partir\s+de)\s+(ahora|hoy|ya)\b[^.!?\n]{0,60}\b(h[aá]blame|hablame|con\s+tu\s+voz|por\s+audio|hablando|escucharte|escuchar\w*|audios?)/i,
  /\bya\s+no\s+me\s+escribas\b/i,
  /\b(res)?p[oó]ndeme\s+hablando\b|\bcont[eé]stame\s+hablando\b/i,
  /\b(activa|enciende|pon|usa)(me)?\s+(el\s+)?modo\s+(de\s+)?(voz|audio|habla)\b/i,
  /^\W*(h[aá]blame|quiero\s+escucharte|quiero\s+o[ií]rte)(\s+(a\s+partir\s+de\s+ahora|desde\s+ahora|siempre|por\s+favor))?\W*$/i,
  /\b(h[aá]blame|hablame)\s+(a\s+partir\s+de\s+ahora|desde\s+ahora|siempre)\b/i
];
const RE_PIDE_TEXTO = [
  /\bvuelve\s+a\s+escribir(me)?\b/i,
  /\bmejor\s+(vuelve\s+a\s+)?escr[ií]beme\b/i,
  /\bya\s+no\s+me\s+(mandes|env[ií]es|pases|hagas)\s+(m[aá]s\s+)?(audios?|notas\s+de\s+voz)\b/i,
  /\bprefiero\s+que\s+(me\s+)?(respondas|escribas|contestes)\s+(por\s+|con\s+)?(texto|escrito|escribiendo)\b/i,
  /\b(desactiva|apaga|quita|cancela)(me)?\s+(el\s+)?modo\s+(de\s+)?(voz|audio|habla)\b/i,
  /\b(solo|s[oó]lo)\s+(por\s+)?(texto|escrito)\b/i,
  /\bya\s+no\s+(quiero|necesito)\s+(escucharte|o[ií]rte|audios?)\b/i,
  /\bd[eé]jame\s+leer\b/i
];

function detectarCambioModoVoz(texto) {
  const t = String(texto || '').trim();
  if (!t || t.length > 300) return null;
  const esPregunta = /^[¿]|\?\s*$/.test(t);
  const explicito = /\b(quiero|desde\s+ahora|a\s+partir\s+de|ya\s+no|prefiero|vuelve|activa|desactiva|mejor)\b/i.test(t);
  if (esPregunta && !explicito) return null;                       // "¿tienes modo de voz?" no cambia nada
  const voz = RE_PIDE_VOZ.some(r => r.test(t));
  const texto_ = RE_PIDE_TEXTO.some(r => r.test(t));
  if (voz && texto_) return null;                                  // contradictorio → ambiguo
  if (voz) return 'voz';
  if (texto_) return 'texto';
  return null;
}

// ¿Vale la pena preguntarle a la IA? (el mensaje habla de voz/audio/escribir pero ninguna regla lo reconoció)
function podriaSerInstruccionDeModo(texto) {
  const t = String(texto || '');
  if (t.length > 220) return false;
  const palabrasDeVoz = /\b(voz|audios?|habl\w*|h[aá]bl\w*|escuch\w*|o[ií]r\w*|oy[eé]\w*|notas?\s+de\s+voz)\b/i.test(t);
  const palabrasDeTexto = /\b(leer\w*|le[ií]d\w*|escr[ií]b\w*|escrit\w*|texto)\b/i.test(t);
  const sabor = /\b(de\s+ahora\s+en\s+adelante|desde\s+ahora|a\s+partir\s+de|ya\s+no|siempre|mejor|prefiero|quiero|pereza|cansad\w*|ocupad\w*|manejando|conduciendo|por\s+favor)\b/i.test(t);
  return palabrasDeVoz || (palabrasDeTexto && sabor);
}

// ── Cliente de ElevenLabs ───────────────────────────────────────────────────
function crearErrorElevenLabs(res, cuerpo) {
  let detalle = {};
  try { detalle = JSON.parse(cuerpo).detail || {}; } catch { /* no era JSON */ }
  const codigo = (typeof detalle === 'object' && (detalle.status || detalle.code)) || '';
  const mensaje = typeof detalle === 'string' ? detalle : (detalle.message || '');
  const e = new Error(`ElevenLabs respondió ${res.status}${codigo ? ` (${codigo})` : ''}: ${String(mensaje).slice(0, 160)}`);
  e.status = res.status;
  e.codigoApi = String(codigo);
  if (res.status === 402 || /paid_plan_required|payment_required/i.test(e.codigoApi + mensaje)) e.categoriaVoz = 'plan';
  else if (/quota_exceeded|insufficient|credits?/i.test(e.codigoApi + mensaje) || (res.status === 401 && /quota/i.test(mensaje))) e.categoriaVoz = 'cuota';
  else if (res.status === 401 || res.status === 403) e.categoriaVoz = 'autenticacion';
  else if (res.status === 404) e.categoriaVoz = 'voz_no_encontrada';
  else if (res.status === 422 || res.status === 400) e.categoriaVoz = 'solicitud';
  else if (res.status === 429) e.categoriaVoz = 'limite_ritmo';
  else if (res.status >= 500) e.categoriaVoz = 'servidor';
  else e.categoriaVoz = 'desconocido';
  return e;
}

function crearClienteElevenLabs({ fetchFn = globalThis.fetch, log = () => {} } = {}) {
  const apiKey = () => (process.env.ELEVENLABS_API_KEY || '').replace(/[^\x21-\x7E]/g, '');
  const modelo = () => (process.env.ELEVENLABS_MODEL_ID || MODELO_PREDETERMINADO).trim();
  const ajustes = () => ({
    stability: numeroEnv('ELEVENLABS_STABILITY', 0.45, 0, 1),
    similarity_boost: numeroEnv('ELEVENLABS_SIMILARITY', 0.75, 0, 1),
    style: numeroEnv('ELEVENLABS_STYLE', 0.2, 0, 1),
    speed: numeroEnv('ELEVENLABS_SPEED', 1.0, 0.7, 1.2),
    use_speaker_boost: true
  });
  const timeoutMs = () => numeroEnv('ELEVENLABS_TIMEOUT_MS', 45000, 5000, 120000);

  async function pedir(ruta, opciones = {}, tiempoMs) {
    const clave = apiKey();
    if (!clave) { const e = new Error('Falta la variable ELEVENLABS_API_KEY'); e.categoriaVoz = 'sin_clave'; throw e; }
    const ctrl = new AbortController();
    const temporizador = setTimeout(() => ctrl.abort(), tiempoMs || timeoutMs());
    try {
      const res = await fetchFn(`${API_BASE}${ruta}`, { ...opciones, headers: { 'xi-api-key': clave, ...(opciones.headers || {}) }, signal: ctrl.signal });
      return res;
    } catch (err) {
      if (err && err.name === 'AbortError') { const e = new Error('ElevenLabs tardó demasiado en responder'); e.categoriaVoz = 'timeout'; throw e; }
      const e = new Error(`No se pudo conectar con ElevenLabs: ${String(err && err.message).replace(clave, '[oculto]').slice(0, 120)}`); e.categoriaVoz = 'red'; throw e;
    } finally { clearTimeout(temporizador); }
  }

  // Genera UN audio completo (mp3) para el texto. Espera a que termine, valida y solo reintenta ante fallos temporales (1 vez).
  async function sintetizar(texto, { voiceId } = {}) {
    const voz = (voiceId || process.env.ELEVENLABS_VOICE_ID || VOZ_PREDETERMINADA).trim();
    if (!/^[A-Za-z0-9]{10,40}$/.test(voz)) { const e = new Error('ELEVENLABS_VOICE_ID tiene un formato inválido'); e.categoriaVoz = 'voz_no_encontrada'; throw e; }
    const m = modelo();
    const limite = LIMITE_CARACTERES_MODELO[m] || 5000;
    if (!texto || texto.length > limite) { const e = new Error(`Texto vacío o más largo que el límite del modelo (${limite})`); e.categoriaVoz = 'solicitud'; throw e; }
    const cuerpo = { text: texto, model_id: m, voice_settings: ajustes() };
    if (MODELOS_CON_CODIGO_IDIOMA.has(m)) cuerpo.language_code = 'es';
    const intentar = async () => {
      const res = await pedir(`/text-to-speech/${voz}?output_format=mp3_44100_128`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, body: JSON.stringify(cuerpo) });
      if (!res.ok) throw crearErrorElevenLabs(res, await res.text().catch(() => ''));
      const tipo = (res.headers.get('content-type') || '').toLowerCase();
      if (!/audio|octet-stream/.test(tipo)) { const e = new Error(`ElevenLabs devolvió un tipo inesperado (${tipo || 'sin tipo'})`); e.categoriaVoz = 'respuesta_invalida'; throw e; }
      const buffer = Buffer.from(await res.arrayBuffer());       // se espera la respuesta COMPLETA
      const declarado = parseInt(res.headers.get('content-length') || '0', 10);
      if (declarado && buffer.length < declarado) { const e = new Error('Audio incompleto (menos bytes de los anunciados)'); e.categoriaVoz = 'respuesta_invalida'; throw e; }
      if (!esMp3Valido(buffer)) { const e = new Error('ElevenLabs devolvió un audio vacío o dañado'); e.categoriaVoz = 'respuesta_invalida'; throw e; }
      return buffer;
    };
    try { return await intentar(); }
    catch (err) {
      if (['servidor', 'red', 'limite_ritmo', 'respuesta_invalida'].includes(err.categoriaVoz)) {
        log(`reintento único tras fallo temporal (${err.categoriaVoz})`);
        await new Promise(r => setTimeout(r, 1500));
        return await intentar();                                  // un solo reintento; si falla, se propaga
      }
      throw err;
    }
  }

  async function listarVoces() {
    const res = await pedir('/voices', { method: 'GET' }, 20000);
    if (!res.ok) throw crearErrorElevenLabs(res, await res.text().catch(() => ''));
    const datos = await res.json();
    return (datos.voices || []).map(v => ({
      id: v.voice_id, nombre: v.name, categoria: v.category || '', genero: (v.labels && v.labels.gender) || '', edad: (v.labels && v.labels.age) || '',
      acento: (v.labels && v.labels.accent) || '', uso: (v.labels && (v.labels.use_case || v.labels.usecase)) || '',
      espanol: Array.isArray(v.verified_languages) && v.verified_languages.some(l => (l.language || '').toLowerCase() === 'es' || /^es/i.test(l.locale || ''))
    }));
  }

  async function suscripcion() {
    const res = await pedir('/user/subscription', { method: 'GET' }, 15000);
    if (!res.ok) throw crearErrorElevenLabs(res, await res.text().catch(() => ''));
    const d = await res.json();
    return { usados: d.character_count, limite: d.character_limit, plan: d.tier, reinicio: d.next_character_count_reset_unix };
  }

  return { configurado: () => !!apiKey(), modelo, sintetizar, listarVoces, suscripcion };
}

function esMp3Valido(b) {
  if (!Buffer.isBuffer(b) || b.length < 2000) return false;
  const id3 = b.subarray(0, 3).toString('latin1') === 'ID3';
  const sync = b[0] === 0xFF && (b[1] & 0xE0) === 0xE0;
  return id3 || sync;
}

// ── Conversión REAL a nota de voz de WhatsApp (Ogg/Opus) con ffmpeg, en memoria (sin archivos temporales) ─────────
function convertirMp3AOpus(mp3, rutaFfmpeg = 'ffmpeg', timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '40k', '-vbr', 'on', '-application', 'voip', '-f', 'ogg', 'pipe:1'];
    let proc;
    try { proc = spawn(rutaFfmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (err) { const e = new Error(`No se pudo ejecutar ffmpeg: ${err.message}`); e.categoriaVoz = 'ffmpeg'; return reject(e); }
    const salida = []; let tam = 0; let errTexto = ''; let terminado = false;
    const fin = (err, valor) => { if (terminado) return; terminado = true; clearTimeout(temporizador); err ? reject(err) : resolve(valor); };
    const temporizador = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ya terminó */ } const e = new Error('ffmpeg tardó demasiado en convertir el audio'); e.categoriaVoz = 'ffmpeg'; fin(e); }, timeoutMs);
    proc.on('error', (err) => { const e = new Error(`ffmpeg no disponible: ${err.message}`); e.categoriaVoz = 'ffmpeg'; fin(e); });
    proc.stdout.on('data', (c) => { salida.push(c); tam += c.length; });
    proc.stderr.on('data', (c) => { if (errTexto.length < 500) errTexto += c.toString(); });
    proc.stdin.on('error', () => { /* EPIPE si ffmpeg falla antes: se reporta en 'close' */ });
    proc.on('close', (codigo) => {
      const buffer = Buffer.concat(salida, tam);
      if (codigo !== 0 || buffer.length < 1000 || buffer.subarray(0, 4).toString('latin1') !== 'OggS') {
        const e = new Error(`ffmpeg no produjo un Ogg/Opus válido (código ${codigo}): ${errTexto.trim().slice(0, 160)}`); e.categoriaVoz = 'ffmpeg'; return fin(e);
      }
      fin(null, buffer);
    });
    proc.stdin.end(mp3);
  });
}

// ── Utilidades de concurrencia y caché ──────────────────────────────────────
// Ejecuta tareas de la MISMA clave una tras otra (evita mezclar audios del mismo chat).
function crearColaPorClave() {
  const colas = new Map();
  return (clave, tarea) => {
    const previa = colas.get(clave) || Promise.resolve();
    const actual = previa.catch(() => {}).then(tarea);
    colas.set(clave, actual);
    actual.finally(() => { if (colas.get(clave) === actual) colas.delete(clave); }).catch(() => {});
    return actual;
  };
}

function crearCacheAudio(maxEntradas = 20, maxBytes = 12 * 1024 * 1024) {
  const mapa = new Map(); let bytes = 0;
  const clave = (...partes) => crypto.createHash('sha256').update(partes.join('\u0001')).digest('hex');
  return {
    clave,
    get(k) { const v = mapa.get(k); if (!v) return null; mapa.delete(k); mapa.set(k, v); return v; },
    set(k, valor) {
      if (valor.length > maxBytes / 2) return;
      if (mapa.has(k)) { bytes -= mapa.get(k).length; mapa.delete(k); }
      mapa.set(k, valor); bytes += valor.length;
      while ((mapa.size > maxEntradas || bytes > maxBytes) && mapa.size) { const primera = mapa.keys().next().value; bytes -= mapa.get(primera).length; mapa.delete(primera); }
    }
  };
}

module.exports = {
  VOZ_PREDETERMINADA, MODELO_PREDETERMINADO, prepararTextoParaVoz, recortarParaVoz, detectarCambioModoVoz, podriaSerInstruccionDeModo,
  crearClienteElevenLabs, convertirMp3AOpus, esMp3Valido, crearColaPorClave, crearCacheAudio
};
