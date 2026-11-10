'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { audioToOgg } = require('../ai');

function wavOf(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

test('wav input converts to ogg', async () => {
  const pcm = Buffer.alloc(9600);
  const out = await audioToOgg(wavOf(pcm), 'audio/wav');
  assert.strictEqual(out.slice(0, 4).toString('ascii'), 'OggS');
});

test('raw pcm input converts to ogg', async () => {
  const pcm = Buffer.alloc(9600);
  const out = await audioToOgg(pcm, 'audio/L16;codec=pcm;rate=24000');
  assert.strictEqual(out.slice(0, 4).toString('ascii'), 'OggS');
});
