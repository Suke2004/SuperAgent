# Daily Use

A walkthrough of the app as it actually behaves. Everything here is on-device: no
account, no telemetry, and nothing but your own requests leaves the phone.

## 1. First launch

The app opens **straight into an empty chat** rather than a list — the thing you
almost always want is a new conversation. Past chats are in the drawer: swipe from
the left edge, or tap the history button in the header. The drawer holds a wordmark,
an ACTIONS group, the history and an ACCOUNT footer, with the conversation you are in
marked by a soft fill and a clay bar down its left edge.

The history is cut into the same groups as the full list — **PINNED**, then TODAY,
YESTERDAY, THIS WEEK and OLDER, each with a count — so four hundred chats stay
navigable without reading a single title. Searching the drawer puts every hit in one
run under **MATCHES**, best first, because date headings over a ranked result only
bury the row you wanted. The search box empties itself when the drawer closes, so it
always reopens on the whole history.

On the **full list** — ACTIONS → *Chats* — a row slides left to uncover **pin, rename
and delete**, the three actions worth doing dozens of times a week. Long-pressing it
opens the full menu at the point you pressed, which is also the only version a screen
reader can reach. Those actions are deliberately not in the drawer: it is where you go
to *leave* for another chat, and a menu about one row is a menu about staying.

Before the first send, give it a key: header menu → **Provider profile**, or
Settings → **Providers**.

## 2. The key and the transport

Settings → Providers → the profile you want:

- **Wire format** — Anthropic or OpenAI. This is not cosmetic; it decides the base
  URL shape, and the two AgentRouter endpoints are **not** interchangeable:
  - Anthropic: `https://agentrouter.org` (no `/v1`) → `POST /v1/messages`
  - OpenAI: `https://agentrouter.org/v1` → `POST /v1/chat/completions`, `GET /v1/models`
- **API key** — stored in Android Keystore through `expo-secure-store`, never in
  app storage and never in a backup. The screen shows only a salted fingerprint, so
  two keys can be told apart without the key being readable anywhere.
- **Extra headers** — for gateways that want something more. `Authorization` is
  applied last and cannot be overridden here; a header whose *name* looks like a
  credential is refused, because this list is ordinary app storage.
- **Test connection** — four steps, each reported separately: base URL shape, then
  `GET /models`, then a one-token completion, then whether the gateway serves
  `/images/generations` at all. The last one is information about the gateway, not
  a requirement: it is probed with an empty body so nothing is generated and
  nothing is billed, and it never fails the test.

A failed step quotes the gateway's own words. A 401 from this gateway is
deliberately reported as one ambiguous conclusion naming both causes — a wrong key
and a client-allowlist rejection produce byte-identical bodies, so anything more
specific would be a guess.

## 3. Having a conversation

Type and send. While a reply streams, the button is **Stop**, and stopping keeps
the partial text and marks it aborted rather than throwing it away. Text is revealed
as it is written rather than in the lumps the gateway sends, at a pace chased from
however fast the model is actually going; a block too large to be typing — a
summarised history, a reconnect replay — appears at once instead.

Long-press any message for: copy, **read aloud** (choose it again to stop), edit and
resend, edit in place, regenerate, fork from here, exclude from context, delete. The
menu opens where you pressed. Excluding keeps a message in the transcript but stops
sending it — the cheapest way to drop a wrong turn without losing the thread.

While the model works, a pulsing three-dot indicator stands in for the reply and is
replaced by it. Thinking, tool calls and tool results are collapsed pills you can
open: a tool call reads as a sentence — *Searched the web*, with the query beside it —
with the raw name and full arguments behind the chevron, and a result says how many
lines came back and opens itself when it is an error. The label never claims the call
worked; the result below it is what says that.

The header menu carries the system prompt, model, provider profile, model controls,
skills, MCP servers, plan mode, projects, rename, tags, pin, **bring in a message**
(quote from another chat), the prompt library, files this conversation has made,
export and delete. Most of it is faster to reach with `/`.

## 4. Slash commands and mentions

Type `/` as the first character of an empty draft and one list opens over everything
reachable: app commands, your prompt templates, installed skills and prompts offered
by MCP servers. Keep typing to filter. `/` on its own opens the whole list, which is
the discovery path if you do not yet know what is in there.

The app commands are `/model`, `/system`, `/skills`, `/servers`, `/controls`,
`/files`, `/export`, `/reference` and `/attach`. A prompt template with
`{{variables}}` opens the fill form; an MCP prompt is fetched with `prompts/get` and
inserted as text.

`@` works inside a sentence rather than as the whole draft, over the same index and
ranking: generated files, installed skills, and connected servers. A file mention
attaches through the picker's own admission path, size ceiling included. Only a real
mention opens the list — `ada@example` does not.

## 5. Talking, and being talked to

**Dictation.** Hold the microphone in the composer and speak; let go and the words
land in the draft as editable text rather than being sent. Seeing what was heard
before it costs a turn is the point. On a device whose OS offers on-device
recognition, nothing is uploaded to do it. The permission is asked for the first time
you hold the button, and the app says what it is for.

**Read aloud.** Long-press any reply → *Read aloud*, using the voice and speed chosen
in voice mode. Choosing it again stops.

**Voice mode** is the button next to the microphone, and is a screen rather than a
control: no keyboard, a talk button, and the reply spoken back to you. Hold to talk,
let go, and the answer is read a paragraph at a time with the paragraph being read
highlighted. Long answers page sideways, three steps to a page, and each page scrolls.
The `+` adds a photo or a document without leaving the conversation.

Be clear about what the voices are: **five deliveries of your device's own
text-to-speech voice, not five recorded ones.** Buttery, Airy, Mellow, Glassy and
Rounded are pitch and rate settings on the system engine, and the picker says so on
screen. Four speeds — 0.75×, 1×, 1.25×, 1.5× — multiply the style's own rate, clamped
to what an engine will accept. Both choices are remembered.

Two consequences worth knowing. If the device has no text-to-speech voice installed
for its locale there is nothing to fall back on: install one from Android Settings →
Accessibility → Text-to-speech output. And the highlight moves a paragraph at a time
rather than a word at a time, because Android does not report word boundaries during
speech — a paragraph is one utterance, and the highlight advances when that utterance
finishes.

## 6. Model and reasoning controls

Header menu → **Model controls**, or `/controls`. Max output tokens, sampling, and
reasoning: Anthropic takes a thinking budget, OpenAI takes an effort level. Two rules
are enforced rather than explained after the fact — thinking cannot be switched off at
the top effort levels, and the thinking budget must leave room under `max_tokens`,
because on the Anthropic wire that number is the *total* output allowance.

Anything a model does not support is shown disabled with the reason, never hidden.
Wrong or missing capability data is editable under Settings → **Models**.

## 7. Attachments

The `+` takes a photo, picks images, attaches a document, or attaches a file this
conversation already produced. Images are resized to 1568px on the long edge and
recompressed down a quality ladder before encoding, and ingested one at a time — a
12 MP photo is otherwise a multi-megabyte string in memory.

**The camera.** *Take a photo* opens a viewfinder in the app rather than handing off to
the system camera, and the reason is the review strip: photographing a page usually means
taking three of them and keeping the one that is in focus. Press the shutter as many times
as the message has room for, tap any thumbnail to drop it, then *use*. The front/back
switch and the flash button are both live, and the flash offers only what the facing side
has — `off → auto → on` on the back, `off → screen flash` on the front, because there is
no lamp on the front of a phone.

Nothing is encoded while you are shooting. Each press writes a full-resolution JPEG into
the app's cache and nothing else; the whole session goes down the resize ladder in one
pass when you press *use*, which is what keeps a single bitmap in memory no matter how
many photos were taken. Closing the camera, or dropping a shot from the strip, deletes
that file immediately — a photo taken here is never added to your gallery, and
`expo-media-library` is not a dependency, so the app has no way to put it there.

Two things the camera deliberately does not do: no barcode or QR scanning (the ML Kit
dependency is switched off in the config plugin, which keeps it out of the APK), and no
document edge detection, deskew or crop.

Documents are read **on the device**, no server involved:

| Format | Read as |
| --- | --- |
| PDF | Sent as a document block where the model takes one; text otherwise |
| `.txt`, `.md`, `.csv`, `.json`, code | Text |
| `.docx` | Paragraphs, headings and tables in order |
| `.xlsx` | Tab-separated cells under each sheet name |
| `.pptx` | One section per slide |

An Office file is a zip of XML and the reader is ours, so the composer says what the
format loses before you send: layout, styling, images, cell formats and formulas —
values, not the formula that produced them. Text extracted from any document is capped
at 120,000 characters, and an elision is stated rather than silent.

The ceilings, all enforced before the send rather than after:

| Limit | Value | Why |
| --- | --- | --- |
| Per conversation | **20 files** | The number the Claude apps use. Every attachment is re-sent with every later turn, so this is a bill as much as a limit. |
| Per message | 8 files | |
| One image | ~1.1 MB after resizing | It is base64 in the request body |
| One PDF | 8 MB | |
| One Office file | 4 MB | |
| One text file | 1 MB | |

The attach sheet says how many slots are left and disables what will not fit, counting
everything already sent in the conversation as well as what is staged. If the model has
no native document support the composer says so *before* you send, because afterwards
the only symptom is an answer that ignored your tables.

**A file from another app.** SuperAgent appears in Android's "Open with" list for PDFs,
text, JSON, XML, images and the three Office formats. Picking it opens a new
conversation with the file staged under its own name, ready to send. Only a
`content://` URI from the system provider is accepted; a `file://` path is refused with
the reason on screen, because such a path can name this app's own private storage,
including the encrypted database. The share sheet's *send* action is a different
Android intent and is **not** handled — React Native never exposes the file it carries,
and the app does not pretend otherwise.

## 8. Files the model writes

Ask for a file and you get one. `write_file` produces Markdown, text, CSV, JSON or
code; `create_pdf` renders Markdown through the platform's own print engine;
`create_document` writes a real `.docx`, `.xlsx` or `.pptx` — headings, paragraphs,
bold, italics, code, tables and bullets, with each table becoming a sheet in a workbook
and each `##` becoming a slide in a deck. Naming a format that does not exist is
refused with the list rather than guessed at; leaving it out gives you `.docx`.

Each file lands as a card in the transcript. **Open** shows it inside the app:

| The file | What Open does |
| --- | --- |
| Text, Markdown, CSV, JSON, code | Shows it, and lets you edit and save back over it |
| `html`, `svg` | Renders it in the artifact preview |
| `.docx`, `.xlsx`, `.pptx` | Shows the words, read-only |
| Anything else | Hands it to another app |

An Office file is read-only on purpose and says so: the reader recovers the words, not
the layout, so saving an edit would quietly delete the formatting.

**Save to a folder** writes a copy wherever the system folder picker points — Downloads
is fine. If no folder is granted it falls back to the share sheet, which is the same
hand-off **Share** does. `/files` lists everything a conversation has produced, and
`@` will attach one back into the next message.

## 9. What a reply can contain

Beyond text and headings:

- **Code**, syntax-highlighted, with copy. A `html` or `svg` fence also gets
  **Preview**, which renders it beside the conversation in a WebView with no network,
  no storage and no way back into the app; any navigation away from that document is
  refused and reported.
- **Charts.** A ` ```chart ` fence draws a bar, line or scatter plot from JSON — the
  app's own `{type, labels, series}`, a Chart.js-shaped `{type, data: {labels,
  datasets}}`, or a bare `{type, labels, data}`. Drawn with plain views and text, so
  there is no chart library and nothing executes. Up to six series, forty bars or four
  hundred points; each series takes a colour that clears 3:1 against the page in both
  light and dark and differs in lightness as well as hue, so the lines stay
  distinguishable without relying on colour alone. A spec it cannot draw falls back to
  the code block with the reason printed above it.
- **Diagrams** from a ` ```mermaid ` fence, and **maths** from LaTeX.
- **Tables**, which scroll sideways rather than squeezing.
- **Terminal output** — see §15.1.
- **Sources**, where the model searched or fetched: a numbered chip per site, labelled
  by domain, opening in the browser through the same allowlist as any markdown link.
  An export keeps them with the quoted passage.

## 10. Built-in tools

Settings → **Built-in tools**, which is a screen of its own. Three tools are always
offered and have no switch, because they only ever write into the app's own directory
and nothing leaves it until you pick a destination: `write_file`, `create_pdf` and
`create_document`. The screen says that rather than showing three switches that are
always on. The rest are decisions:

| Tool | Default | What it is |
| --- | --- | --- |
| `read_mcp_resource` | on | Reads a resource from a server you already added |
| `fetch_url` | **off** | Reads a web page. Re-checks the address it *landed* on, so a public host cannot redirect the fetch onto a private one. Its output is untrusted text entering the context window. |
| `run_code` | **off** | JavaScript in a WebView of its own: no network, no storage, no bridge into the app, `console.log` captured, given up on after five seconds. A calculator, not a shell. |
| Web search | **off**, Anthropic only | Runs on the provider's side. Billed per search, and the results are untrusted text. |

These three switches are **global** — on for every conversation — and they live here
only. A conversation's ⋯ menu has a **Tools** row that reads out what the current turn
can actually do (*files, PDFs and documents · web pages · 12 tools from 2 servers · 3
skills*) and, when tapped, brings you to this screen rather than offering a second copy
of the same switch. Servers, skills and plan mode are the per-conversation half of that
line and are set where they belong: the ⋯ menu.

## 11. Plan mode

A per-conversation toggle in the header menu. Reading still works, so a plan is built
on what is actually there; writing a file, rendering a document and every connected MCP
tool are refused with an instruction to write out the steps instead. The refusal is a
gate in the tool router rather than a line in the system prompt, so a tool added later
inherits it without being told. The **Tools** row reflects it too: while plan mode is on
it reads *writing blocked* and reports server tools as blocked, while `web pages` and
`code` stay — because plan mode blocks by effect, and those two read.

## 12. Projects

Settings → **Projects**. A project groups conversations around one piece of work and
lends all of them a set of instructions and reference documents — the same formats §7
accepts. Join or leave from a conversation's header menu, and filter the conversation
list by project, where a new chat inherits whichever project is showing.

Order in the prompt is fixed: project instructions, then the conversation's own system
prompt, then the knowledge documents — fenced, under their own heading, with an
explicit note that directions written inside them are source material rather than
instructions to follow. Conversations outlive their project: deleting one unfiles its
chats and keeps them.

## 13. Context pressure

The gauge under the composer measures against **usable** space (context window
minus reserved output), since the failure you actually hit is a truncated reply.
When a conversation outgrows it, the per-conversation strategy decides: warn,
drop oldest, or summarise into a rolling summary. Nothing is ever silently
dropped without a note in the transcript.

The tool manifest counts against the same budget — a conversation with two chatty MCP
servers spends real context on tool definitions before a word is said. When tools have
to be dropped to fit, the transcript says how many, not just the system prompt.

## 14. Skills

Settings → **Skills**, or `/skills` to switch them on for one conversation. A skill is
a name, a one-line description and a body of instructions. Only names and descriptions
go into the prompt; the body is sent only when the model asks for it, so a dozen skills
cost a couple of lines a turn.

Import a single `SKILL.md`, or a **zip** of them — a folder from a desktop client
imports in one go, with a name collision renamed rather than clobbering what you
have, and any member that is not a skill reported rather than silently dropped.
**Export all as zip** writes into a folder you pick (Downloads is fine); a single
skill exports through the share sheet.

Importing somebody else's skill runs their instructions in your conversations.
Read one before switching it on.

## 15. MCP servers

Settings → **MCP servers**, or `/servers` to choose which ones a conversation may call.
Two ways in. **Browse connectors** opens a short built-in list of servers you may already
use — DeepWiki, Context7, Cloudflare docs, Hugging Face, Stripe, GitHub, Sentry, Notion,
Linear, Jira and Confluence, Asana — with a search box, a note on each saying whether it
needs an account, and an *Added* badge on the ones you already have. The list leads with
the three that need no sign-in at all, so the first one you try works on the first tap.
**Add by URL** is the other way, and it is the same form: tapping a connector only
*prefills* it, so you see and confirm the URL before anything is saved.

Two things the connector list is honest about. It is a **snapshot**, dated on screen, of
addresses other people control — if connecting fails, the entry has gone stale and the
note names the vendor's own documentation page to check. And nothing in it is a
recommendation; it is a list of servers that exist, alongside a line saying what each one
can see once you connect it.

Either way in, it is http(s) only — a phone cannot spawn the local processes stdio needs,
and a field that can never work is worse than an honest refusal. Sign in if the
server wants OAuth (tokens go to the Keystore beside the API key, so they are redacted
from logs and exports from the moment they exist), then choose which tools are offered.
Nothing is offered by default.

Tool calls are approved mid-turn: allow once, always allow this tool, deny, or
never. The full arguments are shown. Leaving the screen resolves nothing — you
come back to the same question. Every failure, including a denial, comes back as a
tool *result*, so a refused call never costs you the conversation. Calls you have
already always-allowed run in parallel; anything still needing a sheet stays in order,
because two sheets cannot share a screen.

A server's **prompts** are usable, not just listed — they appear in the `/` list. Its
**resources** can be read by the model through `read_mcp_resource`, and a server
offering hundreds of them is counted and opened in full on request rather than cut off
at twenty.

### 15.1 A shell, on a machine that has one

An unrooted Android phone has no `git`, `node` or `python` and cannot be given one:
there is no shell to hand out, and the app can reach its own sandbox and whatever you
pick in the document picker, not the filesystem. The honest version of a terminal is
therefore a shell **somewhere else**, reached over MCP.

Run an MCP server on the laptop or VPS that owns the work — any server exposing a
`run_command`-style tool — put it behind HTTPS with authentication, and add its URL in
Settings → MCP servers. Nothing about it is special to this app: the tool is approved
mid-turn like every other, and `always` is a decision to let a model run commands on
that machine unattended, so it is worth keeping to a tool that cannot do damage.

What the app adds is the reading. A result carrying ANSI colour or a carriage-return
redraw is rendered as a terminal rather than a code block: colours read rather than
printed as `[0;32m`, cursor and mode codes dropped, a progress bar showing its last
state, tabs aligned to eight columns, and long output kept from the end with the
dropped line count stated. **Copy** gives the text without the escapes, and so does a
Markdown export; the JSON export keeps the bytes exactly as the server sent them.

Full-screen programs — `vim`, `top`, anything that redraws in place — are not
emulated. They arrive as legible plain text instead of a pretend screen. Prefer the
non-interactive form (`git --no-pager …`, `top -b -n1`).

## 16. Prompts, memory, usage, backup

- **Prompt library** (Settings, or `/`) — reusable prompts with `{{variable}}`
  placeholders, ranked by how often you use them.
- **Memory** — what the app has distilled about you, and the switch that stops it.
  Off means nothing is collected *and* nothing is sent. Anything containing what
  looks like a secret is dropped rather than stored redacted, and a new memory is
  confirmed before it is kept.
- **Usage** — tokens and estimated cost by day and by model, from the gateway's own
  reported numbers only. A gateway that reports nothing stores a zero, so totals
  are a floor and say so.
- **Backup and restore** — settings, provider metadata, model overrides, skills,
  prompts, projects and MCP servers. Structurally never keys, tokens, conversations or
  memories. Restore merges and never overwrites; keys must be re-pasted.
- **Update** — this section appears *only* when a new version has already been downloaded
  in the background, and it holds one row: *Restart to finish updating*. Tapping it
  restarts the app into the new version. Ignore it and nothing is lost — the update
  applies by itself the next time the app starts cold. It is there because an app you
  never fully close can hold a downloaded fix for days without ever applying it.

## 17. Privacy and the app lock

Settings → **Privacy** → *Require unlock to open* puts the device's fingerprint,
face or PIN in front of the app, on launch and on every return from the background.
Off by default, and switching it on runs the prompt first — a sensor that does not
work cannot lock you out of your own conversations. The switch is disabled with the
reason if nothing is enrolled on the device.

It is a lock, not encryption — but the database is encrypted too, separately: the
whole SQLite file is AES-256 under SQLCipher, keyed from the Android Keystore, so
root reads ciphertext rather than your transcript. The lock is what stops someone
holding your unlocked phone from opening the app. Auto-backup is off, so the file
never leaves for Google Drive either. Clearing the app's data destroys the key, and
with it the conversations — there is no escrow copy.

The API key is separate and always was: it lives in the Android Keystore, is read
per request, and the in-memory copy is dropped when the app goes to the background.

Files the model writes live in the app's own directory, inside the same sandbox, and
are removed with the app. A copy you save to a folder is outside all of that and is
yours to manage.

## 18. Accessibility

- Every control has a screen-reader label, and a disabled one explains itself rather
  than going quiet. Icons are hidden from the reader on purpose — the label lives on the
  control, so a row does not announce "settings icon, Settings, button".
- Icons do not grow with the system font scale, because a glyph in a fixed disc that
  grows clips against it. Everything an icon *means* is in the label, which does scale.
- **Reduce Motion** is honoured as a distinction rather than a switch. Decorative
  motion — a stagger, a pulse, a press scale — collapses to a single frame. Positional
  motion keeps its direction and only shortens, because when a sheet slides up from the
  bottom edge the slide is what says "this came from down there and swiping down puts it
  back". The setting asks for less movement, not for less comprehensible software.
- Haptics fire on activation rather than on touch: a finger landing on a button inside a
  scroller fires a press and then cancels, and there is no way to un-buzz. Destructive
  confirmations buzz a warning on the confirm button, not on the menu item that opens
  the dialog — the tap that opens it is reversible and the tap that dismisses it is not.
- A swipe-to-reveal row is a shortcut, never the only route: everything it uncovers is
  also in the long-press menu, which is what a screen reader reaches.
- **You are told when a reply lands.** With a screen reader running and the app in front
  of you, the end of a turn is announced once — *"Reply ready, 214 words"* — because a
  reply that arrives silently is a reply you have to keep checking for. It is announced
  once, at the end, and not while the text is streaming: a screen reader re-reads a
  changing region from the top, so announcing a stream would read the answer from the
  beginning several times a second. If the app is in the background instead, the same
  event arrives as an ordinary notification. Never both.
- Text fields and labels grow with the system font scale. A few glyphs that live in
  fixed-size boxes — the `＋` and `−` on a stepper, the send arrow — deliberately do not,
  because at the largest scale they would grow past the box and clip; the words beside
  them scale as normal.
- **Read aloud** and **voice mode** exist for reading a long answer without looking at
  it; dictation exists for writing one without typing.
- There is no haptics switch and no notification switch in this app, on purpose. Android
  already has both — *Touch feedback* in system settings, and the app's notification
  channel in the app info screen — and a second copy here could disagree with the one you
  already set.

## 19. Export and diagnostics

Header menu → **Export**, or `/export` — Markdown or JSON, to the share sheet or the
clipboard. Exports never carry attachment bytes and are redacted twice. A copy tells you
the clipboard keeps it until you copy something else: Android offers no "sensitive"
marker here, and clearing it on a timer would destroy whatever you copied next.

Settings → **Debug log** — requests, status codes, stream events and dropped
parameters, with the key redacted at the write boundary. No telemetry, no
analytics, no third-party crash reporting.

---

The app has been exercised on a physical Android device: keyboard insets under
edge-to-edge, FlashList anchoring during a live stream, markdown geometry, and the
attachment pipeline. Things a device run cannot fix, all in `docs/flaws.md` §3:

- A reply stops streaming if you background the app mid-turn. The partial text is kept
  and marked aborted, and the conversation is queued for retry.
- Dictation, read aloud, the app lock, icons, blur, gestures and artifact previews are
  native modules. An APK built before any of them lacks that feature until it is
  rebuilt — an over-the-air update carries JavaScript only, and cannot cross that line.
- The `+` in "Take a photo" opens a viewfinder inside the app, and that whole screen is a
  native module: an APK built before 2026-09-02 does not have it, and no update can add it.
  There is no barcode mode and no document scanning — a photograph of a page goes to the
  model as a photograph of a page.
- Saving an image goes through the share sheet, not the gallery — there is no one-tap
  "Save to Photos" without `expo-media-library`. A photo taken in the camera is not kept
  either: the file lives in the app's cache until the message is built, then is deleted.
- The connector list in Settings → MCP servers is a dated snapshot of addresses other
  people control, filled into the form for you rather than verified. If one fails to
  connect, the entry has gone stale — the note beside it names the vendor's own page to
  check, and the fix belongs in the app, not in a URL you retype every time.
- **The app is not in the Android share sheet.** You can open a file *into* it — *Open
  with → SuperAgent* from a file manager — but you cannot share *to* it from another app.
  Android hands a shared file to an app through a channel that JavaScript cannot read, so
  this one needs a new build rather than an update.
- **Portrait only**, and back is a plain gesture rather than the animated preview Android
  14 can show. Both are build-time settings, so neither can arrive over an update.
- Everything in §18 is written into the app and read back in code review, but **it has not
  yet been walked with TalkBack on a real device.** If a label reads wrongly or the focus
  order jumps, that is a bug worth reporting rather than something already known.
