# Gemini integration and 503 diagnostic report

## Selected models and API calls

The application defaults to these fixed model IDs; optional environment overrides remain available:

| Pool | Default model | SDK API method and request |
|---|---|---|
| Chat | `gemini-3.5-flash-lite` | `models.generateContent`, text contents, system instruction, JSON response mode where requested |
| STT | `gemini-3.5-flash-lite` | `models.generateContent`, OGG audio as `inlineData` plus transcription instruction |
| TTS | `gemini-3.8-flash-lite-tts` | `models.generateContent`, `responseModalities: ['AUDIO']`, prebuilt voice `Kore` |

No runtime model discovery, `models.list()` call, or automatic model switching remains. The installed `@google/genai` version is 3.0.0. Its types support `GenerateContentConfig.abortSignal` and `httpOptions`, including request timeout and retry options. The SDK documentation notes that its abort signal is client-side and does not guarantee cancellation of server-side processing.

## Changes made

- Fixed model defaults in `ai.js`; retained `GEMINI_MODEL`, `GEMINI_STT_MODEL`, and `GEMINI_TTS_MODEL` as optional overrides. `GEMINI_TTS_VOICE` defaults to `Kore`.
- Reworked `KeyPool` to enforce bounded attempts, request deadlines, per-attempt timeouts, key rotation, transient retries, Retry-After handling, and per-key cooldown for authentication/permission failures.
- Disabled opaque SDK retries (`httpOptions.retryOptions.attempts: 1`) so retry count and timing are controlled by the application.
- Passed an `AbortSignal` and SDK HTTP timeout for each attempt. A timeout aborts the client request where supported; it must not be interpreted as proof that Google stopped processing the request.
- Added one-line structured diagnostics with timestamp, pool, model, attempt, HTTP status, Google error code, sanitized error category, request duration, key-rotation indicator, and final outcome. Logs do not include raw SDK error bodies.
- Updated `env.example` with the fixed defaults and optional override names.
- Added mocked tests; they issue no Google API requests.

## Root causes established from repository code

- Previously, `KeyPool.run()` attempted each currently eligible key once and then threw. A 503 received a 30-second cooldown, but there was no bounded retry/backoff cycle after the pool pass. A 429 received a long cooldown rather than using the response's Retry-After value.
- The previous `answerFormQuestion` 12-second wrapper used `Promise.race` without an `AbortSignal`. It could return a timeout to the handler while the underlying SDK request continued. Thus the timeout log did not prove that the request stopped.
- Chat, STT, and TTS were separate `KeyPool` instances, using `GEMINI_CHAT_KEYS`, `GEMINI_STT_KEYS`, and `GEMINI_TTS_KEYS`. If a channel-specific list was empty, each pool could fall back to `GEMINI_API_KEY`; in that configuration the pools were separate but could use the same credential.
- The SDK's `models.generateContent` is the call path for all three features. Before this change, the model value could come from environment overrides or runtime discovery, so the supplied status-only logs do not establish which exact model was used in production.
- The installed SDK's API error type exposes an HTTP status. In the installed 3.0.0 implementation, a non-success HTTP response is converted to an `ApiError` whose message contains the JSON error body; the declared `ApiErrorInfo` does not expose response headers. Therefore raw exception messages are intentionally not logged. The request-scoped fetch wrapper captures response headers and attaches them to a failed request so `Retry-After` remains available even when the SDK's `ApiError` drops the headers. The new diagnostics parse the safe Google error status/code from JSON-shaped SDK errors when available and use a generic sanitized message category.

## Production 503 investigation

The supplied production excerpt establishes that the chat pool received HTTP 503 responses from three configured key slots and that the form-help path later reached a 12-second timeout. It does **not** contain the corresponding model ID, endpoint, Google error code, response body, per-attempt duration, or production environment variable names/values. It therefore cannot establish that the keys all failed against the same effective model or reveal Google's underlying reason.

The code path sends chat requests through the same SDK `models.generateContent` method and the same configured chat model for a given process; separate chat keys do not themselves choose different models. Whether production overrides were set is unknown.

Plausible causes include temporary Google service overload or unavailability, a model- or region-specific service problem, or repeated requests consuming the previous timeout budget while the client rotated through keys. HTTP 503 alone is not evidence that an API key is invalid. Invalid/unauthorized credentials are handled separately as 401/403; quota/rate exhaustion is recognized through 429 or `RESOURCE_EXHAUSTED`. A model-access problem is also possible, but the supplied logs do not include the status/code/body needed to confirm it.

The new retry policy will make future failures distinguishable by status and Google error code. It cannot retroactively identify the cause of the earlier production 503s.

## Retry and timeout configuration

The AI call limits are:

| Pool | Overall deadline | Per-attempt timeout | Maximum attempts |
|---|---:|---:|---:|
| Chat | 28 seconds | 10 seconds | 6 |
| STT | 40 seconds | 16 seconds | 6 |
| TTS | 45 seconds | 18 seconds | 6 |

- HTTP 500, 502, 503, and 504 are retryable with key rotation and bounded exponential backoff plus jitter.
- HTTP 429 and `RESOURCE_EXHAUSTED` honor Retry-After when supplied; otherwise they use bounded exponential backoff with jitter. A delay that cannot fit within the request deadline ends the request instead of exceeding that deadline.
- Fallback backoff starts at 250 ms, grows exponentially, and is capped at 5 seconds after jitter.
- HTTP 401/403 authentication or permission failures disable that key for 12 hours and rotate to another available key. `RESOURCE_EXHAUSTED` is treated as quota/rate exhaustion, not as an invalid key.
- HTTP 400 and other unclassified 4xx responses are not blindly retried.
- Each pool is a separate `KeyPool`; configured key names are `GEMINI_CHAT_KEYS`, `GEMINI_STT_KEYS`, and `GEMINI_TTS_KEYS`, with `GEMINI_API_KEY` as the existing fallback. Model overrides are `GEMINI_MODEL`, `GEMINI_STT_MODEL`, and `GEMINI_TTS_MODEL`; voice is configured by `GEMINI_TTS_VOICE`.
- SDK-level retry attempts are set to one so application-level attempt/deadline limits remain authoritative.

## Privacy-safe production log collection

1. Reproduce one failure using a test message that contains no personal information.
2. In Render logs, collect only `[gemini]` structured diagnostic records for the relevant time window, plus the timestamp and affected pool. Do not copy raw request/response bodies, webhook logs, message logs, environment values, or credential configuration.
3. Keep the JSON fields intact so attempts can be grouped by timestamp, pool, and model ID. Share the HTTP status, Google error code, sanitized error message, duration, rotation indicator, and outcome.
4. Do not expose API keys, phone numbers, CNICs, user messages, or audio data. The application logs intentionally omit raw Google error bodies because their contents are not guaranteed to be safe.

## Remaining questions

- What Google error code and sanitized provider explanation accompanied the historical 503 responses?
- Which model override, if any, was set in production at that time?
- Did the historical failures affect all three pools or only chat? The supplied excerpt only shows chat.
- Were failures correlated with a specific time window, model availability, project quota, or region?
- Can production verify that the selected STT and TTS models are enabled for the deployed credentials and support the deployed account/region? The mocked tests verify request shapes, not live model access.

These require privacy-safe production diagnostics or a controlled live request. No production credentials were used for this implementation or its tests.
