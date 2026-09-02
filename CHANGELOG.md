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

- **A screen reader is now told when a reply lands** — with TalkBack on, a finished turn
  announces *"Reply ready, 48 words"*. It says how much arrived rather than reading the
  reply out, because the length is the one thing swiping through a transcript cannot tell
  you quickly, and because an announcement cannot be interrupted once it starts — reading
  a reply aloud on purpose is *Read aloud*, which has its own button. The transcript
  deliberately does **not** announce as it streams: a live region on text that changes on
  every token makes TalkBack restart from the beginning each time, so you would hear the
  first sentence over and over and never reach the end. Nothing is said for a turn you
  stopped yourself, nothing for a turn that produced no text, and nothing when the app is
  in the background — that case already gets the notification, and exactly one of the two
  speaks for any turn. JS only.
- **Settings can finish an update instead of waiting for one** — a JavaScript fix is
  downloaded and verified in the background at launch, but it only takes effect the next
  time the app starts from cold, which for an app left resident can be days. While one is
  waiting, Settings now shows a single **Restart to finish updating** row at the top. It
  is not a second update mechanism and not a "check for updates" button: doing nothing
  arrives at exactly the same place, later. It warns that a typed-but-unsent draft is
  lost, because drafts live in memory. JS only.
- **A directory of tool servers** — adding an MCP server used to mean knowing its URL,
  which is a strange thing to ask of somebody who has just learned that MCP exists.
  Settings → MCP servers now has a **Browse connectors** list of eleven well-known
  servers — DeepWiki, Context7, Cloudflare docs, Hugging Face, Stripe, GitHub, Sentry,
  Notion, Linear, Jira and Confluence, Asana — each saying in one line what it can see and
  whether
  it needs a token, a sign-in or nothing at all, with the ones needing nothing first so
  the first thing you try is the one that works. An entry that is already installed says
  *Added* instead of offering itself twice. Tapping one **fills in the add form and saves
  nothing**: the same name, URL and header validation runs as for a URL you typed, so the
  shortcut is into the form rather than around it. The list is honest about being a list —
  it is a dated snapshot (May 2026) of addresses other people control, every entry links
  to that vendor's own docs, and nothing in it is vetted or recommended by this project.
  The approval gate, not the directory, is what stands between the model and a tool.
  JS only.
- **One line that says what this turn can actually do** — the answer used to be spread
  across a settings screen, the conversation's server list, its skill list and whether
  plan mode was on, so the only way to know was to remember. The conversation ⋯ menu now
  has a **Tools** row that reads it back — *files, PDFs and documents · web pages · 12
  tools from 2 servers · 3 skills*, or *writing blocked · 12 server tools blocked* in plan
  mode — computed from what
  is really configured rather than from a sentence somebody kept in step by hand, and
  tapping it goes to the screen where the switches are. JS only.
- **A camera inside the app** — *Take a photo* used to hand you to the system camera and
  take back one picture. It now opens a viewfinder in SuperAgent, because the thing
  people actually do with a camera in a chat app is photograph the same page four times
  and keep the one that is in focus. Several shots per message, a strip along the bottom
  to look at them, and a tap on a thumbnail to drop that one. The status line counts down
  the slots left in the message, and the shutter goes dead — with the reason in words —
  when they run out. Flash cycles off → auto → on on the back camera and off → screen
  flash on the front, because that is what a front camera has. Nothing is encoded until
  you press *use* and nothing is sent until you press send; a session you back out of
  deletes its own photos. What it is not: no pinch-to-zoom, no crop, no document scanner,
  and no barcode or QR scanning — the ML Kit dependency that would bring is left out of
  the APK deliberately. The app never records video, so it does not claim microphone
  access on the camera's account either. **Needs a rebuild** (`expo-camera` — the first
  new native module in twelve sections of parity work, so no installed build has a
  camera and no update can give it one).
- **Voice mode** — a full-screen conversation with no keyboard in it: hold the button
  to talk, let go, and the reply is spoken back a paragraph at a time with the
  paragraph being read highlighted. Long replies page sideways, three steps to a page.
  Five voices and four playback speeds, both remembered. It is honest about what it
  is: the five styles are five pitch-and-rate deliveries of the device's own
  text-to-speech voice, not five recorded ones, and the picker says so — a real voice
  provider needs a speech endpoint the gateway does not expose. Attachments can be
  added mid-conversation without leaving it. Reachable from the composer, next to the
  microphone.
- **Charts** — a ` ```chart ` fence renders as a bar, line or scatter plot, from the
  app's own spec (`{type, labels, series}`), a Chart.js-shaped one, or a bare
  `{type, labels, data}`. Drawn with views and text alone: no chart library, no SVG,
  no WebView, so it costs nothing to install and cannot execute anything. Six series,
  forty bars or four hundred points, each series a colour that clears 3:1 against the
  page in both schemes and differs in lightness as well as hue. A spec it cannot draw
  falls back to the code block with the reason shown, rather than to an empty box.
- **Word, Excel and PowerPoint files the model can write** — `create_document`, a
  built-in beside `write_file` and `create_pdf`, turns Markdown into a real `.docx`,
  `.xlsx` or `.pptx`. Headings, paragraphs, bold, italics, code, tables and bullets;
  a workbook takes each table as a sheet, a deck takes each `##` as a slide. No new
  dependency — OOXML is a zip of XML and `fflate` was already here — so no rebuild.
  The ceilings are documented where they are made: bullets are literal characters
  rather than real numbering, and a link's address is written after its text instead
  of as a relationship.
- **Open a file from another app** — SuperAgent now appears in Android's share and
  "Open with" list for PDFs, text, JSON, XML, images and the three Office formats.
  The file arrives staged on a new conversation with its own name, ready to send.
  Only a `content://` URI from the system picker is accepted; a `file://` path is
  refused with a reason on screen, because a `file:///data/data/…` path can name this
  app's own private storage, including its database. **Needs a rebuild**
  (an `intentFilters` change in `app.json`).
- **A generated file can be read, edited and saved** — the file card's Open now shows
  the file inside the app instead of handing it away: text and Markdown are editable
  and save back over the original, an `html` or `svg` file gets the artifact preview,
  and an Office file is read-only and says why (the reader recovers the words, not the
  layout, so saving would quietly delete the formatting). **Save to a folder** writes
  a copy wherever the system picker points, with the share sheet as the fallback when
  no folder is granted.
- **Tool steps read as sentences** — a call in the transcript said `web_search_exa`
  and a JSON blob. It now says *Searched the web* with the query beside it, under an
  icon chosen for what the tool does, with the arguments behind the chevron and the
  raw name kept for the screen reader. Matched on the verb in the name rather than a
  list of known tools, because most of them arrive over MCP and cannot be known in
  advance. The label never claims the call succeeded — the result below it says that.
- **Sources are labelled by site** — a citation chip showed a truncated title; it now
  shows the domain with the index in bold, which is what distinguishes one source
  from five others in a row. The title moved to the accessibility label and is still
  in the export.
- **Share an image** — an attached or generated image opened full screen has a Share
  button, so a picture the model produced can leave the app without a screenshot.
- **A reply arrives by being written** — streamed text is revealed at a pace chased
  from the backlog rather than a fixed characters-per-second, so it keeps up with a
  fast model and does not stall behind a slow one. A backlog too large to be typing —
  a summarised history, a reconnect replay — appears at once instead of animating a
  slab of text nobody is waiting on.
- **A long-press menu opens where you pressed** — over a blur, pinned to whichever
  side of the touch has more room, measuring neither the element nor itself. It is
  still the complete list of a row's actions and the only one a screen reader reaches.
- **Toasts** — a bulk action that succeeded says so and gets out of the way. Failures
  still take a tap.
- **One vocabulary of motion** — every duration, curve and spring the app may use
  lives in [src/constants/animations.ts](src/constants/animations.ts) and nothing
  invents one locally, because a drawer opening in 240ms beside a sheet rising in
  400ms reads as two apps. Screens slide horizontally on both platforms; sheets rise
  over their own measured height and can be thrown away downwards; the drawer runs off
  one shared value on the UI thread, so a drag takes over the number the animation was
  driving, and the page behind it shrinks, shifts and rounds its corners; list rows
  slide left to uncover pin, rename and delete; every control dips and springs back,
  with the haptic on activation rather than on touch. Reduce Motion is read as a
  distinction, not a switch: decorative motion collapses to one frame, positional
  motion keeps its direction and only shortens, because a sheet that appears instantly
  no longer says which edge it came from. **Needs a rebuild**
  (`expo-blur`, `expo-linear-gradient`, `react-native-gesture-handler`).
- **Every affordance is a drawn icon** — `☰ ⋯ ↑ + ● × ✕ › ⌄` were typed characters,
  each at whatever size its own call site chose, each growing with the system font
  scale and sliding off centre inside its fixed disc. They are Feather glyphs now,
  behind a role map ([src/components/Icon.tsx](src/components/Icon.tsx)): a caller
  names `send`, not `arrow-up`, which makes the family swappable in one file and makes
  it impossible for the same idea to pick a different picture on another screen.
  **Needs a rebuild** (`@expo/vector-icons`).
- **The drawer has somewhere to stand** — a wordmark, an ACTIONS group, HISTORY and an
  ACCOUNT footer, with the open conversation marked by a soft accent fill and a clay
  bar down its left edge rather than a badge reading "Here" beside a row that already
  looked selected.
- **Skeletons where a load has a known shape** — rows rather than a spinner, so
  arriving content does not shove the screen. The spinner stays for waits whose result
  has no shape yet: a reachability probe, a message search.
- **Terminal output** — a tool result that carries ANSI colour or redraws its own line
  is rendered as a terminal instead of a code block: colours read, cursor codes
  dropped, a progress bar showing its last state, tabs aligned to eight columns. This
  is the last piece of using a remote shell over MCP from the phone — see
  [docs/USAGE.md](docs/USAGE.md) §15.1. Copy and Markdown export give the
  text without the escapes; the JSON export keeps the bytes verbatim.
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

- **The switchable built-in tools have their own screen, and the ones with no switch are
  named there.** Web fetch, web search and `run_code` were three toggles sitting directly
  in the settings hub, which made the list of built-in tools look like a list of three.
  They moved to Settings → Built-in tools, where the hub row now reports their state in
  one line instead of repeating the toggles; the screen itself says that writing a file,
  rendering a PDF and generating a document are always offered and *why* they have no
  switch — they reach nothing but this app's own storage, so there is no access to
  withhold. The switches remain global and exist in exactly one place: a per-conversation
  copy of a decision this size is two sources of truth waiting to disagree. JS only.
- **The history drawer is grouped and no longer slows down.** It used to be one flat run
  of chats under a single "History", so a chat pinned in March sat wherever its date put
  it and forty rows told you nothing about where last week ended. It now reads *Pinned*,
  *Today*, *Yesterday*, *This week*, *Older*, each with a count — the same headings as
  the full list, because it is the same code. Searching drops the headings and puts every
  hit in one run under *Matches*, best first: date buckets over a ranked list only bury
  the row you were looking for. The search box also empties itself when the drawer
  closes, so it always reopens on the whole history instead of on last week's query.
  Underneath, the list is virtualised — it used to build every row each time the drawer
  opened, which is what made it heavy at a few hundred chats. Dragging the panel shut
  from anywhere over the rows still works, and still loses to a vertical scroll. JS only.
- **The system camera hand-off is gone.** `expo-image-picker`'s camera path was removed
  rather than kept beside the new viewfinder: it needed the same camera permission and
  ran the same attachment pipeline, so two rows offering a camera would have been a
  choice with nothing to base it on. The gallery half of the picker is untouched. One
  consequence is stated rather than hidden — if the viewfinder fails to open on a
  particular device, there is currently no second way to take a photo, and
  [docs/flaws.md](docs/flaws.md) says so.
- **OTA updates are now enabled** (`updates.enabled: true`, channels `preview` and
  `production`). 1.0.0 shipped with them off; a JavaScript-only fix can now reach a
  device without a new APK. Anything native still cannot — see the entries marked
  **needs a rebuild** above and [docs/07_Deployment.md](docs/07_Deployment.md) §9.
- **A conversation holds twenty attachments**, counted across every message already
  sent plus whatever is staged — the number the Claude apps use. The attach sheet says
  how many slots are left and disables what will not fit, instead of accepting a file
  and failing on send.
- **Read aloud uses the voice and speed chosen in voice mode**, so a message read from
  the transcript sounds like the one read in the conversation.
- **The artifact preview is a panel beside the conversation**, not a screen you left
  for. Its scene transform and the drawer's are one hook, summing their shifts,
  because the two push the page in opposite directions.
- **Sheets have one implementation.** `SheetShell` replaced three hand-rolled `Modal`
  presentations; the model-controls sheet gained the `ScrollView` it never had despite
  a dozen fields under a 90% height cap.
- **Assistant replies crossfade out of a pulsing three-dot indicator** which stands in
  for the reply and is replaced by it, rather than a spinner beside empty space.
- **Twelve destructive confirmations buzz a warning** — on the confirm button, not on
  the menu item that opens the dialog: the tap that opens it is reversible and the tap
  that dismisses it is not.
- **Thinking, tool calls and tool results share one disclosure pill.** They were three
  shapes for the same idea — a collapsed line with a chevron — at three paddings.
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

- The stepper's **−** and **+** could grow out of their buttons at Android's largest font
  size. They sat in the one fixed-height box in the app with text that scaled, so the
  glyph outgrew the disc it was centred in. They no longer scale, for the same reason the
  icons do not: a symbol drawn in a fixed circle is not text. Every label, value and
  message in the app still scales. This was the last remaining case of that bug — the
  icon discs elsewhere were fixed earlier in this cycle. JS only.
- The three cost guards in the test suite measured the machine rather than the code, and
  two of them failed as soon as a second test run shared the CPU. They asserted absolute
  times — 2,000 ms to parse a thousand message bodies, 150 ms each for the conversation
  list's grouping and filtering. Each one now times a quarter of its input, then all of
  it, and asserts the larger run cost under 12× the smaller: linear is 4, quadratic is
  16, and load cancels because both halves meet the same load. Nothing about the app
  changed; the guards catch what they were always meant to catch and no longer fail for
  reasons that have nothing to do with the code.
- Dictation could send the wrong session's words. The speech-recognition events are
  module-wide, so a second screen mounting the hook received the first one's results;
  a handler now ignores anything it does not own, ownership is dropped before the end
  event so a failed session is not sent, and `stop()` keeps it until the end so the
  final transcript wins over the last interim guess.
- Three hardcoded `#00000088` backdrops became one `scrim` token — one value for both
  schemes, deliberately not derived from either palette, because a scrim tinted with
  the light palette's paper leaves the page underneath competing with the sheet on top
  of it.
- A link's domain is now parsed with a regex rather than `new URL`, whose Hermes
  polyfill is partial: a throwing parser in the middle of rendering a transcript takes
  the whole screen down.
- The drawer's capture-phase `PanResponder` is gone. The list inside it is Gesture
  Handler's `ScrollView` now, so the pan and the scroller are in one arbitration
  instead of racing for the responder.
- The history drawer could not be dragged shut and its list would not scroll to the
  end. The drag is claimed in the capture phase, so the list inside the panel stops
  swallowing a horizontal swipe, and the scroller is bounded, so the footer buttons
  stay on screen with four hundred chats above them. The panel is a layer rather than a
  flex child, so a rotation no longer parks it at the previous width, and the swipe-in
  strip at the screen edge is a thumb's width instead of a hairline.
- The chat header's ☰ and ⋯ are fixed, centred targets rather than bare text that grew
  out of the row at large system font sizes.
- The chat header carried three things in the strip between two 44dp buttons — the
  title, the model on a second line, and an "Unreachable" pill wedged beside it. It
  is now just the title: the model is already the tappable chip on the composer, and
  the unreachable state is already a whole sentence pinned above it.
- The first React frame after the splash replaced the app's mark with a stock
  spinner. It is the mark now, on the same colour, turning.
- Opening a conversation showed a bare spinner under whatever title the previous screen
  had left; it now shows the app's mark on an empty header, and an empty chat opens on
  the mark and a question rather than a bordered "nothing here yet" card.

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
- Glyph buttons no longer drift out of their discs at large system font sizes. (See the
  stepper entry above for the last case of this.)
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
