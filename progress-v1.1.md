# SuperAgent — v1.1 plan

**Written:** 2026-08-31 · **Base:** `release/v1.0.0-prep` @ `bc88a47` · **Supersedes nothing** —
[progress.md](progress.md) stays the record of what v1.0 built; this file is only what comes next.

Every claim below was checked against the code, not remembered. Where a reported issue turned
out to be "never built" rather than "broken", it says so — that changes the fix from a bug hunt
into a feature.

---

## Status — 2026-09-02

Everything in Part 3, items 1–8, is implemented and on green gates (`pnpm gates`: typecheck, lint,
**1,573 tests in 79 suites** — the count when this file was written; [progress.md](progress.md)
carries the current figures — coverage thresholds). See [CHANGELOG.md](CHANGELOG.md) `[Unreleased]`
for the user-facing list. Nothing on this list was deferred.

**This document has been overtaken by a second workstream.** After items 1–8 closed, Sections 1–7
and 10–12 of
a Claude-parity checklist landed on top of them — message rendering, inline visuals, file reading,
file generating and editing, voice mode, an in-app camera, a grouped, virtualised history drawer,
a bundled directory of tool servers with a one-line answer to what a turn can do, and last a
platform-and-accessibility pass (a screen reader told when a reply lands, a pending update
applied without waiting for a cold start) —
which closed several things this file
recorded as open or as "not v1.1". Where that has happened the row or bullet below says so inline rather than being
deleted, because the reasoning for deferring was the useful part. Neither workstream was a planned
sprint, which is its own finding: see [06_Eng_Plan.md](docs/06_Eng_Plan.md) §4.5 and D-17.

How the last three of items 1–8 landed, since they are the ones with a design worth recording:

- **Item 8, web search.** A server-side tool on the Anthropic path, so it needed a new block kind
  that survives the round trip. `ServerToolBlock` carries the provider's `server_tool_use` and
  `web_search_tool_result` frames **verbatim** in `raw`, plus a derived summary and source list for
  the transcript. Verbatim is load-bearing rather than tidy: the API rejects a result block whose
  `tool_use_id` no longer matches the call before it, so a normalised copy would make every *later*
  request in that conversation a 400. A pair whose arguments were cut off mid-stream is shown but
  replayed as nothing, for the same reason. The tool definition is prepended to `body.tools` so the
  `cache_control` marker stays on the last entry and the cached prefix keeps its bytes. Off by
  default behind `allowWebSearch`, Anthropic profiles only — it is billed per search, and search
  results are untrusted text entering the window, the same injection surface as `fetch_url`.
  `citations` on text blocks was not implemented at the time of writing; sources came from the
  result block instead, which is what the source list needs. **It has since been built**:
  `citations_delta` frames accumulate onto the live text block ([chat.ts:1846](src/stores/chat.ts:1846)),
  de-duplicated by URL, rendered under the answer ([ContentBlocks.tsx:513](src/components/chat/ContentBlocks.tsx:513))
  and carried into an export through `redactDeep` rather than `safe`, because a title and a URL are
  model-adjacent strings from a third party ([export.ts:303](src/chat/export.ts:303)).
- **`@`-mentions.** Built as one engine rather than two: `CommandKind` gained `file` and `server`,
  and `rankCommands`, `uniqueNames` and `CommandBar` are shared with `/` behind a `prefix` prop. The
  one real difference is position — a command *is* the draft, a mention is a word inside a sentence —
  so it lives in a single anchored regex, and `ada@example` does not open the list. `@file` reuses
  the picker's whole admission path, size ceiling included.
- **`estimateToolTokens` calibration.** Fixed a larger bug behind it: `planTurn`'s only caller was
  never passed `tools` at all, so the manifest was excluded from the history budget entirely,
  contradicting `budget.ts`'s own rationale. Tools now flow into the budget, and are corrected by
  their own residual-derived factor rather than the prose one — JSON tokenizing badly says nothing
  about English. The factor falls back to the blended one until there is enough evidence to measure.

One correction to §3 below: a truncated arguments blob is **refused with an error result**, not
retried. The app cannot reconstruct JSON it never received, and a retry loop over a truncated
stream bills a round to guess. The result says the call was cut off, which the model can act on.

---

## Part 1 — The seven reported issues, verified

### 1. Slash commands do not work → they do not exist

`grep` for `startsWith('/')` across `src/` and `app/` returns three hits, all unrelated (a zip
path check, a URL check, a language-name check). There is no `/` handling in
[Composer.tsx](src/components/chat/Composer.tsx) at all. Nothing regressed; the feature was
never written.

What exists instead: prompt templates, skills and MCP servers are reachable **only** through the
conversation `⋯` menu → a sheet ([\[id\].tsx:776](app/chat/[id].tsx:776)). Three taps and a
scroll to insert a saved prompt.

**Build:** a `/` trigger in the composer that opens a filtered list over one merged index —
prompt templates (`src/stores/prompts.ts`), installed skills (`src/stores/skills.ts`), MCP
prompts (already discovered at [mcp.ts:150](src/stores/mcp.ts:150)) and a handful of app
commands (`/export`, `/model`, `/clear`, `/skills`). Selecting a template with `{{variables}}`
opens the existing fill form — `fillPrompt` and `variablesIn` in
[prompts.ts](src/chat/prompts.ts) already do that work, so this is a new entry point, not a new
engine.

**Blocker inside this:** MCP prompts are listed but unusable. The client implements
`prompts/list` ([client.ts:116](src/mcp/client.ts:116)) and never `prompts/get`, and the settings
screen says as much out loud ("Listed for reference"). `/` cannot insert an MCP prompt until
`prompts/get` exists. One method, same `session.call` plumbing as `resources/read`.
→ **Closed:** `prompts/get` is at [client.ts:173](src/mcp/client.ts:173), and it was the one
method it looked like.

### 2. Document generation is missing → correct, and it is two separate gaps

**The model cannot produce a file.** `resolveCall`
([chat.ts:848](src/stores/chat.ts:848)) routes exactly two things: `invoke_skill`, and any name
starting with `mcp_`. Everything else returns *"There is no tool called …"*. There is no
file-writing tool, no code execution, nothing that produces bytes.

**The app can only export two formats.** [export.ts](src/chat/export.ts) emits Markdown and
JSON, delivered by clipboard or share sheet ([deliver.ts](src/chat/deliver.ts)). No PDF, no
`.docx`, no `.xlsx`, no CSV. `deliver.ts` documents the *absence of "save to file"* as a
deliberate choice — that reasoning holds for a transcript and stops holding the moment the
answer is a generated spreadsheet.

**Build, in this order:**

1. `write_file` as a built-in tool — the model names a file and its text content, the app writes
   it under the app's document directory and shows it as a card in the transcript with Share and
   Open. `expo-file-system` is already in the tree.
2. Markdown → PDF via `expo-print`'s `printToFileAsync`. The Markdown renderer already produces
   HTML-shaped structure ([blocks.ts](src/components/markdown/blocks.ts)); `expo-print` takes
   HTML and returns a real PDF. One new Expo module, no native code of our own.
3. CSV and `.xlsx` are the honest hard ones. CSV is a string, so it comes free with `write_file`.
   `.xlsx` needs a writer library (`fflate` is already installed, which covers the zip half of
   OOXML but not the XML half). Ship CSV in v1.1; leave `.xlsx` to v1.2 unless asked.
4. `.docx` — same shape as `.xlsx`. Not in v1.1.

**All four shipped, and items 3–4 came earlier than planned.** The XML half of OOXML turned out to
be string templating for the subset a generated document uses, so `.docx`, `.xlsx` and `.pptx`
write with no library at all ([ooxml.ts](src/chat/ooxml.ts) — see Part 4 for the reversal). The
transcript card, Share and Open, and an in-app preview for every format the app can generate are in
[USAGE §8](docs/USAGE.md).

### 3. The model interacts with tools badly → four distinct causes, all real

**All four are fixed.** The diagnosis is kept because the *dominant* cause turned out to be the
first one, and that is the part worth remembering.

- **Only two tool families exist.** No filesystem, no web, no execution, no time, no math. A
  model with `invoke_skill` and nothing else looks incompetent because it has nothing to be
  competent with. This is the dominant cause and item 2 and 4 below are its fix.
  → **Fixed:** `write_file`, `create_document`, `fetch_url`, `web_search`, `run_code` and
  `read_mcp_resource` are all built in, the last four off by default ([USAGE §10](docs/USAGE.md)).
- **Tool results from images are thrown away.** `flattenToolResult`
  ([protocol.ts:294](src/mcp/protocol.ts:294)) turns non-text MCP content into a *description* of
  itself. A server that returns a screenshot returns, to the model, the sentence "an image".
  Every vision-driven MCP tool is therefore broken by design. Fix: pass image content through as
  a real `image` block when the model has vision (`capabilitiesFor` already knows), and keep the
  description as the fallback.
  → **Fixed as described**, with one bound added that this note did not anticipate: an image
  returned by a tool is capped by `MAX_TOOL_IMAGE_BASE64`, because a server can return a 10 MB
  screenshot and the window cannot.
- **Tools are silently withheld under budget.** `selectTools`
  ([tools.ts](src/chat/tools.ts)) drops tools to fit a token ceiling and tells the model which
  ones went. That is the right design and it is invisible to the *user* — there is no indicator
  that this turn ran with half a manifest. With more tools coming, withholding becomes the
  common path. Fix: surface the withheld count in the transcript, not just in the system prompt.
  → **Fixed**, and it closed [06_Eng_Plan.md](docs/06_Eng_Plan.md)'s D-13, which had been open
  since the harness sprint because `selectTools` had no call site at all
  ([chat.ts:1381](src/stores/chat.ts:1381)).
- **The round cap ends the turn with a note asking the user to send again**
  ([chat.ts:1213](src/stores/chat.ts:1213)). Correct for runaway loops, wrong as the routine
  experience once tools multiply. Fix: raise the default, and make the note a **Continue** button
  rather than a sentence asking for a retype. → **Fixed as described.**

Also worth knowing: a truncated arguments blob is stored as `{ __unparsed: … }`
([chat.ts:199](src/stores/chat.ts:199)) and then handed to the server, which fails it. Retrying
the call once on a parse failure would be a few lines and would convert a dead turn into a
working one. → **Not what shipped.** See the correction in the Status block: the call is refused
with an error result the model can act on, because the app cannot reconstruct JSON it never
received and a retry over a truncated stream bills a round to guess.

### 4. There is no terminal → correct, and on Android there mostly cannot be one

Be clear about the ceiling before building: an unrooted Android app cannot run `git`, `node`,
`python` or `pnpm`. There is no shell to give. `expo-file-system` reaches the app's own sandbox
and whatever the user picks through the document picker — not the filesystem.

So "terminal" splits into three things, of which two are buildable:

- **A local command surface over the app itself** — `/` commands from item 1, plus a scriptable
  set of app actions (export, switch model, toggle a skill, run a prompt over N conversations).
  Buildable now, genuinely useful, no native work.
- **A real shell on a remote machine, over MCP.** This is the answer for `git` and `node`: an MCP
  server on a laptop or a VPS exposing a `run_command` tool, and a transcript pane that renders
  its output as a terminal rather than as a `tool_result` blob. The client
  ([client.ts](src/mcp/client.ts)) already speaks HTTP/SSE with OAuth, so the work is a renderer
  and a docs page, not a protocol.
- **A JS sandbox for arithmetic and data munging**, the equivalent of Claude's analysis tool.
  **Built in v1.1** as `run_code`: not Hermes `eval` but a zero-sized `react-native-webview`
  under `default-src 'none'; script-src 'unsafe-inline'`, so the engine that runs model-written
  code is not the engine holding the API keys. Off by default. See
  [sandbox.ts](src/chat/sandbox.ts).

### 5. UI issues → the ones I can point at

The report did not name them, so here is what is verifiable from the code. Send screenshots for
the rest and they go in this list.

**All four are now fixed.** Recorded as found, with the fix under each.

- **The app calls itself three different things.** `app.json` name is `Jarvis`; the slug is
  `agentrouter-mobile` and the package `org.lyric.agentrouter`; export metadata writes `Jarvis`
  ([export.ts:415](src/chat/export.ts:415)); the backup envelope writes `AgentRouter Mobile`
  ([backup.ts:113](src/chat/backup.ts:113)); the MCP OAuth client registers as
  `AgentRouter Mobile` ([oauth.ts:159](src/mcp/oauth.ts:159)); and `bc88a47` renamed the project
  to **SuperAgent**. The composer placeholder reads `Reply to Jarvis…`
  ([Composer.tsx:501](src/components/chat/Composer.tsx:501)), and two permission strings name
  Jarvis to the user at the moment Android asks for the camera.
  The backup envelope is the one string that cannot simply change — `parseBackup` matches on it,
  so a rename must accept both or every existing backup stops restoring.
  → **Fixed.** One constant, `APP_NAME` in [app.ts](src/lib/app.ts), is the only source of the
  display name; a grep for `Jarvis` across `src`, `app`, `plugins` and `app.json` now returns a
  single hit, and it is the comment in that file explaining which legacy strings still have to be
  *accepted*. The backup reader takes both envelopes, and the identity strings — slug, package,
  `jarvis://` scheme — deliberately did not change, because renaming them orphans installs and
  OAuth redirects.
- **Twelve actions in one sheet.** The conversation menu carries system prompt, model, profile,
  controls, skills, servers, rename, tags, pin, reference, export and delete
  ([\[id\].tsx:776–843](app/chat/[id].tsx:776)). Nothing is one tap. `/` commands take the top
  four out of the sheet.
  → **Fixed** by `/` commands plus the icon pass: the four most-used actions are reachable
  without the sheet.
- **Send and attach are text glyphs, not icons** — `↑` and `+` rendered as `<Text>`
  ([Composer.tsx:131](src/components/chat/Composer.tsx:131),
  [:258](src/components/chat/Composer.tsx:258)). At large accessibility font sizes they grow and
  drift off centre inside a fixed 36dp disc.
  → **Fixed.** Every affordance draws through a *role* in `ICONS`
  ([Icon.tsx](src/components/Icon.tsx)) — `send`, not `arrow-up` — so the same idea cannot pick a
  different picture on another screen. The clipping is fixed at the root: an icon is not the only
  carrier of meaning, and what it *means* lives on the accessibility label of the control around
  it, which scales when the glyph cannot. Checklist §12 found the **last** instance of the same bug
  and closed it the same way: `StepButton`'s `−` and `+` in [ui.tsx](src/components/ui.tsx) were the
  one remaining scaling glyph in a fixed-height box.
- **MCP resources are capped at 20 with no way to see more**
  ([mcp.tsx:326](app/settings/mcp.tsx:326)).
  → **Fixed.** `RESOURCE_PREVIEW = 20` is now a preview with a *Show all* row behind it
  ([mcp.tsx:51](app/settings/mcp.tsx:51)); twenty still answers "is it working?" without paging
  hundreds of rows on first open.

### 6. Voice mode is missing → and a permission is already being asked for

Output exists: `speakOrStop` reads a message aloud through Android TTS
([speech.ts](src/chat/speech.ts)). Input does not exist — there is no speech-to-text, no
recording, no audio dependency in `package.json` at all.

**But `app.json` already declares `android.permission.RECORD_AUDIO`** ([app.json:24](app.json)).
Nothing in the codebase uses it. That is a permission on the Play listing with no feature behind
it, which is both a store-review problem and the wrong thing to ship. Either build voice input in
v1.1 or delete the line — do not release it as it stands.

**Build:** hold-to-talk on the composer, `expo-speech-recognition` (on-device where the OS offers
it), transcript dropped into the draft as editable text rather than sent — the user should see
what was heard before it costs a turn. Full duplex "voice mode" (barge-in, continuous turn-taking)
is a v1.2+ project and depends on a streaming audio provider the gateway does not currently expose.

**Closed, and the deferral above turned out to be wrong.** Hold-to-talk shipped as written
([dictation.ts](src/lib/dictation.ts) driving the composer), so `RECORD_AUDIO` now has a feature
behind it. Then the checklist's Section 5 built the full hands-free mode too — and it did *not*
need a streaming audio provider, which is the part this document got wrong. The loop is the two
engines already on the device: `expo-speech-recognition` listens, the reply is scripted into
utterances by [voice.ts](src/chat/voice.ts), `expo-speech` speaks them, and recognition restarts on
`onDone`. Barge-in is a listener that cancels the utterance rather than a duplex audio stream. What
that costs is recorded rather than hidden: turn-taking is half-duplex, so the app is either
listening or speaking, never both, and the five voice styles are pitch and rate on the OS voice
rather than five distinct voices. No audio dependency was added.

### 7. Claude as the reference — the full gap list

Reference surface: the Claude apps plus Claude Code, since the request is "everything Claude has".

| Capability | SuperAgent today | Work |
|---|---|---|
| Streaming chat, markdown, code highlighting | ✅ | — |
| Extended thinking / reasoning budgets | ✅ | — |
| Multi-provider, multi-model routing | ✅ (beyond Claude) | — |
| Prompt caching | ✅ | — |
| Conversation search | ✅ FTS | — |
| Edit-and-resend, regenerate | ✅ | — |
| Memory across conversations | ✅ | — |
| Custom skills (SKILL.md) | ✅ | — |
| MCP connectors, remote, with OAuth | ✅ | ✅ **A directory since** — checklist §10 adds eleven well-known servers as bundled data ([catalog.ts](src/mcp/catalog.ts)), so adding one no longer starts with knowing its URL |
| Per-tool approval | ✅ | — |
| Usage and cost per turn | ✅ (beyond Claude) | — |
| Offline queue, app lock, encrypted DB | ✅ (beyond Claude) | — |
| Image + PDF + text attachments | ✅ | — |
| Read aloud (TTS) | ✅ | — |
| **Slash commands** | ✅ v1.1 | One list over prompt templates, skills, MCP prompts and app commands (§1) |
| **File / document generation** | ✅ v1.1 — md/txt/csv/json + PDF; ✅ **`.docx`/`.xlsx`/`.pptx` since** | Closed by checklist §4 — generated as OOXML through the already-present `fflate`, no new dependency ([ooxml.ts](src/chat/ooxml.ts)) |
| **Voice input** | ✅ v1.1 — hold-to-talk into the draft; ✅ **hands-free voice mode since** | Closed by checklist §5 ([voice.ts](src/chat/voice.ts), [VoiceMode.tsx](src/components/chat/VoiceMode.tsx)). Half-duplex, on the two engines already on the device — see §6 |
| **Web search** | ✅ v1.1 — Anthropic server-side tool, off by default, source list in the transcript | Citations on text blocks done: `citations_delta` → a source list under the answer, quoted in an export |
| **Web fetch (read a URL)** | ✅ v1.1 — `fetch_url`, off by default, re-checks the address it landed on | — |
| **Artifacts** (rendered HTML/SVG/code preview) | ✅ v1.1 — Preview on any `html`/`svg` fence, `react-native-webview` under `default-src 'none'`, navigation refused ([artifact.ts](src/chat/artifact.ts)) | No new content block: an artifact is a view of a fence already in the transcript, so old messages get it too |
| **Analysis tool** (run code) | ✅ v1.1 — `run_code`, off by default, JS in a WebView with no network, no storage and no bridge ([sandbox.ts](src/chat/sandbox.ts)) | A calculator, not a shell; classified read-only for plan mode |
| **Projects** (grouped chats + shared knowledge) | ✅ v1.1 — instructions + documents inherited by every conversation, filter chips on the list ([project.ts](src/chat/project.ts)) | Prompt order: project instructions → conversation prompt → knowledge, fenced and marked source-material |
| **@-mentions** of files, skills, connectors | ✅ v1.1 | Same index and ranking as `/`, one anchored regex apart |
| **MCP prompts usable, not just listed** | ✅ v1.1 — `prompts/get` ([client.ts:173](src/mcp/client.ts:173)) | — |
| **MCP resources readable by the model** | ✅ v1.1 — `read_mcp_resource` built-in | — |
| **Subagents / task delegation** | ❌ | Not v1.1. Two models on one phone battery is a different product. |
| **Plan mode** | ✅ — per-conversation toggle; writers and every MCP tool refused, reads still allowed ([plan.ts](src/chat/plan.ts)) | — |
| **Native filesystem / bash** | ❌ on device — ✅ over MCP | A `run_command` server on a real machine, rendered as a terminal ([terminal.ts](src/chat/terminal.ts), [USAGE §15.1](docs/USAGE.md)); §4 |
| **Docx / xlsx / pptx reading** | ✅ — read on device into text, no new dependency ([office.ts](src/chat/office.ts)) | ✅ **Writing them is closed too** — checklist §4 generates the OOXML directly ([ooxml.ts](src/chat/ooxml.ts)); a generated Office file is read-only in the app and says why, because the reader recovers words rather than layout |
| **Inline visuals** (charts, tables, diagrams) | ✅ **since** — checklist §2 | Views and text, not a canvas and not `react-native-svg`: an unsupported spec returns `{kind: 'unsupported', why}` and the fence degrades to a code block with a reason ([chart.ts](src/components/markdown/chart.ts)) |
| **Reading a file the user opens from another app** | ✅ **since** — checklist §3 | `content://` from a system provider only; `file://` refused with the reason shown, because `file:///data/data/<package>/…` can name this app's own encrypted database ([incoming.ts](src/chat/incoming.ts)) |
| **In-app camera** | ✅ **since** — checklist §6 | `expo-camera 57.0.4`, the first new native dependency in the parity effort, so it is also the first item that cannot reach an installed build over the update channel. Shots are held as file paths and encoded once on the way out, which is what keeps `attach.ts`'s one-bitmap-at-a-time rule true with a shutter that can be pressed eight times ([camera.ts](src/chat/camera.ts), [CameraMode.tsx](src/components/chat/CameraMode.tsx)). Not yet run on a phone |
| **A directory of tool servers** | ✅ **since** — checklist §10 | Eleven entries in a frozen array with a slug, what each can see, its auth kind and the vendor's own docs link, ordered no-sign-in-first; `draftFromEntry` prefills the same add form and **saves nothing**, so the form's `validate` runs either way ([catalog.ts](src/mcp/catalog.ts)). A dated snapshot — `CATALOG_AS_OF` is `'May 2026'` and the screen says so — and nothing in it is vetted or recommended. Endpoint liveness is unverifiable by any gate: §7 steps 72–75 |
| **One line for "what can this turn do?"** | ✅ **since** — checklist §10 | `summariseTools` over the three global switches, this conversation's server and skill counts and the plan-mode flag, in the ⋯ menu and again as the settings hub's subtitle ([builtins.ts](src/chat/builtins.ts)). Takes `plan` as an input rather than consulting the gate, because `plan.ts` imports `builtins.ts`; a tripwire in `builtins.test.ts` holds the duplicated wording in step |
| **A grouped, virtualised history drawer** | ✅ **since** — checklist §7 | *Pinned · Today · Yesterday · This week · Older* with counts, from the **same** `buildRows` the list screen uses, so a heading cannot disagree between the two; a search drops the headings for one relevance-ordered *Matches* run. `FlashList` with `getItemType` and `extraData={currentId}` replaced `filtered.map()` in a `ScrollView` ([drawerRows in list.ts](src/chat/list.ts), [Sidebar.tsx](src/components/Sidebar.tsx)). No per-row menu, deliberately. Frame rate and the two-axis gesture argument are §7 steps 69–71 |
| **A screen reader told when a reply lands** | ✅ **since** — checklist §12 | `"Reply ready, N words"`, announced once per finished turn — the *size*, not the text, because reading it aloud is `Read aloud`'s job and an announcement cannot be interrupted. The transcript carries **no** live region on purpose: one on streaming text makes TalkBack restart from the top on every token. `replyAnnouncement` mirrors `replyNotice` and the pair's invariant is tested — exactly one of the two speaks per turn ([notify.ts](src/lib/notify.ts)) |
| **A pending update applied without waiting for a cold start** | ✅ **since** — checklist §11 | `checkAutomatically: 'ON_LOAD'` already downloads and verifies; a *Restart to finish updating* row appears while `useUpdates().isUpdatePending` is true ([app/settings/index.tsx](app/settings/index.tsx)). Not a second update mechanism — doing nothing arrives at the same place, later — and it says an unsent draft is lost |
| **Being in Android's share sheet** (`ACTION_SEND`) | ❌ — the one genuine gap left | Not buildable from JavaScript: Android carries the payload in `EXTRA_TEXT`/`EXTRA_STREAM`, and both `Linking.getInitialURL()` and Expo Router's `+native-intent.tsx` see only `getIntent().getData()`. Needs a native dependency plus a manifest entry plus a **rebuild**, which is why it is flagged rather than half-built. *Open with* (`ACTION_VIEW`) does work — see the row above |
| **Landscape, large screens, predictive back, launcher shortcuts** | ❌ — flagged, not stubbed | Each is a one-line `app.json` change with real work behind it: every screen is written for one column, and `predictiveBackGestureEnabled` changes how all eight modals' `onRequestClose` behaves. All four are rebuilds |
| **Chat sharing by link** | ❌ | Not building — needs a server, and the app's premise is no server |

---

## Part 2 — Found while checking, not reported

**All five are closed.** Kept with the fix under each, because the reasoning is the useful part.

- **`app.json` and the changelog disagree about OTA updates.** `app.json` has
  `updates.enabled: true` with a live Expo URL; `CHANGELOG.md` states "There is no OTA channel
  (`updates.enabled: false`)". One of them is shipping a lie to whoever reads it next. Decide,
  then make both say it.
  → **Settled in favour of enabling**, and both now say so. `[1.0.0]`'s release facts still read
  *"OTA updates disabled"* because that is what 1.0.0 shipped; `[Unreleased]` records the change.
  The decision is recorded as remote-code trust taken deliberately, with three load-bearing
  mitigations — the channel is signed by Expo, `runtimeVersion` is `appVersion` so an update
  cannot cross a native boundary, and `fallbackToCacheTimeout: 0` means a slow or hostile network
  delays nothing. It is the only route a JavaScript security fix has to a hand-installed APK.
- **`RECORD_AUDIO` with no feature** — §6, repeated here because it is a release blocker rather
  than a feature request. → **Closed:** dictation and voice mode both use it (§6).
- **Tool calls resolve strictly sequentially** ([chat.ts:1132](src/stores/chat.ts:1132)), with a
  comment explaining why: two approval sheets cannot share a screen. Sound. But calls that are
  *already* approved (`always`) have no reason to queue, and a five-call turn currently takes
  five round trips of latency for no benefit. Fix: partition into approved and unapproved, run
  the approved set in parallel, keep the sheet-driven ones serial. → **Fixed as described.**
- **No indicator that a tool is running.** `live.phase` covers preparing / connecting / saving;
  a 40-second MCP call shows nothing. With more tools this becomes the most-seen state in the app.
  → **Fixed:** `StreamPhase` gained `'tools'` ([chat.ts:124](src/stores/chat.ts:124)), alongside
  `summarising` and `retrying`, so every wait the user can sit through now names itself.
- **`estimateToolTokens` gets no calibration.** Text estimates are corrected against the
  gateway's reported counts (`useCalibration`); the tool manifest — soon the largest part of the
  prompt — is not. Worth one sample per turn. *(Fixed in v1.1: its own residual-derived factor,
  and the manifest now reaches the history budget at all. See Status above.)*

---

## Part 3 — Order of work

Each numbered item is shippable on its own and each ends on green gates
(`pnpm gates`, plus `expo export --platform android` in CI).

1. **Release hygiene** — settle the name across all six places (with a backup reader that accepts
   both envelopes), settle the OTA contradiction, and either build voice or drop `RECORD_AUDIO`.
   Nothing else should ship before this.
2. **`/` commands** — the merged index, the sheet, the app commands. Plus `prompts/get` so MCP
   prompts stop being decoration. Highest ratio of felt improvement to code in this document.
3. **Built-in tools** — `write_file`, `fetch_url`, `read_mcp_resource`. This is the fix for "the
   model can't use tools": give it tools. Each is a small pure function plus a `resolveCall` branch.
4. **Document generation** — Markdown → PDF via `expo-print`, CSV via `write_file`, a file card
   in the transcript with Share and Open.
5. **Tool-loop repairs** — image results passed through, one retry on unparsed arguments, a
   Continue button instead of the round-cap sentence, parallel execution of pre-approved calls,
   a running indicator.
6. **Voice input** — hold-to-talk into the draft.
7. **UI pass** — glyphs to real icons, the twelve-item sheet split now that `/` carries four of
   them, resources pagination.
8. **Web search**, once 3 proves the tool path.

Items 1–8 all landed in v1.1. Everything marked v1.2 in the table above is out of scope here.

**What came after, and is not on this list.** Sections 1–7 and 10–12 of the Claude-parity checklist
landed on
top of items 1–8: message rendering (typewriter reveal, streaming affordances, a context menu that
opens where you pressed), inline visuals (charts drawn as views), reading a file another app hands
over, generating and editing Office documents, hands-free voice mode, a camera inside the app, a
history drawer grouped and virtualised by the list screen's own row builder, a bundled directory
of eleven tool servers with one line saying what the current turn can actually do, and a
platform-and-accessibility pass.
Together they closed the two reversals in Part 4 and ten rows in §7's table. They are tracked in
[06_Eng_Plan.md](docs/06_Eng_Plan.md) §4.5 as an out-of-order block. Sections 8 (sync — which needs
a server, and is on the PRD's non-goals list) and 9 (a cowork/agentic surface — a battery and cost
decision) both await a product decision, which is why 10 was taken out of order and why 11 and 12
followed it; **those two are now all that is left, and neither is a work item.**
Section 6 is the one that broke this list's best
property: every item in v1.1 and in Sections 1–5 shipped without a new native module, and `expo-camera`
does not, so the next release is an APK rather than a bundle. Sections 7, 10, 11 and 12 restored the
property
without
undoing that cost — none of the four added a dependency or any native code, so all reach an installed
build over
the update channel, but the APK is still owed for the camera. §11's findings say why that streak was
easier to keep than it looks: most of what the section asked for was already built, and the four items
that were not — the share sheet, launcher shortcuts, predictive back, landscape — each need a rebuild,
so all four were flagged rather than half-built.

## Part 4 — Not building, and why

Two of these five were reversed by the checklist work. The original reasoning is kept, with what
actually happened under it — a cut list that deletes its reversals reads as if the call were never
made.

- **Chat sharing by link** — needs a server. The app's whole security posture is that nothing
  leaves the device unasked. → **Still not building.**
- **Subagents** — a second model loop on a phone is a battery and cost decision the user has not
  asked to make. → **Still not building.** It is checklist §9 and unstarted.
- **A real shell on device** — not available on unrooted Android. The remote-MCP route in §4 is
  the honest version and it is documentation plus a renderer, not a platform fight.
  → **Still true**, and the renderer plus the docs page both shipped ([USAGE §15.1](docs/USAGE.md)).
- **`.docx` / `.pptx` writing in v1.1** — OOXML needs an XML writer we do not have. CSV and PDF
  cover the actual "give me a file" request; revisit when someone asks for Word specifically.
  → **Reversed.** The premise was wrong in one word: OOXML needs an XML *writer*, and for the
  subset a generated document actually uses, that is string templating plus the zip half `fflate`
  was already doing. `.docx`, `.xlsx` and `.pptx` all write, with no new dependency
  ([ooxml.ts](src/chat/ooxml.ts)).
- **Full-duplex voice mode** — depends on streaming audio the gateway does not expose. Hold-to-talk
  is 90% of the value for 10% of the work. → **Reversed, and the premise was wrong.** Hands-free
  voice mode does not need streaming audio at all: it is the recogniser and the TTS engine already
  on the device, taking turns. What it genuinely cannot be is *full*-duplex — the app listens or
  speaks, never both — so the shipped feature is honest about being half-duplex rather than
  claiming what the deferral said it would need (§6).

## Part 5 — New dependencies this implies

`expo-print` (PDF), `expo-speech-recognition` (voice input), `expo-sharing` (file hand-off —
`deliver.ts` reasoned it away for text, which stops applying for generated files), and
`react-native-webview` only if artifacts land in v1.2. All Expo-official except the last. Every
one of them is **native**, so a device running the v1.0 APK needs a rebuild, not an update.

**All four landed, including `react-native-webview` — artifacts came in v1.1, not v1.2.** The
rebuild requirement held: the `[Unreleased]` CHANGELOG entry is marked **needs a rebuild** and
none of it can travel over the update channel. Worth recording that the estimate was otherwise
right in the direction that matters — the four features the checklist added on top (inline
visuals, Office generation, file previews, voice mode) needed **no** new dependency at all: charts
are views and text, OOXML is `fflate`, previews reuse the WebView, and voice reuses the two OS
engines. `react-native-svg`, a chart library, an XML library and an audio library were each
considered and each declined. That is the bar for the next one.
