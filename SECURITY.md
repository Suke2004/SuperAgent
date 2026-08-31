# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | ✅ |
| < 1.0 | ❌ |

Distribution is a direct APK. There is no OTA channel (`updates.enabled: false`), so a
security fix reaches a device only as a new build — see [docs/07_Deployment.md](docs/07_Deployment.md).

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting: the **Security** tab → **Report a
vulnerability**. That opens a private advisory visible only to the maintainers.

Please include the app version and `versionCode`, the Android version, what an attacker
gains, and a reproduction. Expect an acknowledgement within 7 days. If a fix is needed
it ships as a patch release with the advisory published on merge.

Do not include a real API key in a report. If a report needs one to reproduce, say so
and one will be arranged out of band.

## What is in scope

- The app in this repository: `app/`, `src/`, `plugins/`, `app.json`, the config plugins.
- Anything that moves a secret out of its tier (see below).
- Anything that lets untrusted content — a model reply, a skill file, an MCP tool
  result, a restored backup — reach a privileged path.

## What is out of scope

- **The gateway.** AgentRouter and any other origin a user configures are third-party
  services. The app cannot revoke a token it can only send; rotation is the gateway
  console's job.
- **MCP servers you add yourself.** An MCP server is code you chose to trust. The app
  asks for approval before a tool runs and refuses credential headers in the server
  form, but a server you approve can do what its tools do. Trust boundary documented in
  [docs/USAGE.md](docs/USAGE.md) §8.
- **A rooted or compromised device.** Every secret here rests on the Android Keystore.
- **Web (`pnpm web`).** Development target only. There is no Keystore, so keys live in
  a page variable for the session, the app says so on screen, and nothing persists.

## The security model, in short

Full detail in the "Security considerations" section of the [README](README.md#security-considerations),
[ARCHITECTURE.md](ARCHITECTURE.md) §2, and [docs/flaws.md](docs/flaws.md) §2 — which
keeps every finding, fixed or not, with the reasoning.

Three storage tiers, one rule each:

| Tier | Holds | Rule |
| --- | --- | --- |
| Android Keystore (`expo-secure-store`) | API keys, the database key | Never leaves. Not in Zustand, AsyncStorage, logs, exports, backups or git. |
| SQLite | Conversations, messages, memories, MCP rows | Encrypted at rest (SQLCipher, AES-256) under a Keystore key. Not backup-eligible: `allowBackup: false`. |
| AsyncStorage | Provider metadata, model flags, settings | Plaintext on disk. Nothing secret may be added to a `partialize` output. |

Also load-bearing:

- `Authorization`, `x-api-key` and `User-Agent` are enforced in `buildHeaders`, not
  defaulted — a profile header colliding with any of them is deleted before the real
  one is set.
- HTTPS only, enforced by the app's URL validation *and* by the platform: the release
  network security config refuses cleartext and trusts system CAs only
  (`plugins/with-system-ca-only.js`). User-installed CAs are trusted in debuggable
  builds only.
- The debug log and both export formats are redacted; exports redact twice.
- No telemetry, no analytics, no crash reporting, no WebView, no `eval`.

## Known accepted risks

Stated so a reader does not have to discover them:

- **Streamed replies stop when the app is backgrounded.** Needs a foreground service
  and therefore the bare workflow. The partial reply is kept and marked aborted.
- **No key escrow.** Clearing app data destroys the Keystore entry and the encrypted
  database with it. By design; there is no recovery path.
- **Three `pnpm audit` advisories in build tooling** (`image-size` via Metro, `uuid`
  via `xcode`). Neither package is in the app's runtime graph. Reasoning for not
  forcing a resolution: [docs/flaws.md](docs/flaws.md) §5.
- **Model-authored memories** are replayed into later system prompts. Gated behind a
  one-tap confirm the first time each is stored, and per-conversation opt-out exists.
