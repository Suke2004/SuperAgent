# SuperAgent Technical Requirements Document

## 1. Technology Baseline

- Expo SDK 57, React Native 0.86, React 19 with the React Compiler on, TypeScript 6
  (`strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`).
- Expo Router for navigation.
- Zustand for non-secret application state.
- Expo SQLite for local persistence and FTS5 search, switched to SQLCipher from `app.json`.
- Expo Secure Store for Android Keystore-backed API-key storage.
- FlashList for virtualized conversation transcripts.
- Marked and Refractor for Markdown and syntax highlighting.
- Reanimated and Gesture Handler for motion and gestures; `expo-blur` and
  `expo-linear-gradient` for surface treatment.
- `@expo/vector-icons` (Feather) behind a role map, never a glyph name at a call site.
- `react-native-webview` for the artifact preview and the code sandbox.
- `expo-speech` for output, `expo-speech-recognition` for input; `expo-print` and
  `expo-sharing` for generated documents; `expo-local-authentication` for the app lock;
  `expo-updates` for the OTA channel — configured *and* called: `useUpdates()` surfaces a
  pending bundle in Settings and `reloadAsync()` applies it, so the update does not sit on
  disk until the OS next kills the process.
- `expo-camera` for the in-app viewfinder, with `recordAudioAndroid: false` and
  `barcodeScannerEnabled: false` in the config plugin — the app never records video, so
  the manifest does not claim `RECORD_AUDIO` on the camera's account, and dropping the
  barcode scanner drops ML Kit from the build.
- `fflate` and `js-yaml` for reading and writing OOXML.

Deliberately not dependencies: a chart library or `react-native-svg` (charts are views
and text), an OOXML library (`fflate` plus generated XML), an audio library (the OS does
speech), `expo-media-library`, `react-native-maps`, and any accessibility package —
`AccessibilityInfo`, `AppState` and the `accessibility*` props are React Native's own, and
the screen-reader announcement at the end of a turn is one call to
`announceForAccessibility`. The connector directory is in the
same category and worth naming, because it looks like an integration and is not: the
eleven servers in `src/mcp/catalog.ts` are **bundled data**, a frozen array of URLs,
transports and auth kinds. No vendor SDK, no registry client, no network call at build or
start. Adding a connector is an entry in that array; the code path it reaches is the same
`parseServerUrl` → add-form → `useMcp` path a hand-typed URL takes.

## 2. Transport Contract

All UI and orchestration code consumes a provider-neutral transport interface. Adapters own URL construction, request shapes, streaming events, tool schemas, images/documents, system prompts, stop reasons, and optional-parameter fallback.

Anthropic transport:

- Base origin has no `/v1` suffix.
- Sends `POST /v1/messages`.
- Uses Anthropic content blocks and SSE events.
- Supports extended thinking and native document blocks where capability flags allow it.
- Owns provider-side web search, which is Anthropic-only and off by default.

OpenAI transport:

- Base URL includes `/v1`.
- Sends `POST /chat/completions` and `GET /models`.
- Uses delta events and OpenAI message/tool shapes.
- Maps `max_tokens` to `max_completion_tokens` for reasoning families when required.

Both transports use a static honest user agent, Bearer authentication, connect/idle timeouts, incremental UTF-8 decoding, SSE parsing, and bounded retry policy. `Authorization`, `x-api-key` and `User-Agent` are enforced in `buildHeaders` rather than defaulted: a profile header colliding with any of them is deleted before the real one is set.

`streamingFetch.ts` is the only module that depends on Expo's streaming fetch. Tests inject a pure fetch implementation.

## 3. Data and State Requirements

### Zustand stores

Persisted to AsyncStorage:

- `providers`: named profiles, active profile, failover state, key status/fingerprint.
- `models`: per-profile registry, discovery timestamps, capability flags, wire hints, pricing, hidden state.
- `settings`: theme, failover, diagnostics, tool permissions, speech style and rate, app lock, memory, prompt caching, and global defaults.
- `calibration`: smoothed estimator error per model, with a separate factor for tool
  manifests.

In-memory, backed by SQLite:

- `chat`: conversation projections, drafts, messages, active streams, turn orchestration.
- `skills`, `prompts`, `memory`, `projects`, `mcp`: user-authored rows, loaded on demand
  and held whole so a send does not touch the database on the turn's hot path.

Ephemeral: `queue` (offline sends), `reachability`.

Secrets are explicitly excluded from persisted slices. A persisted setting is never typed
as a narrow union — `voiceStyle` is a `string` resolved through `styleById`, because a
build that drops a style would otherwise rehydrate a value its own type calls impossible.

### SQLite schema

Tables are `conversations`, `conversation_tags`, `messages`, `usage_events`, `memories`,
`skills`, `mcp_servers`, `prompts`, `projects`, plus the `messages_fts` index and its
three synchronising triggers. Message content is stored as JSON blocks plus denormalized
text. Message sequence values are floating-point keys so inserts between messages do not
rewrite the transcript. Regeneration keeps the previous reply as a hidden variant keyed by
`turn_id`/`answers_id` rather than branching the transcript. Foreign keys, WAL,
migrations, and local-day usage aggregation are required.

`SCHEMA_VERSION` is 8, held in SQLite's `user_version`. `MIGRATIONS` is append-only and
every step must be safe to re-run, because the app can be killed mid-upgrade and the
version is only bumped once the step commits. The DDL lives in `src/db/ddl.ts` as SQL text
with no `expo-sqlite` import, so a test can build the real schema under Node's
`node:sqlite` and assert on the query plan the app ships rather than on a copy of it.

FTS5 is created outside the numbered migrations, so a build without it still gets a
working database. If unavailable, search must fall back to escaped LIKE matching,
including for CJK text that `unicode61` may not tokenize well.

No credential has a column. Bearer and OAuth tokens live in `expo-secure-store` under
`mcp.<id>`, because a database file gets backed up and copied.

### Files

Files the model writes are not in the database. They go to the app's own document
directory under a sanitised name and are referenced from a message. `src/chat/files.ts` is
the only module that writes there and the only place a copy leaves the sandbox — through
the system folder picker, with the share sheet as the fallback.

## 4. Request and Context Processing

- `ConversationConfig` stores sampling, reasoning, skills, servers, context strategy, rolling summary, and thinking visibility.
- Request construction is pure and testable.
- Context pressure is calculated against usable context after reserving output tokens, and
  includes the tool manifest — which is often the largest part of the prompt.
- Strategies are `warn`, `drop_oldest`, and `summarise`. Before dropping whole turns, the
  progressive trim ladder drops replayed reasoning and shortens long tool results.
- Claude validation blocks disabling thinking at `xhigh`/`max` and warns/errors when thinking consumes the visible-output budget.
- A project's instructions and knowledge documents are prepended to the system prompt at
  send time, fenced and labelled as source material.
- Plan mode is a gate in the tool router. A writing built-in must be listed in
  `WRITING_BUILTINS`, or plan mode will allow it.
- Pre-approved tool calls in one turn run concurrently; anything needing an approval sheet
  stays serial, because two sheets cannot share a screen.
- What a turn can do is summarised in one pure function, `summariseTools` in
  `src/chat/builtins.ts`, taking the global switches, this conversation's server and skill
  counts and the plan-mode flag as **inputs**. It does not consult the plan gate, because
  `src/chat/plan.ts` imports `builtins.ts` and the reverse would close a cycle; the
  duplicated wording is held in step by a test in `builtins.test.ts`, the one module
  allowed to import both.
- A connector entry never bypasses validation. `draftFromEntry` produces the same
  `McpServerDraft` the add form produces, and the form's `validate` — non-empty name,
  `parseServerUrl`-valid URL, unique name, both halves of every custom header — runs
  either way.

## 5. Rendering and Performance

- Parse Markdown into a closed AST before React rendering.
- Keep Refractor out of pure parsing modules; inject HAST data into the highlighter.
- Render code one non-wrapping line at a time inside horizontal scroll containers.
- Use FlashList with bottom anchoring for live streams.
- Virtualise every list of conversations, including the one inside the history drawer.
  Both go through one row builder (`src/chat/list.ts`), so headings and counts cannot
  disagree between the two views, and both declare `getItemType` — FlashList recycles by
  type, and a row kind that omits it inherits a cell shaped for the previous row. A
  drawer whose list must also pan horizontally renders through Gesture Handler's
  `ScrollView` via `renderScrollComponent`, so the pan and the scroll arbitrate as one
  gesture rather than two.
- Read the clock on mount, never in a render body. `Date.now()` in render is rejected by
  `react-hooks/purity` — including inside the render-phase state-adjustment block — so a
  component needing a fresh *now* is one that mounts when the clock should be read, with
  `useState(() => Date.now())`.
- Publish stream state at most every 60 ms (`COMMIT_INTERVAL`) rather than once per token.
- Reveal the committed buffer by chasing a fraction of the backlog — `TYPEWRITER_MS` 33,
  `TYPEWRITER_LEAD` 8, abandoning the chase past `TYPEWRITER_MAX_LAG` 400 characters —
  so a lumpy stream reads as writing rather than as slabs. Pure, and tested without a device.
- Memoize transcript rows using a caller-supplied clock.
- Keep components thin; logic belongs in pure modules or stores where it can be tested.
- Draw charts with views and text, not a canvas: at most 6 series, 40 bars, 400 points,
  each series colour clearing 3:1 against its own background and varying in lightness as
  well as hue. Anything unsupported returns `{kind: 'unsupported', why}` so the fence
  degrades to a code block with a reason rather than an empty box.
- Take every duration, curve, spring and stagger from `src/constants/animations.ts`;
  never a literal at a call site. `src/components/motion.tsx` holds the behaviour — how
  Reduce Motion is read, how a press feels, how the scene transform is shared between the
  drawer and the artifact panel — and imports almost nothing, because `ui.tsx` imports
  `Glyph` and a shared hook in either would close an import cycle.
- Under Reduce Motion, decorative motion collapses to `REDUCED_MS`; positional motion
  keeps its direction and only shortens.

## 6. Error Handling

Use typed `GatewayError` kinds: network, auth, client rejection, rate limit, server, validation, content blocked, and parameter dropped. Preserve the gateway message verbatim. Retry only network/429/5xx according to policy; do not fail over after a response has begun streaming.

Every tool outcome — success, refusal, denial, timeout — returns as a `tool_result`, so a
conversation never holds a call with no answer.

## 7. Security Requirements

- Secure-key access is isolated in `src/lib/secureKey.ts`. The module-scoped cache and the
  cached transports holding the key are dropped when the app is backgrounded, and the
  redactor is re-primed on the way back.
- The database key is a 32-byte value held only in the Keystore (`src/db/cipher.ts`). An
  existing plaintext database is converted once via `sqlcipher_export`.
- The app lock (`src/lib/appLock.ts`) is independent of encryption: the database key is not
  auth-gated, or the send queue would lose access while the device is locked.
- Untrusted markup and model-written JavaScript load only under `default-src 'none'` with
  inline style and script permitted and nothing else. Navigation away from the first
  document is refused and reported. No bridge, no network, no storage. `run_code` is
  abandoned after `RUN_TIMEOUT_MS` (5 s), with code and output capped at 20,000 characters
  each.
- An inbound intent is accepted only for a `content://` URI from a system provider;
  `file://` is refused with the reason shown, because `file:///data/data/<package>/…` can
  name the app's own encrypted database. The redirect runs before any React tree exists,
  so it is wrapped in `try`/`catch`.
- `fetch_url` re-checks the address it landed on, so a public host cannot redirect onto a
  link-local or private address.
- HTTPS only, enforced by URL validation and by the release network security config, which
  refuses cleartext and trusts system CAs only (`plugins/with-system-ca-only.js`).
- `allowWebFetch`, `allowWebSearch` and `allowRunCode` default to false.

## 8. Web Development Compatibility

The Android target uses Keystore and native SQLite. Web development uses Expo SQLite's WASM asset through `metro.config.js`; there is no browser Keystore, so on web a key lives in process memory for the session and nowhere else — deliberately not `localStorage`, which any injected script can read and which survives the tab closing. The cost is re-pasting the key after a refresh. Web is a development target and must not be treated as Android security.

## 9. Quality Gates

```bash
npm run gates
```

That runs typecheck, lint and coverage. The four automated gates, individually:

```text
npx tsc --noEmit
npx eslint src app
npx jest --coverage
npx expo export --platform android --output-dir .expo-export
```

The export gate's output directory is gitignored, so there is nothing to clean up
afterwards; CI runs it with exactly that flag. Coverage floors live in
`jest.config.js` (`coverageThreshold.global`) at 66 % statements, 63 % branches,
58 % functions, 68 % lines.

Jest runs in the `node` environment with `roots: ['<rootDir>/src']`, no setup file, and a
`testMatch` of `.ts` only. This is a structural constraint, not a configuration detail:
any module a test can reach must keep `react-native` out of its import graph, which is why
`saveToFolder` reaches `expo-file-system/legacy` through a dynamic `import()` and why
`files.ts` and `attach.ts` branch on whether a picker is *available* rather than on
`Platform.OS`. A `react-native` import in a tested module's graph breaks the whole suite,
not one test.

An APK build additionally requires EAS credentials:

```bash
pnpm run build:preview
```

Physical-device checks remain mandatory for streaming, Android layout behaviour, gestures,
speech, file hand-off, and anything the native surface touches — a build made before a
native module was added lacks that feature until it is rebuilt, and an OTA update cannot
cross that line. They are also the **only** way to check the accessibility surface: a
screen reader, the largest system font scale, Reduce Motion and a modal focus trap are
invisible to all four automated gates, so every label and role in the app is an assertion
until a device says otherwise. That device pass is the fifth gate, and the protocol is in
[07_Deployment.md](07_Deployment.md) §7 — 79 steps, of which 76–79 are the accessibility
group.
