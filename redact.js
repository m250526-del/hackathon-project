'use strict';

const { toAsciiDigits } = require('./validators');

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const DASH_RE = /[\u2010-\u2015\u2212]/g;
const FULLWIDTH_RE = /[\uFF10-\uFF19]/g;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const DIGIT_RUN_RE = /[+(]?\d(?:[\s\-.()\/_]{0,3}\d){3,}/g;

// Digits spelled out as words (voice transcripts): English, Roman Urdu, Urdu script.
const DIGIT_WORDS = [
  'sifar', 'siphar', 'zero', 'oh', 'aik', 'ek', 'one', 'do', 'two', 'teen', 'three',
  'char', 'chaar', 'four', 'paanch', 'panch', 'five', 'chhe', 'chay', 'chhey', 'six',
  'saat', 'seven', 'aath', 'aat', 'eight', 'nau', 'naw', 'nine',
  'صفر', 'ایک', 'یک', 'دو', 'تین', 'چار', 'چہار', 'پانچ', 'پنج', 'چھ', 'چھے', 'سات', 'ہفت', 'آٹھ', 'ہشت', 'نو',
];
const W = DIGIT_WORDS.join('|');
const WORD_RUN_RE = new RegExp(`(?<!\\p{L})(?:${W})(?:[\\s,.\\-]+(?:${W})){5,}(?!\\p{L})`, 'giu');

// Name introductions: "mera naam X", "my name is X", "walid ka naam X", Urdu script.
const NAME_TRIGGERS = [
  '(?:mera|meri|mere)\\s+(?:poora\\s+|pura\\s+)?naam',
  'my\\s+(?:full\\s+)?name\\s+is',
  "(?:walid|walida|abu|abbu|ammi|father|mother|wife|husband|biwi|shohar)(?:\\s+(?:ka|ki|ke)|['’]s)?\\s+(?:naam|name)(?:\\s+is)?",
  '(?:میرا|والد|والدہ|بیوی|شوہر)(?:\\s+(?:کا|کی))?\\s+نام',
].join('|');
const NAME_RE = new RegExp(
  `(?<!\\p{L})((?:${NAME_TRIGGERS})(?:\\s+(?:hai|is|ہے))?)\\s+((?:[\\p{L}\\p{M}'’]+\\s+){0,4}[\\p{L}\\p{M}'’]+)`,
  'giu'
);
const STOP = new Set(
  (
    'hai hay hain he hy h hoon hun ho tha thi aur and or ka ki ke ko se me mein par pe pay kya kyun kahan kidhar kaise ' +
    'ye yeh wo woh to is the my hi bhi nahi nahin likhna likhun likhu likhoon likhein likho bohat bahut lamba chota ' +
    'ab abhi sahi galat daalna dalna dalun bharna what where how ' +
    'ہے ہیں ہوں اور کا کی کے کو سے میں پر یہ وہ کیا کہاں کیسے تو تھا تھی بھی نہیں'
  ).split(' ')
);

function redact(input) {
  let text = toAsciiDigits(input)
    .replace(FULLWIDTH_RE, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(INVISIBLE_RE, '')
    .replace(DASH_RE, '-');
  let digitCount = 0;
  const kinds = new Set();

  // Emails first, so digits inside an address cannot split it.
  text = text.replace(EMAIL_RE, () => {
    kinds.add('email');
    return '[email]';
  });

  text = text.replace(DIGIT_RUN_RE, (m) => {
    digitCount += m.replace(/\D/g, '').length;
    kinds.add('number');
    return '[number]';
  });

  text = text.replace(WORD_RUN_RE, (m) => {
    const wordCount = m.split(/[\s,.\-]+/).filter(Boolean).length;
    digitCount += wordCount === 12 && /\bcnic\b/i.test(text.slice(0, text.indexOf(m))) ? 13 : wordCount;
    kinds.add('number');
    return '[number]';
  });

  text = text.replace(NAME_RE, (m, prefix, rest) => {
    const tokens = rest.split(/\s+/);
    const taken = [];
    for (const t of tokens) {
      if (taken.length === 4 || STOP.has(t.toLowerCase())) break;
      taken.push(t);
    }
    if (!taken.length) return m;
    kinds.add('name');
    const left = tokens.slice(taken.length);
    return `${prefix} [name]${left.length ? ' ' + left.join(' ') : ''}`;
  });

  const hasWords = /[A-Za-z\u0600-\u06FF]{2,}/.test(text.replace(/\[(?:number|email|name)\]/g, ''));
  return { text: text.trim(), digitCount, hasWords, kinds: [...kinds] };
}

module.exports = { redact };
