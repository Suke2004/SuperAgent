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

### Security: `src/lib/secureKey.ts`, `src/lib/redact.ts`

Secure-key access is isolated from stores and UI. A module-scoped cache avoids repeated Keystore reads. Every loaded secret is registered with the redactor, and logs are scrubbed at the write boundary.

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
| API key | Secure-key module | Android Keystore; browser local storage only on web fallback |
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
- Never import platform-heavy rendering or transport dependencies into pure test modules.
- Preserve React Compiler memoization and effect rules; derive values instead of silencing lint failures.

## 7. Current Boundary and Risks

The current implementation has completed foundation and core-chat phases, with provider setup, model capability editing, reasoning controls, Markdown rendering, search, and streaming chat in place. Multimodal input, skills, MCP, exports, usage dashboard, and offline queue remain planned extensions. Physical Android verification and EAS APK production are external release gates, not guaranteed by unit tests alone.
