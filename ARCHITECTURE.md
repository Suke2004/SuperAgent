# SuperAgent Architecture

The app is called SuperAgent from one constant (`src/lib/app.ts`). The package slug
`agentrouter-mobile`, the Android package `org.lyric.agentrouter` and the `jarvis://`
URL scheme keep their original values: those are identity rather than presentation, and
changing them orphans installs and OAuth redirects.

## 1. System Context

```text
     +---------------+          +--------------------------------+
     | Android OS    |          |        Android / Web UI        |
     | intents (VIEW)+--------->+ Expo Router screens            |
     | TTS engine    |content:// | chat, settings, voice mode     |
     | speech-to-text|<---------+ markdown, charts, terminal     |
     | camera        |          | camera viewfinder              |
     +---------------+          +----+----------------------+----+
                                     |                      |
                                     |            +---------v---------+
                                     |            | WebView sandbox   |
                                     |            | artifacts,run_code|
                                     |            | default-src 'none'|
                                     |            +-------------------+
                  +------------------v-----------+
                  |      Zustand application     |
                  | chat / providers / models    |
                  | mcp / projects / settings    |
                  +---+---------+--------+-------+
                      |         |        |
        +-------------v--+ +----v-----+ +v----------------+
        | SQLite database| | Files    | | Transport layer |
        | conversations  | | generated| | Anthropic/OpenAI|
        | messages / FTS | | documents| | SSE / retry     |
        +----------------+ +----------+ +--------+--------+
                                                 |
                                         AgentRouter gateway
                                         MCP servers (HTTPS)
```

## 2. Layer Responsibilities

### Presentation: `app/`, `src/components/`

Screens compose settings, lists, sheets, composers, transcript rows, Markdown, charts, terminal output, artifact previews, the voice-mode and camera modals, and stream views. They do not know wire formats and do not hold API keys. Shared controls provide consistent disabled explanations, accessibility labels, spacing, and theme colors.

Three cross-cutting pieces live here rather than in a screen, because a screen-local copy is how they diverge:

- **`src/constants/animations.ts`** is the whole vocabulary of motion — every duration, curve, spring, stagger and scale the app is allowed to use. Nothing invents one locally. `src/components/motion.tsx` holds the behaviour that goes with those numbers: how Reduce Motion is read, how a press feels, how the scene transform is shared between the drawer and the artifact panel. It imports almost nothing on purpose — `ui.tsx` imports `Glyph`, so a hook exported from either for the other would close an import cycle.
- **`src/components/Icon.tsx`** is a role map, not a re-export. A caller names `send`, never `arrow-up`, so the family is swappable in one file and the same idea cannot pick a different picture on another screen. Icons do not scale with the system font: a glyph in a fixed 36dp disc that grows clips against it, and everything the icon *means* is on the accessibility label of the control around it, which does scale.
- **`src/theme/`** owns the palette and, separately, `SERIES` — six chart colours per scheme, each clearing 3:1 against its own background and varying in lightness as well as hue. Deliberately not palette tokens: a `Palette` key is something any component may reach for, and these six are only ever a chart's series.

### Application state: `src/stores/`

Zustand coordinates user intent and observable state. The chat store owns the turn lifecycle: prepare, context selection/summarisation, connect, stream, resolve tool calls, save, abort, retry, and failure handling. Persisted state contains only safe metadata.

### Domain logic: `src/chat/`, `src/lib/`, `src/components/markdown/`

Pure functions validate request configuration, estimate context pressure, group/search conversations, parse Markdown, sanitize links, parse LaTeX, read and write OOXML, script a spoken reply, cycle a camera's flash and count its remaining attachment slots, label a tool call, decide how a generated file should be previewed, admit or refuse an inbound file, and format times/costs. Keeping these functions pure makes them fast to test without React Native or a gateway.

This is not a preference, it is enforced by the test setup. Jest runs in the `node` environment with no setup file and `testMatch` of `*.test.ts` only, so any module a test can reach must keep `react-native` out of its import graph. Two consequences worth knowing before adding code: `src/chat/files.ts` reaches `expo-file-system/legacy` through a dynamic `import()` rather than a top-level one, and `src/chat/attach.ts` branches on whether a picker is *available* rather than on `Platform.OS`. The pattern that falls out of it is a pure `.ts` module paired with a thin `.tsx` view — `voice.ts`/`VoiceMode.tsx`, `camera.ts`/`CameraMode.tsx`, `chart.ts`/`ChartView.tsx`, `preview.ts`/`FilePreview.tsx`, `toolLabel.ts`/`ContentBlocks.tsx`, `office.ts`+`ooxml.ts`/`FilePreview.tsx`, `incoming.ts`/`+native-intent.tsx`, `attachments.ts`/`attach.ts`, `list.ts`/`Sidebar.tsx`. `camera.ts`/`CameraMode.tsx` shows the split's limit as clearly as its value: the flash cycle and the slot arithmetic are unit-tested, and nothing on a Node runner can tell you whether the preview is upright.

`list.ts` shows the other edge of the same rule: the drawer and the conversation list are two views over **one** row builder, so "Older · 34" cannot mean different things in the two places, and the one behaviour the drawer does differently — dropping the group headings while a search is running — is a function with tests (`drawerRows`) rather than a ternary in JSX. When a component needs a decision, the decision moves here and the component keeps the hooks.

`src/lib/notify.ts` is the same split applied to something that is not a screen at all: what the app says when a turn ends *and the transcript cannot say it*. It exports two pure functions over one input — `replyNotice`, the notification body for a turn that finished while the app was away, and `replyAnnouncement`, the screen-reader utterance for one that finished while it was in front of you — and one impure `notifyReplyReady` that reads `AppState` **once** and dispatches whichever of the two applies. Both refuse the same three turns (aborted, empty, wrong side of `foreground`), which makes their mutual exclusion a property a test can state: exactly one speaks per turn. The single `AppState` read is the point of the arrangement; two call sites asking the same question is how a user ends up with both a banner and a voice, or with neither.

### Persistence: `src/db/`, `expo-file-system`

SQLite is the source of truth for conversations and messages, and for everything else the user authors: `conversations`, `conversation_tags`, `messages`, `messages_fts`, `usage_events`, `memories`, `skills`, `mcp_servers`, `prompts` and `projects`. `conversations.ts` owns SQL and maps rows to domain types. `schema.ts` owns WAL, foreign keys, FTS setup and web-compatible initialization; the DDL itself lives in `ddl.ts` as SQL text with no `expo-sqlite` import, so a test can build the real schema under Node's `node:sqlite` and assert on the query plan the app actually ships. `SCHEMA_VERSION` is 8 and `MIGRATIONS` is append-only — editing a landed step changes the schema of databases that already ran it.

FTS is created outside the numbered migrations on purpose: a failed `CREATE VIRTUAL TABLE` inside migration 0 would roll back the tables the app cannot run without, so a build without FTS5 still gets a working database and falls back to escaped `LIKE`.

Files the model produces are not in the database. They are written to the app's own document directory under a sanitised name and referenced from a message; `src/chat/files.ts` is the only module that writes there, and it is also the only place a copy leaves the sandbox — through the system folder picker, with the share sheet as the fallback when no folder is granted.

### Transport: `src/transports/`

The transport boundary converts one unified `ChatRequest` into Anthropic or OpenAI requests and converts both response streams into common events. `streamingFetch.ts` is the only Expo streaming-fetch dependency; tests inject a pure fetch implementation.

### Tools: `src/chat/builtins.ts`, `src/chat/plan.ts`, `src/mcp/`

Tools reach the model from two places and are resolved in one. Built-ins (`write_file`, `create_pdf`, `create_document`, `fetch_url`, `read_mcp_resource`, `run_code`, plus provider-side web search) are pure argument parsers plus a branch in the chat store's router; MCP tools arrive from servers the user added. Plan mode is a gate in that router rather than a line in the system prompt, so a tool added later inherits the refusal without being told about it.

`src/mcp/catalog.ts` sits beside the client and is the one file here that talks to nothing: eleven well-known servers as a frozen array of slugs, URLs, transports and auth kinds — **bundled data, not a registry client**. No vendor SDK, no network call at build or at start. It ends at `draftFromEntry`, which returns the same `McpServerDraft` the add form produces, so the directory is a shortcut into that form rather than a second way to create a server.

What a turn can actually do is one pure function, `summariseTools`, taking the three global switches plus this conversation's server and skill counts and the plan-mode flag as **inputs**. It cannot ask the plan gate, because `plan.ts` imports `builtins.ts` and the reverse would close a cycle; the wording it duplicates is held in step by a tripwire in `builtins.test.ts`, the one module allowed to import both. Where a cycle forces two modules to know the same thing, the test that can see both is the only place the agreement can live.

### Security: `src/lib/secureKey.ts`, `src/lib/redact.ts`, `src/lib/appLock.ts`

Secure-key access is isolated from stores and UI. A module-scoped cache avoids repeated Keystore reads, and both it and the cached transports holding the key are dropped when the app is backgrounded, with the redactor re-primed on the way back. Every loaded secret is registered with the redactor, and logs are scrubbed at the write boundary. `appLock.ts` gates the app behind the device biometric or PIN when the user turns it on. The database itself is encrypted: `expo-sqlite` vendors SQLCipher and is switched to it from `app.json`, under a 32-byte key held only in the Android Keystore (`src/db/cipher.ts`, `src/db/schema.ts`), with an existing plaintext file converted once via `sqlcipher_export`. The lock and the encryption are separate controls — the key is not auth-gated, because that would deny the send queue database access while the device is locked.

Two boundaries were added with the features that needed them, and both are refusals rather than sanitisers:

- **Inbound files** (`src/chat/incoming.ts`, `app/+native-intent.tsx`). An "open with" intent is accepted only when it carries a `content://` URI from a system provider. A `file://` path is refused with a reason shown to the user, because `file:///data/data/<package>/…` can name this app's own private storage, including the encrypted database. The redirect runs before any React tree exists, so it is wrapped in a `try`/`catch` — a throw there is a blank app, not an error screen.
- **The WebView sandbox** (`src/components/ArtifactPreview.tsx`, `src/components/CodeSandbox.tsx`). Untrusted markup and model-written JavaScript load under `default-src 'none'` with only inline style and script allowed. Navigation away from the first document is refused and reported. There is no bridge back into the app, no network, no storage, and `run_code` is abandoned after five seconds. The engine that runs model output is deliberately not the engine holding the keys.

## 3. Request Lifecycle

```text
User sends draft
      |
      v
Chat store loads conversation + active provider key
      |
      v
Context strategy selects messages, tools and project knowledge,
builds unified request
      |
      v
resolveTransport(profile, key fingerprint, wire hints)
      |
      v
Adapter sends request and parses incremental SSE/delta events
      |
      +--> network failure before first event --> bounded retry/failover
      |
      +--> event stream --> throttled stream state --> revealed by
      |                     typewriter pacing --> FlashList footer
      |
      +--> tool_use blocks --> plan-mode gate --> approval sheet -->
      |    built-in or MCP call --> tool_result --> next round
      |
      v
Final usage/error/stop reason saved to SQLite
```

A tool round is not a special case of the lifecycle, it is a loop over it: every outcome, including a refusal and a denial, comes back as a tool *result*, so the conversation is never left with a call that has no answer. Pre-approved calls in one turn run concurrently; anything needing an approval sheet stays serial, because two sheets cannot share a screen.

## 4. Data Ownership

| Data | Owner | Persistence |
|---|---|---|
| API key | Secure-key module | Android Keystore; on web, process memory for the session and nowhere else |
| MCP OAuth tokens | MCP OAuth module | Android Keystore, beside the API key |
| Provider metadata | Providers store | AsyncStorage-safe persisted Zustand slice |
| Model flags/pricing | Models store | Persisted Zustand slice |
| Settings, including voice style and speech rate | Settings store | Persisted Zustand slice |
| Estimator error per model | Calibration store | Persisted Zustand slice |
| Conversation/message content | SQLite module | SQLite database |
| Projects and their knowledge documents | Projects store | SQLite (`projects`), held whole in memory |
| Skills, prompts, memories, MCP server rows | Their stores | SQLite; loaded on demand, never persisted to AsyncStorage |
| The connector directory | `src/mcp/catalog.ts` | Nowhere — a frozen array in the bundle. It is read to prefill a draft and never written to |
| Generated files | `src/chat/files.ts` | App document directory, referenced by a message |
| Attachment bytes in flight | Chat store | In memory only; never written to SQLite or an export |
| Camera shots not yet used | Camera modal | Cache files, as URIs. Encoded only when the user presses *use*; `discardShots` deletes an abandoned session's photos |
| Active draft/stream | Chat store | In memory |
| Debug log | Log module | In-memory, key-redacted |

## 5. Extension Points

- New provider formats implement the transport interface and wire-specific adapter.
- New model controls extend `SamplingParams`, `ControlKey`, validation, and adapter mappings.
- Multimodal blocks extend the unified `ContentBlock` union and each adapter's encoder.
- Skills and MCP add tool definitions to the request builder and tool results to the chat turn loop.
- New built-in tools are a name, an argument parser and a `resolveCall` branch in `src/chat/builtins.ts`. A *writing* built-in must also be listed in `WRITING_BUILTINS` (`src/chat/plan.ts`) or plan mode will allow it, and in `selectTools`' `required` set if it should survive a tight token budget.
- New icons are a role added to `ICONS`, never a Feather name at a call site.
- New motion is a constant added to `src/constants/animations.ts`, never a literal duration.
- New chart types extend `src/components/markdown/chart.ts`; anything it cannot draw must return `{kind: 'unsupported', why}` so the fence falls back to a code block with the reason, rather than an empty box.
- A new tool-step label is a verb pattern in `src/chat/toolLabel.ts`. Order matters — first match wins, and the specific pattern goes before the general one (`read_url` before `read`).
- A new generated-file behaviour is a `PreviewMode` in `src/chat/preview.ts`, decided from the filename before the file is opened.
- A new document format is an entry in `OFFICE_FORMATS` plus a writer in `src/chat/ooxml.ts`.
- A new camera control is a decision function in `src/chat/camera.ts` and a button in `CameraMode.tsx`. The flash cycle, the remaining-slot arithmetic and the status line live in the pure module so the viewfinder holds no arithmetic of its own.
- A new history row kind is a variant of `ListRow` in `src/chat/list.ts`, a branch in `buildRows`, and a `getItemType` case in both views that render it — the list screen and the drawer. FlashList recycles by type, so a kind that skips `getItemType` gets a cell shaped for the previous row.
- A new connector is an entry in `CONNECTORS` (`src/mcp/catalog.ts`) — an `id`, a name, a URL, a transport, an auth kind, one searched line of what it is *for* (`blurb`) and one of what it can *see* once connected (`reach`), plus the vendor's own docs page — and **never a code path**. The `id` is also the default server name, so it has to survive `qualifyToolName` intact. `draftFromEntry` produces the same `McpServerDraft` the add form produces, so an entry reaches the model through the same `parseServerUrl` → `validate` → approval-gate route a hand-typed URL does. Bump `CATALOG_AS_OF` when the list is re-checked; it is a knowledge cutoff, not a build date.
- Export and backup should consume domain objects after redaction, never raw SecureStore values.

## 6. Architectural Invariants

- Never collapse the two AgentRouter base URL conventions.
- Never put API keys in Zustand, AsyncStorage, logs, or exports.
- Never estimate API-reported usage fields when the response does not provide them.
- Never retry a non-retryable 4xx or fail over after stream bytes have arrived.
- Enforce `Authorization`, `x-api-key` and `User-Agent` in `buildHeaders`, not by default ordering: a profile header that collides with any of them is deleted before the real one is set.
- Never import platform-heavy rendering or transport dependencies into pure test modules. `react-native` in a tested module's import graph breaks the whole suite, not one test.
- Preserve React Compiler memoization and effect rules; derive values instead of silencing lint failures.
- Never accept a `file://` URI from outside the app. Only `content://` from a system provider.
- Never load untrusted markup or model-written code anywhere but the sealed WebView, and never widen its CSP to make something render.
- Never hardcode a duration, a colour or an icon name at a call site. The three vocabularies — `animations.ts`, the palette, `ICONS` — exist so that divergence is impossible rather than merely discouraged.
- Never treat Reduce Motion as an off switch. Decorative motion collapses; positional motion keeps its direction and only shortens, because a sheet that appears instantly no longer says which edge it came from or which way to throw it back.
- Never let a persisted setting be typed as a narrow union. `voiceStyle` is a `string`, resolved through `styleById`, precisely because a stored id can outlive the style it named.
- Never let a step of spoken text exceed `MAX_STEP`. It is both the utterance handed to an engine that refuses long input and the run of text highlighted on screen, so an escaped cap breaks the speech and the sync at once.
- Never encode a camera shot before the user has chosen to use it, and never hold a camera open behind another screen. `CameraMode` mounts `CameraView` only while it is visible, and its shots stay file URIs until `captureShots` runs them through the one-bitmap-at-a-time ingest path.
- Never build history rows twice. The list screen and the drawer both go through `src/chat/list.ts`, so a heading cannot say *Older · 34* in one place and *Older · 35* in the other, and a new bucket rule is one edit. Where the drawer differs it differs in a named exported function — `drawerRows` flattens a search into one relevance-ordered run — not in a ternary inside JSX where no test can reach it.
- Never read the clock in a render body. `react-hooks/purity` rejects `Date.now()` there, including inside the render-phase state-adjustment block that `react-hooks/set-state-in-effect` otherwise pushes you towards, so a component that stays mounted has no legal way to re-read it. Anything that needs a fresh *now* is a component that **mounts** when the clock should be read, with `useState(() => Date.now())`. That is why the drawer's history is `DrawerHistory` and not the body of `Sidebar`.
- Never let one piece of state have two controls. The three switchable built-ins live on `app/settings/tools.tsx` and nowhere else, and the connector directory prefills the add form instead of saving on the user's behalf. A second control over one value is two sources of truth waiting to disagree, and the copy that is not looked at is the one that rots.
- Never test that somebody else's server is up. `catalog.test.ts` asserts every entry's URL parses and every draft the form would accept; whether the endpoint answers is a device step (§7, 72–75), and a failure there means the catalog entry is **stale**, not that the app is broken.
- Never put an `accessibilityLiveRegion` on streaming text. A region whose text changes on every delta makes TalkBack restart from the top on each one, so the user hears the opening words dozens of times and never reaches the end. A finished turn is announced **once**, from `notifyReplyReady` — the one place a turn ends — and it announces the *size* rather than the content, because reading a reply aloud is a separate feature with its own switch. The corollary is the mutual exclusion above: a notification when the app is away, an announcement when it is not, never both.
- Never duplicate a control the platform already owns. There is no in-app haptics switch (Android's *Touch feedback* is system-wide) and no in-app notification switch, for the same reason there is no second control over one setting: the copy nobody looks at is the one that drifts. The exception is a platform setting the app must *interpret* rather than obey — Reduce Motion, per the invariant above.

## 7. Current Boundary and Risks

Every planned phase is implemented, and so is the whole v1.1 list: provider setup, model capability editing, reasoning controls, Markdown rendering, charts, search, streaming chat, multimodal input, skills, MCP with prompts and resources — now reachable from a bundled directory as well as by URL — slash commands and mentions, projects, plan mode, artifacts, the code sandbox, built-in tools including document generation, web search, file reading and writing including the three Office formats, inbound file intents, dictation, voice mode, an in-app camera, and a history drawer grouped and virtualised by the same row builder as the list screen. Ten of the twelve sections of the Claude-parity checklist are done — 1–7 and 10–12; 8 (sync) and 9 (a cowork surface) are product decisions on the PRD's non-goals list rather than work items. The app has been exercised on a physical Android device — but before the camera, before the drawer's grouping, before the connector directory, and before anything in the platform and accessibility pass existed.

What is still open is listed in [docs/flaws.md](docs/flaws.md). The load-bearing items:

- **Streaming stops when the app is backgrounded.** A foreground service needs the bare workflow. The partial reply is kept and marked aborted.
- **Live-gateway behaviour is unmeasured** — prompt caching, document blocks, estimator accuracy — because the gateway rejects every request before the credential is considered.
- **SQLCipher changes the native build**, so it is only trustworthy once an APK has run it on a device.
- **The native surface has grown.** `expo-camera`, `expo-speech`, `expo-speech-recognition`, `expo-local-authentication`, `expo-print`, `expo-sharing`, `react-native-webview`, `react-native-gesture-handler`, `expo-blur`, `expo-linear-gradient`, `expo-updates` and `@expo/vector-icons` are all native, as is the `intentFilters` block in `app.json`. An APK built before any of them lacks that feature until it is rebuilt, and an OTA update cannot cross that line — updates are scoped to the `runtimeVersion` the APK was built with. `expo-camera` is the newest and the starkest case: it arrived after the 1.0.0 APK and after the device run, so **no installed build has a camera at all**, and the camera has never been on a phone.
- **OTA is now enabled** (`updates.enabled: true`, channels `preview` and `production`). That is remote-code trust, taken deliberately: it is the only route a JavaScript fix has to a device that installed an APK by hand. The channel is signed and runtime-scoped, so it cannot introduce a native change, and `fallbackToCacheTimeout: 0` keeps a slow network out of the cold start. What was missing until now is the other end: `checkAutomatically: 'ON_LOAD'` downloads and verifies, then waits for the next **cold start**, which on an app left resident can be days. Settings shows a *Restart to finish updating* row while `useUpdates().isUpdatePending` is true — a way to stop waiting, not a second update mechanism. **Code signing is still not configured**, which is the open half of this item ([docs/flaws.md](docs/flaws.md) §2.7).
- **Half of Android's file hand-off is unhandled, and it cannot be fixed from JavaScript.** `ACTION_VIEW` works; `ACTION_SEND` — being in the *share* sheet rather than the *open with* list — does not, because Android puts the payload in `EXTRA_TEXT`/`EXTRA_STREAM` while both `Linking.getInitialURL()` and Expo Router's `+native-intent.tsx` see only `getIntent().getData()`. Closing it needs a new native dependency plus a manifest entry plus a rebuild, so it is left unhandled rather than half-pretended. It is the one genuine feature gap left by the parity work that is not a product decision.
- **Everything the accessibility pass claims is unverified by construction.** The screen-reader announcement is unit-tested as a string; whether TalkBack queues it, whether *Remove animations* flipped mid-session actually takes effect without a relaunch, and whether every screen survives Android's largest font size are a synthesised voice and two system settings. Steps 76–79 of the device protocol are the only check that exists.
- **Voice mode speaks with the device's engine, not a provider.** The five styles are pitch and rate settings on the system voice, and the picker says so rather than implying five recordings. `expo-speech` reports word boundaries on iOS only, which is why the script is one utterance per step driven by `onDone` and why the highlight moves a paragraph at a time on Android.
- **An Office file the app wrote cannot be edited in the app.** The reader recovers words, not layout, so a save would silently drop the formatting. The preview is read-only and says why.
- **Attachments are base64 in the request body**, so the per-file ceiling is well under what a provider accepts and a conversation holds twenty of them. A Files API on the gateway is the real fix.
- **Components have no unit coverage**, by the same design decision that keeps the domain layer pure. `app/chat/[id].tsx` is the largest and most stateful file in the app and has none. Rendering, gestures, navigation and layout are caught by the device protocol in [docs/07_Deployment.md](docs/07_Deployment.md) §7 or not at all. The drawer is the current example: `drawerRows` is tested, but the two things Section 7 actually claims — a steady frame rate through hundreds of rows, and a horizontal pan that loses its argument with the vertical scroller — are only visible to steps 69–71 on a phone.
- **The connector directory is a dated snapshot of addresses other people control.** `CATALOG_AS_OF` is `'May 2026'`, and every one of the eleven URLs, transports and auth kinds can change without this repository hearing about it. Nothing in the list is vetted or recommended, every entry links to the vendor's own docs, and the approval gate — not the list — is what stands between the model and a tool. No gate can check any of it: `catalog.test.ts` proves the entries parse and the form would accept them, and liveness is device steps 72–75, where a failure means the entry is stale rather than the app broken.

