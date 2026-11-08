require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const pino = require('pino');
const crypto = require('crypto');

// 🆕 v3.4.0 — módulos opcionales de visión y hojas de tareas. Si faltan, el resto del bot sigue funcionando igual.
let MODULO_TAREA = null;
let MODULO_HOJA = null;
try { MODULO_TAREA = require('./lib/tarea'); } catch (err) { console.log('⚠️ lib/tarea.js no disponible — visión de tareas desactivada:', err.message); }
let MODULO_VOZ = null;
try { MODULO_VOZ = require('./lib/voz'); } catch (err) { console.log('⚠️ lib/voz.js no disponible — voz desactivada:', err.message); }
try { MODULO_HOJA = require('./lib/hoja'); } catch (err) { console.log('⚠️ lib/hoja.js no disponible — hojas en imagen desactivadas:', err.message); }
// Hora REAL de inicio del proceso (no la hora en que se cargó este archivo).
const INICIO_PROCESO_MS = Date.now() - Math.round(process.uptime() * 1000);

function limpiarValorEnv(valor) { return (valor || '').replace(/[^\x20-\x7E]/g, '').trim(); }

const CARPETA_BIN = path.join(__dirname, 'bin');
const RUTA_YTDLP = fs.existsSync(path.join(CARPETA_BIN, 'yt-dlp')) ? path.join(CARPETA_BIN, 'yt-dlp') : 'yt-dlp';
const HAY_FFMPEG_LOCAL = fs.existsSync(path.join(CARPETA_BIN, 'ffmpeg'));
const ARGS_FFMPEG = HAY_FFMPEG_LOCAL ? `--ffmpeg-location "${CARPETA_BIN}"` : '';
// 🆕 Ruta directa al binario de ffmpeg (para comprimir audios citados antes
// de mandarlos a la IA) — distinto de ARGS_FFMPEG, que es solo el argumento
// que se le pasa a yt-dlp.
const RUTA_FFMPEG_BIN = HAY_FFMPEG_LOCAL ? path.join(CARPETA_BIN, 'ffmpeg') : 'ffmpeg';

function verificarBinarioYtDlp() {
  return new Promise((resolve) => {
    exec(`"${RUTA_YTDLP}" --version`, { timeout: 15000 }, (err, stdout) => {
      if (err) { console.log('❌ ALERTA: el binario de yt-dlp no funciona. Detalle:', err.message); return resolve(false); }
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
      if (/^temp_tiktok_/.test(archivo) || /^temp_youtube_/.test(archivo) || /^temp_facebook_/.test(archivo) || /^temp_instagram_/.test(archivo) || /^temp_audio_ia_/.test(archivo)) {
        try { fs.unlinkSync(path.join(__dirname, archivo)); borrados++; } catch {}
      }
    }
    if (borrados > 0) console.log(`🧹 Se limpiaron ${borrados} archivo(s) temporal(es).`);
  } catch (err) { console.log('⚠️ No se pudo limpiar archivos temporales:', err.message); }
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

const PATRON_COMANDO_TIKTOK = /^\/tik\s*tok\b/i;
const ENLACE_TIKTOK = /(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s]+/i;
const MAX_INTENTOS_TIKTOK = 3;

// 🔒 Seguridad: la URL se inserta entre comillas en un comando de shell (exec). Sin esta validación, un mensaje
// como /tiktok tiktok.com/x"$(comando)" o que empiece con "--exec" podría ejecutar comandos en el servidor.
// Solo se acepta una URL que empiece por el dominio, sin espacios ni caracteres de shell (" ` $ \).
function esUrlSeguraParaShell(url) {
  return typeof url === 'string' && url.length <= 600 && /^(?:https?:\/\/)?[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?:[\/?#]|$)/.test(url) && !/[\s"`$\\]/.test(url);
}

async function descargarVideoTiktokConYtDlp(url) {
  if (!esUrlSeguraParaShell(url)) throw new Error('Enlace con caracteres no permitidos');
  const idTemp = Date.now();
  for (let intento = 1; intento <= MAX_INTENTOS_TIKTOK; intento++) {
    const archivo = path.join(__dirname, `temp_tiktok_${idTemp}_${intento}.mp4`);
    try {
      const cmd = [`"${RUTA_YTDLP}"`, '-f', 'mp4/best', '--no-playlist', '--retries', '5', '--socket-timeout', '30', '--no-check-certificates', ARGS_FFMPEG, '-o', `"${archivo}"`, `"${url}"`].filter(Boolean).join(' ');
      await ejecutarComando(cmd, { timeout: 120000 });
      if (!fs.existsSync(archivo) || fs.statSync(archivo).size <= 5000) throw new Error('Archivo vacío o no descargado');
      for (let i = 1; i < intento; i++) { const viejo = path.join(__dirname, `temp_tiktok_${idTemp}_${i}.mp4`); if (fs.existsSync(viejo)) fs.unlinkSync(viejo); }
      return archivo;
    } catch (err) {
      if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
      if (intento < MAX_INTENTOS_TIKTOK) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('yt-dlp falló después de varios intentos');
}

function esProbablementeSlideshow(url) { return /\/photo\//i.test(url); }

async function descargarVideoTiktokConAPI(url) {
  for (let intento = 1; intento <= MAX_INTENTOS_TIKTOK; intento++) {
    try {
      const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error(`API respondió ${res.status}`);
      const data = await res.json();
      if (data?.code !== 0 || !data?.data) throw new Error(data?.msg || 'La API no devolvió datos válidos');
      if (Array.isArray(data.data.images) && data.data.images.length > 0) {
        let audioUrl = data.data.music || null;
        if (audioUrl && audioUrl.startsWith('/')) audioUrl = `https://www.tikwm.com${audioUrl}`;
        return { tipo: 'slideshow', imagenes: data.data.images, audio: audioUrl };
      }
      if (data.data.play) {
        const enlaceLimpio = data.data.play.startsWith('http') ? data.data.play : `https://www.tikwm.com${data.data.play}`;
        return { tipo: 'video_url', url: enlaceLimpio };
      }
      throw new Error('La API no devolvió ni video ni imágenes');
    } catch (err) { if (intento < MAX_INTENTOS_TIKTOK) await new Promise(r => setTimeout(r, 3000)); }
  }
  throw new Error('La API de respaldo también falló');
}

async function descargarVideoTiktok(url) {
  if (esProbablementeSlideshow(url)) return await descargarVideoTiktokConAPI(url);
  try { const archivo = await descargarVideoTiktokConYtDlp(url); return { tipo: 'archivo', ruta: archivo }; }
  catch (err) { return await descargarVideoTiktokConAPI(url); }
}

async function enviarResultadoTiktok(sock, jidDestino, resultado) {
  const captionLimpio = '🎥 ¡Aquí está tu video! ✨';
  if (resultado.tipo === 'archivo') { await sock.sendMessage(jidDestino, { video: { url: resultado.ruta }, caption: captionLimpio }); return; }
  if (resultado.tipo === 'video_url') { await sock.sendMessage(jidDestino, { video: { url: resultado.url }, caption: captionLimpio }); return; }
  if (resultado.tipo === 'slideshow') {
    await sock.sendMessage(jidDestino, { text: `📸 Publicación de fotos — te mando ${resultado.imagenes.length} imagen(es) 💕` });
    let enviadas = 0;
    for (const imgUrl of resultado.imagenes.slice(0, 15)) { try { await sock.sendMessage(jidDestino, { image: { url: imgUrl } }); enviadas++; } catch (err) {} }
    if (resultado.audio) { try { await sock.sendMessage(jidDestino, { audio: { url: resultado.audio }, mimetype: 'audio/mpeg' }); } catch (err) {} }
    if (enviadas === 0) await sock.sendMessage(jidDestino, { text: '💔 No pude enviar ninguna imagen, el enlace pudo haber vencido.' });
  }
}

async function manejarComandoTiktok(sock, jidDestino, enlace) {
  if (!ENLACE_TIKTOK.test(enlace)) { await sock.sendMessage(jidDestino, { text: '💕 Uso: /tiktok <enlace>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎬 ¡Claro! Dame un momentito 💖' });
  let rutaTemporal = null;
  try {
    const resultado = await descargarVideoTiktok(enlace);
    if (resultado.tipo === 'archivo') rutaTemporal = resultado.ruta;
    await enviarResultadoTiktok(sock, jidDestino, resultado);
  } catch (err) { await sock.sendMessage(jidDestino, { text: '💔 No pude bajar ese contenido, intenta con otro enlace 🙏' }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

const ENLACE_YOUTUBE = /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[^\s]+/i;
const ENLACE_FACEBOOK = /(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.watch)\/[^\s]+/i;
const ENLACE_INSTAGRAM = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[^\s]+/i;
const URL_DESCARGAS = limpiarValorEnv(process.env.URL_DESCARGAS) || 'https://mini-servidor.onrender.com';
const CLAVE_API_DESCARGAS = limpiarValorEnv(process.env.CLAVE_API_DESCARGAS) || 'Albert292776';
if (!limpiarValorEnv(process.env.CLAVE_API_DESCARGAS)) console.log('⚠️ SEGURIDAD: CLAVE_API_DESCARGAS no está definida en el entorno y se está usando el valor antiguo escrito en el código. Defínela en Render/.env, cambia esa clave en el mini-servidor y borra el valor del código.');

async function extraerDetalleError(respuesta) {
  try { const data = await respuesta.json(); return data.detalle || data.error || JSON.stringify(data); }
  catch (err) { return await respuesta.text().catch(() => ''); }
}

async function descargarAudioYoutube(url) {
  const parametros = new URLSearchParams({ url });
  if (CLAVE_API_DESCARGAS) parametros.set('clave', CLAVE_API_DESCARGAS);
  const respuesta = await fetch(`${URL_DESCARGAS}/audio?${parametros.toString()}`);
  if (!respuesta.ok) throw new Error(`El descargador respondió ${respuesta.status}: ${String(await extraerDetalleError(respuesta)).slice(0, 300)}`);
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Archivo demasiado pequeño.');
  const rutaTemporal = path.join(__dirname, `temp_youtube_${Date.now()}.m4a`);
  fs.writeFileSync(rutaTemporal, buffer);
  return rutaTemporal;
}

async function manejarComandoYoutube(sock, jidDestino, enlace) {
  if (!ENLACE_YOUTUBE.test(enlace)) { await sock.sendMessage(jidDestino, { text: '🎵 Uso: /youtube <enlace>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎧 Descargando el audio...' });
  let rutaTemporal = null;
  try { rutaTemporal = await descargarAudioYoutube(enlace); await sock.sendMessage(jidDestino, { audio: { url: rutaTemporal }, mimetype: 'audio/mp4', ptt: false }); }
  catch (err) { await sock.sendMessage(jidDestino, { text: `💔 No pude descargar ese audio. Detalle: ${err.message.slice(0, 150)}` }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

async function descargarVideoYoutube(url) {
  const parametros = new URLSearchParams({ url });
  if (CLAVE_API_DESCARGAS) parametros.set('clave', CLAVE_API_DESCARGAS);
  const respuesta = await fetch(`${URL_DESCARGAS}/video?${parametros.toString()}`);
  if (!respuesta.ok) throw new Error(`El descargador respondió ${respuesta.status}: ${String(await extraerDetalleError(respuesta)).slice(0, 300)}`);
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Archivo demasiado pequeño.');
  const rutaTemporal = path.join(__dirname, `temp_youtube_video_${Date.now()}.mp4`);
  fs.writeFileSync(rutaTemporal, buffer);
  return rutaTemporal;
}

async function manejarComandoYoutubeVideo(sock, jidDestino, enlace) {
  if (!ENLACE_YOUTUBE.test(enlace)) { await sock.sendMessage(jidDestino, { text: '🎬 Uso: /youtubevideo <enlace>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎬 Descargando el video...' });
  let rutaTemporal = null;
  try { rutaTemporal = await descargarVideoYoutube(enlace); await sock.sendMessage(jidDestino, { video: { url: rutaTemporal }, caption: '🎥 ¡Aquí está tu video! ✨' }); }
  catch (err) { await sock.sendMessage(jidDestino, { text: `💔 No pude descargar ese video. Detalle: ${err.message.slice(0, 150)}` }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

async function descargarFacebook(url, tipo) {
  const parametros = new URLSearchParams({ url, tipo });
  if (CLAVE_API_DESCARGAS) parametros.set('clave', CLAVE_API_DESCARGAS);
  const respuesta = await fetch(`${URL_DESCARGAS}/facebook?${parametros.toString()}`);
  if (!respuesta.ok) throw new Error(`El descargador respondió ${respuesta.status}: ${String(await extraerDetalleError(respuesta)).slice(0, 300)}`);
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Archivo demasiado pequeño.');
  const extension = tipo === 'audio' ? 'm4a' : 'mp4';
  const rutaTemporal = path.join(__dirname, `temp_facebook_${tipo}_${Date.now()}.${extension}`);
  fs.writeFileSync(rutaTemporal, buffer);
  return rutaTemporal;
}

async function manejarComandoFacebook(sock, jidDestino, enlace, tipo) {
  if (!ENLACE_FACEBOOK.test(enlace)) { await sock.sendMessage(jidDestino, { text: `📘 Uso: /${tipo === 'audio' ? 'facebookaudio' : 'facebook'} <enlace>` }); return; }
  await sock.sendMessage(jidDestino, { text: tipo === 'audio' ? '🎧 Sacando el audio...' : '🎬 Descargando el video...' });
  let rutaTemporal = null;
  try {
    rutaTemporal = await descargarFacebook(enlace, tipo);
    if (tipo === 'audio') await sock.sendMessage(jidDestino, { audio: { url: rutaTemporal }, mimetype: 'audio/mp4', ptt: false });
    else await sock.sendMessage(jidDestino, { video: { url: rutaTemporal }, caption: '🎥 ¡Aquí está tu video! ✨' });
  } catch (err) { await sock.sendMessage(jidDestino, { text: `💔 No pude descargar eso de Facebook. Detalle: ${err.message.slice(0, 150)}` }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

async function descargarVideoInstagram(url) {
  const parametros = new URLSearchParams({ url });
  if (CLAVE_API_DESCARGAS) parametros.set('clave', CLAVE_API_DESCARGAS);
  const respuesta = await fetch(`${URL_DESCARGAS}/instagram?${parametros.toString()}`);
  if (!respuesta.ok) throw new Error(`El descargador respondió ${respuesta.status}: ${String(await extraerDetalleError(respuesta)).slice(0, 300)}`);
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Archivo demasiado pequeño.');
  const rutaTemporal = path.join(__dirname, `temp_instagram_${Date.now()}.mp4`);
  fs.writeFileSync(rutaTemporal, buffer);
  return rutaTemporal;
}

async function manejarComandoInstagram(sock, jidDestino, enlace) {
  if (!ENLACE_INSTAGRAM.test(enlace)) { await sock.sendMessage(jidDestino, { text: '📸 Uso: /instagram <enlace>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎬 Descargando el video de Instagram...' });
  let rutaTemporal = null;
  try { rutaTemporal = await descargarVideoInstagram(enlace); await sock.sendMessage(jidDestino, { video: { url: rutaTemporal }, caption: '🎥 ¡Aquí está tu video! ✨' }); }
  catch (err) { await sock.sendMessage(jidDestino, { text: `💔 No pude descargar ese video de Instagram. Detalle: ${err.message.slice(0, 150)}` }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

function obtenerTextoMensaje(msg) {
  return (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '').trim();
}

const PATRON_COMANDO_FOTOFF = /^\/fotoff\s+(\S+)/i;
const PATRON_COMANDO_ELIMINAR_FOTO = /^\/eliminar\s+foto\s+(\S+)/i;
const PATRON_COMANDO_YOUTUBE = /^\/youtube\s+(\S+)/i;
const PATRON_COMANDO_YOUTUBEVIDEO = /^\/youtubevideo\s+(\S+)/i;
const PATRON_COMANDO_FACEBOOK_AUDIO = /^\/facebookaudio\s+(\S+)/i;
const PATRON_COMANDO_FACEBOOK = /^\/facebook\s+(\S+)/i;
const PATRON_COMANDO_INSTAGRAM = /^\/instagram\s+(\S+)/i;
const CLAVE_IA_PRINCIPAL = process.env.CLAVE_IA_PRINCIPAL;
const CLAVE_IA_RESPALDO = process.env.CLAVE_IA_RESPALDO;
const CLAVE_IA_RESPALDO2 = process.env.CLAVE_IA_RESPALDO2;
const MODELO_PRINCIPAL = 'gemini-3.6-flash';
const MODELO_RESPALDO = 'gemini-3.6-flash';
const MODELO_RESPALDO2 = 'gemini-3.6-flash';
const MODELO_IMAGEN = 'gemini-2.5-flash-image';

const CODIGO_DUEÑO_LEGADO = '2927760128';
const CODIGO_DUEÑO = limpiarValorEnv(process.env.CODIGO_PROPIETARIO) || CODIGO_DUEÑO_LEGADO;
if (!limpiarValorEnv(process.env.CODIGO_PROPIETARIO)) console.log('⚠️ SEGURIDAD: CODIGO_PROPIETARIO no está definido en el entorno y se usa el valor antiguo escrito en el código. Defínelo en Render/.env y bórralo del código.');
const NOMBRE_BOT = 'Anzy';
const CREADOR = 'Albert Drak';
const VERSION_BOT = '3.4.0';
const TU_NUMERO = '51996399291';
const NUMERO_BOT_VINCULADO = '51975922748';
const JID_DUEÑO = `${TU_NUMERO}@s.whatsapp.net`;
const PUERTO = process.env.PORT || 3000;
const LIMITE_DIARIO_ESTIMADO = 1400;
// 🔧 Subido de 900 a 1500, como pediste — respuestas más completas, aunque
// tarden un poco más en generarse.
const MAX_TOKENS_RESPUESTA = 1500;
const INTEGRANTES_POR_PAGINA = 10;

const COMANDO_LLAMADA_IA = '/anzy';

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 v3.4.0 — TIEMPO ENCENDIDO, DIAGNÓSTICO Y LLAMADAS A LA IA CON TIEMPO LÍMITE
// ═══════════════════════════════════════════════════════════════════════════
const TIMEOUT_IA_TEXTO_MS = parseInt(process.env.TIMEOUT_IA_TEXTO_MS, 10) || 45000;
const TIMEOUT_IA_AUDIO_MS = parseInt(process.env.TIMEOUT_IA_AUDIO_MS, 10) || 120000;
const TIMEOUT_IA_VISION_MS = parseInt(process.env.TIMEOUT_IA_VISION_MS, 10) || 120000;

// ── Tiempo encendida (SIEMPRE calculado por código, nunca por la IA) ─────────
// A) Tiempo del PROCESO ACTUAL: parte de la hora real de inicio del proceso y se reinicia con cada reinicio.
// B) Tiempo acumulado desde la instalación: NO está implementado (haría falta guardarlo de forma
//    persistente; el disco de Render se borra en cada despliegue). Por eso no se muestra ni se afirma.
function desglosarDuracion(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    total,
    semanas: Math.floor(total / 604800),
    dias: Math.floor((total % 604800) / 86400),
    horas: Math.floor((total % 86400) / 3600),
    minutos: Math.floor((total % 3600) / 60),
    segundos: total % 60,
    diasTotales: Math.floor(total / 86400)
  };
}

function formatearDuracionLarga(ms, { semanas = true } = {}) {
  const d = desglosarDuracion(ms);
  const partes = [];
  const agregar = (n, singular, plural) => { if (n > 0) partes.push(`${n} ${n === 1 ? singular : plural}`); };
  if (semanas) { agregar(d.semanas, 'semana', 'semanas'); agregar(d.dias, 'día', 'días'); }
  else agregar(d.diasTotales, 'día', 'días');
  agregar(d.horas, 'hora', 'horas');
  agregar(d.minutos, 'minuto', 'minutos');
  if (d.segundos > 0 || partes.length === 0) partes.push(`${d.segundos} ${d.segundos === 1 ? 'segundo' : 'segundos'}`);
  if (partes.length === 1) return partes[0];
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
}

function formatearDuracionCorta(ms) {
  const d = desglosarDuracion(ms);
  const dias = d.diasTotales;
  return `${dias > 0 ? dias + 'd ' : ''}${d.horas}h ${d.minutos}m ${d.segundos}s`;
}

function fechaLegible(ms) {
  return new Date(ms).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function obtenerUptimeMs() { return Date.now() - INICIO_PROCESO_MS; }

function textoUptime() {
  return `${NOMBRE_BOT.toUpperCase()} ESTÁ ACTIVO DESDE HACE:\n\n${formatearDuracionLarga(obtenerUptimeMs())}.\n\n_Tiempo del proceso actual (se reinicia cada vez que el bot se reinicia). Inicio: ${fechaLegible(INICIO_PROCESO_MS)} (hora de Lima)._`;
}

const PATRON_PREGUNTA_UPTIME = /(cu[aá]nto\s+tiempo\s+(llevas|lleva|has\s+estado|est[aá]s?|estas)\s+(encendid|prendid|activ|funcionando|conectad|despiert|on\b)|cu[aá]nto\s+(llevas|lleva)\s+(encendid|prendid|activ|funcionando)|desde\s+cu[aá]ndo\s+(est[aá]s?|estas)\s+(encendid|prendid|activ|conectad|funcionando)|\buptime\b|tiempo\s+(de\s+)?(actividad|encendid\w*|funcionamiento)|hace\s+cu[aá]nto\s+(est[aá]s?|estas)\s+(encendid|prendid|activ))/i;
function esPreguntaUptime(texto) { return PATRON_PREGUNTA_UPTIME.test(texto || ''); }

// Si la pregunta menciona de forma más libre el tiempo encendida, se le da el dato real a la IA.
function contextoSistemaSiAplica(texto) {
  const t = texto || '';
  if (/(encendid|prendid|activ[ao]|funcionando|conectad|uptime)/i.test(t) && /(tiempo|cu[aá]nto|desde|hace|llevas)/i.test(t)) {
    return `\n\nDATO REAL DEL SISTEMA (calculado por el programa, no lo cambies ni lo inventes): llevas encendida ${formatearDuracionLarga(obtenerUptimeMs())} desde el último reinicio del proceso.`;
  }
  return '';
}

// ── Diagnóstico (sin guardar contenido de conversaciones ni credenciales) ────
const EVENTOS_DIAG = [];
const MAX_EVENTOS_DIAG = 150;
const ESTADISTICAS_LATENCIA = new Map();

function sanitizarParaLog(texto) {
  return String(texto == null ? '' : texto)
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[clave]')
    .replace(/\bgh[pousr]_[0-9A-Za-z]{20,}/g, '[token]')
    .replace(/\bsk_[0-9a-zA-Z]{16,}/g, '[clave]')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{10,}/gi, '$1[token]')
    .replace(/([?&](?:key|clave|token|api_key|apikey|x-goog-api-key)=)[^&\s"']+/gi, '$1[oculto]')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
}

// Distingue fallos temporales de errores de configuración.
function clasificarError(err) {
  const mensaje = String((err && err.message) || err || '');
  const estadoHttp = Number((err && (err.status || err.statusCode)) || 0);
  const codigo = err && err.codigo;
  const t = (re) => re.test(mensaje);
  if (err && err.categoriaVoz) {
    const cv = err.categoriaVoz;
    return { categoria: `voz_${cv}`, tipo: ['autenticacion', 'plan', 'voz_no_encontrada', 'sin_clave', 'ffmpeg'].includes(cv) ? 'configuracion' : (['cuota', 'timeout', 'servidor', 'red', 'limite_ritmo'].includes(cv) ? 'temporal' : 'entrada') };
  }
  if (codigo === 'TIMEOUT' || t(/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT|tiempo de espera/i)) return { categoria: 'timeout', tipo: 'temporal' };
  if (estadoHttp === 429 || t(/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|daily free allocation/i)) return { categoria: 'cuota', tipo: 'temporal' };
  if (estadoHttp === 401 || estadoHttp === 403 || t(/\b40[13]\b|API key|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i)) return { categoria: 'autenticacion', tipo: 'configuracion' };
  if (estadoHttp === 404 || t(/\b404\b|NOT_FOUND|is not found|not supported for|model.*(deprecated|retired|not available)/i)) return { categoria: 'modelo_no_disponible', tipo: 'configuracion' };
  if (t(/SAFETY|PROHIBITED_CONTENT|blocked by|bloqueo de seguridad/i)) return { categoria: 'contenido_bloqueado', tipo: 'entrada' };
  if (estadoHttp === 400 || t(/\b400\b|INVALID_ARGUMENT/i)) return { categoria: 'solicitud_invalida', tipo: 'entrada' };
  if (codigo === 'RESPUESTA_VACIA') return { categoria: 'respuesta_vacia', tipo: 'temporal' };
  if (estadoHttp >= 500 || t(/\b5\d\d\b|UNAVAILABLE|overloaded|INTERNAL|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i)) return { categoria: 'servidor_o_red', tipo: 'temporal' };
  if (codigo && /^IMAGEN_|^MEDIA_/.test(codigo)) return { categoria: String(codigo).toLowerCase(), tipo: 'entrada' };
  return { categoria: 'desconocido', tipo: 'desconocido' };
}

function registrarEventoDiag(funcion, err, ms, extra) {
  const c = clasificarError(err);
  const evento = {
    fecha: new Date().toISOString(), funcion, categoria: c.categoria, tipo: c.tipo,
    ms: typeof ms === 'number' ? ms : null,
    detalle: sanitizarParaLog(err && err.message ? err.message : err),
    extra: extra ? sanitizarParaLog(extra) : undefined
  };
  EVENTOS_DIAG.push(evento);
  if (EVENTOS_DIAG.length > MAX_EVENTOS_DIAG) EVENTOS_DIAG.shift();
  return evento;
}

function registrarLatencia(funcion, ms, ok) {
  const e = ESTADISTICAS_LATENCIA.get(funcion) || { n: 0, ok: 0, fallos: 0, totalMs: 0, maxMs: 0, ultimoMs: 0 };
  e.n++; if (ok) e.ok++; else e.fallos++;
  e.totalMs += ms; e.maxMs = Math.max(e.maxMs, ms); e.ultimoMs = ms;
  ESTADISTICAS_LATENCIA.set(funcion, e);
}

const ultimoAvisoConfig = new Map();
function avisarPropietarioSiConfiguracion(sock, err, funcion) {
  try {
    const c = clasificarError(err);
    if (c.tipo !== 'configuracion') return;
    const ahora = Date.now();
    if (ahora - (ultimoAvisoConfig.get(c.categoria) || 0) < 30 * 60 * 1000) return;
    ultimoAvisoConfig.set(c.categoria, ahora);
    sock.sendMessage(JID_DUEÑO, { text: `🔧 *Diagnóstico*: se detectó un posible error de configuración en "${funcion}" (${c.categoria}).\nDetalle: ${sanitizarParaLog(err && err.message).slice(0, 160)}\n_Es solo una detección: no se aplicó ninguna reparación._` }).catch(() => {});
  } catch { /* nunca bloquear por el aviso */ }
}

function generarResumenDiagnostico() {
  const lineas = [`🩺 *Diagnóstico de ${NOMBRE_BOT}* · v${VERSION_BOT}`, ''];
  lineas.push(`⏱ Activa desde hace: ${formatearDuracionLarga(obtenerUptimeMs())} _(proceso actual)_`);
  lineas.push(`📡 WhatsApp: ${estado.conectado ? 'conectado' : 'desconectado'} · reconexiones seguidas: ${estado.intentosReconexion}`);
  if (estado.ultimoError && !estado.conectado) lineas.push(`   último error de conexión: ${sanitizarParaLog(estado.ultimoError).slice(0, 120)}`);
  lineas.push(`🤖 IA: ${CLIENTES_IA.length} cliente(s) configurado(s) (${CLIENTES_IA.map(c => c.nombre).join(', ') || 'ninguno'}) · modelo: ${MODELO_PRINCIPAL}`);
  lineas.push(`📊 Cuota estimada hoy: ${contadorCuota.usados}/${LIMITE_DIARIO_ESTIMADO}`);
  lineas.push(`🟢 Bot activo: ${botActivo ? 'sí' : 'no'}`);
  lineas.push(`🔊 Voz: ${(VOZ && VOZ.cliente.configurado()) ? `ElevenLabs (${VOZ.cliente.modelo()}) · ${estadoVoz.audios} audio(s), ≈${estadoVoz.caracteres} caracteres este mes · ${estadoVoz.ffmpegOpus === false ? 'sin Opus (audio mp3)' : 'notas de voz Ogg/Opus'}${Date.now() < estadoVoz.bloqueadoHasta ? ' · en pausa: ' + estadoVoz.motivoBloqueo : ''}` : 'sin configurar'}`);
  if (ESTADISTICAS_LATENCIA.size) {
    lineas.push('', '⏳ *Tiempos de respuesta* (promedio · máx · último):');
    for (const [fn, e] of ESTADISTICAS_LATENCIA) lineas.push(`• ${fn}: ${Math.round(e.totalMs / e.n)} ms · ${e.maxMs} ms · ${e.ultimoMs} ms (${e.ok} ok / ${e.fallos} fallos)`);
  }
  const recientes = EVENTOS_DIAG.slice(-8).reverse();
  if (recientes.length) {
    lineas.push('', '🧾 *Últimos errores registrados:*');
    for (const ev of recientes) {
      const hora = new Date(ev.fecha).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      lineas.push(`• ${hora} · ${ev.funcion} · ${ev.categoria} (${ev.tipo})${ev.ms != null ? ` · ${ev.ms} ms` : ''}`);
    }
  } else lineas.push('', '🧾 Sin errores registrados desde el último reinicio.');

  const ultimos = EVENTOS_DIAG.slice(-40);
  const cuenta = (cat) => ultimos.filter(e => e.categoria === cat).length;
  const notas = [];
  if (cuenta('autenticacion')) notas.push('Se detectaron errores de autenticación (configuración): revisa las claves CLAVE_IA_*.');
  if (cuenta('modelo_no_disponible')) notas.push('Se detectó un modelo no disponible (configuración): revisa el identificador del modelo.');
  if (cuenta('cuota')) notas.push('Se detectó cuota agotada (temporal): se renueva sola; si se repite todos los días, revisa el plan. Recuerda que el límite es por proyecto de Google, no por clave.');
  if (cuenta('voz_cuota')) notas.push('Se agotó el crédito de voz de ElevenLabs (temporal): se renueva cada mes.');
  if (cuenta('voz_plan') || cuenta('voz_autenticacion') || cuenta('voz_voz_no_encontrada') || cuenta('voz_sin_clave')) notas.push('La voz tiene un problema de configuración: revisa ELEVENLABS_API_KEY y ELEVENLABS_VOICE_ID (en el plan gratis solo se pueden usar algunas voces).');
  if (cuenta('voz_ffmpeg')) notas.push('ffmpeg no pudo convertir el audio a Opus: las respuestas salen como audio mp3.');
  if (cuenta('timeout')) notas.push('Hubo respuestas que superaron el tiempo límite (temporal).');
  if (cuenta('servidor_o_red')) notas.push('Hubo caídas o errores de red del servicio (temporal).');
  if (cuenta('conexion_whatsapp') || ultimos.some(e => e.funcion === 'conexion_whatsapp')) notas.push('Hubo desconexiones de WhatsApp: revisa los logs de Render si persisten.');
  if (notas.length) lineas.push('', '🔎 *Observaciones:*', ...notas.map(n => `• ${n}`), '', '_Esto es solo detección; no se aplicó ninguna reparación._');
  return lineas.join('\n');
}

// ── Llamadas a la IA con tiempo límite, medición y respaldo ──────────────────
async function llamarModelo(cliente, parametros, timeoutMs, funcion) {
  const inicio = Date.now();
  const controlador = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => {
      const e = new Error(`Tiempo de espera agotado (${timeoutMs} ms)`); e.codigo = 'TIMEOUT';
      if (controlador) { try { controlador.abort(); } catch { /* ya cancelado */ } }
      rechazar(e);
    }, timeoutMs);
  });
  const config = { ...(parametros.config || {}) };
  if (controlador) config.abortSignal = controlador.signal;
  try {
    const res = await Promise.race([cliente.ai.models.generateContent({ ...parametros, model: cliente.modelo, config }), limite]);
    const ms = Date.now() - inicio;
    registrarLatencia(funcion, ms, true);
    console.log(`⏱️ [IA:${funcion}] cliente=${cliente.nombre} modelo=${cliente.modelo} ${ms} ms OK`);
    return res;
  } catch (err) {
    const ms = Date.now() - inicio;
    registrarLatencia(funcion, ms, false);
    const ev = registrarEventoDiag(`ia_${funcion}`, err, ms, `cliente=${cliente.nombre}`);
    console.log(`⚠️ [IA:${funcion}] cliente=${cliente.nombre} ${ms} ms FALLÓ (${ev.categoria}/${ev.tipo}): ${ev.detalle}`);
    throw err;
  } finally { clearTimeout(temporizador); }
}

// Prueba los clientes en orden. Cada cliente se intenta UNA vez (sin esperas artificiales). Solo si TODOS
// fallaron por caídas transitorias del servidor (5xx/red) se reintenta una vez el principal. No se reintenta
// ante cuota, timeout ni errores de configuración: repetir la misma petición solo alargaría la espera.
async function generarConRespaldo(funcion, construirParametros, timeoutMs) {
  if (CLIENTES_IA.length === 0) throw new Error('No hay ningún token de IA configurado');
  const errores = [];
  const ejecutar = async (cliente) => {
    const res = await llamarModelo(cliente, construirParametros(cliente), timeoutMs, funcion);
    if (!res || typeof res.text !== 'string' || !res.text.trim()) {
      const e = new Error('La IA no devolvió texto (respuesta vacía o bloqueada)'); e.codigo = 'RESPUESTA_VACIA'; throw e;
    }
    return res;
  };
  for (const cliente of CLIENTES_IA) {
    try { return await ejecutar(cliente); } catch (err) { errores.push(err); }
  }
  if (errores.every(e => clasificarError(e).categoria === 'servidor_o_red')) {
    await new Promise(r => setTimeout(r, 700));
    try { return await ejecutar(CLIENTES_IA[0]); } catch (err) { errores.push(err); }
  }
  throw errores[errores.length - 1];
}

async function probarClientesIA() {
  const resultados = [];
  for (const cliente of CLIENTES_IA) {
    const t0 = Date.now();
    try {
      await llamarModelo(cliente, { contents: 'Responde solo con la palabra OK.', config: { maxOutputTokens: 16 } }, 20000, 'prueba');
      resultados.push({ nombre: cliente.nombre, ok: true, ms: Date.now() - t0 });
    } catch (err) {
      const c = clasificarError(err);
      resultados.push({ nombre: cliente.nombre, ok: false, ms: Date.now() - t0, categoria: c.categoria, tipo: c.tipo });
    }
  }
  return resultados;
}

if (!CLAVE_IA_PRINCIPAL) console.log('❌ ALERTA: no se detectó CLAVE_IA_PRINCIPAL.');
if (URL_DESCARGAS) console.log(`🔍 URL_DESCARGAS configurada: ${URL_DESCARGAS}`);

const TEXTO_AYUDA = `*COMANDOS · ${NOMBRE_BOT}*

🧠 *Inteligencia Artificial*
• Mencióname, o escribe /anzy <pregunta>
• Cita un audio, mencióname y pídeme algo sobre él 🎙️
• /imagen <descripción> — genero una imagen con IA
• Envía o cita una foto y mencióname: la leo, resuelvo la tarea y, si quieres, te la devuelvo en una hoja en imagen 📸

🎭 *Modos de personalidad*
• /novia on · /novia off
• /amiga on · /amiga off

🎉 *Descargas*
• /tiktok <enlace>
• /youtube <enlace> — audio 🎧
• /youtubevideo <enlace> — video 🎬
• /facebook <enlace> — video
• /facebookaudio <enlace> — audio
• /instagram <enlace> — video 📸

🎉 *Diversión y utilidades*
• /frase
• /perfil @usuario

👑 *Administración de grupo*
• /promover · /degradar @usuario
• /todos <mensaje>
• /cerrar · /abrir
• /recordatorio <tiempo><S|M|H> <texto>
• /ranking

📋 *Información*
• /info · /creador · /estado
• /comando anzy

🗂️ *Memoria personal*
• /recordar · /olvidarme`;

const PALABRAS_CRISIS = ['quiero morir', 'no quiero vivir', 'suicidar', 'suicidio', 'matarme', 'quitarme la vida', 'hacerme daño', 'autolesion', 'cortarme'];
function esMensajeDeCrisis(texto) { return PALABRAS_CRISIS.some(p => texto.toLowerCase().includes(p)); }

const PALABRAS_COMPRA = ['cuanto cuesta', 'cuánto cuesta', 'precio', 'precios', 'quiero comprar', 'tienes stock', 'como pago', 'cómo pago', 'esta disponible', 'está disponible', 'vendes'];
function esIntencionCompra(texto) { return PALABRAS_COMPRA.some(p => texto.toLowerCase().includes(p)); }

process.on('unhandledRejection', (err) => console.log('⚠️ Promesa no manejada:', err?.message || err));
process.on('uncaughtException', (err) => console.log('⚠️ Excepción no capturada:', err?.message || err));

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
];

const REGLAS_IA_BASE = `
Eres ${NOMBRE_BOT}, una asistente virtual femenina, creada por ${CREADOR}. Hablas de ti misma en femenino, con un tono cálido, amable, cercano y dulce — pero SIEMPRE educado.

CONTEXTO: estás respondiendo dentro de un grupo o chat de WhatsApp.

Si estás hablando con TU PROPIETARIO/CREADOR (se te indicará explícitamente), trátalo con más cercanía y calidez.

IMPORTANTE: solo eres una asistente conversacional. No ejecutas acciones sobre el grupo ni el clan por tu cuenta — todas esas acciones requieren que la persona use el comando exacto.

CÓMO ERES:
✅ Amable, femenina, empática, positiva.
✅ EXPLÍCITA y CLARA.
✅ Emojis con soltura pero sin exagerar (2 a 4).
✅ Hablas como una creación de ${CREADOR}.

❌ NUNCA grosera ni jerga masculina/callejera.

📏 LARGO: adapta el largo a la pregunta.

🚨 CRISIS REAL: responde con calidez genuina y anímalo a hablar con un profesional.

🔒 DATOS REALES Y SEGURIDAD:
• NUNCA reveles claves API, contraseñas, tokens, variables de entorno ni configuración interna.
• NUNCA inventes datos técnicos del bot (tiempo encendida, estado, cuota, errores). Si el sistema te los da en el contexto, úsalos tal cual; si no los tienes, dilo.
• Si algo de una imagen no se distingue, NO lo inventes: pide una foto más clara.
`;

const REGLAS_MODO_AMIGA = `\n\n👯 MODO AMIGA ACTIVO: háblale como su mejor amiga — cercana, relajada, bromista. Interésate por lo que te cuenta, dale seguimiento a la conversación anterior si aplica. Nada de tono romántico.`;

// 🔧 Modo novia mejorado: más detalle de comportamiento, apodos cariñosos,
// seguimiento real de la conversación — sigue sin ser explícito.
const REGLAS_MODO_NOVIA = `\n\n💘 MODO NOVIA ACTIVO: ahora hablas con esta persona como su novia virtual — cariñosa, coqueta, un poco celosa en broma, y muy pendiente de ella. Usa apodos cariñosos (bebé, mi amor, corazón, mi vida) con naturalidad, sin abusar de ellos en cada frase. Muéstrate interesada de verdad en su día, hazle preguntas de vuelta, y retoma cosas que te haya contado antes en la charla si vienen al caso. Usa emojis como 🥺💕😘🫶 con soltura pero sin saturar. Si te pide ayuda con algo serio, ayúdala igual de bien, solo mantén ese tono cariñoso de fondo. Nunca vulgar, nunca contenido sexual explícito — el coqueteo es tierno e insinuante, jamás gráfico.`;

const MENSAJES_ESPERA = ['💫 Dame un segundito 🥰', '🌸 Un momentito, ya vuelvo 💕', '✨ Dame un momento 🙈', '💖 Inténtalo de nuevo en un ratito 🌷'];
function mensajeEsperaAleatorio() { return MENSAJES_ESPERA[Math.floor(Math.random() * MENSAJES_ESPERA.length)]; }

const contadorCuota = { fecha: new Date().toDateString(), usados: 0 };
function registrarUsoIA() {
  const hoy = new Date().toDateString();
  if (contadorCuota.fecha !== hoy) { contadorCuota.fecha = hoy; contadorCuota.usados = 0; }
  contadorCuota.usados++;
}
function cuotaCasiAgotada() { return contadorCuota.usados >= LIMITE_DIARIO_ESTIMADO * 0.9; }

const ARCHIVO_MEMORIA = path.join(__dirname, 'memoria.json');
function cargarMemoria() { try { return JSON.parse(fs.readFileSync(ARCHIVO_MEMORIA, 'utf-8')); } catch (err) { return {}; } }
let memoriaPersistente = cargarMemoria();
let guardadoPendiente = null;
function guardarMemoria() {
  if (guardadoPendiente) clearTimeout(guardadoPendiente);
  guardadoPendiente = setTimeout(() => { fs.writeFile(ARCHIVO_MEMORIA, JSON.stringify(memoriaPersistente), (err) => { if (err) console.log('⚠️ Error guardando memoria:', err.message); }); }, 2000);
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
  // 🆕 v3.4.0: se recorta cada turno al armar el prompt (la memoria guardada no cambia) para no enviar miles de tokens de más.
  const recorte = (t, n) => { const x = String(t == null ? '' : t); return x.length > n ? x.slice(0, n) + '…' : x; };
  return '\n\nHISTORIAL RECIENTE:\n' + lista.map(m => `Dijo: "${recorte(m.texto, 300)}"\nRespondiste: "${recorte(m.respuesta, 450)}"`).join('\n---\n');
}
function olvidarUsuario(jidUsuario) { delete memoriaPersistente[jidUsuario]; guardarMemoria(); }
const contadorMensajesGrupo = new Map();
function registrarMensajeGrupo(jidGrupo, jidUsuario) {
  if (!contadorMensajesGrupo.has(jidGrupo)) contadorMensajesGrupo.set(jidGrupo, new Map());
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  mapa.set(jidUsuario, (mapa.get(jidUsuario) || 0) + 1);
}

const recordatoriosGrupo = [];
function programarRecordatorioGrupo(jidGrupo, milisegundos, texto) { recordatoriosGrupo.push({ jidGrupo, tiempoEjecucion: Date.now() + milisegundos, texto }); }

let botActivo = true;
let sockActivo = null;

const modoJefe = new Map();
const modoNovia = new Map();
const modoAmiga = new Map();
let estiloGlobalExtra = '';
function esCodigoDueño(texto) { return texto.trim() === CODIGO_DUEÑO; }

// 🔧 IMPORTANTE: claveModo ahora espera recibir una IDENTIDAD YA RESUELTA
// (un número real, calculado con resolverNumeroReal) en vez del JID crudo
// del mensaje. Antes se usaba el JID tal cual llegaba, y como WhatsApp a
// veces identifica a la misma persona con un @lid y otras veces con su
// número real (según el mensaje), la clave cambiaba a mitad de conversación
// y el bot "se olvidaba" que el modo amiga/novia estaba activo. Ahora,
// como todos los llamados le pasan un número ya resuelto, la clave es
// siempre la misma para esa persona.
function claveModo(jidChat, identidadResuelta) { return `${jidChat}:${identidadResuelta}`; }
function activarModo(mapaObjetivo, jidChat, identidadResuelta) {
  const clave = claveModo(jidChat, identidadResuelta);
  modoNovia.delete(clave); modoAmiga.delete(clave);
  mapaObjetivo.set(clave, true);
}
function desactivarTodosLosModos(jidChat, identidadResuelta) {
  const clave = claveModo(jidChat, identidadResuelta);
  modoNovia.delete(clave); modoAmiga.delete(clave);
}

function calcularTiempoTecleo(texto) { return Math.min(Math.max(texto.length * 5, 150), 600); }

async function enviarRespuestaHumanizada(sock, jid, texto, mentions) {
  try {
    // 🆕 v3.4.0: sin espera artificial. El "escribiendo..." se envía ya al empezar a pensar la respuesta.
    sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await sock.sendMessage(jid, { text: texto, mentions: mentions || [] });
    sock.sendPresenceUpdate('paused', jid).catch(() => {});
  } catch (err) { console.log('⚠️ Error en envío humanizado:', err.message); }
}

function construirClientesIA() {
  const clientes = [];
  if (CLAVE_IA_PRINCIPAL) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_PRINCIPAL }), modelo: MODELO_PRINCIPAL, nombre: 'principal' });
  if (CLAVE_IA_RESPALDO) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_RESPALDO }), modelo: MODELO_RESPALDO, nombre: 'respaldo' });
  if (CLAVE_IA_RESPALDO2) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_RESPALDO2 }), modelo: MODELO_RESPALDO2, nombre: 'respaldo2' });
  return clientes;
}
const CLIENTES_IA = construirClientesIA();

async function generarRespuestaIA(prompt, notasExtra, jidChat, identidadModo) {
  let reglasFinales = REGLAS_IA_BASE;
  const clave = claveModo(jidChat, identidadModo);
  if (modoNovia.get(clave)) reglasFinales += REGLAS_MODO_NOVIA;
  else if (modoAmiga.get(clave)) reglasFinales += REGLAS_MODO_AMIGA;
  if (estiloGlobalExtra) reglasFinales += `\n\n🔧 DIRECTIVA GLOBAL: ${estiloGlobalExtra}`;
  if (notasExtra) reglasFinales += `\n\nCONTEXTO ADICIONAL: ${notasExtra}`;
  if (cuotaCasiAgotada()) reglasFinales += `\n\n⚠️ Casi al límite del día — sé más breve.`;

  // 🆕 v3.4.0: tiempo límite por cliente, medición de cada solicitud, respaldo sin reintentos duplicados.
  const res = await generarConRespaldo('texto', () => ({ contents: prompt, config: { systemInstruction: reglasFinales, safetySettings: SAFETY_SETTINGS, maxOutputTokens: MAX_TOKENS_RESPUESTA } }), TIMEOUT_IA_TEXTO_MS);
  registrarUsoIA();
  return res.text;
}

// ── ENTENDER AUDIOS — se cita un audio + se menciona al bot ────────────────
function extraerAudioCitado(msg) {
  const citado = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!citado || !citado.audioMessage) return null;
  return citado.audioMessage;
}

async function descargarAudioCitado(audioMessageNode) {
  const stream = await downloadContentFromMessage(audioMessageNode, 'audio');
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  return buffer;
}

// 🆕 Duración máxima de audio que se manda a la IA. Recortar audios muy
// largos antes de subirlos es lo que más acelera la respuesta — no porque
// el audio "pese" menos, sino porque menos segundos de audio = menos datos
// que la IA tiene que procesar internamente.
const DURACION_MAXIMA_AUDIO_IA_SEGUNDOS = 360; // 6 minutos

// 🆕 Comprime y recorta el audio ANTES de mandarlo a la IA. Si algo falla
// en la conversión, se manda el audio original tal cual (nunca se bloquea
// la respuesta por esto).
async function convertirAudioParaIA(bufferOriginal) {
  const idTemp = Date.now();
  const rutaEntrada = path.join(__dirname, `temp_audio_ia_in_${idTemp}.ogg`);
  const rutaSalida = path.join(__dirname, `temp_audio_ia_out_${idTemp}.ogg`);
  try {
    fs.writeFileSync(rutaEntrada, bufferOriginal);
    const cmd = [
      `"${RUTA_FFMPEG_BIN}"`, '-y', '-i', `"${rutaEntrada}"`,
      '-t', String(DURACION_MAXIMA_AUDIO_IA_SEGUNDOS),
      '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k',
      `"${rutaSalida}"`
    ].join(' ');
    await ejecutarComando(cmd, { timeout: 30000 });
    if (fs.existsSync(rutaSalida) && fs.statSync(rutaSalida).size > 500) {
      return { buffer: fs.readFileSync(rutaSalida), mimetype: 'audio/ogg' };
    }
    return { buffer: bufferOriginal, mimetype: null };
  } catch (err) {
    console.log('⚠️ No se pudo comprimir el audio, se envía el original:', err.message.slice(0, 150));
    return { buffer: bufferOriginal, mimetype: null };
  } finally {
    [rutaEntrada, rutaSalida].forEach(r => { if (fs.existsSync(r)) { try { fs.unlinkSync(r); } catch {} } });
  }
}

// 🆕 "Hedging": lanza la tarea principal de inmediato; si no responde dentro
// del retraso indicado, lanza la siguiente EN PARALELO (sin cancelar la
// anterior) y usa la que responda primero. Esto evita que una demora
// puntual de un solo cliente de IA duplique el tiempo de espera del
// usuario, sin gastar de más cuando el principal responde rápido (que es
// el caso normal).
function primeraRespuestaExitosa(tareasFabricas, delayEntreIntentosMs) {
  return new Promise((resolve, reject) => {
    let pendientes = tareasFabricas.length;
    let asentado = false;
    let primerError = null;
    tareasFabricas.forEach((fabrica, indice) => {
      setTimeout(() => {
        if (asentado) return;
        fabrica().then((resultado) => {
          if (!asentado) { asentado = true; resolve(resultado); }
        }).catch((err) => {
          if (!primerError) primerError = err;
          pendientes--;
          if (pendientes === 0 && !asentado) reject(primerError || new Error('Todas las tareas fallaron'));
        });
      }, indice * delayEntreIntentosMs);
    });
  });
}
const RETRASO_HEDGE_AUDIO_MS = 15000;

async function generarRespuestaIAConAudio(bufferAudio, mimetype, promptTexto, notasExtra, jidChat, identidadModo) {
  let reglasFinales = REGLAS_IA_BASE;
  const clave = claveModo(jidChat, identidadModo);
  if (modoNovia.get(clave)) reglasFinales += REGLAS_MODO_NOVIA;
  else if (modoAmiga.get(clave)) reglasFinales += REGLAS_MODO_AMIGA;
  if (notasExtra) reglasFinales += `\n\nCONTEXTO ADICIONAL: ${notasExtra}`;

  const { buffer: bufferListo, mimetype: mimetypeListo } = await convertirAudioParaIA(bufferAudio);
  const mimetypeFinal = mimetypeListo || mimetype || 'audio/ogg';

  const contenido = [{ role: 'user', parts: [
    { inlineData: { mimeType: mimetypeFinal, data: bufferListo.toString('base64') } },
    { text: promptTexto || 'Escucha este audio y respóndeme sobre su contenido.' }
  ] }];

  if (CLIENTES_IA.length === 0) throw new Error('Ningún modelo pudo procesar el audio.');

  const intentar = async (cliente) => {
    const res = await llamarModelo(cliente, { contents: contenido, config: { systemInstruction: reglasFinales, safetySettings: SAFETY_SETTINGS, maxOutputTokens: MAX_TOKENS_RESPUESTA } }, TIMEOUT_IA_AUDIO_MS, 'audio');
    registrarUsoIA();
    return res.text;
  };

  try {
    return await primeraRespuestaExitosa(CLIENTES_IA.map(cliente => () => intentar(cliente)), RETRASO_HEDGE_AUDIO_MS);
  } catch (err) {
    console.log('⚠️ Falló IA con audio en todos los clientes:', err.message);
    throw new Error('Ningún modelo pudo procesar el audio.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 v3.4.0 — VISIÓN: leer fotos, resolver tareas y devolverlas como hoja en imagen
// ═══════════════════════════════════════════════════════════════════════════
const MAX_BYTES_IMAGEN = 12 * 1024 * 1024;
const MAX_CONCURRENTES_VISION = parseInt(process.env.MAX_CONCURRENTES_VISION, 10) || 2;
const VENTANA_IMAGEN_RECIENTE_MS = 10 * 60 * 1000;
const MAX_IMAGENES_RECIENTES_POR_CHAT = 8;
const LOGGER_MEDIA = pino({ level: 'error' });

function crearLimitador(max) {
  let activos = 0;
  const cola = [];
  const siguiente = () => {
    if (activos >= max || !cola.length) return;
    activos++;
    const { tarea, resolver, rechazar } = cola.shift();
    tarea().then(resolver, rechazar).finally(() => { activos--; siguiente(); });
  };
  return (tarea) => new Promise((resolver, rechazar) => { cola.push({ tarea, resolver, rechazar }); siguiente(); });
}
const limitadorVision = crearLimitador(MAX_CONCURRENTES_VISION);
const imagenesEnCurso = new Set();
const imagenesRecientes = new Map();

function aNumero(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  if (typeof v === 'object' && 'low' in v) return (v.low >>> 0) + (v.high || 0) * 4294967296;
  return Number(v) || 0;
}

// Quita envolturas de mensajes temporales / de una sola vista.
function desenvolverContenido(contenido) {
  let c = contenido;
  for (let i = 0; i < 4 && c; i++) {
    const interno = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c.viewOnceMessageV2Extension?.message || c.documentWithCaptionMessage?.message;
    if (!interno) break;
    c = interno;
  }
  return c || {};
}

// contextInfo (menciones, mensaje citado) puede estar en distintos tipos de mensaje (texto, imagen con pie, etc.)
function obtenerContextInfo(msg) {
  const c = desenvolverContenido(msg && msg.message);
  for (const nodo of Object.values(c)) { if (nodo && typeof nodo === 'object' && nodo.contextInfo) return nodo.contextInfo; }
  return null;
}

function esNodoImagen(nodo) { return !!nodo && /^image\//i.test(nodo.mimetype || ''); }

// Devuelve la imagen a la que se refiere el mensaje: la ADJUNTA, o si no hay, la del mensaje CITADO.
function extraerImagenDeMensaje(msg) {
  const c = desenvolverContenido(msg && msg.message);
  if (c.imageMessage) return { origen: 'adjunta', nodo: c.imageMessage, msg };
  if (esNodoImagen(c.documentMessage)) return { origen: 'adjunta', nodo: c.documentMessage, msg, esDocumento: true };
  const ctx = obtenerContextInfo(msg);
  const citado = desenvolverContenido(ctx && ctx.quotedMessage);
  const base = { origen: 'citada', idCitado: ctx && ctx.stanzaId, participanteCitado: ctx && ctx.participant, jidChat: msg.key && msg.key.remoteJid };
  if (citado.imageMessage) return { ...base, nodo: citado.imageMessage };
  if (esNodoImagen(citado.documentMessage)) return { ...base, nodo: citado.documentMessage, esDocumento: true };
  return null;
}

function mismaPersona(a, b) {
  const na = extraerNumero(a), nb = extraerNumero(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return (MAPA_LID_A_NUMERO.get(na) || na) === (MAPA_LID_A_NUMERO.get(nb) || nb);
}

// Guarda la referencia (NO la imagen) de las fotos recientes, para el caso "envío foto y luego escribo la pregunta".
function registrarImagenSiCorresponde(msg) {
  const c = desenvolverContenido(msg.message);
  if (!(c.imageMessage || esNodoImagen(c.documentMessage))) return;
  const chat = msg.key.remoteJid;
  const quien = msg.key.participant || msg.key.remoteJid;
  const ahora = Date.now();
  let lista = (imagenesRecientes.get(chat) || []).filter(x => ahora - x.fecha < VENTANA_IMAGEN_RECIENTE_MS);
  lista.push({ msg, quien, fecha: ahora });
  if (lista.length > MAX_IMAGENES_RECIENTES_POR_CHAT) lista = lista.slice(-MAX_IMAGENES_RECIENTES_POR_CHAT);
  imagenesRecientes.set(chat, lista);
}
setInterval(() => {
  const ahora = Date.now();
  for (const [chat, lista] of imagenesRecientes) {
    const vigentes = lista.filter(x => ahora - x.fecha < VENTANA_IMAGEN_RECIENTE_MS);
    if (vigentes.length) imagenesRecientes.set(chat, vigentes); else imagenesRecientes.delete(chat);
  }
}, 5 * 60 * 1000).unref();

function buscarImagenReciente(jidChat, jidUsuario) {
  const ahora = Date.now();
  const lista = imagenesRecientes.get(jidChat) || [];
  for (let i = lista.length - 1; i >= 0; i--) {
    const x = lista[i];
    if (ahora - x.fecha >= VENTANA_IMAGEN_RECIENTE_MS) continue;
    if (!mismaPersona(x.quien, jidUsuario)) continue;
    const c = desenvolverContenido(x.msg.message);
    return { origen: 'reciente', nodo: c.imageMessage || c.documentMessage, msg: x.msg, esDocumento: !c.imageMessage };
  }
  return null;
}

function detectarMimeImagen(b) {
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('ascii') === 'ftyp') {
    const marca = b.subarray(8, 12).toString('ascii');
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(marca)) return 'image/heic';
    if (marca === 'heif') return 'image/heif';
  }
  return null;
}

function errorConCodigo(mensaje, codigo) { const e = new Error(mensaje); e.codigo = codigo; return e; }

async function descargarImagenWhatsApp(ref) {
  const declarado = aNumero(ref.nodo && ref.nodo.fileLength);
  if (declarado > MAX_BYTES_IMAGEN) throw errorConCodigo(`La imagen pesa ${Math.round(declarado / 1048576)} MB`, 'IMAGEN_GRANDE');

  // Si la imagen citada está en el almacén de mensajes recientes, se usa el mensaje completo (permite re-pedir medios caducados).
  let mensajeCompleto = ref.msg || null;
  if (!mensajeCompleto && ref.origen === 'citada' && ref.idCitado && almacenMensajes.has(ref.idCitado)) {
    mensajeCompleto = { key: { remoteJid: ref.jidChat, id: ref.idCitado, participant: ref.participanteCitado, fromMe: false }, message: almacenMensajes.get(ref.idCitado) };
  }
  let buffer;
  try {
    if (mensajeCompleto) {
      buffer = await downloadMediaMessage(mensajeCompleto, 'buffer', {}, { logger: LOGGER_MEDIA, reuploadRequest: sockActivo && sockActivo.updateMediaMessage });
    } else {
      const stream = await downloadContentFromMessage(ref.nodo, ref.esDocumento ? 'document' : 'image');
      const trozos = []; let total = 0;
      for await (const trozo of stream) {
        total += trozo.length;
        if (total > MAX_BYTES_IMAGEN) throw errorConCodigo('La imagen supera el límite de tamaño', 'IMAGEN_GRANDE');
        trozos.push(trozo);
      }
      buffer = Buffer.concat(trozos);
    }
  } catch (err) {
    if (err && err.codigo) throw err;
    throw errorConCodigo(err && err.message ? err.message : 'Fallo de descarga', /404|410|not found|gone|expired|no longer/i.test(String(err && err.message)) ? 'MEDIA_EXPIRADA' : 'MEDIA_DESCARGA');
  }
  if (!buffer || buffer.length < 800) throw errorConCodigo('La imagen descargada está vacía o dañada', 'IMAGEN_CORRUPTA');
  if (buffer.length > MAX_BYTES_IMAGEN) throw errorConCodigo('La imagen supera el límite de tamaño', 'IMAGEN_GRANDE');
  const mime = detectarMimeImagen(buffer);
  if (!mime) throw errorConCodigo('Formato de imagen no reconocido o archivo dañado', 'IMAGEN_CORRUPTA');
  return { buffer, mime };
}

function mensajeErrorImagenParaUsuario(err) {
  const cod = err && err.codigo;
  const c = clasificarError(err);
  if (cod === 'IMAGEN_GRANDE') return '📷 Esa imagen pesa demasiado para procesarla. Envíala como foto normal (más liviana).';
  if (cod === 'IMAGEN_CORRUPTA') return '📷 La imagen llegó dañada o incompleta. ¿Puedes enviarla otra vez?';
  if (cod === 'MEDIA_EXPIRADA') return '📷 Esa foto ya no está disponible en los servidores de WhatsApp (es muy antigua). Envíala de nuevo, por favor.';
  if (cod === 'MEDIA_DESCARGA') return '📷 No pude descargar la foto desde WhatsApp. Inténtalo otra vez en un momento.';
  if (c.categoria === 'cuota') return '💔 Se agotó la cuota de la IA por ahora. Inténtalo de nuevo en unos minutos.';
  if (c.categoria === 'timeout') return '⏳ La IA tardó demasiado en responder. Inténtalo otra vez en un momento.';
  if (c.tipo === 'configuracion') return '🔧 Hay un problema de configuración con la IA; ya avisé al propietario.';
  if (c.categoria === 'contenido_bloqueado') return '🚫 No pude analizar esa imagen por las políticas de seguridad del modelo.';
  return '💔 No pude procesar esa foto, intenta de nuevo.';
}

const REGLAS_VISION = `\n\n📷 IMAGEN ADJUNTA: te enviaron una imagen junto con una petición. Analízala de verdad y responde sobre su contenido real. Si hay texto, números, operaciones o ejercicios, léelos con exactitud. Si algo no se distingue (borroso, cortado, oscuro), NO lo inventes: dilo y pide una foto más clara. Responde en español salvo que pidan otro idioma.`;

async function generarRespuestaIAConImagen(bufferImagen, mimeType, promptTexto, notasExtra, jidChat, identidadModo) {
  let reglas = REGLAS_IA_BASE;
  const clave = claveModo(jidChat, identidadModo);
  if (modoNovia.get(clave)) reglas += REGLAS_MODO_NOVIA;
  else if (modoAmiga.get(clave)) reglas += REGLAS_MODO_AMIGA;
  if (estiloGlobalExtra) reglas += `\n\n🔧 DIRECTIVA GLOBAL: ${estiloGlobalExtra}`;
  if (notasExtra) reglas += `\n\nCONTEXTO ADICIONAL: ${notasExtra}`;
  reglas += REGLAS_VISION;
  const contenido = [{ role: 'user', parts: [
    { inlineData: { mimeType, data: bufferImagen.toString('base64') } },
    { text: promptTexto || 'Describe y explica esta imagen.' }
  ] }];
  const res = await generarConRespaldo('vision', () => ({ contents: contenido, config: { systemInstruction: reglas, safetySettings: SAFETY_SETTINGS, maxOutputTokens: MAX_TOKENS_RESPUESTA * 2 } }), TIMEOUT_IA_VISION_MS);
  registrarUsoIA();
  return res.text;
}

async function resolverTareaConIA(bufferImagen, mimeType, instruccion, opciones) {
  const prompt = MODULO_TAREA.construirPromptTarea(instruccion, opciones);
  const contenido = [{ role: 'user', parts: [
    { inlineData: { mimeType, data: bufferImagen.toString('base64') } },
    { text: prompt }
  ] }];
  const res = await generarConRespaldo('tarea', () => ({ contents: contenido, config: {
    systemInstruction: `Eres ${NOMBRE_BOT}, una tutora virtual muy precisa. Lees fotos de tareas, no inventas datos que no se vean y devuelves exactamente el JSON pedido.`,
    safetySettings: SAFETY_SETTINGS, maxOutputTokens: 8192, temperature: 0.2, responseMimeType: 'application/json'
  } }), TIMEOUT_IA_VISION_MS);
  registrarUsoIA();
  const obj = MODULO_TAREA.extraerJSON(res.text);
  return { crudo: res.text, resultado: obj ? MODULO_TAREA.normalizarResultado(obj) : null };
}

async function enviarTextoPartido(sock, jidChat, partes, citado) {
  for (let i = 0; i < partes.length; i++) {
    await sock.sendMessage(jidChat, { text: partes[i] }, i === 0 && citado ? { quoted: citado } : undefined);
  }
}

// Devuelve true si el mensaje se atendió como imagen (y no debe seguir al flujo de texto).
async function manejarImagenIA(sock, msg, ctx) {
  const { jidChat, jidUsuario, identidadModo, nombreContacto, consulta, esGrupo } = ctx;
  let ref = extraerImagenDeMensaje(msg);
  // "genera una imagen de..." es una petición de crear, no de leer una foto reciente.
  if (!ref && MODULO_TAREA && !RE_GENERAR_IMAGEN.test(consulta || '') && MODULO_TAREA.refiereAImagenReciente(consulta)) ref = buscarImagenReciente(jidChat, jidUsuario);
  if (!ref) return false;

  const claveEnCurso = `${jidChat}:${identidadModo}`;
  if (imagenesEnCurso.has(claveEnCurso)) { await sock.sendMessage(jidChat, { text: '⏳ Ya estoy trabajando en tu foto anterior, dame un momentito 🙏' }); return true; }
  imagenesEnCurso.add(claveEnCurso);
  const t0 = Date.now();
  try {
    const intencion = MODULO_TAREA ? MODULO_TAREA.detectarIntencionImagen(consulta) : { tarea: false, hoja: false, leer: false };
    sock.sendPresenceUpdate('composing', jidChat).catch(() => {});
    if (intencion.tarea) await sock.sendMessage(jidChat, { text: intencion.hoja ? '📸 Leyendo tu foto y preparando la hoja con la solución... puede tardar un poquito ✍️' : '📸 Leyendo tu foto y resolviendo... un momentito ✍️' });

    let descarga;
    try { descarga = await descargarImagenWhatsApp(ref); }
    catch (err) {
      registrarEventoDiag('descarga_imagen', err, Date.now() - t0);
      console.log(`⚠️ [Imagen] fallo de descarga (${err.codigo || 'sin código'}): ${sanitizarParaLog(err.message)}`);
      await sock.sendMessage(jidChat, { text: mensajeErrorImagenParaUsuario(err) });
      return true;
    }
    const msDescarga = Date.now() - t0;

    await limitadorVision(async () => {
      const t1 = Date.now();
      try {
        if (!intencion.tarea) {
          const notas = `Mensaje de ${nombreContacto}${esGrupo ? ' en un grupo de WhatsApp' : ' en privado'}, con una imagen adjunta.`;
          const respuesta = await generarRespuestaIAConImagen(descarga.buffer, descarga.mime, consulta || 'Lee la imagen y explícame su contenido.', notas, jidChat, identidadModo);
          await enviarRespuestaHumanizada(sock, jidChat, respuesta, esGrupo ? [jidUsuario] : []);
          agregarAMemoriaCorta(jidUsuario, `[imagen] ${consulta}`.slice(0, 300), String(respuesta).slice(0, 300));
          console.log(`⏱️ [Imagen:lectura] descarga=${msDescarga} ms ia=${Date.now() - t1} ms total=${Date.now() - t0} ms`);
          return;
        }
        const { crudo, resultado } = await resolverTareaConIA(descarga.buffer, descarga.mime, consulta, { solicitaGraficos: /gr[aá]fic|dibuj|figura/i.test(consulta) || intencion.hoja });
        const msIA = Date.now() - t1;
        if (!resultado) {
          // El modelo no devolvió JSON usable: se entrega su texto tal cual en lugar de inventar nada.
          registrarEventoDiag('tarea_json', new Error('La IA no devolvió JSON válido'), msIA);
          await enviarTextoPartido(sock, jidChat, [String(crudo).slice(0, 3500)], msg);
          return;
        }
        if (!resultado.legible) {
          await sock.sendMessage(jidChat, { text: `📷 No pude leer bien la foto${resultado.motivoIlegible ? `: ${resultado.motivoIlegible}` : ''}.\nEnvíame otra más clara: bien enfocada, con buena luz y con todo el ejercicio dentro del encuadre.` }, { quoted: msg });
          return;
        }
        if (!resultado.ejercicios.length) {
          await sock.sendMessage(jidChat, { text: '🤔 No encontré ejercicios claros en esa foto. ¿Puedes enviarla más de cerca o indicarme qué quieres que haga?' }, { quoted: msg });
          return;
        }
        const ver = MODULO_TAREA.verificarEjercicios(resultado);
        console.log(`🧮 [Tarea] ejercicios=${resultado.ejercicios.length} comprobaciones=${ver.comprobadas} discrepancias=${ver.discrepancias}`);

        let hojaEnviada = false;
        if (intencion.hoja && MODULO_HOJA) {
          const t2 = Date.now();
          try {
            const datos = MODULO_TAREA.datosParaHoja(resultado, { pie: `${NOMBRE_BOT} v${VERSION_BOT}`, subtitulo: `Resuelta por ${NOMBRE_BOT}` });
            const hoja = await MODULO_HOJA.renderizarHoja(datos);
            for (let i = 0; i < hoja.paginas.length; i++) {
              const pie = ver.discrepancias ? ' ⚠️ Revisa los ejercicios marcados.' : '';
              await sock.sendMessage(jidChat, { image: hoja.paginas[i], caption: `📚 Tarea resuelta (hoja ${i + 1}/${hoja.paginas.length}${hoja.truncado ? '+' : ''})${pie}` }, i === 0 ? { quoted: msg } : undefined);
            }
            if (hoja.truncado) await sock.sendMessage(jidChat, { text: `ℹ️ La solución es muy larga: te envié las primeras ${hoja.paginas.length} hojas de ${hoja.totalPaginas}. Pídeme "solo los ejercicios X a Y" para el resto.` });
            hojaEnviada = true;
            console.log(`⏱️ [Tarea:hoja] páginas=${hoja.paginas.length} render=${Date.now() - t2} ms`);
          } catch (err) {
            registrarEventoDiag('hoja_render', err, Date.now() - t2);
            console.log(`⚠️ [Tarea:hoja] fallo: ${sanitizarParaLog(err.message)}`);
            await sock.sendMessage(jidChat, { text: err.codigo === 'SHARP_NO_DISPONIBLE' ? '🧩 Todavía no puedo dibujar hojas en imagen (falta instalar "sharp" en el servidor). Te la mando en texto:' : '🧩 No pude armar la hoja en imagen esta vez. Te la mando en texto:' });
          }
        } else if (intencion.hoja && !MODULO_HOJA) {
          await sock.sendMessage(jidChat, { text: '🧩 La función de hojas en imagen no está instalada todavía. Te la mando en texto:' });
        }
        if (!hojaEnviada) await enviarTextoPartido(sock, jidChat, MODULO_TAREA.formatearSolucionTexto(resultado), msg);
        agregarAMemoriaCorta(jidUsuario, `[tarea en foto] ${consulta}`.slice(0, 300), `Resolví ${resultado.ejercicios.length} ejercicio(s).`);
        console.log(`⏱️ [Tarea] descarga=${msDescarga} ms ia=${msIA} ms total=${Date.now() - t0} ms`);
      } catch (err) {
        registrarEventoDiag('procesar_imagen', err, Date.now() - t1);
        console.log(`❌ [Imagen] error: ${sanitizarParaLog(err.message)}`);
        avisarPropietarioSiConfiguracion(sock, err, 'imagen');
        await sock.sendMessage(jidChat, { text: mensajeErrorImagenParaUsuario(err) });
      }
    });
    return true;
  } finally {
    imagenesEnCurso.delete(claveEnCurso);
    sock.sendPresenceUpdate('paused', jidChat).catch(() => {});
  }
}

// ── Herramientas autorizadas en lenguaje natural ─────────────────────────────
// La IA NO ejecuta código ni comandos: estas frases se traducen a acciones explícitas de una lista fija.
// Las acciones sensibles solo las puede pedir el propietario real (mismo sistema de autorización de siempre).
const RE_HERR_ESTADO = /\b(estado|informe|status)\b[^.\n]{0,25}\b(bot|anzy|tuyo|de\s+ti)\b|\b(mu[eé]strame|dime|dame|ens[eé][nñ]ame|cu[aá]l\s+es)\b[^.\n]{0,20}\b(estado|informe)\b/i;
const RE_HERR_PROBAR_IA = /\b(comprueba|verifica|revisa|chequea|prueba)\b[^.\n]{0,40}\b(ia|inteligencia|gemini|modelo|api)\b[^.\n]{0,40}\b(funcion\w*|anda|sirve|responde|bien|ok|activ\w*)\b/i;
const RE_HERR_ANALIZAR = /\b(analiza|diagnostica|investiga|revisa|por\s+qu[eé])\b[^.\n]{0,50}\b(fall\w*|error\w*|problema\w*|no\s+responde\w*|lent\w*)\b/i;
const RE_HERR_RESET_ESTILO = /\b(restablece|restaura|resetea|reinicia|quita)\b[^.\n]{0,30}\b(estilo|forma\s+de\s+(hablar|responder|expresar\w*)|respuestas?)\b/i;
const RE_HERR_APAGAR = /\b(desactiva|apaga|det[eé]n|pausa)\s+(el\s+)?(bot|anzy)\b|\b(ap[aá]gate|desact[ií]vate|d[eé]tente)\b|^\s*ap[aá]ga\s*$/i;
const RE_HERR_ENCENDER = /\b(activa|enciende|prende|reactiva)\s+(el\s+)?(bot|anzy)\b|\b(act[ií]vate|enci[eé]ndete|pr[eé]ndete)\b/i;
const RE_GENERAR_IMAGEN = /^(?:por\s+favor\s+)?(?:genera|crea|dibuja|haz|hazme|cr[eé]ame|g[eé]nerame)(?:me)?\s+(?:una\s+)?(?:imagen|foto|dibujo|ilustraci[oó]n)\s+(?:de|del|de\s+la|con|que)\s+(.{3,})$/i;

function generarResumenEstadoPublico() {
  return `📊 *Estado de ${NOMBRE_BOT}* · v${VERSION_BOT}\n\n🟢 Conectada: ${estado.conectado ? 'sí' : 'no'}\n⚙️ Bot activo: ${botActivo ? 'sí' : 'no'}\n⏱ Activa desde hace: ${formatearDuracionLarga(obtenerUptimeMs())}\n_(tiempo del proceso actual)_`;
}

async function ejecutarPruebaIA(sock, jidChat) {
  if (!CLIENTES_IA.length) { await sock.sendMessage(jidChat, { text: '❌ No hay ningún cliente de IA configurado (faltan las claves CLAVE_IA_*).' }); return; }
  await sock.sendMessage(jidChat, { text: '🔎 Probando los clientes de IA, un momento...' });
  const r = await probarClientesIA();
  const lineas = r.map(x => x.ok ? `✅ ${x.nombre}: responde (${x.ms} ms)` : `❌ ${x.nombre}: ${x.categoria} (${x.tipo}) tras ${x.ms} ms`);
  await sock.sendMessage(jidChat, { text: `🤖 *Prueba de IA*\n\n${lineas.join('\n')}\n\n_Modelo configurado: ${MODELO_PRINCIPAL}. Es solo una comprobación; no se cambió nada._` });
}

// true = se atendió como herramienta; false = seguir con el flujo normal de la IA.
async function manejarHerramientasNaturales(sock, { jidChat, jidUsuario, consulta, esGrupo, esDueno, comoPropietarioPrivado }) {
  const t = (consulta || '').trim();
  if (!t) return false;
  if (esPreguntaUptime(t)) { await sock.sendMessage(jidChat, { text: textoUptime() }); return true; }
  const propietario = esDueno;
  if (RE_HERR_ESTADO.test(t)) { await sock.sendMessage(jidChat, { text: propietario ? generarResumenDiagnostico() : generarResumenEstadoPublico() }); return true; }
  if (RE_HERR_APAGAR.test(t) || RE_HERR_ENCENDER.test(t)) {
    if (!propietario) { await sock.sendMessage(jidChat, { text: 'Solo el propietario puede activar o desactivar el bot 🚫' }); return true; }
    const apagar = RE_HERR_APAGAR.test(t);
    botActivo = !apagar;
    await sock.sendMessage(jidChat, { text: apagar ? '🔴 Bot desactivado. (Sigo atendiendo tus órdenes de propietario.)' : '🟢 Bot activado.' });
    return true;
  }
  if (propietario && RE_HERR_PROBAR_IA.test(t)) { await ejecutarPruebaIA(sock, jidChat); return true; }
  if (propietario && RE_HERR_ANALIZAR.test(t)) { await sock.sendMessage(jidChat, { text: generarResumenDiagnostico() }); return true; }
  if (propietario && RE_HERR_RESET_ESTILO.test(t)) { estiloGlobalExtra = ''; await sock.sendMessage(jidChat, { text: '✅ Restablecí el estilo de respuestas a mi forma original.' }); return true; }
  if (propietario && !esGrupo && MODULO_VOZ && await manejarHerramientasVoz(sock, jidChat, t, extraerNumero(jidUsuario))) return true;
  const m = t.match(RE_GENERAR_IMAGEN);
  if (m) { await comandoImagen(sock, jidChat, m[1].trim()); return true; }
  return false;
}


// ═══════════════════════════════════════════════════════════════════════════
// 🆕 v3.5.0 — VOZ HUMANIZADA CON ELEVENLABS (solo el chat privado del propietario)
// ═══════════════════════════════════════════════════════════════════════════
// • Modo texto (predeterminado): los mensajes escritos se responden por texto.
// • Modo voz: se activa/desactiva con lenguaje natural ("quiero escucharte", "vuelve a escribirme").
// • Notas de voz del propietario: SIEMPRE se responden con audio, aunque el modo sea texto.
// • La IA decide QUÉ responder; ElevenLabs solo lo convierte en voz. Si algo falla, se responde por texto.
const VOZ = MODULO_VOZ ? {
  cliente: MODULO_VOZ.crearClienteElevenLabs({ log: (m) => console.log(`🔊 [Voz] ${m}`) }),
  cola: MODULO_VOZ.crearColaPorClave(),
  cache: MODULO_VOZ.crearCacheAudio(),
  limitador: crearLimitador(2)
} : null;
const CHAT_PRIVADO_LIBRE = (process.env.CHAT_PRIVADO_LIBRE || 'true').toLowerCase() !== 'false';
const VOZ_MAX_CARACTERES = Math.min(5000, Math.max(200, parseInt(process.env.VOZ_MAX_CARACTERES, 10) || 1200));
const VOZ_LIMITE_CARACTERES_MES = parseInt(process.env.VOZ_LIMITE_CARACTERES_MES, 10) || 9000;
const ARCHIVO_VOZ_PREFS = path.join(__dirname, 'voz_preferencias.json');
const ARCHIVO_VOZ_USO = path.join(__dirname, 'voz_uso.json');
const GITHUB_RUTA_VOZ = limpiarValorEnv(process.env.GITHUB_RUTA_VOZ) || 'voz_preferencias.json';
const GITHUB_RAMA_VOZ = limpiarValorEnv(process.env.GITHUB_RAMA_VOZ);
const DURACION_MAXIMA_NOTA_VOZ_SEGUNDOS = 360;
const MAX_BYTES_AUDIO = 15 * 1024 * 1024;

const NOTA_MODO_VOZ = `\n\nMODO VOZ: tu respuesta se convertirá en audio y la oirás hablada. Habla como en una conversación real: frases cortas y naturales, unas 4 o 5 frases como máximo (unos 600 caracteres), sin listas, sin markdown, sin emojis, sin enlaces ni paréntesis. Escribe los números y símbolos como se pronuncian si hace falta. No digas que es un audio.`;

const estadoVoz = { bloqueadoHasta: 0, motivoBloqueo: '', avisoBloqueoEnviado: false, ffmpegOpus: null, vozAlternativa: null, mes: '', caracteres: 0, audios: 0, fallos: 0 };
const idsAudioProcesados = new Set();

// ── Preferencias persistentes (local + GitHub, el mismo mecanismo que usas para propietarios) ──
let prefsVoz = { version: 1, usuarios: {} };
let shaVozGithub = null;
let guardadoVozPendiente = null;

function cargarPrefsVozLocal() {
  try { const d = JSON.parse(fs.readFileSync(ARCHIVO_VOZ_PREFS, 'utf-8')); if (d && typeof d.usuarios === 'object') prefsVoz = { version: 1, usuarios: d.usuarios }; } catch { /* primera vez */ }
  try { const u = JSON.parse(fs.readFileSync(ARCHIVO_VOZ_USO, 'utf-8')); if (u && u.mes === mesActualVoz()) { estadoVoz.mes = u.mes; estadoVoz.caracteres = u.caracteres || 0; estadoVoz.audios = u.audios || 0; } } catch { /* sin datos */ }
}
function guardarPrefsVozLocal() { try { fs.writeFileSync(ARCHIVO_VOZ_PREFS, JSON.stringify(prefsVoz, null, 2)); } catch (err) { console.log('⚠️ No se pudo guardar voz_preferencias.json:', err.message); } }
function mesActualVoz() { return new Date().toISOString().slice(0, 7); }
function registrarUsoVoz(caracteres) {
  const mes = mesActualVoz();
  if (estadoVoz.mes !== mes) { estadoVoz.mes = mes; estadoVoz.caracteres = 0; estadoVoz.audios = 0; }
  estadoVoz.caracteres += caracteres; estadoVoz.audios++;
  try { fs.writeFileSync(ARCHIVO_VOZ_USO, JSON.stringify({ mes: estadoVoz.mes, caracteres: estadoVoz.caracteres, audios: estadoVoz.audios })); } catch { /* el uso local es solo orientativo */ }
}
function obtenerPrefVoz(numero) { return (prefsVoz.usuarios[numero]) || { modo: 'texto' }; }
function establecerPrefVoz(numero, cambios) {
  prefsVoz.usuarios[numero] = { ...obtenerPrefVoz(numero), ...cambios, actualizado: new Date().toISOString() };
  guardarPrefsVozLocal();
  programarGuardadoVozNube();
}

function cabecerasGithub() { return { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }; }
function ramaVoz() { return GITHUB_RAMA_VOZ || GITHUB_RAMA; }
async function githubLeerPrefsVoz() {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_VOZ)}?ref=${ramaVoz()}`, { headers: cabecerasGithub() });
  if (res.status === 404) { shaVozGithub = null; return null; }
  if (!res.ok) throw new Error(`No se pudo leer las preferencias de voz de GitHub (${res.status})`);
  const data = await res.json();
  shaVozGithub = data.sha;
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
}
async function githubGuardarPrefsVoz(reintento = false) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_VOZ)}`;
  const body = { message: `Preferencias de voz — ${new Date().toISOString()}`, content: Buffer.from(JSON.stringify(prefsVoz, null, 2)).toString('base64'), branch: ramaVoz() };
  if (shaVozGithub) body.sha = shaVozGithub;
  const res = await fetch(url, { method: 'PUT', headers: { ...cabecerasGithub(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if ((res.status === 409 || res.status === 422) && !reintento) { await githubLeerPrefsVoz(); return githubGuardarPrefsVoz(true); }
  if (!res.ok) throw new Error(`No se pudieron guardar las preferencias de voz en GitHub (${res.status})`);
  shaVozGithub = (await res.json()).content.sha;
}
function programarGuardadoVozNube() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (guardadoVozPendiente) clearTimeout(guardadoVozPendiente);
  guardadoVozPendiente = setTimeout(async () => {
    guardadoVozPendiente = null;
    try { await githubGuardarPrefsVoz(); console.log('☁️ Preferencias de voz guardadas en GitHub.'); }
    catch (err) { registrarEventoDiag('voz_prefs_github', err); console.log('⚠️', sanitizarParaLog(err.message)); }
  }, 2000);
}

function verificarFfmpegOpus() {
  return new Promise((resolve) => {
    require('child_process').execFile(RUTA_FFMPEG_BIN, ['-hide_banner', '-encoders'], { timeout: 15000 }, (err, stdout) => {
      estadoVoz.ffmpegOpus = !err && /libopus/.test(String(stdout));
      console.log(estadoVoz.ffmpegOpus ? '🔊 ffmpeg con libopus disponible: las respuestas se enviarán como notas de voz.' : `⚠️ ffmpeg/libopus NO disponible${err ? ` (${sanitizarParaLog(err.message)})` : ''}: las respuestas de voz se enviarán como audio normal (mp3), no como nota de voz.`);
      resolve(estadoVoz.ffmpegOpus);
    });
  });
}

async function inicializarVoz() {
  if (!VOZ) { console.log('⚠️ lib/voz.js no disponible — la voz está desactivada.'); return; }
  cargarPrefsVozLocal();
  if (!VOZ.cliente.configurado()) console.log('⚠️ ELEVENLABS_API_KEY no está definida: el modo voz está desactivado (el resto del bot funciona igual).');
  else console.log(`🔊 Voz lista: modelo ${VOZ.cliente.modelo()} · voz ${process.env.ELEVENLABS_VOICE_ID ? 'configurada en ELEVENLABS_VOICE_ID' : 'predeterminada (premade)'} · límite local ${VOZ_LIMITE_CARACTERES_MES} caracteres/mes.`);
  if (GITHUB_TOKEN && GITHUB_REPO) {
    try {
      const nube = await githubLeerPrefsVoz();
      if (nube && typeof nube.usuarios === 'object') { prefsVoz = { version: 1, usuarios: nube.usuarios }; guardarPrefsVozLocal(); console.log('☁️ Preferencias de voz cargadas desde GitHub.'); }
      else if (Object.keys(prefsVoz.usuarios).length) await githubGuardarPrefsVoz();
    } catch (err) { console.log('⚠️ No se pudo sincronizar las preferencias de voz con GitHub:', sanitizarParaLog(err.message)); }
  } else console.log('⚠️ Sin GitHub configurado: el modo voz elegido se perderá cuando Render reinicie el servicio.');
  if (VOZ.cliente.configurado()) await verificarFfmpegOpus();
}

// ── Generación y envío ──────────────────────────────────────────────────────
async function elegirVozAlternativa(excluir) {
  try {
    const voces = await VOZ.cliente.listarVoces();
    const candidatas = voces.filter(v => v.id !== excluir && (v.genero || '').toLowerCase() === 'female' && /premade|generated/i.test(v.categoria || 'premade'));
    return (candidatas.find(v => v.espanol) || candidatas[0] || {}).id || null;
  } catch (err) { registrarEventoDiag('voz_listar', err); return null; }
}

function marcarBloqueoVoz(minutos, motivo) { estadoVoz.bloqueadoHasta = Date.now() + minutos * 60000; estadoVoz.motivoBloqueo = motivo; estadoVoz.avisoBloqueoEnviado = false; }

// Devuelve { buffer, mimetype, ptt, caracteres } o lanza un error clasificado.
async function sintetizarParaWhatsApp(textoHablado, numero) {
  const preferida = (obtenerPrefVoz(numero).voiceId) || estadoVoz.vozAlternativa || undefined;
  const claveCache = VOZ.cache.clave(preferida || process.env.ELEVENLABS_VOICE_ID || 'defecto', VOZ.cliente.modelo(), textoHablado);
  let ogg = VOZ.cache.get(claveCache);
  let mp3 = null;
  if (!ogg) {
    const t0 = Date.now();
    mp3 = await VOZ.limitador(async () => {
      try { return await VOZ.cliente.sintetizar(textoHablado, { voiceId: preferida }); }
      catch (err) {
        if (err.categoriaVoz === 'plan' || err.categoriaVoz === 'voz_no_encontrada') {
          const alternativa = await elegirVozAlternativa(preferida || process.env.ELEVENLABS_VOICE_ID || MODULO_VOZ.VOZ_PREDETERMINADA);
          if (!alternativa) throw err;
          console.log('🔊 [Voz] la voz configurada no está disponible en tu plan; se usa otra voz premade de tu cuenta.');
          const buffer = await VOZ.cliente.sintetizar(textoHablado, { voiceId: alternativa });
          estadoVoz.vozAlternativa = alternativa;
          return buffer;
        }
        throw err;
      }
    });
    registrarLatencia('voz_elevenlabs', Date.now() - t0, true);
    registrarUsoVoz(Math.round(textoHablado.length * (/flash|turbo/i.test(VOZ.cliente.modelo()) ? 0.5 : 1)));
    if (estadoVoz.ffmpegOpus !== false) {
      try { ogg = await MODULO_VOZ.convertirMp3AOpus(mp3, RUTA_FFMPEG_BIN); VOZ.cache.set(claveCache, ogg); }
      catch (err) { registrarEventoDiag('voz_ffmpeg', err); console.log(`⚠️ [Voz] conversión a Opus fallida: ${sanitizarParaLog(err.message)}`); }
    }
  }
  if (ogg) return { buffer: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true, caracteres: textoHablado.length };
  // Sin Opus válido NO se envía como nota de voz: se manda como audio normal (mp3 real).
  return { buffer: mp3, mimetype: 'audio/mpeg', ptt: false, caracteres: textoHablado.length };
}

// Responde con voz; si algo falla, responde por texto (nunca deja al propietario sin respuesta).
async function responderConVoz(sock, jid, textoRespuesta, numero) {
  const comoTexto = async (aviso) => { await enviarRespuestaHumanizada(sock, jid, textoRespuesta, []); if (aviso) await sock.sendMessage(jid, { text: aviso }); return false; };
  if (!VOZ || !VOZ.cliente.configurado()) return comoTexto('🔇 Aún no tengo configurada la voz (falta ELEVENLABS_API_KEY en Render), así que te respondo por texto.');
  if (Date.now() < estadoVoz.bloqueadoHasta) {
    const aviso = estadoVoz.avisoBloqueoEnviado ? null : `🔇 ${estadoVoz.motivoBloqueo} Te respondo por texto por ahora.`;
    estadoVoz.avisoBloqueoEnviado = true;
    return comoTexto(aviso);
  }
  const hablable = MODULO_VOZ.prepararTextoParaVoz(textoRespuesta);
  if (!hablable) return comoTexto(null);
  if (estadoVoz.mes === mesActualVoz() && estadoVoz.caracteres + hablable.length > VOZ_LIMITE_CARACTERES_MES) {
    marcarBloqueoVoz(360, 'Llegué al límite de voz que configuré para este mes (para cuidar tu plan gratuito).');
    return comoTexto('🔇 Llegué al límite de voz que configuré para este mes (VOZ_LIMITE_CARACTERES_MES). Te respondo por texto.');
  }
  const { hablado, resto } = MODULO_VOZ.recortarParaVoz(hablable, VOZ_MAX_CARACTERES);
  try {
    const nota = await VOZ.cola(jid, async () => {
      sock.sendPresenceUpdate('recording', jid).catch(() => {});
      const resultado = await sintetizarParaWhatsApp(hablado, numero);
      await sock.sendMessage(jid, { audio: resultado.buffer, mimetype: resultado.mimetype, ptt: resultado.ptt });
      return resultado;
    });
    sock.sendPresenceUpdate('paused', jid).catch(() => {});
    console.log(`🔊 [Voz] audio enviado (${nota.ptt ? 'nota de voz Ogg/Opus' : 'audio mp3'}, ${nota.caracteres} caracteres, ${nota.buffer.length} bytes)`);
    if (resto) await sock.sendMessage(jid, { text: `📝 El resto te lo dejo escrito:\n\n${resto}` });
    return true;
  } catch (err) {
    estadoVoz.fallos++;
    registrarEventoDiag('voz_elevenlabs', err);
    console.log(`⚠️ [Voz] fallo (${err.categoriaVoz || 'sin categoría'}): ${sanitizarParaLog(err.message)}`);
    avisarPropietarioSiConfiguracion(sock, err, 'voz');
    if (err.categoriaVoz === 'cuota') marcarBloqueoVoz(60, 'Se acabó el crédito de voz de ElevenLabs.');
    else if (err.categoriaVoz === 'autenticacion' || err.categoriaVoz === 'plan' || err.categoriaVoz === 'sin_clave') marcarBloqueoVoz(30, 'Hay un problema de configuración con la voz.');
    sock.sendPresenceUpdate('paused', jid).catch(() => {});
    const motivo = { cuota: 'Se acabó el crédito de voz de ElevenLabs', autenticacion: 'La clave de ElevenLabs no es válida', plan: 'Esa voz no está disponible en tu plan de ElevenLabs', timeout: 'ElevenLabs tardó demasiado' }[err.categoriaVoz] || 'No pude generar el audio';
    return comoTexto(`🔇 ${motivo}; te respondo por texto.`);
  }
}

// ── Instrucciones naturales: cambiar entre texto y voz ─────────────────────
async function clasificarInstruccionModoConIA(texto) {
  try {
    const prompt = `Eres un clasificador. Una persona habla con su asistente por WhatsApp. Decide si el mensaje es una INSTRUCCIÓN PERMANENTE dirigida al asistente sobre cómo debe responderle de ahora en adelante: "voz" (responder hablando / con audios), "texto" (responder escribiendo) o "ninguna". Si es una pregunta, una mención casual de las palabras voz/audio/hablar/escribir, un tema de conversación, una petición puntual o algo ambiguo, responde "ninguna".\nMensaje: """${texto.slice(0, 220)}"""\nResponde SOLO con JSON: {"accion":"voz"|"texto"|"ninguna"}`;
    const res = await generarConRespaldo('modo_voz', () => ({ contents: prompt, config: { maxOutputTokens: 40, temperature: 0, responseMimeType: 'application/json' } }), 12000);
    let obj = null; try { obj = JSON.parse(res.text); } catch { obj = MODULO_TAREA ? MODULO_TAREA.extraerJSON(res.text) : null; }
    const accion = (obj || {}).accion;
    return accion === 'voz' || accion === 'texto' ? accion : null;
  } catch { return null; }
}

// Devuelve true si el mensaje era una instrucción de modo (y ya se respondió).
async function manejarCambioModoVoz(sock, jid, texto, numero) {
  if (!VOZ) return false;
  let cambio = MODULO_VOZ.detectarCambioModoVoz(texto);
  if (!cambio && MODULO_VOZ.podriaSerInstruccionDeModo(texto)) cambio = await clasificarInstruccionModoConIA(texto);
  if (!cambio) return false;
  if (cambio === 'voz') {
    if (!VOZ.cliente.configurado()) { await sock.sendMessage(jid, { text: '🔇 Todavía no puedo hablar: falta configurar ELEVENLABS_API_KEY en Render. Sigo respondiéndote por texto.' }); return true; }
    establecerPrefVoz(numero, { modo: 'voz' });
    await responderConVoz(sock, jid, '¡Listo! Desde ahora te respondo hablando. Si quieres volver a leerme, solo dímelo.', numero);
  } else {
    establecerPrefVoz(numero, { modo: 'texto' });
    await sock.sendMessage(jid, { text: 'Listo, vuelvo a escribirte ✍️ Si me mandas una nota de voz, te sigo respondiendo con audio.' });
  }
  return true;
}

// ── Notas de voz del propietario → respuesta hablada automática ─────────────
async function manejarNotaDeVozPropietario(sock, msg, remitente) {
  const audio = desenvolverContenido(msg.message).audioMessage;
  if (!audio || !audio.ptt) return false;                       // solo notas de voz, no música ni archivos de audio
  if (idsAudioProcesados.has(msg.key.id)) return true;
  idsAudioProcesados.add(msg.key.id);
  if (idsAudioProcesados.size > 500) idsAudioProcesados.delete(idsAudioProcesados.values().next().value);
  const numero = extraerNumero(remitente);
  const t0 = Date.now();
  sock.sendPresenceUpdate('recording', remitente).catch(() => {});
  if (aNumero(audio.seconds) > DURACION_MAXIMA_NOTA_VOZ_SEGUNDOS) { await sock.sendMessage(remitente, { text: '⏱️ Esa nota de voz es demasiado larga para escucharla entera (máximo 6 minutos). ¿Me la mandas en partes?' }); return true; }
  if (aNumero(audio.fileLength) > MAX_BYTES_AUDIO) { await sock.sendMessage(remitente, { text: '📦 Esa nota de voz pesa demasiado. ¿Me la mandas más corta?' }); return true; }
  let buffer;
  try {
    buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: LOGGER_MEDIA, reuploadRequest: sockActivo && sockActivo.updateMediaMessage });
    if (!buffer || buffer.length < 200 || buffer.length > MAX_BYTES_AUDIO) throw errorConCodigo('Audio vacío o demasiado grande', 'MEDIA_DESCARGA');
  } catch (err) {
    registrarEventoDiag('descarga_audio', err, Date.now() - t0);
    await sock.sendMessage(remitente, { text: '💔 No pude descargar tu nota de voz. ¿Me la mandas otra vez?' });
    return true;
  }
  try {
    const notas = `Mensaje privado de tu PROPIETARIO/CREADOR (${msg.pushName || 'propietario'}), enviado como NOTA DE VOZ.${obtenerContextoCorto(remitente)}${NOTA_MODO_VOZ}`;
    const respuesta = await generarRespuestaIAConAudio(buffer, audio.mimetype || 'audio/ogg', 'Escucha esta nota de voz y respóndeme de forma natural y conversacional, como si hablaras.', notas, remitente, numero);
    const msIA = Date.now() - t0;
    await responderConVoz(sock, remitente, respuesta, numero);
    agregarAMemoriaCorta(remitente, '[nota de voz]', String(respuesta).slice(0, 300));
    console.log(`⏱️ [NotaDeVoz] ia=${msIA} ms total=${Date.now() - t0} ms`);
  } catch (err) {
    registrarEventoDiag('nota_de_voz_ia', err, Date.now() - t0);
    console.log(`❌ [NotaDeVoz] ${sanitizarParaLog(err.message)}`);
    avisarPropietarioSiConfiguracion(sock, err, 'nota_de_voz');
    await sock.sendMessage(remitente, { text: '💔 No pude entender tu nota de voz, ¿me la repites?' });
  }
  return true;
}

// ── Herramientas del propietario relacionadas con la voz (lenguaje natural) ─
const RE_VOZ_LISTAR = /\b(lista|listame|mu[eé]strame|muestra|dime|cu[aá]les)\b[^.\n]{0,30}\b(voces)\b/i;
const RE_VOZ_USAR = /\b(usa|utiliza|cambia|pon|elige|ponte)\b[^.\n]{0,25}\bvoz\b(?:\s+(?:de|a|llamada|como|con\s+id|id))?\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9]{3,40})\s*[.!]?\s*$/i;
const RE_VOZ_CREDITOS = /\b(cr[eé]ditos?|cuota|cu[aá]nto)\b[^.\n]{0,30}\b(voz|elevenlabs|audios?)\b|\b(voz|elevenlabs)\b[^.\n]{0,30}\b(cr[eé]ditos?|cuota|queda\w*)\b/i;
const RE_VOZ_PRUEBA = /\b(prueba|probar)\b[^.\n]{0,10}\b(tu\s+)?voz\b|\bdi\s+algo\s+con\s+tu\s+voz\b|\bsuena\s+tu\s+voz\b/i;

async function manejarHerramientasVoz(sock, jid, texto, numero) {
  if (!VOZ) return false;
  if (RE_VOZ_PRUEBA.test(texto)) {
    await responderConVoz(sock, jid, 'Hola, soy yo, con mi voz. Si me escuchas bien, ya estamos listos para conversar.', numero);
    return true;
  }
  if (RE_VOZ_LISTAR.test(texto)) {
    if (!VOZ.cliente.configurado()) { await sock.sendMessage(jid, { text: '🔇 Falta ELEVENLABS_API_KEY en Render.' }); return true; }
    try {
      const voces = await VOZ.cliente.listarVoces();
      const lineas = voces.slice(0, 25).map(v => `• ${v.nombre} — ${[v.genero, v.edad, v.acento, v.espanol ? 'español verificado' : ''].filter(Boolean).join(', ') || v.categoria}\n  id: ${v.id}`);
      await sock.sendMessage(jid, { text: `🎙️ *Voces de tu cuenta* (${voces.length}):\n\n${lineas.join('\n')}\n\nPara elegir una dime, por ejemplo: "usa la voz Nombre". ${(obtenerPrefVoz(numero).voiceId) ? '' : 'Ahora uso la configurada en Render o la predeterminada.'}\n_En el plan gratuito, la API solo deja usar algunas voces._` });
    } catch (err) { registrarEventoDiag('voz_listar', err); await sock.sendMessage(jid, { text: `❌ No pude listar las voces (${err.categoriaVoz || 'error'}). Si tu clave no tiene permiso "voices_read", pon el ID de la voz directamente en ELEVENLABS_VOICE_ID.` }); }
    return true;
  }
  const mUsar = texto.match(RE_VOZ_USAR);
  if (mUsar) {
    const pedido = mUsar[2];
    try {
      const voces = await VOZ.cliente.listarVoces();
      const encontrada = voces.find(v => v.id === pedido) || voces.find(v => (v.nombre || '').toLowerCase().split(/[\s\-–]/)[0] === pedido.toLowerCase()) || voces.find(v => (v.nombre || '').toLowerCase().includes(pedido.toLowerCase()));
      if (!encontrada) { await sock.sendMessage(jid, { text: `No encontré una voz llamada "${pedido}" en tu cuenta. Pídeme "lista las voces" para ver las disponibles.` }); return true; }
      establecerPrefVoz(numero, { voiceId: encontrada.id });
      estadoVoz.vozAlternativa = null;
      await responderConVoz(sock, jid, `Listo, ahora hablo con la voz ${encontrada.nombre.split(/[\s\-–]/)[0]}. ¿Qué tal suena?`, numero);
    } catch (err) { registrarEventoDiag('voz_listar', err); await sock.sendMessage(jid, { text: '❌ No pude consultar tus voces en este momento.' }); }
    return true;
  }
  if (RE_VOZ_CREDITOS.test(texto)) {
    const local = `Uso local este mes: ≈ ${estadoVoz.caracteres} caracteres en ${estadoVoz.audios} audio(s) (límite que configuré: ${VOZ_LIMITE_CARACTERES_MES}).`;
    try {
      const s = await VOZ.cliente.suscripcion();
      await sock.sendMessage(jid, { text: `🔊 *Crédito de voz (ElevenLabs)*\nPlan: ${s.plan || 'n/d'}\nUsados: ${s.usados} de ${s.limite}\n${s.reinicio ? `Se renueva: ${new Date(s.reinicio * 1000).toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}\n` : ''}\n${local}` });
    } catch (err) { await sock.sendMessage(jid, { text: `🔊 No pude consultar el saldo real a ElevenLabs (${err.categoriaVoz || 'error'}; tu clave puede no tener permiso "user_read").\n${local}` }); }
    return true;
  }
  return false;
}

const FRASES_AVISO_SALIDA_FALLBACK = ['Ay, mira quién se fue del grupo... y sí lo tenía fichado en el clan 👀', 'Se me salió alguien del grupo y ¡sorpresa! está en mi lista 📋', 'Alguien se despidió del grupo, pero yo sí lo tenía registrado 💅'];
const FRASES_CONFIRMACION_ELIMINACION_FALLBACK = ['Listo, su registro ya no está en la lista del clan 🗑️', 'Su ficha ya fue eliminada de la lista 💔', 'Ya quité su registro, todo limpio 📋✨'];

async function generarMensajeVariadoIA(instruccion, fallbackLista) {
  try {
    const respuesta = await generarRespuestaIA(instruccion, 'Genera SOLO el mensaje pedido, sin comillas, máximo 2 líneas, tono femenino cálido.', 'sistema_interno', 'sistema_interno');
    return (respuesta || '').trim() || fallbackLista[Math.floor(Math.random() * fallbackLista.length)];
  } catch (err) { return fallbackLista[Math.floor(Math.random() * fallbackLista.length)]; }
}

// ── 🆕 Imágenes gratis con Cloudflare Workers AI (FLUX.1 schnell) ───────────────
// Si defines CF_ACCOUNT_ID y CF_API_TOKEN, /imagen usa Cloudflare primero (plan gratis, sin tarjeta, 10 000 "neurons"
// por día ≈ 170 imágenes). Si no están definidos, o falla, se intenta Gemini como antes.
const CF_ACCOUNT_ID = limpiarValorEnv(process.env.CF_ACCOUNT_ID);
const CF_API_TOKEN = limpiarValorEnv(process.env.CF_API_TOKEN);
const CF_MODELO_IMAGEN = limpiarValorEnv(process.env.CF_MODELO_IMAGEN) || '@cf/black-forest-labs/flux-1-schnell';
const CF_ACTIVO = !!(CF_ACCOUNT_ID && CF_API_TOKEN);

async function mejorarPromptImagen(descripcion) {
  // FLUX entiende mejor el inglés: se traduce/enriquece con una llamada corta. Si falla, se usa el texto original.
  try {
    const res = await generarConRespaldo('prompt_imagen', () => ({ contents: `Convierte esta petición en un prompt corto en inglés (máximo 60 palabras) para un generador de imágenes. Responde SOLO con el prompt.\nPetición: ${descripcion}`, config: { maxOutputTokens: 200, temperature: 0.4 } }), 15000);
    const mejorado = String(res.text || '').trim().replace(/^["']|["']$/g, '');
    return mejorado.length >= 5 ? mejorado.slice(0, 600) : descripcion;
  } catch (err) { return descripcion; }
}

async function generarImagenCloudflare(prompt) {
  const inicio = Date.now();
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), 60000);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODELO_IMAGEN}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, steps: 4 }), signal: controlador.signal
    });
    if (!res.ok) { const e = new Error(`Cloudflare respondió ${res.status}: ${sanitizarParaLog(await res.text().catch(() => ''))}`); e.status = res.status; throw e; }
    let buffer;
    if (/^image\//i.test(res.headers.get('content-type') || '')) buffer = Buffer.from(await res.arrayBuffer());
    else {
      const datos = await res.json();
      const b64 = datos && ((datos.result && datos.result.image) || datos.image);
      if (!b64) throw new Error('Cloudflare no devolvió ninguna imagen');
      buffer = Buffer.from(b64, 'base64');
    }
    if (buffer.length < 1000) throw new Error('Cloudflare devolvió una imagen vacía o dañada');
    registrarLatencia('imagen_cloudflare', Date.now() - inicio, true);
    console.log(`⏱️ [Imagen:cloudflare] ${Date.now() - inicio} ms OK`);
    return buffer;
  } catch (err) {
    registrarLatencia('imagen_cloudflare', Date.now() - inicio, false);
    registrarEventoDiag('imagen_cloudflare', err, Date.now() - inicio);
    throw err;
  } finally { clearTimeout(temporizador); }
}

async function generarImagenIA(prompt) {
  if (CF_ACTIVO) {
    try { const buffer = await generarImagenCloudflare(await mejorarPromptImagen(prompt)); console.log('✅ Imagen generada (Cloudflare)'); return { buffer }; }
    catch (err) {
      console.log(`⚠️ Falló generación de imagen (Cloudflare): ${sanitizarParaLog(err.message)}`);
      if (clasificarError(err).categoria === 'cuota') return { error: 'cuota' };
    }
  }
  for (const cliente of CLIENTES_IA) {
    try {
      const res = await cliente.ai.models.generateContent({ model: MODELO_IMAGEN, contents: prompt, config: { responseModalities: ['IMAGE', 'TEXT'] } });
      const partes = res?.candidates?.[0]?.content?.parts || [];
      for (const parte of partes) { if (parte.inlineData?.data) { console.log(`✅ Imagen generada (cliente ${cliente.nombre})`); return { buffer: Buffer.from(parte.inlineData.data, 'base64') }; } }
      return { error: 'sin_datos' };
    } catch (err) {
      registrarEventoDiag('generar_imagen', err, null, `cliente=${cliente.nombre}`);
      console.log(`⚠️ Falló generación de imagen (${cliente.nombre}): ${sanitizarParaLog(err.message)}`);
      if (/429|quota|exceeded/i.test(err.message || '')) return { error: 'cuota' };
    }
  }
  return { error: 'ninguno' };
}

async function comandoImagen(sock, jidDestino, descripcion) {
  if (!descripcion || descripcion.trim().length < 2) { await sock.sendMessage(jidDestino, { text: 'Uso: /imagen <descripción>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎨 Dame un segundito, la estoy creando...' });
  const resultado = await generarImagenIA(descripcion);
  if (resultado.buffer) { await sock.sendMessage(jidDestino, { image: resultado.buffer, caption: '✨ ¡Aquí tienes!' }); return; }
  if (resultado.error === 'cuota') {
    await sock.sendMessage(jidDestino, { text: CF_ACTIVO ? '💔 Se acabó la cuota gratis de imágenes de hoy. Se renueva a las 19:00 (hora de Perú). No es un error del bot.' : '💔 Se agotó la cuota de generación de imágenes de esta cuenta de Google AI por ahora. Esto se resuelve revisando el plan/facturación de la API, no es un error del bot.' });
    return;
  }
  await sock.sendMessage(jidDestino, { text: '💔 No pude generar la imagen esta vez — revisa los logs de Render para más detalle.' });
}

function obtenerIdentificadoresBot(sock) {
  const ids = new Set();
  const rawId = sock.user?.id || '';
  const rawLid = sock.user?.lid || '';
  if (rawId) ids.add(rawId.split(':')[0].split('@')[0]);
  if (rawLid) ids.add(rawLid.split(':')[0].split('@')[0]);
  ids.add(TU_NUMERO); ids.add(NUMERO_BOT_VINCULADO);
  return [...ids].filter(Boolean);
}

function esMencionAlBot(msg, texto, identificadoresBot) {
  const mencionados = obtenerContextInfo(msg)?.mentionedJid || [];
  const numerosMencionados = mencionados.map(j => j.split('@')[0]);
  if (numerosMencionados.some(n => identificadoresBot.includes(n))) return true;
  return identificadoresBot.some(id => texto.includes(`@${id}`));
}

function debeResponderIA(texto, msg, identificadoresBot) {
  if (esMencionAlBot(msg, texto, identificadoresBot)) return true;
  return (texto.trim().split(/\s+/)[0] || '').toLowerCase() === COMANDO_LLAMADA_IA;
}

function normalizarBusqueda(texto) { return (texto || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }

function detectarSolicitudInfoPorNombre(texto) {
  const t = texto.trim();
  if (!/\b(informaci[oó]n|informe|info|datos|ficha|perfil)\b/i.test(t)) return null;
  let resto = t.replace(/^.*?\b(?:del|de la|de|sobre)\s+integrante\b/i, '').replace(/^.*?\b(?:informaci[oó]n|informe|info|datos|ficha|perfil)\b/i, '').replace(/^\s*(?:del|de la|de|del clan|de|sobre|los|las|el|la)\s+/i, '').trim().replace(/[.?!]+$/, '');
  if (!resto || resto.length < 2 || resto.length > 45) return null;
  return resto;
}

function extraerTextoCitado(msg) {
  const citado = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!citado) return null;
  return citado.conversation || citado.extendedTextMessage?.text || null;
}

function numeroEsValido(numero) { return !!numero && numero.length >= 8 && numero.length <= 15; }
function esNumeroTelefonicoProbable(numero) { return !!numero && numero.length >= 8 && numero.length <= 13; }

function extraerNumero(jid) {
  if (!jid) return '';
  const parteSinServidor = String(jid).split('@')[0].split(':')[0];
  return parteSinServidor.replace(/[^0-9]/g, '');
}

function normalizarParticipante(participanteRaw) {
  if (typeof participanteRaw === 'string') return { jid: participanteRaw, numero: extraerNumero(participanteRaw) };
  const jid = participanteRaw?.id || participanteRaw?.jid || '';
  const numeroReal = [participanteRaw?.phoneNumber, participanteRaw?.jid].filter(Boolean).map(extraerNumero).find(n => esNumeroTelefonicoProbable(n));
  return { jid, numero: numeroReal || extraerNumero(jid) };
}

const MAPA_LID_A_NUMERO = new Map();
function actualizarCacheLid(metadata) {
  if (!metadata || !Array.isArray(metadata.participants)) return;
  for (const p of metadata.participants) {
    const numeroReal = [p.phoneNumber, p.jid].filter(Boolean).map(extraerNumero).find(n => esNumeroTelefonicoProbable(n));
    if (!numeroReal) continue;
    for (const posibleLid of [p.id, p.lid].filter(Boolean).map(extraerNumero)) {
      if (posibleLid && posibleLid !== numeroReal) MAPA_LID_A_NUMERO.set(posibleLid, numeroReal);
    }
  }
}

async function resolverNumeroReal(sock, jidChat, jidObjetivo) {
  const numeroDirecto = extraerNumero(jidObjetivo);
  if (esNumeroTelefonicoProbable(numeroDirecto)) return numeroDirecto;
  if (MAPA_LID_A_NUMERO.has(numeroDirecto)) return MAPA_LID_A_NUMERO.get(numeroDirecto);
  if (jidChat && jidChat.endsWith('@g.us')) {
    try {
      const metadata = await sock.groupMetadata(jidChat);
      actualizarCacheLid(metadata);
      const participante = metadata.participants.find(p => [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).map(extraerNumero).includes(numeroDirecto));
      if (participante) {
        const candidatoReal = [participante.phoneNumber, participante.id, participante.jid].filter(Boolean).map(extraerNumero).find(n => esNumeroTelefonicoProbable(n));
        if (candidatoReal) return candidatoReal;
      }
    } catch (err) {}
    if (MAPA_LID_A_NUMERO.has(numeroDirecto)) return MAPA_LID_A_NUMERO.get(numeroDirecto);
  }
  return null;
}

function esPropietario(numero) { return numero === TU_NUMERO; }
const propietariosVerificados = new Set();
const pendientesPropietario = new Map();

function esPropietarioEfectivo(jid) { if (!jid) return false; const numero = extraerNumero(jid); return esPropietario(numero) || propietariosVerificados.has(numero); }

async function esPropietarioContexto(sock, jidChat, jidUsuario) {
  const numero = await resolverNumeroReal(sock, jidChat, jidUsuario);
  return esPropietario(numero) || (numero && propietariosVerificados.has(numero));
}

function buscarConteoEnMapa(mapa, jid) {
  if (!mapa) return 0;
  if (mapa.has(jid)) return mapa.get(jid);
  const numero = extraerNumero(jid);
  for (const [clave, valor] of mapa.entries()) { if (extraerNumero(clave) === numero) return valor; }
  return 0;
}

const ARCHIVO_SILENCIADOS = path.join(__dirname, 'silenciados.json');
function cargarSilenciados() { try { return new Set(JSON.parse(fs.readFileSync(ARCHIVO_SILENCIADOS, 'utf-8'))); } catch (err) { return new Set(); } }
let SILENCIADOS = cargarSilenciados();
let guardadoSilenciadosPendiente = null;
function guardarSilenciados() {
  if (guardadoSilenciadosPendiente) clearTimeout(guardadoSilenciadosPendiente);
  guardadoSilenciadosPendiente = setTimeout(() => { fs.writeFile(ARCHIVO_SILENCIADOS, JSON.stringify([...SILENCIADOS]), (err) => { if (err) console.log('⚠️ Error guardando silenciados:', err.message); }); }, 1000);
}

const NUMEROS_IGNORADOS = (process.env.NUMEROS_IGNORADOS || '').split(',').map(n => n.trim()).filter(Boolean);
function esNumeroIgnorado(jid) { const numero = extraerNumero(jid); return NUMEROS_IGNORADOS.includes(numero) || SILENCIADOS.has(numero); }

const NOMBRES_CONOCIDOS = new Map();
function registrarNombreConocido(jid, pushName) { if (pushName) NOMBRES_CONOCIDOS.set(extraerNumero(jid), pushName); }
function obtenerNombreVisible(jid) { const numero = extraerNumero(jid); return NOMBRES_CONOCIDOS.get(numero) || `+${numero}`; }
const CLAVE_CLAN_GLOBAL = 'clan_global';
const GITHUB_CARPETA_FOTOS = 'fotos';
function rutaFotoIntegrante(codigo) { return `${GITHUB_CARPETA_FOTOS}/${codigo}.jpg`; }

const GITHUB_TOKEN = limpiarValorEnv(process.env.GITHUB_TOKEN);
const GITHUB_REPO = limpiarValorEnv(process.env.GITHUB_REPO);
const GITHUB_RUTA_ARCHIVO = limpiarValorEnv(process.env.GITHUB_RUTA_ARCHIVO) || 'integrantes.json';
const GITHUB_RUTA_PROPIETARIOS = limpiarValorEnv(process.env.GITHUB_RUTA_PROPIETARIOS) || 'propietarios.json';
const GITHUB_RAMA = limpiarValorEnv(process.env.GITHUB_RAMA) || 'main';
const GITHUB_API_BASE = 'https://api.github.com';

if (GITHUB_TOKEN) console.log(`🔍 GITHUB_TOKEN detectado — longitud: ${GITHUB_TOKEN.length} caracteres`);

let githubShaActual = null;
let githubShaPropietarios = null;

async function githubLeerIntegrantes() {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_ARCHIVO)}?ref=${GITHUB_RAMA}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`No se pudo leer de GitHub (${res.status})`);
  const data = await res.json();
  githubShaActual = data.sha;
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
}

async function githubGuardarIntegrantes(dataObjeto) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_ARCHIVO)}`;
  const body = { message: `Actualización de integrantes — ${new Date().toISOString()}`, content: Buffer.from(JSON.stringify(dataObjeto, null, 2)).toString('base64'), branch: GITHUB_RAMA };
  if (githubShaActual) body.sha = githubShaActual;
  const res = await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`No se pudo guardar en GitHub (${res.status})`);
  const data = await res.json();
  githubShaActual = data.content.sha;
}

async function inicializarNubeIntegrantes() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) { console.log('⚠️ GITHUB_TOKEN o GITHUB_REPO no configurados.'); return; }
  try {
    const nube = await githubLeerIntegrantes();
    if (nube && typeof nube === 'object') { integrantesClan = nube; console.log('☁️ Integrantes cargados desde GitHub.'); }
    else { await githubGuardarIntegrantes(integrantesClan || {}); console.log('🆕 Archivo de integrantes creado en GitHub.'); }
  } catch (err) { console.log('⚠️ No se pudo conectar con GitHub (integrantes):', err.message); }
}

async function githubLeerPropietarios() {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_PROPIETARIOS)}?ref=${GITHUB_RAMA}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`No se pudo leer propietarios de GitHub (${res.status})`);
  const data = await res.json();
  githubShaPropietarios = data.sha;
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
}

async function githubGuardarPropietarios(lista) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_PROPIETARIOS)}`;
  const body = { message: `Propietarios actualizados — ${new Date().toISOString()}`, content: Buffer.from(JSON.stringify(lista, null, 2)).toString('base64'), branch: GITHUB_RAMA };
  if (githubShaPropietarios) body.sha = githubShaPropietarios;
  const res = await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`No se pudo guardar propietarios en GitHub (${res.status})`);
  const data = await res.json();
  githubShaPropietarios = data.content.sha;
}

async function inicializarNubePropietarios() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) { console.log('⚠️ Sin GitHub configurado — /propietario no persistirá entre reinicios.'); return; }
  try {
    const nube = await githubLeerPropietarios();
    if (Array.isArray(nube)) { nube.forEach(n => propietariosVerificados.add(n)); console.log('☁️ Propietarios verificados cargados desde GitHub.'); }
    else { await githubGuardarPropietarios([...propietariosVerificados]); console.log('🆕 Archivo de propietarios creado en GitHub.'); }
  } catch (err) { console.log('⚠️ No se pudo conectar con GitHub (propietarios):', err.message); }
}

let guardadoPropietariosPendiente = null;
function guardarPropietariosEnNube() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (guardadoPropietariosPendiente) clearTimeout(guardadoPropietariosPendiente);
  guardadoPropietariosPendiente = setTimeout(async () => { try { await githubGuardarPropietarios([...propietariosVerificados]); } catch (err) { console.log('⚠️ Error guardando propietarios en GitHub:', err.message); } }, 1500);
}

async function githubSubirFoto(rutaArchivo, bufferImagen) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rutaArchivo)}`;
  let shaExistente = null;
  try { const resInfo = await fetch(`${url}?ref=${GITHUB_RAMA}`, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } }); if (resInfo.ok) { const infoData = await resInfo.json(); shaExistente = infoData.sha; } } catch (err) {}
  const body = { message: `Foto actualizada — ${new Date().toISOString()}`, content: bufferImagen.toString('base64'), branch: GITHUB_RAMA };
  if (shaExistente) body.sha = shaExistente;
  const res = await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`No se pudo subir la foto a GitHub (${res.status})`);
}

async function githubDescargarFoto(rutaArchivo) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rutaArchivo)}?ref=${GITHUB_RAMA}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`No se pudo descargar la foto de GitHub (${res.status})`);
  const data = await res.json();
  return Buffer.from(data.content, 'base64');
}

async function githubEliminarFoto(rutaArchivo) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const urlInfo = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rutaArchivo)}?ref=${GITHUB_RAMA}`;
  try {
    const resInfo = await fetch(urlInfo, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
    if (!resInfo.ok) return;
    const info = await resInfo.json();
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rutaArchivo)}`;
    await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Foto eliminada — ${new Date().toISOString()}`, sha: info.sha, branch: GITHUB_RAMA }) });
  } catch (err) { console.log('⚠️ No se pudo eliminar la foto en GitHub:', err.message); }
}

const ARCHIVO_INTEGRANTES = path.join(__dirname, 'integrantes.json');
function cargarIntegrantes() { try { return JSON.parse(fs.readFileSync(ARCHIVO_INTEGRANTES, 'utf-8')); } catch (err) { return {}; } }
let integrantesClan = cargarIntegrantes();
let guardadoIntegrantesPendiente = null;
function guardarIntegrantes() {
  if (guardadoIntegrantesPendiente) clearTimeout(guardadoIntegrantesPendiente);
  guardadoIntegrantesPendiente = setTimeout(async () => {
    fs.writeFile(ARCHIVO_INTEGRANTES, JSON.stringify(integrantesClan, null, 2), (err) => { if (err) console.log('⚠️ Error guardando integrantes localmente:', err.message); });
    if (GITHUB_TOKEN && GITHUB_REPO) { try { await githubGuardarIntegrantes(integrantesClan); } catch (err) { console.log('⚠️ Error guardando integrantes en GitHub:', err.message); } }
  }, 1500);
}

const ARCHIVO_MOVIMIENTOS = path.join(__dirname, 'movimientos.json');
const MAX_REGISTROS_MOVIMIENTOS = 300;
function cargarMovimientos() { try { return JSON.parse(fs.readFileSync(ARCHIVO_MOVIMIENTOS, 'utf-8')); } catch (err) { return []; } }
let registroMovimientos = cargarMovimientos();
let guardadoMovimientosPendiente = null;
function guardarMovimientos() {
  if (guardadoMovimientosPendiente) clearTimeout(guardadoMovimientosPendiente);
  guardadoMovimientosPendiente = setTimeout(() => { fs.writeFile(ARCHIVO_MOVIMIENTOS, JSON.stringify(registroMovimientos), (err) => { if (err) console.log('⚠️ Error guardando movimientos:', err.message); }); }, 1500);
}

const ETIQUETAS_MOVIMIENTO = {
  add: { icono: '➕', texto: 'agregó al grupo a' }, remove: { icono: '🚫', texto: 'sacó del grupo a' },
  promote: { icono: '⭐', texto: 'hizo admin a' }, demote: { icono: '🔻', texto: 'quitó el admin a' },
  cerrar: { icono: '🔒', texto: 'cerró el grupo' }, abrir: { icono: '🔓', texto: 'abrió el grupo' },
  salio: { icono: '🚶', texto: 'salió del grupo' }, se_unio: { icono: '🔗', texto: 'se unió por enlace de invitación' }
};

const ACCIONES_BOT_RECIENTES = new Set();
function marcarAccionBotReciente(jidGrupo, accion, jids) { jids.forEach(jid => { const clave = `${jidGrupo}:${accion}:${extraerNumero(jid)}`; ACCIONES_BOT_RECIENTES.add(clave); setTimeout(() => ACCIONES_BOT_RECIENTES.delete(clave), 10000); }); }
function accionFueDelBot(jidGrupo, accion, jid) { return ACCIONES_BOT_RECIENTES.has(`${jidGrupo}:${accion}:${extraerNumero(jid)}`); }

async function registrarAccionAdmin(sock, jidGrupo, accionOriginal, jidEjecutor, jidsObjetivo, nombreGrupoTexto, numerosConocidos) {
  let accion = accionOriginal;
  const numeroEjecutorReal = jidEjecutor ? await resolverNumeroReal(sock, jidGrupo, jidEjecutor) : null;
  const listaObjetivos = jidsObjetivo || [];
  const objetivosReales = [];
  for (let i = 0; i < listaObjetivos.length; i++) {
    const conocido = numerosConocidos && numerosConocidos[i];
    objetivosReales.push(esNumeroTelefonicoProbable(conocido) ? conocido : await resolverNumeroReal(sock, jidGrupo, listaObjetivos[i]));
  }
  let objetivos = objetivosReales.filter(Boolean);
  if (numeroEjecutorReal && objetivos.length === 1 && objetivos[0] === numeroEjecutorReal) {
    if (accion === 'remove') accion = 'salio';
    if (accion === 'add') accion = 'se_unio';
    objetivos = [];
  }
  const entrada = { accion, jidGrupo, nombreGrupo: nombreGrupoTexto || null, ejecutor: numeroEjecutorReal, objetivos, fecha: new Date().toISOString() };
  registroMovimientos.push(entrada);
  if (registroMovimientos.length > MAX_REGISTROS_MOVIMIENTOS) registroMovimientos.shift();
  guardarMovimientos();
  sock.sendMessage(JID_DUEÑO, { text: formatearMovimiento(jidGrupo, entrada) }).catch(() => {});
}
const FRASES_RANDOM = ['La constancia le gana al talento cuando el talento no es constante 💪', 'Hoy es un buen día para no rendirte 🌸', 'El que no arriesga, no gana nada bonito 🐟', 'Mejor sola que mal acompañada, mejor acompañada que aburrida 💕'];
function comandoFrase() { return FRASES_RANDOM[Math.floor(Math.random() * FRASES_RANDOM.length)]; }

async function comandoRanking(sock, jidGrupo) {
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  if (!mapa || mapa.size === 0) return { texto: 'Aún no hay suficiente actividad 📊', mentions: [] };
  const ordenado = [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { texto: '🏆 *Ranking de más activas:*\n' + ordenado.map(([jid, n], i) => `${i + 1}. ${obtenerNombreVisible(jid)} — ${n} msjs`).join('\n'), mentions: ordenado.map(([jid]) => jid) };
}

async function esAdminGrupo(sock, jidGrupo, jidUsuario) {
  try {
    const metadata = await sock.groupMetadata(jidGrupo);
    actualizarCacheLid(metadata);
    const numeroObjetivo = extraerNumero(jidUsuario);
    const participante = metadata.participants.find(p => { if (p.id === jidUsuario) return true; const candidatos = [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean).map(extraerNumero); return candidatos.includes(numeroObjetivo); });
    return !!participante && (participante.admin === 'admin' || participante.admin === 'superadmin');
  } catch (err) { return false; }
}

async function tienePermisoClan(sock, jidChat, jidUsuario) {
  if (await esPropietarioContexto(sock, jidChat, jidUsuario)) return true;
  if (jidChat.endsWith('@g.us')) return await esAdminGrupo(sock, jidChat, jidUsuario);
  return false;
}

async function comandoPerfil(sock, jidGrupo, jidUsuario, mencionJid) {
  const jidObjetivo = mencionJid || jidUsuario;
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  const mensajes = buscarConteoEnMapa(mapa, jidObjetivo);
  const esAdmin = await esAdminGrupo(sock, jidGrupo, jidObjetivo);
  await sock.sendMessage(jidGrupo, { text: `👤 *Perfil de ${obtenerNombreVisible(jidObjetivo)}*\n📨 Mensajes: ${mensajes}\n👑 Admin: ${esAdmin ? 'Sí' : 'No'}`, mentions: [jidObjetivo] });
}

function generarCodigoUnico() { const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; const usados = new Set(lista.map(i => i.codigo).filter(Boolean)); let codigo; do { codigo = String(Math.floor(Math.random() * 100)).padStart(2, '0'); } while (usados.has(codigo)); return codigo; }
function asegurarCodigosClan() { const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; let cambiado = false; for (const ficha of lista) { if (!ficha.codigo) { ficha.codigo = generarCodigoUnico(); cambiado = true; } } if (cambiado) guardarIntegrantes(); }

function agregarIntegrante(datos) {
  if (!integrantesClan[CLAVE_CLAN_GLOBAL]) integrantesClan[CLAVE_CLAN_GLOBAL] = [];
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL];
  const numeroLimpio = extraerNumero(datos.numero) || datos.numero;
  const existente = lista.find(i => (datos.idFF && i.idFF === datos.idFF) || extraerNumero(i.numero) === numeroLimpio);
  if (existente) { Object.assign(existente, datos, { fecha: existente.fecha, codigo: existente.codigo || generarCodigoUnico() }); guardarIntegrantes(); return { actualizado: true, ficha: existente }; }
  const ficha = { ...datos, codigo: generarCodigoUnico(), tieneFoto: false, fecha: new Date().toISOString() };
  lista.push(ficha); guardarIntegrantes();
  return { actualizado: false, ficha };
}

function quitarIntegrante(criterio) {
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  const criterioLimpio = extraerNumero(criterio) || criterio;
  const criterioCodigo = String(criterio).trim().padStart(2, '0');
  const indice = lista.findIndex(i => i.idFF === criterio || extraerNumero(i.numero) === criterioLimpio || i.codigo === criterioCodigo);
  if (indice === -1) return null;
  const eliminada = lista[indice];
  lista.splice(indice, 1); guardarIntegrantes();
  if (eliminada.tieneFoto) githubEliminarFoto(rutaFotoIntegrante(eliminada.codigo)).catch(() => {});
  return eliminada;
}

function buscarIntegrantePorDato(criterio) { asegurarCodigosClan(); const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; const criterioLimpio = extraerNumero(criterio) || criterio; const criterioCodigo = String(criterio).trim().padStart(2, '0'); return lista.find(i => i.idFF === criterio || extraerNumero(i.numero) === criterioLimpio || i.codigo === criterioCodigo) || null; }
function buscarIntegrantePorNumero(numero) { asegurarCodigosClan(); const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; const numeroLimpio = extraerNumero(numero); return lista.find(i => extraerNumero(i.numero) === numeroLimpio) || null; }
function buscarIntegrantesPorNombre(nombreBuscado) { asegurarCodigosClan(); const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; const objetivo = normalizarBusqueda(nombreBuscado); if (!objetivo) return []; return lista.filter(i => (i.nombre && normalizarBusqueda(i.nombre).includes(objetivo)) || (i.apodo && normalizarBusqueda(i.apodo).includes(objetivo))); }
function obtenerEtiquetaPersona(criterio) { if (!criterio) return 'Desconocido'; const numero = extraerNumero(criterio) || criterio; const ficha = buscarIntegrantePorDato(numero); if (ficha) return ficha.apodo || ficha.nombre; const nombreCache = NOMBRES_CONOCIDOS.get(numero); return nombreCache || 'Miembro del grupo'; }

function formatearFichaIntegrante(ficha) { return `*FICHA DE INTEGRANTE*\n*Nombre*  : ${ficha.nombre}\n*Número*  : ${ficha.numero}\n*ID FF*   : ${ficha.idFF}\n*Apodo*   : ${ficha.apodo}\n*Código*  : ${ficha.codigo}`; }
function formatearFichaCorta(ficha, posicion) { return `${posicion}. *${ficha.nombre}* (${ficha.apodo}) — código ${ficha.codigo}\n   📱 ${ficha.numero} · 🆔 ${ficha.idFF}`; }

async function enviarFichaCompleta(sock, jidChat, ficha) {
  const texto = formatearFichaIntegrante(ficha);
  if (ficha.tieneFoto && GITHUB_TOKEN && GITHUB_REPO) {
    try { const buffer = await githubDescargarFoto(rutaFotoIntegrante(ficha.codigo)); if (buffer) { await sock.sendMessage(jidChat, { image: buffer, caption: texto }); return; } } catch (err) {}
  }
  await sock.sendMessage(jidChat, { text: texto });
}

function totalPaginasClan() { return Math.max(1, Math.ceil((integrantesClan[CLAVE_CLAN_GLOBAL] || []).length / INTEGRANTES_POR_PAGINA)); }

function generarTextoPaginaClan(numeroPaginaTexto) {
  asegurarCodigosClan();
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  if (!lista.length) return 'Aún no hay integrantes registradas.';
  const paginas = totalPaginasClan();
  const numeroPagina = parseInt(numeroPaginaTexto, 10);
  if (!numeroPaginaTexto || isNaN(numeroPagina) || numeroPagina < 1) return `Uso: /lista <número>\nHay ${paginas} página(s).`;
  if (numeroPagina > paginas) return `Esa página no existe. Solo hay ${paginas} página(s).`;
  const inicio = (numeroPagina - 1) * INTEGRANTES_POR_PAGINA;
  const bloque = lista.slice(inicio, inicio + INTEGRANTES_POR_PAGINA);
  return `*CLAN · PÁGINA ${String(numeroPagina).padStart(2, '0')} DE ${String(paginas).padStart(2, '0')}*\n\n${bloque.map((ficha, i) => formatearFichaCorta(ficha, inicio + i + 1)).join('\n\n')}`;
}

function generarResumenClan() {
  asegurarCodigosClan();
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  if (!lista.length) return 'Aún no hay integrantes registradas.';
  const paginas = totalPaginasClan();
  const primeraPagina = generarTextoPaginaClan('1');
  if (paginas <= 1) return primeraPagina;
  return `${primeraPagina}\n\nHay ${paginas} páginas (${lista.length} integrantes):\n${Array.from({ length: paginas - 1 }, (_, i) => `/lista ${String(i + 2).padStart(2, '0')}`).join('\n')}`;
}

async function comandoClanAgregar(sock, jidChat, jidUsuario, textoCompleto) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden registrar integrantes 🚫' }); return; }
  const partes = textoCompleto.split(';').map(p => p.trim()).filter(Boolean);
  if (partes.length < 4) { await sock.sendMessage(jidChat, { text: 'Formato: /clan agregar Nombre; Número; ID FF; Apodo' }); return; }
  const [nombre, numero, idFF, apodo] = partes;
  const { actualizado, ficha } = agregarIntegrante({ nombre, numero, idFF, apodo, agregadoPor: extraerNumero(jidUsuario) });
  await sock.sendMessage(jidChat, { text: `${actualizado ? '✏️ Ficha actualizada' : '✅ Integrante registrada'}:\n\n${formatearFichaIntegrante(ficha)}` });
}
async function comandoClanQuitar(sock, jidChat, jidUsuario, criterio) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden quitar integrantes 🚫' }); return; }
  if (!criterio) { await sock.sendMessage(jidChat, { text: 'Uso: /clan quitar <número, ID FF o código>' }); return; }
  const eliminada = quitarIntegrante(criterio);
  await sock.sendMessage(jidChat, { text: eliminada ? `🗑️ Eliminada: *${eliminada.apodo || eliminada.nombre}*.` : 'No encontré a nadie con ese dato.' });
}
async function comandoClanVer(sock, jidChat, criterio) {
  if (!criterio) { await sock.sendMessage(jidChat, { text: 'Uso: /clan ver <número, ID FF o código>' }); return; }
  const ficha = buscarIntegrantePorDato(criterio);
  if (!ficha) { await sock.sendMessage(jidChat, { text: 'No encontré a nadie con ese dato.' }); return; }
  await enviarFichaCompleta(sock, jidChat, ficha);
}

async function comandoEliminarPorCodigo(sock, jidChat, jidUsuario, codigo) {
  if (!codigo || !/^\d{1,2}$/.test(codigo)) { await sock.sendMessage(jidChat, { text: 'Uso: /eliminar <código de dos cifras>' }); return; }
  const codigoNormalizado = codigo.padStart(2, '0');
  const esSalidaPendiente = pendingSalidasClan.has(codigoNormalizado);
  const tienePermiso = esSalidaPendiente ? await esPropietarioContexto(sock, jidChat, jidUsuario) : await tienePermisoClan(sock, jidChat, jidUsuario);
  if (!tienePermiso) { await sock.sendMessage(jidChat, { text: esSalidaPendiente ? 'Solo el propietario puede confirmar esta eliminación 🚫' : 'Solo las admins o el propietario pueden eliminar integrantes 🚫' }); return; }
  const eliminada = quitarIntegrante(codigoNormalizado);
  if (!eliminada) { await sock.sendMessage(jidChat, { text: `No encontré a nadie con el código ${codigoNormalizado}.` }); return; }
  await sock.sendMessage(jidChat, { text: `🗑️ Eliminada del clan: *${eliminada.apodo || eliminada.nombre}* (código ${eliminada.codigo}).` });

  const pendiente = pendingSalidasClan.get(codigoNormalizado);
  if (pendiente) {
    pendingSalidasClan.delete(codigoNormalizado);
    const mensajeGrupo = await generarMensajeVariadoIA(`Avisa al grupo, en un mensaje corto, que la ficha de "${eliminada.apodo}" fue eliminada de la lista del clan.`, FRASES_CONFIRMACION_ELIMINACION_FALLBACK);
    if (pendiente.jidGrupoOrigen !== jidChat) { try { await sock.sendMessage(pendiente.jidGrupoOrigen, { text: mensajeGrupo }); } catch (err) {} }
    else { await sock.sendMessage(jidChat, { text: mensajeGrupo }); }
  }
}

async function comandoEliminarFoto(sock, jidChat, jidUsuario, codigo) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden eliminar fotos 🚫' }); return; }
  if (!codigo || !/^\d{1,2}$/.test(codigo)) { await sock.sendMessage(jidChat, { text: 'Uso: /eliminar foto <código>' }); return; }
  const codigoNormalizado = codigo.padStart(2, '0');
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  const ficha = lista.find(i => i.codigo === codigoNormalizado);
  if (!ficha) { await sock.sendMessage(jidChat, { text: `No encontré a nadie con el código ${codigoNormalizado}.` }); return; }
  if (!ficha.tieneFoto) { await sock.sendMessage(jidChat, { text: `*${ficha.apodo || ficha.nombre}* no tiene foto guardada.` }); return; }
  await githubEliminarFoto(rutaFotoIntegrante(ficha.codigo));
  ficha.tieneFoto = false; guardarIntegrantes();
  await sock.sendMessage(jidChat, { text: `🗑️ Foto eliminada de *${ficha.apodo || ficha.nombre}*.` });
}

async function comandoIntegrantePorMencion(sock, jidChat, jidUsuario, mencionados) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden ver fichas 🚫' }); return; }
  if (!mencionados.length) { await sock.sendMessage(jidChat, { text: 'Menciona a quién buscar: /integrante @usuario' }); return; }
  const numero = await resolverNumeroReal(sock, jidChat, mencionados[0]);
  const ficha = numero ? buscarIntegrantePorNumero(numero) : null;
  if (!ficha) { await sock.sendMessage(jidChat, { text: `No encontré a esa persona en el clan.` }); return; }
  await enviarFichaCompleta(sock, jidChat, ficha);
}

async function comandoFotoIntegrante(sock, jidChat, jidUsuario, msg, codigoTexto) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden subir fotos 🚫' }); return; }
  if (!GITHUB_TOKEN || !GITHUB_REPO) { await sock.sendMessage(jidChat, { text: 'Falta configurar GITHUB_TOKEN y GITHUB_REPO en Render.' }); return; }
  const codigoNormalizado = (codigoTexto || '').trim().padStart(2, '0');
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  const ficha = lista.find(i => i.codigo === codigoNormalizado);
  if (!ficha) { await sock.sendMessage(jidChat, { text: `No encontré a nadie con el código ${codigoNormalizado}.` }); return; }
  if (!msg.message.imageMessage) { await sock.sendMessage(jidChat, { text: `Adjunta la imagen con descripción: /fotoff ${codigoNormalizado}` }); return; }
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'error' }) });
    await githubSubirFoto(rutaFotoIntegrante(ficha.codigo), buffer);
    ficha.tieneFoto = true; guardarIntegrantes();
    await sock.sendMessage(jidChat, { text: `📸 Foto guardada para *${ficha.apodo || ficha.nombre}*.` });
  } catch (err) { await sock.sendMessage(jidChat, { text: 'No pude guardar la foto, intenta de nuevo.' }); }
}

const borradoresIntegrante = new Map();
function claveBorrador(jidGrupo, jidUsuario) { return `${jidGrupo}:${jidUsuario}`; }
function actualizarBorrador(jidGrupo, jidUsuario, campo, valor) { const clave = claveBorrador(jidGrupo, jidUsuario); const actual = borradoresIntegrante.get(clave) || {}; actual[campo] = valor; borradoresIntegrante.set(clave, actual); return actual; }
function borradorCompleto(borrador) { return !!(borrador && borrador.nombre && borrador.numero && borrador.idFF && borrador.apodo); }
const ETIQUETAS_CAMPO_BORRADOR = { nombre: '/nombreff', numero: '/numeroff', idFF: '/idff', apodo: '/apodoff' };

async function comandoCampoIntegrante(sock, jidChat, jidUsuario, campo, valor) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden registrar integrantes 🚫' }); return; }
  if (!valor) { await sock.sendMessage(jidChat, { text: `Uso: ${ETIQUETAS_CAMPO_BORRADOR[campo]} <valor>` }); return; }
  const borrador = actualizarBorrador(jidChat, jidUsuario, campo, valor);
  if (borradorCompleto(borrador)) {
    const { actualizado, ficha } = agregarIntegrante({ nombre: borrador.nombre, numero: borrador.numero, idFF: borrador.idFF, apodo: borrador.apodo, agregadoPor: extraerNumero(jidUsuario) });
    borradoresIntegrante.delete(claveBorrador(jidChat, jidUsuario));
    await sock.sendMessage(jidChat, { text: `${actualizado ? '✏️ Ficha actualizada' : '✅ ¡Integrante registrada!'} 💖\n\n${formatearFichaIntegrante(ficha)}` });
  } else {
    const faltan = ['nombre', 'numero', 'idFF', 'apodo'].filter(c => !borrador[c]).map(c => ETIQUETAS_CAMPO_BORRADOR[c]);
    await sock.sendMessage(jidChat, { text: `📝 Anoté "${valor}" ✅\n\nMe falta: ${faltan.join(', ')}` });
  }
}

const pendingSalidasClan = new Map();

async function avisarSalidaIntegranteRegistrado(sock, jidGrupo, numeroSalio) {
  const ficha = buscarIntegrantePorNumero(numeroSalio);
  if (!ficha) return;
  pendingSalidasClan.set(ficha.codigo, { jidGrupoOrigen: jidGrupo, fecha: Date.now() });
  const mensajeAviso = await generarMensajeVariadoIA(`Avisa al grupo, en un mensaje corto y natural, que una integrante registrada en el clan (apodada "${ficha.apodo}") salió o fue sacada del grupo, y que tiene registro en la lista.`, FRASES_AVISO_SALIDA_FALLBACK);
  await sock.sendMessage(jidGrupo, { text: mensajeAviso });
  await enviarFichaCompleta(sock, jidGrupo, ficha);
  await sock.sendMessage(jidGrupo, { text: `¿Deseas eliminarla de la lista del clan? Solo el propietario puede confirmarlo con: /eliminar ${ficha.codigo}` });
}

async function manejarComandosClanUniversal(sock, jidChat, jidUsuario, texto, mencionados, msg) {
  const matchNombre = texto.match(/^\/nombreff\s+(.+)/i); if (matchNombre) { await comandoCampoIntegrante(sock, jidChat, jidUsuario, 'nombre', matchNombre[1].trim()); return true; }
  const matchNumero = texto.match(/^\/numeroff\s+(.+)/i); if (matchNumero) { await comandoCampoIntegrante(sock, jidChat, jidUsuario, 'numero', matchNumero[1].trim()); return true; }
  const matchIdFF = texto.match(/^\/idff\s+(.+)/i); if (matchIdFF) { await comandoCampoIntegrante(sock, jidChat, jidUsuario, 'idFF', matchIdFF[1].trim()); return true; }
  const matchApodo = texto.match(/^\/apodoff\s+(.+)/i); if (matchApodo) { await comandoCampoIntegrante(sock, jidChat, jidUsuario, 'apodo', matchApodo[1].trim()); return true; }
  if (PATRON_COMANDO_ELIMINAR_FOTO.test(texto)) { const m = texto.match(PATRON_COMANDO_ELIMINAR_FOTO); await comandoEliminarFoto(sock, jidChat, jidUsuario, m[1]); return true; }
  if (PATRON_COMANDO_FOTOFF.test(texto)) { const m = texto.match(PATRON_COMANDO_FOTOFF); await comandoFotoIntegrante(sock, jidChat, jidUsuario, msg, m[1]); return true; }

  const partesTexto = texto.trim().split(/\s+/);
  const comando = (partesTexto[0] || '').toLowerCase();
  const resto = partesTexto.slice(1);

  if (comando === '/integrantes') { if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario 🚫' }); return true; } await sock.sendMessage(jidChat, { text: generarResumenClan() }); return true; }
  if (comando === '/lista') { if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario 🚫' }); return true; } await sock.sendMessage(jidChat, { text: generarTextoPaginaClan(resto[0]) }); return true; }
  if (comando === '/integrante') { await comandoIntegrantePorMencion(sock, jidChat, jidUsuario, mencionados || []); return true; }
  if (comando === '/eliminar') { await comandoEliminarPorCodigo(sock, jidChat, jidUsuario, resto[0]); return true; }
  if (comando === '/clan') {
    const sub = (resto[0] || '').toLowerCase();
    const restoSub = resto.slice(1).join(' ');
    if (sub === 'agregar') { await comandoClanAgregar(sock, jidChat, jidUsuario, restoSub); return true; }
    if (sub === 'quitar') { await comandoClanQuitar(sock, jidChat, jidUsuario, restoSub.trim()); return true; }
    if (sub === 'ver') { await comandoClanVer(sock, jidChat, restoSub.trim()); return true; }
    if (sub === 'lista') { await sock.sendMessage(jidChat, { text: generarResumenClan() }); return true; }
    await sock.sendMessage(jidChat, { text: 'Usa /integrantes 🙂' });
    return true;
  }
  return false;
}
function formatearMovimiento(jidGrupo, r) {
  const info = ETIQUETAS_MOVIMIENTO[r.accion] || { icono: '•', texto: r.accion };
  const fecha = new Date(r.fecha).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const nombreEjecutor = r.ejecutor ? obtenerEtiquetaPersona(r.ejecutor) : 'Desconocido';
  let cuerpo = `*MOVIMIENTO DE GRUPO* ${info.icono}\n\n*Grupo:* ${r.nombreGrupo || 'Sin nombre'}\n*Realizado por:* ${nombreEjecutor}${r.ejecutor ? ` (+${r.ejecutor})` : ' (número no disponible)'}\n*Acción:* ${info.texto}`;
  if (r.objetivos && r.objetivos.length) cuerpo += `\n*Afectado(s):* ${r.objetivos.map(n => `${obtenerEtiquetaPersona(n)} (+${n})`).join(', ')}`;
  cuerpo += `\n*Fecha:* ${fecha}`;
  return cuerpo;
}

async function comandoMovimientos(sock, jidGrupo, jidUsuario, argumentoTexto) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario)) && !(await esPropietarioContexto(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden ver los movimientos 🚫' }); return; }
  const numeroEncontrado = (argumentoTexto.match(/\d+/) || [])[0];
  const cantidad = Math.min(Math.max(parseInt(numeroEncontrado, 10) || 10, 1), 30);
  const registros = registroMovimientos.filter(r => r.jidGrupo === jidGrupo).slice(-cantidad).reverse();
  if (!registros.length) { await sock.sendMessage(jidGrupo, { text: '📋 Todavía no hay movimientos registrados.' }); return; }
  await sock.sendMessage(jidGrupo, { text: `*ÚLTIMOS MOVIMIENTOS*\n\n${registros.map(r => formatearMovimiento(jidGrupo, r)).join('\n\n')}` });
}

async function comandoPromoverDegradar(sock, jidGrupo, jidUsuario, mencionados, accion) {
  if (!mencionados.length) return { ok: false };
  try {
    marcarAccionBotReciente(jidGrupo, accion, mencionados);
    await sock.groupParticipantsUpdate(jidGrupo, mencionados, accion);
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); actualizarCacheLid(meta); nombreGrupo = meta.subject; } catch (err) {}
    await registrarAccionAdmin(sock, jidGrupo, accion, jidUsuario, mencionados, nombreGrupo);
    return { ok: true };
  } catch (err) { return { ok: false }; }
}

async function comandoPromoverDegradarComando(sock, jidGrupo, jidUsuario, mencionados, accion) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden usar este comando 🚫' }); return; }
  if (!mencionados.length) { await sock.sendMessage(jidGrupo, { text: `Menciona a quién: /${accion === 'promote' ? 'promover' : 'degradar'} @usuario` }); return; }
  const r = await comandoPromoverDegradar(sock, jidGrupo, jidUsuario, mencionados, accion);
  await sock.sendMessage(jidGrupo, { text: r.ok ? (accion === 'promote' ? '⭐ Listo, ahora es admin.' : '🔻 Listo, ya no es admin.') : 'No pude hacer el cambio, revisa que el bot sea admin del grupo.' });
}

async function comandoTodos(sock, jidGrupo, jidUsuario, mensajeExtra) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden usar /todos 🚫' }); return; }
  try {
    const metadata = await sock.groupMetadata(jidGrupo);
    actualizarCacheLid(metadata);
    const jids = metadata.participants.map(p => p.id);
    const texto = mensajeExtra ? `📢 ${mensajeExtra}` : '📢 ¡Atención a todas!';
    await sock.sendMessage(jidGrupo, { text: `${texto}\n\n${jids.map(j => `@${j.split('@')[0]}`).join(' ')}`, mentions: jids });
  } catch (err) { await sock.sendMessage(jidGrupo, { text: 'No pude etiquetar a todos, intenta de nuevo.' }); }
}

async function comandoCerrarGrupo(sock, jidGrupo, jidUsuario, cerrar) {
  try {
    await sock.groupSettingUpdate(jidGrupo, cerrar ? 'announcement' : 'not_announcement');
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); actualizarCacheLid(meta); nombreGrupo = meta.subject; } catch (err) {}
    await registrarAccionAdmin(sock, jidGrupo, cerrar ? 'cerrar' : 'abrir', jidUsuario, [], nombreGrupo);
    await sock.sendMessage(jidGrupo, { text: cerrar ? '🔒 Grupo cerrado, solo admins escriben.' : '🔓 Grupo abierto para todas.' });
  } catch (err) { await sock.sendMessage(jidGrupo, { text: 'No pude cambiar la configuración, revisa que el bot sea admin.' }); }
}

async function comandoCerrarGrupoComando(sock, jidGrupo, jidUsuario, cerrar) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo admins 🚫' }); return; }
  await comandoCerrarGrupo(sock, jidGrupo, jidUsuario, cerrar);
}

function generarTextoInfo() {
  return `🤖 *${NOMBRE_BOT}* — v${VERSION_BOT}\n\n👨‍💻 Creada por: *${CREADOR}*.\n🟢 Estado: ${estado.conectado ? 'Conectada' : 'Desconectada'}\n⏱ Activa desde hace: ${formatearDuracionLarga(obtenerUptimeMs())}\n\nEscribe /comando anzy para ver comandos.`;
}

const TEXTO_CREADOR = `💖 Fui creada con mucho cariño por *${CREADOR}*. ¡Gracias por todo! 🙌✨`;

async function procesarComandoJefe(sock, remitente, texto) {
  const t = texto.toLowerCase().trim();
  if (t === 'salir' || t.includes('modo normal')) { modoJefe.delete(remitente); await sock.sendMessage(remitente, { text: 'Listo jefe, cerré el menú 🙌' }); return; }
  if (t.includes('informe') || t.includes('estado')) { await sock.sendMessage(remitente, { text: `📊 Conectada: ${estado.conectado ? 'Sí' : 'No'}\nBot activo: ${botActivo ? 'Sí' : 'No'}\n${textoUptime()}\n\nRecibidos: ${estado.mensajesRecibidos}\nEnviados: ${estado.mensajesEnviados}\nCuota IA: ${contadorCuota.usados}/${LIMITE_DIARIO_ESTIMADO}` }); return; }
  if (t.includes('apaga')) { botActivo = false; await sock.sendMessage(remitente, { text: '🔴 Bot apagado.' }); return; }
  if (t.includes('enciende') || t.includes('activa')) { botActivo = true; await sock.sendMessage(remitente, { text: '🟢 Bot encendido.' }); return; }
  if (t.includes('restaura')) { estiloGlobalExtra = ''; await sock.sendMessage(remitente, { text: '✅ Volví a mi forma original.' }); return; }
  estiloGlobalExtra = texto.trim();
  await sock.sendMessage(remitente, { text: `✅ Actualicé mi forma de expresarme:\n"${estiloGlobalExtra}"` });
}

async function generarAnuncioActualizacionIA(mejorasTexto) {
  const prompt = `Escribe un anuncio corto, emocionante y cálido (tono femenino) avisando que el bot ${NOMBRE_BOT} entrará en mantenimiento para traer estas mejoras: ${mejorasTexto || 'mejoras generales de rendimiento y nuevas funciones'}. No agregues firma ni versión al final, eso se agrega aparte. Máximo 5 líneas.`;
  try {
    const respuesta = await generarRespuestaIA(prompt, 'Genera SOLO el anuncio, sin comillas.', 'sistema_interno', 'sistema_interno');
    return (respuesta || '').trim() || `🛠️ ${NOMBRE_BOT} entrará en actualización con nuevas mejoras.`;
  } catch (err) { return `🛠️ ${NOMBRE_BOT} entrará en actualización con nuevas mejoras.`; }
}

async function comandoActualizacion(sock, jidChat, jidUsuario, mejorasTexto) {
  if (!(await esPropietarioContexto(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo el propietario puede anunciar actualizaciones 🚫' }); return; }
  await sock.sendMessage(jidChat, { text: '📡 Preparando el anuncio y avisando a todos los grupos...' });
  try {
    const anuncio = await generarAnuncioActualizacionIA(mejorasTexto);
    const mensajeFinal = `${anuncio}\n\n_Versión actual: v${VERSION_BOT}_\n\n> ${CREADOR}`;
    const grupos = await sock.groupFetchAllParticipating();
    let enviados = 0;
    for (const jid of Object.keys(grupos)) { try { await sock.sendMessage(jid, { text: mensajeFinal }); enviados++; } catch (err) {} }
    await sock.sendMessage(jidChat, { text: `✅ Aviso enviado a ${enviados} grupo(s).` });
  } catch (err) { await sock.sendMessage(jidChat, { text: 'No pude generar/enviar el aviso, intenta de nuevo.' }); }
}

async function manejarComandosGenerales(sock, jidChat, jidUsuario, texto, mencionados, esGrupo, clavePendientePropietario) {
  const partesTexto = texto.trim().split(/\s+/);
  const comando = (partesTexto[0] || '').toLowerCase();
  const resto = partesTexto.slice(1);

  switch (comando) {
    case '/frase': await sock.sendMessage(jidChat, { text: comandoFrase() }); return true;
    case '/imagen': await comandoImagen(sock, jidChat, resto.join(' ')); return true;
    case '/perfil': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoPerfil(sock, jidChat, jidUsuario, mencionados[0]); return true;
    case '/ranking': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } { const { texto: t, mentions } = await comandoRanking(sock, jidChat); await sock.sendMessage(jidChat, { text: t, mentions }); } return true;
    case '/promover': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoPromoverDegradarComando(sock, jidChat, jidUsuario, mencionados, 'promote'); return true;
    case '/degradar': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoPromoverDegradarComando(sock, jidChat, jidUsuario, mencionados, 'demote'); return true;
    case '/todos': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoTodos(sock, jidChat, jidUsuario, resto.join(' ')); return true;
    case '/cerrar': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoCerrarGrupoComando(sock, jidChat, jidUsuario, true); return true;
    case '/abrir': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoCerrarGrupoComando(sock, jidChat, jidUsuario, false); return true;
    case '/recordatorio': {
      if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; }
      if (!(await esAdminGrupo(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo admins 🚫' }); return true; }
      const entrada = resto[0] || ''; const textoRecordatorio = resto.slice(1).join(' ');
      const match = entrada.match(/^(\d+)([smh])$/i);
      if (!match || !textoRecordatorio) { await sock.sendMessage(jidChat, { text: 'Uso: /recordatorio <tiempo><S|M|H> <texto>' }); return true; }
      const cantidad = parseInt(match[1], 10); const unidad = match[2].toLowerCase();
      const multiplicador = unidad === 's' ? 1000 : unidad === 'm' ? 60000 : 3600000;
      programarRecordatorioGrupo(jidChat, cantidad * multiplicador, textoRecordatorio);
      await sock.sendMessage(jidChat, { text: `⏰ Listo, aviso programado: "${textoRecordatorio}"` });
      return true;
    }
    case '/movimiento': case '/movimientos': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoMovimientos(sock, jidChat, jidUsuario, resto.join(' ')); return true;
    case '/propietario': pendientesPropietario.set(clavePendientePropietario, Date.now()); await sock.sendMessage(jidChat, { text: '🔐 Escribe la contraseña de propietario:' }); return true;
    case '/silencio': {
      if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario 🚫' }); return true; }
      if (!mencionados.length) { await sock.sendMessage(jidChat, { text: 'Menciona a quién silenciar.' }); return true; }
      mencionados.forEach(j => SILENCIADOS.add(extraerNumero(j))); guardarSilenciados();
      await sock.sendMessage(jidChat, { text: `🔇 Listo, dejé de responderle a ${mencionados.length} usuario(s).` });
      return true;
    }
    case '/activarse': {
      if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario 🚫' }); return true; }
      if (!mencionados.length) { await sock.sendMessage(jidChat, { text: 'Menciona a quién reactivar.' }); return true; }
      mencionados.forEach(j => SILENCIADOS.delete(extraerNumero(j))); guardarSilenciados();
      await sock.sendMessage(jidChat, { text: `🔊 Listo, ya vuelvo a responderle.` });
      return true;
    }
    // 🔧 /novia — arreglado el bug de la clave (usa identidadModo resuelto)
    // 🆕 /novia @usuario — SOLO el propietario, aplica el modo dirigido a
    // esa persona sin encender el modo global del chat.
    case '/novia': {
      const sub = (resto[0] || '').toLowerCase();
      if (sub === 'on') {
        const identidadModo = (await resolverNumeroReal(sock, jidChat, jidUsuario)) || extraerNumero(jidUsuario);
        activarModo(modoNovia, jidChat, identidadModo);
        await sock.sendMessage(jidChat, { text: '💕 Modo novia activado 😘' });
      } else if (sub === 'off') {
        const identidadModo = (await resolverNumeroReal(sock, jidChat, jidUsuario)) || extraerNumero(jidUsuario);
        desactivarTodosLosModos(jidChat, identidadModo);
        await sock.sendMessage(jidChat, { text: '💫 Volví a mi forma normal.' });
      } else if (mencionados && mencionados.length) {
        if (!(await esPropietarioContexto(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo el propietario puede usar /novia @usuario 🚫' }); return true; }
        if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Ese uso de /novia solo funciona dentro de un grupo.' }); return true; }
        const identidadObjetivo = (await resolverNumeroReal(sock, jidChat, mencionados[0])) || extraerNumero(mencionados[0]);
        activarModo(modoNovia, jidChat, identidadObjetivo);
        await sock.sendMessage(jidChat, { text: `💘 Listo, ahora seré la novia virtual de ${obtenerNombreVisible(mencionados[0])} en este chat 😏` });
      } else {
        await sock.sendMessage(jidChat, { text: 'Uso:\n/novia on\n/novia off\n/novia @usuario (solo propietario)' });
      }
      return true;
    }
    // 🔧 /amiga — mismo arreglo de clave que /novia
    case '/amiga': {
      const sub = (resto[0] || '').toLowerCase();
      const identidadModo = (await resolverNumeroReal(sock, jidChat, jidUsuario)) || extraerNumero(jidUsuario);
      if (sub === 'on') { activarModo(modoAmiga, jidChat, identidadModo); await sock.sendMessage(jidChat, { text: '👯 Modo amiga activado 💕' }); }
      else if (sub === 'off') { desactivarTodosLosModos(jidChat, identidadModo); await sock.sendMessage(jidChat, { text: '☺️ Volví a mi forma normal.' }); }
      else await sock.sendMessage(jidChat, { text: 'Uso:\n/amiga on\n/amiga off' });
      return true;
    }
    case '/estado': await sock.sendMessage(jidChat, { text: (await esPropietarioContexto(sock, jidChat, jidUsuario)) ? generarResumenDiagnostico() : generarResumenEstadoPublico() }); return true;
    case '/diagnostico': {
      if (!(await esPropietarioContexto(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo el propietario puede ver el diagnóstico 🚫' }); return true; }
      await sock.sendMessage(jidChat, { text: generarResumenDiagnostico() });
      return true;
    }
    case '/info': await sock.sendMessage(jidChat, { text: generarTextoInfo() }); return true;
    case '/creador': await sock.sendMessage(jidChat, { text: TEXTO_CREADOR }); return true;
    case '/actualizacion': await comandoActualizacion(sock, jidChat, jidUsuario, resto.join(' ')); return true;
    case '/recordar': { const lista = memoriaPersistente[jidUsuario] || []; if (!lista.length) { await sock.sendMessage(jidChat, { text: 'Aún no tengo nada guardado de ti 🤔' }); return true; } await sock.sendMessage(jidChat, { text: `🧠 Esto recuerdo:\n\n${lista.map(m => `👤 ${m.texto}\n🤖 ${m.respuesta}`).join('\n\n')}` }); return true; }
    case '/olvidarme': olvidarUsuario(jidUsuario); await sock.sendMessage(jidChat, { text: 'Listo, borré mi memoria de ti 🗑️' }); return true;
  }
  return false;
}
async function procesarMensajeGrupo(sock, msg, identificadoresBot) {
  const jidGrupo = msg.key.remoteJid;
  const jidUsuario = msg.key.participant || msg.key.remoteJid;
  const nombreContacto = msg.pushName || 'amiga';
  const texto = obtenerTextoMensaje(msg);
  if (!texto) return;

  if (esNumeroIgnorado(jidUsuario)) return;
  registrarNombreConocido(jidUsuario, msg.pushName);

  const clavePendientePropietario = `${jidGrupo}:${jidUsuario}`;
  if (pendientesPropietario.has(clavePendientePropietario)) {
    pendientesPropietario.delete(clavePendientePropietario);
    if (texto.trim() === CODIGO_DUEÑO) {
      const numeroReal = await resolverNumeroReal(sock, jidGrupo, jidUsuario);
      if (numeroReal) { propietariosVerificados.add(numeroReal); guardarPropietariosEnNube(); }
      await sock.sendMessage(jidGrupo, { text: '👑 Contraseña correcta. Te reconozco como propietaria/o del bot.' });
    } else { await sock.sendMessage(jidGrupo, { text: '❌ Contraseña incorrecta. Escribe /propietario para intentar de nuevo.' }); }
    return;
  }

  registrarMensajeGrupo(jidGrupo, jidUsuario);

  if (/^\/comando\s+anzy$/i.test(texto)) { await sock.sendMessage(jidGrupo, { text: TEXTO_AYUDA }); return; }
  if (PATRON_COMANDO_TIKTOK.test(texto)) { await manejarComandoTiktok(sock, jidGrupo, texto.replace(PATRON_COMANDO_TIKTOK, '').trim()); return; }
  if (PATRON_COMANDO_YOUTUBE.test(texto)) { const m = texto.match(PATRON_COMANDO_YOUTUBE); await manejarComandoYoutube(sock, jidGrupo, m[1]); return; }
  if (PATRON_COMANDO_YOUTUBEVIDEO.test(texto)) { const m = texto.match(PATRON_COMANDO_YOUTUBEVIDEO); await manejarComandoYoutubeVideo(sock, jidGrupo, m[1]); return; }
  if (PATRON_COMANDO_FACEBOOK_AUDIO.test(texto)) { const m = texto.match(PATRON_COMANDO_FACEBOOK_AUDIO); await manejarComandoFacebook(sock, jidGrupo, m[1], 'audio'); return; }
  if (PATRON_COMANDO_FACEBOOK.test(texto)) { const m = texto.match(PATRON_COMANDO_FACEBOOK); await manejarComandoFacebook(sock, jidGrupo, m[1], 'video'); return; }
  if (PATRON_COMANDO_INSTAGRAM.test(texto)) { const m = texto.match(PATRON_COMANDO_INSTAGRAM); await manejarComandoInstagram(sock, jidGrupo, m[1]); return; }

  if (esIntencionCompra(texto)) {
    try { await sock.sendMessage(jidGrupo, { text: 'Dame un toque que le aviso a Alberto 🙌', mentions: [jidUsuario] }); await sock.sendMessage(JID_DUEÑO, { text: `💰 Posible cliente: ${nombreContacto} preguntó: "${texto}"` }); } catch (err) {}
    return;
  }

  const mencionados = obtenerContextInfo(msg)?.mentionedJid || [];
  if (await manejarComandosClanUniversal(sock, jidGrupo, jidUsuario, texto, mencionados, msg)) return;

  try { const manejado = await manejarComandosGenerales(sock, jidGrupo, jidUsuario, texto, mencionados, true, clavePendientePropietario); if (manejado) return; }
  catch (err) { console.log('❌ Error en comando:', err.message); return; }

  if (!debeResponderIA(texto, msg, identificadoresBot)) return;

  if (esMensajeDeCrisis(texto)) { try { await sock.sendMessage(JID_DUEÑO, { text: `🚨 Alerta: ${nombreContacto} escribió: "${texto}"` }); } catch (err) {} }

  const consultaSinMencion = texto.replace(/@\d+/g, '').replace(/^\/\S*\s*/, '').trim() || texto;

  // 🔧 Identidad resuelta UNA sola vez para esta persona, en este chat —
  // se usa tanto para el audio citado como para la respuesta de texto, así
  // el modo novia/amiga se detecta siempre con la misma clave.
  const identidadModo = (await resolverNumeroReal(sock, jidGrupo, jidUsuario)) || extraerNumero(jidUsuario);
  // 🆕 v3.4.0: la identidad ya está resuelta; se reutiliza para saber si es el propietario (evita otra consulta a WhatsApp).
  const esDueñoResuelto = !!identidadModo && (esPropietario(identidadModo) || propietariosVerificados.has(identidadModo));
  sock.sendPresenceUpdate('composing', jidGrupo).catch(() => {});

  // 🆕 v3.4.0: foto adjunta / citada / reciente (visión, tareas, hojas) — solo si se activó la IA (mención o /anzy).
  try { if (await manejarImagenIA(sock, msg, { jidChat: jidGrupo, jidUsuario, identidadModo, nombreContacto, consulta: consultaSinMencion, esGrupo: true })) return; }
  catch (err) { console.log('❌ Error en flujo de imagen:', sanitizarParaLog(err.message)); return; }

  // 🆕 v3.4.0: tiempo encendida real y herramientas autorizadas en lenguaje natural.
  try { if (await manejarHerramientasNaturales(sock, { jidChat: jidGrupo, jidUsuario, consulta: consultaSinMencion, esGrupo: true, esDueno: esDueñoResuelto })) return; }
  catch (err) { console.log('❌ Error en herramienta natural:', sanitizarParaLog(err.message)); }

  const audioCitado = extraerAudioCitado(msg);
  if (audioCitado) {
    try {
      const bufferAudio = await descargarAudioCitado(audioCitado);
      const respuesta = await generarRespuestaIAConAudio(bufferAudio, audioCitado.mimetype, consultaSinMencion || 'Escucha este audio y cuéntame de qué trata.', `Mensaje de ${nombreContacto} en un grupo.`, jidGrupo, identidadModo);
      await enviarRespuestaHumanizada(sock, jidGrupo, respuesta, [jidUsuario]);
      agregarAMemoriaCorta(jidUsuario, texto, respuesta);
    } catch (err) { console.log('❌ Error procesando audio citado:', err.message); await sock.sendMessage(jidGrupo, { text: '💔 No pude escuchar ese audio, intenta de nuevo.' }); }
    return;
  }

  if (mencionados.length && /\b(informaci[oó]n|informe|info|datos|ficha|perfil|foto)\b/i.test(consultaSinMencion)) {
    if (await tienePermisoClan(sock, jidGrupo, jidUsuario)) {
      const numero = await resolverNumeroReal(sock, jidGrupo, mencionados[0]);
      const ficha = numero ? buscarIntegrantePorNumero(numero) : null;
      if (ficha) { await enviarFichaCompleta(sock, jidGrupo, ficha); return; }
    }
  }

  const nombreBuscado = detectarSolicitudInfoPorNombre(consultaSinMencion);
  if (nombreBuscado && await tienePermisoClan(sock, jidGrupo, jidUsuario)) {
    const encontrados = buscarIntegrantesPorNombre(nombreBuscado);
    if (encontrados.length === 1) { await enviarFichaCompleta(sock, jidGrupo, encontrados[0]); return; }
    if (encontrados.length > 1) { await sock.sendMessage(jidGrupo, { text: `Varias coincidencias:\n\n${encontrados.map(f => `• ${f.nombre} (${f.apodo}) — código ${f.codigo}`).join('\n')}\n\nUsa /clan ver <código>.` }); return; }
  }

  try {
    const textoCitado = extraerTextoCitado(msg);
    const esDueño = esDueñoResuelto;
    let notas = `Mensaje de ${nombreContacto} en un grupo de WhatsApp.`;
    if (esDueño) notas += `\n\nIMPORTANTE: es TU PROPIETARIO/CREADOR.`;
    if (textoCitado) notas += `\n\nMENSAJE CITADO: "${textoCitado}"`;
    notas += obtenerContextoCorto(jidUsuario) + contextoSistemaSiAplica(consultaSinMencion);
    const respuesta = await generarRespuestaIA(consultaSinMencion, notas, jidGrupo, identidadModo);
    await enviarRespuestaHumanizada(sock, jidGrupo, respuesta, [jidUsuario]);
    agregarAMemoriaCorta(jidUsuario, texto, respuesta);
  } catch (err) { console.log('❌ Error IA:', sanitizarParaLog(err.message)); avisarPropietarioSiConfiguracion(sock, err, 'respuesta_ia'); await sock.sendMessage(jidGrupo, { text: mensajeEsperaAleatorio() }); }
}
function registrarBienvenidasYDespedidas(sock) {
  sock.ev.on('group-participants.update', async (evento) => {
    const { id: jidGrupo, participants, action, author } = evento;
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); actualizarCacheLid(meta); nombreGrupo = meta.subject; } catch (err) {}
    for (const participanteRaw of participants) {
      const { jid: jidParticipante, numero: numeroParticipante } = normalizarParticipante(participanteRaw);
      if (!jidParticipante) continue;
      if (['add', 'remove', 'promote', 'demote'].includes(action) && !accionFueDelBot(jidGrupo, action, jidParticipante)) {
        await registrarAccionAdmin(sock, jidGrupo, action, author || null, [jidParticipante], nombreGrupo, [numeroParticipante]);
      }
      if (action === 'remove' && esNumeroTelefonicoProbable(numeroParticipante)) {
        avisarSalidaIntegranteRegistrado(sock, jidGrupo, numeroParticipante).catch(err => console.log('⚠️ Error avisando salida:', err.message));
      }
    }
  });
}

const estado = { conectado: false, inicio: INICIO_PROCESO_MS, mensajesRecibidos: 0, mensajesEnviados: 0, ultimoQR: null, intentosReconexion: 0, ultimoError: null };
function calcularEsperaReconexion(intentos) { const base = Math.min(3000 * Math.pow(2, intentos), 60000); return intentos > 8 ? 90000 : base; }

const almacenMensajes = new Map();
// 🆕 v3.4.0: el almacén crecía sin límite (fuga de memoria). Ahora conserva solo los últimos mensajes.
const MAX_MENSAJES_ALMACEN = 3000;
function guardarEnAlmacen(msg) {
  almacenMensajes.set(msg.key.id, msg.message);
  if (almacenMensajes.size > MAX_MENSAJES_ALMACEN) { const masViejo = almacenMensajes.keys().next().value; almacenMensajes.delete(masViejo); }
}
let nubeInicializada = false;
let IDENTIFICADORES_BOT_CACHE = [];

async function iniciarBot() {
  limpiarArchivosTemporalesViejos();
  await verificarBinarioYtDlp();
  await actualizarSistema();

  if (!nubeInicializada) { await inicializarNubeIntegrantes(); await inicializarNubePropietarios(); try { await inicializarVoz(); } catch (err) { console.log('⚠️ Error inicializando la voz:', sanitizarParaLog(err.message)); } nubeInicializada = true; }

  const { state, saveCreds } = await useMultiFileAuthState('sesion');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ auth: state, version, printQRInTerminal: false, browser: [NOMBRE_BOT, 'Chrome', '2.0.0'], syncFullHistory: false, markOnlineOnConnect: true, getMessage: async (key) => almacenMensajes.get(key.id) || undefined, logger: pino({ level: 'error' }) });

  sockActivo = sock;
  sock.ev.on('creds.update', saveCreds);
  registrarBienvenidasYDespedidas(sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) { estado.ultimoQR = await QRCode.toDataURL(qr); qrcodeTerminal.generate(qr, { small: true }); }
    if (connection === 'open') { estado.conectado = true; estado.intentosReconexion = 0; estado.ultimoQR = null; IDENTIFICADORES_BOT_CACHE = obtenerIdentificadoresBot(sock); console.log('\n✅ BOT CONECTADO Y LISTO ✅'); }
    if (connection === 'close') {
      estado.conectado = false;
      const motivo = lastDisconnect?.error?.output?.statusCode;
      estado.ultimoError = lastDisconnect?.error?.message || 'Desconocido';
      registrarEventoDiag('conexion_whatsapp', lastDisconnect?.error || 'Desconocido', null, `motivo=${lastDisconnect?.error?.output?.statusCode ?? 'n/d'}`);
      if (motivo === DisconnectReason.loggedOut || motivo === DisconnectReason.badSession) { console.log('❌ Sesión inválida. Borra "sesion" y vuelve a escanear.'); return; }
      if (motivo === DisconnectReason.restartRequired) { setTimeout(() => iniciarBot(), 1500); return; }
      estado.intentosReconexion++;
      setTimeout(() => iniciarBot(), calcularEsperaReconexion(estado.intentosReconexion));
    }
  });

  // 🆕 v3.4.0: antes solo se atendía el primer mensaje de cada lote (m.messages[0]); ahora se atienden todos, en paralelo.
  const procesarUpsert = async (msg) => {
    if (!msg || !msg.message) return;
    const remitente = msg.key.remoteJid;
    if (msg.key.fromMe) return;
    guardarEnAlmacen(msg);
    registrarImagenSiCorresponde(msg);

    if (!remitente.endsWith('@g.us')) {
      if (remitente.endsWith('@s.whatsapp.net') || remitente.endsWith('@lid')) {
        const textoPersonal = obtenerTextoMensaje(msg);
        if (esNumeroIgnorado(remitente)) return;

        if (pendientesPropietario.has(remitente)) {
          pendientesPropietario.delete(remitente);
          if (textoPersonal.trim() === CODIGO_DUEÑO) { propietariosVerificados.add(extraerNumero(remitente)); guardarPropietariosEnNube(); await sock.sendMessage(remitente, { text: '👑 Contraseña correcta. Te reconozco como propietaria/o.' }); }
          else await sock.sendMessage(remitente, { text: '❌ Contraseña incorrecta. Escribe /propietario para intentar de nuevo.' });
          return;
        }

        // 🆕 v3.5.0: nota de voz del propietario en su chat privado → respuesta hablada automática (sin importar el modo).
        if (VOZ && esPropietarioEfectivo(remitente)) {
          try { if (await manejarNotaDeVozPropietario(sock, msg, remitente)) return; }
          catch (err) { registrarEventoDiag('nota_de_voz', err); console.log('❌ Error en nota de voz:', sanitizarParaLog(err.message)); return; }
        }

        if (!textoPersonal) return;

        if (/^\/comando\s+anzy$/i.test(textoPersonal)) { await sock.sendMessage(remitente, { text: TEXTO_AYUDA }); return; }
        if (PATRON_COMANDO_TIKTOK.test(textoPersonal)) { await manejarComandoTiktok(sock, remitente, textoPersonal.replace(PATRON_COMANDO_TIKTOK, '').trim()); return; }
        if (PATRON_COMANDO_YOUTUBE.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_YOUTUBE); await manejarComandoYoutube(sock, remitente, m[1]); return; }
        if (PATRON_COMANDO_YOUTUBEVIDEO.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_YOUTUBEVIDEO); await manejarComandoYoutubeVideo(sock, remitente, m[1]); return; }
        if (PATRON_COMANDO_FACEBOOK_AUDIO.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_FACEBOOK_AUDIO); await manejarComandoFacebook(sock, remitente, m[1], 'audio'); return; }
        if (PATRON_COMANDO_FACEBOOK.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_FACEBOOK); await manejarComandoFacebook(sock, remitente, m[1], 'video'); return; }
        if (PATRON_COMANDO_INSTAGRAM.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_INSTAGRAM); await manejarComandoInstagram(sock, remitente, m[1]); return; }

        if (await manejarComandosClanUniversal(sock, remitente, remitente, textoPersonal, [], msg)) return;

        if (esCodigoDueño(textoPersonal)) { modoJefe.set(remitente, true); await sock.sendMessage(remitente, { text: `🔐 Menú activado, jefe.\n\ninforme · apagar · encender · restaura · salir` }); return; }
        if (modoJefe.get(remitente)) { await procesarComandoJefe(sock, remitente, textoPersonal); return; }

        try { const manejado = await manejarComandosGenerales(sock, remitente, remitente, textoPersonal, [], false, remitente); if (manejado) return; } catch (err) { return; }

        // 🆕 v3.5.0: en el chat privado del propietario se conversa sin comandos (desactivable con CHAT_PRIVADO_LIBRE=false).
        const esDueñoPrivado = esPropietarioEfectivo(remitente);
        if (debeResponderIA(textoPersonal, msg, IDENTIFICADORES_BOT_CACHE) || (CHAT_PRIVADO_LIBRE && esDueñoPrivado)) {
          const consultaSinMencion = textoPersonal.replace(/^\/\S*\s*/, '').trim() || textoPersonal;
          // 🔧 En privado la identidad es simplemente el número de quien
          // escribe — no hace falta resolver contra metadata de grupo.
          const identidadModo = extraerNumero(remitente);
          sock.sendPresenceUpdate('composing', remitente).catch(() => {});

          // 🆕 v3.5.0: instrucciones naturales para cambiar entre texto y voz (solo el propietario, solo en privado).
          if (VOZ && esDueñoPrivado && !extraerImagenDeMensaje(msg)) {
            try { if (await manejarCambioModoVoz(sock, remitente, consultaSinMencion, identidadModo)) return; }
            catch (err) { console.log('❌ Error al cambiar el modo de voz:', sanitizarParaLog(err.message)); }
          }
          const modoVozActivo = !!(VOZ && esDueñoPrivado && obtenerPrefVoz(identidadModo).modo === 'voz');

          // 🆕 v3.4.0: fotos, tiempo encendida y herramientas autorizadas también en privado.
          try { if (await manejarImagenIA(sock, msg, { jidChat: remitente, jidUsuario: remitente, identidadModo, nombreContacto: msg.pushName || 'un usuario', consulta: consultaSinMencion, esGrupo: false })) return; }
          catch (err) { console.log('❌ Error en flujo de imagen:', sanitizarParaLog(err.message)); return; }
          try { if (await manejarHerramientasNaturales(sock, { jidChat: remitente, jidUsuario: remitente, consulta: consultaSinMencion, esGrupo: false, esDueno: esPropietarioEfectivo(remitente) })) return; }
          catch (err) { console.log('❌ Error en herramienta natural:', sanitizarParaLog(err.message)); }

          const audioCitado = extraerAudioCitado(msg);
          if (audioCitado) {
            try {
              const bufferAudio = await descargarAudioCitado(audioCitado);
              const respuesta = await generarRespuestaIAConAudio(bufferAudio, audioCitado.mimetype, consultaSinMencion || 'Escucha este audio y cuéntame de qué trata.', `Mensaje privado de ${msg.pushName || 'un usuario'}.${modoVozActivo ? NOTA_MODO_VOZ : ''}`, remitente, identidadModo);
              if (modoVozActivo) await responderConVoz(sock, remitente, respuesta, identidadModo); else await enviarRespuestaHumanizada(sock, remitente, respuesta, []);
              agregarAMemoriaCorta(remitente, textoPersonal, respuesta);
            } catch (err) { await sock.sendMessage(remitente, { text: '💔 No pude escuchar ese audio.' }); }
            return;
          }

          const nombreBuscado = detectarSolicitudInfoPorNombre(consultaSinMencion);
          if (nombreBuscado && esPropietarioEfectivo(remitente)) {
            const encontrados = buscarIntegrantesPorNombre(nombreBuscado);
            if (encontrados.length === 1) { await enviarFichaCompleta(sock, remitente, encontrados[0]); return; }
            if (encontrados.length > 1) { await sock.sendMessage(remitente, { text: `Varias coincidencias:\n\n${encontrados.map(f => `• ${f.nombre} (${f.apodo}) — código ${f.codigo}`).join('\n')}\n\nUsa /clan ver <código>.` }); return; }
          }
          try {
            const esDueño = esPropietarioEfectivo(remitente);
            let notas = `Mensaje privado de ${msg.pushName || 'un usuario'}.`;
            if (esDueño) notas += `\n\nIMPORTANTE: es TU PROPIETARIO/CREADOR.`;
            notas += obtenerContextoCorto(remitente) + contextoSistemaSiAplica(consultaSinMencion) + (modoVozActivo ? NOTA_MODO_VOZ : '');
            const respuesta = await generarRespuestaIA(consultaSinMencion, notas, remitente, identidadModo);
            if (modoVozActivo) await responderConVoz(sock, remitente, respuesta, identidadModo); else await enviarRespuestaHumanizada(sock, remitente, respuesta, []);
            agregarAMemoriaCorta(remitente, textoPersonal, respuesta);
          } catch (err) { await sock.sendMessage(remitente, { text: mensajeEsperaAleatorio() }); }
        }
      }
      return;
    }

    if (!botActivo) return;
    const tipoMensaje = Object.keys(msg.message)[0];
    const tieneTexto = !!(msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption);
    const esSoloMedia = ['audioMessage', 'videoMessage', 'stickerMessage'].includes(tipoMensaje) && !tieneTexto;
    const esImagenSinTexto = tipoMensaje === 'imageMessage' && !tieneTexto;
    if (esSoloMedia || esImagenSinTexto) return;

    estado.mensajesRecibidos++;
    try { await procesarMensajeGrupo(sock, msg, IDENTIFICADORES_BOT_CACHE); estado.mensajesEnviados++; }
    catch (err) { registrarEventoDiag('procesar_mensaje_grupo', err); console.log('❌ Error procesando mensaje de grupo:', sanitizarParaLog(err.message)); }
  };
  sock.ev.on('messages.upsert', async m => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) procesarUpsert(msg).catch(err => { registrarEventoDiag('messages_upsert', err); console.log('❌ Error en messages.upsert:', sanitizarParaLog(err.message)); });
  });
}

setInterval(async () => {
  if (!sockActivo || recordatoriosGrupo.length === 0) return;
  const ahora = Date.now();
  for (let i = recordatoriosGrupo.length - 1; i >= 0; i--) {
    if (recordatoriosGrupo[i].tiempoEjecucion <= ahora) { const r = recordatoriosGrupo[i]; try { await sockActivo.sendMessage(r.jidGrupo, { text: `⏰ Recordatorio: ${r.texto}` }); } catch (err) {} recordatoriosGrupo.splice(i, 1); }
  }
}, 30 * 1000);

const PANEL_FONDO_URL = limpiarValorEnv(process.env.PANEL_FONDO_URL) || '';

const LISTA_COMANDOS_PANEL = [
  { cat: '🧠 Inteligencia Artificial', items: [['/anzy <pregunta>', 'Pregúntale a la IA'], ['@bot <pregunta>', 'Mencionando al bot'], ['Cita un audio + menciona', 'Entiende y responde sobre el audio 🎙️'], ['Foto (adjunta o citada) + menciona', 'Lee la imagen, resuelve tareas y puede devolverlas en una hoja en imagen 📸'], ['/imagen <descripción>', 'Genera una imagen con IA']] },
  { cat: '🎭 Modos', items: [['/novia on · off', 'Modo cariñoso'], ['/amiga on · off', 'Modo amiga'], ['/novia @usuario', 'Solo propietario — activa modo novia dirigido a esa persona']] },
  { cat: '🎉 Descargas', items: [['/tiktok <enlace>', 'TikTok sin marca de agua'], ['/youtube <enlace>', 'Audio de YouTube'], ['/youtubevideo <enlace>', 'Video de YouTube'], ['/facebook <enlace>', 'Video de Facebook'], ['/facebookaudio <enlace>', 'Audio de Facebook'], ['/instagram <enlace>', 'Video de Instagram']] },
  { cat: '🎉 Utilidades', items: [['/frase', 'Frase random'], ['/perfil @user', 'Actividad en el grupo']] },
  { cat: '👑 Admin (grupo)', items: [['/promover @user', 'Lo hace admin'], ['/degradar @user', 'Le quita admin'], ['/todos <msj>', 'Etiqueta a todos'], ['/cerrar · /abrir', 'Controla quién escribe'], ['/recordatorio <n>S/M/H <texto>', 'Aviso al grupo'], ['/ranking', 'Top de más activas']] },
  { cat: '👑 SOLO PROPIETARIO (oculto del chat)', items: [
    ['/propietario', 'Verifica con contraseña (persiste en GitHub)'],
    ['/nombreff · /numeroff · /idff · /apodoff', 'Registro paso a paso'],
    ['/fotoff <código>', 'Guarda foto'], ['/eliminar foto <código>', 'Quita solo la foto'],
    ['/clan agregar/quitar/ver', 'Gestión del clan'], ['/eliminar <código>', 'Elimina integrante'],
    ['/integrantes · /lista NN', 'Ver el clan'], ['/integrante @user', 'Ficha de esa persona'],
    ['/silencio · /activarse @user', 'Ignorar/reactivar usuario'], ['/movimiento', 'Últimos movimientos'],
    ['/actualizacion <mejoras>', 'La IA redacta el aviso de mantenimiento y lo manda a todos los grupos'],
    ['/novia @usuario', 'Activa modo novia dirigido a esa persona, sin encender el modo global'],
    ['Voz (chat privado)', 'Nota de voz → respuesta hablada · "quiero escucharte" / "vuelve a escribirme" · "lista las voces" · "prueba tu voz"'],
    ['Aviso de salida', 'Si un integrante sale del grupo, el aviso+ficha+foto se manda AL MISMO GRUPO; solo tú confirmas la eliminación']
  ] },
  { cat: '📋 Info', items: [['/info', 'Info del bot'], ['/estado', 'Estado y tiempo encendida (el propietario ve el diagnóstico completo)'], ['/creador', 'Quién lo hizo'], ['/comando anzy', 'Lista pública']] },
  { cat: '🗂️ Memoria', items: [['/recordar', 'Qué recuerda de ti'], ['/olvidarme', 'Borra su memoria']] }
];

function generarHtmlComandos() {
  return LISTA_COMANDOS_PANEL.map(grupo => `
    <div class="cat-titulo">${grupo.cat}</div>
    <div class="cmd-grid">${grupo.items.map(([nombre, desc]) => `<div class="cmd-card"><div class="cmd-nombre">${nombre}</div><div class="cmd-desc">${desc}</div></div>`).join('')}</div>
  `).join('');
}

const app = express();

// 🔒 v3.4.0: protección OPCIONAL del panel. Si defines PANEL_TOKEN, las acciones (/panel/toggle, /panel/actualizacion) y el QR
// exigen ?token=... (o la cabecera x-panel-token). Si no lo defines, todo funciona como antes, pero cualquiera con la URL
// podría apagar el bot, mandar avisos a todos tus grupos o ver el QR de vinculación.
const PANEL_TOKEN = limpiarValorEnv(process.env.PANEL_TOKEN);
if (!PANEL_TOKEN) console.log('⚠️ SEGURIDAD: PANEL_TOKEN no está definido; el panel de control y /qr están accesibles sin contraseña.');
function panelAutorizado(req) {
  if (!PANEL_TOKEN) return true;
  const dado = String(req.query.token || req.headers['x-panel-token'] || '');
  const a = crypto.createHash('sha256').update(dado).digest();
  const b = crypto.createHash('sha256').update(PANEL_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
function sufijoTokenPanel(req) { return PANEL_TOKEN && panelAutorizado(req) ? `?token=${encodeURIComponent(PANEL_TOKEN)}` : ''; }

app.get('/status', (req, res) => {
  res.json({ conectado: estado.conectado, botActivo, uptimeSegundos: Math.floor((Date.now() - estado.inicio) / 1000), uptimeTexto: formatearDuracionLarga(obtenerUptimeMs()), inicioProceso: new Date(INICIO_PROCESO_MS).toISOString(), mensajesRecibidos: estado.mensajesRecibidos, mensajesEnviados: estado.mensajesEnviados, intentosReconexion: estado.intentosReconexion, cuotaUsada: contadorCuota.usados, cuotaLimite: LIMITE_DIARIO_ESTIMADO, version: VERSION_BOT });
});

app.get('/panel/toggle', (req, res) => { if (!panelAutorizado(req)) return res.status(401).send('No autorizado'); botActivo = !botActivo; res.redirect('/' + sufijoTokenPanel(req)); });

app.get('/panel/actualizacion', async (req, res) => {
  if (!panelAutorizado(req)) return res.status(401).send('No autorizado');
  if (sockActivo) {
    try {
      const anuncio = await generarAnuncioActualizacionIA(req.query.mejoras || '');
      const mensajeFinal = `${anuncio}\n\n_Versión actual: v${VERSION_BOT}_\n\n> ${CREADOR}`;
      const grupos = await sockActivo.groupFetchAllParticipating();
      for (const jid of Object.keys(grupos)) { try { await sockActivo.sendMessage(jid, { text: mensajeFinal }); } catch (err) {} }
    } catch (err) {}
  }
  res.redirect('/' + sufijoTokenPanel(req));
});

app.get('/', (req, res) => {
  const _tk = sufijoTokenPanel(req); const _controles = panelAutorizado(req);
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${NOMBRE_BOT} · Panel</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Creepster&family=Orbitron:wght@500;700;900&family=Space+Mono&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: #0a0005;
    ${PANEL_FONDO_URL ? `background-image: linear-gradient(rgba(10,0,5,0.75), rgba(10,0,5,0.9)), url('${PANEL_FONDO_URL}'); background-size: cover; background-position: center; background-attachment: fixed;` : `background-image: radial-gradient(circle at 20% 0%, #2a0015 0%, #0a0005 55%, #000000 100%);`}
    color: #ffd6e8; font-family: 'Space Mono', monospace; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 50px 20px 70px; overflow-x: hidden; position: relative;
  }
  .blob { position: fixed; border-radius: 50%; filter: blur(100px); opacity: 0.35; z-index: 0; pointer-events: none; }
  .blob1 { width: 420px; height: 420px; background: #ff0044; top: -120px; left: -140px; animation: flotar1 10s ease-in-out infinite; }
  .blob2 { width: 360px; height: 360px; background: #6a0033; bottom: -100px; right: -120px; animation: flotar2 13s ease-in-out infinite; }
  @keyframes flotar1 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(50px,70px); } }
  @keyframes flotar2 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-60px,-40px); } }
  .lazo { font-size: 50px; text-align: center; margin-bottom: -10px; filter: drop-shadow(0 0 10px #ff0044); animation: parpadeo 3s infinite; position: relative; z-index: 1; }
  @keyframes parpadeo { 0%,90%,100% { opacity: 1; } 95% { opacity: 0.2; } }
  h1 { font-family: 'Creepster', cursive; font-weight: 400; font-size: 56px; letter-spacing: 6px; color: #ff0044; text-align: center; position: relative; z-index: 1; text-shadow: 0 0 20px #ff0044, 0 0 40px #6a0033; animation: glitch 4s infinite; }
  @keyframes glitch { 0%,96%,100% { transform: translate(0,0); } 97% { transform: translate(-2px,1px); } 98% { transform: translate(2px,-1px); } 99% { transform: translate(-1px,0px); } }
  .goteo { width: 100%; max-width: 500px; height: 6px; background: repeating-linear-gradient(90deg, #ff0044 0 4px, transparent 4px 20px); margin: 10px 0 30px; position: relative; z-index: 1; }
  .sub { color: #d999b3; font-size: 12px; letter-spacing: 3px; margin-bottom: 34px; text-transform: uppercase; position: relative; z-index: 1; }
  .badge { padding: 10px 26px; border-radius: 30px; font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: 13px; letter-spacing: 2px; display: flex; align-items: center; gap: 10px; margin-bottom: 20px; position: relative; z-index: 1; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .online { background: rgba(255,0,68,0.12); border: 1px solid #ff0044; color: #ff0044; }
  .online .dot { background: #ff0044; box-shadow: 0 0 10px #ff0044; animation: pulso 1.2s infinite; }
  .offline { background: rgba(100,100,100,0.12); border: 1px solid #555; color: #bbb; }
  .offline .dot { background: #666; }
  @keyframes pulso { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .controles { display: flex; gap: 12px; margin-bottom: 30px; position: relative; z-index: 1; flex-wrap: wrap; justify-content: center; }
  .btn-control { background: linear-gradient(160deg, #6a0033, #2a0015); border: 1px solid #ff0044; color: #ffd6e8; font-family: 'Orbitron', sans-serif; font-size: 11px; letter-spacing: 1px; padding: 10px 18px; border-radius: 8px; cursor: pointer; text-decoration: none; transition: box-shadow .2s, transform .2s; }
  .btn-control:hover { box-shadow: 0 0 18px #ff0044; transform: translateY(-2px); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .card { background: linear-gradient(160deg, rgba(60,0,25,0.85), rgba(10,0,5,0.9)); border: 1px solid rgba(255,0,68,0.35); border-radius: 14px; padding: 20px; text-align: center; box-shadow: 0 0 20px rgba(255,0,68,0.12); }
  .card .valor { font-family: 'Orbitron', sans-serif; font-size: 26px; color: #ffd6e8; font-weight: 700; }
  .card .etiqueta { font-size: 10px; color: #d999b3; margin-top: 8px; text-transform: uppercase; letter-spacing: 1.5px; }
  .seccion { margin-top: 40px; margin-bottom: 14px; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 3px; color: #ff0044; text-transform: uppercase; align-self: flex-start; max-width: 900px; width: 100%; position: relative; z-index: 1; text-shadow: 0 0 8px #ff0044; }
  .barra-fondo { width: 100%; max-width: 900px; height: 16px; background: rgba(255,255,255,0.06); border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,0,68,0.3); position: relative; z-index: 1; }
  .barra-relleno { height: 100%; background: linear-gradient(90deg, #ff0044, #6a0033); box-shadow: 0 0 10px #ff0044; }
  .cat-titulo { font-family: 'Orbitron', sans-serif; font-size: 14px; letter-spacing: 2px; color: #ff6ea3; margin: 26px 0 12px; text-transform: uppercase; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .cmd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .cmd-card { background: rgba(40,0,15,0.8); border: 1px solid rgba(255,0,68,0.25); border-radius: 10px; padding: 12px 16px; transition: border-color .2s, box-shadow .2s; }
  .cmd-card:hover { border-color: #ff0044; box-shadow: 0 0 16px rgba(255,0,68,0.3); }
  .cmd-nombre { font-family: 'Orbitron', sans-serif; font-size: 12px; color: #ff6ea3; letter-spacing: 1px; }
  .cmd-desc { font-size: 11px; color: #d999b3; margin-top: 4px; }
  #qr { margin-top: 30px; position: relative; z-index: 1; }
  #qr img { border-radius: 14px; border: 2px solid rgba(255,0,68,0.4); box-shadow: 0 0 30px rgba(255,0,68,0.3); }
</style>
</head>
<body>
  <div class="blob blob1"></div>
  <div class="blob blob2"></div>
  <div class="lazo">🎀💀</div>
  <h1>${NOMBRE_BOT.toUpperCase()}</h1>
  <div class="goteo"></div>
  <div class="sub">Panel de control tenebroso · ${CREADOR}</div>
  <div id="badge" class="badge offline"><div class="dot"></div>Cargando...</div>
  ${_controles ? `<div class="controles">
    <a href="/panel/toggle${_tk}" class="btn-control">⚡ Encender / Apagar bot</a>
    <a href="/panel/actualizacion${_tk}" class="btn-control">🛠️ Avisar actualización</a>
  </div>` : ''}
  <div class="seccion">Actividad</div>
  <div class="grid">
    <div class="card"><div class="valor" id="msgIn">0</div><div class="etiqueta">Recibidos</div></div>
    <div class="card"><div class="valor" id="msgOut">0</div><div class="etiqueta">Enviados</div></div>
    <div class="card"><div class="valor" id="uptime">0s</div><div class="etiqueta">Uptime</div></div>
    <div class="card"><div class="valor" id="reint">0</div><div class="etiqueta">Reconexiones</div></div>
  </div>
  <div class="seccion">Cuota de IA hoy</div>
  <div class="grid"><div class="card" style="grid-column: 1 / -1"><div class="valor" id="cuotaTexto">0 / 0</div><div class="barra-fondo" style="margin-top:14px"><div class="barra-relleno" id="cuotaBarra" style="width:0%"></div></div></div></div>
  <div class="seccion" style="margin-top:50px">Comandos disponibles</div>
  ${generarHtmlComandos()}
  <div id="qr"></div>
  <script>
    async function actualizar() {
      const r = await fetch('/status'); const d = await r.json();
      const badge = document.getElementById('badge');
      badge.innerHTML = '<div class="dot"></div>' + (d.conectado ? (d.botActivo ? 'CONECTADO' : 'CONECTADO (bot apagado)') : 'DESCONECTADO') + ' · v' + d.version;
      badge.className = 'badge ' + (d.conectado ? 'online' : 'offline');
      document.getElementById('msgIn').textContent = d.mensajesRecibidos;
      document.getElementById('msgOut').textContent = d.mensajesEnviados;
      document.getElementById('reint').textContent = d.intentosReconexion;
      const u = d.uptimeSegundos, dd = Math.floor(u / 86400), h = Math.floor((u % 86400) / 3600), m = Math.floor((u % 3600) / 60), s = u % 60;
      document.getElementById('uptime').textContent = (dd > 0 ? dd + 'd ' : '') + h + 'h ' + m + 'm ' + s + 's';
      document.getElementById('uptime').title = d.uptimeTexto || '';
      document.getElementById('cuotaTexto').textContent = d.cuotaUsada + ' / ' + d.cuotaLimite;
      document.getElementById('cuotaBarra').style.width = Math.min(100, Math.round((d.cuotaUsada / d.cuotaLimite) * 100)) + '%';
    }
    setInterval(actualizar, 3000);
    actualizar();
  </script>
</body>
</html>`);
});

app.get('/qr', (req, res) => {
  if (!panelAutorizado(req)) return res.status(401).send('No autorizado');
  if (!estado.ultimoQR) return res.send('<h2 style="font-family:sans-serif;color:#fff;background:#000;height:100vh;display:flex;align-items:center;justify-content:center">No hay QR pendiente.</h2>');
  res.send(`<body style="background:#000;display:flex;justify-content:center;align-items:center;height:100vh"><img src="${estado.ultimoQR}" /></body>`);
});

app.listen(PUERTO, () => console.log(`🌐 Panel web activo en el puerto ${PUERTO}`));

const URL_PROPIA = process.env.RENDER_EXTERNAL_URL;
if (URL_PROPIA) setInterval(() => { fetch(URL_PROPIA).catch(() => {}); }, 4 * 60 * 1000);

iniciarBot();
