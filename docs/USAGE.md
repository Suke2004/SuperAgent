# Daily Use

A walkthrough of the app as it actually behaves. Everything here is on-device: no
account, no telemetry, and nothing but your own requests leaves the phone.

## 1. First launch

The app opens **straight into an empty chat** rather than a list — the thing you
almost always want is a new conversation. Past chats are in the drawer: swipe from
the left edge, or tap the history button in the header. The drawer is also where
rename, pin, tag, archive and delete live, by long-pressing a row.

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
the partial text and marks it aborted rather than throwing it away.

Long-press any message for: copy, **read aloud** (the system voice; choose it again
to stop), edit and resend, edit in place, regenerate, fork from here, exclude from
context, delete. Excluding keeps a message in the transcript but stops sending it —
the cheapest way to drop a wrong turn without losing the thread.

There is no in-app dictation, and none is needed: the keyboard's own microphone
types into the composer like any other text field.

The header menu carries the system prompt, model, provider profile, model controls,
skills, MCP servers, rename, tags, pin, **bring in a message** (quote from another
chat), the prompt library, export and delete.

## 4. Model and reasoning controls

Header menu → **Model controls**. Max output tokens, sampling, and reasoning:
Anthropic takes a thinking budget, OpenAI takes an effort level. Two rules are
enforced rather than explained after the fact — thinking cannot be switched off at
the top effort levels, and the thinking budget must leave room under `max_tokens`,
because on the Anthropic wire that number is the *total* output allowance.

Anything a model does not support is shown disabled with the reason, never hidden.
Wrong or missing capability data is editable under Settings → **Models**.

## 5. Attachments

The paperclip takes a photo, picks images, or attaches a document. Images are
resized before encoding and ingested one at a time — a 12 MP photo is otherwise a
multi-megabyte string in memory. If the model has no native document support the
composer says so *before* you send, because afterwards the only symptom is an
answer that ignored your tables.

## 6. Context pressure

The gauge under the composer measures against **usable** space (context window
minus reserved output), since the failure you actually hit is a truncated reply.
When a conversation outgrows it, the per-conversation strategy decides: warn,
drop oldest, or summarise into a rolling summary. Nothing is ever silently
dropped without a note in the transcript.

## 7. Skills

Settings → **Skills**. A skill is a name, a one-line description and a body of
instructions. Only names and descriptions go into the prompt; the body is sent
only when the model asks for it, so a dozen skills cost a couple of lines a turn.
Switch them on per conversation from the header menu.

Import a single `SKILL.md`, or a **zip** of them — a folder from a desktop client
imports in one go, with a name collision renamed rather than clobbering what you
have, and any member that is not a skill reported rather than silently dropped.
**Export all as zip** writes into a folder you pick (Downloads is fine); a single
skill exports through the share sheet.

Importing somebody else's skill runs their instructions in your conversations.
Read one before switching it on.

## 8. MCP servers

Settings → **MCP servers**. Add by URL — http(s) only, because a phone cannot
spawn the local processes stdio needs, and a field that can never work is worse
than an honest refusal. Sign in if the server wants OAuth (tokens go to the
Keystore beside the API key, so they are redacted from logs and exports from the
moment they exist), then choose which tools are offered.

Tool calls are approved mid-turn: allow once, always allow this tool, deny, or
never. The full arguments are shown. Leaving the screen resolves nothing — you
come back to the same question. Every failure, including a denial, comes back as a
tool *result*, so a refused call never costs you the conversation.

## 9. Prompts, memory, usage, backup

- **Prompt library** (Settings, or the header menu) — reusable prompts with
  `{{variable}}` placeholders, ranked by how often you use them.
- **Memory** — what the app has distilled about you, and the switch that stops it.
  Off means nothing is collected *and* nothing is sent. Anything containing what
  looks like a secret is dropped rather than stored redacted, and a new memory is
  confirmed before it is kept.
- **Usage** — tokens and estimated cost by day and by model, from the gateway's own
  reported numbers only. A gateway that reports nothing stores a zero, so totals
  are a floor and say so.
- **Backup and restore** — settings, provider metadata, model overrides, skills,
  prompts and MCP servers. Structurally never keys, tokens, conversations or
  memories. Restore merges and never overwrites; keys must be re-pasted.

## 10. Privacy and the app lock

Settings → **Privacy** → *Require unlock to open* puts the device's fingerprint,
face or PIN in front of the app, on launch and on every return from the background.
Off by default, and switching it on runs the prompt first — a sensor that does not
work cannot lock you out of your own conversations. The switch is disabled with the
reason if nothing is enrolled on the device.

It is a lock, not encryption. `expo-sqlite` offers no encrypted-database option, so
the transcript is plaintext on disk and root reads it without ever seeing the lock
screen. While the phone is locked, Android's own file encryption is what protects
it. Auto-backup is off, so it never leaves for Google Drive either.

The API key is separate and always was: it lives in the Android Keystore, is read
per request, and the in-memory copy is dropped when the app goes to the background.

## 11. Export and diagnostics

Header menu → **Export** — Markdown or JSON, to the share sheet or the clipboard.
Exports never carry attachment bytes and are redacted twice. A copy tells you the
clipboard keeps it until you copy something else: Android offers no "sensitive"
marker here, and clearing it on a timer would destroy whatever you copied next.

Settings → **Debug log** — requests, status codes, stream events and dropped
parameters, with the key redacted at the write boundary. No telemetry, no
analytics, no third-party crash reporting.

---

The app has been exercised on a physical Android device: keyboard insets under
edge-to-edge, FlashList anchoring during a live stream, markdown geometry, and the
attachment pipeline. Two things a device run cannot fix, both in `docs/flaws.md` §3:
a reply stops streaming if you background the app mid-turn (the partial text is kept
and marked aborted), and read-aloud plus the app lock are native modules that need
an APK rebuild to appear on an older build.
