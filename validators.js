'use strict';

// Converts Urdu/Arabic-Indic digits to ASCII digits.
function toAsciiDigits(input) {
  return String(input || '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function validateName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 60) return { ok: false, reason: 'bad_length' };
  if (/[0-9\u0660-\u0669\u06F0-\u06F9?!@#$%^&*()_+=<>{}\[\]\\|\/]/.test(t)) return { ok: false, reason: 'bad_chars' };
  return { ok: true, value: t };
}

function validateCnic(text) {
  const t = toAsciiDigits(text).trim();
  if (/[^0-9\s-]/.test(t)) return { ok: false, reason: 'not_a_number' };
  const digits = t.replace(/\D/g, '');
  if (digits.length !== 13) return { ok: false, reason: 'wrong_length', digitsFound: digits.length };
  return { ok: true, value: `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}` };
}

function validateDob(text) {
  const t = toAsciiDigits(text).trim();
  const m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (!m) return { ok: false, reason: 'bad_format' };
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  const real = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  if (!real || year < 1900 || d.getTime() > Date.now()) return { ok: false, reason: 'bad_date' };
  return { ok: true, value: `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}` };
}

function validateAddress(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 8 || t.length > 200) return { ok: false, reason: 'bad_length' };
  return { ok: true, value: t };
}

function validatePhone(text) {
  const t = toAsciiDigits(text).trim();
  if (/[^0-9\s+-]/.test(t)) return { ok: false, reason: 'not_a_number' };
  let digits = t.replace(/\D/g, '');
  if (digits.startsWith('92') && digits.length === 12) digits = '0' + digits.slice(2);
  if (digits.length !== 11) return { ok: false, reason: 'wrong_length', digitsFound: digits.length };
  if (!digits.startsWith('03')) return { ok: false, reason: 'bad_format' };
  return { ok: true, value: `${digits.slice(0, 4)}-${digits.slice(4)}` };
}

function validateCount(text, min, max) {
  const t = toAsciiDigits(text).trim();
  if (!/^\d{1,3}$/.test(t)) return { ok: false, reason: 'not_a_number' };
  const n = Number(t);
  if (n < min || n > max) return { ok: false, reason: 'bad_range' };
  return { ok: true, value: String(n) };
}

function makeChoiceValidator(options) {
  return (text) => {
    const t = toAsciiDigits(text).trim().toLowerCase();
    if (/^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= options.length) return { ok: true, value: options[Number(t) - 1] };
    const hit = options.find((o) => o.toLowerCase() === t);
    if (hit) return { ok: true, value: hit };
    return { ok: false, reason: 'bad_choice' };
  };
}

module.exports = { toAsciiDigits, validateName, validateCnic, validateDob, validateAddress, validatePhone, validateCount, makeChoiceValidator };
