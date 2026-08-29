# AgentRouter Mobile — Build Progress

**Last updated:** 2026-08-30
**Gates, all green as of this writing:**

```bash
npx tsc --noEmit && npx eslint . && npx jest
```

→ tsc clean, eslint clean, **817 tests / 26 suites** in ~5 s. 27,772 lines across `src` and `app`.

Coverage is now a **gate, not a note**: `npx jest --coverage` measures lines 62.66%, statements 61.33%, branches 60.78%, functions 47.68%, and `jest.config.js` carries a `coverageThreshold` a point or two under each of those, so the runner fails rather than the number going stale in this file. The functions figure is low for a structural reason, not a negligent one — `app/` and `src/components/` are excluded from unit testing by design (see the note on `jest.config.js` below), and every uncovered function is a component or a store action that only exists to call one.

The same three gates run in CI on every push and pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), which is the only thing that makes the paragraph above worth reading. `pnpm gates` runs them locally in one command.

Run all three at the end of every phase and fix what they surface. Don't pause between phases to ask whether to continue.

**On phase numbering:** the table under "Phases 2–6" below is the *original* PRD grouping. [docs/06_Eng_Plan.md](docs/06_Eng_Plan.md) supersedes it and is what current work follows — there, Phase 2 is Sprints 5 and 6 ("List & organisation"), and the model/reasoning controls the table calls Phase 2 were largely delivered inside Phase 1's config sheet. Where the two disagree, the Eng Plan wins.

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
- **Both mandated key tests now exist and pass**: `src/lib/redact.test.ts` (the key never reaches the debug log) and `src/chat/export.test.ts` (the key never appears in an export, verified by greping the produced artefact). Neither asserts a call site; both search the finished output, so a new field added without redaction fails rather than ships.
- The same redaction is reused as a **write-time screen for long-term memory**: a candidate memory that changes under `redactString` is discarded rather than stored, so a token pasted into a conversation cannot become a permanent line in every future system prompt.
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
- `errors.ts` — `GatewayError` with **15** kinds: `client_rejected | key_rejected | forbidden | content_blocked | unsupported_param | not_found | insufficient_credits | rate_limited | server | bad_request | validation | network | aborted | parse | unknown`. The 401 split (`client_rejected` vs `key_rejected`) is the one that matters most operationally, and `validation` is deliberately *this app refusing to send* rather than the gateway refusing — nothing left the device, so there is no gateway message to quote and no log entry to point at.
- `validate.ts`, `support.ts` (`ModelCapabilities`, `DEFAULT_CAPABILITIES`, `TRANSPORT_SUPPORT` where values are *the reason it is unsupported*)
- `streamingFetch.ts` — the only module that imports `expo/fetch`; injected into the adapters so tests run in pure Node
- `index.ts` — `resolveTransport()`, cache keyed by profile + key fingerprint + wire signature

**Stores** (`src/stores/`) — `settings.ts`, `providers.ts` (named profiles, active one, failover state), `models.ts` (registry from `/v1/models`, per-profile keys `profileId::modelId`, discovery never overwrites hand-edited capability flags)

**Persistence** (`src/db/`) — `ddl.ts` (all DDL as plain SQL strings with **no `expo-sqlite` import**, so tests build the real schema under `node:sqlite`), `schema.ts` (WAL, foreign keys, `user_version` migration chain, currently **v3**; FTS5 external-content + sync triggers + integrity-check-on-boot), `list-query.ts` (pure keyset-paging SQL builder), `conversations.ts` (full CRUD, `listConversationPage`, `toUnifiedMessages`, `recordUsage`, `DEFAULT_TITLE`), `memories.ts` (long-term memory CRUD + `clearMemories`), `search.ts` (FTS-then-LIKE hybrid, because `unicode61` cannot tokenize CJK)

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

### Phase 2 (Eng Plan Sprints 5–6) — ✅ COMPLETE

**Sprint 5 · list virtualisation and the measurable baseline**

- **Keyset paging, not `OFFSET`.** `src/db/list-query.ts` builds the list SQL as a pure function, with the cursor as a row-value comparison `(c.pinned, c.updated_at, c.id) < (?, ?, ?)` — which SQLite converts into an index range constraint. `listConversationPage()` in `conversations.ts` returns `{conversations, cursor}`; `listConversations()` is now a thin wrapper for the callers that want one page. `app/index.tsx` drives it with `onEndReached`, and paging is disabled while a search query is active because search is its own ranking.
- **The index that makes it work (debt D-02, closed).** Migration 1 → 2 drops `conversations_order` and creates `conversations_list (archived, pinned DESC, updated_at DESC, id DESC)`. Leading with `archived` turns the filter into an equality constraint; carrying `id` lets the index spell out the whole `ORDER BY`, which is what removes the `TEMP B-TREE`.
- **Proved, not assumed.** `src/db/__tests__/list-query.test.ts` runs the shipped SQL against real SQLite via **`node:sqlite`** (built into Node 24, with FTS5 and `EXPLAIN QUERY PLAN`) over 500 seeded conversations with deliberate `updated_at` ties, and asserts `SEARCH … USING INDEX conversations_list`, the absence of `TEMP B-TREE`, the absence of `OFFSET`, and that paging visits every row exactly once across ties. This is why `ddl.ts` and `list-query.ts` exist as separate modules: the test exercises the SQL that ships, not a copy of it.
- **FTS drift detection actually detects drift (debt D-03, closed).** The boot check is now `INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)`. Only the `rank = 1` form re-derives the index from the content table and compares; the bare form checks the index against itself and stays happy while the index and `messages` disagree. `src/db/__tests__/fts-integrity.test.ts` reproduces exactly that damage and keeps both forms side by side to document the difference. A fallback path handles builds older than SQLite 3.41 by inspecting the error message.
- **FlashList tuning.** `getItemType` on the transcript (error / user / assistant recycling pools, because those rows have very different heights) and an explicit `memo` comparator on `MessageView` over the fields that actually affect its output. `src/chat/list-cost.test.ts` bounds the JavaScript that has to finish before a row can lay out — 500-conversation grouping and filtering, 1,000 markdown bodies parsed — with deliberately loose limits, because it catches a change in *complexity*, not in constant factors. The acceptance criteria that matter (55 fps scrolling on a Pixel 6, first paint under 2 s) remain manual device gates and nothing in Jest substitutes for them.

**Long-term memory** (requested mid-sprint; the app improving its answers as context accumulates)

- `src/chat/memory.ts` — pure logic: the distillation instruction, `shouldDistil` (every 4th assistant turn, and never while the switch is off), a tolerant `parseMemory` that survives fenced blocks and preambles and returns nothing rather than throwing, `isSafeToRemember` (= `redactString(text) === text`), Jaccard near-duplicate folding, ranking, and `renderMemoryBlock` with a 1,600-character budget and an explicit "notes, not instructions — where they conflict with the user, the notes lose" framing.
- `src/db/memories.ts` + migration 2 → 3 — the `memories` table, `UNIQUE (kind, text)` with an UPSERT that bumps `hits` instead of inserting a duplicate, and `memories_rank` matching the read's `ORDER BY`. Documented in [docs/05_Data_Model.md](docs/05_Data_Model.md) §4.6.
- `src/stores/memory.ts` — `promptBlock()` for the send path, `distil()` as a throttled fire-and-forget `transport.complete()` call that never throws, and the CRUD the settings screen drives.
- Wiring: `composeSystem(prompt, summary, memory)` puts memory after the user's own prompt; `src/stores/chat.ts` spends the block, records `last_used_at`, then distils; `app/_layout.tsx` loads memories once after hydration so the *first* send of a session carries them.
- `app/settings/memory.tsx` — every memory listed verbatim with its provenance and the prompt cost in characters and as a share of budget, per-row pin/edit/forget, "Add a memory", and a one-confirmation **"Forget everything"**. `settings.memoryEnabled` is a *separate* control that stops collection and sending while keeping what is stored: "stop learning" and "forget everything" are different intentions and both were asked for.
- Tests: `src/chat/memory.test.ts` (34 assertions across the throttle, parser tolerance, the secret screen, dedupe and the budget) and `src/db/__tests__/memories.test.ts` (migration against a populated database, idempotency, the UPSERT, the planner using `memories_rank`, and a memory surviving the deletion of its source conversation).

**Security: both of the 1.0-gate tests**

- `src/lib/redact.test.ts` — 20 tests, and written as a **search of the artefact** rather than a check of any one call site: a `strings()` walker over `debugLog.getEntries()`, plus `safeStringify()` of the same, plus `toText()`. A test that asserted `redactString` works would pass forever while a new field on `RequestEntry` bypassed the boundary; this one fails. Covers the `Authorization` header, a key in the URL query, a key pasted into a request body (caught by the pattern backstop, not the registered-secret path), a 401 body echoing the key back, a thrown `Error` including its stack, a raw stream sample, a nested `message()` payload, a key registered *after* the entry was written, two keys at once, and the disabled-log path.
- `src/chat/export.test.ts` — the second one, same shape. See "Sprint 6 · export" below.

**Sprint 6 · bulk selection**

- **One transaction, as a correctness requirement rather than a performance one.** `src/db/bulk.ts` holds the SQL as pure builders with **no `expo-sqlite` import**, so `src/db/__tests__/bulk.test.ts` runs the statements that ship. `deleteConversations()` in `conversations.ts` wraps the whole selection in one `withTransactionAsync`, chunked at `BULK_CHUNK = 400` to stay under `SQLITE_MAX_VARIABLE_NUMBER` (999 on older builds). Fifty separate deletes can be interrupted halfway, and a half-destroyed selection has no undo and no way for the user to say which half went.
- **The blast radius is proved, not read off the DDL.** `bulk.test.ts` builds the real schema under `node:sqlite` with `PRAGMA foreign_keys = ON` — without which SQLite parses `ON DELETE CASCADE` and then ignores it, and every assertion would pass for the wrong reason — and asserts that messages and `conversation_tags` cascade away, that **`usage_events` survive** (`conversation_id` there is a plain column, not a foreign key, because spend is an accounting record of money already spent), and that `messages_fts` stays in step because the AFTER DELETE trigger fires on *cascaded* rows, with `integrity-check … rank = 1` still passing afterwards. The 50-conversation test runs `BEGIN … ROLLBACK` and asserts nothing moved, then `BEGIN … COMMIT` and asserts everything did.
- **Counts are what happened, not what was asked.** `setArchivedSql` carries `WHERE archived <> ?` so `changes` means "rows that moved"; `addTagSql` inserts `FROM conversations`, so a stale id contributes no row instead of tripping the foreign key and taking the transaction with it. Every confirmation reports the statement's own `changes`.
- **`src/chat/selection.ts` + `selection.test.ts`** — the sentences a destructive confirmation says, kept in a `.ts` module because Jest matches `.ts` only. The rule the module exists to enforce: **a bulk confirmation describes the selection, not the button.** `describeDelete` names the message count (twelve rows can be four thousand messages), calls out pinned rows with the right singular/plural verb, samples at most three titles, offers archiving in the same breath, and says that usage history is kept — pre-empting the reasonable worry that tidying the list falsifies the dashboard.
- **The selection is intersected with what is on screen, by derivation.** `app/index.tsx` derives `picked = pruneSelection(selected, filtered)` in a `useMemo`, and the row ticks, the counts and the actions all read it. An effect would prune one render later, which is one render in which the count on the button and the rows it would touch disagree. `selected === null` means "not selecting", so an empty selection does not exit the mode.

**Sprint 6 · export, and the second 1.0-gate test**

- `src/chat/export.ts` — pure, taking the conversation and its messages as arguments and returning text; nothing in it touches SQLite, the clipboard or the share sheet. Markdown for a person, JSON under a versioned envelope (`EXPORT_SCHEMA_VERSION`) for a program, single conversations and bundles, `exportFilename` slugging by allow-list so no share target rejects the name.
- **The gating test greps the artefact.** `src/chat/export.test.ts` (35 tests) plants the key in every field an export touches — title, system prompt, tags, message text, a thinking block, tool-call arguments both nested and as an object *key*, a tool result, an error message, the conversation config and a message's meta — then asserts the key appears in neither format, in the filename, or in a bundle. Adding an exported field without redaction means adding it to a fixture that already contains the key. One case deliberately never registers the secret, so the pattern backstop is tested as the thing that catches a key restored from a backup on another device.
- **Redaction runs twice on purpose.** Every string goes through `redactString` as it is written, and the finished artefact goes through it again. The second pass is a net under the first, because the failure mode is a *future* field added without one — which produces a leak, not a compile error. It is safe after `JSON.stringify` because the replacement text contains nothing JSON escapes, and the test parses the JSON export to prove it.
- **Attachment bytes are never exported**, in either format: an image becomes `[image: image/jpeg, ~340 kB — not included]` and a JSON block carries `bytes` and `included: false` in place of `data`. Partly size, partly that silently shipping every photo the user attached inside a file they meant as a transcript is a privacy decision nobody asked to make. Document text that was already extracted on device *is* included — the model saw it.
- **Thinking is off by default**, available, and labelled when included: it restates private context in blunter terms than the reply does. The chat screen offers it as a separately named action rather than a checkbox, because a checkbox is a thing people leave ticked.
- `src/chat/deliver.ts` — the impure half: gathers rows from SQLite and hands the artefact to `expo-clipboard` or React Native's `Share`. Above `SHARE_BYTE_LIMIT` (256 kB) it copies instead and *says so*, because Android's Binder parcel has a hard ceiling around 1 MB and a share target that overflows it fails with an error the user cannot act on. There is no "save to file": `expo-file-system` and `expo-sharing` are not dependencies, and the share sheet's own targets are what "save it" means anyway. Wired into the per-conversation menu, the bulk actions sheet, and the chat screen's conversation menu.

**CI/CD (debt D-08, closed)**

- `.github/workflows/ci.yml` — one `verify` job, not three: typecheck, lint and test share an install that costs more than all three gates put together, so splitting them for parallel red X's would triple the install for a few seconds of wall clock. `concurrency` keyed on the *ref* with `cancel-in-progress`, because a force-push makes the in-flight run irrelevant. Coverage runs inside the test step rather than as a second pass, since `coverageThreshold` makes it a gate and not a report, and an `if: always()` step formats `coverage/coverage-summary.json` into the run summary — visible precisely when the run is red.
- `.github/workflows/build-apk.yml` — `workflow_dispatch` with a `profile` **choice** input, plus `push: tags: ['v*']`. The gates run again here: a tag can point at any commit, including one that never saw CI. `EXPO_TOKEN` is the only secret, and it is an Expo account token, not a signing key — the keystore stays in EAS and no gateway API key has any reason to exist on a runner. `--no-wait` so a queued EAS build does not bill Actions minutes. No `cancel-in-progress`, deliberately: a cancelled build step can leave a queued EAS build with nothing watching it.
- Two corrections to the Eng Plan's spec, both recorded in [docs/06_Eng_Plan.md](docs/06_Eng_Plan.md) §9.4 rather than quietly edited into §9.1: **Node 24, not 22** (the `src/db/__tests__` suite imports `node:sqlite`, which needs `--experimental-sqlite` on 22, so the whole directory fails to load on a Node 22 runner), and **pnpm 10.29.1, not 11** (what the lockfile was produced by, which matters under `--frozen-lockfile`).
- `jest.config.js` now carries `coverageThreshold.global` at lines 61 / statements 60 / branches 59 / functions 46 — a point or two under the measured run, and ratcheted upward as Sprint 6 landed (the harness sprint below ratcheted it again, to 62 / 61 / 60 / 48). The slack absorbs adding a pure module before its tests land in the same change, and still fails when a whole file arrives untested. `package.json` gained `test:coverage` and a `gates` script that runs all three locally.

**Phase 2 is complete.** Sprints 5 and 6 are both delivered; what remains in the "What to do next" list below is Phase 3 onwards.

---

### Harness token optimization — ✅ COMPLETE (requested after Phase 2; brings Phase 4/5 budgeting concerns forward)

Four pure modules under `src/chat/`, plus the transport plumbing to express what they decide. The brief was tools and token cost; the work divides into three defects that were losing tokens silently and one capability that was displayed but structurally impossible.

**`src/chat/budget.ts` — one home for the turn arithmetic.** It existed in two places that disagreed: the chat store computed `contextWindow − maxTokens − thinkingBudget − systemPrompt − 512`, the composer's gauge computed `contextWindow − reserved`. Two consequences, both real and both invisible:

- **Thinking was double-counted.** On the Anthropic path `max_tokens` is the *total* output allowance including thinking — `validateConfig` already refuses a request whose thinking budget is not below it. Reserving `maxTokens + budgetTokens` therefore reserved it twice; at effort `max` that is **128k tokens of a 200k window given away** for nothing. `replyReservation()` is a named function specifically so the temptation to add the two together has somewhere to be documented as wrong.
- **Memory and tool definitions were not counted at all**, despite both going into the request the budget was being computed for. A long memory block plus a talkative MCP server could push the assembled request past a window the planner had just declared roomy — the one failure trimming exists to prevent.

`planTurn()` returns `{window, reply, prefix, margin, history, tight}`. `tight` is the interesting output: when the fixed costs leave less than `MIN_HISTORY_BUDGET`, `history` is that floor rather than the real remainder and the flag is set, so the UI can name *which* fixed cost to cut instead of silently trimming the conversation to nothing to fit a 40k-token manifest. `describeTightBudget()` names one thing — the biggest — because a list of three is a list nobody acts on.

**`src/chat/trim.ts` — a ladder instead of a cliff.** The old behaviour had one lever, dropping whole turns from the oldest end, and reached for it immediately: a conversation one token over budget lost an entire exchange. Two much cheaper things go first. **Replayed reasoning** is billed as input on every turn it is sent, is the largest thing in a reasoning conversation, and is worth almost nothing to the next turn because the model's conclusions are in the visible reply underneath it. **Long tool results** — a directory listing, an HTTP body — are mostly padding by the third turn, so `truncateMiddle` keeps both ends around an honest `… N characters elided …` marker, weighted two-thirds to the head. Only then are turns dropped, via the existing `selectMessagesWithinBudget`. Each step runs only if the previous one was not enough, `actions` records only what actually ran, and indices in the report refer to the *input* array so the transcript can still mark the right stored rows excluded. `settings.progressiveTrim` (default on) turns the ladder off by passing `keepThinkingInLast: all.length` and an effectively infinite result cap, which lands straight on the old behaviour.

**`src/chat/tools.ts` — the manifest is the most expensive thing nobody looks at.** Sent in full every turn whether or not the model calls anything; forty MCP tools is 8–15k tokens of JSON Schema on a conversation that is 2k of text. Two levers in order: `slimSchema` drops keys a model does not read (`$schema`, `$id`, `$comment`, `title`, `examples`, `deprecated`, `readOnly`, `writeOnly`) and clamps prose at a sentence boundary, leaving everything semantic — `type`, `enum`, `required`, `properties`, `items`, `anyOf`, formats, numeric bounds — verbatim, which routinely takes 30–50% off a verbose manifest without changing what the model may send. When that is not enough, `selectTools` offers fewer and `describeWithheldTools` **names the ones left out**, because a model that silently cannot see a tool invents a workaround and reports success.

**`src/chat/cache.ts` — `cacheRead` was displayed and structurally always zero.** The Messages API caches only what carries `cache_control`, and nothing ever asked, so every turn re-paid full price for an identical system prompt, an identical manifest and an identical history. A write costs 1.25× and a read 0.1×, so a breakpoint pays for itself on its first re-read and loses 25% of that prefix if never read — which means marking what is *stable*, not what is large: tools, then the system prompt, then history up to the last complete exchange. `MIN_CACHEABLE_TOKENS` is 2,048 (the small-model floor) rather than 1,024, because requesting a write below the minimum is silently ignored and still charges the premium. Thresholds apply to the **cumulative** prefix, since a breakpoint covers everything before it — which is why a one-line system prompt behind a large manifest is worth marking. The fourth of the API's four breakpoints is deliberately left unspent for the Phase 5 tool loop.

**Transport plumbing.** `CacheMarks` on `ChatRequest` is transport-agnostic on purpose: the OpenAI-compatible path caches automatically and ignores it. The Anthropic adapter promotes a marked system prompt to block form (a string has nowhere to put a marker), marks the last tool definition, and takes a `cacheThrough` index in `toAnthropicMessages`. That last one is the subtle case: adjacent same-role turns merge, so a unified index is not a wire index, and the marker **steps back rather than over-covering** — marking a wire message that swallowed the newest turn would write a fresh entry every turn and read one that is always an exchange short. `ModelCapabilities.promptCache` gates the whole thing per model and defaults off for unknowns, because a gateway that charges the write premium and serves nothing back is worse than no caching.

**Cache-stability rules the modules enforce between them:** `trimToBudget` returns its input untouched when it already fits; `selectTools` emits in the caller's original order however it ranked for inclusion; `planCache` places no history breakpoint when a trim rewrote history. All three exist because a rewritten prefix is a cache miss, and rewriting history to save 200 tokens can cost the whole cache read.

**Wiring and UI.** `src/stores/chat.ts` composes the system prompt (prompt + memory + summary), plans the turn, runs the ladder, logs `describeTrim()` — step names and sizes only, never content — and attaches the cache plan. `app/chat/[id].tsx` now counts the memory block in the composer's live estimate and reserves via `replyReservation`, so the gauge and the send path finally agree. `app/settings/appearance.tsx` gained a **Token usage** section with `promptCaching` and `progressiveTrim`, both on by default.

**Tests.** 87 new: `budget.test.ts`, `trim.test.ts`, `tools.test.ts`, `cache.test.ts`, plus `cache_control` and `cacheThrough` blocks in the existing Anthropic adapter suite. Suite is **904 tests / 30 suites in ~12 s with coverage**; `jest.config.js` ratcheted to lines 62 / statements 61 / branches 60 / functions 48. `tsc --noEmit` and `eslint .` both clean.

**Not yet wired, and deliberately:** `selectTools`/`describeWithheldTools` have no call site because tools do not reach `buildRequest` until Phase 5, and `describeCacheOutcome`/`describeTightBudget` are written for the per-message cost sheet and the pressure banner that Phase 5 fills in. They are tested rather than speculative — the arithmetic they encode had to be settled while the reasons were fresh.

---

### Phases 2–6 — original PRD grouping (superseded by the Eng Plan; see the note at the top)

| Phase | Scope |
|---|---|
| 2 | Model + reasoning controls. Per-conversation model plus single-message override; temperature, top_p, max_tokens, stop sequences, seed, presence/frequency penalties on the OpenAI path; saveable presets; OpenAI `reasoning_effort` (`minimal`/`low`/`medium`/`high`) sent only for reasoning-flagged models; Anthropic extended thinking with an explicit `budget_tokens` slider plus the `low`→`max` effort ladder; thinking streamed into a collapsible pane, collapsed by default but remembering the preference; per-message usage split into input / output / thinking / cached **read from the API response, never estimated**. Every control greys out with an explanation when the model or transport doesn't support it. |
| 3 | Multimodal. Camera, multi-select gallery, file picker; on-device resize + recompress before upload; base64 blocks for Anthropic vs data URLs for OpenAI; composer thumbnail strip with per-image removal; attachment blocked with a reason on non-vision models; PDFs and text files (extract text for OpenAI, native document blocks for Anthropic); on-device speech-to-text and system TTS; feature-detect `/v1/images/generations` and only surface it if the gateway answers (expect disabled); register as an Android share target for text and images. |
| 4 | Skills. `SKILL.md` with YAML frontmatter (`name`, `description`) + Markdown body; create / edit / duplicate / delete / import-export zip; per-conversation enable toggles; **progressive disclosure** — inject only name + description, expose an `invoke_skill` tool, return the body as the tool result; log invocations visibly in the transcript. |
| 5 | MCP over the network. Streamable HTTP and SSE only, never stdio; add by URL with headers or bearer token, plus OAuth 2.1 + PKCE; discover tools / resources / prompts with per-tool enable-disable; bridge into both API formats; agentic loop with a configurable iteration cap; **approval gate with ask-every-time / always-allow / deny showing full arguments**; tool calls and results as distinct collapsible transcript entries; server errors and timeouts returned to the model as an error result rather than crashing the loop. |
| 6 | Power features. Prompt library with variable substitution; export to Markdown and JSON and via the share sheet; settings backup/restore; automatic failover to the backup domain with a visible active-domain indicator; usage dashboard by day and model from local data; request-level debug log, copyable, **key redacted**; offline send queue that retries on reconnect. |

---

## What to do next, in order

Phase 2 (Eng Plan Sprints 5–6) is finished, as is the harness token-optimization sprint that followed it. Next:

1. **Phase 3 — multimodal**, as scoped in the Eng Plan. It needs `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker` and `expo-file-system` installed first; `app/settings/model/[key].tsx` already exposes the `documents` capability flag, so the gate for document attachments exists.
2. Then Phases 4–6 as scoped in the Eng Plan. Note that Phase 6's export item is **already delivered** in Sprint 6 — what remains of Phase 6 is the prompt library, settings backup/restore, and the offline send queue.
3. Physical-device verification, which nothing in Jest substitutes for. See "Known gaps".

---

## Mandated work still outstanding

**Tests:**
- ✅ **The debug log never contains the API key** — `src/lib/redact.test.ts`. Done.
- ✅ **The API key never appears in an exported conversation**, verified by greping the produced artefact — `src/chat/export.test.ts`. Done. Both 1.0-gate security tests now pass.
- Skill frontmatter parser (Phase 4)
- Mocked-transport tool-call loop: multi-round tool use, an iteration-cap trip, a tool returning an error (Phase 5)

Already covered: both transport adapters, the SSE parser (incl. split and malformed events), token counting, request building and validation, search, the markdown parser, the highlighter, the LaTeX subset, link sanitising, fence languages, relative-time formatting, conversation list grouping, the list query plan and keyset paging against real SQLite, FTS integrity checking, long-term memory (parsing, the secret screen, dedupe, budget, and the schema), bulk operations against real SQLite (cascade, transaction rollback, FTS trigger, surviving usage events), the bulk confirmation wording, export in both formats including the key-leak gate, and the harness budgeting layer (turn budget, the trim ladder, tool-manifest slimming and selection, cache breakpoint planning, and the adapter's `cache_control` placement).

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
- **All DDL lives in `src/db/ddl.ts`, with no `expo-sqlite` import.** That is what lets `node:sqlite` build the real schema in Jest and assert query plans with `EXPLAIN QUERY PLAN`. A migration written inline in `schema.ts` is a migration no test can reach. There is a narrow local `node:sqlite.d.ts` in `src/db/__tests__/` rather than a dependency on `@types/node`, whose globals would shadow React Native's.
- **Every migration statement is idempotent** (`IF NOT EXISTS`, `DROP … IF EXISTS`). The `PRAGMA user_version` bump happens *outside* the transaction — `expo-sqlite`'s async transaction wrapper cannot carry it — so a process killed at the wrong moment re-runs a migration that already applied. Idempotency is the recovery story; keep it, and keep asserting it.
- **A memory that fails the redaction screen is dropped, never stored redacted.** `isSafeToRemember` is `redactString(text) === text`. Storing `"their key is [REDACTED]"` would be worthless in the prompt and would look like a bug on the memory screen.
- **Memory is subordinate to the user's own prompt, and says so in the prompt itself.** `composeSystem` puts the user's system prompt first, then memory, then any rolling summary. A remembered "prefers terse answers" must not quietly outrank a prompt asking for detail today.
- **`memoryEnabled` off means nothing is collected *and* nothing is sent** — both halves, so the feature costs zero tokens while off — but stored memories are kept. Deleting them is a separate, explicit action.
- **An export never carries attachment bytes, and redaction runs twice.** Both are load-bearing rather than belt-and-braces theatre: the second `redactString` pass exists to catch a field somebody adds to the exporter later without the first one, and `src/chat/export.test.ts` greps the finished artefact so that omission fails a test instead of shipping. Do not "optimise away" either pass, and do not start embedding base64 in exports — a transcript that silently contains every photo the user ever attached is a different artefact from the one they asked for.
- **A bulk delete is one transaction or nothing**, and `usage_events` are deliberately not foreign-keyed to `conversations` so spend history survives it. Both are asserted in `src/db/__tests__/bulk.test.ts` against real SQLite with `PRAGMA foreign_keys = ON`.
- **`replyReservation` must never add the thinking budget to `max_tokens`.** On the Anthropic path `max_tokens` *is* the total output allowance including thinking, and `validateConfig` already enforces that the thinking budget sits below it. Adding them threw away up to 128k tokens of window per reasoning turn and nothing failed, which is exactly why the arithmetic lives in one named function with the reason attached. `src/chat/budget.test.ts` pins it.
- **Three rules keep the prompt cache warm, and each one looks like a missed optimisation until you price it.** A cache write costs 1.25× and a read 0.1×, so anything that changes the prefix's bytes forfeits the read for the whole prefix, not just the changed part:
  - `trimToBudget` returns its input **untouched** when it already fits — no defensive normalising, no re-ordering.
  - `selectTools` emits the kept manifest in the **caller's original order**, however it ranked tools for inclusion. A recency-ordered manifest changes its bytes almost every turn and throws away the largest cacheable block in the request.
  - `planCache` places **no history breakpoint when a trim ran**. A rewritten prefix is a cache miss by definition; writing it again pays the premium for an entry the next turn also misses.
- **The Anthropic cache marker steps back, never forward.** `toAnthropicMessages` merges adjacent same-role turns, so a unified-message index is not a wire-message index. The marker goes on the last wire message that *ends at or before* `cacheThrough`; marking one that swallowed the newest turn would write a fresh entry every turn and read one that is always an exchange short. Asserted in the `cacheThrough` block of `src/transports/__tests__/anthropic.test.ts`.
- **`ModelCapabilities.promptCache` defaults off for an unknown model.** A gateway that accepts `cache_control`, charges the 1.25× write premium and serves nothing back is worse than no caching at all, and it cannot be detected from here without paying for it once. Guessed on only for Claude ids.
- **`slimSchema` may drop decoration and never anything semantic.** `type`, `enum`, `required`, `properties`, `items`, `anyOf`, formats and numeric bounds are the difference between a tool the model calls correctly and one it guesses at. If a key's absence could change a valid call, it does not belong in `DECORATIVE_SCHEMA_KEYS`.
- **A withheld tool is named to the model, not merely omitted.** A model that silently cannot see a tool invents a workaround and reports success. `describeWithheldTools` returns `''` when nothing was withheld, so the common path's prefix stays byte-identical — see the cache rules above.
- **Thinking is not dropped from an assistant message containing a `tool_use`.** The API requires the thinking block that preceded a tool call to come back with its signature intact; dropping it is a 400, not a smaller request. `thinkingIsLoadBearing()` in `src/chat/trim.ts` is the guard, and a test in `trim.test.ts` fails if it goes.

---

## Known gaps

- **Nothing has run on a physical device.** No Android device has been attached to this machine, so everything below is unit-tested and type-checked but visually unverified. This list belongs in the final "couldn't verify" deliverable:
  - Token-by-token streaming. The SSE layer is tested at chunk sizes down to one byte, all line endings and multi-byte splits, and both adapters stream one byte per chunk in tests.
  - `KeyboardAvoidingView behavior="padding"` under `edgeToEdgeEnabled: true`. `react-native-keyboard-controller` is **not** a dependency, so this is the stock option; edge-to-edge means the keyboard overlays content and the nav bar is drawn under, which is why the composer carries `useSafeAreaInsets().bottom`.
  - The inline-`View`-inside-`Text` approach in the markdown renderer, and `MathView`'s geometry ratios — React Native gives no baseline-relative positioning and no pre-layout glyph measurement, so both are tuned by eye.
  - FlashList v2's `maintainVisibleContentPosition` anchoring during a live stream.
  - **The two list performance criteria.** 55 fps while scrolling 500 conversations and first paint of a 1,000-message transcript under 2 s are properties of the native renderer. `src/chat/list-cost.test.ts` bounds the JavaScript that runs before layout; it does not and cannot measure either criterion.
  - **Long-term memory end to end.** The distillation pass has never run against the live gateway, so how often a real model returns `[]` versus inventing trivia is unmeasured. The parser, the secret screen and the budget are tested; the *quality* of what gets remembered is not, and it is the thing most likely to need the prompt in `DISTIL_INSTRUCTION` tuned after first contact.
  - **The share sheet.** `Share.share({ message })` and the 256 kB fallback to the clipboard are reasoned from Android's Binder limit, not measured on a device — which target apps truncate a long `message`, and at what size, is unverified. The artefact itself is fully tested; only the handover is not.
  - **Prompt caching has never been exercised against the live gateway.** The breakpoints, the block-form system prompt and the merge-aware marker placement are all unit-tested, but whether this gateway forwards `cache_control` to Anthropic at all — and whether it passes `cache_read_input_tokens` back — is unknown, and it is the one thing that decides whether the feature saves money or costs 25% on the marked prefix. `describeCacheOutcome` is written to report exactly this case ("we asked and got nothing"), and `ModelCapabilities.promptCache` is the per-model off switch if it turns out to be the answer. First real conversation will settle it in one turn: a non-zero `cacheWrite` on turn one and a non-zero `cacheRead` on turn two.
  - **The trim ladder's savings are estimates.** `TrimReport.before`/`after` come from the character-ratio estimator, so the figure in the transcript banner is approximate in the same way the composer's gauge is. What was *lost* is exact; what it saved is not.
- **`.expo/types/` has not been generated**, so expo-router's typed routes are not actually being enforced — `router.push({ pathname: '/chat/[id]', params: { id } })` currently typechecks against `string`. Run the dev server once to generate them and re-run `tsc`; a typo in a route path is invisible until then.
- **Live gateway verification is blocked on a real API key.** Both domains are reachable and the unauthenticated 401 shape has been captured, but key-rejected vs client-rejected could not be distinguished without a token (an honest UA and an empty UA give the identical 401, and spoofing is off the table). If the key is provided, it should go in a gitignored file or an env var — never pasted into chat.
- Rate-limit thresholds are undocumented; which optional parameters the gateway silently drops vs rejects is unknown.

---

## Dependencies

Installed and in use: `expo ~57.0.15`, `react 19.2.3`, `react-native 0.86.2`, `typescript ~6.0.3`, `expo-router`, `expo-sqlite`, `expo-secure-store`, `expo-clipboard`, `expo-crypto`, `expo-linking`, `zustand 5`, `@react-native-async-storage/async-storage`, `@shopify/flash-list 2.0.2`, `react-native-safe-area-context`, `react-native-screens`, `marked 18`, `refractor 5`, `js-yaml` (Phase 4 frontmatter), `fflate` (Phase 4 zip).

Still to install:
- Phase 3 — `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker`, `expo-file-system`, `expo-speech`, `expo-sharing`

`expo-file-system` and `expo-sharing` are listed under Phase 3 rather than Sprint 6 on purpose: export ships through `expo-clipboard` and React Native's `Share`, which needed no native additions. When Phase 3 pulls them in, export can gain a "save as a file" action for free — it is not a gap in the export module.
- Phase 5 — `expo-web-browser` / `expo-auth-session` for the MCP OAuth 2.1 + PKCE flow

`.npmrc` sets `legacy-peer-deps` (an ERESOLVE peer conflict in the Expo 57 tree). `package.json` has an `allowScripts` entry for `unrs-resolver`, whose skipped postinstall was what made Jest fail to resolve `babel-jest` by bare name — hence the `require.resolve('babel-jest')` in `jest.config.js`.
