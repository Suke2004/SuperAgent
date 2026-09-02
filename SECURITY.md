# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | ✅ |
| < 1.0 | ❌ |

Distribution is a direct APK. An EAS Update channel is enabled (`updates.enabled: true`,
channels `preview` and `production`), so a **JavaScript-only** security fix can reach a
device without a reinstall. Anything touching a native module, a config plugin or
`app.json` cannot: an update is scoped to the `runtimeVersion` the APK was built with,
so it ships as a new build — see [docs/07_Deployment.md](docs/07_Deployment.md).

**How long a fix takes to take effect.** A published bundle is downloaded on the next
launch and applied on the next *cold* start, which for an app the user never fully closes
can be days. Settings shows an *Update → Restart to finish updating* row while a
downloaded bundle is waiting, so applying it is a single deliberate tap instead of a wait
for the OS to reclaim the process. When we publish a fix for a reported vulnerability, that
row is the fastest route to being on the fixed version; restarting the app by hand does the
same thing.

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
  result, a restored backup, a file handed in by another app — reach a privileged path.
- Anything that escapes the WebView sandbox that renders artifacts and runs `run_code`,
  or that widens its content security policy.
- Anything that gets an inbound intent to open a path inside the app's own sandbox.

## What is out of scope

- **The gateway.** AgentRouter and any other origin a user configures are third-party
  services. The app cannot revoke a token it can only send; rotation is the gateway
  console's job.
- **MCP servers you add yourself.** An MCP server is code you chose to trust. The app
  asks for approval before a tool runs and refuses credential headers in the server
  form, but a server you approve can do what its tools do. Trust boundary documented in
  [docs/USAGE.md](docs/USAGE.md) §15.
- **The servers in the connector directory.** The eleven entries in `src/mcp/catalog.ts`
  are addresses other people operate, recorded as they stood in May 2026. Nothing in the
  list is vetted or recommended by this project, tapping one only fills in the add form,
  and the same approval gate applies to a server that arrived from the list as to one you
  typed. A URL in the list that now points somewhere else is a stale entry — report it as
  a bug in the data, not as a vulnerability in the app.
- **Content a model asks the app to render.** A chart spec, an HTML artifact and a
  `run_code` program are all model output. They are contained rather than trusted: a
  chart is drawn with views and text and cannot execute, and the other two run in a
  WebView with no network, no storage and no bridge. A report that one of them *escaped*
  its container is in scope; a report that a model wrote something silly is not.
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

A fourth store exists and is deliberately not a tier: files the model writes go to the
app's document directory in plaintext, inside the same sandbox, removed with the app.
They are not backup-eligible either, and a copy the user saves to a folder is outside all
of it by their own choice. `src/chat/files.ts` is the only module that writes there.

Also load-bearing:

- `Authorization`, `x-api-key` and `User-Agent` are enforced in `buildHeaders`, not
  defaulted — a profile header colliding with any of them is deleted before the real
  one is set.
- HTTPS only, enforced by the app's URL validation *and* by the platform: the release
  network security config refuses cleartext and trusts system CAs only
  (`plugins/with-system-ca-only.js`). User-installed CAs are trusted in debuggable
  builds only.
- **Inbound files are refused, not sanitised.** An "open with" intent is accepted only
  when it carries a `content://` URI from a system provider. A `file://` path is refused
  with the reason shown, because `file:///data/data/<package>/…` can name this app's own
  private storage, including the encrypted database. The redirect runs before any React
  tree exists, so a throw there would be a blank app; it is wrapped accordingly.
- **The WebView is sealed.** Artifact previews and `run_code` load under
  `default-src 'none'` with only inline style and script permitted, navigation away from
  the first document is refused and reported, there is no bridge back into the app, and
  a `run_code` program is abandoned after five seconds. The engine that runs model
  output is deliberately not the engine holding the keys. `run_code` and `fetch_url` are
  off by default; web search is off by default and Anthropic-only.
- **`fetch_url` re-checks the address it landed on**, so a public host cannot redirect
  the fetch onto a link-local or private address.
- The debug log and both export formats are redacted; exports redact twice.
- No telemetry, no analytics, no crash reporting, no `eval`.

## Known accepted risks

Stated so a reader does not have to discover them:

- **Streamed replies stop when the app is backgrounded.** Needs a foreground service
  and therefore the bare workflow. The partial reply is kept and marked aborted.
- **No key escrow.** Clearing app data destroys the Keystore entry and the encrypted
  database with it. By design; there is no recovery path.
- **An update channel is remote-code trust**, accepted because it is the only route a
  JavaScript security fix has to a device that installed an APK by hand. Mitigations
  taken rather than assumed: the channel is signed by Expo, the `runtimeVersion` policy
  is `appVersion` so an update cannot cross a native boundary, and
  `fallbackToCacheTimeout: 0` means a slow or hostile network delays nothing and falls
  back to the bundle already on the device. **`expo-updates` code signing is still not
  configured** — the mitigations bound the blast radius, but the channel's integrity is
  the EAS account's until it is. It is the one open item on
  [docs/flaws.md](docs/flaws.md) §4. The in-app *Restart to finish updating* row does not
  widen this: it applies a bundle `expo-updates` already downloaded, and cannot check,
  choose or fetch one.
- **Untrusted text enters the context window** from tool results, fetched pages, search
  results, skill files, project knowledge documents and files handed in by other apps.
  The app cannot make a model ignore an instruction embedded in one. What it does
  instead: the writers are gated behind approval, `fetch_url`, `run_code` and web search
  are off by default, knowledge documents are fenced and labelled as source material,
  and nothing the model returns is executed outside the sandbox.
- **Three `pnpm audit` advisories in build tooling** (`image-size` via Metro, `uuid`
  via `xcode`). Neither package is in the app's runtime graph. Reasoning for not
  forcing a resolution: [docs/flaws.md](docs/flaws.md) §5.
- **Model-authored memories** are replayed into later system prompts. Gated behind a
  one-tap confirm the first time each is stored, and per-conversation opt-out exists.
- **`RECORD_AUDIO` is declared** and now has a feature behind it: hold-to-talk dictation
  and voice mode. Recognition uses the OS service, on-device where the OS offers it, and
  the app neither records to a file nor uploads audio itself.
- **`CAMERA` is declared** and has two features behind it: the gallery picker's retired
  hand-off is gone, and `expo-camera` draws a viewfinder in the app. A shot is a JPEG in
  this app's own cache and nothing else — it is not written to the media library (no
  `expo-media-library`, no storage permission), it is not encoded until the user presses
  *use*, and closing the camera deletes every shot that was not used. `recordAudioAndroid`
  is `false`, so the camera claims no microphone of its own, and `barcodeScannerEnabled`
  is `false`, so ML Kit is not in the APK. One config hazard worth naming because no gate
  catches it: `cameraPermission: false` on the `expo-image-picker` plugin would call
  `withBlockedPermissions` and strip `CAMERA` from the merged manifest, silently breaking
  the viewfinder. The key is absent, not `false`.
