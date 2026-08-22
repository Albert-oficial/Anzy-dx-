require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const pino = require('pino');

// ── UBICACIÓN DE yt-dlp / ffmpeg ──────────────────────────────
const CARPETA_BIN = path.join(__dirname, 'bin');
const RUTA_YTDLP = fs.existsSync(path.join(CARPETA_BIN, 'yt-dlp'))
  ? path.join(CARPETA_BIN, 'yt-dlp')
  : 'yt-dlp';
const HAY_FFMPEG_LOCAL = fs.existsSync(path.join(CARPETA_BIN, 'ffmpeg'));
const ARGS_FFMPEG = HAY_FFMPEG_LOCAL ? `--ffmpeg-location "${CARPETA_BIN}"` : '';

function verificarBinarioYtDlp() {
  return new Promise((resolve) => {
    exec(`"${RUTA_YTDLP}" --version`, { timeout: 15000 }, (err, stdout) => {
      if (err) {
        console.log('❌ ALERTA: el binario de yt-dlp no funciona. Detalle:', err.message);
        return resolve(false);
      }
      console.log(`✅ yt-dlp funcionando correctamente, versión: ${String(stdout).trim()}`);
      resolve(true);
    });
  });
}

async function actualizarSistema() {
  console.log('🔄 Buscando actualizaciones de yt-dlp (canal nightly)...');
  return new Promise((resolve) => {
    exec(`"${RUTA_YTDLP}" --update-to nightly`, (err) => {
      if (!err) { console.log('✅ yt-dlp actualizado al último nightly'); return resolve(); }
      exec('pip install --upgrade --pre --break-system-packages yt-dlp', (err2) => {
        if (err2) console.log('⚠️ No se pudo actualizar yt-dlp automáticamente:', err2.message);
        else console.log('✅ yt-dlp actualizado vía pip (pre-release)');
        resolve();
      });
    });
  });
}

function limpiarArchivosTemporalesViejos() {
  try {
    const archivos = fs.readdirSync(__dirname);
    let borrados = 0;
    for (const archivo of archivos) {
      if (/^temp_tiktok_/.test(archivo)) {
        try { fs.unlinkSync(path.join(__dirname, archivo)); borrados++; } catch {}
      }
    }
    if (borrados > 0) console.log(`🧹 Se limpiaron ${borrados} archivo(s) temporal(es).`);
  } catch (err) {
    console.log('⚠️ No se pudo limpiar archivos temporales:', err.message);
  }
}

function ejecutarComando(cmd, opciones) {
  return new Promise((resolve, reject) => {
    exec(cmd, opciones, (err, stdout, stderr) => {
      if (err) {
        const detalle = (stderr || err.message || '').trim().split('\n').slice(-6).join('\n');
        return reject(new Error(detalle || err.message));
      }
      resolve(stdout);
    });
  });
}

// ── TIKTOK: video normal + fotos/slideshow con audio ────────────────────
const PATRON_COMANDO_TIKTOK = /^\/tik\s*tok\b/i;
const ENLACE_TIKTOK = /(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s]+/i;
const MAX_INTENTOS_TIKTOK = 3;

async function descargarVideoTiktokConYtDlp(url) {
  const idTemp = Date.now();
  for (let intento = 1; intento <= MAX_INTENTOS_TIKTOK; intento++) {
    const archivo = path.join(__dirname, `temp_tiktok_${idTemp}_${intento}.mp4`);
    try {
      console.log(`🔄 [TikTok/yt-dlp] Intento ${intento} de ${MAX_INTENTOS_TIKTOK}...`);
      const cmd = [
        `"${RUTA_YTDLP}"`, '-f', 'mp4/best', '--no-playlist',
        '--retries', '5', '--socket-timeout', '30', '--no-check-certificates',
        ARGS_FFMPEG, '-o', `"${archivo}"`, `"${url}"`
      ].filter(Boolean).join(' ');
      await ejecutarComando(cmd, { timeout: 120000 });
      if (!fs.existsSync(archivo) || fs.statSync(archivo).size <= 5000) {
        throw new Error('Archivo vacío o no descargado');
      }
      for (let i = 1; i < intento; i++) {
        const viejo = path.join(__dirname, `temp_tiktok_${idTemp}_${i}.mp4`);
        if (fs.existsSync(viejo)) fs.unlinkSync(viejo);
      }
      return archivo;
    } catch (err) {
      console.log(`❌ [TikTok/yt-dlp] Intento ${intento} falló: ${err.message.slice(0, 150)}`);
      if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
      if (intento < MAX_INTENTOS_TIKTOK) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('yt-dlp falló después de varios intentos');
}

// La API de yt-dlp casi nunca puede con publicaciones de fotos+audio (no son
// un "video" real), así que para slideshows vamos DIRECTO a la API tikwm.
function esProbablementeSlideshow(url) {
  return /\/photo\//i.test(url);
}

async function descargarVideoTiktokConAPI(url) {
  for (let intento = 1; intento <= MAX_INTENTOS_TIKTOK; intento++) {
    try {
      console.log(`🔄 [TikTok/API] Intento ${intento} de ${MAX_INTENTOS_TIKTOK}...`);
      const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error(`API respondió ${res.status}`);
      const data = await res.json();

      if (data?.code !== 0 || !data?.data) {
        throw new Error(data?.msg || 'La API no devolvió datos válidos');
      }

      if (Array.isArray(data.data.images) && data.data.images.length > 0) {
        let audioUrl = data.data.music || null;
        if (audioUrl && audioUrl.startsWith('/')) audioUrl = `https://www.tikwm.com${audioUrl}`;
        return { tipo: 'slideshow', imagenes: data.data.images, audio: audioUrl };
      }

      if (data.data.play) {
        const enlaceLimpio = data.data.play.startsWith('http')
          ? data.data.play
          : `https://www.tikwm.com${data.data.play}`;
        return { tipo: 'video_url', url: enlaceLimpio };
      }

      throw new Error('La API no devolvió ni video ni imágenes');
    } catch (err) {
      console.log(`❌ [TikTok/API] Intento ${intento} falló: ${err.message.slice(0, 80)}`);
      if (intento < MAX_INTENTOS_TIKTOK) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('La API de respaldo también falló');
}

async function descargarVideoTiktok(url) {
  // Si parece foto/slideshow, yt-dlp casi seguro va a fallar — ahorramos
  // tiempo yendo directo a la API en vez de esperar el timeout de yt-dlp.
  if (esProbablementeSlideshow(url)) {
    return await descargarVideoTiktokConAPI(url);
  }
  try {
    const archivo = await descargarVideoTiktokConYtDlp(url);
    return { tipo: 'archivo', ruta: archivo };
  } catch (err) {
    console.log('⚠️ yt-dlp no pudo con TikTok (puede ser un slideshow de fotos), probando con la API:', err.message);
    return await descargarVideoTiktokConAPI(url);
  }
}

// ── Envío del resultado de TikTok — compartido entre grupo y chat personal ──
async function enviarResultadoTiktok(sock, jidDestino, resultado) {
  const captionLimpio = '🎥 ¡Aquí está tu video! ✨';
  if (resultado.tipo === 'archivo') {
    await sock.sendMessage(jidDestino, { video: { url: resultado.ruta }, caption: captionLimpio });
    return;
  }
  if (resultado.tipo === 'video_url') {
    await sock.sendMessage(jidDestino, { video: { url: resultado.url }, caption: captionLimpio });
    return;
  }
  if (resultado.tipo === 'slideshow') {
    await sock.sendMessage(jidDestino, { text: `📸 Esto es una publicación de fotos — te mando ${resultado.imagenes.length} imagen(es) 💕` });
    let enviadas = 0;
    for (const imgUrl of resultado.imagenes.slice(0, 15)) {
      try {
        await sock.sendMessage(jidDestino, { image: { url: imgUrl } });
        enviadas++;
      } catch (err) {
        console.log('⚠️ No se pudo enviar una imagen del slideshow:', err.message);
      }
    }
    if (resultado.audio) {
      try {
        await sock.sendMessage(jidDestino, { audio: { url: resultado.audio }, mimetype: 'audio/mpeg' });
      } catch (err) {
        console.log('⚠️ No se pudo enviar el audio del slideshow:', err.message);
      }
    }
    if (enviadas === 0) {
      await sock.sendMessage(jidDestino, { text: '💔 No pude enviar ninguna de las imágenes, puede que el enlace haya vencido. Intenta de nuevo.' });
    }
  }
}

async function manejarComandoTiktok(sock, jidDestino, texto) {
  const enlace = texto.replace(PATRON_COMANDO_TIKTOK, '').trim();
  if (!ENLACE_TIKTOK.test(enlace)) {
    await sock.sendMessage(jidDestino, { text: '💕 Escríbelo así:\n/tiktok enlace-de-tiktok\n(también funciona /tik tok)' });
    return;
  }
  await sock.sendMessage(jidDestino, { text: '🎬 ¡Claro que sí! Dame un momentito 💖' });
  let rutaTemporal = null;
  try {
    const resultado = await descargarVideoTiktok(enlace);
    if (resultado.tipo === 'archivo') rutaTemporal = resultado.ruta;
    await enviarResultadoTiktok(sock, jidDestino, resultado);
    console.log('✅ TikTok enviado correctamente');
  } catch (err) {
    console.error('❌ Error descargando TikTok:', err.message);
    await sock.sendMessage(jidDestino, { text: '💔 No pude bajar ese contenido, intenta con otro enlace 🙏💖' });
  } finally {
    if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} }
  }
}
const CLAVE_IA_PRINCIPAL = process.env.CLAVE_IA_PRINCIPAL;
const CLAVE_IA_RESPALDO = process.env.CLAVE_IA_RESPALDO;
const CLAVE_IA_RESPALDO2 = process.env.CLAVE_IA_RESPALDO2;
const MODELO_PRINCIPAL = 'gemini-3.6-flash';
const MODELO_RESPALDO = 'gemini-3.6-flash';
const MODELO_RESPALDO2 = 'gemini-3.6-flash';
const CODIGO_DUEÑO = '2927760128';
const NOMBRE_BOT = 'Anzy';
const CREADOR = 'Albert Oficial';
const VERSION_BOT = '2.12.0';
const TU_NUMERO = '51996399291';
const JID_DUEÑO = `${TU_NUMERO}@s.whatsapp.net`;
const PUERTO = process.env.PORT || 3000;
const LIMITE_DIARIO_ESTIMADO = 1400;
const MAX_TOKENS_RESPUESTA = 1500;

const COMANDO_LLAMADA_IA = '/anzy';

if (!CLAVE_IA_PRINCIPAL) console.log('❌ ALERTA: no se detectó CLAVE_IA_PRINCIPAL.');
if (!CLAVE_IA_RESPALDO) console.log('⚠️ Aviso: no se detectó CLAVE_IA_RESPALDO.');
if (!CLAVE_IA_RESPALDO2) console.log('⚠️ Aviso: no se detectó CLAVE_IA_RESPALDO2.');

const TEXTO_AYUDA = `╔═══════════════════════╗
   COMANDOS · ${NOMBRE_BOT}
╚═══════════════════════╝

🧠 *Inteligencia Artificial*
• Mencióname, o escribe /anzy <pregunta>
• /anzy hot <pregunta> — un nivel de personalidad más atrevido y directo
• Responde/cita un mensaje y mencióname para que lo lea también

🎉 *Diversión y utilidades*
• /frase — frase random
• /tiktok <enlace> — video o foto/slideshow de TikTok sin marca de agua (también /tik tok, funciona en grupo y en privado) 🎬
• /perfil @usuario — actividad en el grupo

💕 *Modo Novia*
• /novia on — activo un modo más cariñoso y coqueto contigo
• /novia off — vuelvo a mi forma normal

👑 *Administración*
• /promover @usuario — lo hace admin
• /degradar @usuario — le quita admin
• /todos <mensaje> — etiqueta a todos
• /cerrar · /abrir — controla quién escribe
• /recordatorio <tiempo><S|M|H> <texto> — ej: /recordatorio 30M reunión
• /ranking — top de más activas del grupo
• /movimiento — últimos movimientos de admins 🗂️

📋 *Información*
• /info · /creador
• /comando anzy — ver esta lista

🗂️ *Memoria personal*
• /recordar — qué recuerda de ti
• /olvidarme — borra su memoria de ti`;

const TEXTO_AYUDA_PROPIETARIO = `${TEXTO_AYUDA}

👑 *Solo propietario* (funciona en grupo o en privado)
• /propietario — verificarte con contraseña
• /nombreff · /numeroff · /idff · /apodoff — registro paso a paso del clan
• /clan agregar Nombre; Número; ID FF; Apodo
• /clan ver <código o número> · /clan quitar <código o número>
• /eliminar <código de 2 cifras> — elimina a alguien del clan
• /integrantes — lista completa del clan con códigos
• /verificacion grupo <4 dígitos> — le da un código a este grupo (úsalo DENTRO del grupo)
• /acceder grupo <4 dígitos> — desde cualquier chat, vincula ese chat al clan de ese grupo
• /silencio @usuario — el bot deja de responderle por completo
• /activarse @usuario — el bot vuelve a responderle`;

const PALABRAS_CRISIS = [
  'quiero morir', 'no quiero vivir', 'suicidar', 'suicidio', 'matarme',
  'quitarme la vida', 'hacerme daño', 'autolesion', 'cortarme'
];
function esMensajeDeCrisis(texto) {
  const t = texto.toLowerCase();
  return PALABRAS_CRISIS.some(p => t.includes(p));
}

const PALABRAS_COMPRA = [
  'cuanto cuesta', 'cuánto cuesta', 'precio', 'precios', 'quiero comprar',
  'tienes stock', 'como pago', 'cómo pago', 'esta disponible', 'está disponible', 'vendes'
];
function esIntencionCompra(texto) {
  const t = texto.toLowerCase();
  return PALABRAS_COMPRA.some(p => t.includes(p));
}

process.on('unhandledRejection', (err) => console.log('⚠️ Promesa no manejada:', err?.message || err));
process.on('uncaughtException', (err) => console.log('⚠️ Excepción no capturada:', err?.message || err));

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
];

const REGLAS_IA_BASE = `
Eres ${NOMBRE_BOT}, una asistente virtual femenina, creada por ${CREADOR}. Hablas de ti misma en femenino, con un tono cálido, amable, cercano y dulce — pero SIEMPRE educado. Jamás eres grosera, cortante ni usas insultos, groserías o jerga como "causa", "pata", "brother" o similares.

CONTEXTO: estás respondiendo dentro de un grupo de WhatsApp, puede haber varias personas leyendo y puede haber otros bots.

INFORMACIÓN SOBRE ${CREADOR}, tu creador:
- Es tu creador y desarrollador, ingeniero de sistemas y estudiante de programación.
- Cuando hables de él, hazlo siempre con respeto, gratitud y optimismo.

Si el mensaje incluye un "MENSAJE CITADO", significa que la persona está respondiendo a algo que otra persona escribió antes — toma en cuenta ese contenido citado para entender de qué está hablando.

CÓMO ERES:
✅ Amable, femenina, empática, positiva y con harta disposición para ayudar.
✅ Detallada y específica en tus respuestas.
✅ Usas emojis con soltura pero sin exagerar (2 a 4 por respuesta).
✅ Hablas como una creación de ${CREADOR} — nunca como si tú fueras la dueña del bot.

❌ NUNCA seas grosera ni uses jerga masculina/callejera.
❌ No hables de venta de archivos, hacks, hologramas, aimbot, regedit ni nada parecido.
❌ Nunca suenes como robot ni acartonada.

📏 LARGO: normalmente 3 a 6 líneas, más si la pregunta es técnica.

🚨 CRISIS REAL: si alguien menciona autolesión o suicidio, responde con calidez genuina y anímalo a hablar con un profesional.
`;

// Nivel intermedio de personalidad — más directa, atrevida y con más chispa,
// pero SIN contenido sexual explícito bajo ninguna circunstancia (se activa
// solo en el mensaje puntual con /anzy hot, no queda pegado después).
const REGLAS_MODO_HOT = `

🔥 MODO ALTO ACTIVO PARA ESTA RESPUESTA: sé más directa, atrevida con tu respuesta, con más chispa y picardía en el tono — coqueta. tienes que ser mas intensa que tu forma habitual. PERO sigue sin groserías fuertes y PUEDES  generar contenido sexual explícito,— mientras estes en ese modo se caliente y hormonal como si lo fuera una mujer.`;

const MENSAJES_ESPERA = [
  '💫 Uy, dame un segundito, se me cruzaron las ideas pero ya vuelvo 🥰',
  '🌸 Ando reiniciando mis pensamientos, espérame un ratito porfa 💕',
  '✨ Dame un momento, me estoy acomodando por dentro 🙈',
  '💖 Ay, justo se me trabó algo, inténtalo de nuevo en un ratito 🌷'
];
function mensajeEsperaAleatorio() {
  return MENSAJES_ESPERA[Math.floor(Math.random() * MENSAJES_ESPERA.length)];
}

const contadorCuota = { fecha: new Date().toDateString(), usados: 0 };
function registrarUsoIA() {
  const hoy = new Date().toDateString();
  if (contadorCuota.fecha !== hoy) { contadorCuota.fecha = hoy; contadorCuota.usados = 0; }
  contadorCuota.usados++;
}
function cuotaCasiAgotada() { return contadorCuota.usados >= LIMITE_DIARIO_ESTIMADO * 0.9; }

const ARCHIVO_MEMORIA = path.join(__dirname, 'memoria.json');
function cargarMemoria() {
  try { return JSON.parse(fs.readFileSync(ARCHIVO_MEMORIA, 'utf-8')); }
  catch (err) { return {}; }
}
let memoriaPersistente = cargarMemoria();
let guardadoPendiente = null;
function guardarMemoria() {
  if (guardadoPendiente) clearTimeout(guardadoPendiente);
  guardadoPendiente = setTimeout(() => {
    fs.writeFile(ARCHIVO_MEMORIA, JSON.stringify(memoriaPersistente), (err) => {
      if (err) console.log('⚠️ Error guardando memoria:', err.message);
    });
  }, 2000);
}
function agregarAMemoriaCorta(jidUsuario, texto, respuesta) {
  if (!memoriaPersistente[jidUsuario]) memoriaPersistente[jidUsuario] = [];
  memoriaPersistente[jidUsuario].push({ texto, respuesta, fecha: new Date().toISOString() });
  if (memoriaPersistente[jidUsuario].length > 10) memoriaPersistente[jidUsuario].shift();
  guardarMemoria();
}
function obtenerContextoCorto(jidUsuario) {
  const lista = memoriaPersistente[jidUsuario] || [];
  if (lista.length === 0) return '';
  return '\n\nHISTORIAL RECIENTE con esta persona:\n' +
    lista.map(m => `Dijo: "${m.texto}"\nRespondiste: "${m.respuesta}"`).join('\n---\n');
}
function olvidarUsuario(jidUsuario) {
  delete memoriaPersistente[jidUsuario];
  guardarMemoria();
}
const contadorMensajesGrupo = new Map();
function registrarMensajeGrupo(jidGrupo, jidUsuario) {
  if (!contadorMensajesGrupo.has(jidGrupo)) contadorMensajesGrupo.set(jidGrupo, new Map());
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  mapa.set(jidUsuario, (mapa.get(jidUsuario) || 0) + 1);
}

const recordatoriosGrupo = [];
function programarRecordatorioGrupo(jidGrupo, milisegundos, texto) {
  recordatoriosGrupo.push({ jidGrupo, tiempoEjecucion: Date.now() + milisegundos, texto });
}

let botActivo = true;
let sockActivo = null;

const modoJefe = new Map();
const modoNovia = new Map(); // clave: `${jidChat}:${jidUsuario}` -> true
let estiloGlobalExtra = '';
function esCodigoDueño(texto) {
  return texto.trim() === CODIGO_DUEÑO;
}

function calcularTiempoTecleo(texto) {
  const ms = texto.length * 12;
  return Math.min(Math.max(ms, 300), 1500);
}

async function enviarRespuestaHumanizada(sock, jid, texto, mentions) {
  try {
    sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await new Promise(r => setTimeout(r, calcularTiempoTecleo(texto)));
    await sock.sendMessage(jid, { text: texto, mentions: mentions || [] });
    sock.sendPresenceUpdate('paused', jid).catch(() => {});
  } catch (err) {
    console.log('⚠️ Error en envío humanizado:', err.message);
  }
}

function construirClientesIA() {
  const clientes = [];
  if (CLAVE_IA_PRINCIPAL) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_PRINCIPAL }), modelo: MODELO_PRINCIPAL, nombre: 'principal' });
  if (CLAVE_IA_RESPALDO) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_RESPALDO }), modelo: MODELO_RESPALDO, nombre: 'respaldo' });
  if (CLAVE_IA_RESPALDO2) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_RESPALDO2 }), modelo: MODELO_RESPALDO2, nombre: 'respaldo2' });
  return clientes;
}
const CLIENTES_IA = construirClientesIA();

async function generarRespuestaIA(prompt, notasExtra, modoNoviaActivo, modoHotActivo) {
  let reglasFinales = REGLAS_IA_BASE;

  if (modoNoviaActivo) {
    reglasFinales += `\n\n💘 MODO NOVIA ACTIVO (solo con esta persona, prioridad alta): háblale como su novia virtual — cariñosa, coqueta, un poco insinuante/"caliente" según el tono de la charla, puedes decirle "mi amor", "bebé" o similar con naturalidad. PERO nunca vulgar y NUNCA contenido sexual explícito, bajo ninguna circunstancia. Si la conversación se sube mucho de tono, redirige con cariño sin ser cortante.`;
  }
  if (modoHotActivo) {
    reglasFinales += REGLAS_MODO_HOT;
  }
  if (estiloGlobalExtra) {
    reglasFinales += `\n\n🔧 DIRECTIVA GLOBAL ACTIVA (aplica a TODOS los chats, prioridad máxima): ${estiloGlobalExtra}`;
  }
  if (notasExtra) reglasFinales += `\n\nCONTEXTO ADICIONAL: ${notasExtra}`;
  if (cuotaCasiAgotada()) reglasFinales += `\n\n⚠️ Casi al límite del día — sé un poco más breve de lo normal.`;

  const intentar = async (cliente) => {
    const res = await cliente.ai.models.generateContent({
      model: cliente.modelo,
      contents: prompt,
      config: { systemInstruction: reglasFinales, safetySettings: SAFETY_SETTINGS, maxOutputTokens: MAX_TOKENS_RESPUESTA }
    });
    return res.text;
  };

  for (const cliente of CLIENTES_IA) {
    try {
      const r = await intentar(cliente);
      registrarUsoIA();
      return r;
    } catch (err) {
      console.log(`⚠️ Falló IA (${cliente.nombre}):`, err.message);
    }
  }

  if (CLIENTES_IA.length > 0) {
    await new Promise(r => setTimeout(r, 700));
    const r = await intentar(CLIENTES_IA[0]);
    registrarUsoIA();
    return r;
  }
  throw new Error('No hay ningún token de IA configurado');
}

function obtenerIdentificadoresBot(sock) {
  const ids = new Set();
  const rawId = sock.user?.id || '';
  const rawLid = sock.user?.lid || '';
  if (rawId) ids.add(rawId.split(':')[0].split('@')[0]);
  if (rawLid) ids.add(rawLid.split(':')[0].split('@')[0]);
  ids.add(TU_NUMERO);
  return [...ids].filter(Boolean);
}

function esMencionAlBot(msg, texto, identificadoresBot) {
  const mencionados = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const numerosMencionados = mencionados.map(j => j.split('@')[0]);
  if (numerosMencionados.some(n => identificadoresBot.includes(n))) return true;
  return identificadoresBot.some(id => texto.includes(`@${id}`));
}

// Devuelve { llamar: bool, hot: bool } — hot=true si el mensaje empieza con /anzy hot
function detectarLlamadaIA(texto, msg, identificadoresBot) {
  const t = texto.trim();
  if (/^\/anzy\s+hot\b/i.test(t)) return { llamar: true, hot: true };
  if (esMencionAlBot(msg, texto, identificadoresBot)) return { llamar: true, hot: false };
  const primeraPalabra = (t.split(/\s+/)[0] || '').toLowerCase();
  if (primeraPalabra === COMANDO_LLAMADA_IA) return { llamar: true, hot: false };
  return { llamar: false, hot: false };
}

function extraerTextoCitado(msg) {
  const citado = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!citado) return null;
  return citado.conversation || citado.extendedTextMessage?.text || null;
}

function normalizarParticipante(participanteRaw) {
  if (typeof participanteRaw === 'string') {
    return { jid: participanteRaw, numero: participanteRaw.split('@')[0] };
  }
  const jid = participanteRaw?.id || participanteRaw?.jid || participanteRaw?.phoneNumber || '';
  const numero = (participanteRaw?.phoneNumber || jid || '').split('@')[0];
  return { jid, numero };
}

function extraerNumero(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}

function esPropietario(jid) {
  if (!jid) return false;
  return extraerNumero(jid) === TU_NUMERO;
}
const propietariosVerificados = new Set();
const pendientesPropietario = new Map();
function esPropietarioEfectivo(jid) {
  if (!jid) return false;
  return esPropietario(jid) || propietariosVerificados.has(extraerNumero(jid));
}

function buscarConteoEnMapa(mapa, jid) {
  if (!mapa) return 0;
  if (mapa.has(jid)) return mapa.get(jid);
  const numero = extraerNumero(jid);
  for (const [clave, valor] of mapa.entries()) {
    if (extraerNumero(clave) === numero) return valor;
  }
  return 0;
}

const ARCHIVO_SILENCIADOS = path.join(__dirname, 'silenciados.json');
function cargarSilenciados() {
  try { return new Set(JSON.parse(fs.readFileSync(ARCHIVO_SILENCIADOS, 'utf-8'))); }
  catch (err) { return new Set(); }
}
let SILENCIADOS = cargarSilenciados();
let guardadoSilenciadosPendiente = null;
function guardarSilenciados() {
  if (guardadoSilenciadosPendiente) clearTimeout(guardadoSilenciadosPendiente);
  guardadoSilenciadosPendiente = setTimeout(() => {
    fs.writeFile(ARCHIVO_SILENCIADOS, JSON.stringify([...SILENCIADOS]), (err) => {
      if (err) console.log('⚠️ Error guardando silenciados:', err.message);
    });
  }, 1000);
}

const NUMEROS_IGNORADOS = (process.env.NUMEROS_IGNORADOS || '')
  .split(',').map(n => n.trim()).filter(Boolean);
function esNumeroIgnorado(jid) {
  const numero = extraerNumero(jid);
  return NUMEROS_IGNORADOS.includes(numero) || SILENCIADOS.has(numero);
}

const NOMBRES_CONOCIDOS = new Map();
function registrarNombreConocido(jid, pushName) {
  if (!pushName) return;
  NOMBRES_CONOCIDOS.set(extraerNumero(jid), pushName);
}
function obtenerNombreVisible(jid) {
  const numero = extraerNumero(jid);
  return NOMBRES_CONOCIDOS.get(numero) || `+${numero}`;
}

// ── VINCULACIÓN DE CLANES ENTRE GRUPOS ──────────────────────────────────────
const ARCHIVO_VINCULOS = path.join(__dirname, 'vinculos_clan.json');
function cargarVinculos() {
  try {
    const data = JSON.parse(fs.readFileSync(ARCHIVO_VINCULOS, 'utf-8'));
    return {
      codigos: data.codigos || {},
      codigoAGrupo: data.codigoAGrupo || {},
      vinculos: data.vinculos || {}
    };
  } catch (err) {
    return { codigos: {}, codigoAGrupo: {}, vinculos: {} };
  }
}
let ESTADO_VINCULOS = cargarVinculos();
let guardadoVinculosPendiente = null;
function guardarVinculos() {
  if (guardadoVinculosPendiente) clearTimeout(guardadoVinculosPendiente);
  guardadoVinculosPendiente = setTimeout(() => {
    fs.writeFile(ARCHIVO_VINCULOS, JSON.stringify(ESTADO_VINCULOS, null, 2), (err) => {
      if (err) console.log('⚠️ Error guardando vínculos de clan:', err.message);
    });
  }, 1000);
}

function claveVinculo(jidChatActual, jidUsuario) {
  return `${jidChatActual}:${extraerNumero(jidUsuario)}`;
}

function resolverGrupoClan(jidChatActual, jidUsuario) {
  return ESTADO_VINCULOS.vinculos[claveVinculo(jidChatActual, jidUsuario)] || jidChatActual;
}

async function comandoVerificarGrupo(sock, jidGrupo, jidUsuario, codigo) {
  if (!jidGrupo.endsWith('@g.us')) {
    await sock.sendMessage(jidGrupo, { text: 'Este comando solo se puede usar dentro de un grupo (el que quieres verificar).' });
    return;
  }
  if (!esPropietarioEfectivo(jidUsuario)) {
    await sock.sendMessage(jidGrupo, { text: 'Solo el propietario puede verificar un grupo 🚫' });
    return;
  }
  if (!codigo || !/^\d{4}$/.test(codigo)) {
    await sock.sendMessage(jidGrupo, { text: 'Uso: /verificacion grupo <código de 4 dígitos>\nEj: /verificacion grupo 2927' });
    return;
  }
  ESTADO_VINCULOS.codigos[jidGrupo] = codigo;
  ESTADO_VINCULOS.codigoAGrupo[codigo] = jidGrupo;
  guardarVinculos();
  await sock.sendMessage(jidGrupo, { text: `✅ Grupo verificado con el código ${codigo}.\n\nDesde cualquier chat (grupo o personal) puedes escribir:\n/acceder grupo ${codigo}\n\nY los comandos de clan de ese chat van a usar la lista de este grupo.` });
}

async function comandoAccederGrupo(sock, jidChatActual, jidUsuario, codigo) {
  if (!esPropietarioEfectivo(jidUsuario)) {
    await sock.sendMessage(jidChatActual, { text: 'Solo el propietario puede usar este comando 🚫' });
    return;
  }
  if (!codigo || !/^\d{4}$/.test(codigo)) {
    await sock.sendMessage(jidChatActual, { text: 'Uso: /acceder grupo <código de 4 dígitos>' });
    return;
  }
  const grupoObjetivo = ESTADO_VINCULOS.codigoAGrupo[codigo];
  if (!grupoObjetivo) {
    await sock.sendMessage(jidChatActual, { text: 'No encontré ningún grupo verificado con ese código.' });
    return;
  }
  ESTADO_VINCULOS.vinculos[claveVinculo(jidChatActual, jidUsuario)] = grupoObjetivo;
  guardarVinculos();
  let nombreGrupo = 'ese grupo';
  try { const meta = await sock.groupMetadata(grupoObjetivo); nombreGrupo = meta.subject || nombreGrupo; } catch (err) {}
  await sock.sendMessage(jidChatActual, { text: `🔗 Listo, este chat quedó vinculado al clan de *${nombreGrupo}*.\n\nAhora /integrantes, /clan, /eliminar, /nombreff, etc. van a usar esa lista, hasta que uses /acceder grupo con otro código.` });
}

// ── NUBE: GitHub como almacenamiento gratuito de integrantes ────────────────
function limpiarValorEnv(valor) {
  return (valor || '').replace(/[^\x20-\x7E]/g, '').trim();
}

const GITHUB_TOKEN = limpiarValorEnv(process.env.GITHUB_TOKEN);
const GITHUB_REPO = limpiarValorEnv(process.env.GITHUB_REPO);
const GITHUB_RUTA_ARCHIVO = limpiarValorEnv(process.env.GITHUB_RUTA_ARCHIVO) || 'integrantes.json';
const GITHUB_RAMA = limpiarValorEnv(process.env.GITHUB_RAMA) || 'main';
const GITHUB_API_BASE = 'https://api.github.com';

if (GITHUB_TOKEN) {
  console.log(`🔍 GITHUB_TOKEN detectado — longitud: ${GITHUB_TOKEN.length} caracteres`);
}

let githubShaActual = null;

async function githubLeerIntegrantes() {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_ARCHIVO)}?ref=${GITHUB_RAMA}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new Error(`No se pudo leer de GitHub (${res.status}): ${detalle}`);
  }
  const data = await res.json();
  githubShaActual = data.sha;
  const contenido = Buffer.from(data.content, 'base64').toString('utf-8');
  return JSON.parse(contenido);
}

async function githubGuardarIntegrantes(dataObjeto) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_ARCHIVO)}`;
  const contenidoBase64 = Buffer.from(JSON.stringify(dataObjeto, null, 2), 'utf-8').toString('base64');
  const body = { message: `Actualización automática de integrantes — ${new Date().toISOString()}`, content: contenidoBase64, branch: GITHUB_RAMA };
  if (githubShaActual) body.sha = githubShaActual;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new Error(`No se pudo guardar en GitHub (${res.status}): ${detalle}`);
  }
  const data = await res.json();
  githubShaActual = data.content.sha;
}

async function inicializarNubeIntegrantes() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('⚠️ GITHUB_TOKEN o GITHUB_REPO no configurados — los integrantes se pueden perder si Render reinicia el disco.');
    return;
  }
  try {
    const nube = await githubLeerIntegrantes();
    if (nube && typeof nube === 'object') {
      integrantesClan = nube;
      console.log('☁️ Integrantes cargados desde GitHub — persisten aunque el bot se reinicie.');
    } else {
      await githubGuardarIntegrantes(integrantesClan || {});
      console.log('🆕 No había archivo en GitHub, se creó uno nuevo con los datos actuales.');
    }
  } catch (err) {
    console.log('⚠️ No se pudo conectar con GitHub, sigo usando el respaldo local:', err.message);
  }
}const ARCHIVO_INTEGRANTES = path.join(__dirname, 'integrantes.json');
function cargarIntegrantes() {
  try { return JSON.parse(fs.readFileSync(ARCHIVO_INTEGRANTES, 'utf-8')); }
  catch (err) { return {}; }
}
let integrantesClan = cargarIntegrantes();
let guardadoIntegrantesPendiente = null;
function guardarIntegrantes() {
  if (guardadoIntegrantesPendiente) clearTimeout(guardadoIntegrantesPendiente);
  guardadoIntegrantesPendiente = setTimeout(async () => {
    fs.writeFile(ARCHIVO_INTEGRANTES, JSON.stringify(integrantesClan, null, 2), (err) => {
      if (err) console.log('⚠️ Error guardando integrantes localmente:', err.message);
    });
    if (GITHUB_TOKEN && GITHUB_REPO) {
      try { await githubGuardarIntegrantes(integrantesClan); }
      catch (err) { console.log('⚠️ Error guardando integrantes en GitHub:', err.message); }
    }
  }, 1500);
}

const ARCHIVO_MOVIMIENTOS = path.join(__dirname, 'movimientos.json');
const MAX_REGISTROS_MOVIMIENTOS = 300;
function cargarMovimientos() {
  try { return JSON.parse(fs.readFileSync(ARCHIVO_MOVIMIENTOS, 'utf-8')); }
  catch (err) { return []; }
}
let registroMovimientos = cargarMovimientos();
let guardadoMovimientosPendiente = null;
function guardarMovimientos() {
  if (guardadoMovimientosPendiente) clearTimeout(guardadoMovimientosPendiente);
  guardadoMovimientosPendiente = setTimeout(() => {
    fs.writeFile(ARCHIVO_MOVIMIENTOS, JSON.stringify(registroMovimientos), (err) => {
      if (err) console.log('⚠️ Error guardando movimientos:', err.message);
    });
  }, 1500);
}

const ETIQUETAS_MOVIMIENTO = {
  add:     { icono: '➕', texto: 'agregó al grupo a' },
  remove:  { icono: '🚫', texto: 'sacó del grupo a' },
  promote: { icono: '⭐', texto: 'hizo admin a' },
  demote:  { icono: '🔻', texto: 'quitó el admin a' },
  cerrar:  { icono: '🔒', texto: 'cerró el grupo' },
  abrir:   { icono: '🔓', texto: 'abrió el grupo' },
  salio:   { icono: '🚶', texto: 'salió del grupo' },
  se_unio: { icono: '🔗', texto: 'se unió por enlace de invitación' }
};

const ACCIONES_BOT_RECIENTES = new Set();
function marcarAccionBotReciente(jidGrupo, accion, jids) {
  jids.forEach(jid => {
    const clave = `${jidGrupo}:${accion}:${extraerNumero(jid)}`;
    ACCIONES_BOT_RECIENTES.add(clave);
    setTimeout(() => ACCIONES_BOT_RECIENTES.delete(clave), 10000);
  });
}
function accionFueDelBot(jidGrupo, accion, jid) {
  return ACCIONES_BOT_RECIENTES.has(`${jidGrupo}:${accion}:${extraerNumero(jid)}`);
}

function registrarAccionAdmin(sock, jidGrupo, accionOriginal, jidEjecutor, jidsObjetivo, nombreGrupoTexto) {
  let accion = accionOriginal;
  let objetivos = (jidsObjetivo || []).map(j => extraerNumero(j));
  const numeroEjecutor = jidEjecutor ? extraerNumero(jidEjecutor) : null;

  if (numeroEjecutor && objetivos.length === 1 && objetivos[0] === numeroEjecutor) {
    if (accion === 'remove') accion = 'salio';
    if (accion === 'add') accion = 'se_unio';
    objetivos = [];
  }

  const entrada = { accion, jidGrupo, nombreGrupo: nombreGrupoTexto || null, ejecutor: numeroEjecutor, objetivos, fecha: new Date().toISOString() };
  registroMovimientos.push(entrada);
  if (registroMovimientos.length > MAX_REGISTROS_MOVIMIENTOS) registroMovimientos.shift();
  guardarMovimientos();

  sock.sendMessage(JID_DUEÑO, { text: formatearMovimiento(jidGrupo, entrada) }).catch(() => {});
}

const FRASES_RANDOM = [
  'La constancia le gana al talento cuando el talento no es constante 💪',
  'Hoy es un buen día para no rendirte 🌸',
  'El que no arriesga, no gana nada bonito 🐟',
  'Mejor sola que mal acompañada, mejor acompañada que aburrida 💕'
];
function comandoFrase() { return FRASES_RANDOM[Math.floor(Math.random() * FRASES_RANDOM.length)]; }

async function comandoRanking(sock, jidGrupo) {
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  if (!mapa || mapa.size === 0) return { texto: 'Aún no hay suficiente actividad para armar un ranking 📊', mentions: [] };
  const ordenado = [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const mentions = ordenado.map(([jid]) => jid);
  const texto = '🏆 *Ranking de más activas:*\n' + ordenado.map(([jid, n], i) =>
    `${i + 1}. ${obtenerNombreVisible(jid)} — ${n} msjs`
  ).join('\n');
  return { texto, mentions };
}

async function esAdminGrupo(sock, jidGrupo, jidUsuario) {
  try {
    const metadata = await sock.groupMetadata(jidGrupo);
    const numeroObjetivo = extraerNumero(jidUsuario);
    const participante = metadata.participants.find(p => {
      if (p.id === jidUsuario) return true;
      const candidatos = [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean).map(extraerNumero);
      return candidatos.includes(numeroObjetivo);
    });
    return !!participante && (participante.admin === 'admin' || participante.admin === 'superadmin');
  } catch (err) {
    return false;
  }
}

async function tienePermisoClan(sock, jidGrupo, jidUsuario) {
  if (esPropietarioEfectivo(jidUsuario)) return true;
  return await esAdminGrupo(sock, jidGrupo, jidUsuario);
}

async function comandoPerfil(sock, jidGrupo, jidUsuario, mencionJid) {
  const jidObjetivo = mencionJid || jidUsuario;
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  const mensajes = buscarConteoEnMapa(mapa, jidObjetivo);
  const esAdmin = await esAdminGrupo(sock, jidGrupo, jidObjetivo);
  const texto = `👤 *Perfil de ${obtenerNombreVisible(jidObjetivo)}*\n📨 Mensajes en el grupo: ${mensajes}\n👑 Admin: ${esAdmin ? 'Sí' : 'No'}`;
  await sock.sendMessage(jidGrupo, { text, mentions: [jidObjetivo] });
}

function generarCodigoUnico(jidGrupo) {
  const lista = integrantesClan[jidGrupo] || [];
  const usados = new Set(lista.map(i => i.codigo).filter(Boolean));
  let codigo;
  do {
    codigo = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  } while (usados.has(codigo));
  return codigo;
}

function asegurarCodigosClan(jidGrupo) {
  const lista = integrantesClan[jidGrupo] || [];
  let cambiado = false;
  for (const ficha of lista) {
    if (!ficha.codigo) { ficha.codigo = generarCodigoUnico(jidGrupo); cambiado = true; }
  }
  if (cambiado) guardarIntegrantes();
}

function agregarIntegrante(jidGrupo, datos) {
  if (!integrantesClan[jidGrupo]) integrantesClan[jidGrupo] = [];
  const numeroLimpio = extraerNumero(datos.numero) || datos.numero;
  const existente = integrantesClan[jidGrupo].find(i =>
    (datos.idFF && i.idFF === datos.idFF) || extraerNumero(i.numero) === numeroLimpio
  );
  if (existente) {
    Object.assign(existente, datos, { fecha: existente.fecha, codigo: existente.codigo || generarCodigoUnico(jidGrupo) });
    guardarIntegrantes();
    return { actualizado: true, ficha: existente };
  }
  const ficha = { ...datos, codigo: generarCodigoUnico(jidGrupo), fecha: new Date().toISOString() };
  integrantesClan[jidGrupo].push(ficha);
  guardarIntegrantes();
  return { actualizado: false, ficha };
}

function quitarIntegrante(jidGrupo, criterio) {
  const lista = integrantesClan[jidGrupo] || [];
  const criterioLimpio = extraerNumero(criterio) || criterio;
  const criterioCodigo = String(criterio).trim().padStart(2, '0');
  const indice = lista.findIndex(i => i.idFF === criterio || extraerNumero(i.numero) === criterioLimpio || i.codigo === criterioCodigo);
  if (indice === -1) return false;
  lista.splice(indice, 1);
  guardarIntegrantes();
  return true;
}

function buscarIntegrante(jidGrupo, criterio) {
  asegurarCodigosClan(jidGrupo);
  const lista = integrantesClan[jidGrupo] || [];
  const criterioLimpio = extraerNumero(criterio) || criterio;
  const criterioCodigo = String(criterio).trim().padStart(2, '0');
  return lista.find(i => i.idFF === criterio || extraerNumero(i.numero) === criterioLimpio || i.codigo === criterioCodigo) || null;
}

function obtenerEtiquetaPersona(jidGrupo, criterio) {
  if (!criterio) return 'Desconocido';
  const numero = extraerNumero(criterio) || criterio;
  const ficha = buscarIntegrante(jidGrupo, numero);
  if (ficha) return ficha.apodo || ficha.nombre;
  const nombreCache = NOMBRES_CONOCIDOS.get(numero);
  if (nombreCache) return nombreCache;
  return 'Miembro del grupo';
}

function formatearFichaIntegrante(ficha) {
  return `┏━━━━━━━━━━━━━━━━━━━┓
┃   FICHA DE INTEGRANTE
┗━━━━━━━━━━━━━━━━━━━┛
👤 Nombre  : ${ficha.nombre}
📱 Número  : ${ficha.numero}
🆔 ID FF   : ${ficha.idFF}
🏷️ Apodo   : ${ficha.apodo}
🔑 Código  : ${ficha.codigo}`;
}

function generarTextoListaClan(jidGrupo) {
  asegurarCodigosClan(jidGrupo);
  const lista = integrantesClan[jidGrupo] || [];
  if (!lista.length) return '📋 Aún no hay integrantes registradas en el clan.';
  const cuerpo = lista.map(ficha => formatearFichaIntegrante(ficha)).join('\n\n');
  return `╔═══════════════════════╗\n   INTEGRANTES DEL CLAN (${lista.length})\n╚═══════════════════════╝\n\n${cuerpo}`;
}

async function comandoClanAgregar(sock, jidGrupo, jidUsuario, textoCompleto) {
  if (!(await tienePermisoClan(sock, jidGrupo, jidUsuario))) {
    await sock.sendMessage(jidGrupo, { text: 'Solo las admins o el propietario pueden registrar integrantes 🚫' });
    return;
  }
  const partes = textoCompleto.split(';').map(p => p.trim()).filter(Boolean);
  if (partes.length < 4) {
    await sock.sendMessage(jidGrupo, { text: 'Formato: /clan agregar Nombre; Número; ID FF; Apodo' });
    return;
  }
  const grupoDatos = resolverGrupoClan(jidGrupo, jidUsuario);
  const [nombre, numero, idFF, apodo] = partes;
  const { actualizado, ficha } = agregarIntegrante(grupoDatos, { nombre, numero, idFF, apodo, agregadoPor: jidUsuario.split('@')[0] });
  await sock.sendMessage(jidGrupo, { text: `${actualizado ? '✏️ Ficha actualizada' : '✅ Integrante registrada'}:\n\n${formatearFichaIntegrante(ficha)}` });
}

async function comandoClanQuitar(sock, jidGrupo, jidUsuario, criterio) {
  if (!(await tienePermisoClan(sock, jidGrupo, jidUsuario))) {
    await sock.sendMessage(jidGrupo, { text: 'Solo las admins o el propietario pueden quitar integrantes 🚫' });
    return;
  }
  if (!criterio) { await sock.sendMessage(jidGrupo, { text: 'Uso: /clan quitar <número, ID FF o código>' }); return; }
  const grupoDatos = resolverGrupoClan(jidGrupo, jidUsuario);
  const ok = quitarIntegrante(grupoDatos, criterio);
  await sock.sendMessage(jidGrupo, { text: ok ? '🗑️ Integrante eliminada de la lista.' : 'No encontré a nadie con ese dato.' });
}

async function comandoClanVer(sock, jidGrupo, jidUsuario, criterio) {
  if (!criterio) { await sock.sendMessage(jidGrupo, { text: 'Uso: /clan ver <número, ID FF o código>' }); return; }
  const grupoDatos = resolverGrupoClan(jidGrupo, jidUsuario);
  const ficha = buscarIntegrante(grupoDatos, criterio);
  if (!ficha) { await sock.sendMessage(jidGrupo, { text: 'No encontré a nadie con ese dato.' }); return; }
  await sock.sendMessage(jidGrupo, { text: formatearFichaIntegrante(ficha) });
}

async function comandoEliminarPorCodigo(sock, jidGrupo, jidUsuario, codigo) {
  if (!(await tienePermisoClan(sock, jidGrupo, jidUsuario))) {
    await sock.sendMessage(jidGrupo, { text: 'Solo las admins o el propietario pueden eliminar integrantes 🚫' });
    return;
  }
  if (!codigo || !/^\d{1,2}$/.test(codigo)) {
    await sock.sendMessage(jidGrupo, { text: 'Uso: /eliminar <código de dos cifras>\nEj: /eliminar 07\n\nRevisa los códigos con /integrantes' });
    return;
  }
  const grupoDatos = resolverGrupoClan(jidGrupo, jidUsuario);
  asegurarCodigosClan(grupoDatos);
  const codigoNormalizado = codigo.padStart(2, '0');
  const lista = integrantesClan[grupoDatos] || [];
  const indice = lista.findIndex(i => i.codigo === codigoNormalizado);
  if (indice === -1) {
    await sock.sendMessage(jidGrupo, { text: `No encontré a nadie con el código ${codigoNormalizado}. Usa /integrantes para revisar la lista.` });
    return;
  }
  const [eliminada] = lista.splice(indice, 1);
  guardarIntegrantes();
  await sock.sendMessage(jidGrupo, { text: `🗑️ Eliminada del clan: *${eliminada.apodo || eliminada.nombre}* (código ${codigoNormalizado}). Las demás integrantes no fueron afectadas.` });
}

const borradoresIntegrante = new Map();
function claveBorrador(jidGrupo, jidUsuario) { return `${jidGrupo}:${jidUsuario}`; }
function actualizarBorrador(jidGrupo, jidUsuario, campo, valor) {
  const clave = claveBorrador(jidGrupo, jidUsuario);
  const actual = borradoresIntegrante.get(clave) || {};
  actual[campo] = valor;
  borradoresIntegrante.set(clave, actual);
  return actual;
}
function borradorCompleto(borrador) {
  return !!(borrador && borrador.nombre && borrador.numero && borrador.idFF && borrador.apodo);
}
const ETIQUETAS_CAMPO_BORRADOR = { nombre: '/nombreff', numero: '/numeroff', idFF: '/idff', apodo: '/apodoff' };

async function comandoCampoIntegrante(sock, jidGrupo, jidUsuario, campo, valor) {
  if (!(await tienePermisoClan(sock, jidGrupo, jidUsuario))) {
    await sock.sendMessage(jidGrupo, { text: 'Solo las admins o el propietario pueden registrar integrantes 🚫' });
    return;
  }
  if (!valor) {
    await sock.sendMessage(jidGrupo, { text: `Uso: ${ETIQUETAS_CAMPO_BORRADOR[campo]} <valor>` });
    return;
  }
  const grupoDatos = resolverGrupoClan(jidGrupo, jidUsuario);
  const borrador = actualizarBorrador(grupoDatos, jidUsuario, campo, valor);
  if (borradorCompleto(borrador)) {
    const { actualizado, ficha } = agregarIntegrante(grupoDatos, {
      nombre: borrador.nombre, numero: borrador.numero, idFF: borrador.idFF, apodo: borrador.apodo,
      agregadoPor: jidUsuario.split('@')[0]
    });
    borradoresIntegrante.delete(claveBorrador(grupoDatos, jidUsuario));
    await sock.sendMessage(jidGrupo, { text: `${actualizado ? '✏️ Ficha actualizada' : '✅ ¡Integrante registrada!'} 💖\n\n${formatearFichaIntegrante(ficha)}` });
  } else {
    const faltan = ['nombre', 'numero', 'idFF', 'apodo'].filter(c => !borrador[c]).map(c => ETIQUETAS_CAMPO_BORRADOR[c]);
    await sock.sendMessage(jidGrupo, { text: `📝 Anoté "${valor}" ✅\n\nMe falta: ${faltan.join(', ')}` });
  }
}

async function manejarComandosClanUniversal(sock, jidChatActual, jidUsuario, texto) {
  const matchNombre = texto.match(/^\/nombreff\s+(.+)/i);
  if (matchNombre) { await comandoCampoIntegrante(sock, jidChatActual, jidUsuario, 'nombre', matchNombre[1].trim()); return true; }
  const matchNumero = texto.match(/^\/numeroff\s+(.+)/i);
  if (matchNumero) { await comandoCampoIntegrante(sock, jidChatActual, jidUsuario, 'numero', matchNumero[1].trim()); return true; }
  const matchIdFF = texto.match(/^\/idff\s+(.+)/i);
  if (matchIdFF) { await comandoCampoIntegrante(sock, jidChatActual, jidUsuario, 'idFF', matchIdFF[1].trim()); return true; }
  const matchApodo = texto.match(/^\/apodoff\s+(.+)/i);
  if (matchApodo) { await comandoCampoIntegrante(sock, jidChatActual, jidUsuario, 'apodo', matchApodo[1].trim()); return true; }

  const partesTexto = texto.trim().split(/\s+/);
  const comando = (partesTexto[0] || '').toLowerCase();
  const resto = partesTexto.slice(1);

  if (comando === '/integrantes') {
    if (!(await tienePermisoClan(sock, jidChatActual, jidUsuario))) {
      await sock.sendMessage(jidChatActual, { text: 'Solo las admins o el propietario pueden ver la lista del clan 🚫' });
      return true;
    }
    const grupoDatos = resolverGrupoClan(jidChatActual, jidUsuario);
    await sock.sendMessage(jidChatActual, { text: generarTextoListaClan(grupoDatos) });
    return true;
  }
  if (comando === '/eliminar') { await comandoEliminarPorCodigo(sock, jidChatActual, jidUsuario, resto[0]); return true; }
  if (comando === '/clan') {
    const sub = (resto[0] || '').toLowerCase();
    const restoSub = resto.slice(1).join(' ');
    if (sub === 'agregar') { await comandoClanAgregar(sock, jidChatActual, jidUsuario, restoSub); return true; }
    if (sub === 'quitar') { await comandoClanQuitar(sock, jidChatActual, jidUsuario, restoSub.trim()); return true; }
    if (sub === 'ver') { await comandoClanVer(sock, jidChatActual, jidUsuario, restoSub.trim()); return true; }
    if (sub === 'lista') {
      const grupoDatos = resolverGrupoClan(jidChatActual, jidUsuario);
      await sock.sendMessage(jidChatActual, { text: generarTextoListaClan(grupoDatos) });
      return true;
    }
    await sock.sendMessage(jidChatActual, { text: 'Usa /integrantes para ver la lista del clan 🙂' });
    return true;
  }
  if (comando === '/verificacion' || comando === '/verificación') {
    const sub = (resto[0] || '').toLowerCase();
    if (sub === 'grupo') { await comandoVerificarGrupo(sock, jidChatActual, jidUsuario, resto[1]); return true; }
    await sock.sendMessage(jidChatActual, { text: 'Uso: /verificacion grupo <código de 4 dígitos>' });
    return true;
  }
  if (comando === '/acceder') {
    const sub = (resto[0] || '').toLowerCase();
    if (sub === 'grupo') { await comandoAccederGrupo(sock, jidChatActual, jidUsuario, resto[1]); return true; }
    await sock.sendMessage(jidChatActual, { text: 'Uso: /acceder grupo <código de 4 dígitos>' });
    return true;
  }
  return false;
}

function formatearMovimiento(jidGrupo, r) {
  const info = ETIQUETAS_MOVIMIENTO[r.accion] || { icono: '•', texto: r.accion };
  const fecha = new Date(r.fecha).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const numeroEjecutor = r.ejecutor;
  const nombreEjecutor = numeroEjecutor ? obtenerEtiquetaPersona(jidGrupo, numeroEjecutor) : 'Desconocido';
  let cuerpo = `┌─────────────────────┐\n│ ${info.icono}  MOVIMIENTO DE GRUPO\n└─────────────────────┘\n\n👥 *Grupo:* ${r.nombreGrupo || 'Sin nombre registrado'}\n👤 *Realizado por:* ${nombreEjecutor}${numeroEjecutor ? ` (+${numeroEjecutor})` : ''}\n📌 *Acción:* ${info.texto}`;
  if (r.objetivos && r.objetivos.length) {
    const detalles = r.objetivos.map(n => `${obtenerEtiquetaPersona(jidGrupo, n)} (+${n})`).join(', ');
    cuerpo += `\n🎯 *Afectado(s):* ${detalles}`;
  }
  cuerpo += `\n🕐 *Fecha:* ${fecha}`;
  return cuerpo;
}

async function comandoMovimientos(sock, jidGrupo, jidUsuario, argumentoTexto) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario)) && !esPropietarioEfectivo(jidUsuario)) {
    await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden ver los movimientos del grupo 🚫' });
    return;
  }
  const numeroEncontrado = (argumentoTexto.match(/\d+/) || [])[0];
  const cantidad = Math.min(Math.max(parseInt(numeroEncontrado, 10) || 10, 1), 30);
  const registros = registroMovimientos.filter(r => r.jidGrupo === jidGrupo).slice(-cantidad).reverse();
  if (!registros.length) {
    await sock.sendMessage(jidGrupo, { text: '📋 Todavía no hay movimientos registrados en este grupo.' });
    return;
  }
  const cuerpo = registros.map(r => formatearMovimiento(jidGrupo, r)).join('\n\n');
  await sock.sendMessage(jidGrupo, { text: `╔═══════════════════════╗\n  ÚLTIMOS MOVIMIENTOS\n╚═══════════════════════╝\n\n${cuerpo}` });
}
async function comandoPromoverDegradar(sock, jidGrupo, jidUsuario, mencionados, accion) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) {
    await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden usar este comando 🚫' });
    return;
  }
  if (!mencionados.length) {
    await sock.sendMessage(jidGrupo, { text: `Menciona a quién: /${accion === 'promote' ? 'promover' : 'degradar'} @usuario` });
    return;
  }
  try {
    marcarAccionBotReciente(jidGrupo, accion, mencionados);
    await sock.groupParticipantsUpdate(jidGrupo, mencionados, accion);
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); nombreGrupo = meta.subject; } catch (err) {}
    registrarAccionAdmin(sock, jidGrupo, accion, jidUsuario, mencionados, nombreGrupo);
    await sock.sendMessage(jidGrupo, { text: accion === 'promote' ? '⭐ Listo, ahora es admin.' : '🔻 Listo, ya no es admin.' });
  } catch (err) {
    await sock.sendMessage(jidGrupo, { text: 'No pude hacer el cambio, revisa que el bot sea admin del grupo.' });
  }
}

async function comandoTodos(sock, jidGrupo, jidUsuario, mensajeExtra) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) {
    await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden usar /todos 🚫' });
    return;
  }
  try {
    const metadata = await sock.groupMetadata(jidGrupo);
    const jids = metadata.participants.map(p => p.id);
    const texto = mensajeExtra ? `📢 ${mensajeExtra}` : '📢 ¡Atención a todas!';
    const menciones = jids.map(j => `@${j.split('@')[0]}`).join(' ');
    await sock.sendMessage(jidGrupo, { text: `${texto}\n\n${menciones}`, mentions: jids });
  } catch (err) {
    await sock.sendMessage(jidGrupo, { text: 'No pude etiquetar a todos, intenta de nuevo.' });
  }
}

async function comandoCerrarGrupo(sock, jidGrupo, jidUsuario, cerrar) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) {
    await sock.sendMessage(jidGrupo, { text: 'Solo admins 🚫' });
    return;
  }
  try {
    await sock.groupSettingUpdate(jidGrupo, cerrar ? 'announcement' : 'not_announcement');
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); nombreGrupo = meta.subject; } catch (err) {}
    registrarAccionAdmin(sock, jidGrupo, cerrar ? 'cerrar' : 'abrir', jidUsuario, [], nombreGrupo);
    await sock.sendMessage(jidGrupo, { text: cerrar ? '🔒 Grupo cerrado, solo admins escriben.' : '🔓 Grupo abierto para todas.' });
  } catch (err) {
    await sock.sendMessage(jidGrupo, { text: 'No pude cambiar la configuración, revisa que el bot sea admin.' });
  }
}

function generarTextoInfo() {
  const uptimeH = ((Date.now() - estado.inicio) / 3600000).toFixed(1);
  return `🤖 *${NOMBRE_BOT}* — v${VERSION_BOT}

👨‍💻 Creada por: *${CREADOR}*, ingeniero de sistemas y estudiante de programación.
🟢 Estado: ${estado.conectado ? 'Conectada y activa' : 'Desconectada'}
⏱ Tiempo activa: ${uptimeH}h

Escribe /comando anzy para ver todo lo que puedo hacer.`;
}

const TEXTO_CREADOR = `💖 Fui creada con mucho cariño por *${CREADOR}*, ingeniero de sistemas y estudiante de programación que sigue mejorándome cada día. ¡Gracias por todo, Albert! 🙌✨`;

async function procesarComandoJefe(sock, remitente, texto) {
  const t = texto.toLowerCase().trim();
  if (t === 'salir' || t.includes('salir del menu') || t.includes('salir del menú') || t.includes('modo normal')) {
    modoJefe.delete(remitente);
    await sock.sendMessage(remitente, { text: 'Listo jefe, cerré el menú 🙌' });
    return;
  }
  if (t.includes('informe') || t.includes('estado') || t.includes('estadistica') || t.includes('estadística')) {
    const uptimeH = ((Date.now() - estado.inicio) / 3600000).toFixed(1);
    await sock.sendMessage(remitente, {
      text: `📊 *Informe de ${NOMBRE_BOT}*\nConectada: ${estado.conectado ? 'Sí' : 'No'}\nBot activo: ${botActivo ? 'Sí' : 'No'}\nUptime: ${uptimeH}h\nMensajes recibidos: ${estado.mensajesRecibidos}\nMensajes enviados: ${estado.mensajesEnviados}\nCuota IA hoy: ${contadorCuota.usados}/${LIMITE_DIARIO_ESTIMADO}\nReconexiones: ${estado.intentosReconexion}\nTono actual: ${estiloGlobalExtra || 'el original, sin cambios'}`
    });
    return;
  }
  if (t.includes('apaga')) { botActivo = false; await sock.sendMessage(remitente, { text: '🔴 Bot apagado en todos los grupos.' }); return; }
  if (t.includes('enciende') || t.includes('activa')) { botActivo = true; await sock.sendMessage(remitente, { text: '🟢 Bot encendido en todos los grupos.' }); return; }
  if (t.includes('restaura') || t.includes('vuelve a la normalidad') || t.includes('como eras antes') || t.includes('forma original')) {
    estiloGlobalExtra = '';
    await sock.sendMessage(remitente, { text: '✅ Listo jefe, volví a mi forma de ser original.' });
    return;
  }
  estiloGlobalExtra = texto.trim();
  await sock.sendMessage(remitente, { text: `✅ Listo jefe, actualicé mi forma de expresarme en TODOS los grupos:\n"${estiloGlobalExtra}"\n\n(escribe "restaura" para volver a mi forma original)` });
}
async function procesarMensajeGrupo(sock, msg, identificadoresBot) {
  const jidGrupo = msg.key.remoteJid;
  const jidUsuario = msg.key.participant || msg.key.remoteJid;
  const nombreContacto = msg.pushName || 'amiga';
  const texto = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
  if (!texto) return;

  if (esNumeroIgnorado(jidUsuario)) return;
  registrarNombreConocido(jidUsuario, msg.pushName);

  const clavePendientePropietario = `${jidGrupo}:${jidUsuario}`;
  if (pendientesPropietario.has(clavePendientePropietario)) {
    pendientesPropietario.delete(clavePendientePropietario);
    if (texto.trim() === CODIGO_DUEÑO) {
      propietariosVerificados.add(extraerNumero(jidUsuario));
      await sock.sendMessage(jidGrupo, { text: '👑 Contraseña correcta. Te reconozco como propietaria/o del bot en este chat — ya puedes agregar o eliminar integrantes del clan, vincular grupos y silenciar usuarios.' });
    } else {
      await sock.sendMessage(jidGrupo, { text: '❌ Contraseña incorrecta. Escribe /propietario para intentar de nuevo.' });
    }
    return;
  }

  registrarMensajeGrupo(jidGrupo, jidUsuario);
  const textoLower = texto.toLowerCase();

  if (/^\/comando\s+anzy$/i.test(texto)) {
    const texto_respuesta = esPropietarioEfectivo(jidUsuario) ? TEXTO_AYUDA_PROPIETARIO : TEXTO_AYUDA;
    await sock.sendMessage(jidGrupo, { text: texto_respuesta });
    return;
  }

  if (PATRON_COMANDO_TIKTOK.test(texto)) {
    await manejarComandoTiktok(sock, jidGrupo, texto);
    return;
  }

  if (esIntencionCompra(texto)) {
    try {
      await sock.sendMessage(jidGrupo, { text: 'Dame un toque que le aviso a Alberto para que te atienda directo 🙌', mentions: [jidUsuario] });
      await sock.sendMessage(JID_DUEÑO, { text: `💰 Posible cliente en grupo: ${nombreContacto} (${jidUsuario.split('@')[0]}) preguntó: "${texto}"` });
    } catch (err) { console.log('❌ Error en flujo de compra:', err.message); }
    return;
  }

  if (await manejarComandosClanUniversal(sock, jidGrupo, jidUsuario, texto)) return;

  const mencionados = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const partesTexto = texto.split(/\s+/);
  const comando = partesTexto[0].toLowerCase();
  const resto = partesTexto.slice(1);

  try {
    switch (comando) {
      case '/frase': await sock.sendMessage(jidGrupo, { text: comandoFrase() }); return;
      case '/perfil': await comandoPerfil(sock, jidGrupo, jidUsuario, mencionados[0]); return;
      case '/ranking': { const { texto: t, mentions } = await comandoRanking(sock, jidGrupo); await sock.sendMessage(jidGrupo, { text: t, mentions }); return; }
      case '/promover': await comandoPromoverDegradar(sock, jidGrupo, jidUsuario, mencionados, 'promote'); return;
      case '/degradar': await comandoPromoverDegradar(sock, jidGrupo, jidUsuario, mencionados, 'demote'); return;
      case '/todos': await comandoTodos(sock, jidGrupo, jidUsuario, resto.join(' ')); return;
      case '/cerrar': await comandoCerrarGrupo(sock, jidGrupo, jidUsuario, true); return;
      case '/abrir': await comandoCerrarGrupo(sock, jidGrupo, jidUsuario, false); return;
      case '/propietario': {
        pendientesPropietario.set(clavePendientePropietario, Date.now());
        await sock.sendMessage(jidGrupo, { text: '🔐 Escribe la contraseña de propietario para continuar:' });
        return;
      }
      case '/silencio': {
        if (!(await tienePermisoClan(sock, jidGrupo, jidUsuario))) {
          await sock.sendMessage(jidGrupo, { text: 'Solo las admins o el propietario pueden usar este comando 🚫' });
          return;
        }
        if (!mencionados.length) { await sock.sendMessage(jidGrupo, { text: 'Menciona a quién silenciar: /silencio @usuario' }); return; }
        mencionados.forEach(j => SILENCIADOS.add(extraerNumero(j)));
        guardarSilenciados();
        await sock.sendMessage(jidGrupo, { text: `🔇 Listo, dejé de responderle a ${mencionados.length} usuario(s).` });
        return;
      }
      case '/activarse': {
        if (!(await tienePermisoClan(sock, jidGrupo, jidUsuario))) {
          await sock.sendMessage(jidGrupo, { text: 'Solo las admins o el propietario pueden usar este comando 🚫' });
          return;
        }
        if (!mencionados.length) { await sock.sendMessage(jidGrupo, { text: 'Menciona a quién reactivar: /activarse @usuario' }); return; }
        mencionados.forEach(j => SILENCIADOS.delete(extraerNumero(j)));
        guardarSilenciados();
        await sock.sendMessage(jidGrupo, { text: `🔊 Listo, ya vuelvo a responderle a ${mencionados.length} usuario(s).` });
        return;
      }
      case '/novia': {
        const sub = (resto[0] || '').toLowerCase();
        const claveNovia = `${jidGrupo}:${jidUsuario}`;
        if (sub === 'on') {
          modoNovia.set(claveNovia, true);
          await sock.sendMessage(jidGrupo, { text: '💕 Listo mi amor, activé el modo novia solo para ti... ahora te voy a hablar distinto 😘' });
        } else if (sub === 'off') {
          modoNovia.delete(claveNovia);
          await sock.sendMessage(jidGrupo, { text: '💫 Ok, volví a mi forma normal contigo.' });
        } else {
          await sock.sendMessage(jidGrupo, { text: 'Uso:\n/novia on — activa el modo novia\n/novia off — lo desactiva' });
        }
        return;
      }
      case '/recordatorio': {
        if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo admins pueden programar recordatorios 🚫' }); return; }
        const entrada = resto[0] || '';
        const textoRecordatorio = resto.slice(1).join(' ');
        const match = entrada.match(/^(\d+)([smh])$/i);
        if (!match || !textoRecordatorio) {
          await sock.sendMessage(jidGrupo, { text: 'Uso: /recordatorio <tiempo><S|M|H> <texto>\nEj:\n/recordatorio 30S avisar\n/recordatorio 15M avisar\n/recordatorio 10H avisar' });
          return;
        }
        const cantidad = parseInt(match[1], 10);
        const unidad = match[2].toLowerCase();
        const multiplicador = unidad === 's' ? 1000 : unidad === 'm' ? 60000 : 3600000;
        const etiquetaUnidad = unidad === 's' ? 'segundos' : unidad === 'm' ? 'minutos' : 'horas';
        programarRecordatorioGrupo(jidGrupo, cantidad * multiplicador, textoRecordatorio);
        await sock.sendMessage(jidGrupo, { text: `⏰ Listo, aviso en ${cantidad} ${etiquetaUnidad}: "${textoRecordatorio}"` });
        return;
      }
      case '/info': await sock.sendMessage(jidGrupo, { text: generarTextoInfo() }); return;
      case '/creador': await sock.sendMessage(jidGrupo, { text: TEXTO_CREADOR }); return;
      case '/recordar': {
        const lista = memoriaPersistente[jidUsuario] || [];
        if (!lista.length) { await sock.sendMessage(jidGrupo, { text: 'Aún no tengo nada guardado de ti 🤔' }); return; }
        const resumen = lista.map(m => `👤 ${m.texto}\n🤖 ${m.respuesta}`).join('\n\n');
        await sock.sendMessage(jidGrupo, { text: `🧠 Esto recuerdo de ti:\n\n${resumen}` });
        return;
      }
      case '/olvidarme': { olvidarUsuario(jidUsuario); await sock.sendMessage(jidGrupo, { text: 'Listo, borré todo lo que recordaba de ti 🗑️' }); return; }
      case '/movimiento': case '/movimientos': await comandoMovimientos(sock, jidGrupo, jidUsuario, resto.join(' ')); return;
    }
  } catch (err) {
    console.log('❌ Error en comando:', err.message);
    return;
  }

  const deteccion = detectarLlamadaIA(texto, msg, identificadoresBot);
  if (!deteccion.llamar) return;

  if (esMensajeDeCrisis(texto)) {
    try { await sock.sendMessage(JID_DUEÑO, { text: `🚨 Alerta: ${nombreContacto} en grupo escribió algo que parece señal de crisis: "${texto}"` }); } catch (err) {}
  }

  try {
    let consultaLimpia = texto.replace(/@\d+/g, '');
    consultaLimpia = deteccion.hot
      ? consultaLimpia.replace(/^\/anzy\s+hot\s*/i, '').trim()
      : consultaLimpia.replace(/^\/\S*\s*/, '').trim();
    if (!consultaLimpia) consultaLimpia = texto;

    const textoCitado = extraerTextoCitado(msg);
    let notas = `Mensaje de ${nombreContacto} dentro de un grupo de WhatsApp, hay más personas leyendo y puede haber otros bots.`;
    if (textoCitado) notas += `\n\nMENSAJE CITADO (a lo que está respondiendo ${nombreContacto}): "${textoCitado}"`;
    notas += obtenerContextoCorto(jidUsuario);

    const noviaActiva = modoNovia.get(`${jidGrupo}:${jidUsuario}`) || false;
    const respuesta = await generarRespuestaIA(consultaLimpia, notas, noviaActiva, deteccion.hot);
    await enviarRespuestaHumanizada(sock, jidGrupo, respuesta, [jidUsuario]);
    agregarAMemoriaCorta(jidUsuario, texto, respuesta);
  } catch (err) {
    console.log('❌ Error IA:', err.message);
    await sock.sendMessage(jidGrupo, { text: mensajeEsperaAleatorio() });
  }
}

function registrarBienvenidasYDespedidas(sock) {
  sock.ev.on('group-participants.update', async (evento) => {
    const { id: jidGrupo, participants, action, author } = evento;
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); nombreGrupo = meta.subject; } catch (err) {}
    for (const participanteRaw of participants) {
      const { jid: jidParticipante, numero } = normalizarParticipante(participanteRaw);
      if (!jidParticipante) continue;
      if (['add', 'remove', 'promote', 'demote'].includes(action) && !accionFueDelBot(jidGrupo, action, jidParticipante)) {
        registrarAccionAdmin(sock, jidGrupo, action, author || null, [jidParticipante], nombreGrupo);
      }
      try {
        if (action === 'promote') {
          await sock.sendMessage(jidGrupo, { text: `⭐ @${numero} ahora es admin del grupo.`, mentions: [jidParticipante] });
        } else if (action === 'demote') {
          await sock.sendMessage(jidGrupo, { text: `🔻 @${numero} ya no es admin.`, mentions: [jidParticipante] });
        }
      } catch (err) {
        console.log('⚠️ Error en aviso de admin:', err.message);
      }
    }
  });
}
const estado = {
  conectado: false, inicio: Date.now(), mensajesRecibidos: 0, mensajesEnviados: 0,
  ultimoQR: null, intentosReconexion: 0, ultimoError: null
};

function calcularEsperaReconexion(intentos) {
  const base = Math.min(3000 * Math.pow(2, intentos), 60000);
  return intentos > 8 ? 90000 : base;
}

const almacenMensajes = new Map();
let nubeInicializada = false;
let IDENTIFICADORES_BOT_CACHE = [];

async function iniciarBot() {
  limpiarArchivosTemporalesViejos();
  await verificarBinarioYtDlp();
  await actualizarSistema();

  if (!nubeInicializada) {
    await inicializarNubeIntegrantes();
    nubeInicializada = true;
  }

  const { state, saveCreds } = await useMultiFileAuthState('sesion');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state, version, printQRInTerminal: false,
    browser: [NOMBRE_BOT, 'Chrome', '2.0.0'], syncFullHistory: false, markOnlineOnConnect: true,
    getMessage: async (key) => almacenMensajes.get(key.id) || undefined,
    logger: pino({ level: 'error' })
  });

  sockActivo = sock;
  sock.ev.on('creds.update', saveCreds);
  registrarBienvenidasYDespedidas(sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      estado.ultimoQR = await QRCode.toDataURL(qr);
      qrcodeTerminal.generate(qr, { small: true });
    }
    if (connection === 'open') {
      estado.conectado = true; estado.intentosReconexion = 0; estado.ultimoQR = null;
      IDENTIFICADORES_BOT_CACHE = obtenerIdentificadoresBot(sock);
      console.log('\n✅ BOT CONECTADO Y LISTO ✅');
      console.log('🆔 Identificadores del bot detectados:', IDENTIFICADORES_BOT_CACHE);
    }
    if (connection === 'close') {
      estado.conectado = false;
      const motivo = lastDisconnect?.error?.output?.statusCode;
      estado.ultimoError = lastDisconnect?.error?.message || 'Desconocido';
      if (motivo === DisconnectReason.loggedOut || motivo === DisconnectReason.badSession) {
        console.log('❌ Sesión inválida. Borra la carpeta "sesion" y vuelve a escanear.');
        return;
      }
      if (motivo === DisconnectReason.restartRequired) {
        setTimeout(() => iniciarBot(), 1500);
        return;
      }
      estado.intentosReconexion++;
      setTimeout(() => iniciarBot(), calcularEsperaReconexion(estado.intentosReconexion));
    }
  });

  sock.ev.on('messages.upsert', async m => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message) return;

    const remitente = msg.key.remoteJid;
    if (msg.key.fromMe) return;

    almacenMensajes.set(msg.key.id, msg.message);

    if (!remitente.endsWith('@g.us')) {
      if (remitente.endsWith('@s.whatsapp.net')) {
        const textoPersonal = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (esNumeroIgnorado(remitente)) return;

        if (pendientesPropietario.has(remitente)) {
          pendientesPropietario.delete(remitente);
          if (textoPersonal.trim() === CODIGO_DUEÑO) {
            propietariosVerificados.add(extraerNumero(remitente));
            await sock.sendMessage(remitente, { text: '👑 Contraseña correcta. Te reconozco como propietaria/o del bot — ya puedes agregar o eliminar integrantes del clan, vincular grupos y silenciar usuarios desde aquí.' });
          } else {
            await sock.sendMessage(remitente, { text: '❌ Contraseña incorrecta. Escribe /propietario para intentar de nuevo.' });
          }
          return;
        }

        if (textoPersonal.toLowerCase() === '/propietario') {
          pendientesPropietario.set(remitente, Date.now());
          await sock.sendMessage(remitente, { text: '🔐 Escribe la contraseña de propietario para continuar:' });
          return;
        }

        if (/^\/comando\s+anzy$/i.test(textoPersonal)) {
          const texto_respuesta = esPropietarioEfectivo(remitente) ? TEXTO_AYUDA_PROPIETARIO : TEXTO_AYUDA;
          await sock.sendMessage(remitente, { text: texto_respuesta });
          return;
        }

        if (PATRON_COMANDO_TIKTOK.test(textoPersonal)) {
          await manejarComandoTiktok(sock, remitente, textoPersonal);
          return;
        }

        if (await manejarComandosClanUniversal(sock, remitente, remitente, textoPersonal)) return;

        if (esCodigoDueño(textoPersonal)) {
          modoJefe.set(remitente, true);
          await sock.sendMessage(remitente, {
            text: `🔐 Menú principal activado, jefe.\n\nPuedes pedirme:\n• informe — estadísticas del bot\n• apagar / encender — activa o desactiva el bot en los grupos\n• restaura — vuelvo a mi forma de ser original\n• cualquier otra frase — la tomo como tu nueva forma de expresarme en TODOS los grupos\n• salir — cierra este menú`
          });
          return;
        }
        if (modoJefe.get(remitente)) {
          await procesarComandoJefe(sock, remitente, textoPersonal);
          return;
        }

        // ── IA también responde en chat personal (con soporte de /anzy hot) ──
        const deteccion = detectarLlamadaIA(textoPersonal, msg, IDENTIFICADORES_BOT_CACHE);
        if (deteccion.llamar) {
          try {
            let consultaLimpia = deteccion.hot
              ? textoPersonal.replace(/^\/anzy\s+hot\s*/i, '').trim()
              : textoPersonal.replace(/^\/\S*\s*/, '').trim();
            if (!consultaLimpia) consultaLimpia = textoPersonal;
            const notas = `Mensaje privado de ${msg.pushName || 'un usuario'}.` + obtenerContextoCorto(remitente);
            const noviaActiva = modoNovia.get(`${remitente}:${remitente}`) || false;
            const respuesta = await generarRespuestaIA(consultaLimpia, notas, noviaActiva, deteccion.hot);
            await enviarRespuestaHumanizada(sock, remitente, respuesta, []);
            agregarAMemoriaCorta(remitente, textoPersonal, respuesta);
          } catch (err) {
            console.log('❌ Error IA (privado):', err.message);
            await sock.sendMessage(remitente, { text: mensajeEsperaAleatorio() });
          }
        }
      }
      return;
    }

    if (!botActivo) return;

    const tipoMensaje = Object.keys(msg.message)[0];
    const esSoloMedia = ['imageMessage', 'audioMessage', 'videoMessage', 'stickerMessage'].includes(tipoMensaje)
      && !(msg.message.conversation || msg.message.extendedTextMessage?.text);
    if (esSoloMedia) return;

    estado.mensajesRecibidos++;
    try {
      await procesarMensajeGrupo(sock, msg, IDENTIFICADORES_BOT_CACHE);
      estado.mensajesEnviados++;
    } catch (err) {
      console.log('❌ Error procesando mensaje de grupo:', err.message);
    }
  });
}

setInterval(async () => {
  if (!sockActivo || recordatoriosGrupo.length === 0) return;
  const ahora = Date.now();
  for (let i = recordatoriosGrupo.length - 1; i >= 0; i--) {
    if (recordatoriosGrupo[i].tiempoEjecucion <= ahora) {
      const r = recordatoriosGrupo[i];
      try { await sockActivo.sendMessage(r.jidGrupo, { text: `⏰ Recordatorio: ${r.texto}` }); } catch (err) {}
      recordatoriosGrupo.splice(i, 1);
    }
  }
}, 30 * 1000);

const LISTA_COMANDOS_PANEL = [
  { cat: '🧠 Inteligencia Artificial', items: [
    ['/anzy <pregunta>', 'Pregúntale a la IA'],
    ['/anzy hot <pregunta>', 'Nivel de personalidad más atrevido'],
    ['@bot <pregunta>', 'Mencionando al bot']
  ]},
  { cat: '🎉 Diversión y utilidades', items: [
    ['/tiktok · /tik tok <enlace>', 'Video o fotos de TikTok sin marca de agua — funciona en grupo y en privado 🎬'],
    ['/frase', 'Frase random'],
    ['/perfil @user', 'Actividad en el grupo']
  ]},
  { cat: '💕 Modo Novia', items: [
    ['/novia on', 'Activa un modo cariñoso y coqueto conmigo'],
    ['/novia off', 'Vuelve a mi forma normal']
  ]},
  { cat: '👑 Admin', items: [
    ['/promover @user', 'Lo hace admin'],
    ['/degradar @user', 'Le quita admin'],
    ['/todos <msj>', 'Etiqueta a todos'],
    ['/cerrar · /abrir', 'Controla quién escribe'],
    ['/recordatorio <n>S/M/H <texto>', 'Aviso al grupo, ej: 30M'],
    ['/ranking', 'Top de más activas'],
    ['/movimiento', 'Últimos movimientos de admins, con nombre y grupo 🗂️'],
    ['/silencio @user', 'El bot deja de responderle por completo'],
    ['/activarse @user', 'El bot vuelve a responderle']
  ]},
  { cat: '👑 Propietario', items: [
    ['/propietario', 'Pide contraseña (grupo o privado) y te reconoce como propietaria/o'],
    ['/verificacion grupo <4 dígitos>', 'Le da un código a este grupo (úsalo dentro del grupo)'],
    ['/acceder grupo <4 dígitos>', 'Desde cualquier chat, vincula ese chat al clan de ese grupo']
  ]},
  { cat: '👥 Clan · registro paso a paso', items: [
    ['/nombreff <nombre>', 'Guarda el nombre'],
    ['/numeroff <número>', 'Guarda el número'],
    ['/idff <ID>', 'Guarda el ID FF'],
    ['/apodoff <apodo>', 'Guarda el apodo (al completar los 4, se guarda solo)'],
    ['/clan ver <código o número>', 'Ver una ficha'],
    ['/clan quitar <código o número>', 'Eliminar una ficha'],
    ['/eliminar <código de 2 cifras>', 'Elimina a una integrante sin afectar a las demás'],
    ['/integrantes', 'Lista completa con códigos (admins o propietario)']
  ]},
  { cat: '📋 Info', items: [
    ['/info', 'Info del bot'],
    ['/creador', 'Quién lo hizo'],
    ['/comando anzy', 'Ver lista de comandos en el chat']
  ]},
  { cat: '🗂️ Memoria personal', items: [
    ['/recordar', 'Ver qué recuerda de ti'],
    ['/olvidarme', 'Borra su memoria de ti']
  ]}
];

function generarHtmlComandos() {
  return LISTA_COMANDOS_PANEL.map(grupo => `
    <div class="cat-titulo">${grupo.cat}</div>
    <div class="cmd-grid">
      ${grupo.items.map(([nombre, desc]) => `
        <div class="cmd-card">
          <div class="cmd-nombre">${nombre}</div>
          <div class="cmd-desc">${desc}</div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

const app = express();

app.get('/status', (req, res) => {
  res.json({
    conectado: estado.conectado, botActivo,
    uptimeSegundos: Math.floor((Date.now() - estado.inicio) / 1000),
    mensajesRecibidos: estado.mensajesRecibidos, mensajesEnviados: estado.mensajesEnviados,
    intentosReconexion: estado.intentosReconexion,
    cuotaUsada: contadorCuota.usados, cuotaLimite: LIMITE_DIARIO_ESTIMADO
  });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${NOMBRE_BOT} · Panel</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Space+Mono&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at 20% 0%, #240a1c 0%, #06010a 55%, #000000 100%); color: #ffe3f3; font-family: 'Space Mono', monospace; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 50px 20px 70px; overflow-x: hidden; position: relative; }
  .blob { position: fixed; border-radius: 50%; filter: blur(90px); opacity: 0.35; z-index: 0; pointer-events: none; }
  .blob1 { width: 380px; height: 380px; background: #ff2ee6; top: -100px; left: -120px; animation: flotar1 12s ease-in-out infinite; }
  .blob2 { width: 320px; height: 320px; background: #a24bff; bottom: -80px; right: -100px; animation: flotar2 14s ease-in-out infinite; }
  .blob3 { width: 260px; height: 260px; background: #ff6ec7; top: 40%; left: 60%; animation: flotar1 16s ease-in-out infinite reverse; }
  @keyframes flotar1 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(40px,60px); } }
  @keyframes flotar2 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-50px,-30px); } }
  h1 { font-family: 'Orbitron', sans-serif; font-weight: 900; font-size: 42px; letter-spacing: 8px; background: linear-gradient(90deg, #ff2ee6, #ff6ec7, #b83bff, #ff2ee6); background-size: 300% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: brillo 6s linear infinite; text-align: center; position: relative; z-index: 1; text-shadow: 0 0 30px rgba(255,46,230,0.35); }
  @keyframes brillo { to { background-position: 300% center; } }
  .sub { color: #d99cc9; font-size: 12px; letter-spacing: 3px; margin: 6px 0 34px; text-transform: uppercase; position: relative; z-index: 1; }
  .badge { padding: 10px 26px; border-radius: 30px; font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: 13px; letter-spacing: 2px; display: flex; align-items: center; gap: 10px; margin-bottom: 34px; position: relative; z-index: 1; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .online { background: rgba(0,255,170,0.08); border: 1px solid #00ffaa; color: #00ffaa; }
  .online .dot { background: #00ffaa; box-shadow: 0 0 10px #00ffaa; animation: pulso 1.4s infinite; }
  .offline { background: rgba(255,60,90,0.08); border: 1px solid #ff3c5a; color: #ff3c5a; }
  .offline .dot { background: #ff3c5a; box-shadow: 0 0 10px #ff3c5a; }
  @keyframes pulso { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .card { background: linear-gradient(160deg, rgba(40,8,32,0.85), rgba(10,4,12,0.9)); border: 1px solid rgba(255,80,190,0.3); border-radius: 14px; padding: 20px; text-align: center; box-shadow: 0 0 20px rgba(255,60,180,0.08); transition: transform .2s, box-shadow .2s; }
  .card:hover { transform: translateY(-3px); box-shadow: 0 0 26px rgba(255,60,180,0.3); }
  .card .valor { font-family: 'Orbitron', sans-serif; font-size: 26px; color: #ffe3f3; font-weight: 700; }
  .card .etiqueta { font-size: 10px; color: #d99cc9; margin-top: 8px; text-transform: uppercase; letter-spacing: 1.5px; }
  .seccion { margin-top: 40px; margin-bottom: 14px; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 3px; color: #ff6ec7; text-transform: uppercase; align-self: flex-start; max-width: 900px; width: 100%; position: relative; z-index: 1; }
  .barra-fondo { width: 100%; max-width: 900px; height: 16px; background: rgba(255,255,255,0.05); border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,80,190,0.25); position: relative; z-index: 1; }
  .barra-relleno { height: 100%; background: linear-gradient(90deg, #ff2ee6, #a24bff); box-shadow: 0 0 10px #ff2ee6; }
  .cat-titulo { font-family: 'Orbitron', sans-serif; font-size: 14px; letter-spacing: 2px; color: #ff6ec7; margin: 26px 0 12px; text-transform: uppercase; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .cmd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .cmd-card { background: rgba(30,6,24,0.75); border: 1px solid rgba(255,110,199,0.25); border-radius: 10px; padding: 12px 16px; transition: border-color .2s, box-shadow .2s; }
  .cmd-card:hover { border-color: #ff2ee6; box-shadow: 0 0 16px rgba(255,46,230,0.3); }
  .cmd-nombre { font-family: 'Orbitron', sans-serif; font-size: 12px; color: #ff6ec7; letter-spacing: 1px; }
  .cmd-desc { font-size: 11px; color: #d99cc9; margin-top: 4px; }
  #qr { margin-top: 30px; position: relative; z-index: 1; }
  #qr img { border-radius: 14px; border: 2px solid rgba(255,80,190,0.4); box-shadow: 0 0 30px rgba(255,60,180,0.3); }
</style>
</head>
<body>
  <div class="blob blob1"></div>
  <div class="blob blob2"></div>
  <div class="blob blob3"></div>
  <h1>${NOMBRE_BOT.toUpperCase()}</h1>
  <div class="sub">Panel de control · ${CREADOR}</div>
  <div id="badge" class="badge offline"><div class="dot"></div>Cargando...</div>
  <div class="seccion">Actividad</div>
  <div class="grid">
    <div class="card"><div class="valor" id="msgIn">0</div><div class="etiqueta">Recibidos</div></div>
    <div class="card"><div class="valor" id="msgOut">0</div><div class="etiqueta">Enviados</div></div>
    <div class="card"><div class="valor" id="uptime">0s</div><div class="etiqueta">Uptime</div></div>
    <div class="card"><div class="valor" id="reint">0</div><div class="etiqueta">Reconexiones</div></div>
  </div>
  <div class="seccion">Cuota de IA hoy</div>
  <div class="grid">
    <div class="card" style="grid-column: 1 / -1">
      <div class="valor" id="cuotaTexto">0 / 0</div>
      <div class="barra-fondo" style="margin-top:14px"><div class="barra-relleno" id="cuotaBarra" style="width:0%"></div></div>
    </div>
  </div>
  <div class="seccion" style="margin-top:50px">Comandos disponibles</div>
  ${generarHtmlComandos()}
  <div id="qr"></div>
  <script>
    async function actualizar() {
      const r = await fetch('/status');
      const d = await r.json();
      const badge = document.getElementById('badge');
      badge.innerHTML = '<div class="dot"></div>' + (d.conectado ? (d.botActivo ? 'CONECTADO' : 'CONECTADO (bot apagado)') : 'DESCONECTADO');
      badge.className = 'badge ' + (d.conectado ? 'online' : 'offline');
      document.getElementById('msgIn').textContent = d.mensajesRecibidos;
      document.getElementById('msgOut').textContent = d.mensajesEnviados;
      document.getElementById('reint').textContent = d.intentosReconexion;
      const h = Math.floor(d.uptimeSegundos / 3600), m = Math.floor((d.uptimeSegundos % 3600) / 60), s = d.uptimeSegundos % 60;
      document.getElementById('uptime').textContent = h + 'h ' + m + 'm ' + s + 's';
      document.getElementById('cuotaTexto').textContent = d.cuotaUsada + ' / ' + d.cuotaLimite;
      const pct = Math.min(100, Math.round((d.cuotaUsada / d.cuotaLimite) * 100));
      document.getElementById('cuotaBarra').style.width = pct + '%';
    }
    setInterval(actualizar, 3000);
    actualizar();
  </script>
</body>
</html>`);
});

app.get('/qr', (req, res) => {
  if (!estado.ultimoQR) return res.send('<h2 style="font-family:sans-serif;color:#fff;background:#000;height:100vh;display:flex;align-items:center;justify-content:center">No hay QR pendiente. El bot ya está conectado o aún no se generó uno.</h2>');
  res.send(`<body style="background:#000;display:flex;justify-content:center;align-items:center;height:100vh"><img src="${estado.ultimoQR}" /></body>`);
});

app.listen(PUERTO, () => console.log(`🌐 Panel web activo en el puerto ${PUERTO}`));

const URL_PROPIA = process.env.RENDER_EXTERNAL_URL;
if (URL_PROPIA) {
  setInterval(() => { fetch(URL_PROPIA).catch(() => {}); }, 4 * 60 * 1000);
}

iniciarBot();
