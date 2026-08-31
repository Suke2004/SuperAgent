# AgentRouter Mobile Architecture

## 1. System Context

```text
                  +-----------------------------+
                  |        Android / Web UI     |
                  | Expo Router screens         |
                  | Chat, settings, model UI   |
                  +--------------+--------------+
                                 |
                  +--------------v--------------+
                  |      Zustand application    |
                  | chat / providers / models   |
                  | settings                    |
                  +------+----------------+-----+
                         |                |
              +----------v-----+   +------v----------+
              | SQLite database |   | Transport layer |
              | conversations   |   | Anthropic/OpenAI|
              | messages / FTS  |   | SSE / retry     |
              +-----------------+   +--------+--------+
                                             |
                                     AgentRouter gateway
```

## 2. Layer Responsibilities

### Presentation: `app/`, `src/components/`

Screens compose settings, lists, sheets, composers, transcript rows, Markdown, and stream views. They do not know wire formats and do not hold API keys. Shared controls provide consistent disabled explanations, accessibility labels, spacing, and theme colors.

### Application state: `src/stores/`

Zustand coordinates user intent and observable state. The chat store owns the turn lifecycle: prepare, context selection/summarisation, connect, stream, save, abort, retry, and failure handling. Persisted state contains only safe metadata.

### Domain logic: `src/chat/`, `src/lib/`, `src/components/markdown/`

Pure functions validate request configuration, estimate context pressure, group/search conversations, parse Markdown, sanitize links, parse LaTeX, and format times/costs. Keeping these functions pure makes them fast to test without React Native or a gateway.

### Persistence: `src/db/`

SQLite is the source of truth for conversations and messages. `conversations.ts` owns SQL and maps rows to domain types. `schema.ts` owns migrations, WAL, foreign keys, FTS setup, and web-compatible database initialization.

### Transport: `src/transports/`

The transport boundary converts one unified `ChatRequest` into Anthropic or OpenAI requests and converts both response streams into common events. `streamingFetch.ts` is the only Expo streaming-fetch dependency; tests inject a pure fetch implementation.

### Security: `src/lib/secureKey.ts`, `src/lib/redact.ts`, `src/lib/appLock.ts`

Secure-key access is isolated from stores and UI. A module-scoped cache avoids repeated Keystore reads, and both it and the cached transports holding the key are dropped when the app is backgrounded, with the redactor re-primed on the way back. Every loaded secret is registered with the redactor, and logs are scrubbed at the write boundary. `appLock.ts` gates the app behind the device biometric or PIN when the user turns it on. The database itself is encrypted: `expo-sqlite` vendors SQLCipher and is switched to it from `app.json`, under a 32-byte key held only in the Android Keystore (`src/db/cipher.ts`, `src/db/schema.ts`), with an existing plaintext file converted once via `sqlcipher_export`. The lock and the encryption are separate controls — the key is not auth-gated, because that would deny the send queue database access while the device is locked.

## 3. Request Lifecycle

```text
User sends draft
      |
      v
Chat store loads conversation + active provider key
      |
      v
Context strategy selects messages and builds unified request
      |
      v
resolveTransport(profile, key fingerprint, wire hints)
      |
      v
Adapter sends request and parses incremental SSE/delta events
      |
      +--> network failure before first event --> bounded retry/failover
      |
      +--> event stream --> throttled stream state --> FlashList footer
      |
      v
Final usage/error/stop reason saved to SQLite
```

## 4. Data Ownership

| Data | Owner | Persistence |
|---|---|---|
| API key | Secure-key module | Android Keystore; on web, process memory for the session and nowhere else |
| Provider metadata | Providers store | AsyncStorage-safe persisted Zustand slice |
| Model flags/pricing | Models store | Persisted Zustand slice |
| Conversation/message content | SQLite module | SQLite database |
| Active draft/stream | Chat store | In memory |
| Debug log | Log module | In-memory, key-redacted |

## 5. Extension Points

- New provider formats implement the transport interface and wire-specific adapter.
- New model controls extend `SamplingParams`, `ControlKey`, validation, and adapter mappings.
- Multimodal blocks extend the unified `ContentBlock` union and each adapter’s encoder.
- Skills and MCP add tool definitions to the request builder and tool results to the chat turn loop.
- Export and backup should consume domain objects after redaction, never raw SecureStore values.

## 6. Architectural Invariants

- Never collapse the two AgentRouter base URL conventions.
- Never put API keys in Zustand, AsyncStorage, logs, or exports.
- Never estimate API-reported usage fields when the response does not provide them.
- Never retry a non-retryable 4xx or fail over after stream bytes have arrived.
- Enforce `Authorization`, `x-api-key` and `User-Agent` in `buildHeaders`, not by default ordering: a profile header that collides with any of them is deleted before the real one is set.
- Never import platform-heavy rendering or transport dependencies into pure test modules.
- Preserve React Compiler memoization and effect rules; derive values instead of silencing lint failures.

## 7. Current Boundary and Risks

Every planned phase is implemented: provider setup, model capability editing, reasoning controls, Markdown rendering, search, streaming chat, multimodal input, skills, MCP, exports, the usage dashboard and the offline queue. The app has been exercised on a physical Android device.

What is still open is listed in [docs/flaws.md](docs/flaws.md): streaming stops when the app is backgrounded (a foreground service needs the bare workflow), and live-gateway behaviour — prompt caching, document blocks, estimator accuracy — is unmeasured because the gateway rejects every request before the credential is considered. The database is no longer plaintext: SQLCipher is enabled from `app.json` under a Keystore-held key (§2 above), though the flag changes the native build and so is only trustworthy once an APK has run it on a device. `expo-speech` and `expo-local-authentication` are native modules, so an APK built before them lacks read aloud and the app lock until it is rebuilt.