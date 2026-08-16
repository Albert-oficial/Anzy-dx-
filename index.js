const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

async function iniciarBot() {
  console.log('\n🔄 PASO 1: Preparando...');

  // ✅ BORRA SESIÓN VIEJA OBLIGATORIAMENTE
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
  console.log('🔄 PASO 3: Obteniendo versión WhatsApp...');
  const { version } = await fetchLatestBaileysVersion();
  console.log(`✅ Versión: ${version.join('.')}`);

  // ✅ CREA CONEXIÓN
  console.log('🔄 PASO 4: Creando conexión...');
  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false, // ❌ Desactivamos el automático para mostrarlo NOSOTROS
    browser: ['ANZY DEX', 'Chrome', '14.0']
  });
  console.log('✅ Conexión lista → esperando QR...');

  // ✅ ESCUCHA EVENTOS
  sock.ev.on('connection.update', (update) => {
    const { qr, connection, lastDisconnect } = update;

    // 📋 MUESTRA EL QR
    if (qr) {
      console.log('\n═══════════════════════════════════════════════');
      console.log('📋 ══ ESCANEA ESTE QR CON WHATSAPP ══');
      console.log('═══════════════════════════════════════════════\n');
      qrcode.generate(qr, { small: true });
      console.log('\n═══════════════════════════════════════════════\n');
    }

    // ✅ CONECTADO
    if (connection === 'open') {
      console.log('\n✅ ✅ ✅ CONECTADO EXITOSAMENTE ✅ ✅ ✅\n');
    }

    // 🔌 DESCONECTADO
    if (connection === 'close') {
      const razon = lastDisconnect?.error?.message || 'Desconocida';
      console.log(`\n🔌 Desconectado: ${razon}`);
      console.log('🔄 Reintentando en 5 segundos...\n');
      setTimeout(iniciarBot, 5000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// 🚀 ARRANQUE CON CAPTURA DE ERRORES
iniciarBot().catch(err => {
  console.log('\n❌ ❌ ❌ ERROR CRÍTICO:');
  console.log('👉', err.message);
  console.log('\n🔄 Reintentando en 5 segundos...\n');
  setTimeout(iniciarBot, 5000);
});
