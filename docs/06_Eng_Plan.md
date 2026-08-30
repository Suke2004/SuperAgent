# 06 — Engineering Plan

**SuperAgent / AgentRouter Mobile · Roadmap, Sprints, Quality and Risk**

| | |
|---|---|
| **Version** | 1.3 |
| **Status** | Current — Phases 0, 1, 2 and 3 complete, harness budgeting layer landed ahead of schedule, Phase 4 next |
| **Planning horizon** | 2026-08-29 → 2027-04 (six phases, twelve 2-week sprints) |
| **Audience** | Engineers picking up a sprint, and anyone deciding what to cut |
| **Companion docs** | [05_Data_Model.md](05_Data_Model.md) · [07_Deployment.md](07_Deployment.md) · [PRD.md](../PRD.md) · [TRD.md](../TRD.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [progress.md](../progress.md) |

---

## Executive summary

This document turns the product intent in [PRD.md](../PRD.md) into a sequenced, estimated, testable plan: what gets built in which two-week sprint, what "done" means for each feature, what could go wrong, and which gate stops a bad change from reaching a device. It is written for the engineer who has been handed a sprint and needs to know not just the tasks but the *order constraints* — because in this codebase the ordering is where the risk lives. Streaming transport must land before retry policy, and retry policy before error classification, since each one's correctness is defined in terms of the previous one's observable behaviour.

The project is a solo-maintained, offline-first Android chat client for LLM gateways with no server component and no telemetry. That shapes every plan decision in this document. There is no staged server rollout to hide a bad release behind, no analytics to tell us a feature is unused, and no way to fix a corrupted device database remotely. The compensating controls are heavy static verification (TypeScript strict, ESLint, a 976-test Jest suite that runs in about five seconds), a deliberate architectural rule that all non-trivial logic lives in pure `.ts` modules where it can be tested, and physical-device verification as a release gate rather than a nice-to-have.

Phases 0, 1 and 2 are complete: foundation, both transport adapters, the SQLite schema, streaming chat, search, error handling, CI, list virtualisation and paging, tags, pin/archive, two-tier search, bulk operations and export. One block of Phase 4/5 work has also landed early, out of sprint order and at the maintainer's request: the **harness budgeting layer** (§4.1), which fixes three token losses that were costing window on every turn and adds prompt caching. Phases 3 through 6 — attachments and documents, the rest of context management, MCP and tools, and polish/observability — are planned here at sprint granularity with story points, acceptance criteria and risks. §5 is the critical path. §10 is the risk register, and the five risks the product brief calls out by name (auth failure, mid-stream network loss, context overflow, Keystore unavailability, FTS5 absence) each have a named mitigation that is already partly in code. §11 is the technical-debt register, seeded from the hazards identified in [05_Data_Model.md](05_Data_Model.md) §12.

**The one thing to take away:** the quality gates in §8 are not negotiable per-sprint, because with no server and no telemetry, a gate skipped is a defect shipped to a device we cannot reach.

---

## 1. Baseline: where the project actually is

| Dimension | Status as of 2026-08-30 |
|---|---|
| Phases complete | 0 (foundation + transport), 1 (core chat), 2 (list & organisation), 3 (attachments & documents), plus the harness budgeting layer out of order (§4.1) |
| Phases remaining | 4 (context — partly pre-built), 5 (MCP & tools), 6 (polish & observability). The PRD's Phase 3 also listed speech-to-text, TTS, image generation and share-target registration; this plan never scheduled them and they are unbuilt |
| Test suite | 976 tests / 32 suites, ~4 s — measured, and enforced by CI |
| Coverage | lines 64.14% · statements 63.10% · branches 62.34% · functions 51.30%, against a floor of 64 / 63 / 62 / 51 |
| Source size | ~34,100 lines (`src` + `app`) |
| Schema | `PRAGMA user_version = 3` (`conversations`/`messages` → FTS5 → `memories`) |
| Toolchain | Expo SDK 57, RN 0.86.2, React 19.2.3, TypeScript 6.0.3, New Architecture on |
| CI | **Green.** [`ci.yml`](../.github/workflows/ci.yml) runs the three gates plus a coverage floor on every push and PR; [`build-apk.yml`](../.github/workflows/build-apk.yml) builds by hand or by `v*` tag (§9) |
| Live gateway verification | **Blocked** on a real API key |

Two honest caveats that affect planning:

1. **The gates were re-run, and coverage is now a gate rather than a note.** `tsc --noEmit`, `eslint .` and `jest` are green in this worktree at the figures in the table above; `jest.config.js` carries a `coverageThreshold` set two points under the measured run, so the number is enforced by the runner instead of transcribed into a markdown file. This was the first task of Sprint 5 and the reason CI exists at all.
2. **No end-to-end verification against a live gateway has happened.** Every transport behaviour is verified against injected `fetch` fixtures built from the documented wire formats. That is genuinely good coverage of *our* parsing and *our* error mapping; it is zero coverage of the gateway actually behaving as documented. This is the single largest source of unknown-unknowns in the plan and it is tracked as R-01.

### 1.1 Decisions that are settled

These are recorded in `progress.md` as "decisions a new session should not silently undo", and the plan assumes them. Reversing any one is a re-plan, not a task:

- Two base-URL conventions, never interchangeable: Anthropic takes a bare origin plus `POST /v1/messages`; OpenAI-compatible takes an origin ending in `/v1` plus `POST /chat/completions`.
- API keys live only in SecureStore. Never in Zustand, never in AsyncStorage ([05_Data_Model.md](05_Data_Model.md) §2).
- Retry only on `rate_limited | server | network`. Failover only on `network`, and only before the first stream event.
- Honest static User-Agent (`AgentRouterMobile/1.0 (Android)`). Never spoof another client — the gateway's terms ban it and it is a bannable offence.
- MCP over HTTP/SSE only. **No stdio** — Android cannot spawn local processes.
- No telemetry, no analytics, no third-party crash reporting. Everything stays on device.
- Logic lives in pure `.ts` modules because Jest matches `.ts` only; components are deliberately not unit-tested.

---

## 2. Roadmap and timeline

```
2026        Sep         Oct         Nov         Dec       2027 Jan     Feb     Mar
        │           │           │           │           │           │           │
PHASE 1 ████████████████████████████████ (COMPLETE — retrospective in §3)
  S1  Week 1-2   setup · navigation · Zustand stores            ✔ 21 pts
  S2  Week 3-4   streaming transport adapters                   ✔ 34 pts
  S3  Week 5-6   SQLite schema · persistence · search           ✔ 29 pts
  S4  Week 7-8   UI polish · error handling · device testing    ✔ 24 pts

PHASE 2         ████████████ (COMPLETE — divergences in the §4 retrospective)
  S5  Week 9-10  CI/CD · green baseline · list virtualisation   ✔ 21 pts
  S6  Week 11-12 tags · pin/archive · search UI · export        ✔ 26 pts

  H   out of order  harness token budget · trim ladder ·        ✔ (§4.1)
                    tool manifest cost · prompt caching
                    — pulls slices of S9 and S11 forward

PHASE 3         ████████████ (COMPLETE — divergences in the §4 retrospective)
  S7  Week 13-14 image capture · resize · base64 pipeline        ✔ 29 pts
  S8  Week 15-16 PDF/text documents · extraction · size guards   ✔ 24 pts

PHASE 4                                 ░░░░░░░░░░░░  context management
  S9  Week 17-18 pressure gauge · drop_oldest · exclusions         26 pts
  S10 Week 19-20 rolling summary · throughSeq · budget selection    31 pts

PHASE 5                                             ░░░░░░░░░░░░  MCP & tools
  S11 Week 21-22 MCP over HTTP/SSE · tool_use loop                 34 pts
  S12 Week 23-24 tool approval UX · result rendering · limits      26 pts

PHASE 6                                                         ░░░░░░  polish
  S13 Week 25-26 observability · perf hardening · a11y · 1.0        24 pts
        │           │           │           │           │           │           │
        └─ alpha ───┴───────────┴─ beta ────┴───────────┴───────────┴─ 1.0 ─────┘
           (self)                (5-10 testers)                       (release)
```

Sprint numbering continues across phases because the sprint is the unit of commitment; the phase is the unit of user-visible value. A phase that needs a third sprint takes it from the next phase rather than compressing its own testing — the alternative is a phase that is "done" with its device verification skipped, which is not done ([§18](#18-definition-of-done)).

### 2.1 Phase intent, in one line each

| Phase | Intent | User-visible outcome |
|---|---|---|
| 0 | Foundation and transport | — (infrastructure) |
| 1 | Core chat | Send a message, watch it stream, find it later |
| 2 | List & organisation | Manage hundreds of conversations without scrolling forever |
| 3 | Attachments | Ask about a photo or a PDF |
| 4 | Context management | Long conversations stop failing at the window boundary |
| 5 | MCP & tools | The model can use remote tools |
| 6 | Polish & observability | Diagnose a problem without a debugger; ship 1.0 |

---

## 3. Phase 1 sprint breakdown (complete — recorded for provenance)

Phase 1 is documented at the same granularity as the future sprints, for two reasons: velocity data for estimating Phases 2–6, and a record of *why* the sequence was what it was. The ordering here is the reason the project works, and repeating it wrongly in a later phase is a real risk.

### Sprint 1 · Week 1–2 — Setup, navigation, Zustand stores · 21 pts

| Story | Pts | Acceptance criteria |
|---|---|---|
| Expo SDK 57 + New Architecture + typed routes | 5 | `pnpm typecheck` clean; app boots on emulator and a physical Pixel |
| Expo Router file tree: chat / list / settings | 3 | Deep link to a conversation id restores that screen |
| `useSettings` persisted slice | 3 | Setting survives force-stop and relaunch |
| `useProviders` with two seeded profiles | 5 | Switching profile changes the origin used by the next request |
| `useModels` catalogue slice, `entryKey()` | 3 | Per-model override survives a discovery refresh |
| Hydration gate (`useHydrated`, 3 s timeout) | 2 | No flash of defaults on a warm start |

**Why first.** Nothing else can be tested without a place to put state and a way to reach a screen. The stores were built before any transport so that the transport had a real consumer rather than a test harness, which is how the `ChatRequest` shape ended up driven by the UI's needs instead of by the wire format.

**Risk retired:** persisted-state shape churn. Getting `partialize` right early meant later slices inherited the pattern, including the rule that it is reviewed as a security control ([05_Data_Model.md](05_Data_Model.md) §10.3).

### Sprint 2 · Week 3–4 — Streaming transport adapters · 34 pts

| Story | Pts | Acceptance criteria |
|---|---|---|
| `Transport` interface, `ChatRequest`, `StreamEvent` (13 variants) | 5 | Both adapters implement one interface; chat imports neither directly |
| Anthropic adapter: `POST /v1/messages`, SSE parse | 8 | Fixture stream yields ordered events; `pause_turn` surfaced, not swallowed |
| OpenAI adapter: `POST /chat/completions`, `GET /models` | 8 | `max_completion_tokens` alias with one retry under the old name |
| `streamingFetch` + `supportsStreaming()` probe | 5 | Non-streaming runtime degrades to buffered, and *says so* in Settings |
| Content-block encode/decode both directions | 5 | Round-trip identity test per block type ([05_Data_Model.md](05_Data_Model.md) §9) |
| Injected `fetch` for testability | 3 | Every transport test runs in `node`, no network, no mocking library |

**Why second, and why the largest sprint.** The transport defines the vocabulary — `StreamEvent`, `ContentBlock`, `TokenUsage`, `StopReason` — that persistence, UI and error handling all speak. Building it after persistence would have meant a schema designed around a guessed wire shape. It is 34 points because two dissimilar protocols behind one interface is genuinely the hardest thing in the codebase, and because the SSE parser has to be correct against truncation, keep-alives, multi-line data fields and split UTF-8 sequences.

### Sprint 3 · Week 5–6 — SQLite schema, persistence, search · 29 pts

| Story | Pts | Acceptance criteria |
|---|---|---|
| Schema v1, WAL, `foreign_keys = ON`, `user_version` migrations | 5 | Fresh install and upgrade-from-v0 both reach v1; cascade verified |
| `insertMessage` / `flattenContent` / `previewOf` / `deriveTitle` | 5 | `text` always equals `flattenContent(content)` (property test) |
| Float `seq` append / insert-between / fork | 5 | Insert between adjacent messages performs **zero** `UPDATE`s |
| FTS5 external-content index + triggers + drift rebuild | 8 | Search finds a message written before the index existed (rebuild path) |
| `LIKE` fallback for missing FTS5 and CJK | 3 | Suite passes with FTS5 forced unavailable |
| Usage events with frozen `day` and `cost` | 3 | Unpriced event stores `NULL`, and the report says "unpriced", not "$0.00" |

**Why third.** Persistence had to know the final shape of a message, which meant after the transport. It had to come before UI polish because a list screen built on in-memory data grows assumptions the database cannot satisfy — sorting by a field that is not indexed, for instance.

**The decision made here that most shaped later work:** `messages.text` as a stored projection ([05_Data_Model.md](05_Data_Model.md) §6.4). It made search and list previews cheap at the cost of an invariant to maintain, and every later sprint that adds a block type inherits an obligation from it (§B.2 of that document).

### Sprint 4 · Week 7–8 — UI polish, error handling, device testing · 24 pts

| Story | Pts | Acceptance criteria |
|---|---|---|
| `GatewayError` with 15 kinds; verbatim gateway text preserved | 5 | Every kind maps to one actionable hint; no kind renders "Unknown error" |
| Retry policy (4 attempts, 500 ms base, ×2, 20 s cap, 90 s elapsed) | 5 | `Retry-After` honoured, clamped to `[computed, maxDelayMs]` |
| Failover to the parity origin on `network` only | 3 | A 401 does **not** fail over and does not double-spend credits |
| Markdown → closed AST via `marked`, syntax highlighting | 5 | A 5,000-line reply renders without blocking input |
| FlashList v2 bottom anchoring, 60 ms publish throttle | 3 | Streaming does not fight the user's scroll position |
| Physical device pass (Pixel 6, Samsung S22) | 3 | Both devices: send, stream, background mid-stream, return, search |

**Why last.** Error handling is defined in terms of retry, which is defined in terms of the transport's observable failures (§5). Building the error UI first produces a taxonomy that does not match what actually happens on the wire — which is precisely the drift visible in `progress.md`'s stale 8-kind list versus the 15 kinds in `errors.ts` ([05_Data_Model.md](05_Data_Model.md) Appendix D).

**Velocity baseline: 27 pts/sprint** (108 across four sprints). Phases 2–6 are estimated against that, with no assumption of speed-up.

---

## 4. Phases 2–6, sprint by sprint

Each sprint lists stories with points, the acceptance criterion that proves it, and the risks it retires. Acceptance criteria are written so that a reviewer can *check* them, not interpret them. Sprints 5 and 6 have shipped and carry an outcome column; the retrospective after Sprint 6 records where they diverged from what is written here.

### Sprint 5 · Phase 2 · CI/CD and list virtualisation · 21 pts · ✅ shipped

| Story | Pts | Acceptance criteria | Test strategy | Outcome |
|---|---|---|---|---|
| Restore a runnable green baseline (`pnpm install`, gates) | 3 | `typecheck`, `lint`, `test` all pass locally and the counts are recorded in the PR | run the gates | ✅ |
| GitHub Actions CI (§9) | 5 | A PR with a deliberate type error is blocked by CI, not by review | commit a failing branch, confirm red, revert | ✅ |
| Coverage reporting with a floor | 2 | Coverage printed in the job summary; floor set at the current measured line rate, not aspirationally | `jest --coverage` | ✅ `coverageThreshold` in `jest.config.js`, ratcheted twice since |
| FlashList tuning for 1,000-message transcripts (§12) | 5 | Scroll a 1,000-message conversation at ≥55 fps on a Pixel 6; initial render <2 s | perf harness + device | ⚠️ code shipped, **fps figure unverified** — no physical device in this environment |
| `(archived, pinned DESC, updated_at DESC)` index ([05_Data_Model.md](05_Data_Model.md) §11.3) | 2 | `EXPLAIN QUERY PLAN` shows `SEARCH … USING INDEX conversations_list`; no `TEMP B-TREE` | planner assertion test | ✅ index shipped as `conversations_list (archived, pinned DESC, updated_at DESC, id DESC)`; the fourth column is what removes the `TEMP B-TREE` |
| Fix in-memory vs stored preview drift (§12.2 of the data model) | 1 | Preview identical before and after a relaunch, for a reply starting with a code fence | unit test on the store action | ✅ |
| Cursor paging for the conversation list | 3 | 500 conversations: list opens in <400 ms, no `OFFSET` in the SQL | integration test | ✅ keyset paging; the "no `OFFSET`" half is asserted, the millisecond half is device-pending |

**Why CI first in Phase 2.** Everything after this sprint is riskier than everything before it, because Phases 3–5 touch binary data, context arithmetic and remote tools. Adding automation *after* the risky work is how a regression reaches a device. Also: the baseline currently exists only as a number in a markdown file, which is the definition of an unverified claim.

### Sprint 6 · Phase 2 · Tags, organisation, export · 26 pts · ✅ shipped

| Story | Pts | Acceptance criteria | Test strategy | Outcome |
|---|---|---|---|---|
| Tag CRUD with `parseTags()` semantics | 3 | `Work, work , WORK` yields one tag spelled `Work` | unit (already partly covered) | ✅ |
| Tag filter chips with counts, most-used first | 3 | Chips only offer tags present on screen; a chip never filters to zero rows | unit on `tagCounts` | ✅ |
| Pin / archive with grouped headings | 3 | Pinned group appears above `Today` regardless of age | unit on `buildRows` | ✅ |
| Two-tier search UI (instant filter + debounced FTS section) | 5 | Every instant-filter hit is visibly justified by its own title/preview/tag/model | unit + device | ✅ unit; the `LIKE` fallback for FTS5-less devices is kept and tested |
| Bulk select: archive, delete, retag | 5 | Deleting 50 conversations is one transaction; usage events survive | integration | ✅ one transaction, chunked at `BULK_CHUNK = 400` parameters ([05_Data_Model.md](05_Data_Model.md) §5.3) |
| Export a conversation (Markdown + JSON) | 5 | Exported file contains **no** API key; verified by a test that greps the artefact | **mandated security test** | ✅ `src/chat/export.test.ts` — 35 tests, greps the artefact against a hostile fixture; delivery is clipboard + share sheet rather than a file (see the retrospective below) |
| Empty, loading and error states for the list | 2 | No spinner without a cancel path; no error without an action | device | ✅ |

**Risk retired:** R-07 (unbounded list growth). Also closes the mandated-but-unwritten security test: *the API key never appears in any log output or exported file*. Both 1.0-gate security tests now exist and pass — `src/lib/redact.test.ts` for the log and `src/chat/export.test.ts` for the artefact.

### Phase 2 retrospective · where the plan was wrong, and what shipped instead

Same reasoning as §9.4: recorded rather than edited away, because the value of a
plan is calibration, and calibration needs the misses.

| Planned | Shipped | Why |
|---|---|---|
| "Exported **file**" | Clipboard (`expo-clipboard`) and the Android share sheet (React Native `Share`) | `expo-file-system` and `expo-sharing` are not dependencies — they are scheduled under Phase 3 with the attachment pipeline that actually needs them. Adding them a phase early to write a file the share sheet can already hand to Drive, Keep or an email client would have been two new native modules for no capability the user lacks. |
| (unstated) | `SHARE_BYTE_LIMIT = 256 * 1024`, above which `share` silently downgrades to `copy` and says so | The share intent crosses an Android Binder transaction with a ~1 MB parcel ceiling. A 40-conversation bundle passes it easily. The alternative to downgrading is an opaque `TransactionTooLargeException` on a code path the user cannot retry differently. |
| (unstated) | Redaction runs **twice** — per string during assembly, then over the whole finished artefact | One pass is one missed field away from a leak, and the fields are added by future changes rather than this one. The second pass is safe after `JSON.stringify` because `[REDACTED]` contains no character JSON escapes. |
| (unstated) | Attachment bytes are never exported; images become `{ mediaType, bytes, included: false }` | A base64 photo is ~9 MB of string. Putting it through the clipboard is not an export, it is a hang. |
| Sprint 6's export story sits in Phase 2 | Phase 6 also lists an export item | It is the same feature; Phase 6's line is already delivered. Noted so a later sprint does not build it twice. |
| (unstated) | Bulk delete keeps `usage_events`, `memories` and forked children | Cost history is an accounting record about the past, not a property of the row; a memory is meant to outlive its source conversation. Both are soft references on purpose ([05_Data_Model.md](05_Data_Model.md) §5.3). |

### 4.1 Out-of-order work · harness token optimization · ✅ shipped

Requested directly after Phase 2 and built immediately, ahead of Sprint 7. It is
recorded here rather than folded into Sprint 9 because it did not follow the plan:
it pulled a slice of Phase 4 (budgeting, trimming, context pressure arithmetic) and
a slice of Phase 5 (what tool definitions cost per turn) forward by four sprints,
and it changed acceptance criteria that later sprints were written against.

Three of the four items were **defect repair, not features** — the app worked and
was quietly throwing away context window on every turn:

| Defect | Cost | Fix |
|---|---|---|
| Thinking double-counted in the history budget | Up to 128k tokens of a 200k window per reasoning turn at effort `max`. `max_tokens` on the Anthropic path is the total output allowance *including* thinking; the store reserved `maxTokens + budgetTokens` | `replyReservation()` in `src/chat/budget.ts`, with the reason attached to the function so the addition is not reintroduced |
| Memory block and tool definitions absent from the prefix estimate | A request could exceed a window the planner had just called roomy — the exact failure trimming exists to prevent | `prefixCost()` counts the composed system prompt (prompt + memory + summary) and every tool definition, via the same `estimateToolTokens` the request estimator uses, so the two cannot drift |
| Two disagreeing budget calculations (store vs composer gauge) | The gauge and the send path could differ on whether a turn fit | `planTurn()` is the single home; `app/chat/[id].tsx` reads the same function |
| `usage.cacheRead` displayed but structurally always zero | Every turn re-paid full input price for an identical prefix. In a long conversation the prefix *is* the cost | `src/chat/cache.ts` plans breakpoints; the Anthropic adapter expresses them via `CacheMarks` |

Plus one behaviour change: **trimming is a ladder, not a cliff.** Replayed
reasoning goes first (largest, and worth almost nothing to the next turn), then
long tool results are truncated middle-out, and only then are whole turns dropped.
`settings.progressiveTrim` returns to the old behaviour in one switch.

**Consequences for later sprints — read these before planning Sprint 9:**

- **Sprint 9's first story is largely done.** `contextPressure` already measures
  against usable space, and `planTurn` now supplies the reserved figure without
  double-counting thinking. What remains is the gauge UI, the `warn` confirmation,
  per-message `excluded` persistence, and the ±15% estimator-accuracy corpus, which
  still needs a real key (R-01).
- **Sprint 9's `drop_oldest` story shrinks and moves.** `selectMessagesWithinBudget`
  is now the *last* rung of `trimToBudget`, not the strategy itself. The orphan case
  it names as "the bug" is still the bug and still tested where it was.
- **Sprint 11/12 inherit a tool budget.** `selectTools` and `describeWithheldTools`
  exist and are tested but have no call site, because tools do not reach
  `buildRequest` until MCP lands. Wiring them is a story in Sprint 11, not a rewrite.
- **The fourth `cache_control` breakpoint is reserved for the tool loop.** The API
  allows four; this layer spends at most three. Sprint 11 gets the last one for tool
  results appended mid-turn — do not spend it earlier.
- **A new per-model flag exists:** `ModelCapabilities.promptCache`, defaulting off
  for anything not recognised as Claude. Sprint 13's model-registry work should
  surface it alongside `documents` and `extendedEffort`.
- **A new risk, not yet in §10 as a numbered entry because it resolves on first
  contact:** whether this gateway forwards `cache_control` upstream and returns
  `cache_read_input_tokens`. If it accepts the marker, charges the 1.25× write
  premium and serves nothing back, caching is a 25% surcharge on the marked prefix.
  `describeCacheOutcome` reports precisely that case, and `promptCache: false` is the
  off switch. One real two-turn conversation settles it.

**Delivered:** `src/chat/budget.ts`, `src/chat/trim.ts`, `src/chat/tools.ts`,
`src/chat/cache.ts`; `CacheMarks` in `src/transports/types.ts`; `cache_control` and
merge-aware marker placement in `src/transports/anthropic.ts`; `promptCache` in
`src/transports/support.ts`; `estimateToolTokens` exported from `src/lib/tokens.ts`;
`promptCaching` and `progressiveTrim` settings with a **Token usage** section in
`app/settings/appearance.tsx`; 87 new tests. Coverage floor ratcheted to
62 / 61 / 60 / 48. All three gates green.

### Sprint 7 · Phase 3 · Images · 29 pts · ✅ shipped

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| Camera + library picker (`expo-image-picker`) with permission copy | 3 | Denied permission shows a settings deep link, not a dead button | device |
| Downscale and re-encode before base64 | 8 | A 12 MP photo becomes ≤1568 px on the long edge and <1.5 MB base64 | unit on the sizing function + device |
| `ImageBlock` storage and both wire encodings | 5 | Round-trip identity per adapter ([05_Data_Model.md](05_Data_Model.md) §9) | unit |
| Attachment size guard with a per-request budget | 5 | Adding an image that would exceed the budget is refused *before* the request, with the number shown | unit |
| Thumbnail rendering in the transcript, full-screen viewer | 3 | Scrolling past 20 images does not spike memory beyond 250 MB on a Pixel 6 | device + memory profile |
| Token estimate for images (2,500 tokens each) in the gauge | 2 | Gauge changes when an image is attached; the estimate never reaches `messages.usage` | unit |
| `excluded` toggle interacts correctly with attachments | 3 | Excluding a message with an image removes its cost from the estimate | unit |

**The hard part is not the picker, it is memory.** Base64 of a full-resolution photo is a ~9 MB JavaScript string, and the bridge copies it. Downscaling before encoding is the whole feature; everything else is plumbing. The acceptance criterion is a byte budget, not "it works".

### Sprint 8 · Phase 3 · Documents · 24 pts · ✅ shipped

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| Document picker, `DocumentBlock` storage | 3 | PDF and `.txt` both store with `mediaType` and optional extracted `text` | unit |
| Anthropic native PDF documents | 5 | PDF sent as `{type:'document', source:{type:'base64', media_type:'application/pdf'}}` | fixture test |
| Text extraction path for non-native types | 5 | Extracted text used when present; placeholder string when not | unit |
| OpenAI degradation (no native documents) | 3 | Extracted text inlined; user warned in the composer, not after the failure | unit + device |
| `flattenContent()` covers documents (name fallback) | 2 | Searching a PDF's filename finds the message | unit |
| Capability gating via `ModelCapabilities.documents` | 3 | Attach affordance hidden for models that cannot accept documents | unit |
| Size and page limits with a clear refusal | 3 | A 60 MB PDF is refused with its size shown, before any encoding work | unit |

**Note on `ModelCapabilities.documents`:** it already exists in `src/transports/support.ts`. `progress.md` lists its absence as a known gap; that entry is stale ([05_Data_Model.md](05_Data_Model.md) Appendix D). Verify before building. — Verified: it existed, and `app/settings/model/[key].tsx` already exposed it. No work needed.

### Phase 3 retrospective · where the plan was wrong, and what shipped instead

Both sprints shipped in full. Four notes.

**The plan under-estimated how much already existed and over-estimated the picker.** `ImageBlock` storage and both wire encodings (Sprint 7, 5 pts) were already done in Phase 1 with round-trip tests, as was `flattenContent()`'s document handling (Sprint 8, 2 pts) and the 2,500-token image figure. What actually consumed the sprint was the two guard layers the tables allot 5 and 3 points to: a refusal that names both numbers involved, at four separate limits (per image, per message, by count, per document type), evaluated in an order where the *most* specific complaint wins. `admitImage` checks the media type before the count so a TIFF at eight attachments is not blamed on the limit.

**Two acceptance criteria were rewritten because they were unfalsifiable here, and both rewrites are recorded rather than quietly substituted.** "Scrolling past 20 images does not spike memory beyond 250 MB on a Pixel 6" and the 12 MP/1.5 MB byte budget are device criteria with no device attached. What is asserted instead is the *decision* each one was protecting: `planResize` produces 1568 px on the long edge with the ratio preserved for a 4032×3024 source, and `admitImage` refuses anything still over 1.5 M base64 chars after the ladder. The memory ceiling itself is unverified and is listed as such in `progress.md`.

**Capability gating deviates from the story as written, deliberately.** Sprint 8 says "Attach affordance hidden for models that cannot accept documents". Hiding it is wrong here: `ModelCapabilities.vision` and `.documents` are *hand-edited* flags, because the gateway's `/v1/models` returns ids and nothing else — so a hidden affordance is indistinguishable from a missing feature, and the fix (Settings → Models) is undiscoverable. The rows are shown and disabled with the reason naming the flag and where to flip it. This is the same principle `Sheet` was built on and is recorded in §11 as a spec correction, not debt.

**Documents needed a third outcome.** The plan models document support as a boolean per model. The OpenAI-compatible path has no document block at all, so a PDF there is neither supported nor a capability problem — it is refused for a structural reason, while a *text* file on the same path is supported but lossy. `documentSupport` returns `{supported, reason, native}` and `documentCaveat` produces the composer's warning, which satisfies "user warned in the composer, not after the failure" more precisely than a boolean could.

**Shipped:** `src/chat/attachments.ts` (pure, ~560 lines), `src/chat/attach.ts` (impure), `src/db/content.ts` (extracted from `conversations.ts` so the §8.3 projection is testable at all), the composer's attachment strip and paperclip, a full-screen image viewer, staged-attachment state in `src/stores/chat.ts`, the attach and refusal sheets in `app/chat/[id].tsx`, `expo-image-picker` permission copy in `app.json`; 72 new tests. Coverage floor ratcheted to 64 / 63 / 62 / 51. All three gates green.

**Out of scope and not delivered:** the PRD's Phase 3 row also lists on-device speech-to-text, system TTS, `/v1/images/generations` feature detection and Android share-target registration. This plan's Phase 3 is Sprints 7–8 only and never scheduled them; they are unbuilt, and `progress.md`'s "what to do next" carries them as an explicit open question rather than an assumed deliverable.

### Sprint 9 · Phase 4 · Context pressure and exclusions · 26 pts

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| `contextPressure` computed against **usable** space | 5 | Usable = window − reserved output − reserved thinking; gauge never reads 40% on a request that will be rejected | unit, table-driven |
| Gauge UI with three bands and the number | 3 | Bands at documented thresholds; exact token estimate visible on tap | device |
| `warn` strategy | 2 | Sending above threshold requires one confirmation, never blocks silently | device |
| `drop_oldest` with orphan removal | 5 | `selectMessagesWithinBudget` newest-first; a leading orphaned assistant message is dropped, not sent | unit — the orphan case is the bug |
| `setExclusions` per message, persisted in `excluded` | 3 | Exclusion survives relaunch; excluded message greyed, not hidden |unit + device |
| Heuristic estimator accuracy check (3.8 chars/token Latin, 0.9 tok/char CJK) | 5 | Estimate within ±15% of gateway-reported input tokens across a 20-fixture corpus | unit against recorded usage |
| Never persist an estimate | 3 | Property test: no code path writes to `messages.usage` without a gateway response | unit |

**The subtle requirement is the denominator.** Measuring pressure against the raw context window is the intuitive implementation and it is wrong: a request that fits the window but leaves no room for the reserved output allocation still fails. Pressure must be measured against usable space or the gauge lies exactly when it matters.

### Sprint 10 · Phase 4 · Rolling summary · 31 pts

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| `summarise` strategy end to end | 8 | Prefix through `throughSeq` replaced by one summary block; nothing double-counted, nothing dropped | unit + integration |
| Summary generation request (separate turn, own budget) | 5 | Summarisation does not consume the user's reply budget; its usage is recorded as its own `usage_event` | integration |
| `summary.throughSeq` persistence and merge-not-replace writes | 3 | Two settings changed in sequence do not clobber each other ([05_Data_Model.md](05_Data_Model.md) §10.2) | unit |
| Re-summarise when the summary itself grows too large | 5 | Summary of summaries terminates; no unbounded growth | unit |
| Failure path: summarisation fails → fall back to `drop_oldest` | 3 | User sees one warning, the turn still sends | unit |
| Show the user what was dropped or summarised | 5 | An inline affordance lists the elided range and can expand it | device |
| `pause_turn` handling for very long Anthropic turns | 2 | `pause_turn` continues the turn rather than presenting it as an end | fixture |

**Why this is the largest remaining sprint.** Summarisation is the only feature that spends the user's money without being asked to. It needs its own budget, its own usage row, its own failure path, and a visible account of what it did — otherwise a user's bill grows for reasons they cannot see, which is a trust failure, not a bug.

### Sprint 11 · Phase 5 · MCP over HTTP/SSE and the tool loop · 34 pts

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| MCP client over HTTP/SSE (**no stdio**) | 8 | Connects, lists tools, calls one, handles a server that never responds | fixture server |
| Server config storage (URL + headers) | 3 | Header values with secret-looking names redacted in logs and never in AsyncStorage in plaintext form beyond what the user typed | unit |
| Tool schema → `tool_use` request wiring, both adapters | 8 | Anthropic `tools[]` and OpenAI `tools[].function` generated from one stored schema | unit |
| Tool loop: `tool_use` → execute → `tool_result` → continue | 8 | A two-round tool conversation completes; loop bounded by a max-iteration guard | integration |
| `stop_reason: tool_use` / `tool_calls` handling | 3 | Neither is presented to the user as a finished answer | fixture |
| Timeout and cancellation per tool call | 4 | Cancelling mid-tool leaves the transcript consistent, no half-written `tool_result` | integration |

**Bounded loops are a hard requirement, not a nicety.** A model that keeps calling a tool that keeps failing will spend money until the user notices. The max-iteration guard, its default, and the message shown when it trips are part of the acceptance criteria.

### Sprint 12 · Phase 5 · Tool approval and rendering · 26 pts

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| Per-tool approval modes: always ask / allow / deny | 5 | Default is **ask**; "allow" is per tool per server, never global | unit + device |
| Approval UI showing the exact arguments | 5 | Arguments rendered readably; secret-looking values redacted in the prompt | device |
| `tool_result` rendering incl. `isError` | 3 | Errors visually distinct; long results collapsed with an expander | device |
| Nested content in tool results (recursive blocks) | 5 | An image returned by a tool renders | unit + device |
| Per-server rate and payload limits | 5 | A tool returning 10 MB is truncated with a visible notice | unit |
| Kill switch: disable all MCP in one tap | 3 | Disabling takes effect on the next turn without a relaunch | device |

**Approval defaults to ask.** A remote tool call is arbitrary code running somewhere else with the user's data. The convenient default is dangerous, so the default is the safe one.

### Sprint 13 · Phase 6 · Observability, performance, 1.0 · 24 pts

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| Debug log screen: filter, copy, share | 3 | Copy produces redacted text; no unredacted value can reach the clipboard | **mandated security test** |
| Per-request timing surfaced (`firstTokenMs`, `latencyMs`) | 3 | Both recorded in `meta` and visible per message | unit |
| Performance panel: fps during stream, DB timings | 5 | Numbers gathered on device, no third-party SDK | device |
| Accessibility pass | 5 | TalkBack reads the transcript in order; targets ≥44 dp; contrast ≥4.5:1 | device + audit |
| Streaming-partial scratch row (data model §12.3), if justified | 5 | Process death mid-stream recovers the partial reply, one row rewritten per tick | integration |
| 1.0 release checklist and docs refresh | 3 | [07_Deployment.md](07_Deployment.md) checklist fully green; `progress.md` accurate | review |

---

## 5. Critical path

```
                    ┌──────────────────────┐
                    │  Zustand stores      │  S1
                    │  (a consumer exists) │
                    └───────────┬──────────┘
                                │
                    ┌───────────▼──────────┐
                    │ STREAMING TRANSPORT  │  S2  ◄── defines the vocabulary:
                    │ SSE parse, adapters  │        StreamEvent, ContentBlock,
                    └───────────┬──────────┘        TokenUsage, StopReason
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
    ┌─────────▼──────┐ ┌────────▼───────┐ ┌───────▼────────┐
    │ RETRY POLICY   │ │ SQLite schema  │ │ Context/tokens │
    │ backoff, jitter│ │ (needs final   │ │ (needs usage   │
    │ Retry-After    │ │  message shape)│ │  shape)        │
    │        S2/S4   │ │           S3   │ │          S9    │
    └─────────┬──────┘ └────────┬───────┘ └───────┬────────┘
              │                 │                 │
    ┌─────────▼──────┐ ┌────────▼───────┐ ┌───────▼────────┐
    │ ERROR CLASSIF- │ │ FTS5 + search  │ │ Summarisation  │
    │ ICATION (15    │ │ + fallback     │ │        S10     │
    │ kinds, hints)  │ │           S3   │ └────────────────┘
    │           S4   │ └────────────────┘
    └─────────┬──────┘
              │
    ┌─────────▼──────────────────────────────┐
    │ FAILOVER (network only, pre-first-event)│  S4
    └─────────┬──────────────────────────────┘
              │
    ┌─────────▼──────────────────────────────┐
    │ MCP / TOOL LOOP  (needs every failure   │  S11
    │ mode above to already be classified)    │
    └─────────────────────────────────────────┘
```

**Streaming transport → retry policy → error classification** is the ordering that matters most, and the reason is that each stage's correctness is *defined by* the previous stage's observable behaviour:

1. **Transport before retry.** "Retryable" is a statement about what the transport actually reports. `isRetryableKind()` admits exactly `rate_limited | server | network`; you cannot decide that set without knowing which failures the SSE parser can distinguish. A parse failure mid-stream and a socket reset look identical until the parser tells you otherwise, and one is retryable while the other is not.
2. **Retry before classification.** A user-facing error is the *final* state after retries are exhausted. Classify first and you build UI for a transient 503 the user should never have seen; `withExhaustedNote()` exists because "server error" and "server error, after four attempts over 90 seconds" call for different words.
3. **Classification before failover.** Failover is a decision keyed on `kind === 'network'`. Without a trustworthy kind, failover fires on a 401 — retrying an auth failure against a second origin, spending the same credits to fail the same way, and sending the user hunting an allowlist problem they do not have.
4. **Classification before MCP.** The tool loop multiplies failure modes: a tool can fail, the gateway can fail while a tool is in flight, and a tool can succeed with an error payload. Building it on an incomplete taxonomy produces `unknown` errors, which is the one outcome the 15-kind union exists to prevent.

**Parallelisable work** (safe to do out of order): list UI and grouping, tags, Markdown rendering, accessibility, export, the debug-log screen, index tuning. These depend on shapes, not on behaviours.

**Non-negotiable prerequisite for Phase 5:** `DEFAULT_RETRY_POLICY` (4 attempts, 500 ms base, ×2 factor, 20 s per-delay cap, 90 s total elapsed, full jitter) applies to tool calls too, or a flaky MCP server turns into an unbounded spend.

---

## 6. Estimates

### 6.1 Story point scale

Points measure uncertainty and coordination cost, not hours. The scale is calibrated to this codebase:

| Pts | Meaning | Example from Phase 1 |
|---|---|---|
| 1 | One obvious change, existing test extends | fix the preview drift |
| 2 | Small, contained, one new test | hydration gate |
| 3 | Clear approach, a few files, new tests | tag parsing |
| 5 | Design decision required, or crosses a layer | retry policy |
| 8 | Genuinely uncertain, or must be verified on device | FTS5 + rebuild + fallback |
| 13 | Too big — split it | (never used) |

Anything estimated 13 gets decomposed in planning. The two 34-point sprints (S2, S11) are sums, not single stories.

### 6.2 Totals

| Phase | Sprints | Points | Cumulative | Calendar |
|---|---|---|---|---|
| 1 (done) | S1–S4 | 108 | 108 | Weeks 1–8 |
| 2 | S5–S6 | 47 | 155 | Weeks 9–12 |
| 3 | S7–S8 | 53 | 208 | Weeks 13–16 |
| 4 | S9–S10 | 57 | 265 | Weeks 17–20 |
| 5 | S11–S12 | 60 | 325 | Weeks 21–24 |
| 6 | S13 | 24 | 349 | Weeks 25–26 |

At the observed 27 pts/sprint, the remaining 241 points need ~9 sprints; nine are planned. **There is no slack in this plan.** That is a deliberate statement rather than an oversight: with a solo maintainer, the realistic buffer is not padded estimates but a scope-cut list agreed in advance (§Appendix B).

### 6.3 What gets cut first, if it must

In order, most-cuttable first: (1) the streaming-partial scratch row (S13 — the loss is recoverable by regenerating), (2) bulk operations beyond delete (S6), (3) nested content in tool results (S12 — text-only results cover the common case), (4) re-summarise-the-summary (S10 — cap conversation length instead), (5) the performance panel (S13 — keep the timings in `meta`, drop the UI).

Never cut: the export/log redaction tests, the `LIKE` search fallback, the retry policy, tool approval defaults, or physical-device verification.

---

## 7. Test strategy

### 7.1 The pyramid, and how this project achieves it

```
            ▲
           /5\        E2E — 5%
          /────\      manual on physical devices, scripted protocol
         /  15  \     INTEGRATION — 15%
        /────────\    store + db + transport with injected fetch and an
       /          \   in-memory SQLite, no network, no UI
      /     80     \  UNIT — 80%
     /──────────────\ pure .ts modules: transports, db logic, chat/, lib/
    ────────────────
```

The shape is not aspirational — it falls out of an architectural rule. `jest.config.js` matches `.ts` only, in a `node` environment. Components are `.tsx`, so **logic in a component is logic with no test**. The response has been to push every decision into a pure module: `src/chat/list.ts` holds the list's filtering and grouping, `src/chat/request.ts` holds request validation, `src/lib/tokens.ts` holds estimation, `src/db/conversations.ts` holds every SQL statement. Screens keep the hooks and nothing else.

**The tradeoff, stated honestly.** This buys a fast, deterministic suite (976 tests in ~4 s) and near-total coverage of decision logic. It buys *zero* coverage of rendering, gesture handling, navigation and layout. A component that fails to render is caught by a human on a device or not at all. Adding `jest-expo` + React Native Testing Library would close that gap and cost a much slower suite, a jsdom-shaped environment that is not the real runtime, and a category of test that historically breaks on every RN upgrade. For a solo maintainer shipping to Android with a scripted device protocol ([07_Deployment.md](07_Deployment.md)), the current split is the better trade. **Revisit it if a second engineer joins**, because the calculus changes when a regression can be introduced by someone who did not write the original code.

### 7.2 What each tier covers

| Tier | Scope | Runner | Gate |
|---|---|---|---|
| Unit | pure functions, transports (injected `fetch`), db logic, redaction, tokens, retry | `jest`, `node` | CI, every push |
| Integration | store↔db↔transport turn orchestration, migrations, FTS rebuild, tool loop | `jest`, `node`, in-memory SQLite | CI, every push |
| E2E | the six flows in §17, on real hardware | human, scripted | release only |

### 7.3 Test cases that must exist (and their current status)

```ts
// SECURITY — mandated, currently unwritten. Blocks the 1.0 gate.
it('never emits the API key in the debug log', () => {
  registerSecret('sk-ant-api03-REALKEYSHAPED-VALUE-0123456789');
  debugLog.request({ transport: 'anthropic', method: 'POST',
    url: 'https://agentrouter.org/v1/messages',
    headers: { 'x-api-key': 'sk-ant-api03-REALKEYSHAPED-VALUE-0123456789' } });
  expect(debugLog.toText()).not.toContain('REALKEYSHAPED');
  expect(debugLog.toText()).toContain('[REDACTED]');
});

it('never emits the API key in an exported conversation', async () => {
  const md = await exportConversation(conversationWithKeyInSystemPrompt);
  expect(md).not.toMatch(/sk-(ant-)?[A-Za-z0-9_-]{8,}/);
});
```

```ts
// PERSISTENCE — the invariant that denormalisation depends on.
it('keeps messages.text equal to flattenContent(content)', async () => {
  for (const blocks of BLOCK_FIXTURES) {                 // all six block types
    const id = await insertMessage(conv, { role: 'assistant', blocks });
    const row = await getMessageRow(id);
    expect(row.text).toBe(flattenContent(JSON.parse(row.content)));
  }
});

// SEQ — the claim that makes REAL worth its oddity.
it('inserts between two messages with zero UPDATEs', async () => {
  const stmts = await recordStatements(() => insertBetween(conv, 2, 3));
  expect(stmts.filter((s) => /^UPDATE/i.test(s))).toHaveLength(0);
});

// SEARCH — must survive a build without FTS5.
it('falls back to LIKE when FTS5 is unavailable', async () => {
  withFts5Disabled(async () => {
    await expect(searchMessages('needle')).resolves.toContainMessageWith('needle');
  });
});

// RETRY — the classification boundary.
it.each`
  status | kind                    | retryable
  ${401} | ${'key_rejected'}       | ${false}
  ${403} | ${'forbidden'}          | ${false}
  ${402} | ${'insufficient_credits'} | ${false}
  ${429} | ${'rate_limited'}       | ${true}
  ${500} | ${'server'}             | ${true}
  ${400} | ${'bad_request'}        | ${false}
`('classifies $status as $kind (retryable=$retryable)', ({ status, kind, retryable }) => {
  const err = classifyHttpError(status, 'gateway text', {});
  expect(err.kind).toBe(kind);
  expect(isRetryableKind(err.kind)).toBe(retryable);
});

// FAILOVER — must not fire on an auth failure.
it('does not fail over on a 401', async () => {
  const calls = [];
  await expect(withFailover(recordingRun(calls), { enabled: true })).rejects.toThrow();
  expect(calls.map((c) => c.baseUrl)).toEqual(['https://agentrouter.org']);  // once only
});

// CONTEXT — the orphan case.
it('drops a leading orphaned assistant message when trimming', () => {
  const kept = selectMessagesWithinBudget(TRANSCRIPT, TINY_BUDGET);
  expect(kept[0].role).not.toBe('assistant');
});
```

Four more joined the list with the harness layer (§4.1). Each one pins a defect
that produced no error — the app worked and lost tokens, or worked and paid a
premium — which is the category unit tests are worth the most against:

```ts
// BUDGET — max_tokens already includes thinking on this path.
it('does not double-count thinking', () => {
  expect(replyReservation({ maxTokens: 32_000 }, { enabled: true, budgetTokens: 24_000 })).toBe(32_000);
});

// TRIM — a thinking block before a tool_use must come back verbatim, or 400.
it('keeps thinking in a message containing a tool_use', () => {
  const report = trimToBudget(TRANSCRIPT_WITH_TOOL_CALL, TINY_BUDGET);
  expect(report.messages[3].content.some((b) => b.type === 'thinking')).toBe(true);
});

// TOOLS — cache stability outranks priority order on the wire.
it("emits the kept manifest in the caller's original order", () => {
  const { tools } = selectTools({ tools: [a, b, c], budget: TWO_TOOLS, recent: ['charlie'] });
  expect(tools.map((t) => t.name)).toEqual(['alpha', 'charlie']);
});

// CACHE — a rewritten prefix can never be read back, so never pay to write it.
it('places no history breakpoint when a trim ran', () => {
  expect(planCache({ messages: HISTORY, historyRewritten: true }).historyThrough).toBeUndefined();
});
```

### 7.4 Coverage policy

Coverage is reported but the gate is a **floor at the current measured rate**, not a target. A number chosen aspirationally gets met by testing easy code; the floor exists only to catch a PR that deletes tests. Per-directory expectations, enforced by review rather than tooling: `src/transports/`, `src/db/`, `src/lib/`, `src/chat/` near-total on branches; `app/` and `src/components/` untested by design and excluded from the denominator so they cannot dilute the signal.

---

## 8. Quality gates

Four gates. All four must pass before a merge to `main`; all four plus the device protocol before a release.

| # | Gate | Command | Blocks | Rationale |
|---|---|---|---|---|
| 1 | Types | `pnpm typecheck` (`tsc --noEmit`) | merge | Strict TS is this project's substitute for a schema validator at every boundary |
| 2 | Lint | `pnpm lint` (`eslint .`) | merge | Catches unused code and import-boundary violations |
| 3 | Tests | `pnpm test` (`jest`) | merge | 976 tests, ~4 s — cheap enough that there is no excuse |
| 4 | Device | scripted protocol on Pixel 6 + Samsung S22 | release | The only coverage of rendering, gestures and real network behaviour |

```bash
pnpm typecheck && pnpm lint && pnpm test
```

**Why device verification is a gate and not a task.** The unit tiers cannot see the three failure classes that actually reach users: a component that throws on render, a gesture that fights the streaming scroll anchor, and a network transition (Wi-Fi → cellular → dead zone) mid-stream. Every one of those has to be observed. The protocol is in [07_Deployment.md](07_Deployment.md); the point here is that "tests pass" is not a release criterion on its own.

---

## 9. CI/CD pipeline

**Shipped in Sprint 5.** Both workflows exist: [`ci.yml`](../.github/workflows/ci.yml) and
[`build-apk.yml`](../.github/workflows/build-apk.yml). The YAML below is the *plan* as
written before the runner was tried; the two corrections it needed are recorded in §9.4,
and the files themselves are authoritative. Read them, not this.

### 9.1 `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      # --frozen-lockfile: a PR that silently changes the lockfile fails here
      # rather than producing a build nobody can reproduce.
      - run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Lint
        run: pnpm lint

      - name: Test
        run: pnpm test -- --ci --coverage --coverageReporters=text-summary

      - name: Coverage summary
        if: always()
        run: pnpm test -- --ci --coverage --coverageReporters=text-summary >> "$GITHUB_STEP_SUMMARY"
```

### 9.2 `.github/workflows/build-apk.yml`

```yaml
name: Build APK
on:
  workflow_dispatch:
    inputs:
      profile:
        description: EAS build profile
        type: choice
        options: [preview, production]
        default: preview
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}

      - run: pnpm install --frozen-lockfile

      # Gates run again here. A tag must not be able to skip them by being a tag.
      - run: pnpm typecheck && pnpm lint && pnpm test -- --ci

      - name: EAS build
        run: eas build --platform android --profile ${{ inputs.profile || 'preview' }} --non-interactive --no-wait
```

Three deliberate choices:

- **The gates run again in the build workflow.** They already ran on the PR, but a tag can point at any commit, including one that never saw CI. Re-running is thirty seconds; shipping an unverified build is a release.
- **`EXPO_TOKEN` is the only secret**, and it is an org-scoped Expo token, not a signing key. No API key for any gateway ever enters CI, because CI has no reason to talk to a gateway.
- **`--no-wait`** so a queued EAS build does not burn Actions minutes. The build is tracked in the Expo dashboard; the artefact is fetched by whoever is releasing ([07_Deployment.md](07_Deployment.md)).

### 9.3 What CI deliberately does not do

| Not automated | Why |
|---|---|
| Publish to the Play Store | Distribution is direct APK today; automating an unmade decision is waste |
| Run an Android emulator suite | Slow, flaky, and the device protocol covers what it would |
| Push an OTA update on merge | `expo-updates` channels are release-gated, not merge-gated |
| Sign with a production keystore in CI | The keystore stays in EAS; nothing needs it on a runner |
| Report telemetry or coverage to a third party | No third-party services — the project's privacy stance applies to itself |

### 9.4 Where the plan was wrong, and what shipped instead

Kept rather than quietly edited out of §9.1–9.2, because a plan that only ever
records its successes teaches nothing about how much to trust the next one.

| Planned | Shipped | Why |
|---|---|---|
| `node-version: 22` | `node-version: 24` | Load-bearing, not a preference. `src/db/__tests__` imports `node:sqlite` to build the real schema and read `EXPLAIN QUERY PLAN`. On Node 22 that module needs `--experimental-sqlite`, so on a Node 22 runner the entire directory fails to *load* — a green plan producing a red pipeline for a reason unrelated to any commit. |
| `pnpm/action-setup` `version: 11` | `version: 10.29.1` | pnpm 11 was aspirational; 10.29.1 is what the lockfile was produced by and what the project is developed against. With `--frozen-lockfile` in the next step, a major-version mismatch is a coin flip on whether install fails. |
| Coverage summary via a **second** `pnpm test` run | One run emitting `json-summary`, formatted by a `node -e` step | The planned version re-ran the whole suite to print numbers it had already computed, doubling the slowest step to produce identical output. `text-summary` writes to stdout only, so the fix was to also ask for `json-summary` — which lands on disk — and read that. |
| `pnpm test -- --ci` in the build workflow | `pnpm test -- --ci --coverage` | `jest.config.js` grew a `coverageThreshold` after §9 was written, which makes coverage a gate rather than a report. Omitting `--coverage` on the tag path would mean the floor was enforced everywhere except the one place that ships an APK. |
| (unstated) | No `cancel-in-progress` on `build-apk.yml` | Correct for `ci.yml`, wrong here. A superseded test run is waste; a cancelled build step can leave a queued EAS build running with nothing watching it. |

---

## 10. Risk register

Probability (P) and Impact (I) on 1–5. Exposure = P × I. Ordered by exposure.

| ID | Risk | P | I | Exp | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|---|
| R-01 | Gateway behaves differently from its docs; no live verification has occurred | 4 | 5 | 20 | Every wire assumption behind a fixture test so the diff is small when reality differs; verbatim gateway error text preserved so a mismatch is *readable*; live smoke test as the first act of any release | maintainer | **open** |
| R-02 | Auth failure misdiagnosed as an allowlist or network problem | 3 | 4 | 12 | `key_rejected` / `forbidden` / `insufficient_credits` are separate kinds with distinct hints; `MissingKeyError` thrown instead of sending an empty Bearer; failover explicitly excluded for non-`network` kinds | maintainer | mitigated |
| R-03 | Network interruption mid-stream loses the partial reply | 4 | 3 | 12 | Retry on `network`; failover only *before* the first event (after it, retrying would duplicate output); user message durable before the request; scratch-row persistence costed in S13 | maintainer | partially mitigated |
| R-04 | Context-window overflow rejects a request the gauge said was fine | 3 | 4 | 12 | Pressure measured against **usable** space, not raw window; `drop_oldest` / `summarise` strategies; `pause_turn` handled; estimator accuracy gated at ±15% in S9 | maintainer | S9 |
| R-05 | Solo-maintainer bus factor | 3 | 4 | 12 | Every non-obvious decision documented in the doc set; "decisions not to undo" list; comments explain *why*; this document's §6.3 cut list | maintainer | ongoing |
| R-06 | FTS5 absent from a device's SQLite build | 2 | 4 | 8 | Runtime probe, `IF NOT EXISTS` creation outside the migration chain, `LIKE` fallback, suite run with FTS5 forced off | maintainer | mitigated |
| R-07 | Android Keystore unavailable or SecureStore throws | 2 | 4 | 8 | Fall back to the module-scoped in-memory cache for the session; **tell the user the key will not persist**; never fall back to AsyncStorage | maintainer | see §10.1 |
| R-08 | Expo SDK 57 upgrade breaks the native ABI (already happened once) | 3 | 3 | 9 | `reanimated@4.5.1` / `worklets@0.10.4` pinned for C++ ABI compatibility; `expo-updates@57.0.18` pinned for the EAS `minimumReleaseAge` policy; upgrade in its own PR with a device pass | maintainer | mitigated |
| R-09 | Base64 attachment blows up memory on a mid-range device | 3 | 3 | 9 | Downscale before encode; hard per-request byte budget refused up front; memory ceiling as an S7 acceptance criterion | maintainer | S7 |
| R-10 | `VACUUM` (or a table rebuild) silently desynchronises the FTS index | 2 | 4 | 8 | Documented prohibition ([05_Data_Model.md](05_Data_Model.md) §12.1); rebuild required in the same transaction; move the drift check to FTS5 `integrity-check` | maintainer | open (debt D-03) |
| R-11 | MCP tool loop spends unbounded money | 2 | 4 | 8 | Max-iteration guard; retry policy applies to tool calls; approval defaults to ask; one-tap kill switch | maintainer | S11 |
| R-12 | A persisted-state migration loses provider profiles | 2 | 3 | 6 | Independent version counters per tier; `migrate` merges over defaults rather than replacing; tested with pre-migration fixtures | maintainer | mitigated |
| R-13 | Hydration race renders defaults over stored values | 2 | 3 | 6 | 3 s timeout plus the convention that stores persist only on explicit change; any auto-write at startup must check hydration | maintainer | partially mitigated |
| R-14 | APK grows past a comfortable direct-download size | 2 | 2 | 4 | Tree-shaking, image compression, no unused native modules — tracked in [07_Deployment.md](07_Deployment.md) | maintainer | monitored |

### 10.1 R-07 in detail: Keystore unavailability

Android Keystore can fail: a device with a corrupted keystore, a user who changed their screen lock in a way that invalidated keys, an emulator image without the right hardware backing, or a `SecureStore` call that simply throws. The naive response — write the key to AsyncStorage so the app keeps working — is unacceptable. It converts a temporary inconvenience into a permanent plaintext secret on disk, and it does so invisibly.

The designed behaviour:

```
loadApiKey(profileId)
  ├─ in-memory cache hit? ────────────────► return it (already registered with redact)
  ├─ SecureStore.getItemAsync succeeds? ──► cache, registerSecret(), return
  └─ SecureStore throws
       ├─ log the failure kind (never the key)
       ├─ if the user has entered a key THIS session → keep serving it from RAM
       │    and surface a persistent banner: "Your key can't be saved on this
       │    device. You'll need to re-enter it after restarting."
       └─ otherwise → MissingKeyError with the Keystore-specific hint
```

The invariant that survives every branch: **the key never touches AsyncStorage or SQLite.** A session-only key is a degraded experience the user is told about. A silently persisted plaintext key is a breach they are not.

---

## 11. Technical debt register

| ID | Debt | Origin | Cost of carrying | Fix | When |
|---|---|---|---|---|---|
| D-01 | Four stale web-export directories in the tree (`.tmp-web-export`, `dist-web-check`, `dist-web-final`, `dist-web-test`) | ad-hoc web export checks | confuses `git status`, risks committing build output | delete; add to `.gitignore` | S5, 30 min |
| D-02 | `conversations_order` index does not cover the `archived` filter | v1 schema | full-ish scan on every list load | `(archived, pinned DESC, updated_at DESC)` | S5, in a migration |
| D-03 | FTS drift check compares counts, not identity | v1 schema | cannot detect rowid renumbering (R-10) | switch to FTS5 `integrity-check` | S5 |
| D-04 | In-memory preview ≠ stored preview | store/db split | visible flicker of preview text after relaunch | call `previewOf()` in the store action | S5, 1 pt |
| D-05 | Redundant `Number.EPSILON` in `regenerate()` | intent the float cannot express | misleads the next reader into "fixing" exclusivity | delete it; keep the `inclusive` flag | S5, 15 min |
| D-06 | `progress.md` records 8 error kinds; there are 15 | doc drift | a new contributor builds against the wrong taxonomy | update `progress.md` from `errors.ts` | S5 |
| D-07 | `progress.md` lists `ModelCapabilities.documents` as missing; it exists | doc drift | duplicate work in S8 | update `progress.md` | S5 |
| D-08 | No CI | never set up | gates are claims, not facts | §9 | S5 |
| D-09 | No component-level tests at all | deliberate (§7.1) | render regressions caught only on device | revisit if a second engineer joins | deferred, with a trigger |
| D-10 | Mid-stream process death loses the partial reply | deliberate (write amplification) | user loses a long reply on a background kill | scratch row | S13, cuttable |
| D-11 | No live-gateway smoke test in any automated form | needs a real key | R-01 stays open | manual smoke script run at each release, key from a gitignored file | each release |
| D-12 | Prompt caching is unverified against the gateway | §4.1, needs a real key | if `cache_control` is accepted but not honoured, the marked prefix costs 1.25× and saves nothing — a silent surcharge, not an error | one two-turn conversation: expect `cacheWrite > 0` then `cacheRead > 0`. If not, set `promptCache: false` for the model | first live session (with D-11) |
| D-13 | `selectTools` / `describeWithheldTools` have no call site | §4.1 landed the tool budget before tools reach `buildRequest` | tested code that no request exercises; the wiring assumptions could be wrong in a way the tests cannot see | wire into the request builder alongside the MCP manifest | S11 |
| D-14 | `src/chat/attach.ts` has no automated coverage at all | it is four `expo-*` packages and a file system; the testable half was extracted into `attachments.ts` instead | the memory ceiling the whole module is arranged around (P-10) is unmeasured, as is whether every `saveAsync` temporary is really deleted | one device session: attach eight photos with the Android Studio profiler attached, then check the cache directory | first device session (with D-11) |
| D-15 | The 2,500-token image estimate is a provider figure applied flat, never measured | no live turn has reported a prompt count for a request containing an image | the gauge is wrong by an unknown amount on any conversation with attachments, and the calibration factor deliberately does not correct it | compare one reported prompt count against the estimate for the same request; if it is consistently off, the constant is the fix, not the factor | first live session (with D-11) |

**Spec corrections made in Phase 3, recorded rather than silently substituted:** Sprint 8's "Attach affordance hidden for models that cannot accept documents" ships as *shown and disabled with the reason*, because `vision`/`documents` are hand-edited flags and a hidden affordance is indistinguishable from a missing feature. Sprint 7's two device criteria (12 MP → 1.5 MB, 20 images under 250 MB) are asserted as the decisions they protect — `planResize`'s output and `admitImage`'s refusal — with the memory ceiling itself left open as D-14.

**Policy:** debt gets an ID here or it does not exist. Items D-01 through D-08 are all scheduled into Sprint 5 precisely because they are cheap and they distort everything measured after them — a stale doc and an absent CI both cause work that looks like development and is not.

**Status after Phase 2: D-01 … D-08 are closed.** The four web-export directories are deleted and gitignored; `conversations_order` became `conversations_list (archived, pinned DESC, updated_at DESC, id DESC)` in migration 1 → 2 with a planner assertion holding it there; the FTS drift check is now `INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)` (`src/db/schema.ts`), where the `rank = 1` argument is the part that catches rowid renumbering; the store action calls `previewOf()`; the `Number.EPSILON` addition is gone from `regenerate()` and the comment now explains why it never worked (a ULP above `seq = 4` is larger than `EPSILON`, so the addition rounded away); both `progress.md` drift items are corrected; CI is green. **D-09 … D-11 remain open as designed** — D-09 is deferred with a trigger, D-10 is scheduled into S13 and cuttable, D-11 is blocked on a real key and recurs at every release. **D-12 and D-13 were opened by the harness sprint** (§4.1) and are both consequences of building a layer before the thing it serves exists: D-12 rides along with D-11's first live session, D-13 closes in S11. **D-14 and D-15 were opened by Phase 3**, and both are the same shape as D-12: an unmeasurable claim about hardware or a live gateway, made testable only by attaching one. Neither blocks Phase 4.

---

## 12. Performance benchmarks and targets

Measured on a **Pixel 6 (Android 14)** as the reference device and a **Samsung Galaxy S22** as the second. Emulator numbers are recorded but never used as a gate — the emulator has a desktop CPU and lies about scroll performance.

| # | Scenario | Target | Why this number | How measured |
|---|---|---|---|---|
| P-01 | Cold start to interactive | <2.0 s | Below the threshold where a user checks whether the tap registered | manual stopwatch, 5 runs, median |
| P-02 | Render a 1,000-message transcript | **<2.0 s** to first paint | The stated product requirement; also the point where a virtualised list either works or does not | instrumented timestamp, seeded DB |
| P-03 | Scroll that transcript | ≥55 fps sustained | 60 is the panel rate; 55 leaves headroom before dropped frames are visible | `PerformanceObserver` / RN frame callback |
| P-04 | Time to first token | <1.0 s on Wi-Fi | Dominated by the gateway; our share is transport setup | `meta.firstTokenMs` |
| P-05 | Average message latency, end to end | **<500 ms** overhead above gateway time | The release success metric | `meta.latencyMs` minus gateway time |
| P-06 | Stream publish cadence | 60 ms throttle, no dropped frames | Fast enough to read as live, slow enough not to thrash React | frame timings during a long stream |
| P-07 | Conversation list, 500 conversations | <400 ms open | Perceived instant | instrumented |
| P-08 | FTS search, 50k messages | <300 ms to results | Below typing cadence, so results feel keystroke-driven | instrumented, seeded DB |
| P-09 | `LIKE` fallback search, 50k messages | <1.5 s | Degraded but usable; shows a spinner, unlike the FTS path | instrumented |
| P-10 | Peak memory, 20 images in a transcript | <250 MB | Below the point where Android starts killing the app in the background | Android Studio profiler |
| P-11 | APK size | <60 MB | Direct download over cellular | `eas build` output |
| P-12 | Test suite wall time | <10 s | Fast enough that nobody skips it | CI |

### 12.1 How P-02 is achieved: the FlashList strategy

Rendering 1,000 messages in under two seconds is not a matter of tuning props; it requires that the number of mounted components be independent of transcript length, and that the components that *are* mounted do no avoidable work.

```
┌── FlashList (v2) ───────────────────────────────────────────────┐
│  data: ListRow[]  ← headers and messages flattened into ONE      │
│                     array, built by a pure function so it is     │
│                     testable and referentially stable            │
│  keyExtractor: row.key      ← 'conv:<id>' / 'header:<bucket>'    │
│                               stable across re-renders           │
│  maintainVisibleContentPosition: bottom anchoring                │
│                               ← streaming appends must not move  │
│                                 the content under the user's     │
│                                 thumb                            │
│  getItemType: row.kind      ← separate recycling pools for       │
│                               headers and messages               │
└──────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │  MessageRow — React.memo with  │
              │  an explicit comparator:       │
              │  re-render only if id, seq,    │
              │  content ref, or streaming     │
              │  flag changed                  │
              └───────────────┬────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │  Markdown: parsed ONCE to a    │
              │  closed AST (marked) and       │
              │  memoised on the block ref.    │
              │  Streaming re-parses only the  │
              │  LAST block, at 60 ms.         │
              │  refractor/HAST injected, so   │
              │  pure modules stay pure.       │
              └────────────────────────────────┘
```

The four rules that make it hold, in order of how easily they are broken:

1. **One flat array, built by a pure function.** `buildRows()` produces headers and messages together, so FlashList sees a single homogeneous list and the grouping stays unit-testable. Building it inline in the component would make it un-testable *and* rebuild it on every render.
2. **Stable keys, and `getItemType` per kind.** Recycling a header view into a message view is a layout thrash; separate pools avoid it.
3. **Memoise the row, and re-parse only the streaming block.** A naive implementation re-parses the entire transcript's Markdown on every 60 ms publish — at 1,000 messages that is unusable. Only the final block changes while streaming.
4. **Bottom anchoring via `maintainVisibleContentPosition`.** Without it, appending content during a stream shifts what the user is reading. This is a correctness requirement disguised as a performance one.

---

## 13. Security checklist

Reviewed every sprint, in full, before the sprint is closed. This is the shortest section in the document and the one with the least room for judgement.

**Secrets**
- [ ] No API key, token or `Authorization` value reachable from any Zustand slice
- [ ] Every `partialize` reviewed as a security control — its output lands in plaintext AsyncStorage
- [ ] Keys read only through `loadApiKey()`; every load calls `registerSecret()`
- [ ] `MissingKeyError` thrown rather than sending an empty Bearer
- [ ] Keystore failure degrades to session-only RAM, never to AsyncStorage (§10.1)
- [ ] `keyFingerprint()` used wherever a key must be *identified* in the UI

**Redaction**
- [ ] Redaction applied at the log **write** boundary, so the buffer never holds a secret
- [ ] Exact-secret redaction *and* pattern backstop *and* key-name-based deep redaction all active
- [ ] Any new secret-bearing field name added to `SECRET_KEY_RE`
- [ ] Test: the key never appears in the debug log (§7.3)
- [ ] Test: the key never appears in an export artefact (§7.3)
- [ ] Stream samples and error strings pass through `redactString()` before storage

**Network**
- [ ] HTTPS only; no `http://` origin accepted in profile validation
- [ ] Honest static User-Agent; never spoof another client (bannable under the gateway's terms)
- [ ] Failover origin is a configured parity domain, never a discovered one
- [ ] No request body logged without redaction; base64 attachment payloads truncated in logs
- [ ] Certificate pinning — **evaluated and deliberately not implemented**; see below

**Data**
- [ ] `clear all data` clears SQLite, AsyncStorage, SecureStore **and** `clearRegisteredSecrets()`
- [ ] Export contains no secret and no `meta.baseUrl` the user did not enter
- [ ] No telemetry, no analytics, no third-party crash reporting — verified by dependency review
- [ ] MCP server headers treated as secret-bearing by default

**On certificate pinning.** The product brief lists it, and it is the right thing to consider. It is *not* implemented, deliberately: users point this app at their own gateway origins, including self-hosted ones and the parity domain. Pinning a certificate we do not control breaks the app whenever that operator rotates, and the failure looks like a network outage. The threat it defends against — a MITM with a trusted CA — is also the threat where a user has already lost the device. The mitigations that are in place instead: HTTPS enforced, no plaintext origin accepted, the key never leaving Keystore, and the request log showing exactly which origin answered. **Revisit if the app ever ships with a default gateway we operate**, where pinning becomes both possible and correct.

---

## 14. Monitoring and observability without a server

There is no backend, no crash reporter and no analytics. Observability therefore means: **the device can explain itself to its user, who can then explain it to us.** Everything below is on-device and opt-in to share.

| Signal | Where it lives | Retention | How it reaches a maintainer |
|---|---|---|---|
| Request/response log (redacted) | `src/lib/log.ts` ring buffer, 300 entries, memory only | process lifetime | user taps "copy log" and pastes it |
| Gateway request id | `meta.gatewayRequestId` (from `request-id` / `x-request-id` / `x-oneapi-request-id`) | with the message, forever | quoted in a support thread |
| Timings | `meta.firstTokenMs`, `meta.latencyMs` | with the message | debug screen aggregates |
| Retry and failover facts | `meta.retryCount`, `meta.failedOver`, `meta.droppedParam` | with the message | debug screen |
| Which origin answered | `meta.baseUrl` | with the message | tells primary from fallback at a glance |
| Token usage and cost | `usage_events` | forever | on-device report |
| Stream sample | first 2,000 chars of the raw stream, redacted | process lifetime | the one thing that diagnoses a parser bug |
| Crash | Android's own logcat / Play crash dialog | OS-controlled | user-reported |

Design decisions worth defending:

**The log buffer is memory-only and never persisted.** A persisted debug log is a file containing whatever the redactor missed. Losing the log on restart is a real cost; it is smaller than the cost of a durable artefact full of prose the user typed.

**Redaction happens on write, not on display.** So the buffer itself is safe by construction. Copy, share, screenshot — none of them can leak, because there is nothing in the buffer to leak. Redacting at display time would mean one forgotten call site is a disclosure.

**The stream sample earns its risk.** It is the only signal that distinguishes "the gateway sent something we do not parse" from "our parser is wrong", which is the single most likely class of R-01 failure. Two kilobytes, redacted, memory-only.

**A ring buffer, not a growing list.** A long streaming session would otherwise grow the buffer without bound on a memory-constrained device.

---

## 15. Rollout strategy

```
   ALPHA                    BETA                      RELEASE
   (weeks 9-12)             (weeks 13-24)             (week 25+)
   ┌────────────┐           ┌────────────┐            ┌────────────┐
   │ audience   │           │ audience   │            │ audience   │
   │ maintainer │           │ 5-10 known │            │ public     │
   │ only       │           │ testers    │            │ direct APK │
   ├────────────┤           ├────────────┤            ├────────────┤
   │ channel    │           │ channel    │            │ channel    │
   │ dev build  │           │ preview    │            │ production │
   │            │           │ APK link   │            │ APK + OTA  │
   ├────────────┤           ├────────────┤            ├────────────┤
   │ cadence    │           │ cadence    │            │ cadence    │
   │ continuous │           │ per sprint │            │ monthly,   │
   │            │           │ (2 weeks)  │            │ synced to  │
   │            │           │            │            │ Expo SDK   │
   ├────────────┤           ├────────────┤            ├────────────┤
   │ exit gate  │           │ exit gate  │            │            │
   │ all 4 gates│           │ 2 sprints  │            │ crash-free │
   │ green +    │           │ with no    │            │ >99%       │
   │ live smoke │           │ P1 bug +   │            │            │
   │ test passes│           │ device pass│            │            │
   └────────────┘           └────────────┘            └────────────┘
```

**Alpha exits when the live smoke test passes**, not when the features are done. R-01 is the largest open risk and no amount of feature work retires it; one real request against a real gateway does.

**Beta is small and known.** Five to ten testers who can be asked a follow-up question are worth more than five hundred anonymous installs when there is no telemetry. The feedback loop is a human one, so it must be a short list of humans.

**Release cadence is monthly and synced to Expo SDK releases** ([07_Deployment.md](07_Deployment.md)). Aligning with the SDK means the dependency upgrade and the feature release share one device-verification pass instead of needing two.

---

## 16. Success metrics per phase

Each metric is something that can actually be observed on a device with no telemetry — a measurement the maintainer or a beta tester can take, not a dashboard number.

| Phase | Metric | Target | Measured by |
|---|---|---|---|
| 0 | Both adapters pass their fixture suites | 100% | CI |
| 0 | One transport interface, zero adapter imports above the transport layer | 0 violations | lint rule + review |
| 1 | Send → first token, Wi-Fi | <1.0 s | `meta.firstTokenMs` median over 20 turns |
| 1 | Search finds a known message | 100% of 20 seeded probes | manual script |
| 1 | Errors rendering as "unknown" | 0 across the 15 kinds | fixture test |
| 1 | Survives background/foreground mid-stream | no crash, no duplicate message | device protocol |
| 2 | Open a 500-conversation list | <400 ms | instrumented |
| 2 | 1,000-message transcript first paint | <2.0 s | instrumented |
| 2 | Export contains a secret | **0 occurrences** | automated test |
| 3 | 12 MP photo attach → request sent | <3 s, <1.5 MB base64 | instrumented + device |
| 3 | Peak memory, 20 images | <250 MB | profiler |
| 4 | Requests rejected for context overflow | <1% of turns | device log review over a beta cycle |
| 4 | Estimator vs gateway-reported input tokens | within ±15% | 20-fixture corpus |
| 5 | Tool loop completes a 2-round conversation | 100% on the fixture server | integration |
| 5 | Unapproved tool executions | **0** | integration + review |
| 6 | Crash-free sessions | >99% | beta tester reports over 4 weeks |
| 6 | Average message latency overhead | <500 ms | `meta.latencyMs` aggregate |
| 6 | TalkBack reads the transcript in order | pass | manual audit |

Two metrics are deliberately absent. **DAU/retention**: unmeasurable without telemetry, and the project's privacy stance means it stays that way. **Crash-free rate before Phase 6**: with fewer than ten testers the denominator is too small for the number to mean anything; before then, the honest metric is "count of distinct crashes reported", which is a list, not a rate.

---

## 17. User flows mapped to features

| Flow ([USAGE.md](../USAGE.md), [PRD.md](../PRD.md)) | Features it exercises | Phase | Where it can break |
|---|---|---|---|
| **Setup** — add a provider, paste a key, test the connection | `useProviders`, SecureStore write, `resolveTransportOrNull`, `GET /models`, connection test steps | 0–1 | wrong base-URL convention for the kind; key rejected vs client rejected; Keystore failure (R-07) |
| **Chat** — type, stream, read | `runTurn`, SSE parse, 60 ms publish, FlashList anchoring, Markdown AST, `insertMessage`, `recordUsage` | 1 | mid-stream network loss (R-03); scroll fighting; re-parse cost at length |
| **Organise** — pin, tag, archive, find | `buildRows`, `tagCounts`, `filterConversations`, list indexes | 2 | index gap (D-02); preview drift (D-04) |
| **Search** — instant filter, then full-text | `matchesQuery`/`highlightTerms`, `searchMessages`, FTS5 + `LIKE` | 1–2 | FTS5 absent (R-06); CJK tokenisation; `bm25` ordering sign |
| **Attach** — photo or PDF, then ask | picker, downscale, `ImageBlock`/`DocumentBlock`, capability gating, size budget | 3 | memory (R-09); OpenAI document degradation |
| **Long conversation** — pressure, trim or summarise | `contextPressure`, `selectMessagesWithinBudget`, rolling summary, `throughSeq` | 4 | overflow despite a green gauge (R-04); orphaned leading assistant message |
| **Use a tool** — approve, execute, continue | MCP HTTP/SSE client, `tool_use`/`tool_result` loop, approval UI | 5 | unbounded loop (R-11); no stdio on Android |
| **Recover from an error** — read it, retry, fail over | 15 error kinds with hints, retry policy, `withExhaustedNote`, failover guard | 1 | misclassification (R-02); failover on the wrong kind |
| **Diagnose** — open the log, copy it | ring buffer, redaction at write, `gatewayRequestId`, stream sample | 1 / 6 | a leak here is a security bug, not a UX one |

Every flow has at least one row in the risk register. That is the check this table exists to perform: a flow with no identified failure mode has not been thought about hard enough.

---

## 18. Definition of done

A feature is done when **every** line below is true. Not "mostly", and not "the important ones".

**Code**
- [ ] Logic lives in a pure `.ts` module; the component holds hooks and layout only
- [ ] Comments explain *why*, and only where the reason is not obvious from the code
- [ ] Matches the surrounding code's naming, comment density and idiom
- [ ] No new dependency without a stated reason and a pinned version

**Tests**
- [ ] Unit tests for every branch of the new logic
- [ ] Integration test if it crosses store ↔ db ↔ transport
- [ ] The failure path is tested, not just the happy one
- [ ] Fixtures for any new wire shape, both adapters where applicable
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green, locally and in CI

**Device**
- [ ] Verified on a Pixel 6 **and** a Samsung S22 (or noted as not device-relevant, with a reason)
- [ ] Verified with the network interrupted, if it touches the network
- [ ] Verified backgrounded and resumed, if it holds state across time
- [ ] Relevant performance target from §12 measured, not assumed

**Security**
- [ ] §13 checklist re-run for the touched area
- [ ] Nothing new in a `partialize` output that should not be plaintext on disk
- [ ] Any new log line proven redacted

**Docs**
- [ ] [05_Data_Model.md](05_Data_Model.md) updated if the schema, a JSON field or a tier boundary changed
- [ ] [07_Deployment.md](07_Deployment.md) updated if the build, profile or release process changed
- [ ] `progress.md` updated: status, gate counts, and any decision that should not be undone
- [ ] Debt discovered along the way filed in §11 with an ID

**Review**
- [ ] Self-review of the full diff as a diff, not as a set of files
- [ ] Every acceptance criterion from the sprint table demonstrably met

The device block is the one most likely to be skipped under time pressure and the one least safe to skip: it is the only tier that covers rendering (§7.1), and an APK that crashes on launch cannot be fixed remotely ([07_Deployment.md](07_Deployment.md) rollback).

---

## Appendix A — Reference tables

### A.1 Error kinds, retry and failover behaviour

| Kind | Typical HTTP | Retryable | Fails over | User-facing intent |
|---|---|---|---|---|
| `client_rejected` | 401/403 variant | no | no | The gateway refused *this app*, not the key |
| `key_rejected` | 401 | no | no | Check the key in Settings |
| `forbidden` | 403 | no | no | The key lacks access to this model |
| `content_blocked` | 400/451 | no | no | The request was refused on policy grounds |
| `unsupported_param` | 400 | no | no | One parameter dropped, request retried once |
| `not_found` | 404 | no | no | Wrong base URL convention or wrong model id |
| `insufficient_credits` | 402 | no | no | Top up; retrying cannot help |
| `rate_limited` | 429 | **yes** | no | Backoff, honouring `Retry-After` |
| `server` | 5xx | **yes** | no | The gateway is unwell; backoff |
| `bad_request` | 400 | no | no | We built the request wrong — a bug |
| `validation` | — (local) | no | no | Caught before sending; deliberately not `bad_request` |
| `network` | — | **yes** | **yes** | Unreachable; retry, then the fallback origin |
| `aborted` | — | no | no | The user stopped it |
| `parse` | — | no | no | We could not read the stream — likely our bug (R-01) |
| `unknown` | — | no | no | Should never render; if seen, the taxonomy has a hole |

### A.2 Retry policy constants

| Constant | Value | Reason |
|---|---|---|
| `maxAttempts` | 4 | Three retries covers a transient blip; more just delays the error |
| `baseDelayMs` | 500 | Below human patience for a first retry |
| `factor` | 2 | Standard exponential |
| `maxDelayMs` | 20 000 | A 40 s wait reads as a hang |
| `maxElapsedMs` | 90 000 | Total budget; a turn that takes 90 s to fail has failed |
| `jitter` | 1 (full) | Full jitter — nothing here is coordinated, but it is free |
| `Retry-After` | clamped to `[computed, maxDelayMs]` | Honour the gateway, but never sleep for an hour because a header said so |
| `NO_RETRY_POLICY` | 1 attempt | Connection tests and user-initiated actions that must report immediately |

### A.3 Commands

```bash
pnpm typecheck && pnpm lint && pnpm test
```

```bash
pnpm test -- --coverage --coverageReporters=text-summary
```

```bash
pnpm build:apk
```

## Appendix B — Checklists

### B.1 Sprint start

- [ ] Previous sprint's device pass completed and its findings filed
- [ ] Gates green on `main` before any new branch
- [ ] Stories have acceptance criteria a reviewer can check, not interpret
- [ ] Critical-path order respected (§5) — nothing scheduled before its prerequisite
- [ ] Points total ≤ 30 (observed velocity is 27; over-committing borrows from testing)
- [ ] Risks the sprint retires, and risks it *introduces*, both named

### B.2 Sprint close

- [ ] Every story meets §18 in full, or is explicitly carried over — no partial credit
- [ ] Security checklist (§13) re-run
- [ ] Performance targets touched by the sprint re-measured on the Pixel 6
- [ ] `progress.md` updated with real gate output, not remembered numbers
- [ ] New debt filed with an ID in §11
- [ ] Velocity recorded; if it moved, §6.2 re-projected rather than the plan re-asserted

### B.3 Scope-cut decision (when a sprint will not fit)

- [ ] Cut from §6.3's list, in order, before inventing a new cut
- [ ] Never cut: redaction tests, `LIKE` search fallback, retry policy, tool approval defaults, device verification
- [ ] Record what was cut and why in `progress.md` — an undocumented cut becomes a mystery gap
- [ ] If a phase slips, take the sprint from the next phase; do not compress this phase's testing

## Appendix C — Glossary

| Term | Meaning here |
|---|---|
| **Acceptance criterion** | A checkable statement, measured or observed — not a description of intent |
| **Critical path** | The dependency chain where each stage's correctness is defined by the previous stage's behaviour (§5) |
| **Exposure** | Probability × Impact in the risk register |
| **Failover** | Retrying against the parity origin; `network` kind only, pre-first-event only |
| **Gate** | A check that blocks a merge or a release; four of them (§8) |
| **Kind** | One of the 15 `GatewayErrorKind` values |
| **Phase** | A unit of user-visible value; one to two sprints |
| **Point** | A unit of uncertainty and coordination cost, not time (§6.1) |
| **Pressure** | Context fill measured against *usable* space, not the raw window |
| **Sprint** | Two weeks; the unit of commitment |
| **Usable space** | context window − reserved output − reserved thinking |
| **Velocity** | Points completed per sprint; observed at 27 |

---

## Ownership and maintenance

| | |
|---|---|
| **Owner** | The maintainer (`Suke2004`) |
| **Update at** | Every sprint close (§B.2) — velocity, status, new debt, new risks |
| **Update immediately when** | A risk materialises · a phase's scope changes · a gate is added or changed · the critical path is re-ordered · CI changes |
| **Do not update for** | Individual task completion within a sprint (that is `progress.md`'s job) |
| **Source of truth for status** | [progress.md](../progress.md). This document is the *plan*; `progress.md` is the *state*. When they disagree about what is done, `progress.md` wins — and this document's projections should then be recomputed |
| **Staleness signal** | If the current date is past a sprint's window and its row here still reads as planned, this document is stale |

Cross-references: schema, indexes and the hazards that seed §11 are in [05_Data_Model.md](05_Data_Model.md); build profiles, the device protocol and rollback are in [07_Deployment.md](07_Deployment.md); product requirements in [PRD.md](../PRD.md); transport contracts in [TRD.md](../TRD.md); layering rules in [ARCHITECTURE.md](../ARCHITECTURE.md); user-facing flows in [USAGE.md](../USAGE.md).

## Document history

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.3 | 2026-08-30 | Phase 3 close-out | Phase 3 recorded as shipped: Sprint 7 (images) and Sprint 8 (documents) both delivered. §1 baseline re-measured (976 tests / 32 suites, ~4 s; coverage 64.14 / 63.10 / 62.34 / 51.30 against a ratcheted 64 / 63 / 62 / 51 floor; ~34,100 lines) and the executive summary's 904-test figure corrected; §7.1 and §8 gate 3 likewise. §2 timeline marks S7 and S8 complete and makes Phase 4 the next block; the "phases remaining" row now says plainly that the PRD's other Phase 3 items (speech-to-text, TTS, image generation, share target) were never scheduled here and are unbuilt. New **Phase 3 retrospective** after Sprint 8: the plan under-estimated how much of the pipeline already existed and over-estimated the picker — the real work was the memory ceiling (resize before base64, sequential ingest, temp-file deletion) and the refusal wording. Two device acceptance criteria are recorded as unverified rather than ticked, with the decisions they protect asserted in tests instead. One deliberate deviation from the sprint wording: capability gating **shows and disables with a reason** rather than hiding the affordance, because `vision`/`documents` are hand-edited flags and a hidden button is indistinguishable from a broken one. §11 opens **D-14** (`attach.ts`, the impure half, has no automated coverage, so the P-10 memory ceiling is unmeasured) and **D-15** (the flat 2,500-token image estimate has never been checked against a reported `usage`). Neither blocks Phase 4. |
| 1.2 | 2026-08-30 | Harness sprint close-out | Version and status bumped: the harness budgeting layer landed **out of order**, ahead of Phase 3. §1 baseline re-measured (904 tests / 30 suites, ~5 s plain and ~12 s with coverage; coverage 64.54 / 63.32 / 62.21 / 50.81 against a ratcheted 62 / 61 / 60 / 48 floor; ~32,100 lines) and the executive summary's 817-test figure corrected, with a new paragraph on why the layer was pulled forward. §2 timeline gains an `H` row marked out of order. New **§4.1** records the sprint in full: a defect/cost/fix table for the four modules (`budget.ts` double-counted the thinking budget into `max_tokens`; `trim.ts` replaced a hard drop with a four-rung ladder; `tools.ts` sent every definition every turn; `cache.ts` never marked a cacheable prefix), the ladder note, six consequences for later sprints — Sprint 9's first story is largely done, `drop_oldest` shrinks to the last rung, Sprints 11/12 inherit `selectTools`, the fourth `cache_control` breakpoint is reserved for the tool loop, `promptCache` needs surfacing in S13, and the gateway-caching risk — and a delivered list. §7.3 gains four example cases (BUDGET / TRIM / TOOLS / CACHE); §7.1 and §8 gate 3 corrected to 904 tests / ~5 s. §11 opens **D-12** (prompt caching unverified against the gateway — a silent 1.25× surcharge if `cache_control` is accepted but not honoured; settled by one two-turn conversation) and **D-13** (`selectTools` has no call site until S11). |
| 1.1 | 2026-08-30 | Phase 2 close-out | Phase 2 recorded as shipped. §1 baseline re-measured (817 tests / 26 suites, ~5 s; coverage 62.66 / 61.33 / 60.78 / 47.68 against a 61 / 60 / 59 / 46 floor; ~30,300 lines across `src` + `app`) and the executive summary's stale 658-test figure corrected. §2 timeline marks S5 and S6 complete. §4 Sprints 5 and 6 gain an outcome column, including the two acceptance criteria that shipped as code but remain **device-unverified** (the 55 fps scroll target and the 400 ms list-open target) — recorded rather than ticked, because no physical device exists in this environment. New Phase 2 retrospective after Sprint 6 in the §9.4 style: export ships through `expo-clipboard` and React Native `Share` rather than a written file (`expo-file-system` / `expo-sharing` belong to Phase 3), `SHARE_BYTE_LIMIT` against the Binder parcel ceiling, double redaction, no attachment bytes in an export, the duplicate Phase 6 export line, and what a bulk delete deliberately spares. §11 records D-01 … D-08 as closed with the evidence for each, and D-09 … D-11 as open by design. |
| 1.0 | 2026-08-29 | Architecture review | Initial issue. Baseline as of Phase 1 complete; 13 sprints across six phases with per-story points and acceptance criteria; Phase 1 recorded retrospectively for velocity (27 pts/sprint) and ordering provenance; critical path (transport → retry → classification → failover → tools) with the reasoning for each edge; 80/15/5 test pyramid with the architectural rule that produces it and an honest account of what it does not cover; concrete test cases including the two mandated redaction tests; four quality gates; greenfield GitHub Actions CI and APK workflows; 14-entry risk register with R-07 (Keystore) expanded; 11-entry debt register seeded from the data-model hazards, with D-01…D-08 scheduled into Sprint 5; twelve performance targets and the FlashList strategy behind the 1,000-message/2 s requirement; security checklist including the reasoned decision *not* to pin certificates; on-device observability model; alpha→beta→release rollout; per-phase success metrics; user-flow-to-feature mapping cross-checked against the risk register; and a five-block definition of done. |

