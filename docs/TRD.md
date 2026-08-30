# AgentRouter Mobile Technical Requirements Document

## 1. Technology Baseline

- Expo SDK 57, React Native 0.86, React 19, TypeScript 6.
- Expo Router for navigation.
- Zustand for non-secret application state.
- Expo SQLite for local persistence and FTS5 search.
- Expo Secure Store for Android Keystore-backed API-key storage.
- FlashList for virtualized conversation transcripts.
- Marked and Refractor for Markdown and syntax highlighting.

## 2. Transport Contract

All UI and orchestration code consumes a provider-neutral transport interface. Adapters own URL construction, request shapes, streaming events, tool schemas, images/documents, system prompts, stop reasons, and optional-parameter fallback.

Anthropic transport:

- Base origin has no `/v1` suffix.
- Sends `POST /v1/messages`.
- Uses Anthropic content blocks and SSE events.
- Supports extended thinking and native document blocks where capability flags allow it.

OpenAI transport:

- Base URL includes `/v1`.
- Sends `POST /chat/completions` and `GET /models`.
- Uses delta events and OpenAI message/tool shapes.
- Maps `max_tokens` to `max_completion_tokens` for reasoning families when required.

Both transports use a static honest user agent, Bearer authentication, connect/idle timeouts, incremental UTF-8 decoding, SSE parsing, and bounded retry policy.

## 3. Data and State Requirements

### Zustand stores

- `providers`: named profiles, active profile, failover state, key status/fingerprint.
- `models`: per-profile registry, discovery timestamps, capability flags, wire hints, pricing, hidden state.
- `chat`: conversation projections, drafts, messages, active streams, turn orchestration.
- `settings`: theme, failover, diagnostics, and global defaults.

Secrets are explicitly excluded from persisted slices.

### SQLite schema

Tables include `conversations`, `conversation_tags`, `messages`, and `usage_events`. Message content is stored as JSON blocks plus denormalized text. Message sequence values are floating-point keys so inserts between messages do not rewrite the transcript. Foreign keys, WAL, migrations, and local-day usage aggregation are required.

FTS5 is preferred. If unavailable, search must fall back to escaped LIKE matching, including for CJK text that `unicode61` may not tokenize well.

## 4. Request and Context Processing

- `ConversationConfig` stores sampling, reasoning, skills, servers, context strategy, rolling summary, and thinking visibility.
- Request construction is pure and testable.
- Context pressure is calculated against usable context after reserving output tokens.
- Strategies are `warn`, `drop_oldest`, and `summarise`.
- Claude validation blocks disabling thinking at `xhigh`/`max` and warns/errors when thinking consumes the visible-output budget.

## 5. Rendering and Performance

- Parse Markdown into a closed AST before React rendering.
- Keep Refractor out of pure parsing modules; inject HAST data into the highlighter.
- Render code one non-wrapping line at a time inside horizontal scroll containers.
- Use FlashList with bottom anchoring for live streams.
- Publish stream state at most every 60 ms rather than once per token.
- Memoize transcript rows using a caller-supplied clock.
- Keep components thin; logic belongs in pure modules or stores where it can be tested.

## 6. Error Handling

Use typed `GatewayError` kinds: network, auth, client rejection, rate limit, server, validation, content blocked, and parameter dropped. Preserve the gateway message verbatim. Retry only network/429/5xx according to policy; do not fail over after a response has begun streaming.

## 7. Web Development Compatibility

The Android target uses Keystore and native SQLite. Web development uses Expo SQLite's WASM asset through `metro.config.js`; there is no browser Keystore, so on web a key lives in process memory for the session and nowhere else — deliberately not `localStorage`, which any injected script can read and which survives the tab closing. The cost is re-pasting the key after a refresh. Web is a development target and must not be treated as Android security.

## 8. Quality Gates

```text
npx tsc --noEmit
npx eslint src app
npx jest --runInBand
npx expo export --platform web
pnpm run build:apk
```

The APK gate requires EAS credentials and a successful preview build. Physical-device checks remain mandatory for streaming and Android layout behavior.
