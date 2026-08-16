require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ═══════════════════════════════════════════════
// ⚙️ CONFIGURACIÓN
// ═══════════════════════════════════════════════
const CLAVE_IA = process.env.CLAVE_IA_PRINCIPAL || '';
const CARPETA_BIN = path.join(__dirname, 'bin');
const RUTA_YTDLP = fs.existsSync(path.join(CARPETA_BIN, 'yt-dlp'))
  ? path.join(CARPETA_BIN, 'yt-dlp')
  : 'yt-dlp';

// ── PROCESAR COOKIES ──
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
// 🎵 DETECCIÓN DE ENLACES
// ═══════════════════════════════════════════════
const ENLACE_YOUTUBE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;

// ═══════════════════════════════════════════════
// 🎵 DESCARGAR AUDIO
// ═══════════════════════════════════════════════
async function descargarAudioYoutube(url) {
  const id = url.match(ENLACE_YOUTUBE)?.[1];
  if (!id) throw new Error('Enlace inválido');

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
    throw new Error('Archivo no generado');
  }
  return archivo;
}

// ═══════════════════════════════════════════════
// 🤖 INICIAR BOT — QR GARANTIZADO ✅
// ═══════════════════════════════════════════════
async function iniciarBot() {
  console.log('🔄 Cargando sesión de WhatsApp...');

  const { state, saveCreds } = await useMultiFileAuthState('sesion');
  const { version } = await fetchLatestBaileysVersion();

  console.log(`✅ Versión de Baileys obtenida: ${version.join('.')}`);

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true,  // ✅ QR OBLIGATORIO EN CONSOLA
    browser: ['ANZY DEX', 'Chrome', '14.0']
  });

  // ── ESTADO DE CONEXIÓN ──
  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log('\n══════════════════════════════════════════');
      console.log('📋 ── ESCANEA ESTE QR CON WHATSAPP ──');
      console.log('══════════════════════════════════════════\n');
    }

    if (connection === 'open') {
      console.log('\n✅ 🤖 ANZY DEX — CONECTADO Y LISTO 🎉');
      console.log('🎵 Comando: /youtube [enlace]\n');
    }

    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.code || 'Desconocido';
      const razon = DisconnectReason[codigo] || 'Sin detalle';
      console.log(`🔌 Desconectado: ${razon} — Reintentando en 5s...`);
      setTimeout(iniciarBot, 5000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── RECIBIR MENSAJES ──
  sock.ev.on('messages.upsert', async (msg) => {
    const mensaje = msg.messages[0];
    if (!mensaje.message || mensaje.key.fromMe) return;

    const jid = mensaje.key.remoteJid;
    const texto = (mensaje.message.conversation || mensaje.message.extendedTextMessage?.text || '').trim();

    // ── COMANDO /youtube ──
    if (texto.toLowerCase().startsWith('/youtube')) {
      const enlace = texto.replace(/^\/youtube\s*/i, '').trim();

      if (!ENLACE_YOUTUBE.test(enlace)) {
        await sock.sendMessage(jid, {
          text: '⚠️ Formato:\n/youtube https://youtu.be/xxxxxx'
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
        fs.unlink(archivo, () => {});
      } catch (err) {
        await sock.sendMessage(jid, {
          text: `❌ No se pudo descargar.\n\nMotivo: ${err.message.slice(0, 300)}\n\nIntenta más tarde 🙏`
        });
      }
    }
  });
}

// 🚀 ARRANCAR OBLIGATORIAMENTE
iniciarBot().catch(err => {
  console.error('❌ ERROR AL INICIAR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
