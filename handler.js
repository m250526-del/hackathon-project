'use strict';

// Entry point for every incoming WhatsApp message.
// Step 1 (now): log only. Later steps add session state, validation, redaction and AI agents here.
async function handleIncomingMessage({ sock, pgPool, fromJid, senderPhone, textContent, isImage, isAudio, rawMessage }) {
  console.log('[INCOMING]', { senderPhone, textLength: textContent.length, isImage, isAudio });
}

module.exports = { handleIncomingMessage };
