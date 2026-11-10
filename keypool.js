'use strict';

const { GoogleGenAI } = require('@google/genai');

const MIN = 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_DEADLINE_MS = 30000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 12000;
const MAX_BACKOFF_MS = 5000;

function parseKeys(name) {
  const v = process.env[name];
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function errorBody(e) {
  if (!e) return null;
  if (e.error && typeof e.error === 'object') return e.error;
  if (typeof e.body === 'string') {
    try {
      return JSON.parse(e.body).error || null;
    } catch (ignored) {}
  }
  if (typeof e.message === 'string' && e.message.startsWith('{')) {
    try {
      return JSON.parse(e.message).error || null;
    } catch (ignored) {}
  }
  return null;
}

function httpStatus(e) {
  const body = errorBody(e);
  const status = Number(e && (e.status || e.statusCode || (e.response && e.response.status) || (body && body.code)));
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function googleErrorCode(e) {
  const body = errorBody(e);
  const code = body && body.status;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code : null;
}

function safeErrorMessage(e, status, code) {
  if (status === 400) return 'Google API rejected the request (HTTP 400)';
  if (status === 401 || (status === 403 && code !== 'RESOURCE_EXHAUSTED')) {
    return 'Google API authentication or permission failure';
  }
  if (status === 429 || code === 'RESOURCE_EXHAUSTED') return 'Google API rate or quota limit';
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return `Google API service failure (HTTP ${status})`;
  }
  if (
    e &&
    (e.code === 'REQUEST_TIMEOUT' ||
      e.code === 'REQUEST_DEADLINE' ||
      e.name === 'RequestDeadlineError' ||
      e.name === 'AbortError' ||
      e.name === 'TimeoutError')
  ) {
    if (e.code === 'REQUEST_DEADLINE' || e.name === 'RequestDeadlineError') return 'Request deadline exceeded';
    return 'Request timed out';
  }
  if (!status && e) return 'Network or client request failure';
  return code ? `Google API request failed (${code})` : 'Google API request failed';
}

function retryAfterMs(e, now) {
  const headers =
    (e && e.headers) ||
    (e && e.response && e.response.headers) ||
    (e && e.response && e.response.responseInternal && e.response.responseInternal.headers);
  let value;
  if (headers && typeof headers.get === 'function') value = headers.get('retry-after');
  else if (headers) value = headers['retry-after'] || headers['Retry-After'];
  if (value == null) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}

function isAuthFailure(status, code) {
  return status === 401 || (status === 403 && code !== 'RESOURCE_EXHAUSTED');
}

function isRetryable(e, status, code) {
  if (status === 429 || code === 'RESOURCE_EXHAUSTED' || [500, 502, 503, 504].includes(status)) return true;
  if (status !== null) return false;
  return Boolean(
    e &&
      (e.code === 'REQUEST_TIMEOUT' ||
        e.name === 'AbortError' ||
        e.name === 'TimeoutError' ||
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|fetch failed|socket hang up/i.test(String(e.code || e.message || '')))
  );
}

function backoffMs(attempt, random) {
  const ceiling = Math.min(MAX_BACKOFF_MS, 250 * 2 ** Math.max(0, attempt - 1));
  return Math.min(MAX_BACKOFF_MS, Math.round(ceiling * (0.5 + random())));
}

function safeFailure(e, status, code) {
  if (e instanceof RequestDeadlineError || e instanceof RequestTimeoutError) return e;
  const error = new Error(safeErrorMessage(e, status, code));
  error.name = 'GeminiRequestError';
  if (status !== null) error.status = status;
  if (code) error.googleErrorCode = code;
  return error;
}

function diagnosticLog(logger, fields) {
  const line = '[gemini] ' + JSON.stringify({
    timestamp: new Date().toISOString(),
    pool: fields.pool,
    modelId: fields.modelId || null,
    attemptNumber: fields.attemptNumber,
    httpStatus: fields.httpStatus,
    googleErrorCode: fields.googleErrorCode,
    sanitizedErrorMessage: fields.sanitizedErrorMessage,
    requestDurationMs: fields.requestDurationMs,
    keyRotationOccurred: fields.keyRotationOccurred,
    finalOutcome: fields.finalOutcome,
    ...(fields.retryDelayMs === undefined ? {} : { retryDelayMs: fields.retryDelayMs }),
  });
  logger(line, fields.finalOutcome);
}

class RequestDeadlineError extends Error {
  constructor() {
    super('Gemini request deadline exceeded');
    this.name = 'RequestDeadlineError';
    this.code = 'REQUEST_DEADLINE';
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super('Gemini attempt timed out');
    this.name = 'RequestTimeoutError';
    this.code = 'REQUEST_TIMEOUT';
  }
}

class KeyPool {
  constructor(channel, keys, clientFactory = (apiKey) => new GoogleGenAI({ apiKey }), runtime = {}) {
    this.channel = channel;
    this.slots = keys.map((apiKey) => ({
      client: clientFactory(apiKey),
      disabledUntil: 0,
    }));
    this.cursor = 0;
    this.now = runtime.now || Date.now;
    this.sleep = runtime.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = runtime.random || Math.random;
    this.logger = runtime.logger || ((message, outcome) => {
      if (outcome === 'success') console.log(message);
      else console.error(message);
    });
  }

  get size() {
    return this.slots.length;
  }

  nextUsableIndex(start, now) {
    for (let offset = 0; offset < this.slots.length; offset++) {
      const index = (start + offset) % this.slots.length;
      if (this.slots[index].disabledUntil <= now) return index;
    }
    return -1;
  }

  async run(fn, options = {}) {
    const started = this.now();
    const deadlineMs = Math.max(1, options.deadlineMs || DEFAULT_DEADLINE_MS);
    const deadlineAt = started + deadlineMs;
    const maxAttempts = Math.max(1, Math.min(20, options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
    const attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs || DEFAULT_ATTEMPT_TIMEOUT_MS);
    const modelId = options.modelId || null;

    if (!this.slots.length) {
      const error = new Error(`no keys configured for ${this.channel}`);
      diagnosticLog(this.logger, {
        pool: this.channel,
        modelId,
        attemptNumber: 0,
        httpStatus: null,
        googleErrorCode: null,
        sanitizedErrorMessage: 'No API keys configured for this pool',
        requestDurationMs: 0,
        keyRotationOccurred: false,
        finalOutcome: 'failed',
      });
      throw error;
    }

    let lastError;
    let attemptNumber = 0;
    let startIndex = this.cursor;
    let previousIndex = null;

    while (attemptNumber < maxAttempts) {
      const now = this.now();
      if (now >= deadlineAt) {
        const error = lastError || new RequestDeadlineError();
        diagnosticLog(this.logger, {
          pool: this.channel,
          modelId,
          attemptNumber,
          httpStatus: httpStatus(error),
          googleErrorCode: googleErrorCode(error),
          sanitizedErrorMessage: safeErrorMessage(error, httpStatus(error), googleErrorCode(error)),
          requestDurationMs: now - started,
          keyRotationOccurred: false,
          finalOutcome: 'deadline',
        });
        throw error.code === 'REQUEST_DEADLINE' ? error : new RequestDeadlineError();
      }

      const index = this.nextUsableIndex(startIndex, now);
      if (index < 0) break;
      const slot = this.slots[index];
      const keyRotationOccurred = previousIndex !== null && index !== previousIndex;
      previousIndex = index;
      attemptNumber++;
      const attemptStarted = this.now();
      const timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, deadlineAt - attemptStarted));
      const controller = new AbortController();
      let timeout;
      let timedOut = false;

      try {
        const request = Promise.resolve().then(() => fn(slot.client, {
          signal: controller.signal,
          timeoutMs,
        }));
        const result = await Promise.race([
          request,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(timeoutMs >= deadlineAt - attemptStarted ? new RequestDeadlineError() : new RequestTimeoutError());
            }, timeoutMs);
          }),
        ]);
        clearTimeout(timeout);
        this.cursor = index;
        diagnosticLog(this.logger, {
          pool: this.channel,
          modelId,
          attemptNumber,
          httpStatus: null,
          googleErrorCode: null,
          sanitizedErrorMessage: null,
          requestDurationMs: this.now() - attemptStarted,
          keyRotationOccurred,
          finalOutcome: 'success',
        });
        return result;
      } catch (e) {
        clearTimeout(timeout);
        const failure = timedOut
          ? this.now() >= deadlineAt
            ? new RequestDeadlineError()
            : new RequestTimeoutError()
          : e;
        lastError = failure;
        const status = httpStatus(failure);
        const code = googleErrorCode(failure);
        const authFailure = isAuthFailure(status, code);
        if (authFailure) {
          slot.disabledUntil = this.now() + 12 * 60 * MIN;
        }

        const nextIndex = this.nextUsableIndex((index + 1) % this.slots.length, this.now());
        const retryable = isRetryable(failure, status, code) || authFailure;
        const hasAttempts = attemptNumber < maxAttempts && retryable && nextIndex >= 0;
        const delayMs = status === 429 || code === 'RESOURCE_EXHAUSTED'
          ? retryAfterMs(e, this.now()) ?? backoffMs(attemptNumber, this.random)
          : authFailure
            ? 0
            : backoffMs(attemptNumber, this.random);
        const withinDeadline = this.now() + delayMs < deadlineAt;
        const finalOutcome = failure instanceof RequestDeadlineError
          ? 'deadline'
          : timedOut && this.now() >= deadlineAt
          ? 'deadline'
          : hasAttempts && !withinDeadline
            ? 'deadline'
            : hasAttempts
            ? 'retrying'
            : 'failed';

        diagnosticLog(this.logger, {
          pool: this.channel,
          modelId,
          attemptNumber,
          httpStatus: status,
          googleErrorCode: code,
          sanitizedErrorMessage: safeErrorMessage(failure, status, code),
          requestDurationMs: this.now() - attemptStarted,
          keyRotationOccurred,
          finalOutcome,
          ...(finalOutcome === 'retrying' ? { retryDelayMs: delayMs } : {}),
        });

        if (finalOutcome === 'deadline') throw new RequestDeadlineError();
        if (finalOutcome !== 'retrying') throw safeFailure(failure, status, code);
        if (delayMs > 0) {
          await this.sleep(delayMs);
        }
        startIndex = (index + 1) % this.slots.length;
      }
    }

    if (lastError) throw safeFailure(lastError, httpStatus(lastError), googleErrorCode(lastError));
    diagnosticLog(this.logger, {
      pool: this.channel,
      modelId,
      attemptNumber,
      httpStatus: null,
      googleErrorCode: null,
      sanitizedErrorMessage: 'No usable API keys remain for this pool',
      requestDurationMs: this.now() - started,
      keyRotationOccurred: false,
      finalOutcome: 'failed',
    });
    throw new Error(`No usable API keys remain for ${this.channel}`);
  }
}

module.exports = {
  KeyPool,
  parseKeys,
  RequestDeadlineError,
  RequestTimeoutError,
  httpStatus,
  googleErrorCode,
};
