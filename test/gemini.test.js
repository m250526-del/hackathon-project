'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { KeyPool, RequestDeadlineError, RequestTimeoutError } = require('../keypool');

function fakeRuntime() {
  const logs = [];
  const delays = [];
  return {
    logs,
    delays,
    logger: (line) => logs.push(JSON.parse(line.slice('[gemini] '.length))),
    sleep: async (ms) => delays.push(ms),
    random: () => 0.5,
  };
}

function apiError(status, code, message = 'provider message') {
  return Object.assign(new Error(message), {
    status,
    error: { code: status, status: code, message },
  });
}

test('successful first-key request logs a privacy-safe success', async () => {
  const runtime = fakeRuntime();
  const pool = new KeyPool('chat', ['secret-key'], (apiKey) => ({ apiKey }), runtime);
  const result = await pool.run(async (client) => client.apiKey === 'secret-key' && 'ok', {
    modelId: 'gemini-3.5-flash-lite',
    maxAttempts: 1,
  });

  assert.equal(result, 'ok');
  assert.equal(runtime.logs[0].finalOutcome, 'success');
  assert.equal(runtime.logs[0].pool, 'chat');
  assert.equal(runtime.logs[0].modelId, 'gemini-3.5-flash-lite');
  assert.equal(JSON.stringify(runtime.logs).includes('secret-key'), false);
});

test('503 rotates to another key and succeeds', async () => {
  const runtime = fakeRuntime();
  const pool = new KeyPool('chat', ['key-one', 'key-two'], (apiKey) => ({ apiKey }), runtime);
  const seen = [];
  const result = await pool.run(async (client) => {
    seen.push(client.apiKey);
    if (client.apiKey === 'key-one') throw apiError(503, 'UNAVAILABLE', 'sensitive request content');
    return 'ok';
  }, { modelId: 'gemini-3.5-flash-lite', maxAttempts: 2, deadlineMs: 2000 });

  assert.equal(result, 'ok');
  assert.deepEqual(seen, ['key-one', 'key-two']);
  assert.equal(runtime.logs[0].httpStatus, 503);
  assert.equal(runtime.logs[0].googleErrorCode, 'UNAVAILABLE');
  assert.equal(runtime.logs[0].keyRotationOccurred, false);
  assert.equal(runtime.logs[1].keyRotationOccurred, true);
  assert.equal(JSON.stringify(runtime.logs).includes('sensitive request content'), false);
});

test('all configured keys failing produces bounded attempts and final diagnostic', async () => {
  const runtime = fakeRuntime();
  const pool = new KeyPool('stt', ['key-one', 'key-two', 'key-three'], (apiKey) => ({ apiKey }), runtime);
  await assert.rejects(
    pool.run(async () => { throw apiError(503, 'UNAVAILABLE'); }, {
      modelId: 'gemini-3.8-flash',
      maxAttempts: 3,
      deadlineMs: 2000,
    }),
    (error) => error.status === 503
  );
  assert.equal(runtime.logs.length, 3);
  assert.equal(runtime.logs[2].finalOutcome, 'failed');
});

test('429 honors Retry-After before rotating and retrying', async () => {
  const runtime = fakeRuntime();
  const pool = new KeyPool('chat', ['key-one', 'key-two'], (apiKey) => ({ apiKey }), runtime);
  const error = apiError(429, 'RESOURCE_EXHAUSTED');
  error.headers = { 'retry-after': '2' };
  const result = await pool.run(async (client) => {
    if (client.apiKey === 'key-one') throw error;
    return 'ok';
  }, { maxAttempts: 2, deadlineMs: 5000 });

  assert.equal(result, 'ok');
  assert.deepEqual(runtime.delays, [2000]);
  assert.equal(runtime.logs[0].googleErrorCode, 'RESOURCE_EXHAUSTED');
});

test('invalid API key rotates to another key without exposing credentials', async () => {
  const runtime = fakeRuntime();
  const pool = new KeyPool('tts', ['secret-invalid-key', 'valid-key'], (apiKey) => ({ apiKey }), runtime);
  const result = await pool.run(async (client) => {
    if (client.apiKey === 'secret-invalid-key') throw apiError(403, 'PERMISSION_DENIED');
    return 'ok';
  }, { maxAttempts: 2, deadlineMs: 2000 });

  assert.equal(result, 'ok');
  assert.equal(runtime.logs[0].sanitizedErrorMessage, 'Google API authentication or permission failure');
  assert.equal(JSON.stringify(runtime.logs).includes('secret-invalid-key'), false);
});

test('non-retryable 400 is not retried on another key', async () => {
  const runtime = fakeRuntime();
  const pool = new KeyPool('chat', ['key-one', 'key-two'], (apiKey) => ({ apiKey }), runtime);
  let calls = 0;
  await assert.rejects(
    pool.run(async () => {
      calls++;
      throw apiError(400, 'INVALID_ARGUMENT');
    }, { maxAttempts: 4, deadlineMs: 2000 }),
    (error) => error.status === 400
  );
  assert.equal(calls, 1);
  assert.equal(runtime.logs[0].finalOutcome, 'failed');
});

test('attempt timeout aborts the client request', async () => {
  const runtime = fakeRuntime();
  const pool = new KeyPool('chat', ['key-one', 'key-two'], (apiKey) => ({ apiKey }), runtime);
  let signal;
  await assert.rejects(
    pool.run((_client, request) => {
      signal = request.signal;
      return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }, { maxAttempts: 1, deadlineMs: 100, attemptTimeoutMs: 10 }),
    (error) => error instanceof RequestTimeoutError
  );
  assert.equal(signal.aborted, true);
  assert.equal(runtime.logs[0].finalOutcome, 'failed');
});

test('overall deadline aborts an in-flight request', async () => {
  const runtime = fakeRuntime();
  const pool = new KeyPool('chat', ['key-one'], () => ({}), runtime);
  let signal;
  await assert.rejects(
    pool.run((_client, request) => {
      signal = request.signal;
      return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }, { maxAttempts: 2, deadlineMs: 15, attemptTimeoutMs: 100 }),
    (error) => error instanceof RequestDeadlineError
  );
  assert.equal(signal.aborted, true);
  assert.equal(runtime.logs[0].finalOutcome, 'deadline');
});

test('separate pools use fixed model IDs and compatible SDK request options', async () => {
  const apiPath = require.resolve('@google/genai');
  const keypoolPath = require.resolve('../keypool');
  const aiPath = require.resolve('../ai');
  const oldSdk = require.cache[apiPath];
  const oldSpawn = require('node:child_process').spawn;
  const oldEnv = {
    GEMINI_CHAT_KEYS: process.env.GEMINI_CHAT_KEYS,
    GEMINI_STT_KEYS: process.env.GEMINI_STT_KEYS,
    GEMINI_TTS_KEYS: process.env.GEMINI_TTS_KEYS,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    GEMINI_STT_MODEL: process.env.GEMINI_STT_MODEL,
    GEMINI_TTS_MODEL: process.env.GEMINI_TTS_MODEL,
  };
  const clients = [];
  const calls = [];

  class MockGoogleGenAI {
    constructor({ apiKey }) {
      this.apiKey = apiKey;
      this.models = {
        list: () => { throw new Error('model discovery must not run'); },
        generateContent: async (params) => {
          calls.push({ apiKey, params });
          if (apiKey === 'chat-key') return { text: '{"intent":"id_card","voice":null}' };
          if (apiKey === 'stt-key') return { text: 'transcript' };
          return {
            candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([0, 0]).toString('base64') } }] } }],
          };
        },
      };
      clients.push(this);
    }
  }

  const childProcess = require('node:child_process');
  childProcess.spawn = () => {
    const process = new EventEmitter();
    process.stdout = new EventEmitter();
    process.stdin = {
      on() {},
      end() {
        setImmediate(() => {
          process.stdout.emit('data', Buffer.from('mock ogg'));
          process.emit('close', 0);
        });
      },
    };
    return process;
  };
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: { GoogleGenAI: MockGoogleGenAI },
  };
  delete require.cache[keypoolPath];
  delete require.cache[aiPath];
  process.env.GEMINI_CHAT_KEYS = 'chat-key';
  process.env.GEMINI_STT_KEYS = 'stt-key';
  process.env.GEMINI_TTS_KEYS = 'tts-key';
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_STT_MODEL;
  delete process.env.GEMINI_TTS_MODEL;

  try {
    const ai = require('../ai');
    assert.equal((await ai.classifyIntent('redacted intent')).intent, 'id_card');
    assert.equal(await ai.transcribe(Buffer.from([0, 0]), 'audio/ogg'), 'transcript');
    assert.ok((await ai.speak('hello')).length > 0);

    assert.deepEqual(calls.map(({ apiKey, params }) => [apiKey, params.model]), [
      ['chat-key', 'gemini-3.5-flash-lite'],
      ['stt-key', 'gemini-3.8-flash'],
      ['tts-key', 'gemini-3.8-flash-lite-tts'],
    ]);
    for (const { params } of calls) {
      assert.equal(params.config.httpOptions.retryOptions.attempts, 1);
      assert.equal(params.config.abortSignal instanceof AbortSignal, true);
    }
    assert.equal(calls[2].params.config.responseModalities[0], 'AUDIO');
    assert.equal(calls[2].params.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.equal(clients.length, 3);
  } finally {
    childProcess.spawn = oldSpawn;
    if (oldSdk) require.cache[apiPath] = oldSdk;
    else delete require.cache[apiPath];
    delete require.cache[keypoolPath];
    delete require.cache[aiPath];
    for (const [name, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('runtime model discovery has been removed', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'ai.js'), 'utf8');
  assert.doesNotMatch(source, /discoverModel|callWithModel|models\.list|const resolved/);
});
