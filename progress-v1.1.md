# SuperAgent — v1.1 plan

**Written:** 2026-08-31 · **Base:** `release/v1.0.0-prep` @ `bc88a47` · **Supersedes nothing** —
[progress.md](progress.md) stays the record of what v1.0 built; this file is only what comes next.

Every claim below was checked against the code, not remembered. Where a reported issue turned
out to be "never built" rather than "broken", it says so — that changes the fix from a bug hunt
into a feature.

---

## Status — 2026-08-31

Everything in Part 3, items 1–8, is implemented and on green gates (`pnpm gates`: typecheck, lint,
1281 tests, coverage thresholds). See [CHANGELOG.md](CHANGELOG.md) `[Unreleased]` for the
user-facing list. Nothing on this list was deferred.

How the last three landed, since they are the ones with a design worth recording:

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
  `citations` on text blocks is still not implemented; sources come from the result block instead,
  which is what the source list needs.
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

### 3. The model interacts with tools badly → four distinct causes, all real

- **Only two tool families exist.** No filesystem, no web, no execution, no time, no math. A
  model with `invoke_skill` and nothing else looks incompetent because it has nothing to be
  competent with. This is the dominant cause and item 2 and 4 below are its fix.
- **Tool results from images are thrown away.** `flattenToolResult`
  ([protocol.ts:294](src/mcp/protocol.ts:294)) turns non-text MCP content into a *description* of
  itself. A server that returns a screenshot returns, to the model, the sentence "an image".
  Every vision-driven MCP tool is therefore broken by design. Fix: pass image content through as
  a real `image` block when the model has vision (`capabilitiesFor` already knows), and keep the
  description as the fallback.
- **Tools are silently withheld under budget.** `selectTools`
  ([tools.ts](src/chat/tools.ts)) drops tools to fit a token ceiling and tells the model which
  ones went. That is the right design and it is invisible to the *user* — there is no indicator
  that this turn ran with half a manifest. With more tools coming, withholding becomes the
  common path. Fix: surface the withheld count in the transcript, not just in the system prompt.
- **The round cap ends the turn with a note asking the user to send again**
  ([chat.ts:1213](src/stores/chat.ts:1213)). Correct for runaway loops, wrong as the routine
  experience once tools multiply. Fix: raise the default, and make the note a **Continue** button
  rather than a sentence asking for a retype.

Also worth knowing: a truncated arguments blob is stored as `{ __unparsed: … }`
([chat.ts:199](src/stores/chat.ts:199)) and then handed to the server, which fails it. Retrying
the call once on a parse failure would be a few lines and would convert a dead turn into a
working one.

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
- **Twelve actions in one sheet.** The conversation menu carries system prompt, model, profile,
  controls, skills, servers, rename, tags, pin, reference, export and delete
  ([\[id\].tsx:776–843](app/chat/[id].tsx:776)). Nothing is one tap. `/` commands take the top
  four out of the sheet.
- **Send and attach are text glyphs, not icons** — `↑` and `+` rendered as `<Text>`
  ([Composer.tsx:131](src/components/chat/Composer.tsx:131),
  [:258](src/components/chat/Composer.tsx:258)). At large accessibility font sizes they grow and
  drift off centre inside a fixed 36dp disc.
- **MCP resources are capped at 20 with no way to see more**
  ([mcp.tsx:326](app/settings/mcp.tsx:326)).

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
| MCP connectors, remote, with OAuth | ✅ | — |
| Per-tool approval | ✅ | — |
| Usage and cost per turn | ✅ (beyond Claude) | — |
| Offline queue, app lock, encrypted DB | ✅ (beyond Claude) | — |
| Image + PDF + text attachments | ✅ | — |
| Read aloud (TTS) | ✅ | — |
| **Slash commands** | ✅ v1.1 | One list over prompt templates, skills, MCP prompts and app commands (§1) |
| **File / document generation** | ✅ v1.1 — md/txt/csv/json + PDF | `.docx`/`.xlsx` still open (§2 items 3–4) |
| **Voice input** | ✅ v1.1 — hold-to-talk into the draft | Full-duplex voice mode still open (§6) |
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
| **Native filesystem / bash** | ❌ | Not possible on device; §4 |
| **Docx / xlsx / pptx reading** | ✅ — read on device into text, no new dependency ([office.ts](src/chat/office.ts)) | Writing them is still open: OOXML needs an XML writer, and CSV plus PDF cover the "give me a file" request |
| **Chat sharing by link** | ❌ | Not building — needs a server, and the app's premise is no server |

---

## Part 2 — Found while checking, not reported

- **`app.json` and the changelog disagree about OTA updates.** `app.json` has
  `updates.enabled: true` with a live Expo URL; `CHANGELOG.md` states "There is no OTA channel
  (`updates.enabled: false`)". One of them is shipping a lie to whoever reads it next. Decide,
  then make both say it.
- **`RECORD_AUDIO` with no feature** — §6, repeated here because it is a release blocker rather
  than a feature request.
- **Tool calls resolve strictly sequentially** ([chat.ts:1132](src/stores/chat.ts:1132)), with a
  comment explaining why: two approval sheets cannot share a screen. Sound. But calls that are
  *already* approved (`always`) have no reason to queue, and a five-call turn currently takes
  five round trips of latency for no benefit. Fix: partition into approved and unapproved, run
  the approved set in parallel, keep the sheet-driven ones serial.
- **No indicator that a tool is running.** `live.phase` covers preparing / connecting / saving;
  a 40-second MCP call shows nothing. With more tools this becomes the most-seen state in the app.
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

## Part 4 — Not building, and why

- **Chat sharing by link** — needs a server. The app's whole security posture is that nothing
  leaves the device unasked.
- **Subagents** — a second model loop on a phone is a battery and cost decision the user has not
  asked to make.
- **A real shell on device** — not available on unrooted Android. The remote-MCP route in §4 is
  the honest version and it is documentation plus a renderer, not a platform fight.
- **`.docx` / `.pptx` writing in v1.1** — OOXML needs an XML writer we do not have. CSV and PDF
  cover the actual "give me a file" request; revisit when someone asks for Word specifically.
- **Full-duplex voice mode** — depends on streaming audio the gateway does not expose. Hold-to-talk
  is 90% of the value for 10% of the work.

## Part 5 — New dependencies this implies

`expo-print` (PDF), `expo-speech-recognition` (voice input), `expo-sharing` (file hand-off —
`deliver.ts` reasoned it away for text, which stops applying for generated files), and
`react-native-webview` only if artifacts land in v1.2. All Expo-official except the last. Every
one of them is **native**, so a device running the v1.0 APK needs a rebuild, not an update.
