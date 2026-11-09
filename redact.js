'use strict';

const { toAsciiDigits } = require('./validators');

function redact(input) {
  const ascii = toAsciiDigits(input);
  let digitCount = 0;
  let text = ascii.replace(/\d(?:[\s-]?\d){3,}/g, (m) => {
    digitCount += m.replace(/\D/g, '').length;
    return '[number]';
  });
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
  const hasWords = /[A-Za-z\u0600-\u06FF]{2,}/.test(text.replace(/\[number\]|\[email\]/g, ''));
  return { text: text.trim(), digitCount, hasWords };
}

module.exports = { redact };
