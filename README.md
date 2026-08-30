# AgentRouter Mobile

An offline-first Expo Android chat client for AgentRouter and other compatible gateways. Conversations, model flags, usage data, and diagnostics stay on the device; API keys are stored only in Android Keystore via `expo-secure-store`.

Day-to-day operation is a separate document: [docs/USAGE.md](docs/USAGE.md).
Before changing anything here, read [docs/GUIDELINES.md](docs/GUIDELINES.md) — the
contributing rules, the storage and secret boundaries, and what must not be silently
undone.

## Setup

```bash
pnpm install
```

```bash
npx expo start
```

Open Settings → Providers. AgentRouter is the default setup: choose Anthropic or OpenAI, paste the gateway token, and save. For another compatible gateway choose Custom URL and enter its origin and token. The selected transport normalises `/v1` automatically.

The two AgentRouter endpoints are intentionally different, and are **not** interchangeable:

- Anthropic: `https://agentrouter.org` (**no** `/v1`) → `POST /v1/messages`
- OpenAI: `https://agentrouter.org/v1` → `POST /v1/chat/completions` and `GET /v1/models`

They diverge on message shape, system-prompt placement, image encoding, streaming events, tool schema and stop reasons. All of that lives in the adapters; none of it belongs in a screen.

## Architecture

| Layer | What lives there |
| --- | --- |
| `app/` | Expo Router screens. Deliberately thin: `jest.config.js` matches `*.test.ts` only, so logic in a component is logic no test can reach. |
| `src/components/` | UI primitives (`ui.tsx`), the markdown/highlighting renderer, chat views. |
| `src/chat/` | Pure turn logic: request building and validation, trimming, budgeting, attachments, skills, prompts, export, backup, speech. |
| `src/stores/` | Zustand state, persisted to AsyncStorage. Never the key. |
| `src/db/` | SQLite. All DDL is plain SQL in `ddl.ts` with no `expo-sqlite` import, so tests build the real schema under `node:sqlite`. |
| `src/transports/` | Anthropic and OpenAI adapters behind one streaming interface. `fetch` is injected, which is what lets the whole layer be tested in plain Node. |
| `src/mcp/` | Hand-rolled JSON-RPC client, protocol parsing, OAuth hand-off. |
| `src/lib/` | Token estimation, redaction, secure key access, the app lock, logging. |

Gates, all four of which CI runs on every push:

```bash
pnpm gates
```

`pnpm gates` is typecheck + lint + tests with coverage thresholds. CI adds `expo export --platform android`, a full Metro bundle whose output is discarded — the other three structurally cannot see a broken screen.

Build a preview APK with:

```bash
pnpm run build:apk
```

`expo-speech` (read aloud) and `expo-local-authentication` (the app lock) are native modules, so a device running an APK built before they were added needs a rebuild before those two features exist.

## Adding a provider

Settings → Providers → Custom URL. Pick the wire format, enter the provider origin, save the key, then run Test connection — it reports the base URL shape, model discovery, a one-token completion, and whether the gateway serves image generation, each as its own step with the gateway's own error text. Model discovery is runtime-driven; capability flags, context limits, and pricing can be corrected under Settings → Models, and hand edits are never overwritten by a later discovery.

Adding a *transport* rather than a profile means a new adapter in `src/transports/` implementing the same interface, plus an entry in `TRANSPORT_SUPPORT` whose values are the reason a feature is unsupported.

## Security posture

- The key never reaches source, logs, AsyncStorage, git or any Zustand state — `expo-secure-store` plus an in-memory cache read at request time. Both that cache and the cached transports holding it are dropped when the app goes to the background, and the redactor is re-primed from the Keystore on the way back.
- On web there is no Keystore, so keys live in memory for the session and nowhere else. `localStorage` is deliberately not used, which means re-pasting after a refresh.
- `Authorization`, `x-api-key` and `User-Agent` are enforced at the one point every request passes through, not merely defaulted: a profile header that collides with any of them is dropped before the real one is set.
- The debug log and both export formats are redacted; exports redact twice, and a test greps the finished artefact rather than asserting a call site.
- Exports never carry attachment bytes. Backups never carry keys, tokens, conversations or memories.
- Android auto-backup is off, so the transcript database is not eligible for Google Drive or `adb backup`.
- OTA updates are disabled (`updates.enabled: false`). Nothing here publishes one, so an enabled channel would be trust with no use.
- The whole SQLite database is encrypted — SQLCipher via `expo-sqlite`, AES-256, under a 32-byte key held only in the Android Keystore. An existing plaintext file is converted once on first launch. Clearing app data destroys the key and the conversations with it; there is no escrow.
- Settings → Privacy → **Require unlock to open** gates the app behind the device biometric or PIN. Off by default, and a separate control from the encryption above: the database key is not auth-gated, because that would deny the offline send queue access while the device is locked.
- No telemetry, no analytics, no third-party crash reporting.
- The User-Agent is honest and static (`AgentRouterMobile/1.0 (Android)`). Impersonating another client to get past a gateway's allowlist is a bannable offence and is not done here.

`pnpm audit` currently reports three advisories, all in build tooling (Metro's `image-size`, `xcode`'s `uuid`) that never ships to the device. Details and the reasoning for not overriding them are in [docs/flaws.md](docs/flaws.md) §5.

Known flaws and unverified areas are tracked in [docs/flaws.md](docs/flaws.md) and the "Known gaps" section of [progress.md](progress.md).
