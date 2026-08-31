# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), interpreted for a client
app in [docs/07_Deployment.md](docs/07_Deployment.md) §2.1.

Distribution is a direct APK. There is no OTA channel (`updates.enabled: false`), so
every entry below reaches a device only as a new install.

## [Unreleased]

Nothing yet.

## [1.0.0] — 2026-08-31

First release. Everything below is the initial feature set rather than a diff.

### Added

- **Chat** — streaming conversations against AgentRouter or any compatible gateway,
  over both the Anthropic (`/v1/messages`) and OpenAI (`/v1/chat/completions`) wire
  formats, behind one transport interface.
- **Providers** — multiple provider profiles, custom origins, per-profile extra
  headers, and a Test-connection flow that reports base-URL shape, model discovery, a
  one-token completion and image-generation support as separate steps with the
  gateway's own error text.
- **Models** — runtime model discovery with hand-editable capability flags, context
  limits and pricing; hand edits are never overwritten by a later discovery.
- **Reasoning controls** — thinking budgets, sampling parameters, stop sequences.
- **Markdown rendering** — syntax-highlighted code blocks, tables, LaTeX, link
  sanitisation through a scheme allowlist.
- **Attachments** — images from camera or library, and documents.
- **Context management** — pressure indicators, per-message exclusion, rolling
  summarisation, and a token budget that does not double-count thinking.
- **Skills** — Markdown skill files with YAML frontmatter, importable as `.zip`.
- **MCP** — hand-rolled JSON-RPC client over HTTP/SSE, OAuth hand-off, per-tool
  approval before execution.
- **Memory** — model-distilled durable facts, replayed into later system prompts,
  behind a per-memory confirm gate and a per-conversation opt-out.
- **Search** — SQLite FTS5 across conversations and messages.
- **Offline queue** — a turn that fails on a dead network is queued and retried when
  the gateway is next known to be reachable.
- **Usage dashboard** — token and cost accounting from gateway-reported usage only.
- **Export and backup** — Markdown and JSON export, both redacted twice; settings
  backup that carries no keys, tokens, conversations or memories.
- **Accessibility** — screen-reader labels, disabled-state explanations, read aloud
  via `expo-speech`.
- **Privacy** — optional app lock behind the device biometric or PIN.

### Security

- API keys live only in the Android Keystore via `expo-secure-store`, cached in memory
  for request time and dropped when the app is backgrounded.
- The SQLite database is encrypted at rest — SQLCipher, AES-256, under a 32-byte key
  held only in the Keystore. An existing plaintext file is converted once on first
  launch.
- Android auto-backup is disabled, so the transcript database is not eligible for
  Google Drive or `adb backup`.
- `Authorization`, `x-api-key` and `User-Agent` are enforced at the single point every
  request passes through, not defaulted.
- HTTPS only; the release network security config refuses cleartext traffic and trusts
  system CAs only. User-installed CAs are trusted in debuggable builds only.
- OTA updates disabled.
- No telemetry, no analytics, no crash reporting.

### Known issues

- Streamed replies stop when the app is backgrounded. Needs a foreground service and
  therefore the bare workflow; the partial reply is kept and marked aborted.
- Live gateway behaviour is unverified: `agentrouter.org` currently returns
  `unauthorized_client_error` to every request including unauthenticated ones, which
  fires before the credential is considered ([docs/flaws.md](docs/flaws.md) §1).
- Database encryption changes the native build and has not yet been confirmed on a
  device running a release APK. A local `assembleRelease` was attempted and blocked by
  host-toolchain problems only ([docs/flaws.md](docs/flaws.md) §6); EAS Build is the
  documented release path.
- No key escrow. Clearing app data destroys the Keystore entry and the encrypted
  database with it.
- Three `pnpm audit` advisories in build tooling that never ships to the device
  ([docs/flaws.md](docs/flaws.md) §5).

### Release facts

| | |
| --- | --- |
| Version | 1.0.0 |
| `versionCode` | 1 |
| Android package | `org.lyric.agentrouter` |
| Android SDK | min 24, target 36, compile 36 |
| Expo SDK | 57 |
| React Native | 0.86.3 |
| Build profile | `preview` (APK, internal distribution) |
