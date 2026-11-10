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
  'Assalam o Alaikum! Main aap ki sarkari forms bharne mein madad karta hoon.\n\n' +
  'Aap in mein se kisi ke liye madad le sakte hain:\n' +
  '1. Shanakhti card (ID card) ka form\n' +
  '2. Sehat card ka form\n' +
  '3. Driving license ka form\n' +
  '4. Apni application ka status\n\n' +
  'Aap bas bata dein ke aap ko kya chahiye, apne alfaaz mein ya kisi option ka naam ya number bata kar. Voice note bhi bhej sakte hain.';

const VOICE_PATH = path.join(__dirname, 'assets', 'reverse-mode.ogg');

const REVERSE_HINT =
  'Aap mujh se apne form, apni application ki halat ya mutaliqa afsar (focal person) ke baare mein kuch bhi pooch sakte hain. Jab aur kuch na poochna ho to bata dein, main aap ko wapas shuru par le jaunga.';

const REVERSE_TEXT = `Mode: Reverse. Ab aap ka form lock ho chuka hai.\n\n${REVERSE_HINT}`;

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
const NAV_RE = /\b(back|wapas|peeche|pichay|pichla|menu|shuru|cancel|exit)\b|پیچھے|واپس|شروع/i;
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

function digitIntent(t) {
  const n = toAsciiDigits(t).trim();
  if (n === '1') return 'id_card';
  if (n === '2') return 'health_card';
  if (n === '3') return 'license';
  if (n === '4') return 'status';
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
    '\n\nKya sab theek hai? Agar kuch badalna ho to bata dein kaun si cheez badalni hai, ya chahein to poora form dobara bhar sakte hain.'
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

async function remember(pgPool, senderPhone, history, rawText, reply) {
  const red = redact(rawText);
  if (!red.hasWords || !reply) return;
  const strip = (s) => s.replace(/[<>]/g, '');
  const next = [
    ...history,
    { role: 'user', text: `<user_text>${strip(red.text)}</user_text>` },
    { role: 'model', text: reply },
  ];
  await saveSession(pgPool, senderPhone, { chat_history: next.slice(-8) });
}

async function leaveToMenu(ctx, lead) {
  const { pgPool, senderPhone, send } = ctx;
  await resetSession(pgPool, senderPhone);
  await saveSession(pgPool, senderPhone, { chat_history: [] });
  if (lead) await send(`${lead}\n\n${MENU}`);
  else await send(MENU);
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
  const { pgPool, senderPhone, text, session, send, out } = ctx;
  let history = [];
  if (Array.isArray(session.chat_history)) history = session.chat_history;
  let intent = digitIntent(text);
  let reply = '';

  if (!intent) {
    try {
      const c = await ai.classifyIntent(redact(text).text, history);
      intent = c.intent;
      reply = c.reply;
      console.log('[ROUTER] ai intent:', intent);
      if (c.voice !== null) {
        await saveSession(pgPool, senderPhone, { voice_reply: c.voice });
        out.voice = c.voice;
      }
    } catch (e) {
      console.error('classify failed:', e.message);
      intent = matchIntent(text);
    }
  }

  if (FORMS[intent]) {
    await startForm(ctx, intent);
    return;
  }

  if (intent === 'status') {
    const apps = await listApplicationsForPhone(pgPool, senderPhone);
    if (apps.length === 0) {
      await send('Is number se abhi tak koi form jama nahi hua. Aap chahein to ID card, sehat card ya driving license ka form bhar sakte hain.');
      return;
    }
    const lines = apps.map((a) => {
      let title = a.form_type;
      if (FORMS[a.form_type]) title = FORMS[a.form_type].title;
      let extra = '';
      if (a.mode === 'normal') extra = ' (dobara khula hai)';
      return `${title} - ${ref(a.id)} - halat: ${statusLabel(a.status)}${extra}`;
    });
    await send(`Aap ki applications:\n\n${lines.join('\n')}\n\nAur kisi cheez mein madad chahiye to bata dein.`, true);
    return;
  }

  if (reply) {
    await remember(pgPool, senderPhone, history, text, reply);
    await send(reply);
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
    await leaveToMenu(ctx, '');
    return;
  }

  let history = [];
  if (Array.isArray(session.chat_history)) history = session.chat_history;

  let turn = { action: 'chat', reply: '' };
  try {
    turn = await ai.reverseTurn({ redactedText: redact(text).text, history, status: app.status });
  } catch (e) {
    console.error('reverse turn failed:', e.message);
  }

  if (turn.action === 'exit') {
    await leaveToMenu(ctx, turn.reply);
    return;
  }

  if (turn.action === 'show_status') {
    let lead = turn.reply;
    if (!lead) lead = LINES.status;
    await remember(pgPool, senderPhone, history, text, lead);
    await send(`${lead}\n\nReference: ${ref(app.id)}\nForm: ${form.title}\nHalat: ${statusLabel(app.status)}`, true);
    return;
  }

  if (turn.action === 'show_focal') {
    let lead = turn.reply;
    if (!lead) lead = LINES.focal;
    await remember(pgPool, senderPhone, history, text, lead);
    const focal = await getFocal(pgPool, session.form_type);
    if (focal) {
      await send(`${lead}\n\n${focal.name}\n${focal.email}`, true);
    } else {
      await send('Is form ke liye abhi koi focal person darj nahi hai.', true);
    }
    return;
  }

  if (turn.action === 'show_form') {
    let lead = turn.reply;
    if (!lead) lead = LINES.view_form;
    await remember(pgPool, senderPhone, history, text, lead);
    await send(`${lead}\n\n${formView(form, app.data)}`, true);
    return;
  }

  if (turn.reply) {
    await remember(pgPool, senderPhone, history, text, turn.reply);
    await send(turn.reply);
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

  const submit = async () => {
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
  };

  const restart = async () => {
    await saveSession(pgPool, senderPhone, { state: 'collecting', field_index: 0, retry_count: 0, answers: {}, chat_history: [] });
    await send(`Theek hai, dobara shuru karte hain.\n\n${askText(form, 0)}`);
  };

  const openField = async (num) => {
    await saveSession(pgPool, senderPhone, { state: 'editing', field_index: num - 1, retry_count: 0 });
    await send(`Theek hai, naya jawab likhein.\n\n${askText(form, num - 1)}`);
  };

  if (CONFIRM_RE.test(text)) {
    await submit();
    return;
  }

  if (RESTART_RE.test(text)) {
    await restart();
    return;
  }

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

  let turn = { action: 'chat', field: 0, reply: '' };
  if (WORDS_RE.test(text)) {
    try {
      turn = await ai.reviewTurn({ labels: form.fields.map((f) => f.label), redactedText: redact(text).text, history: [] });
    } catch (e) {
      console.error('review turn failed:', e.message);
    }
  }
  if (turn.action === 'confirm') {
    await submit();
    return;
  }
  if (turn.action === 'restart') {
    await restart();
    return;
  }
  if (turn.action === 'edit' && turn.field >= 1 && turn.field <= form.fields.length) {
    await openField(turn.field);
    return;
  }
  if (turn.reply) {
    await send(turn.reply);
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

  const isQuestion = QUESTION_RE.test(text) || READ_RE.test(text) || NAV_RE.test(text);
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
      if (r.nav === 'menu') {
        await resetSession(pgPool, senderPhone);
        await saveSession(pgPool, senderPhone, { chat_history: [] });
        await send(`${r.reply}\n\n${MENU}`);
        return;
      }
      if (r.nav === 'back') {
        if (state === 'editing') {
          await saveSession(pgPool, senderPhone, { state: 'confirming', field_index: form.fields.length, retry_count: 0 });
          await send(summaryText(form, answers), true);
          return;
        }
        if (index > 0) {
          await saveSession(pgPool, senderPhone, { field_index: index - 1, retry_count: 0 });
          await send(`${r.reply}\n\n${askText(form, index - 1)}`);
          return;
        }
      }
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
