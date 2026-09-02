# 06 — Engineering Plan

**SuperAgent / AgentRouter Mobile · Roadmap, Sprints, Quality and Risk**

| | |
|---|---|
| **Version** | 1.9 |
| **Status** | Current — Phases 0–5 complete; Phase 6 partly delivered out of order. Two large workstreams have landed **outside this plan's phase structure** entirely (the v1.1 list, and Sections 1–7 plus 10–12 of the Claude-parity checklist — ten of its twelve), which is now the main thing this document has to be read against |
| **Planning horizon** | 2026-08-29 → 2027-04 (six phases, twelve 2-week sprints) |
| **Audience** | Engineers picking up a sprint, and anyone deciding what to cut |
| **Companion docs** | [05_Data_Model.md](05_Data_Model.md) · [07_Deployment.md](07_Deployment.md) · [PRD.md](../PRD.md) · [TRD.md](../TRD.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [progress.md](../progress.md) · [progress-v1.1.md](../progress-v1.1.md) |

---

## Executive summary

This document turns the product intent in [PRD.md](../PRD.md) into a sequenced, estimated, testable plan: what gets built in which two-week sprint, what "done" means for each feature, what could go wrong, and which gate stops a bad change from reaching a device. It is written for the engineer who has been handed a sprint and needs to know not just the tasks but the *order constraints* — because in this codebase the ordering is where the risk lives. Streaming transport must land before retry policy, and retry policy before error classification, since each one's correctness is defined in terms of the previous one's observable behaviour.

The project is a solo-maintained, offline-first Android chat client for LLM gateways with no server component and no telemetry. That shapes every plan decision in this document. There is no staged server rollout to hide a bad release behind, no analytics to tell us a feature is unused, and no way to fix a corrupted device database remotely. The compensating controls are heavy static verification (TypeScript strict, ESLint, a 1,600-test Jest suite that runs in about five seconds), a deliberate architectural rule that all non-trivial logic lives in pure `.ts` modules where it can be tested, and physical-device verification as a release gate rather than a nice-to-have.

Phases 0 through 5 are complete: foundation, both transport adapters, the SQLite schema, streaming chat, search, error handling, CI, list virtualisation and paging, tags, pin/archive, two-tier search, bulk operations, export, attachments and documents, context management, and MCP with its approval gate and bounded tool loop. Context management arrived in two parts, the **harness budgeting layer** (§4.1) out of sprint order at the maintainer's request, then Sprints 9–10 closing the defects it left behind (§4.2). Phase 6 — polish and observability — is partly delivered already: the debug log screen, per-request timings and an accessibility pass all shipped early, alongside a great deal of work this plan never scheduled. That accessibility pass was later extended by parity Section 12, which is where the end-of-turn screen-reader announcement and the modal focus traps came from — and which also produced the one debt item in §11 that no gate here can ever close, D-20.

**Two workstreams have landed outside the phase structure, and that is now the dominant fact about this document.** The v1.1 list ([progress-v1.1.md](../progress-v1.1.md)) delivered skills, prompts, projects, memory, backup/restore, an app lock, SQLCipher at rest, message variants and web search. Sections 1–7 and 10–12 of a twelve-section Claude-parity checklist then delivered speech-to-text, text-to-speech, voice mode, charts, Office documents in both directions, in-app file preview and editing, an inbound "open with" intent, readable tool labels, one shared vocabulary of motion, an in-app camera, a history drawer grouped and virtualised by the list screen's own row builder, a bundled connector directory with a per-conversation answer to *what tools does this turn have*, an end-of-turn screen-reader announcement, and a pending update the user can apply without waiting for a cold start — see [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]`. **That checklist is now closed at ten of twelve**, with 8 (sync) and 9 (cowork) left behind a product decision rather than an estimate. None of it appears in §4's sprint tables, because none of it was planned there. §5 remains the critical path and its ordering held throughout. §10 is the risk register, and the five risks the product brief calls out by name (auth failure, mid-stream network loss, context overflow, Keystore unavailability, FTS5 absence) each have a named mitigation that is already partly in code. §11 is the technical-debt register, seeded from the hazards identified in [05_Data_Model.md](05_Data_Model.md) §12.

**The one thing to take away:** the quality gates in §8 are not negotiable per-sprint, because with no server and no telemetry, a gate skipped is a defect shipped to a device we cannot reach.

---

## 1. Baseline: where the project actually is

| Dimension | Status as of 2026-09-02 |
|---|---|
| Phases complete | 0 (foundation + transport), 1 (core chat), 2 (list & organisation), 3 (attachments & documents), 4 (context management, part of it pre-built by the harness sprint — §4.1, §4.2), 5 (MCP & tools — §4.3) |
| Phases remaining | 6 (polish & observability), and three of its five stories have already shipped out of order (§4.4). What is left of it is the streaming-partial scratch row (D-10), the performance panel, and the 1.0 checklist |
| Delivered outside this plan | The **v1.1 list** ([progress-v1.1.md](../progress-v1.1.md)): skills, prompts, projects, memory, backup/restore, app lock, SQLCipher at rest, message variants, web search. **Sections 1–7 and 10–12 of the Claude-parity checklist**: speech-to-text, text-to-speech, voice mode, charts, Office read *and* write, in-app file preview and editing, inbound "open with", readable tool labels, shared motion constants, an in-app camera, a grouped and virtualised history drawer, a bundled connector directory, a live per-conversation tool summary, an end-of-turn screen-reader announcement and a user-applied pending update. See §4.5 |
| Test suite | **1,603 tests / 80 suites, ~4–6 s** plain and ~6–8 s with coverage — measured in this worktree, and enforced by CI. A cold first run on this Windows filesystem is several times that; the figures above are warm |
| Coverage | statements 70.05% · branches 66.24% · functions 64.49% · lines 71.62%, against the `jest.config.js` floor of 66 / 63 / 58 / 68 (statements / branches / functions / lines) |
| Source size | ~47,800 lines of shipped code across 163 files (`src` + `app` + `plugins`, excluding the 80 test files and two test helpers); ~64,100 including them |
| Schema | `PRAGMA user_version = 8` (`src/db/ddl.ts`), reached by eight migrations — see [05_Data_Model.md](05_Data_Model.md) §10.1 |
| Toolchain | Expo SDK ~57.0.18, RN 0.86.3, React 19.2.3 (React Compiler on), TypeScript ~6.0.3, New Architecture on |
| CI | **Green.** [`ci.yml`](../.github/workflows/ci.yml) runs the three gates plus a coverage floor on every push and PR; [`build-apk.yml`](../.github/workflows/build-apk.yml) builds by hand or by `v*` tag (§9) |
| Live gateway verification | **Blocked** on a real API key |

Two honest caveats that affect planning:

1. **The gates were re-run, and coverage is now a gate rather than a note.** `tsc --noEmit`, `eslint .` and `jest --coverage` are green in this worktree at the figures in the table above; `jest.config.js` carries a `coverageThreshold` set a few points under the measured run, so the number is enforced by the runner instead of transcribed into a markdown file. This was the first task of Sprint 5 and the reason CI exists at all. One consequence worth naming: the suite was read at ~11 s at the time, which looked like it was **over P-12's <10 s target** (§12). The re-measure it asked for happened on 2026-09-02 and the reading was wrong, not the target: 1,600 tests run in ~4–6 s warm and `calibration.test.ts` — blamed for ten of the eleven seconds — takes 0.64 s. See §11 D-19, closed.
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
- **The database is encrypted with SQLCipher and nothing is backed up.** The raw key lives in SecureStore, `android:allowBackup` is false, and the consequence is accepted: a lost key means unrecoverable conversations ([05_Data_Model.md](05_Data_Model.md) §12.7). Any future feature that copies the database off-device re-opens this decision rather than inheriting it.
- **There is no in-app "clear all data".** Settings offers backup, restore and per-item deletion; uninstalling is the only complete wipe. Building one is a real task with a four-tier checklist (§13), not a checkbox.

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

PHASE 4         ████████████ (COMPLETE — divergences in the §4.2 retrospective)
  S9  Week 17-18 pressure gauge · drop_oldest · exclusions        ✔ 26 pts
  S10 Week 19-20 rolling summary · throughSeq · budget selection  ✔ 31 pts

PHASE 5         ████████████ (COMPLETE — divergences in the §4.3 retrospective)
  S11 Week 21-22 MCP over HTTP/SSE · tool_use loop                ✔ 34 pts
  S12 Week 23-24 tool approval UX · result rendering · limits      ✔ 26 pts

  V   out of order  v1.1: skills · prompts · projects · memory ·  ✔ (§4.5)
                    backup/restore · app lock · SQLCipher ·
                    variants · web search

  C   out of order  Claude parity, Sections 1-7 + 10-12: STT ·     ✔ (§4.5)
                    TTS · voice mode · charts · Office in+out ·
                    file preview & edit · open-with · tool
                    labels · motion vocabulary · in-app camera ·
                    grouped history drawer · connector
                    directory + live tool summary · reply
                    announced to a screen reader · pending
                    update applied on request
                    — takes three of S13's five stories with it,
                      and Section 6 makes the next release a build

PHASE 6                                                         ░░░░░░  polish
  S13 Week 25-26 observability · perf hardening · a11y · 1.0     ◐ 24 pts
        │           │           │           │           │           │           │
        └─ alpha ───┴───────────┴─ beta ────┴───────────┴───────────┴─ 1.0 ─────┘
           (self)                (5-10 testers)                       (release)
```

`◐` is Sprint 13 partly delivered: the debug log screen, per-request timings and the accessibility pass all landed early (§4.4), leaving the performance panel, the scratch row (D-10, cuttable) and the 1.0 checklist.

Sprint numbering continues across phases because the sprint is the unit of commitment; the phase is the unit of user-visible value. A phase that needs a third sprint takes it from the next phase rather than compressing its own testing — the alternative is a phase that is "done" with its device verification skipped, which is not done ([§18](#18-definition-of-done)).

**Read the two out-of-order blocks as the plan's real shape.** Three of the six blocks on this chart — `H`, `V` and `C` — were not scheduled here, and together they are larger than Phases 3, 4 and 5 combined. That is not a planning failure to apologise for; it is what a solo project with a live maintainer looks like, and the honest response is to record it on the chart rather than to keep drawing a plan the work no longer follows. The one thing it costs is velocity data: §6.2's projection is computed from planned points only, so it now under-counts what has actually been built by a wide margin (§6.4).

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
| — (`V`) | v1.1, unplanned | Reusable skills and prompts, projects, remembered facts, a backup, a locked app |
| — (`C`) | Claude parity 1–7 + 10–12, unplanned | Talk to it and be talked back to; read and write real documents; open a file from another app; find an old chat in the drawer without leaving it; connect a tool server from a list instead of a URL, and see what the turn can actually do; be told a reply has landed when you cannot see the screen, and finish a downloaded update without waiting for a cold start |

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
| `GatewayError` with 14 kinds; verbatim gateway text preserved | 5 | Every kind maps to one actionable hint; no kind renders "Unknown error" |
| Retry policy (4 attempts, 500 ms base, ×2, 20 s cap, 90 s elapsed) | 5 | `Retry-After` honoured, clamped to `[computed, maxDelayMs]` |
| Failover to the parity origin on `network` only | 3 | A 401 does **not** fail over and does not double-spend credits |
| Markdown → closed AST via `marked`, syntax highlighting | 5 | A 5,000-line reply renders without blocking input |
| FlashList v2 bottom anchoring, 60 ms publish throttle | 3 | Streaming does not fight the user's scroll position |
| Physical device pass (Pixel 6, Samsung S22) | 3 | Both devices: send, stream, background mid-stream, return, search |

**Why last.** Error handling is defined in terms of retry, which is defined in terms of the transport's observable failures (§5). Building the error UI first produces a taxonomy that does not match what actually happens on the wire — which is precisely the drift visible in `progress.md`'s stale 8-kind list versus the 14 kinds actually in `errors.ts` ([05_Data_Model.md](05_Data_Model.md) Appendix D). Earlier revisions of this document said 15, which was the count before `client_rejected` and `key_rejected` were merged into one `unauthorized`; the merge is described in §1.1 and the row above now reads 14.

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
| FlashList tuning for 1,000-message transcripts (§12) | 5 | Scroll a 1,000-message conversation at ≥55 fps on a Pixel 6; initial render <2 s | perf harness + device | ⚠️ code shipped and exercised on a device (scrolling and stream anchoring are smooth); the **fps figure itself is still unmeasured** — no profiler run, so the number is not asserted |
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

*(The camera half of that first row was later replaced outright: `expo-image-picker`'s camera path was deleted in parity Section 6 in favour of an in-app viewfinder on `expo-camera`. The gallery half, the permission copy and the settings deep link are unchanged — see §4.5 `C`.)*
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

### Sprint 9 · Phase 4 · Context pressure and exclusions · 26 pts · ✅ shipped (one story deferred — §4.2)

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

### Sprint 10 · Phase 4 · Rolling summary · 31 pts · ✅ shipped

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

### 4.2 Phase 4 retrospective — every item was a defect, not a missing feature

The harness sprint (§4.1) had already delivered Sprint 9's denominator, its orphan drop and its exclusion persistence, exactly as §4.1 predicted. What remained across both sprints was a set of things that *ran* and were wrong, which is why the sprint produced three small pure modules rather than a feature.

| Defect | Cost | Fix |
|---|---|---|
| The rolling summary could grow without bound | Charged as input on **every remaining turn**; eventually costs more than the turns it replaced | `src/chat/summary.ts` — a 2,000-char budget enforced on what comes back (`boundSummary`, idempotent, so summary-of-summaries terminates) and a request body that switches from "merge" to "rewrite shorter" past 75% |
| Summarisation spend was invisible | The usage dashboard understated the bill by every summary ever generated | Its own `usage_event`, tagged with the conversation that caused it |
| The `summary` write composed config from the row read at the start of the turn | Silently clobbered any config change made while the turn ran — the merge-not-replace rule of [05_Data_Model.md](05_Data_Model.md) §10.2 | Re-read the row immediately before writing |
| An estimate could reach `messages.usage` | A guess indistinguishable from a measurement a week later, in a column that is a claim about money | `src/chat/usage.ts` — field-by-field copy of reported fields only; absent stays absent rather than becoming `0` |
| Trimming, a failed summarisation and a capped `pause_turn` were all silent | The next reply forgets things for a reason nothing on screen explains | `contextNotes` in the store, surfaced above the composer, dismissable, announced |
| `pause_turn` was presented as a finished answer | A truncated reply that looks complete | Continuation up to `MAX_PAUSE_CONTINUATIONS = 3`, resumed *outside* the `try/finally` so the new turn owns its own abort controller |

**Two deliberate deviations from the sprint wording, recorded rather than substituted silently.** The `warn` story says "sending above threshold requires one confirmation": the confirmation fires at `over`, not at the warn threshold, and only for `warn` — the trimming strategies fix the overflow themselves, and a modal on every send at 85% is one people learn to dismiss unread, which is worse than none. And "Show the user what was dropped or summarised · an inline affordance lists the elided range and can expand it" ships as a **sentence with a dismiss control** rather than an expandable range: the elided turns are still in the database and still on screen in the transcript, so an affordance that re-lists them duplicates the scroll view. What was missing was the statement that a request differed from what the transcript shows, and that is what the note is.

**One story is deferred, not delivered:** the ±15% estimator-accuracy corpus needs the gateway's own reported prompt counts to measure against, so it moves with **D-11** to the first live session.

### Sprint 11 · Phase 5 · MCP over HTTP/SSE and the tool loop · 34 pts · ✅ shipped

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| MCP client over HTTP/SSE (**no stdio**) | 8 | Connects, lists tools, calls one, handles a server that never responds | fixture server |
| Server config storage (URL + headers) | 3 | Header values with secret-looking names redacted in logs and never in AsyncStorage in plaintext form beyond what the user typed | unit |
| Tool schema → `tool_use` request wiring, both adapters | 8 | Anthropic `tools[]` and OpenAI `tools[].function` generated from one stored schema | unit |
| Tool loop: `tool_use` → execute → `tool_result` → continue | 8 | A two-round tool conversation completes; loop bounded by a max-iteration guard | integration |
| `stop_reason: tool_use` / `tool_calls` handling | 3 | Neither is presented to the user as a finished answer | fixture |
| Timeout and cancellation per tool call | 4 | Cancelling mid-tool leaves the transcript consistent, no half-written `tool_result` | integration |

**Bounded loops are a hard requirement, not a nicety.** A model that keeps calling a tool that keeps failing will spend money until the user notices. The max-iteration guard, its default, and the message shown when it trips are part of the acceptance criteria.

### Sprint 12 · Phase 5 · Tool approval and rendering · 26 pts · ✅ shipped (two stories deviate — §4.3)

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| Per-tool approval modes: always ask / allow / deny | 5 | Default is **ask**; "allow" is per tool per server, never global | unit + device |
| Approval UI showing the exact arguments | 5 | Arguments rendered readably; secret-looking values redacted in the prompt | device |
| `tool_result` rendering incl. `isError` | 3 | Errors visually distinct; long results collapsed with an expander | device |
| Nested content in tool results (recursive blocks) | 5 | An image returned by a tool renders | unit + device |
| Per-server rate and payload limits | 5 | A tool returning 10 MB is truncated with a visible notice | unit |
| Kill switch: disable all MCP in one tap | 3 | Disabling takes effect on the next turn without a relaunch | device |

**Approval defaults to ask.** A remote tool call is arbitrary code running somewhere else with the user's data. The convenient default is dangerous, so the default is the safe one.

### Sprint 13 · Phase 6 · Observability, performance, 1.0 · 24 pts · ◐ partly shipped (§4.4)

| Story | Pts | Acceptance criteria | Test strategy |
|---|---|---|---|
| Debug log screen: filter, copy, share | 3 | Copy produces redacted text; no unredacted value can reach the clipboard | **mandated security test** |
| Per-request timing surfaced (`firstTokenMs`, `latencyMs`) | 3 | Both recorded in `meta` and visible per message | unit |
| Performance panel: fps during stream, DB timings | 5 | Numbers gathered on device, no third-party SDK | device |
| Accessibility pass | 5 | TalkBack reads the transcript in order; targets ≥44 dp; contrast ≥4.5:1 | device + audit |
| Streaming-partial scratch row (data model §12.3), if justified | 5 | Process death mid-stream recovers the partial reply, one row rewritten per tick | integration |
| 1.0 release checklist and docs refresh | 3 | [07_Deployment.md](07_Deployment.md) checklist fully green; `progress.md` accurate | review |

### 4.3 Phase 5 retrospective — what MCP actually cost

Both sprints delivered, and unusually for this plan the estimates held: the tool loop was the 34-point sprint it was estimated as. What the plan got wrong was the *shape* of two stories and the *scope* of one.

| Sprint wording | What shipped | Why |
|---|---|---|
| "MCP client over HTTP/SSE (**no stdio**)" | **Two** HTTP transports, not one: Streamable HTTP (the current spec, answering either `application/json` or SSE) *and* the 2024-11-05 HTTP+SSE flow (`GET` for a stream, read the `endpoint` event, `POST` there) | Which one you get is the server's choice, not ours, and a large share of deployed servers still serve the old one. `parseServerUrl` rejects a non-HTTP scheme at the field the user types it into, so there is no stdio path and no code that could grow one |
| — (not scheduled at all) | **OAuth 2.1 with PKCE and dynamic client registration** (`src/mcp/oauth.ts`) | The plan assumed a bearer header the user pastes. Real servers ask for a browser round trip. It is a public client with no secret, because a secret shipped in an app is not a secret, and the token carries a `resource` indicator so it cannot be replayed against a different server. The token goes to SecureStore through the same path as the API key, which registers it with the redactor the moment it exists |
| — (not scheduled at all) | MCP **prompts** and **resources**, not just tools | A server that publishes prompts and resources and is only asked for tools looks broken to its author. `renderPromptMessages` and `resourcesFrom` were the cheap half of a spec we were already speaking |
| "Per-server rate and payload limits · a tool returning 10 MB is truncated with a visible notice" | A **payload ceiling on images only** (`MAX_TOOL_IMAGE_BASE64`, ~1.5 MB of pixels; past it the image is *described* rather than inlined), plus `MAX_PAGES = 20` on `tools/list` paging. **No rate limit, and no general text truncation** | Recorded rather than ticked. The 10 MB text case is real and still open; the image case was the one that could silently spend a whole context window on a screenshot nobody asked to look at, which is the failure that looks like the model forgetting the conversation |
| "Kill switch: disable all MCP in one tap" | **Not built as written.** What exists is per-conversation server selection (`/servers`), a per-tool enable switch, per-tool approval modes, and `confirmToolCalls` | Also recorded rather than ticked. Three controls that each answer "which tools can run here" are not the same as one control that answers "stop everything now", and the one-tap version is still worth building — it is the control you want during an incident, when picking through per-tool switches is exactly what you cannot do |

**The approval gate is the design worth keeping.** An approval has to happen *mid-turn*: the model has asked for a tool, the turn is blocked on the answer, and the user is looking at a transcript. `useMcp.invoke` parks a promise in `pending` and the sheet resolves it. Three consequences fell out, and each one is load-bearing:

- **A denial is a tool *result*, not an exception.** The model is told the user said no, which is information it can act on. An unanswered `tool_use` would make every *later* request in that conversation invalid.
- **"Always allow" is per tool, never global, and persisted** — so it survives the app dying, which is the only way the setting is worth anything.
- **Leaving the screen resolves nothing.** The sheet is rendered from the store, so coming back shows the same question rather than a turn that silently gave up.

**Timeouts are three numbers, not one.** `CONNECT_TIMEOUT_MS = 30_000` waits for headers; `CALL_TIMEOUT_MS = 60_000` bounds one whole call including a tool that genuinely runs for a while; `maxToolIterations` bounds the rounds. The reason the middle one exists at all is that the loop needs *an answer* to put in a `tool_result`, and "the server timed out" is an answer.

**One deliberate simplification, marked in the source.** `McpClient` opens one session per call — initialize, call, close. A tool holding per-session state on the server (a cursor, a temp directory) will not see it again next call. It costs one round trip and no lifecycle bugs; holding the session open is the upgrade if that turns out to matter.

**D-13 closed here.** `selectTools` and `describeWithheldTools` had tests and no call site when §4.1 landed them; they are now wired at [src/stores/chat.ts:1381](../src/stores/chat.ts:1381), which is what the debt item asked for.

### 4.4 Phase 6, partly delivered out of order

Three of Sprint 13's six stories shipped before Phase 6 opened, because each was needed by something else first.

| Story | State | Note |
|---|---|---|
| Debug log screen: filter, copy, share | **Shipped** | [app/settings/debug.tsx](../app/settings/debug.tsx). Both mandated redaction tests exist and pass — see §7.3 |
| Per-request timing surfaced | **Shipped** | `meta.firstTokenMs` / `meta.latencyMs`, behind `devPanelEnabled`, which is off by default because it is an eighth item in a menu people use to copy text |
| Accessibility pass | **Substantially shipped** | Labels and roles across 31 component and screen files; the long-press menu is the only route to a row's actions *and* the only one a screen reader reaches, which was the point. The TalkBack transcript-order audit is device work and still owed — parity Section 12 (§4.5) extended the pass to 87 labels, 78 roles, 52 hints and eight modal traps, and turned the owed audit into named steps: **76–79** in [07_Deployment.md](07_Deployment.md) §7, tracked as D-20 |
| Performance panel (fps, DB timings) | **Not built** | The timings are in `meta`; the UI is not. §6.3 already lists it as cuttable |
| Streaming-partial scratch row | **Not built** | D-10, still cuttable |
| 1.0 release checklist and docs refresh | **In progress** | This revision is part of it |

### 4.5 The two unplanned workstreams

Neither of these has a sprint table anywhere, and that is the honest record: they were requested and built directly, in the order the maintainer wanted them, without being decomposed into estimated stories first. Recording them here as one block each is better than back-dating a plan they never followed.

**`V` — the v1.1 list** ([progress-v1.1.md](../progress-v1.1.md)). Skills (`invoke_skill` with a zip importer), a prompts library, projects with extracted knowledge, remembered facts, backup and restore, an app lock, **SQLCipher at rest**, message variants with a ‹ 2/3 › navigator, and provider-side web search. Two of these changed the shape of the data model rather than adding to it: encryption moved the whole database behind a raw key in SecureStore ([05_Data_Model.md](05_Data_Model.md) §12.7), and variants added three columns to `messages` instead of the parent-pointer tree the obvious design would have used (§10.1, migration 7 → 8).

**`C` — Sections 1–7 and 10–12 of the Claude-parity checklist**, a twelve-section list of UI/UX gaps against the Claude mobile app, worked in order. Sections 1–7 delivered: message rendering (typewriter reveal paced off the backlog, a long-press menu that opens where you pressed, toasts, one motion vocabulary), inline visuals (charts drawn with views and text — no chart library, no SVG, no WebView), file *reading* (Office formats in, in-app preview), file *generating and editing* (`create_document` writing real `.docx`/`.xlsx`/`.pptx` from Markdown through `fflate`, and a generated file that can be opened, edited and saved back), voice mode (speech-to-text, text-to-speech, a full-screen no-keyboard conversation), an in-app camera (a viewfinder, several shots per message, a review strip that drops one by tapping it), and the history drawer (date-grouped headings with counts, virtualised through FlashList, a search that flattens to one relevance-ordered run). Section 10 — connected tools — was taken next because Sections 8 and 9 are product decisions rather than engineering ones (§6.4), and it delivered a bundled connector directory (`src/mcp/catalog.ts`: eleven vendor endpoints, ordered so the first one anybody tries needs no account, tapping one *prefills* the existing add form rather than saving anything) and one place that answers "what tools does this turn have" — `summariseTools` in [builtins.ts](../src/chat/builtins.ts), rendered in the conversation's ⋯ menu and on the new [settings/tools.tsx](../app/settings/tools.tsx) screen the three global switches moved to. **Sections 11 and 12 — platform specifics and accessibility — closed the block**, and they are the two whose deliverable was as much a *survey* as a build: nearly everything both sections ask for was already in the app (inbound intents, share-out, notifications, hardware back on all eight modals, keyboard resize, safe-area insets, permission dead-ends routed to `Linking.openSettings()`; 87 accessibility labels, 78 roles, 52 hints, 25 states, eight live regions, `accessibilityViewIsModal` on every modal, Reduce Motion subscribed to and honoured per-animation). Three real gaps were found and all three were JavaScript: nothing was ever announced to a screen reader (`announceForAccessibility` appeared zero times, so a TalkBack user got silence when a reply completed — the transcript deliberately carries no live region, because one on streaming text makes TalkBack restart from the top on every token), `expo-updates` was configured and never called from JavaScript (so a downloaded security fix waited for an unprompted cold start), and one control could scale out of its own fixed-height box. Four items were **flagged rather than stubbed** because each needs a rebuild: `ACTION_SEND` (Android puts the payload in intent extras that `Linking` and `+native-intent.tsx` cannot read — the one genuine feature gap left), launcher shortcuts, predictive back, and landscape. Two items in either workstream **need a rebuild**: the inbound "open with" intent, an `intentFilters` change in `app.json`, and `expo-camera` — the only new native *module* in the whole of `V` and `C`, and the reason Section 6 could not be an update. Sections 7, 10, 11 and 12 are the counter-examples worth noting: no new dependency, no native change, so all four are parity sections an installed build can receive over the update channel.

**What this costs the plan, stated plainly.** §6.2's velocity projection counts planned points only, so it now describes a fraction of the work done (§6.4). And §11's debt register was never re-seeded from these two workstreams the way it was seeded from [05_Data_Model.md](05_Data_Model.md) §12 — D-16 and D-17 below are the start of that, not the end of it.

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
| 2 (done) | S5–S6 | 47 | 155 | Weeks 9–12 |
| 3 (done) | S7–S8 | 53 | 208 | Weeks 13–16 |
| 4 (done) | S9–S10 | 57 | 265 | Weeks 17–20 |
| 5 (done) | S11–S12 | 60 | 325 | Weeks 21–24 |
| 6 (partly done) | S13 | 24 | 349 | Weeks 25–26 |

All 349 planned points are delivered except roughly 10 of Sprint 13's 24 (the performance panel, the scratch row and the closing checklist). **There is no slack left in the plan because there is almost no plan left** — which is a different problem from the one this section was written to manage.

### 6.3 What gets cut first, if it must

Written before Phases 3–5 shipped, and four of the five items have since been settled by events rather than by a cut: nested content in tool results **shipped** (images, with a ceiling — §4.3), bulk operations beyond delete **shipped**, re-summarise-the-summary **shipped** as `boundSummary` (§4.2), and the scratch row is still unbuilt (D-10). Only the performance panel remains genuinely cuttable, and it is the one thing still open in Sprint 13 besides the checklist.

The original order, kept for provenance, most-cuttable first: (1) the streaming-partial scratch row (S13 — the loss is recoverable by regenerating), (2) bulk operations beyond delete (S6), (3) nested content in tool results (S12 — text-only results cover the common case), (4) re-summarise-the-summary (S10 — cap conversation length instead), (5) the performance panel (S13 — keep the timings in `meta`, drop the UI).

Never cut: the export/log redaction tests, the `LIKE` search fallback, the retry policy, tool approval defaults, or physical-device verification.

### 6.4 The estimate model has run out of plan, and that is now the finding

The original statement in §6.2 was "at the observed 27 pts/sprint, the remaining 241 points need ~9 sprints; nine are planned." Nine were planned and the work is done, so the projection was sound. What it cannot do is describe the present, for one reason: **the two largest workstreams in the repository were never pointed** (§4.5). The velocity number and the totals table both count planned stories only, so any reader using them to answer "how much has been built" will be out by more than a factor of two.

Three ways forward, and the middle one is the recommendation:

1. **Back-fill points for `V` and `C`.** Honest-looking and worthless — points measure uncertainty *at the time of estimating*, and an estimate made after the code exists has none.
2. **Stop projecting from points and project from the checklist.** Sections 8–12 of the Claude-parity list were the actual remaining scope. Each section was one to two of these sprints' worth of work, and each had a known dependency question (Section 6 needed `expo-camera` and therefore a rebuild, which is now the standing cost of the next release rather than a projection; Sections 7, 10, 11 and 12 needed nothing at all and shipped as JavaScript; Section 8 needs a server this project does not have, and Sections 8 and 9 are both on the PRD's non-goals list, so they need a product decision before an estimate). **Sections 10, 11 and 12 have now all shipped** — every section this entry named as workable. What is left is Sections 8 and 9 behind their product decision, and neither is an estimating problem: one is a premise change and the other is a battery-and-cost decision. The useful residue is a different list, and it is not sized in points either: **four flagged items that each need a rebuild rather than a decision** — `ACTION_SEND`, launcher shortcuts, predictive back, landscape (§4.5 `C`). Sizing work as *items with a named blocker* is what this entry was arguing for, and the checklist finishing without a single re-estimate is the argument's result.
3. **Re-baseline the whole plan at 1.0.** Correct eventually, premature now: the release checklist is the thing in flight, and re-planning around it is how it slips.

Until that happens, treat §6.2 as a record of Phases 1–6 and **not** as a burn-down. The staleness signal in *Ownership* is updated to say so.

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

**The tradeoff, stated honestly.** This buys a fast, deterministic suite (1,603 tests in ~5 s) and near-total coverage of decision logic. It buys *zero* coverage of rendering, gesture handling, navigation and layout. A component that fails to render is caught by a human on a device or not at all. Adding `jest-expo` + React Native Testing Library would close that gap and cost a much slower suite, a jsdom-shaped environment that is not the real runtime, and a category of test that historically breaks on every RN upgrade. For a solo maintainer shipping to Android with a scripted device protocol ([07_Deployment.md](07_Deployment.md)), the current split is the better trade. **Revisit it if a second engineer joins**, because the calculus changes when a regression can be introduced by someone who did not write the original code.

**One constraint the rule turns out to carry, worth knowing before you write a test.** `testEnvironment: 'node'` with no setup file means a tested module's *entire import graph* has to be free of `react-native` and of `expo-file-system/legacy` — not just the module itself. That is why several pure modules exist as siblings of the code that uses them rather than inside it: `src/db/ddl.ts`, `list-query.ts`, `variants.ts`, `cipher.ts` and `content.ts` are the `expo-sqlite`-free halves of the database layer, and the same split runs through `attachments.ts`↔`attach.ts`, `office.ts`↔`ooxml.ts`, `voice.ts`↔`speech.ts`, `chart.ts`↔`ChartView.tsx`, `preview.ts`↔`FilePreview.tsx`, `toolLabel.ts`↔`ContentBlocks.tsx` and `incoming.ts`↔`+native-intent.tsx`. Adding an import to the wrong side of one of those pairs breaks a suite in a way the error message does not explain.

### 7.2 What each tier covers

| Tier | Scope | Runner | Gate |
|---|---|---|---|
| Unit | pure functions, transports (injected `fetch`), db logic, redaction, tokens, retry | `jest`, `node` | CI, every push |
| Integration | store↔db↔transport turn orchestration, migrations, FTS rebuild, tool loop | `jest`, `node`, in-memory SQLite | CI, every push |
| E2E | the six flows in §17, on real hardware | human, scripted | release only |

### 7.3 Test cases that must exist (and their current status)

**The two mandated security tests are written and passing.** They were the one item in this section that blocked the 1.0 gate, and they no longer do: the debug-log case is [src/lib/redact.test.ts](../src/lib/redact.test.ts), whose own header calls it "the mandated redaction test", and the export case is [src/chat/export.test.ts](../src/chat/export.test.ts). Both go further than the sketches below — the log suite covers a key arriving inside a gateway error message, a second registered key, an unregistered key caught by the pattern backstop, and `unregisterSecret`; the export suite asserts on the *filename* as well as the body. The sketches are kept because they state the intent in four lines, which the real suites take two hundred to do.

```ts
// SECURITY — implemented: src/lib/redact.test.ts, src/chat/export.test.ts.
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

One more joined with parity Section 10, and it is a different species: a **tripwire over knowledge
this codebase cannot share.** `src/chat/plan.ts` imports `src/chat/builtins.ts`, so `builtins.ts`
must never import `plan.ts` — which means `summariseTools`, which has to say *writing blocked* when
plan mode is on, cannot ask `blockedInPlanMode` which tools those are. The wording is therefore
duplicated, deliberately, and the test both modules *can* import asserts the duplicate still
matches:

```ts
// TOOLS — the summary's plan-mode wording is a copy; this fails when the split moves.
it('matches what plan mode actually blocks', () => {
  expect([WRITE_FILE, CREATE_PDF, CREATE_DOCUMENT].every(blockedInPlanMode)).toBe(true);
  expect([FETCH_URL, RUN_CODE, READ_RESOURCE].some(blockedInPlanMode)).toBe(false);
  const planning = summariseTools({ ...NONE, web: true, code: true, serverTools: 4, servers: 1, plan: true });
  expect(planning).toContain('writing blocked');
  expect(planning).toContain('4 server tools blocked');
  expect(planning).toContain('web pages');   // plan mode blocks by effect: these two read
  expect(planning).toContain('code');
});
```

The pattern generalises: **where a cycle forces two modules to know the same thing, the test that
can see both is the only place the agreement can live.** Prefer removing the duplication; where the
import graph forbids it, a failing test is a much cheaper way to find out than a user reading a
tool summary that contradicts the gate.

`src/mcp/catalog.test.ts` is a second unusual case from the same section, and worth naming for the
opposite reason — **what it deliberately does not test.** It checks eleven bundled connector
endpoints against the app's own `parseServerUrl` and `qualifyToolName`, so no entry can ship that
the add form would reject or whose slug would be mangled into a different tool name. It does *not*
check that any endpoint still answers. That needs the network, and a suite that goes red when a
vendor has an outage is a suite people learn to ignore. Liveness is §7 device step 72 instead, and
that step says what a failure means: the entry is stale, fix `src/mcp/catalog.ts`, not the handset.

A third, from Section 12, is the only test in the suite whose subject is an **invariant between two
functions** rather than either function's output. `replyNotice` and `replyAnnouncement` in
[`src/lib/notify.ts`](../src/lib/notify.ts) are the notification and the screen-reader utterance for a
finished turn; they take the same input, refuse the same three turns (aborted, empty, and the wrong
side of `foreground`), and are meant to be mutually exclusive. Neither function can state that on its
own:

```ts
// NOTIFY — foreground decides which speaks; neither silence nor both is legal.
test('exactly one of the two speaks for any turn', () => {
  for (const foreground of [true, false]) {
    const said = [replyNotice({ ...base, foreground }), replyAnnouncement({ ...base, foreground })];
    expect(said.filter(Boolean)).toHaveLength(1);
  }
});
```

It is cheap and it guards the failure that would actually reach a user: a change to one branch that
leaves a completed reply announced twice, or announced not at all. The same reasoning is why
`notifyReplyReady` reads `AppState` **once** and dispatches, rather than each function reading it —
two readers of one condition is the state this test would no longer be able to see.

### 7.4 Coverage policy

Coverage is reported and the gate is a **ratchet at a few points under the current measured rate**, not a target. A number chosen aspirationally gets met by testing easy code; the floor exists only to catch a PR that deletes tests or lands a whole file untested. The live figures, from `jest.config.js`:

| Metric | Measured | Floor | Slack |
|---|---|---|---|
| Lines | 71.62% | 68 | 3.6 |
| Statements | 70.05% | 66 | 4.1 |
| Branches | 66.24% | 63 | 3.2 |
| Functions | 64.49% | 58 | 6.5 |

**Raise them when a run comes in comfortably higher; never lower them to make a red run green.** That single edit is the one that makes the gate meaningless, and it is easy to justify in the moment, which is why the rule is written down in two places.

**How the denominator is actually drawn, since the old wording here was wrong.** `collectCoverageFrom` is `['src/**/*.ts', '!src/**/*.test.ts', '!src/**/__tests__/**']` — the exclusion is by **file extension**, not by directory. So every `.tsx` component is outside the denominator, and `app/` is outside it entirely because it is not under `src`; but a `.ts` file that happens to live in a component directory is *inside* it. That is not academic: `src/components/` currently reports **0%** for its own `.ts` files while `src/components/markdown/` reports 94.88%, and the difference is only which of them a pure module was extracted from.

Per-directory expectations, enforced by review rather than tooling, with where they currently stand:

| Directory | Expectation | Measured |
|---|---|---|
| `src/transports/` | near-total on branches | 89.46 / 79.34 |
| `src/chat/` | near-total on branches | 86.98 / 80.82 |
| `src/components/markdown/` | pure halves near-total | 94.88 / 87.89 |
| `src/mcp/` | near-total, less `oauth.ts` (browser round trip) | 70.28 / 61.23 |
| `src/lib/` | near-total, less the `expo-*` wrappers | 55.46 / 56.79 |
| `src/db/` | the `expo-sqlite`-free modules near-total; the rest device-only | 25.75 / 21.58 |
| `src/stores/` | actions that decide something, not actions that forward | 39.94 / 33.02 |

The last three read badly and are honest rather than embarrassing: `src/db/schema.ts`, `src/lib/secureKey.ts`, `src/mcp/oauth.ts` and every `providers`/`projects`/`memory` store action sit at 0% because their first import is a native module, and the response was to extract the decisions into siblings that *are* covered (§7.1) rather than to mock a Keystore. **Judge a change by whether it moves the four global numbers down, not by the distance to 100.**

---

## 8. Quality gates

**Five gates, not four.** The document shipped with four; CI has since grown a fifth, and it is the one that catches the class the other three structurally cannot. All four automated gates must pass before a merge to `main`; all four plus the device protocol before a release.

| # | Gate | Command | Blocks | Rationale |
|---|---|---|---|---|
| 1 | Types | `pnpm typecheck` (`tsc --noEmit`) | merge | Strict TS is this project's substitute for a schema validator at every boundary |
| 2 | Lint | `pnpm lint` (`eslint .`) | merge | Catches unused code and import-boundary violations |
| 3 | Tests + coverage | `pnpm test --ci --coverage` (`jest`) | merge | 1,603 tests, ~6–8 s with coverage. `jest.config.js` carries a `coverageThreshold`, so coverage is a gate here and not a report (§7.4) |
| 4 | Bundle | `pnpm expo export --platform android` | merge | **The gate the other three cannot be.** `testMatch` is `.ts` only, so no screen is ever imported by the suite, and `tsc` resolves *types* without resolving what Metro will actually resolve. A bad `@/` alias, a missing asset, a module that only exists on web: all three pass gates 1–3 and fail on the device. The output is thrown away; only the exit code matters |
| 5 | Device | scripted protocol on Pixel 6 + Samsung S22 | release | The only coverage of rendering, gestures and real network behaviour |

```bash
pnpm gates
```

That script is `typecheck && lint && test:coverage` — gates 1–3. Gate 4 has no script; run it directly and delete the output:

```bash
pnpm expo export --platform android --output-dir .expo-export
```

Two CI details that are easy to get wrong and were both got wrong once. The runner pins **Node 24**, not 22, because `src/db/__tests__` imports `node:sqlite` to build the real schema and assert query plans with `EXPLAIN QUERY PLAN`; on Node 22 that module needs `--experimental-sqlite` and the whole directory fails to load. And the flags go to `pnpm test` with **no `--` separator**, because pnpm 10 forwards `--` verbatim, so jest read `--ci` as a positional test-path pattern, matched nothing, and exited 1 on a suite that passes locally.

**Why device verification is a gate and not a task.** The unit tiers cannot see the three failure classes that actually reach users: a component that throws on render, a gesture that fights the streaming scroll anchor, and a network transition (Wi-Fi → cellular → dead zone) mid-stream. Every one of those has to be observed. The protocol is in [07_Deployment.md](07_Deployment.md); the point here is that "tests pass" is not a release criterion on its own.

---

## 9. CI/CD pipeline

**Shipped in Sprint 5.** Both workflows exist: [`ci.yml`](../.github/workflows/ci.yml) and
[`build-apk.yml`](../.github/workflows/build-apk.yml). The YAML below is the *plan* as
written before the runner was tried; the corrections it needed are recorded in §9.4,
and the files themselves are authoritative. Read them, not this.

**Four differences between the plan below and the shipped `ci.yml`**, since they are all things a reader would otherwise take from here and get wrong: the runner pins **Node 24**, not 22 (`node:sqlite` needs `--experimental-sqlite` on 22, so `src/db/__tests__` will not load); the test flags carry **no `--` separator**; there is a fifth step, `pnpm expo export --platform android`, which is gate 4 (§8); and the coverage summary step **reads the `json-summary` artefact Jest already wrote** with a small `node -e` script rather than re-running the suite to produce the same numbers twice.

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

Probability (P) and Impact (I) on 1–5. Exposure = P × I. R-01 through R-14 are ordered by exposure as first issued; **R-15 and R-16 are appended rather than sorted in**, so the identifiers already quoted elsewhere in the doc set stay stable. Read the Exp column, not the row order.

| ID | Risk | P | I | Exp | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|---|
| R-01 | Gateway behaves differently from its docs; no live verification has occurred | 4 | 5 | 20 | Every wire assumption behind a fixture test so the diff is small when reality differs; verbatim gateway error text preserved so a mismatch is *readable*; live smoke test as the first act of any release | maintainer | **open** |
| R-02 | Auth failure misdiagnosed as an allowlist or network problem | 3 | 4 | 12 | `key_rejected` / `forbidden` / `insufficient_credits` are separate kinds with distinct hints; `MissingKeyError` thrown instead of sending an empty Bearer; failover explicitly excluded for non-`network` kinds | maintainer | mitigated |
| R-03 | Network interruption mid-stream loses the partial reply | 4 | 3 | 12 | Retry on `network`; failover only *before* the first event (after it, retrying would duplicate output); user message durable before the request; scratch-row persistence costed in S13 | maintainer | partially mitigated |
| R-04 | Context-window overflow rejects a request the gauge said was fine | 3 | 4 | 12 | Pressure measured against **usable** space, not raw window; `drop_oldest` / `summarise` strategies; `pause_turn` continued; one confirmation before an over-window `warn` send. **Partly mitigated:** the ±15% estimator gate is deferred with D-11, so the gauge's accuracy is still unmeasured | maintainer | S9 → D-11 |
| R-05 | Solo-maintainer bus factor | 3 | 4 | 12 | Every non-obvious decision documented in the doc set; "decisions not to undo" list; comments explain *why*; this document's §6.3 cut list | maintainer | ongoing |
| R-06 | FTS5 absent from a device's SQLite build | 2 | 4 | 8 | Runtime probe, `IF NOT EXISTS` creation outside the migration chain, `LIKE` fallback, suite run with FTS5 forced off | maintainer | mitigated |
| R-07 | Android Keystore unavailable or SecureStore throws | 2 | 4 | 8 | Fall back to the module-scoped in-memory cache for the session; **tell the user the key will not persist**; never fall back to AsyncStorage | maintainer | see §10.1 |
| R-08 | Expo SDK 57 upgrade breaks the native ABI (already happened once) | 3 | 3 | 9 | `react-native-reanimated@4.5.1` / `react-native-worklets@0.10.1` pinned for C++ ABI compatibility; `expo-updates@57.0.19` pinned for the EAS `minimumReleaseAge` policy; upgrade in its own PR with a device pass | maintainer | mitigated |
| R-09 | Base64 attachment blows up memory on a mid-range device | 3 | 3 | 9 | Downscale before encode; hard per-request byte budget refused up front; memory ceiling as an S7 acceptance criterion. **The ceiling itself is still unmeasured** (D-14) | maintainer | S7 → D-14 |
| R-10 | `VACUUM` (or a table rebuild) silently desynchronises the FTS index | 2 | 4 | 8 | Documented prohibition ([05_Data_Model.md](05_Data_Model.md) §12.1); rebuild required in the same transaction; move the drift check to FTS5 `integrity-check` | maintainer | open (debt D-03) |
| R-11 | MCP tool loop spends unbounded money | 2 | 4 | 8 | `maxToolIterations` guard, plus a 30 s connect and 60 s per-call timeout and a 20-page cap on `tools/list`; retry policy applies to tool calls; approval defaults to ask. **The one-tap kill switch was not built** as written — see §4.3 | maintainer | mostly mitigated |
| R-12 | A persisted-state migration loses provider profiles | 2 | 3 | 6 | Independent version counters per tier; a `migrate` would merge over defaults rather than replacing. **Untested, because no store has needed a `migrate` yet** — all four are still on `version: 1` ([05_Data_Model.md](05_Data_Model.md) §10.3), so the mitigation is a convention rather than code | maintainer | untested |
| R-13 | Hydration race renders defaults over stored values | 2 | 3 | 6 | 3 s timeout plus the convention that stores persist only on explicit change; any auto-write at startup must check hydration. On timeout the app now logs which stores did not arrive, so "my provider profile is gone" is diagnosable from Settings → Debug rather than looking like data loss | maintainer | partially mitigated |
| R-14 | APK grows past a comfortable direct-download size | 2 | 2 | 4 | Tree-shaking, image compression, no unused native modules — tracked in [07_Deployment.md](07_Deployment.md) | maintainer | monitored |
| R-15 | An unrecoverable database: the SQLCipher key is lost and nothing is backed up | 2 | 5 | 10 | Accepted, not mitigated, and the mitigation *is* that nothing leaves the device: `android:allowBackup` false plus `plugins/with-no-backup.js`, so there is no encrypted copy anywhere to be stranded by a key that no longer opens it. The hazard is the **next** feature that copies the DB off-device — cloud sync, export-and-restore, "move to my new phone" — because `sqlcipher_export` is a one-way conversion and not a general-purpose rekey ([05_Data_Model.md](05_Data_Model.md) §12.7) | maintainer | accepted; re-opens with sync |
| R-16 | A fork or a regenerate is interrupted and leaves a conversation that looks complete and is not | 2 | 3 | 6 | None yet. `forkConversation()` calls `createConversation()` then loops `appendMessage()` outside any transaction, so a process death partway through leaves a fork holding a prefix of its messages with nothing on screen to say so | maintainer | **open (debt D-16)** |

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
| D-01 | ~~Four stale web-export directories in the tree~~ | ad-hoc web export checks | — | — | **closed in S5**; the directories are gone and gitignored, and CI's gate 4 now writes `.expo-export` deliberately instead |
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
| D-13 | `selectTools` / `describeWithheldTools` have no call site | §4.1 landed the tool budget before tools reach `buildRequest` | tested code that no request exercises; the wiring assumptions could be wrong in a way the tests cannot see | wire into the request builder alongside the MCP manifest | **closed in S11** — [src/stores/chat.ts:1381](../src/stores/chat.ts:1381) |
| D-14 | `src/chat/attach.ts` has no automated coverage at all | it is four `expo-*` packages and a file system; the testable half was extracted into `attachments.ts` instead | the memory ceiling the whole module is arranged around (P-10) is unmeasured, as is whether every `saveAsync` temporary is really deleted | one device session: attach eight photos with the Android Studio profiler attached, then check the cache directory | first device session (with D-11) |
| D-15 | The 2,500-token image estimate is a provider figure applied flat, never measured | no live turn has reported a prompt count for a request containing an image | the gauge is wrong by an unknown amount on any conversation with attachments, and the calibration factor deliberately does not correct it | compare one reported prompt count against the estimate for the same request; if it is consistently off, the constant is the fix, not the factor | first live session (with D-11) |
| D-16 | `forkConversation()` is not wrapped in a transaction | the fork feature; `createConversation()` then a loop of `appendMessage()` | a process death partway through leaves a fork holding a **prefix** of the messages it should have, and it looks complete — the failure is silent and permanent (R-16) | one `withTransactionAsync` around the create-and-copy; [05_Data_Model.md](05_Data_Model.md) §14.5 points here | next DB touch, ~1 pt |
| D-17 | The two unplanned workstreams were never debt-reviewed | §4.5 — `V` and `C` were built directly, not through a sprint close | §11 is seeded from [05_Data_Model.md](05_Data_Model.md) §12 and from sprint retrospectives; two-thirds of the code has been through neither, so this register is now a *sample* of the debt rather than the register of it | one pass over `src/chat/` and `src/components/` against §18's Docs and Tests blocks, filing what it finds | before the 1.0 checklist closes |
| D-18 | No in-app "clear all data", and the four-tier wipe is only a checklist | never built | uninstalling is the only complete erase; §13's line item describes a feature that does not exist, which is worse than an absent one because it reads as done | build it, or strike the line and say so in Settings. The checklist in §13 is the specification | before 1.0 |
| ~~D-19~~ | ~~The test suite is ~11 s against a <10 s target (P-12)~~ | **Closed 2026-09-02 by re-measuring.** 1,573 tests / 79 suites run in ~4–6 s warm; `calibration.test.ts`, blamed for ten of the eleven seconds, is **0.64 s**. The original figure was a cold filesystem cache read as a slow suite — the debt was in the measurement, not the code | — | — | done |
| D-20 | Everything parity Section 12 claims is unverified by construction | §4.5 `C`; no gate in this repository can run a screen reader | 87 labels, 78 roles, 52 hints, 25 state props and `accessibilityViewIsModal` on all eight modals are **assertions about what TalkBack would say**, and a wrong label reads as a confident wrong answer rather than as a missing one. The most likely failure is not an absent prop but a plausible one in the wrong place — focus order that jumps, or two things claiming to be the same control | device steps **76–79** ([07_Deployment.md](07_Deployment.md) §7, group T): TalkBack through a full turn, Reduce Motion on, largest font size, and the modal traps | first device session (with D-11) |

**Spec corrections made in Phase 3, recorded rather than silently substituted:** Sprint 8's "Attach affordance hidden for models that cannot accept documents" ships as *shown and disabled with the reason*, because `vision`/`documents` are hand-edited flags and a hidden affordance is indistinguishable from a missing feature. Sprint 7's two device criteria (12 MP → 1.5 MB, 20 images under 250 MB) are asserted as the decisions they protect — `planResize`'s output and `admitImage`'s refusal — with the memory ceiling itself left open as D-14. **Two more in Phase 5**, both in §4.3: per-server *rate* limits and general result truncation did not ship (only an image payload ceiling did), and the one-tap MCP kill switch did not ship.

**Policy:** debt gets an ID here or it does not exist. Items D-01 through D-08 were all scheduled into Sprint 5 precisely because they were cheap and they distort everything measured after them — a stale doc and an absent CI both cause work that looks like development and is not.

**Status as of 2026-09-02.** **Closed: D-01 … D-08, and D-13.** The four web-export directories are deleted and gitignored (and CI now writes `.expo-export` on purpose, as gate 4); `conversations_order` became `conversations_list (archived, pinned DESC, updated_at DESC, id DESC)` in migration 1 → 2 with a planner assertion holding it there; the FTS drift check is now `INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)` (`src/db/schema.ts`), where the `rank = 1` argument is the part that catches rowid renumbering; the store action calls `previewOf()`; the `Number.EPSILON` addition is gone from `regenerate()` and the comment now explains why it never worked (a ULP above `seq = 4` is larger than `EPSILON`, so the addition rounded away); both `progress.md` drift items are corrected; CI is green; and `selectTools` finally has a caller. **Open by design: D-09** (no component tests — deferred with a trigger) and **D-10** (the scratch row — still cuttable). **Open and blocked on hardware or a key: D-11, D-12, D-14, D-15**, which all discharge together in one live session with a profiler attached; that session is now the single largest piece of unretired risk in the project, and it has been the same four items for three revisions. **Opened in revision 1.5: D-16 … D-19.** D-16 is a real correctness gap with a one-point fix and the only reason it is not closed is that nothing has touched the fork path since; D-17 is the honest admission that this register no longer covers the codebase; D-18 and D-19 were both "a document claims something the code does not do", which is the failure mode this whole doc set is arranged against. **D-19 closed in 1.6 by re-measuring rather than by optimising** — the suite was never slow, the reading was cold — and that is worth keeping as an example: a metric quoted from one run is an anecdote, and this register is exactly where an anecdote hardens into a debt item nobody re-checks. **D-17 remains open and just got larger again**, since parity Section 10 is a *fifth* out-of-order workstream close with no debt pass. Two of the five are camera and drawer work in `src/components/`, which is precisely the directory D-17's remedy names and the one the coverage denominator reports at 0%. Section 10 is the one close that arguably *reduced* the register instead: it moved the three global built-in switches out of the settings hub onto a screen of their own, and replaced four screens' worth of "what tools are live" guesswork with one covered pure function — but it also introduced knowledge that has to be duplicated (§7.3's tripwire note), and that belongs in the pass D-17 describes. **Revision 1.9 changes the shape of this slightly.** Sections 11 and 12 land inside `C`, so they add no *new* workstream to the count, and Section 11 is the nearest thing to a debt pass any of the five has had: it was a survey rather than a build, it swept `app/` and `src/components/` along one dimension (what the platform expects an Android app to do), and it found the code largely already correct — three gaps, all JavaScript-only, all closed. That is one dimension, not D-17's remedy, which names §18's Docs and Tests blocks; but it is the first evidence in this register that the unreviewed two-thirds is not accumulating defects at the rate an unreviewed codebase usually does. **Opened in 1.9: D-20**, which is the mirror image of that reassurance — Section 12 shipped 87 labels and 78 roles that no gate here can hear, so it is the one part of the parity checklist whose completion is a claim rather than a measurement.

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

**P-12 is met, at ~4–6 s warm** (1,603 tests / 80 suites, re-measured 2026-09-02 across three runs). This closes **D-19**, and the way it closed is the useful part: nothing was optimised. The previous entry blamed `src/stores/calibration.test.ts` for "about ten of those seconds" — it runs in **0.64 s** on its own, so the ~11 s reading was a cold filesystem cache being attributed to a suite. A cold run still exceeds the target and a coverage run lands at ~6–8 s, so the honest form of this row is *warm, without coverage*, and that is what CI measures. Every other row in this table is either measured on hardware this environment does not have, or measured and holding.

**One casualty is worth recording, because it is the same mistake one layer down.** Re-running the gates with a second Jest process alive put the machine under enough contention to fail `src/chat/list-cost.test.ts`, whose three cost guards asserted absolute times — 2,000 ms for 1,000 markdown bodies and 150 ms each for the two conversation-list guards. The parser had not changed; the machine was busy. They were rewritten as **ratios** — a quarter of the input measured against all of it, asserting under 12× (linear is 4, quadratic is 16), with the minimum of three runs taken and each unit repeated 20× for timer resolution — and verified against three concurrent suites. The pattern to carry forward is the same one that closed D-19: **a duration measures the machine, a ratio measures the code.** The <10 s target in this table is the last absolute timing figure the repository still asserts anything on, and it is a CI observation rather than a test.

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
- [ ] The SQLCipher raw key is in SecureStore and nowhere else; no code path writes it, logs it or puts it in a backup
- [ ] An MCP OAuth access token goes to SecureStore through the same path as the API key, so it is registered with the redactor the moment it exists

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
- [ ] The update channel is reviewed as a code-delivery path, not a convenience: `updates.enabled` is on, so an EAS channel can replace this app's entire JavaScript bundle on the next cold start, and **`expo-updates` code signing is still not configured** ([flaws.md](flaws.md) §2.7). Until it is, the channel's integrity is the account's. Settings' *Restart to finish updating* row makes the moment a pending bundle takes effect a user choice rather than an unprompted one — visible, not safer

**Data**
- [ ] A `clear all data` action, **when one is built**, clears all four tiers: SQLite, AsyncStorage, SecureStore (API keys *and* MCP OAuth tokens) **and** `clearRegisteredSecrets()` — plus the document directory, which nothing cascades to ([05_Data_Model.md](05_Data_Model.md) §12.5). **There is no such action today** (D-18): Settings offers backup, restore and per-item deletion, and uninstalling is the only complete wipe. This line is the specification for the feature, not a claim that it exists
- [ ] Export contains no secret and no `meta.baseUrl` the user did not enter
- [ ] No telemetry, no analytics, no third-party crash reporting — verified by dependency review
- [ ] MCP server headers treated as secret-bearing by default — which is why `useMcp` is deliberately **not** `persist()`-wrapped ([05_Data_Model.md](05_Data_Model.md) §13.1)
- [ ] A restored backup carries settings, providers, skills, prompts and servers, and **never** keys or conversations

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
   │ 4 automated│           │ 2 sprints  │            │ crash-free │
   │ gates green│           │ with no    │            │ >99%       │
   │ + live     │           │ P1 bug +   │            │            │
   │ smoke test │           │ device pass│            │            │
   └────────────┘           └────────────┘            └────────────┘
```

**Alpha exits when the live smoke test passes**, not when the features are done. R-01 is the largest open risk and no amount of feature work retires it; one real request against a real gateway does. **That gate has not been passed.** The four automated gates are green and the smoke test is still blocked on a key (D-11) — which is why the rollout has not moved off alpha even though Phases 0–5 are complete and two unplanned workstreams have shipped on top of them. It is the clearest single statement of where this project actually is.

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
| 1 | Errors rendering as "unknown" | 0 across the 14 kinds | fixture test |
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

**Which of these are actually measured.** The ones whose measurement is a fixture or a test are green: both adapter suites, the interface-violation count, the 15-kind error coverage, the export-secret count, the tool loop, and unapproved executions. Every row whose "Measured by" column says *instrumented*, *device*, *profiler*, *manual* or *beta tester* is **unmeasured**, because this project has never had a device or a live key attached (D-11, D-14). That is nine of the seventeen rows, and it is the same gap R-01 names — not nine separate problems.

Two metrics are deliberately absent. **DAU/retention**: unmeasurable without telemetry, and the project's privacy stance means it stays that way. **Crash-free rate before Phase 6**: with fewer than ten testers the denominator is too small for the number to mean anything; before then, the honest metric is "count of distinct crashes reported", which is a list, not a rate.

**The unplanned workstreams have no metrics here**, and that is a real gap rather than an oversight worth hiding: nothing in this table says whether voice mode is usable, whether a generated `.docx` opens in Word, or whether a chart is legible. The first two are device questions and belong in [07_Deployment.md](07_Deployment.md)'s protocol. The third is closer than it looks and still not covered: the ≥3:1 series contrast is recorded as a *measurement in a source comment* ([src/theme/index.tsx](../src/theme/index.tsx)), which no gate re-checks — so a palette edit can quietly drop below it, and nothing fails. A contrast assertion over the palette is a pure-`.ts` test this project can actually run, and it is the cheapest of the three to close. **Parity Sections 11 and 12 are the first of these to arrive with their metric attached** rather than owed: the four things they claim which nothing here can check — a screen reader hearing a reply land, the largest font size not clipping, Reduce Motion honoured, a modal trapping focus — are steps 76–79 of that protocol and D-20 in §11. Naming them did not measure them; it stopped them being uncounted.

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
| **Talk to it** — hold to speak, hear the reply | `expo-speech-recognition` → `voice.ts` → `runTurn` → `expo-speech`, paragraph highlighting | `C` | no permission, no recogniser on the device, TTS that stops mid-paragraph on an interruption |
| **Ask it for a document** — get a `.docx` back, edit it, save it | `create_document` → `ooxml.ts` → `fflate` → the file card → the in-app editor → the system folder picker | `C` | an Office file re-read for editing recovers words, not layout, so saving one would silently delete formatting — which is why they are read-only and say so |
| **Open a file from another app** — *Open with → SuperAgent* | `intentFilters` → `+native-intent.tsx` → `incoming.ts` → a staged new conversation | `C` | a `file://` path can name this app's own private storage, including the database. Only `content://` is accepted, and the refusal says why. **This is the *open-with* half only.** The share sheet (`ACTION_SEND`) does not reach here: Android puts that payload in `EXTRA_TEXT`/`EXTRA_STREAM`, and both `+native-intent.tsx` and `Linking.getInitialURL()` see only `getIntent().getData()` — a native dependency and a manifest entry, flagged in §4.5 rather than stubbed |
| **Reuse something** — a skill, a saved prompt, a project's knowledge | `skills.ts`, `prompts.ts`, `projects.ts`, `memory.ts`, all four UNIQUE-indexed by name | `V` | a duplicate name is not a slow query but an ambiguous `invoke_skill` ([05_Data_Model.md](05_Data_Model.md) §11.2) |
| **Move to a new phone** — back up, reinstall, restore | `backup.ts`, and the deliberate exclusions | `V` | a backup carries settings, providers, skills, prompts and servers and **never** keys or conversations, so "restore" does not mean what a user assumes (R-15) |

Every flow has at least one row in the risk register. That is the check this table exists to perform: a flow with no identified failure mode has not been thought about hard enough. The five rows added for `V` and `C` are the ones to be most suspicious of, because they were written after the code rather than before it, and a failure mode you notice while documenting is a failure mode you already avoided by luck.

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
- [ ] `pnpm gates` green locally and in CI, **and** `pnpm expo export --platform android` (gate 4 — the one the other three cannot be)
- [ ] The new module's import graph is free of `react-native` and `expo-file-system/legacy`, or its testable half was extracted into a sibling that is (§7.1)

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
- [ ] [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` gains an entry, marked **needs a rebuild** if it touches a native module or `app.json`
- [ ] `progress.md` updated: status, gate counts, and any decision that should not be undone
- [ ] Debt discovered along the way filed in §11 with an ID
- [ ] A doc claim that has become *false* is retracted in writing, not quietly edited — see [GUIDELINES.md](GUIDELINES.md) §12. D-18 is what the alternative looks like

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

Gates 1–3, which is what `gates` is:

```bash
pnpm gates
```

Gate 4 — the Android bundle. No script; the output is thrown away, only the exit code matters:

```bash
pnpm expo export --platform android --output-dir .expo-export
```

Coverage totals only, without the per-file table:

```bash
pnpm test --coverage --coverageReporters=text-summary
```

A build. There is no `build:apk` script — the profile is part of the command:

```bash
pnpm build:preview
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
- [ ] **If the work was not a planned sprint at all** (as `V` and `C` were not — §4.5), it still gets a close: a §4-style retrospective block, a debt pass, and a line in this document. Skipping that is how §11 became a sample instead of a register (D-17)

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
| **Gate** | A check that blocks a merge or a release; **five** of them, four automated (§8) |
| **Kind** | One of the 14 `GatewayErrorKind` values |
| **Out-of-order block** | Work delivered outside the phase structure and recorded on §2's chart as a lettered row rather than a sprint: `H` (harness), `V` (v1.1), `C` (Claude parity 1–7 + 10–12) |
| **Phase** | A unit of user-visible value; one to two sprints |
| **Point** | A unit of uncertainty and coordination cost, not time (§6.1) |
| **Pressure** | Context fill measured against *usable* space, not the raw window |
| **Ratchet** | A threshold set just under the current measurement, so it fails on regression and never on progress — how coverage is gated (§7.4) |
| **Sprint** | Two weeks; the unit of commitment |
| **Usable space** | context window − reserved output − reserved thinking |
| **Velocity** | Points completed per sprint; observed at 27 across the planned work, and **not** a measure of throughput any more (§6.4) |

---

## Ownership and maintenance

| | |
|---|---|
| **Owner** | The maintainer (`Suke2004`) |
| **Update at** | Every sprint close (§B.2) — velocity, status, new debt, new risks. **And at every out-of-order close too**, which is the lesson of D-17 |
| **Update immediately when** | A risk materialises · a phase's scope changes · a gate is added or changed · the critical path is re-ordered · CI changes · **work lands that this plan never scheduled** |
| **Do not update for** | Individual task completion within a sprint (that is `progress.md`'s job) |
| **Source of truth for status** | [progress.md](../progress.md) for the planned phases, [progress-v1.1.md](../progress-v1.1.md) for the v1.1 list and the Claude-parity sections. This document is the *plan*; those two are the *state*. When they disagree about what is done, they win — and this document's projections should then be recomputed |
| **Staleness signal** | §6.2 is now a **record of Phases 1–6, not a burn-down** (§6.4), so a past-due row there no longer signals staleness on its own. The signals that do: §1's measured baseline disagrees with a fresh `pnpm gates` run · §8 lists a different number of gates than `ci.yml` enforces · a workstream has shipped with no §4 retrospective block and no §11 debt pass |

Cross-references: schema, indexes and the hazards that seed §11 are in [05_Data_Model.md](05_Data_Model.md); build profiles, the device protocol and rollback are in [07_Deployment.md](07_Deployment.md); product requirements in [PRD.md](../PRD.md); transport contracts in [TRD.md](../TRD.md); layering rules in [ARCHITECTURE.md](../ARCHITECTURE.md); user-facing flows in [USAGE.md](../USAGE.md); the conventions this plan's reviews apply — including §12's retract-in-writing rule — in [GUIDELINES.md](GUIDELINES.md); the known-defect list that is not scheduled debt in [flaws.md](flaws.md); the release-by-release record in [CHANGELOG.md](../CHANGELOG.md).

## Document history

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.9 | 2026-09-02 | Parity Sections 11 + 12 close-out (platform specifics, accessibility) | **Sections 11 and 12 of the Claude-parity checklist shipped, and the checklist is now closed at ten of twelve.** §4.5 `C` reads *Sections 1–7 and 10–12*; §6.4's projection item — which had named 11 and 12 as workable today — records them done, leaving **8 and 9 behind their product decision and nothing else in the queue**. The fact worth carrying is that **Section 11 was a survey, not a build**: portrait lock, edge-to-edge, the Android back handler, the notification channel, the keyboard inset, the `+native-intent` deep-link route and safe-area insets were all already there, and the survey found **three gaps, all of them JavaScript-only** — nothing was announced to a screen reader when a reply landed in the foreground ([src/lib/notify.ts](../src/lib/notify.ts) gains a pure `replyAnnouncement`); `expo-updates` was configured but never called, so a downloaded bundle waited for an unprompted cold start (Settings gains a conditional *Update → Restart to finish updating* row on `useUpdates().isUpdatePending`); and one fixed-height glyph box in [src/components/ui.tsx](../src/components/ui.tsx) could overflow at the largest system font size (`allowFontScaling={false}` on the glyph, not the label). **Four items are flagged rather than stubbed, because each needs a rebuild and therefore cannot reach an installed build over the update channel**: `ACTION_SEND` share-to (Android delivers the payload in `EXTRA_TEXT`/`EXTRA_STREAM`, which neither `Linking.getInitialURL()` nor `+native-intent.tsx` can see — a native dependency and a manifest entry), launcher shortcuts, predictive back, and landscape. Two more are deliberate non-builds with reasons recorded: **no in-app haptics switch** (Android's *Touch feedback* owns it — the same reasoning `notify.ts` already carried for notifications) and **no draft surviving process death** (it would pull AsyncStorage into `src/stores/chat.ts`'s import graph and add a rehydrate-versus-keystroke race). §6 gains two invariants, both earned here: **never put an `accessibilityLiveRegion` on streaming text** — TalkBack restarts from the top of the region on every delta, so a live region over a stream reads the reply from the beginning several times a second — and **never duplicate a control the platform already owns**, with Reduce Motion as the standing exception that is *interpreted, not obeyed* (a progress spinner still turns). §7.3 gains a third unusual-test case: `replyNotice`/`replyAnnouncement` is the only test in the suite whose subject is an **invariant between two functions** rather than either function's output, which is also why `notifyReplyReady` reads `AppState` **once** and dispatches. §1 baseline re-measured: **1,603 tests / 80 suites**; coverage 70.05 / 66.24 / 64.49 / 71.62 against unchanged floors. The device protocol gains section **T**, steps 76–79 ([07_Deployment.md](07_Deployment.md) §7), and **D-20 opens**: everything Section 12 claims — 87 labels, 78 roles, 52 hints, eight modal traps — is unverified by construction, because no gate in this repository can run a screen reader. |
| 1.8 | 2026-09-02 | Parity Section 10 close-out (connected tools) | **Section 10 of the Claude-parity checklist shipped, out of order and on purpose: Sections 8 and 9 are product decisions, so the checklist was worked past them.** §4.5 `C` now reads *Sections 1–7 and 10*, and §6.4's projection item — which had named "10, connected tools" as the next workable section — is updated to record it as done, leaving **8 and 9 behind their product decision** and **11 and 12 workable today**. What shipped is two gaps closed, not a new subsystem: MCP already had per-tool enabling, per-tool approval modes, OAuth 2.1 with PKCE and dynamic registration, per-conversation server selection and a bounded loop behind an approval gate. The first gap was that adding a server required knowing its URL — now [src/mcp/catalog.ts](../src/mcp/catalog.ts) bundles eleven vendor endpoints, ordered no-auth first so the first one anybody taps works without an account, and tapping one **prefills the existing add form** rather than saving anything. The second was that "what tools does this turn have" was spread across four screens — now `summariseTools` answers it once, in the conversation's ⋯ menu and on the new [app/settings/tools.tsx](../app/settings/tools.tsx) screen that the three global built-in switches **moved** to (moved, not copied: a second copy of a global switch is two controls over one piece of state). §7.3 gains two entries of a kind this document had not recorded before: a **tripwire over knowledge the import graph forbids sharing** (`plan.ts` imports `builtins.ts`, so `summariseTools` cannot ask `blockedInPlanMode` what plan mode blocks; the wording is duplicated and the test both modules can import asserts the duplicate still matches), and an explicit note on **what `catalog.test.ts` refuses to test** — that any endpoint still answers, because a suite that goes red during a vendor outage is a suite people learn to ignore. Liveness is device step 72 instead, which says a failure means *the entry is stale, fix the catalog, not the handset*. §1 baseline re-measured: **1,600 tests / 80 suites**; coverage 70.06 / 66.23 / 64.46 / 71.63 against unchanged floors, `src/chat/` at 86.98 / 80.82 and `src/mcp/` at 70.28 / 61.23 in §7.4's table; ~47,800 shipped lines across **163** files, ~64,100 including tests. §8's gate 3 and §12's P-12 re-stated, and the with-coverage figure corrected from ~9 s to ~6–8 s. The device protocol gains section **S**, steps 72–75 ([07_Deployment.md](07_Deployment.md) §7): four steps for the one thing no gate in this repository can reach, *somebody else's server*. **D-17 is open and larger again** at a fifth out-of-order close — though this is the one close that arguably reduced the register, by collapsing four screens of guesswork into one covered function. |
| 1.7 | 2026-09-02 | Parity Section 7 close-out (history drawer) | **Section 7 of the Claude-parity checklist shipped: the history drawer is date-grouped and virtualised.** §4.5 `C` now reads *Sections 1–7*, and the fact recorded there is the mirror image of 1.6's: Section 7 needed **no new dependency and no native change**, so it is the first parity section since the camera that an installed build can receive over the update channel. The drawer now goes through the list screen's own row builder — `src/chat/list.ts` gained `drawerRows`, and §6's invariants gain *never build history rows twice*, because a heading that reads "Older · 34" in one view and "Older · 35" in the other is a bug no test would catch. Two more invariants earned by this section: FlashList recycles by row type, so a new `ListRow` kind that skips `getItemType` gets a cell shaped for the previous row (§5); and **the clock may not be read in a render body** — `react-hooks/purity` rejects `Date.now()` there, *including* inside the render-phase adjustment block that `react-hooks/set-state-in-effect` otherwise pushes you towards, which leaves a permanently-mounted component no legal way to re-read it. The resolution is structural and worth knowing before it is rediscovered: anything needing a fresh *now* becomes a component that **mounts** when the clock should be read (`DrawerHistory`, with `useState(() => Date.now())`). §6.4's projection item re-pointed from Sections 7–12 to **Sections 8–12**, and now says out loud that if the product decision on 8 and 9 is "not yet", the next workable section is **10, connected tools**. §1 baseline re-measured: **1,577 tests / 79 suites**; coverage 69.97 / 66.13 / 64.27 / 71.55 against unchanged floors, with `src/chat/` up to 86.90 / 80.64 in §7.4's per-directory table; ~47,200 shipped lines across 161 files, ~63,600 including tests — **no new file in either count**, which is the shape of a section that reused what was there. §8's gate 3 and §12's P-12 re-stated at 1,577. The device protocol gains section **R**, steps 69–71 ([07_Deployment.md](07_Deployment.md) §7), because the two things this section actually claims — a steady frame rate through hundreds of rows and a horizontal pan that loses its argument with a vertical scroller — are invisible to all four automated gates. **D-17 stays open and is larger again**, this being a fourth out-of-order close with no debt pass; two of the four are now `src/components/` work, the directory its remedy names. One deliberate omission, recorded so it is not read as an oversight: the drawer has **no per-row menu**, because those actions are component-body closures in `app/index.tsx` over that screen's selection, prompt and toast state, and a copy would be a second delete confirmation free to drift from the first. |
| 1.6 | 2026-09-02 | Parity Section 6 close-out (camera) + baseline re-measure | **Section 6 of the Claude-parity checklist shipped: an in-app camera on `expo-camera`.** §4.5 `C` now reads *Sections 1–6*, and the significant fact recorded there is that `expo-camera` is the **first and only new native module across both unplanned workstreams** — which moves the next release from "publish a bundle" to "build an APK", and means no installed build has a camera at all. The Sprint 7 story table gains a note that `expo-image-picker`'s camera path was **deleted** rather than kept beside the viewfinder (the gallery half, the permission copy and the settings deep link are untouched). §6.4's projection item re-pointed from Sections 6–12 to **Sections 7–12**, with the observation that Sections 8 and 9 are on the PRD's non-goals list and need a product decision before an estimate rather than a sizing. §1 baseline re-measured across three runs: **1,573 tests / 79 suites, ~4–6 s warm** and ~9 s with coverage; coverage 69.95 / 66.12 / 64.22 / 71.54 against unchanged floors 66 / 63 / 58 / 68; ~47,100 shipped lines across 161 files, ~63,400 including the 79 test files and two test helpers. **§12 flips P-12 from missed to met and §11 closes D-19**, and the manner of closing is the entry worth reading: nothing was optimised. D-19 blamed `calibration.test.ts` for "about ten of those seconds"; it runs in **0.64 s**, so the original ~11 s was a cold filesystem cache attributed to a suite. A metric quoted from a single run is an anecdote, and §11 is precisely where an anecdote hardens into a debt item nobody re-checks. **D-17 stays open and is now larger**, because this is a third out-of-order close with no debt pass behind it. |
| 1.5 | 2026-09-02 | Phase 5 close-out + reconciliation with two unplanned workstreams | Phase 5 recorded as shipped (MCP: two HTTP transports, an approval gate, a bounded tool loop) and Phase 6 as **partly delivered out of order**. The larger change is that this document now admits **two workstreams landed outside its phase structure entirely** — the v1.1 list and Sections 1–5 of the Claude-parity checklist — and that this is the dominant fact about it. §1 baseline re-measured (**1,551 tests / 78 suites, ~11 s** plain and ~12 s with coverage; coverage 69.84 / 65.94 / 64.05 / 71.42 against floors 66 / 63 / 58 / 68; ~46,600 shipped lines, ~62,400 with tests; `PRAGMA user_version = 8`) with a new *Delivered outside this plan* row; the executive summary's 996-test / five-second figures corrected. §1.1 gains two settled decisions: SQLCipher plus `android:allowBackup=false` with the accepted unrecoverability, and that **there is no in-app "clear all data"**. §2's chart marks Phase 5 complete, Phase 6 `◐`, and adds lettered out-of-order rows `V` and `C` — together larger than Phases 3, 4 and 5 combined. Three new sections: **§4.3** Phase 5 retrospective (planned-vs-shipped, including OAuth 2.1 + PKCE + dynamic registration and MCP prompts/resources arriving unscheduled, "per-server rate and payload limits" shipping as an image-only ceiling with no rate limit, and the one-tap kill switch **not** built as written; then the approval-gate design, the three timeouts, and D-13 closed at [chat.ts:1381](../src/stores/chat.ts:1381)); **§4.4** Phase 6 partly delivered (debug screen and timings shipped, a11y substantially shipped across 31 files with a TalkBack order audit still owed, performance panel and scratch row not built); **§4.5** the two unplanned workstreams in full. §6.2/§6.3 rows closed and a new **§6.4** retires the estimate model — *there is no slack left in the plan because there is almost no plan left* — recommending future projection from the checklist rather than from sprints. §7.1 gains the `testEnvironment: 'node'` import-graph constraint that produces every `.ts`↔`.tsx` sibling pair. §7.3 corrected: **both mandated security tests exist and pass** ([redact.test.ts](../src/lib/redact.test.ts), [export.test.ts](../src/chat/export.test.ts)) — the prior "currently unwritten, blocks the 1.0 gate" line was false. §7.4 rewritten around the ratchet rule and the **real** coverage denominator: `collectCoverageFrom` excludes by *extension*, not directory, so `src/components/` is counted and reports 0% while `src/components/markdown` reports 94.88%. §8 is now **five gates**, adding the `expo export` bundle gate that the other three cannot substitute for, with the Node 24 and no-`--`-separator CI details in §9. §10 corrects R-08 (`react-native-reanimated@4.5.1`, `react-native-worklets@0.10.1`, `expo-updates@57.0.19`), rewrites R-11 with the real bounds and the missing kill switch, downgrades **R-12 to untested** (no store defines `migrate`), and opens **R-15** (an unrecoverable database, accepted, re-opening with sync) and **R-16** (fork/regenerate interruption). §11 closes D-01 and D-13 and opens **D-16** (`forkConversation()` is not transactioned), **D-17** (neither unplanned workstream got a debt pass, so §11 is a *sample*, not a register), **D-18** (no clear-all-data; §13 described a feature that does not exist) and **D-19** (~11 s against P-12's <10 s). §12 records **P-12 as currently missed**, naming `calibration.test.ts` at 10 s of the 11. §13's Secrets block gains the SQLCipher raw key and the MCP OAuth token; its Data block is reframed as a specification per GUIDELINES §12. §15's exit gate re-lettered to four automated gates plus a live smoke test, which **has not been passed**. §16 states plainly that nine of seventeen metrics are unmeasured and that the ≥3:1 chart contrast is a figure in a source comment, not an assertion any gate re-checks. §17 gains five flows (talk to it · ask it for a document · open a file from another app · reuse something · move to a new phone). Appendix A.3 rewritten around `pnpm gates` and notes there is **no `build:apk` script**; B.2 gains a close for work that was never a planned sprint. |
| 1.4 | 2026-08-30 | Phase 4 close-out | Phase 4 recorded as shipped: Sprint 9 (context pressure and exclusions) and Sprint 10 (rolling summary) both delivered, with one story deferred. §1 baseline re-measured (996 tests / 34 suites, ~5 s; coverage 64.05 / 63.10 / 62.40 / 51.34 against the same 64 / 63 / 62 / 51 floor) and the executive summary, §7.1 and §8 gate 3 corrected to match. §2 timeline marks S9 and S10 complete and makes Phase 5 the next block. New **§4.2 Phase 4 retrospective**: every item in the sprint was a defect rather than a missing feature, because §4.1 had already built the denominator, the orphan drop and exclusion persistence — an unbounded rolling summary charged as input on every remaining turn, invisible summarisation spend, a `summary` write that clobbered concurrent config edits, an estimate that could reach `messages.usage`, three silent failure paths, and a `pause_turn` presented as a finished answer. Two deviations from the sprint wording are recorded rather than substituted silently: the over-window confirmation fires at `over` and only for `warn`, and "what was dropped or summarised" ships as a dismissable sentence rather than an expandable range, since the elided turns are still in the transcript. R-04 downgraded to *partly* mitigated: the ±15% estimator corpus needs the gateway's own reported counts, so it moves with **D-11** to the first live session. |
| 1.3 | 2026-08-30 | Phase 3 close-out | Phase 3 recorded as shipped: Sprint 7 (images) and Sprint 8 (documents) both delivered. §1 baseline re-measured (976 tests / 32 suites, ~4 s; coverage 64.14 / 63.10 / 62.34 / 51.30 against a ratcheted 64 / 63 / 62 / 51 floor; ~34,100 lines) and the executive summary's 904-test figure corrected; §7.1 and §8 gate 3 likewise. §2 timeline marks S7 and S8 complete and makes Phase 4 the next block; the "phases remaining" row now says plainly that the PRD's other Phase 3 items (speech-to-text, TTS, image generation, share target) were never scheduled here and are unbuilt. New **Phase 3 retrospective** after Sprint 8: the plan under-estimated how much of the pipeline already existed and over-estimated the picker — the real work was the memory ceiling (resize before base64, sequential ingest, temp-file deletion) and the refusal wording. Two device acceptance criteria are recorded as unverified rather than ticked, with the decisions they protect asserted in tests instead. One deliberate deviation from the sprint wording: capability gating **shows and disables with a reason** rather than hiding the affordance, because `vision`/`documents` are hand-edited flags and a hidden button is indistinguishable from a broken one. §11 opens **D-14** (`attach.ts`, the impure half, has no automated coverage, so the P-10 memory ceiling is unmeasured) and **D-15** (the flat 2,500-token image estimate has never been checked against a reported `usage`). Neither blocks Phase 4. |
| 1.2 | 2026-08-30 | Harness sprint close-out | Version and status bumped: the harness budgeting layer landed **out of order**, ahead of Phase 3. §1 baseline re-measured (904 tests / 30 suites, ~5 s plain and ~12 s with coverage; coverage 64.54 / 63.32 / 62.21 / 50.81 against a ratcheted 62 / 61 / 60 / 48 floor; ~32,100 lines) and the executive summary's 817-test figure corrected, with a new paragraph on why the layer was pulled forward. §2 timeline gains an `H` row marked out of order. New **§4.1** records the sprint in full: a defect/cost/fix table for the four modules (`budget.ts` double-counted the thinking budget into `max_tokens`; `trim.ts` replaced a hard drop with a four-rung ladder; `tools.ts` sent every definition every turn; `cache.ts` never marked a cacheable prefix), the ladder note, six consequences for later sprints — Sprint 9's first story is largely done, `drop_oldest` shrinks to the last rung, Sprints 11/12 inherit `selectTools`, the fourth `cache_control` breakpoint is reserved for the tool loop, `promptCache` needs surfacing in S13, and the gateway-caching risk — and a delivered list. §7.3 gains four example cases (BUDGET / TRIM / TOOLS / CACHE); §7.1 and §8 gate 3 corrected to 904 tests / ~5 s. §11 opens **D-12** (prompt caching unverified against the gateway — a silent 1.25× surcharge if `cache_control` is accepted but not honoured; settled by one two-turn conversation) and **D-13** (`selectTools` has no call site until S11). |
| 1.1 | 2026-08-30 | Phase 2 close-out | Phase 2 recorded as shipped. §1 baseline re-measured (817 tests / 26 suites, ~5 s; coverage 62.66 / 61.33 / 60.78 / 47.68 against a 61 / 60 / 59 / 46 floor; ~30,300 lines across `src` + `app`) and the executive summary's stale 658-test figure corrected. §2 timeline marks S5 and S6 complete. §4 Sprints 5 and 6 gain an outcome column, including the two acceptance criteria that shipped as code but remain **device-unverified** (the 55 fps scroll target and the 400 ms list-open target) — recorded rather than ticked, because no physical device exists in this environment. New Phase 2 retrospective after Sprint 6 in the §9.4 style: export ships through `expo-clipboard` and React Native `Share` rather than a written file (`expo-file-system` / `expo-sharing` belong to Phase 3), `SHARE_BYTE_LIMIT` against the Binder parcel ceiling, double redaction, no attachment bytes in an export, the duplicate Phase 6 export line, and what a bulk delete deliberately spares. §11 records D-01 … D-08 as closed with the evidence for each, and D-09 … D-11 as open by design. |
| 1.0 | 2026-08-29 | Architecture review | Initial issue. Baseline as of Phase 1 complete; 13 sprints across six phases with per-story points and acceptance criteria; Phase 1 recorded retrospectively for velocity (27 pts/sprint) and ordering provenance; critical path (transport → retry → classification → failover → tools) with the reasoning for each edge; 80/15/5 test pyramid with the architectural rule that produces it and an honest account of what it does not cover; concrete test cases including the two mandated redaction tests; four quality gates; greenfield GitHub Actions CI and APK workflows; 14-entry risk register with R-07 (Keystore) expanded; 11-entry debt register seeded from the data-model hazards, with D-01…D-08 scheduled into Sprint 5; twelve performance targets and the FlashList strategy behind the 1,000-message/2 s requirement; security checklist including the reasoned decision *not* to pin certificates; on-device observability model; alpha→beta→release rollout; per-phase success metrics; user-flow-to-feature mapping cross-checked against the risk register; and a five-block definition of done. |

