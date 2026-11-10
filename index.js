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
const ai = require('./ai');
const { initSchema, cleanupSessions } = require('./db');
const { Pool } = require('pg');

// Baileys retry counter — tracks how many times each message has been retried
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60, useClones: false });

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const QR_TOKEN = process.env.QR_TOKEN;

let sock = null;
let connectionState = 'connecting';
let latestQr = null;
const AUTH_SESSION_ID = 'helpline_session';
let generation = 0;          // bumps on every (re)start so events from old sockets are ignored
let relinking = false;
let lastAutoRelinkAt = 0;

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
  if (req.path === '/qr' || req.path === '/relink' || req.path === '/ai-test') {
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
    return res.status(404).send(`No QR code available right now (state: ${connectionState}). If it stays like this and the state is not "open", open /relink?token=YOUR_TOKEN to start a fresh pairing.`);
  }
  try {
    const png = await QRCode.toBuffer(latestQr, { width: 400, margin: 2 });
    res.type('png').send(png);
  } catch (err) {
    res.status(500).send('Failed to render QR code.');
  }
});

app.get('/ai-test', async (req, res) => {
  const started = Date.now();
  try {
    const r = await ai.classifyIntent('mujhe shanakhti card banwana hai');
    res.json({ ok: true, ms: Date.now() - started, result: r, expected_intent: 'id_card' });
  } catch (e) {
    res.status(500).json({ ok: false, ms: Date.now() - started, error: String((e && e.message) || e).slice(0, 300) });
  }
});

app.get('/relink', async (req, res) => {
  if (sock && connectionState === 'open') {
    try { await sock.logout(); } catch (e) { console.error('[relink] logout failed:', e.message); }
  }
  const ok = await relink('manual relink requested', { manual: true });
  res.send(ok
    ? 'Relink started. Open /qr?token=YOUR_TOKEN in a few seconds and scan the new QR.'
    : 'Relink is already in progress or failed. Check the logs and /health.');
});

async function relink(reason, { manual = false } = {}) {
  if (relinking) return false;
  if (!manual && Date.now() - lastAutoRelinkAt < 15000) {
    console.error('[relink] skipped: auto-relink ran less than 15s ago (possible loop). Use /relink?token=... to retry.');
    return false;
  }
  relinking = true;
  if (!manual) lastAutoRelinkAt = Date.now();
  try {
    console.log(`[relink] ${reason} - clearing saved session and starting fresh pairing.`);
    generation++;
    latestQr = null;
    connectionState = 'connecting';
    const old = sock;
    sock = null;
    if (old) {
      try { old.end(undefined); } catch (_) {}
    }
    await pgPool.query('DELETE FROM auth_state WHERE session_id = $1', [AUTH_SESSION_ID]);
    await startBaileys();
    return true;
  } catch (err) {
    console.error('[relink] failed:', err.message);
    connectionState = 'logged_out';
    return false;
  } finally {
    relinking = false;
  }
}

async function startBaileys() {
  const myGen = ++generation;
  const isStale = () => myGen !== generation;
  const { state, saveCreds } = await usePostgresAuthState(pgPool, AUTH_SESSION_ID);
  const { version } = await fetchLatestBaileysVersion();
  if (isStale()) return;

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

  sock.ev.on('creds.update', () => { if (!isStale()) saveCreds(); });

  sock.ev.on('connection.update', (update) => {
    if (isStale()) return;
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
        console.log('Logged out by WhatsApp - clearing saved session and generating a fresh QR.');
        relink('logged out by WhatsApp');
      } else {
        connectionState = 'closed';
        console.log('Connection closed, reconnecting...');
        startBaileys();
      }
    }
  });

  // Incoming Message Listener (Detect Confirm Order button, typed YES / ہاں, and Screenshots)
  sock.ev.on('messages.upsert', async (m) => {
    if (isStale()) return;

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
