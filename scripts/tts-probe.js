'use strict';
require('dotenv').config();

const raw = process.env.GEMINI_TTS_KEYS || process.env.GEMINI_API_KEY || '';
const key = raw.split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!key) {
  console.error('No key found in GEMINI_TTS_KEYS or GEMINI_API_KEY');
  process.exit(1);
}

const TEXTS = {
  en: 'Your form has been submitted.',
  roman: 'Aap ka form jama ho gaya hai.',
  urdu: 'آپ کا فارم جمع ہو گیا ہے۔',
  hindi: 'आपका फॉर्म जमा हो गया है।',
};

const VARIANTS = [
  { name: 'lite/new/en', model: 'gemini-3.8-flash-lite-tts', shape: 'new', text: TEXTS.en },
  { name: 'lite/new/roman', model: 'gemini-3.8-flash-lite-tts', shape: 'new', text: TEXTS.roman },
  { name: 'lite/new/urdu', model: 'gemini-3.8-flash-lite-tts', shape: 'new', text: TEXTS.urdu },
  { name: 'lite/new/hindi', model: 'gemini-3.8-flash-lite-tts', shape: 'new', text: TEXTS.hindi },
  { name: 'lite/old/en', model: 'gemini-3.8-flash-lite-tts', shape: 'old', text: TEXTS.en },
  { name: 'full/new/en', model: 'gemini-3.8-flash-tts', shape: 'new', text: TEXTS.en },
  { name: 'full/new/urdu', model: 'gemini-3.8-flash-tts', shape: 'new', text: TEXTS.urdu },
  { name: 'full/new/roman', model: 'gemini-3.8-flash-tts', shape: 'new', text: TEXTS.roman },
];

function voiceConfig(shape) {
  if (shape === 'new') return { voice: 'Kore' };
  return { prebuiltVoiceConfig: { voiceName: 'Kore' } };
}

async function run(v) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${v.model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: v.text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: voiceConfig(v.shape) },
    },
  };
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    const ms = Date.now() - started;
    if (res.ok) {
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      const mime = part?.inlineData?.mimeType || 'none';
      const bytes = part?.inlineData?.data ? Buffer.from(part.inlineData.data, 'base64').length : 0;
      console.log(`${v.name} => OK ${res.status} ${ms}ms mime=${mime} bytes=${bytes}`);
    } else {
      const msg = String(json.error?.message || '').replace(/\s+/g, ' ').slice(0, 300);
      console.log(`${v.name} => FAIL ${res.status} ${ms}ms status=${json.error?.status} message=${msg}`);
    }
  } catch (e) {
    console.log(`${v.name} => ERROR ${String(e.message).slice(0, 200)}`);
  }
}

(async () => {
  for (const v of VARIANTS) await run(v);
})();
