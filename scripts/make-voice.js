'use strict';

try {
  require('dotenv').config();
} catch (e) {}
const fs = require('fs');
const path = require('path');
const ai = require('../ai');

const TEXT =
  'آپ کا فارم جمع ہو گیا ہے اور اب لاک ہو چکا ہے۔ آپ ریورس موڈ میں ہیں۔ اب آپ اپنا فارم دیکھ سکتے ہیں، درخواست کی حالت پوچھ سکتے ہیں، یا متعلقہ افسر کا رابطہ مانگ سکتے ہیں۔ واپس جانے کے لیے ایگزٹ لکھیں۔';

(async () => {
  const audio = await ai.speak(TEXT);
  const dir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reverse-mode.ogg'), audio);
  console.log('saved assets/reverse-mode.ogg', audio.length, 'bytes');
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
