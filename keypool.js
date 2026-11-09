'use strict';

const { GoogleGenAI } = require('@google/genai');

const MIN = 60 * 1000;

function parseKeys(name) {
  const v = process.env[name];
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function cooldownFor(e) {
  const status = Number((e && (e.status || e.code)) || 0) || 0;
  const msg = String((e && e.message) || '');
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) return 10 * MIN;
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) return 12 * 60 * MIN;
  if (status >= 500 || /UNAVAILABLE|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg)) return 30 * 1000;
  return 0;
}

class KeyPool {
  constructor(channel, keys) {
    this.channel = channel;
    this.slots = keys.map((k) => ({ client: new GoogleGenAI({ apiKey: k }), until: 0 }));
    this.cursor = 0;
  }

  get size() {
    return this.slots.length;
  }

  async run(fn) {
    const n = this.slots.length;
    if (!n) throw new Error(`no keys configured for ${this.channel}`);
    const now = Date.now();
    const order = [];
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      if (this.slots[idx].until <= now) order.push(idx);
    }
    if (!order.length) {
      order.push(this.slots.reduce((best, s, i, a) => (s.until < a[best].until ? i : best), 0));
    }
    let lastErr;
    for (const idx of order) {
      try {
        const result = await fn(this.slots[idx].client);
        this.cursor = idx;
        return result;
      } catch (e) {
        lastErr = e;
        const cool = cooldownFor(e);
        if (cool === 0) throw e;
        this.slots[idx].until = Date.now() + cool;
        console.error(`[keypool:${this.channel}] key #${idx + 1} failed (status ${e.status || e.code || 'n/a'}), rotating`);
      }
    }
    throw lastErr;
  }
}

module.exports = { KeyPool, parseKeys };
