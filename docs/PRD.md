# SuperAgent Product Requirements Document

## 1. Product Summary

SuperAgent is a personal Android chat client for an AgentRouter gateway that exposes
Anthropic-compatible and OpenAI-compatible APIs. It provides a fast, local-first
conversation experience while exposing model and reasoning controls that are often hidden
by hosted clients, and it does the work a desktop client would do — read a file, write
one, draw a chart, run a tool, speak a reply — on the device.

The name comes from one constant (`src/lib/app.ts`). The package slug
`agentrouter-mobile`, the Android package `org.lyric.agentrouter` and the `jarvis://`
scheme keep their original values: those are identity rather than presentation, and
changing them orphans installs and OAuth redirects.

The product is for one technically capable owner. It is not intended for Play Store
distribution, multi-user accounts, or a hosted backend.

## 2. Goals

- Make streaming conversations reliable and responsive on Android.
- Support both gateway wire formats without leaking transport differences into the UI.
- Keep API keys and user data on-device, and keep the data encrypted at rest.
- Provide explicit control over model, reasoning, sampling, context, and message history.
- Make gateway failures diagnosable by preserving the gateway's own error text.
- Remain usable on mobile networks with retry, failover, and efficient rendering.
- Let a reply do more than print text: files, documents, charts, tools and speech.
- Contain everything a model produces rather than trusting it.

## 3. Non-Goals

- Play Store publication or account-based synchronization.
- Server-side storage, telemetry, analytics, or third-party crash reporting.
- Local stdio MCP servers. Android cannot spawn those processes; MCP is network-only.
- Spoofing an approved client to bypass gateway allowlists.
- A hosted text-to-speech voice. Spoken replies use the device's own engine.
- Editing a generated Office file in the app. The reader recovers words, not layout, so
  a save would silently drop formatting.

## 4. Target User and Primary Flows

The target user owns an AgentRouter token and wants a controllable personal client.

1. Configure AgentRouter by selecting Anthropic or OpenAI and pasting a token.
2. Optionally add a custom compatible provider with a base URL and token.
3. Test the connection and discover models.
4. Start a conversation, choose a model, adjust generation controls, and stream a reply.
5. Search, organize, edit, regenerate, fork, export, and inspect conversations.
6. Attach an image, a PDF, a text file or an Office document — or hand one in from
   another app through an "open with" intent.
7. Dictate a message, have a reply read aloud, or hold a hands-free conversation in
   voice mode.
8. Let the model write a file, a PDF or a Word/Excel/PowerPoint document, then preview
   it and save a copy to a folder.
9. Group related conversations into a project with shared instructions and documents.
10. Add skills and MCP servers — from a bundled directory or by URL — approve tool calls,
    check in one line what the current turn can do, and use plan mode when a turn should
    read but not write.

## 5. Functional Requirements

### Provider and model management

- Ship AgentRouter as the default setup option.
- Use `https://agentrouter.org` for Anthropic and `https://agentrouter.org/v1` for OpenAI.
- Permit custom named provider profiles with transport, base URL, fallback origin, headers, default model, and connection test.
- Store only key presence and a safe fingerprint in application state.
- Discover models at runtime; allow manual capability and pricing corrections.

### Chat

- Create, open, rename, tag, pin, archive/delete, and fork conversations.
- Stream replies incrementally with an actual abort action.
- Reveal a stream by writing rather than by appearing: pacing is a property of the
  transcript, not of the network.
- Support edit-in-place, edit-and-resend, regenerate with kept alternatives, delete,
  copy, and context exclusion.
- Persist system prompts, model selection, sampling parameters, reasoning configuration, and context strategy per conversation.
- Render Markdown, code highlighting, LaTeX, tables, charts, terminal output, thinking
  blocks, usage, cost, errors, and stop reasons.
- Offer every row action from a long-press menu that opens where the finger was, and
  from a swipe, and from a visible control — a gesture is never the only route.
- Reach the history from inside a conversation without leaving it: a drawer that groups
  chats by when they were last touched, counts each group, searches them, and stays
  smooth at hundreds of rows. The drawer opens and starts conversations; the actions that
  change or destroy one live on the full list, in one place, rather than in two.

### Attachments and files

- Accept images, PDFs, plain text and the three Office formats, with a stated ceiling
  per file, per message and per conversation, and an explicit reason when one is hit.
- Downscale an oversized image through a quality ladder rather than refusing it.
- Accept a file handed in by another app only as a `content://` URI from a system
  provider; refuse `file://` with the reason shown.
- Let the model write a file, a PDF, or a `.docx`/`.xlsx`/`.pptx`, into the app's own
  document directory under a sanitised name.
- Preview a generated file according to what it is, and offer a copy to a folder the
  user picks, with the share sheet as the fallback.
- Take photographs without leaving the app: a viewfinder, several shots per message, and
  a review strip that drops one by tapping it. Nothing is encoded until the user is
  finished, and an abandoned shot is deleted rather than left in the cache.
- Ask for the camera on the screen that needs it, not at the sheet, and turn a permanent
  refusal into the same *Open Settings* action the pickers use.

### Speech

- Dictate into the draft with the OS recognizer, on-device where the OS offers it.
- Read a reply aloud in one of five styles, at one of four speeds, with the spoken run
  highlighted in the transcript.
- Run a hands-free voice mode that listens, sends, speaks the reply, and listens again.
- Say plainly that the styles are settings on the device's own voice, not five
  recordings, and say when no voice is installed rather than falling silent.

### Tools

- Offer built-in tools for writing a file, a PDF, a document, fetching a URL, reading an
  MCP resource, and running code.
- Default the three tools that reach outside the app or execute model output — web
  fetch, web search, `run_code` — to off, and keep those three switches in **one** place,
  not once per conversation and again globally.
- Say which tools have no switch and why: the three writers reach nothing but this app's
  own cache, so there is no access to withhold.
- Ask before running a tool the user has not blanket-approved, and record the standing
  decision per tool.
- Gate writing tools behind plan mode in the router, not in the system prompt, so a tool
  added later inherits the refusal.
- Return every outcome — including a refusal and a denial — as a tool *result*, so a
  conversation is never left holding a call with no answer.
- Answer "what can this turn actually do?" in one line, in the conversation, from what is
  really configured — the global switches, this conversation's servers and skills, and
  whether plan mode is on.
- Let a user connect a well-known tool server without knowing its URL, from a short
  bundled directory that says how old it is, what each server can see, and that nothing
  in it is a recommendation. Tapping an entry fills the same add form as any other
  server; it never saves on the user's behalf.

### Reliability and diagnostics

- Retry 429 and 5xx responses with capped exponential backoff and jitter.
- Fail over only on a network failure before the first stream event.
- Never retry ordinary 4xx responses.
- Surface gateway error messages verbatim and distinguish authentication from client rejection.
- Redact secrets at the log boundary.
- Correct the composer's token estimate against what the gateway reports, per model,
  rather than shipping a better guess.

## 6. UX Requirements

- Android-first, portrait-oriented, light/dark/system themes.
- Dense but readable settings and conversation screens.
- Every unavailable control explains why it is disabled.
- Streaming must not jump the transcript or re-render once per token.
- Search clearly distinguishes local filtering from message-content search.
- Destructive operations require confirmation, and confirm with a haptic.
- The app must remain useful when a model registry is stale or a gateway is unreachable.
- Every duration, colour and icon comes from one vocabulary — `src/constants/animations.ts`,
  the palette, `ICONS` — so the same idea cannot look different on another screen.
- Reduce Motion collapses decorative motion and shortens positional motion, but never
  removes direction: a sheet that appears instantly no longer says which edge it came
  from or which way to throw it back.
- Waiting says what it is waiting for: a skeleton with the shape of the content, or a
  labelled step, not a spinner.
- A screen reader is told when a reply lands, **once**, at the end of the turn, and never
  during the stream. The same event reaches a backgrounded app as a notification instead;
  exactly one of the two fires per turn.
- The system font scale is respected everywhere text is read. The only elements exempt are
  glyphs in fixed-size boxes that would clip at the largest scale — the words beside them
  scale as normal, and the meaning lives on the label rather than the glyph.
- A downloaded update does not wait for an unprompted cold start: while one is pending the
  app offers a restart, and says that is what it does.

## 7. Security and Privacy Requirements

- Android API keys live only in `expo-secure-store`/Android Keystore and an in-memory cache.
- Keys must not enter Zustand persistence, AsyncStorage, logs, exports, or source control.
- The database is encrypted at rest (SQLCipher, AES-256) under a Keystore key, and is
  not backup-eligible.
- An optional app lock gates the app behind the device biometric or PIN. It is a separate
  control from encryption: the database key is not auth-gated, or the send queue would
  lose database access while the device is locked.
- No telemetry, no analytics, no external crash reporting, no `eval`.
- Network requests use the honest static user agent `AgentRouterMobile/1.0 (Android)`.
- HTTPS only, enforced by the app's URL validation and by a release network security
  config that refuses cleartext and trusts system CAs only.
- Untrusted markup and model-written code load only in a sealed WebView: `default-src 'none'`,
  no network, no storage, no bridge back into the app, navigation away refused.
- An inbound file from another app is refused unless it is a `content://` URI from a
  system provider.

## 8. Success Criteria

- TypeScript, ESLint, and the complete Jest suite remain green after every phase.
- Streaming, abort, search, context handling, and transport adapters pass automated tests.
- The app exports for Android (`npx expo export --platform android`) and builds as a
  preview APK through EAS.
- A physical Android verification pass confirms keyboard insets, stream anchoring,
  Markdown geometry, incremental rendering, gestures, speech, and file hand-off — the
  things no unit test on a Node runner can see. It also has to confirm the accessibility
  claims, because a screen reader is the one part of this product that no gate in the
  repository can exercise: a wrong label is a confident wrong answer, not a visible
  absence. Steps 76–79 of [07_Deployment.md](07_Deployment.md) §7 are that check.

## 9. Delivered and Planned

Every phase originally listed as planned has shipped: multimodal input and sharing
(Phase 3), `SKILL.md` skills with progressive disclosure (Phase 4), network MCP with
OAuth/PKCE, discovery, approvals and agentic tool loops (Phase 5), and the prompt
library, exports, backup/restore, usage dashboard, failover indicator and offline queue
(Phase 6). So has the whole v1.1 list: projects, plan mode, artifacts, the code sandbox,
document generation, web search, file reading and writing, inbound file intents,
dictation, voice mode and the in-app camera. Since then a history drawer, the connector
directory — which turns MCP from a feature that needs a URL into one that needs a tap — and
a platform-and-accessibility pass have landed on top. That last one was mostly a survey:
the Android integration was already largely right, and it closed three gaps rather than
building a subsystem — a screen reader is now told when a reply lands, a downloaded update
can be applied on request instead of whenever the OS next kills the app, and the settings
steppers no longer clip at the largest system font size.

What is not built, and is a product decision rather than an oversight:

- **Barcode, QR and document scanning.** The camera is a camera. `barcodeScannerEnabled`
  is switched off in the `expo-camera` config plugin so ML Kit stays out of the APK, and
  there is no edge detection, deskew or crop — a photograph of a page is sent as a
  photograph of a page.
- **Sync.** Nothing leaves the device, so there is nothing to reconcile. Backup and
  restore is the deliberate substitute. Adding it is a premise change, not a feature: it
  needs a server this project does not have.
- **A cowork/agentic surface** beyond the tool loop that already exists. The loop is
  bounded and each step is approvable; a long-running autonomous agent on a phone is a
  battery and cost decision, and it has not been asked for.
- **A connector that this app authored.** The directory lists servers other people run,
  and adding one is an entry in `CONNECTORS` — never a code path. Nothing in the list is
  vetted or recommended by this project, and the approval gate, not the list, is what
  stands between the model and a tool.
- **Background streaming.** A reply stops when the app is backgrounded; the partial is
  kept and marked aborted. A foreground service needs the bare workflow.
- **In-app duplicates of controls Android already owns** — no haptics switch, no
  notification switch. A second copy can disagree with the one the user already set.

What is not built and is *not* a product decision — four platform affordances that each
need a rebuild, so none of them can arrive over an update, and none is worth a build on its
own:

- **Sharing *to* this app** from the Android share sheet. Opening a file *into* it works
  (*Open with*); `ACTION_SEND` delivers its payload through a channel JavaScript cannot
  read, so it needs a native dependency and a manifest entry. This is the one remaining
  gap against the parity checklist that is not a product decision.
- **Landscape.** The transcript would reflow; the composer, attach sheet and viewfinder all
  assume a tall window, so it is a layout pass rather than a flag.
- **Predictive back**, and **launcher shortcuts** (long-press the icon → *New chat*).

Known limitations that the product states rather than hides are kept in
[flaws.md](flaws.md); anything user-visible is also in [USAGE.md](USAGE.md).
