# AgentRouter Mobile — Build Progress

**Last updated:** 2026-08-21
**Gates, all green as of this writing:**

```bash
npx tsc --noEmit && npx eslint src app && npx jest
```

→ tsc clean, eslint clean, **658 tests / 16 suites** in ~3.4 s. 22,309 lines across `src` and `app`.

Run all three at the end of every phase and fix what they surface. Don't pause between phases to ask whether to continue.

---

## Read this first — things that are expensive to get wrong

### The gateway exposes two base URLs that are NOT interchangeable

| Transport | Base URL | Endpoints |
|---|---|---|
| Anthropic-compatible | `https://agentrouter.org` (**no** `/v1`) | `POST /v1/messages` |
| OpenAI-compatible | `https://agentrouter.org/v1` | `POST /v1/chat/completions`, `GET /v1/models` |

Backup/parity domain: `https://ps.air-outer.com`. Auth is a Bearer token from the gateway console, same for both.
Default model `claude-opus-4-6`; also `claude-opus-4-7`, `claude-opus-4-8`. Everything else is discovered at runtime from `GET /v1/models` — do not hardcode a model list beyond those three.

This is already encoded as two distinct transports in `src/transports/`. Don't collapse them: they diverge on message shape, system-prompt placement, image encoding, streaming event format, tool-call schema, and stop reasons. All of that belongs in the adapters, never in the UI.

### Gateway quirks, all already handled — don't regress them

- Errors come back `{"error":{"message":…,"type":"new_api_error"}}`. Surface `message` **verbatim**. Never show a bare "Request failed".
  - The live 401 body puts `type` at the **top level**, not nested — `parseErrorPayload` handles both, preferring nested.
- Only Chinese, English, French, German, Russian are accepted. Anything else is `400 content blocked` and gets its own error kind and explanation.
- A `401` usually means the **client** was rejected, not the key — the gateway runs a client allowlist. Send an honest static UA (`AgentRouterMobile/1.0 (Android)`) and **never spoof another client's identity**; their terms ban circumventing restrictions and it is a bannable offence. On 401, show a diagnostic that distinguishes key-rejected from client-rejected.
- Credits are free-tier and finite, rate limits undocumented: exponential backoff with jitter on 429 and 5xx, capped retries, **never** retry any other 4xx.
- Any optional parameter may be silently dropped or rejected. On an unsupported-parameter failure, retry once without it and say which parameter was dropped.

### Non-negotiable security constraints

- The API key must never be written to source, logs, AsyncStorage, or git. It lives only in `expo-secure-store` (Android Keystore) plus a module-scoped in-memory cache, read at request time. **It is deliberately not in any Zustand state** because persisted slices write to AsyncStorage.
- The debug log must have the key redacted (`src/lib/redact.ts`, applied at the log write boundary).
- A mandated test still to write: **the API key never appears in any log output or exported file.**
- No telemetry, no analytics, no third-party crash reporting. Everything stays on device.
- MCP: **do not attempt stdio.** Android cannot spawn local processes. Say so in the UI rather than offering a field that can't work.

---

## What is built

### Phase 0 — Foundation and transport ✅ COMPLETE

**Transport layer** (`src/transports/`)
- `types.ts` — closed unions for every wire shape: `ChatRequest`, `StreamEvent`, `UnifiedMessage`, `ContentBlock`, `TokenUsage`, `ReasoningConfig`, `WireHints`, `SamplingParams`, `StopReason`
- `anthropic.ts` — Messages adapter: streaming SSE, thinking blocks, tool use, image/document blocks, unsupported-param retry
- `openai.ts` — Chat Completions adapter: same interface, delta events, `reasoning_effort`, `max_tokens` → `max_completion_tokens` **rename** (not a drop) for reasoning models
- `sse.ts` — WHATWG event-stream parser: split events at any chunk boundary, all three line-ending conventions, bare-CR hold-back
- `utf8.ts` — incremental decoder for multi-byte characters split across chunks
- `retry.ts` — backoff with full jitter; connect timeout 30 s, idle timeout 120 s; **no retry once bytes have been yielded**
- `http.ts` — `USER_AGENT = 'AgentRouterMobile/1.0 (Android)'`
- `errors.ts` — `GatewayError` with kinds `network | auth | client_rejected | rate_limit | server | validation | content_blocked | param_dropped`
- `validate.ts`, `support.ts` (`ModelCapabilities`, `DEFAULT_CAPABILITIES`, `TRANSPORT_SUPPORT` where values are *the reason it is unsupported*)
- `streamingFetch.ts` — the only module that imports `expo/fetch`; injected into the adapters so tests run in pure Node
- `index.ts` — `resolveTransport()`, cache keyed by profile + key fingerprint + wire signature

**Stores** (`src/stores/`) — `settings.ts`, `providers.ts` (named profiles, active one, failover state), `models.ts` (registry from `/v1/models`, per-profile keys `profileId::modelId`, discovery never overwrites hand-edited capability flags)

**Persistence** (`src/db/`) — `schema.ts` (WAL, foreign keys, `user_version` migrations, v1: `conversations` / `conversation_tags` / `messages` with `seq REAL` / `usage_events` with local-day `TEXT` and nullable `cost REAL`; FTS5 external-content + sync triggers + rebuild-on-drift), `conversations.ts` (full CRUD, `toUnifiedMessages`, `recordUsage`, `DEFAULT_TITLE`), `search.ts` (FTS-then-LIKE hybrid, because `unicode61` cannot tokenize CJK)

**Security** — `src/lib/secureKey.ts`, `src/lib/redact.ts`

**Utilities** (`src/lib/`) — `tokens.ts` (heuristic estimator, CJK weighted 3.4× Latin, `selectMessagesWithinBudget`, `estimateCost` returning `null` not `0` for unknown pricing), `log.ts`, `id.ts`, `storage.ts`, `gateway.ts`, `when.ts` (`whenBucket`, `rowTime`, `formatDuration`, `formatRate`)

**UI foundation** — `src/theme/index.tsx` (light/dark palettes, `ThemeProvider`, `useTheme`), `src/components/ui.tsx` (`Screen`, `Section`, `Stack`, `Inline`, `Divider`, `Body`, `Heading`, `Note`, `Badge`, `Button`, `Row`, `SwitchRow`, `Segmented`, `Field`, `Stepper`, `Spinner`, `Empty`). **`disabledReason` is a first-class prop** on the controls — it renders as a caption *and* as `accessibilityHint`. Reuse these rather than inventing new primitives.

**Tests** — `src/transports/__tests__/{sse,utf8,anthropic,openai,retry,validate}.test.ts`, `src/lib/tokens.test.ts`, `src/lib/when.test.ts`, `src/db/search.test.ts` (incl. hostile-input FTS fuzz)

---

### Phase 1 — Core chat ✅ COMPLETE

**Chat logic**
- `src/chat/request.ts` + `request.test.ts` — `EFFORT_BUDGETS`, `budgetForEffort`, `validateConfig`, `hasBlockingIssue`, `defaultParams`, `mergeParams`, `resolveReasoning`, `buildRequest`, `composeSystem`, `SUMMARY_INSTRUCTION`. Both mandated Claude constraints are encoded as validation: thinking cannot be *disabled* at `xhigh`/`max`, and `max_tokens` caps total output **including** thinking so a thin margin warns and a zero margin blocks.
- `src/chat/list.ts` + `list.test.ts` — `filterConversations`, `buildRows` (pinned first, then today / yesterday / week / older, stable partition), `tagCounts`, `parseTags`, `matchesQuery`, `rowTime`.
- `src/stores/chat.ts` (~970 lines) — `runTurn` orchestrator with a 60 ms publish throttle (a 100 Hz delta stream must not re-render the transcript per token), failover (network errors only, only before the first stream event), `applyContextStrategy` (warn / drop-oldest / summarise), `setExclusions`, `summariseDropped`, `applyEvent`, `handleTurnFailure` (abort keeps partial text with `stopReason: 'aborted'`), and every message action: send, regenerate, editAndResend, editInPlace, delete, fork, abort.

**Markdown and rendering** (`src/components/markdown/`)
- `blocks.ts` + `blocks.test.ts` — `parseMarkdown()` → closed `MdBlock` / `InlineToken` AST. `breaks: true` deliberately, because chat prose relies on single newlines. Math is tokenised by a `MarkedExtension` on a private `Marked` instance **before** inline parsing, or `$x_1 + x_2$` becomes emphasis. An unterminated ``` fence lexes as a `code` token, which is exactly what streaming needs. Includes a prefix-fuzz suite that parses every prefix of a mixed document, because a throw there takes the transcript down mid-answer.
- `highlight.ts` + `highlight.test.ts` — HAST → `HighlightSpan[][]`, one array per line (a code block scrolls horizontally, so one non-wrapping `<Text>` per line). 12 colour roles, last-recognised-class-wins, newlines split *during* the walk so a block comment keeps its colour on both sides, adjacent same-colour spans merged, `interpolation` resets to plain. `plainLines()` for unknown languages, oversized blocks, and still-streaming fences.
- `latex.ts` + `latex.test.ts` — pure parser for a common subset (fractions, super/subscripts, Greek, operators, roots, delimiters) with an honest passthrough for the rest.
- `href.ts` + `href.test.ts` — link sanitising. **Every non-printable character in this file and its test is built from `String.fromCodePoint(...)` or `new RegExp('\\uXXXX')` — never a bare `\uXXXX` escape inside a string literal.** A previous session pasted literal invisible bytes into the source and the file became unreadable.
- `lang.ts` + `lang.test.ts` — fence-language aliasing and the refractor grammar allowlist.
- `syntax.ts`, `CodeBlock.tsx` (imports `refractor`, per-block copy, horizontal scroll), `Table.tsx` (horizontal scroll rather than overflow), `MathView.tsx`, `Inline.tsx`, `Markdown.tsx`.

**Chat components** (`src/components/chat/`)
- `Composer.tsx` — grow-to-clamp input, context-pressure gauge measured against **usable** space (`window − max_tokens`, because the failure users hit is a truncated reply, not a rejected request), one button that is Send or Stop but never both, and `disabledReason` rendered full-width above the input rather than squeezed beside it.
- `MessageView.tsx` — memoised transcript row: role, timestamp against a caller-supplied `now`, collapsible thinking, usage and cost, excluded/edited/aborted badges, long-press action hook.
- `StreamView.tsx` — the live turn as the list footer. Separate from `MessageView` because a stream has a phase, an elapsed clock, half-parsed tool arguments and no id. The **phase label** is the point: preparing / summarising / connecting / streaming / saving all look like one spinner from outside and fail for entirely different reasons.
- `ContentBlocks.tsx` — non-text block rendering.
- `src/components/Sheet.tsx` — `Sheet` (a scrolling action sheet; Android's `Alert` caps out at three buttons, and disabled actions are shown *with the reason* rather than hidden) and `PromptSheet` (one line of text; `Alert.prompt` does not exist on Android).

**Screens** (`app/`)
- `_layout.tsx` — all ten routes registered, including `chat/[id]`. Boots behind `hydrated && primed` so no screen can log a request before the redactor knows the stored keys.
- `index.tsx` — the conversation list. Fixed search field at the top, gateway-status banner and tag chips in the scrolling list header, `FlashList` rows via `buildRows`, long-press sheet for rename / tags / pin / delete, fixed bottom bar with New conversation. Search is **two passes shown as two passes**: typing filters the loaded conversations instantly, and a debounced `searchMessages` adds message hits underneath, each badged `index` (FTS) or `scan` (LIKE) so it is clear which pass found it.
- `chat/[id].tsx` — the transcript. `FlashList` with `maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}` so streaming text stays anchored without a `scrollToEnd` per delta; the live stream as `ListFooterComponent`; composer above the safe-area inset; three sheets (message actions, conversation actions, model picker) plus `PromptSheet` for system prompt / rename / tags / edit.

---

### Phases 2–6 — Not started

| Phase | Scope |
|---|---|
| 2 | Model + reasoning controls. Per-conversation model plus single-message override; temperature, top_p, max_tokens, stop sequences, seed, presence/frequency penalties on the OpenAI path; saveable presets; OpenAI `reasoning_effort` (`minimal`/`low`/`medium`/`high`) sent only for reasoning-flagged models; Anthropic extended thinking with an explicit `budget_tokens` slider plus the `low`→`max` effort ladder; thinking streamed into a collapsible pane, collapsed by default but remembering the preference; per-message usage split into input / output / thinking / cached **read from the API response, never estimated**. Every control greys out with an explanation when the model or transport doesn't support it. |
| 3 | Multimodal. Camera, multi-select gallery, file picker; on-device resize + recompress before upload; base64 blocks for Anthropic vs data URLs for OpenAI; composer thumbnail strip with per-image removal; attachment blocked with a reason on non-vision models; PDFs and text files (extract text for OpenAI, native document blocks for Anthropic); on-device speech-to-text and system TTS; feature-detect `/v1/images/generations` and only surface it if the gateway answers (expect disabled); register as an Android share target for text and images. |
| 4 | Skills. `SKILL.md` with YAML frontmatter (`name`, `description`) + Markdown body; create / edit / duplicate / delete / import-export zip; per-conversation enable toggles; **progressive disclosure** — inject only name + description, expose an `invoke_skill` tool, return the body as the tool result; log invocations visibly in the transcript. |
| 5 | MCP over the network. Streamable HTTP and SSE only, never stdio; add by URL with headers or bearer token, plus OAuth 2.1 + PKCE; discover tools / resources / prompts with per-tool enable-disable; bridge into both API formats; agentic loop with a configurable iteration cap; **approval gate with ask-every-time / always-allow / deny showing full arguments**; tool calls and results as distinct collapsible transcript entries; server errors and timeouts returned to the model as an error result rather than crashing the loop. |
| 6 | Power features. Prompt library with variable substitution; export to Markdown and JSON and via the share sheet; settings backup/restore; automatic failover to the backup domain with a visible active-domain indicator; usage dashboard by day and model from local data; request-level debug log, copyable, **key redacted**; offline send queue that retries on reconnect. |

---

## What to do next, in order

1. **Add the `documents` capability flag.** `ModelCapabilities` and `DEFAULT_CAPABILITIES` in `src/transports/support.ts`, then the hand-editable screen at `app/settings/model/[key].tsx`. Phase 3 needs it for native document blocks on the Anthropic path. **Don't add it to a test first — that's how it broke last time.** Source, then screen, then test.
2. **Phase 2.** The per-conversation config sheet already has somewhere to live: `chat/[id].tsx`'s conversation menu, and `ConversationConfig` in `src/db/conversations.ts` already carries `params`, `reasoning`, `contextStrategy` and `showThinking`. `validateConfig` / `mergeParams` / `resolveReasoning` in `src/chat/request.ts` are written and tested — Phase 2 is mostly the screen that drives them, not new logic.
3. Phases 3–6 as scoped above.

---

## Mandated work still outstanding

**Tests:**
- Skill frontmatter parser (Phase 4)
- Mocked-transport tool-call loop: multi-round tool use, an iteration-cap trip, a tool returning an error (Phase 5)
- **The API key never appears in any log output or exported file** (Phase 6, once export exists)

Already covered: both transport adapters, the SSE parser (incl. split and malformed events), token counting, request building and validation, search, the markdown parser, the highlighter, the LaTeX subset, link sanitising, fence languages, relative-time formatting, conversation list grouping.

**Deliverables:**
- Release APK — `npm run build:apk` (`eas build --platform android --profile preview`); `eas.json` is configured. Must be confirmed to build before the final phase is declared complete.
- README — setup, architecture sketch, how to add a provider, the two-base-URL distinction. Proportionate; no filler sections.
- A separate usage guide — how to actually operate the app day to day (first launch, entering the key, picking a transport, test connection, starting a chat, the model and reasoning controls, skills, MCP, export). The user asked for this explicitly on top of the README.
- A short closing list of anything that couldn't be implemented or verified against the live gateway, and why.

---

## Decisions a new session should not silently undo

- **`highlight.ts` must not import `refractor`.** It takes the HAST tree as data via its own minimal structural types, the same injection the transports use for `fetch`. refractor is ESM-only with a large `hast-util-*` transitive tree; keeping it out of the pure layer is what lets the whole suite run in the fast `node` environment. `jest.config.js` carries a transform allowlist for that tree, but the *fix* was the layering, not the allowlist — extending the regex instead would mean editing it every time refractor's dependencies shift. The component imports refractor; the pure layer never does.
- **No `\uXXXX` escapes in string literals** in `href.ts` / `href.test.ts`. Build every non-printable from `String.fromCodePoint(...)`, or a regex from `new RegExp('\\uXXXX')`. `\n`, `\t` and `\r` are fine.
- **The React Compiler lint rules are on, and they are load-bearing.** Two rules bite constantly and neither should be silenced with a disable comment:
  - `react-hooks/preserve-manual-memoization` — a `useMemo` body that reads `obj?.a.b` has `obj` as its real dependency, so listing `obj?.a.b` is rejected. Read the value into a `const` *above* the memo and depend on that.
  - `react-hooks/set-state-in-effect` — no synchronous `setState` in an effect body. Both places this came up had a better fix available: derive the value instead (the conversation list keys its search results by the query that produced them, so "stale" and "still searching" both fall out of one comparison), or let mounting be the reset (`PromptSheet` renders its body only while visible, so cancelling discards with no effect involved).
- The API key stays out of all Zustand state.
- `max_tokens` → `max_completion_tokens` is a rename, not a drop.
- Temperature / top_p / top_k are omitted when Anthropic thinking is on; `TokenUsage.thinking` is left `undefined` on that path rather than estimated.
- Stream events accumulate non-destructively; `pause_turn` is its own stop reason.
- Failover fires only on `network` errors and only before the first stream event — a 401 or 429 means the primary answered.
- `MissingKeyError` is thrown rather than sending an empty Bearer token.
- Text fields commit on blur.
- Markdown renders via `marked` + custom RN components, and highlighting via refractor HAST → RN `<Text>`. **No WebView for ordinary rendering.**
- MCP will use a small hand-rolled JSON-RPC client, not the Node-flavoured official SDK.
- `jest.config.js` matches `*.test.ts` only, **not `.tsx`** — components are deliberately not unit-tested. Their correctness rests on `tsc` plus review, so keep logic out of components and in the pure modules where it can be tested.

---

## Known gaps

- **`ModelCapabilities` has no `documents` flag.** See step 1 of "What to do next".
- **Nothing has run on a physical device.** No Android device has been attached to this machine, so everything below is unit-tested and type-checked but visually unverified. This list belongs in the final "couldn't verify" deliverable:
  - Token-by-token streaming. The SSE layer is tested at chunk sizes down to one byte, all line endings and multi-byte splits, and both adapters stream one byte per chunk in tests.
  - `KeyboardAvoidingView behavior="padding"` under `edgeToEdgeEnabled: true`. `react-native-keyboard-controller` is **not** a dependency, so this is the stock option; edge-to-edge means the keyboard overlays content and the nav bar is drawn under, which is why the composer carries `useSafeAreaInsets().bottom`.
  - The inline-`View`-inside-`Text` approach in the markdown renderer, and `MathView`'s geometry ratios — React Native gives no baseline-relative positioning and no pre-layout glyph measurement, so both are tuned by eye.
  - FlashList v2's `maintainVisibleContentPosition` anchoring during a live stream.
- **`.expo/types/` has not been generated**, so expo-router's typed routes are not actually being enforced — `router.push({ pathname: '/chat/[id]', params: { id } })` currently typechecks against `string`. Run the dev server once to generate them and re-run `tsc`; a typo in a route path is invisible until then.
- **Live gateway verification is blocked on a real API key.** Both domains are reachable and the unauthenticated 401 shape has been captured, but key-rejected vs client-rejected could not be distinguished without a token (an honest UA and an empty UA give the identical 401, and spoofing is off the table). If the key is provided, it should go in a gitignored file or an env var — never pasted into chat.
- Rate-limit thresholds are undocumented; which optional parameters the gateway silently drops vs rejects is unknown.

---

## Dependencies

Installed and in use: `expo ~57.0.15`, `react 19.2.3`, `react-native 0.86.2`, `typescript ~6.0.3`, `expo-router`, `expo-sqlite`, `expo-secure-store`, `expo-clipboard`, `expo-crypto`, `expo-linking`, `zustand 5`, `@react-native-async-storage/async-storage`, `@shopify/flash-list 2.0.2`, `react-native-safe-area-context`, `react-native-screens`, `marked 18`, `refractor 5`, `js-yaml` (Phase 4 frontmatter), `fflate` (Phase 4 zip).

Still to install:
- Phase 3 — `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker`, `expo-file-system`, `expo-speech`, `expo-sharing`
- Phase 5 — `expo-web-browser` / `expo-auth-session` for the MCP OAuth 2.1 + PKCE flow

`.npmrc` sets `legacy-peer-deps` (an ERESOLVE peer conflict in the Expo 57 tree). `package.json` has an `allowScripts` entry for `unrs-resolver`, whose skipped postinstall was what made Jest fail to resolve `babel-jest` by bare name — hence the `require.resolve('babel-jest')` in `jest.config.js`.
