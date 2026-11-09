'use strict';

const { getSession, resetSession, saveSession, createApplication, getLatestApplication } = require('./db');
const { FORMS } = require('./forms');
const { redact } = require('./redact');
const { toAsciiDigits } = require('./validators');
const ai = require('./ai');

const MENU =
  'Assalam o Alaikum! Main aap ki form bharne mein madad karunga.\n\n' +
  'Aap kya karna chahte hain?\n' +
  '1 - Shanakhti card (ID card) ka form\n' +
  '2 - Sehat card ka form\n' +
  '3 - Driving license ka form\n' +
  '4 - Apni application ka status dekhna\n\n' +
  'Bas number likh kar bhej dein, ya voice note bhejein. Kisi bhi waqt "menu" likhein to wapas yahin aa jayenge.';

const RESET_RE = /^(menu|cancel|start|shuru|0)$/i;
const BACK_RE = /^(back|wapas|peeche|pichay)$/i;
const YES_RE = /^(1|y|yes|ha+n?|haan|han|ji|ji haan|theek|sahi|ok|okay|ہاں|جی)$/i;
const NO_RE = /^(2|n|no|nahi|nahin|nhi|نہیں)$/i;
const QUESTION_RE = /[?؟]|kahan|kahaan|kidhar|where|kya hota|kya hai|kya likh|kaise|how|samajh nahi|what|\bkon\b|کہاں|کیا|کیسے/i;

const queues = new Map();

function handleIncomingMessage(ctx) {
  const key = ctx.senderPhone;
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => processMessage(ctx));
  queues.set(key, next);
  next.catch(() => {}).finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

function matchIntent(t) {
  if (/^1$|id\s*card|shanakhti|شناختی/i.test(t)) return 'id_card';
  if (/^2$|health|sehat|صحت/i.test(t)) return 'health_card';
  if (/^3$|licen[cs]e|driving|لائسنس/i.test(t)) return 'license';
  if (/^4$|status|halat|حالت/i.test(t)) return 'status';
  return null;
}

function askText(form, index) {
  return `Sawal ${index + 1}/${form.fields.length}: ${form.fields[index].ask}`;
}

function summaryText(form, answers) {
  const lines = form.fields.map((f) => `${f.label}: ${answers[f.key]}`);
  return (
    'Meharbani. Aap ka form ye hai:\n\n' +
    lines.join('\n') +
    '\n\nKya sab theek hai?\n1 - Haan, jama kar dein\n2 - Nahi, dobara shuru karein'
  );
}

async function processMessage({ sock, pgPool, fromJid, senderPhone, textContent, isImage, isAudio, downloadAudio }) {
  console.log('[INCOMING]', { phoneLast4: senderPhone.slice(-4), textLength: textContent.length, isImage, isAudio });

  const session = await getSession(pgPool, senderPhone);
  const out = { voice: Boolean(isAudio || session.voice_reply) };

  const send = async (text) => {
    if (out.voice) {
      try {
        const audio = await ai.speak(text.slice(0, 700));
        await sock.sendMessage(fromJid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
      } catch (e) {
        console.error('tts failed:', e.message);
      }
    }
    await sock.sendMessage(fromJid, { text });
  };

  let text = textContent;

  if (isAudio) {
    const form = FORMS[session.form_type];
    if (session.agent === 'form' && session.state === 'collecting' && form && form.fields[session.field_index].sensitive) {
      await send('Ye maloomat hassas hai. Meharbani kar ke is sawal ka jawab voice note ki bajaye likh kar bhejein.');
      return;
    }
    text = '';
    if (downloadAudio) {
      try {
        const buffer = await downloadAudio();
        text = await ai.transcribe(buffer, 'audio/ogg');
      } catch (e) {
        console.error('stt failed:', e.message);
      }
    }
    if (!text) {
      await send('Awaz samajh nahi aayi. Dobara voice note bhejein ya likh kar bhejein.');
      return;
    }
  }

  text = text.trim();

  if (!text) {
    await send('Abhi main sirf likhe hue ya voice messages samajh sakta hoon. Meharbani kar ke likh kar bhejein.');
    return;
  }

  if (RESET_RE.test(text)) {
    await resetSession(pgPool, senderPhone);
    await send(MENU);
    return;
  }

  if (text.length < 80) {
    const wantsVoice = /voice|awaz|audio|آواز/i.test(text) && /jawab|jawaab|reply|sun|جواب|سن/i.test(text);
    const wantsText = /text|likh/i.test(text) && /jawab|jawaab|reply|جواب/i.test(text);
    if (wantsVoice || wantsText) {
      await saveSession(pgPool, senderPhone, { voice_reply: wantsVoice });
      out.voice = Boolean(isAudio || wantsVoice);
      let next = MENU;
      if (session.agent === 'form' && session.state === 'collecting' && FORMS[session.form_type]) {
        next = askText(FORMS[session.form_type], session.field_index);
      }
      if (wantsVoice) await send(`Theek hai, ab main voice note mein jawab dunga.\n\n${next}`);
      else await send(`Theek hai, ab main likh kar jawab dunga.\n\n${next}`);
      return;
    }
  }

  if (session.agent === 'form') {
    await handleFormStep({ pgPool, senderPhone, text, session, send, out });
  } else {
    await handleRouter({ pgPool, senderPhone, text, send, out });
  }
}

async function startForm(pgPool, senderPhone, formType, send) {
  const form = FORMS[formType];
  await saveSession(pgPool, senderPhone, {
    agent: 'form',
    form_type: formType,
    state: 'collecting',
    field_index: 0,
    retry_count: 0,
    answers: {},
    chat_history: [],
  });
  await send(`${form.intro}\n\n${askText(form, 0)}`);
}

async function handleRouter({ pgPool, senderPhone, text, send, out }) {
  let intent = matchIntent(text);

  if (!intent && /[A-Za-z\u0600-\u06FF]{4,}/.test(text)) {
    try {
      const c = await ai.classifyIntent(redact(text).text);
      intent = c.intent;
      if (c.voice !== null) {
        await saveSession(pgPool, senderPhone, { voice_reply: c.voice });
        out.voice = c.voice;
      }
    } catch (e) {
      console.error('classify failed:', e.message);
    }
  }

  if (FORMS[intent]) {
    await startForm(pgPool, senderPhone, intent, send);
    return;
  }

  if (intent === 'status') {
    const app = await getLatestApplication(pgPool, senderPhone);
    if (!app) {
      await send('Is number se abhi tak koi application jama nahi hui.\n\n' + MENU);
      return;
    }
    const ref = `KF-${String(app.id).padStart(6, '0')}`;
    let title = app.form_type;
    if (FORMS[app.form_type]) title = FORMS[app.form_type].title;
    await send(`Aap ki akhri application: ${ref}\nForm: ${title}\nHalat: ${app.status} (jama ho gayi hai)\n\n${MENU}`);
    return;
  }

  await send(MENU);
}

async function handleFormStep({ pgPool, senderPhone, text, session, send, out }) {
  const form = FORMS[session.form_type];
  if (!form) {
    await resetSession(pgPool, senderPhone);
    await send(MENU);
    return;
  }

  const answers = session.answers || {};

  if (session.state === 'confirming') {
    if (YES_RE.test(text)) {
      const id = await createApplication(pgPool, senderPhone, session.form_type, answers);
      await resetSession(pgPool, senderPhone);
      const ref = `KF-${String(id).padStart(6, '0')}`;
      await send(`Aap ka form jama ho gaya hai.\nReference number: ${ref}\nStatus dekhne ke liye menu mein 4 chunein.\n\n${MENU}`);
      return;
    }
    if (NO_RE.test(text)) {
      await saveSession(pgPool, senderPhone, { state: 'collecting', field_index: 0, retry_count: 0, answers: {}, chat_history: [] });
      await send(`Theek hai, dobara shuru karte hain.\n\n${askText(form, 0)}`);
      return;
    }
    await send('Meharbani kar ke 1 (haan) ya 2 (nahi) likhein.\n\n' + summaryText(form, answers));
    return;
  }

  const index = session.field_index;
  const field = form.fields[index];

  if (BACK_RE.test(text)) {
    if (index === 0) {
      await send(`Ye pehla sawal hai.\n\n${askText(form, 0)}`);
    } else {
      await saveSession(pgPool, senderPhone, { field_index: index - 1, retry_count: 0 });
      await send(askText(form, index - 1));
    }
    return;
  }

  const isQuestion = QUESTION_RE.test(text);
  let result = { ok: false, reason: 'question' };
  if (!isQuestion) result = field.validate(text);

  if (result.ok) {
    const newAnswers = { ...answers, [field.key]: result.value };
    const nextIndex = index + 1;
    if (nextIndex >= form.fields.length) {
      await saveSession(pgPool, senderPhone, { state: 'confirming', field_index: nextIndex, retry_count: 0, answers: newAnswers });
      await send(summaryText(form, newAnswers));
    } else {
      await saveSession(pgPool, senderPhone, { field_index: nextIndex, retry_count: 0, answers: newAnswers });
      await send(askText(form, nextIndex));
    }
    return;
  }

  let retry = session.retry_count;
  if (!isQuestion) retry = session.retry_count + 1;
  await saveSession(pgPool, senderPhone, { retry_count: retry });

  const red = redact(text);
  let userText = '';
  if (red.hasWords) userText = red.text;
  let status = 'invalid';
  if (isQuestion) status = 'question';
  const signal = {
    status,
    reason: result.reason,
    digits_found: toAsciiDigits(text).replace(/\D/g, '').length,
    digits_expected: field.digits || null,
    retry_count: retry,
    user_text: userText,
  };

  let reply = '';
  const history = Array.isArray(session.chat_history) ? session.chat_history : [];
  if (retry >= 3 && !isQuestion) {
    reply = field.help;
  } else {
    try {
      const r = await ai.answerFormQuestion({ formTitle: form.title, field, signal, history });
      reply = r.reply;
      if (r.voice !== null) {
        out.voice = r.voice;
        await saveSession(pgPool, senderPhone, { voice_reply: r.voice, retry_count: session.retry_count });
      }
      if (reply && userText) {
        const clean = (s) => s.replace(/[<>]/g, '');
        const next = [
          ...history,
          { role: 'user', text: `<user_text>${clean(userText)}</user_text>` },
          { role: 'model', text: reply },
        ];
        await saveSession(pgPool, senderPhone, { chat_history: next.slice(-8) });
      }
    } catch (e) {
      console.error('ai failed:', e.message);
    }
  }

  if (!reply) {
    const errDef = field.errors[result.reason];
    if (isQuestion) {
      reply = field.help;
    } else if (typeof errDef === 'function') {
      reply = errDef(result);
    } else if (errDef) {
      reply = errDef;
    } else {
      reply = 'Ye jawab durust nahi laga.';
    }
    if (retry >= 2) reply = field.help;
  }

  await send(`${reply}\n\n${askText(form, index)}`);
}

module.exports = { handleIncomingMessage };
