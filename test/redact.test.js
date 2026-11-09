'use strict';

const { redact } = require('../redact');

// [input, expected text, expected digitCount, expected hasWords]
const cases = [
  ['mera cnic 35202-1234567-1 hai kya?', 'mera cnic [number] hai kya?', 13, true],
  ['12345', '[number]', 5, false],
  ['where do I find my CNIC?', 'where do I find my CNIC?', 0, true],
  ['+92 300 1234567 par call karo', '[number] par call karo', 12, true],
  ['mera number \u06F0\u06F3\u06F0\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7 hai', 'mera number [number] hai', 11, true],
  ['ali1234567@gmail.com meri email hai', '[email] meri email hai', 0, true],
  ['3\u200B5\u200B2\u200B0\u200B2\u200B1234567\u200B1', '[number]', 13, false],
  ['(0300) 123.4567', '[number]', 11, false],
  ['meri tareekh 15-08-1990 hai', 'meri tareekh [number] hai', 8, true],
  ['mera cnic teen paanch do do do aik do teen char paanch chhe saat hai', 'mera cnic [number] hai', 13, true],
  ['my cnic is three five two zero two one two three four five six seven one', 'my cnic is [number]', 13, true],
  ['do teen din baad aaunga', 'do teen din baad aaunga', 0, true],
  ['mera naam Ali Khan hai, CNIC kahan milega?', 'mera naam [name] hai, CNIC kahan milega?', 0, true],
  ['my name is Sara Ahmed, where is the CNIC?', 'my name is [name], where is the CNIC?', 0, true],
  ['میرا نام علی خان ہے', 'میرا نام [name] ہے', 0, true],
  ['mera naam kya likhun?', 'mera naam kya likhun?', 0, true],
  ['Chowk par ghar hai, 12 number gali', 'Chowk par ghar hai, 12 number gali', 0, true],
];

let failed = 0;
for (const [input, text, digitCount, hasWords] of cases) {
  const r = redact(input);
  const ok = r.text === text && r.digitCount === digitCount && r.hasWords === hasWords;
  if (!ok) {
    failed++;
    console.log('FAIL', JSON.stringify(input), '=>', JSON.stringify(r));
  }
}
console.log(failed ? `${failed} FAILED of ${cases.length}` : `ALL ${cases.length} PASSED`);
process.exit(failed ? 1 : 0);
