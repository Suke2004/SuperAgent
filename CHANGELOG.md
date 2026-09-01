# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), interpreted for a client
app in [docs/07_Deployment.md](docs/07_Deployment.md) §2.1.

Distribution is a direct APK, with EAS Update enabled (`updates.enabled: true`, the
`preview` and `production` channels in [eas.json](eas.json)). A JavaScript-only entry
can therefore reach a device as an update; anything touching a native module cannot,
and is marked **needs a rebuild** below.

## [Unreleased]

### Added

- **Word, Excel and PowerPoint attachments** — a `.docx`, `.xlsx` or `.pptx` is read
  on device into text and sent like any other document: paragraphs from a Word file,
  tab-separated cells per named sheet from a workbook, one section per slide from a
  deck. Project knowledge documents accept the same three. No new dependency — an
  Office file is a zip of XML and `fflate` was already here — so no rebuild is needed.
  The composer says what the format loses: layout, styling, images and cell formats.
- **Slash commands** — `/` in the composer opens one list over prompt templates,
  skills, MCP prompts and app commands. Templates with `{{variables}}` open the fill
  form; MCP prompts are fetched with `prompts/get` and inserted as text.
- **Built-in tools** — `write_file`, `create_pdf`, `fetch_url` and
  `read_mcp_resource`, so the model can produce a file and read a page without an MCP
  server in between. `fetch_url` is off until switched on in Settings.
- **Document generation** — Markdown, text, CSV and JSON files written to the app's
  own directory, plus PDF through the platform renderer, each surfaced in the
  transcript with Share and Open. **Needs a rebuild** (`expo-print`, `expo-sharing`).
- **Voice input** — hold the microphone to dictate. The transcript lands in the draft
  as editable text rather than being sent. Declares `RECORD_AUDIO` and the
  speech-recognition permission strings. **Needs a rebuild**
  (`expo-speech-recognition`).
- **`@`-mentions** — `@` in the composer offers generated files, installed skills and
  connected MCP servers over the same index and ranking as `/`. A file mention attaches
  through the picker's own admission path, size ceiling included.
- **Web search** — on Anthropic profiles the model can search the web on the
  provider's side, with the query and the pages it found shown under the reply and each
  source openable. Off by default: it is billed per search, and search results are
  untrusted text entering the context window.
- **Plan mode** — a per-conversation toggle in the conversation menu. Reading still
  works, so the plan is built on what is actually there; writing a file, rendering a
  document and every connected MCP tool are refused with an instruction to write out
  the steps instead. The refusal is a gate in the tool router, not a line in the
  system prompt, so a tool added later inherits it.
- **Citations** — where a provider says which page a sentence came from, the sources
  appear under the answer and open in the browser through the same allowlist as a
  markdown link. An export keeps them, with the quoted passage.
- **Projects** — a project groups conversations around one piece of work and lends all
  of them a set of instructions and reference documents. Managed in Settings →
  Projects, joined or left from a conversation's `⋯` menu, and used as a filter on the
  conversation list, where a new chat inherits whichever project is showing. The
  documents are sent as source material under their own heading, with an explicit note
  that directions written inside them are not instructions to follow. Conversations
  outlive their project: deleting one unfiles its chats and keeps them.
- **Artifacts** — an `html` or `svg` code fence gets a **Preview** button that renders
  it full screen. The document is served under `default-src 'none'` with only inline
  style and script allowed, so an interactive chart works and a hostile one has nowhere
  to send anything; the first navigation is the document itself and every later one is
  refused and reported. No new message type, so replies already in the transcript get
  the button too. **Needs a rebuild** (`react-native-webview`).
- **Analysis tool** — `run_code`, off until switched on in Settings → Built-in tools.
  JavaScript runs in a WebView of its own with no network, no storage and no bridge
  into the app, `console.log` captured and the last expression's value returned. For
  arithmetic, parsing and sorting the model would otherwise guess at. It is not a
  shell, and a program that loops is given up on after five seconds rather than being
  left to stall the turn. **Needs a rebuild** (`react-native-webview`).

### Changed

- The app is now called **SuperAgent** everywhere, from one constant
  ([src/lib/app.ts](src/lib/app.ts)). The slug, Android package and URL scheme are
  unchanged on purpose — changing them would orphan installs and OAuth redirects.
- Tool manifests are now fitted to a token budget, and the transcript says when tools
  were withheld rather than only the system prompt.
- Pre-approved tool calls in one turn run concurrently; calls that need an approval
  sheet stay serial.
- A turn stopped by the tool-round cap offers **Continue** instead of asking for the
  message to be sent again.

### Fixed

- The tool manifest was left out of the turn's history budget entirely — `planTurn` was
  written to count it and was never handed it — so a conversation with two chatty MCP
  servers planned its history against a prefix tens of thousands of tokens smaller than
  the one that went on the wire. Tool definitions are now counted, and corrected by
  their own measured factor rather than the one derived from prose.

- Image and audio content returned by an MCP tool reached the model as the sentence
  "[image: …, not shown]". It is now passed through as a real image block on
  transports that accept one.
- A tool call whose arguments were truncated mid-stream is refused with a result that
  says so, instead of being sent to the server as `{ "__unparsed": … }` — a schema
  error the model cannot read as "your last call was cut off".
- Glyph buttons no longer drift out of their discs at large system font sizes.
- `fetch_url` re-checks the address it *landed* on, so a public host cannot redirect the
  fetch onto a link-local or private address.
- A server offering hundreds of resources showed only the first 20 with no sign there
  were more; the section now counts them and opens in full on request.

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
