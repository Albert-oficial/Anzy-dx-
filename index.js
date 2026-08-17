const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ═══════════════════════════════════════════════
// ⚙️ CONFIGURACIÓN
// ═══════════════════════════════════════════════
const CARPETA_BIN = path.join(__dirname, 'bin');
const RUTA_YTDLP = fs.existsSync(path.join(CARPETA_BIN, 'yt-dlp'))
  ? path.join(CARPETA_BIN, 'yt-dlp')
  : 'yt-dlp';

// ── PROCESAR COOKIES DESDE VARIABLE DE ENTORNO ──
const ARCHIVO_COOKIES = path.join(__dirname, 'cookies_youtube.txt');
let ARGS_COOKIES = '';

function prepararCookies() {
  const contenido = process.env.YOUTUBE_COOKIES;
  if (!contenido) {
    console.log('⚠️ Sin cookies (YOUTUBE_COOKIES no definida)');
    return false;
  }
  try {
    const lineas = contenido.split(/\r?\n/);
    const normalizadas = ['# Netscape HTTP Cookie File', ''];
    for (const linea of lineas) {
      const limpia = linea.trim();
      if (!limpia || limpia.startsWith('#')) continue;
      const campos = limpia.split(/\s+/);
      if (campos.length >= 7) {
        normalizadas.push(campos.join('\t'));
      }
    }
    fs.writeFileSync(ARCHIVO_COOKIES, normalizadas.join('\n') + '\n');
    ARGS_COOKIES = `--cookies "${ARCHIVO_COOKIES}"`;
    console.log('✅ Cookies cargadas 🍪');
    return true;
  } catch (err) {
    console.log('❌ Error en cookies:', err.message);
    return false;
  }
}
prepararCookies();

// ═══════════════════════════════════════════════
// 🎵 DETECCIÓN DE ENLACES DE YOUTUBE
// ═══════════════════════════════════════════════
const ENLACE_YOUTUBE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;

// ═══════════════════════════════════════════════
// 🎵 FUNCIÓN DE DESCARGAR AUDIO
// ═══════════════════════════════════════════════
async function descargarAudioYoutube(url) {
  const id = url.match(ENLACE_YOUTUBE)?.[1];
  if (!id) throw new Error('Enlace de YouTube inválido');

  const archivo = path.join(__dirname, `temp_audio_${id}-${Date.now()}.mp3`);

  const cmd = [
    `"${RUTA_YTDLP}"`,
    '--format', 'bestaudio[ext=m4a]/bestaudio/best',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--extractor-args', 'youtube:player_client=android;skip=dash',
    '--user-agent', 'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    '--no-check-certificates',
    '--no-playlist',
    '--retries', '3',
    ARGS_COOKIES,
    '-o', `"${archivo}"`,
    `"${url}"`
  ].filter(Boolean).join(' ');

  console.log(`🎵 Descargando: ${id}`);

  await new Promise((resolve, reject) => {
    exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.slice(-600) || err.message));
      resolve();
    });
  });

  if (!fs.existsSync(archivo) || fs.statSync(archivo).size < 5000) {
    throw new Error('El archivo no se generó correctamente');
  }
  return archivo;
}

// ═══════════════════════════════════════════════
// 🤖 INICIAR BOT — QR MEJORADO ✅
// ═══════════════════════════════════════════════
async function iniciarBot() {
  console.log('\n🔄 PASO 1: Preparando...');

  // ✅ BORRA SESIÓN VIEJA AUTOMÁTICAMENTE → QR NUEVO SIEMPRE
  const carpetaSesion = path.join(__dirname, 'sesion');
  try {
    if (fs.existsSync(carpetaSesion)) {
      fs.rmSync(carpetaSesion, { recursive: true, force: true });
      console.log('✅ Sesión anterior eliminada');
    } else {
      console.log('✅ Sin sesión anterior');
    }
  } catch (e) {
    console.log('⚠️ No se pudo borrar sesión:', e.message);
  }

  // ✅ CARGA ESTADO
  console.log('🔄 PASO 2: Cargando estado...');
  const { state, saveCreds } = await useMultiFileAuthState('sesion');
  console.log('✅ Estado cargado');

  // ✅ OBTIENE VERSIÓN
  console.log('🔄 PASO 3: Conectando con WhatsApp...');
  const { version } = await fetchLatestBaileysVersion();
  console.log(`✅ Versión Baileys: ${version.join('.')}`);

  // ✅ CREA CONEXIÓN — QR DURA 90 SEGUNDOS ✅
  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    qrTimeout: 90000,  // ⏱️ QR DURA 90 SEGUNDOS (antes 60)
    browser: ['ANZY DEX', 'Chrome', '14.0']
  });
  console.log('✅ Conexión lista → generando QR...');

  // ✅ ESCUCHA EVENTOS DE CONEXIÓN
  sock.ev.on('connection.update', (update) => {
    const { qr, connection, lastDisconnect } = update;

    // 📋 MUESTRA EL QR CLARO
    if (qr) {
      console.log('\n═══════════════════════════════════════════════════');
      console.log('📋 ══ ESCANEA ESTE QR CON WHATSAPP ══');
      console.log('⏱️  Tienes 90 segundos para escanearlo');
      console.log('═══════════════════════════════════════════════════\n');
      qrcode.generate(qr, { small: true });
      console.log('\n═══════════════════════════════════════════════════\n');
    }

    // ✅ CONECTADO EXITOSAMENTE
    if (connection === 'open') {
      console.log('\n✅ ✅ ✅ CONECTADO EXITOSAMENTE ✅ ✅ ✅');
      console.log('🤖 ANZY DEX BOT LISTO PARA USAR 🎉');
      console.log('🎵 Usa: /youtube [enlace de YouTube]\n');
    }

    // 🔌 DESCONECTADO → SE RECONECTA SOLO
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.code;
      const razon = DisconnectReason[codigo] || 'Sin detalle';
      console.log(`\n🔌 Desconectado: ${razon}`);
      console.log('🔄 Reintentando en 5 segundos...\n');
      setTimeout(iniciarBot, 5000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ✅ RECIBIR Y PROCESAR MENSAJES
  sock.ev.on('messages.upsert', async (msg) => {
    const mensaje = msg.messages[0];
    if (!mensaje.message || mensaje.key.fromMe) return;

    const jid = mensaje.key.remoteJid;
    const texto = (mensaje.message.conversation || mensaje.message.extendedTextMessage?.text || '').trim();

    // 🎵 COMANDO /youtube
    if (texto.toLowerCase().startsWith('/youtube')) {
      const enlace = texto.replace(/^\/youtube\s*/i, '').trim();

      if (!ENLACE_YOUTUBE.test(enlace)) {
        await sock.sendMessage(jid, {
          text: '⚠️ Formato correcto:\n/youtube https://youtu.be/xxxxxx'
        });
        return;
      }

      await sock.sendMessage(jid, { text: '🎵 Preparando audio... espera un momento ⏳' });

      try {
        const archivo = await descargarAudioYoutube(enlace);
        await sock.sendMessage(jid, {
          audio: { url: archivo },
          mimetype: 'audio/mpeg'
        });
        console.log('✅ Audio enviado 🎵');
        fs.unlink(archivo, () => {}); // ✅ Borra después de enviar
      } catch (err) {
        await sock.sendMessage(jid, {
          text: `❌ No se pudo descargar.\n\nMotivo: ${err.message.slice(0, 300)}\n\nIntenta más tarde 🙏`
        });
      }
    }
  });
}

// 🚀 ARRANQUE CON CAPTURA TOTAL DE ERRORES
iniciarBot().catch(err => {
  console.log('\n❌ ❌ ❌ ERROR CRÍTICO:');
  console.log('👉', err.message);
  console.log('\n🔄 Reintentando en 5 segundos...\n');
  setTimeout(iniciarBot, 5000);
});
