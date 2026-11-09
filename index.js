require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { usePostgresAuthState } = require('./postgresAuthState');
const { initMessageStore, createMessageStore } = require('./messageStore');
const { handleIncomingMessage } = require('./handler');
const { initSchema, cleanupSessions } = require('./db');
const { Pool } = require('pg');

// Baileys retry counter — tracks how many times each message has been retried
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60, useClones: false });

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const QR_TOKEN = process.env.QR_TOKEN;

let sock = null;
let connectionState = 'connecting';
let latestQr = null;

// ── Canonical Pakistani Phone Normalizer ──────────────────────────────────
// Simple digit extraction only — no more guessing/correcting. WordPress now
// always sends a complete, correctly-prefixed international number (via its
// own country-code dropdown), and WhatsApp itself always reports sender
// numbers in full international format. Kept as its own function (rather
// than inlining everywhere) so all call sites stay unchanged.
function normalizePakistaniPhone(phoneInput) {
  return String(phoneInput || '').replace(/\D/g, '');
}

function normalizeToJid(phone) {
  const digits = normalizePakistaniPhone(phone);
  return `${digits}@s.whatsapp.net`;
}

// ── Message store (for Baileys retry delivery) ───────────────────────────
const messageStore = createMessageStore(pgPool);

async function initDb() {
  try {
    await initMessageStore(pgPool);
    await initSchema(pgPool);
    setInterval(() => cleanupSessions(pgPool).catch((e) => console.error('cleanup failed:', e.message)), 60 * 60 * 1000);
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}
initDb();

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.path === '/qr') {
    if (!QR_TOKEN || req.query.token !== QR_TOKEN) {
      return res.status(401).send('unauthorized');
    }
    return next();
  }
  const key = req.header('X-API-Key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, reason: 'unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: connectionState });
});

app.get('/qr', async (req, res) => {
  if (!latestQr) {
    return res.status(404).send('No QR code available right now (already connected, or not generated yet — check back in a few seconds).');
  }
  try {
    const png = await QRCode.toBuffer(latestQr, { width: 400, margin: 2 });
    res.type('png').send(png);
  } catch (err) {
    res.status(500).send('Failed to render QR code.');
  }
});

async function startBaileys() {
  const { state, saveCreds } = await usePostgresAuthState(pgPool, 'helpline_session');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: 'silent' })
      ),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,

    markOnlineOnConnect: false,

    msgRetryCounterCache,

    enableRecentMessageCache: true,

    enableAutoSessionRecreation: true,

    getMessage: async (key) => {
      return await messageStore.getMessage(key);
    },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      console.log('New QR generated — open the /qr URL of this service in a browser to scan it.');
    }

    if (connection === 'open') {
      connectionState = 'open';
      latestQr = null;
      console.log('✅ WhatsApp connected.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        connectionState = 'logged_out';
        console.log('❌ Logged out / banned. Not reconnecting automatically — falls back to secondary number until re-paired.');
      } else {
        connectionState = 'closed';
        console.log('⚠️  Connection closed, reconnecting...');
        startBaileys();
      }
    }
  });

  // Incoming Message Listener (Detect Confirm Order button, typed YES / ہاں, and Screenshots)
  sock.ev.on('messages.upsert', async (m) => {

    // Privacy: only OUTGOING messages are stored (Baileys needs them for retries).
    // Incoming user text (may contain CNIC etc.) must never be persisted here.
    for (const storedMessage of m.messages) {
      if (storedMessage.key && storedMessage.key.fromMe) {
        await messageStore.saveMessage(storedMessage);
      }
    }

    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const fromJid = msg.key.remoteJid;
      if (!fromJid) continue;

      // WhatsApp can address messages via an opaque "@lid" JID instead of the classic
      // phone-number "@s.whatsapp.net" JID. The phone-based JID, when available, may be in
      // remoteJid OR remoteJidAlt depending on addressing mode — check both.
      const altJid = msg.key.remoteJidAlt;
      const phoneJid = [fromJid, altJid].find((j) => j && j.endsWith('@s.whatsapp.net'));
      if (!phoneJid) continue; // no phone number available from this message at all

      const senderPhone = normalizePakistaniPhone(phoneJid);
      const textContent = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ''
      ).trim();
      const isImage = !!msg.message?.imageMessage;
      const isAudio = !!msg.message?.audioMessage;

      try {
        await handleIncomingMessage({
          sock,
          pgPool,
          fromJid,
          senderPhone,
          textContent,
          isImage,
          isAudio,
          rawMessage: msg,
          downloadAudio: () => downloadMediaMessage(msg, 'buffer', {}),
        });
      } catch (err) {
        console.error('handleIncomingMessage error:', err);
      }
    }
  });
}

startBaileys();

app.listen(PORT, () => {
  console.log(`Helpline WhatsApp server listening on port ${PORT}`);
});
