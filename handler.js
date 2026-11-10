'use strict';

const fs = require('fs');
const path = require('path');

const { getSession, resetSession, saveSession, createApplication, getLatestApplication, getApplication, listApplicationsForPhone, getFocal } = require('./db');
const { FORMS } = require('./forms');
const { redact } = require('./redact');
const { toAsciiDigits } = require('./validators');
const ai = require('./ai');

function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

const MENU =
  'Assalam o Alaikum! Main aap ki form bharne mein madad karunga.\n\n' +
  'Aap kya karna chahte hain?\n' +
  '1 - Shanakhti card (ID card) ka form\n' +
  '2 - Sehat card ka form\n' +
  '3 - Driving license ka form\n' +
  '4 - Apni application ka status dekhna\n\n' +
  'Bas number likh kar bhej dein, ya voice note bhejein. Kisi bhi waqt "menu" likhein to wapas yahin aa jayenge.';

const VOICE_PATH = path.join(__dirname, 'assets', 'reverse-mode.ogg');

const REVERSE_HINT =
  'Aap "mera form" likh kar apna form dekh sakte hain, "status" likh kar halat pooch sakte hain, ya "focal person" likh kar mutaliqa afsar ka rabta maang sakte hain. Wapas jane ke liye "exit" likhein.';

const REVERSE_TEXT = `Mode: Reverse. Ab aap ka form lock ho chuka hai.\n\n${REVERSE_HINT}`;

const REFUSAL =
  'Ye sahulat (form dekhna, status, focal person) form jama karne ke baad Reverse mode mein milti hai. Pehle form mukammal karein.';

const STATUS_LABELS = {
  submitted: 'jama ho chuki hai',
  under_review: 'review mein hai',
  approved: 'manzoor ho gayi hai',
  rejected: 'mustarad ho gayi hai',
};

const LINES = {
  status: 'Aap ki application ki halat ye hai:',
  focal: 'Mutaliqa afsar ka rabta ye hai:',
  view_form: 'Aap ka jama shuda form ye hai:',
};

const RESET_RE = /^(menu|cancel|start|shuru|exit|0)$/i;
const BACK_RE = /^(back|wapas|peeche|pichay)$/i;
const YES_RE = /^(1|y|yes|ha+n?|haan|han|ji|ji haan|theek|sahi|ok|okay|ہاں|جی)$/i;
const NO_RE = /^(2|n|no|nahi|nahin|nhi|نہیں)$/i;
const QUESTION_RE = /[?؟]|\b(?:kahan|kahaan|kidhar|where|kya hota|kya hai|kya likh|kaise|how|samajh nahi|what|kon)\b|کہاں|کیا|کیسے/i;
const CONFIRM_RE = /^(y|yes|ha+n?|haan|han|ji|ji haan|theek|sahi|ok|okay|ہاں|جی)$/i;
const RESTART_RE = /^(dobara|restart|naya|new)$/i;
const READ_RE = /status|halat|حالت|focal|rabta|raabta|رابطہ|contact|mera form|my form|form dikha|form dekh/i;
const WORDS_RE = /[A-Za-z\u0600-\u06FF]{4,}/;

const queues = new Map();

function handleIncomingMessage(ctx) {
  const key = ctx.senderPhone;
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => withTimeout(processMessage(ctx), 60000, 'processMessage'));
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
  const lines = form.fields.map((f, i) => `${i + 1}. ${f.label}: ${answers[f.key]}`);
  return (
    'Meharbani. Aap ka form ye hai:\n\n' +
    lines.join('\n') +
    `\n\nAgar sab theek hai to "haan" likhein.\nKuch badalna ho to us ka number (1-${form.fields.length}) likhein.\nSab dobara bharne ke liye "dobara" likhein.`
  );
}

function ref(id) {
  return `KF-${String(id).padStart(6, '0')}`;
}

function statusLabel(s) {
  if (STATUS_LABELS[s]) return STATUS_LABELS[s];
  return s;
}

function maskValue(key, value) {
  const digits = String(value).replace(/\D/g, '');
  if (key === 'cnic' && digits.length === 13) return `*****-****${digits.slice(9, 12)}-${digits.slice(12)}`;
  if (key === 'phone' && digits.length === 11) return `****-***${digits.slice(7)}`;
  return value;
}

function formView(form, data) {
  return form.fields.map((f, i) => `${i + 1}. ${f.label}: ${maskValue(f.key, data[f.key])}`).join('\n');
}

function isSensitiveNow(session) {
  if (session.agent !== 'form') return false;
  if (session.state === 'verify') return true;
  const form = FORMS[session.form_type];
  if (!form) return false;
  if (session.state === 'collecting' || session.state === 'editing') {
    const field = form.fields[session.field_index];
    if (field && field.sensitive) return true;
  }
  return false;
}

function reprompt(session) {
  const form = FORMS[session.form_type];
  if (session.agent === 'form' && form && (session.state === 'collecting' || session.state === 'editing')) {
    return askText(form, session.field_index);
  }
  return MENU;
}

async function safeLine(type, status, text) {
  const red = redact(text);
  let userText = '';
  if (red.hasWords) userText = red.text;
  try {
    const line = await ai.reverseLine({ type, status, userText });
    if (line) return line;
  } catch (e) {
    console.error('ai line failed:', e.message);
  }
  return LINES[type];
}

async function processMessage({ sock, pgPool, fromJid, senderPhone, textContent, isImage, isAudio, downloadAudio }) {
  console.log('[INCOMING]', { phoneLast4: senderPhone.slice(-4), textLength: textContent.length, isImage, isAudio });

  const session = await getSession(pgPool, senderPhone);
  const out = { voice: Boolean(isAudio || session.voice_reply) };
  console.log('[SESSION]', { phoneLast4: senderPhone.slice(-4), agent: session.agent, state: session.state, voice: out.voice });

  const send = async (text, textOnly) => {
    if (out.voice && !textOnly) {
      try {
        const audio = await ai.speak(text.slice(0, 700));
        await sock.sendMessage(fromJid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
      } catch (e) {
        console.error('tts failed:', e.message);
      }
    }
    try {
      await withTimeout(sock.sendMessage(fromJid, { text }), 20000, 'sendMessage');
      console.log('[SEND] text ok', { phoneLast4: senderPhone.slice(-4) });
    } catch (e) {
      console.error('[SEND] text failed:', e.message);
      throw e;
    }
  };

  let text = textContent;

  if (isAudio) {
    if (isSensitiveNow(session)) {
      await send('Ye maloomat hassas hai. Meharbani kar ke voice note ki bajaye likh kar bhejein.');
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
      const next = reprompt(session);
      if (wantsVoice) await send(`Theek hai, ab main voice note mein jawab dunga.\n\n${next}`);
      else await send(`Theek hai, ab main likh kar jawab dunga.\n\n${next}`);
      return;
    }
  }

  const ctx = { sock, fromJid, pgPool, senderPhone, text, session, send, out };

  if (session.agent === 'form') {
    await handleFormStep(ctx);
  } else {
    await handleRouter(ctx);
  }
}

async function startForm(ctx, formType) {
  const { pgPool, senderPhone, send } = ctx;
  const form = FORMS[formType];
  const app = await getApplication(pgPool, senderPhone, formType);

  if (!app) {
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
    return;
  }

  if (app.mode === 'reverse') {
    await saveSession(pgPool, senderPhone, {
      agent: 'form',
      form_type: formType,
      state: 'reverse',
      field_index: 0,
      retry_count: 0,
      answers: {},
      chat_history: [],
    });
    await send(`Mode: Reverse. Ye form (${form.title}) pehle se jama ho chuka hai. Reference: ${ref(app.id)}.\n\n${REVERSE_HINT}`, true);
    return;
  }

  await saveSession(pgPool, senderPhone, {
    agent: 'form',
    form_type: formType,
    state: 'confirming',
    field_index: form.fields.length,
    retry_count: 0,
    answers: app.data,
    chat_history: [],
  });
  await send(`Mode: Normal. Ye form dobara khol diya gaya hai. Purane jawab ye hain.\n\n${summaryText(form, app.data)}`, true);
}

async function handleRouter(ctx) {
  const { pgPool, senderPhone, text, send, out } = ctx;
  let intent = matchIntent(text);

  if (!intent && READ_RE.test(text)) intent = 'read';

  if (!intent && WORDS_RE.test(text)) {
    try {
      const c = await ai.classifyIntent(redact(text).text);
      intent = c.intent;
      console.log('[ROUTER] ai intent:', intent);
      if (c.voice !== null) {
        await saveSession(pgPool, senderPhone, { voice_reply: c.voice });
        out.voice = c.voice;
      }
    } catch (e) {
      console.error('classify failed:', e.message);
    }
  }

  if (FORMS[intent]) {
    await startForm(ctx, intent);
    return;
  }

  if (intent === 'status' || intent === 'read') {
    const apps = await listApplicationsForPhone(pgPool, senderPhone);
    if (apps.length === 0) {
      await send('Is number se abhi tak koi form jama nahi hua. Form bharne ke liye chunein:\n\n' + MENU);
      return;
    }
    if (intent === 'status') {
      const lines = apps.map((a) => {
        let title = a.form_type;
        if (FORMS[a.form_type]) title = FORMS[a.form_type].title;
        let extra = '';
        if (a.mode === 'normal') extra = ' (dobara khula hai)';
        return `${title} - ${ref(a.id)} - halat: ${statusLabel(a.status)}${extra}`;
      });
      await send(`Aap ki applications:\n\n${lines.join('\n')}\n\n${MENU}`);
      return;
    }
    await send('Apna form dekhne ya status poochne ke liye pehle form chunein:\n\n' + MENU);
    return;
  }

  await send(MENU);
}

async function handleFormStep(ctx) {
  const { pgPool, senderPhone, text, session, send } = ctx;
  const form = FORMS[session.form_type];
  if (!form) {
    await resetSession(pgPool, senderPhone);
    await send(MENU);
    return;
  }

  const state = session.state;

  if (state === 'reverse') {
    await handleReverse(ctx, form);
    return;
  }

  if (state === 'verify') {
    await handleVerify(ctx, form);
    return;
  }

  if (state !== 'collecting' && state !== 'editing' && state !== 'confirming') {
    await resetSession(pgPool, senderPhone);
    await send(MENU);
    return;
  }

  if (text.length < 60 && READ_RE.test(text)) {
    let again = '';
    if (state === 'collecting' || state === 'editing') again = `\n\n${askText(form, session.field_index)}`;
    await send(REFUSAL + again);
    return;
  }

  if (state === 'confirming') {
    await handleConfirming(ctx, form);
    return;
  }

  await handleCollecting(ctx, form);
}

async function handleReverse(ctx, form) {
  const { pgPool, senderPhone, text, session, send } = ctx;
  const app = await getApplication(pgPool, senderPhone, session.form_type);
  if (!app) {
    await resetSession(pgPool, senderPhone);
    await send(MENU);
    return;
  }

  if (RESET_RE.test(text)) {
    await resetSession(pgPool, senderPhone);
    await send(MENU);
    return;
  }

  if (text.toLowerCase() === 'exit') {
    await resetSession(pgPool, senderPhone);
    await send(MENU);
    return;
  }

  let intent = 'other';
  if (WORDS_RE.test(text)) {
    try {
      intent = await ai.classifyReverseIntent(redact(text).text);
    } catch (e) {
      console.error('reverse classify failed:', e.message);
    }
  }

  if (intent === 'exit') {
    await resetSession(pgPool, senderPhone);
    await send(MENU);
    return;
  }

  if (intent === 'status') {
    const line = await safeLine('status', app.status, text);
    const extra = `Reference: ${ref(app.id)}\nForm: ${form.title}\nHalat: ${statusLabel(app.status)}`;
    await send(`${line}\n${extra}`);
    return;
  }

  if (intent === 'focal') {
    const focal = await getFocal(pgPool, session.form_type);
    const line = await safeLine('focal', app.status, text);
    if (focal) {
      await send(`${line}\n${focal.name}\n${focal.email}`);
    } else {
      await send(`${line}\nNo focal person found.`);
    }
    return;
  }

  if (intent === 'view_form') {
    const line = await safeLine('view_form', app.status, text);
    await send(`${line}\n${formView(form, app.data)}`);
    return;
  }

  await send(REVERSE_HINT, true);
}

async function handleVerify(ctx, form) {
  await handleConfirming(ctx, form);
}

async function handleConfirming(ctx, form) {
  const { sock, fromJid, pgPool, senderPhone, text, session, send } = ctx;
  const answers = session.answers || {};

  if (CONFIRM_RE.test(text)) {
    const id = await createApplication(pgPool, senderPhone, session.form_type, answers);
    await saveSession(pgPool, senderPhone, { state: 'reverse', field_index: 0, retry_count: 0, answers: {}, chat_history: [] });
    await send(`Aap ka form jama ho gaya aur lock ho gaya hai.\nReference number: ${ref(id)}`, true);
    await send(REVERSE_TEXT, true);
    if (fs.existsSync(VOICE_PATH)) {
      try {
        await sock.sendMessage(fromJid, { audio: fs.readFileSync(VOICE_PATH), mimetype: 'audio/ogg; codecs=opus', ptt: true });
      } catch (e) {
        console.error('voice note failed:', e.message);
      }
    }
    return;
  }

  if (RESTART_RE.test(text)) {
    await saveSession(pgPool, senderPhone, { state: 'collecting', field_index: 0, retry_count: 0, answers: {}, chat_history: [] });
    await send(`Theek hai, dobara shuru karte hain.\n\n${askText(form, 0)}`);
    return;
  }

  const openField = async (num) => {
    await saveSession(pgPool, senderPhone, { state: 'editing', field_index: num - 1, retry_count: 0 });
    await send(`Theek hai, naya jawab likhein.\n\n${askText(form, num - 1)}`);
  };

  const typed = toAsciiDigits(text).trim();
  if (/^\d{1,2}$/.test(typed)) {
    const num = Number(typed);
    if (num >= 1 && num <= form.fields.length) {
      await openField(num);
      return;
    }
    await send(`Meharbani kar ke 1 se ${form.fields.length} ke darmiyan number likhein.\n\n${summaryText(form, answers)}`, true);
    return;
  }

  let picked = 0;
  if (WORDS_RE.test(text)) {
    try {
      picked = await ai.pickField(form.fields.map((f) => f.label), redact(text).text);
    } catch (e) {
      console.error('pick field failed:', e.message);
    }
  }
  if (picked >= 1 && picked <= form.fields.length) {
    await openField(picked);
    return;
  }

  await send(`Samajh nahi aaya.\n\n${summaryText(form, answers)}`, true);
}

async function handleCollecting(ctx, form) {
  const { pgPool, senderPhone, text, session, send, out } = ctx;
  const state = session.state;
  const answers = session.answers || {};
  const index = session.field_index;
  const field = form.fields[index];

  if (BACK_RE.test(text)) {
    if (state === 'editing') {
      await saveSession(pgPool, senderPhone, { state: 'confirming', field_index: form.fields.length, retry_count: 0 });
      await send(summaryText(form, answers), true);
      return;
    }
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
    if (state === 'editing') {
      await saveSession(pgPool, senderPhone, { state: 'confirming', field_index: form.fields.length, retry_count: 0, answers: newAnswers });
      await send(summaryText(form, newAnswers), true);
      return;
    }
    const nextIndex = index + 1;
    if (nextIndex >= form.fields.length) {
      await saveSession(pgPool, senderPhone, { state: 'confirming', field_index: nextIndex, retry_count: 0, answers: newAnswers });
      await send(summaryText(form, newAnswers), true);
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

  if (!reply) console.error('[handler] AI gave no reply, using hardcoded fallback for field:', field.key);

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
