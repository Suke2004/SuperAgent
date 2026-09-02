# AgentRouter Mobile — Consolidated UX Test Report

> **Status: historical record, kept unedited below. Read this box first.**
>
> This report is a snapshot of a **Phase 1** app and is deliberately **not** being
> rewritten to match the current one. It is dated 2026-09-01 and describes
> "AgentRouter Mobile"; the app is now **SuperAgent** (one constant, `src/lib/app.ts`
> — see [progress.md](../../progress.md)). Three things have changed since:
>
> 1. **The 28 findings have been worked through.** Spot-checked against source on
>    2026-09-02, every finding sampled is closed: UX-01 is `pickProbeModel`
>    ([openai.ts:276](src/transports/openai.ts:276)) with an explicit
>    "switch the profile to a listed model" message; UX-02 is `focusRingStyle`
>    ([ui.tsx:113](src/components/ui.tsx:113)); UX-03 and UX-13 are
>    `accessibilityLabel` on `Field` and `SwitchRow`
>    ([ui.tsx:1028](src/components/ui.tsx:1028), [ui.tsx:767](src/components/ui.tsx:767));
>    UX-06 passes the filters through (`searchMessages(trimmed, filters)`,
>    [index.tsx:379](app/index.tsx:379)); UX-07 has an archive UI; UX-08 and UX-26 are
>    `MIN_TARGET = 48` plus `hitSlop` ([ui.tsx:66](src/components/ui.tsx:66)) rather
>    than inflated designs; UX-10 is [OfflineBanner.tsx](src/components/OfflineBanner.tsx);
>    UX-18 keeps every usage field optional so unknown is not zero
>    ([usage.ts](src/chat/usage.ts)); UX-20 is `app/settings/usage.tsx`; UX-22 and
>    UX-23 both left comments at the fix site naming this report's symptom
>    ([chat.ts:1721](src/stores/chat.ts:1721), [index.tsx:1047](app/index.tsx:1047));
>    UX-28 is `topK` on both transports. **This box is not a per-ticket audit** — it is
>    a sample. Treat any individual claim in the body below as describing the app as it
>    was, not as it is.
> 2. **The scope line is now much narrower than the app.** Multimodal, Skills, MCP and
>    the offline queue were out of scope here and all four have since shipped, as have
>    v1.1 and Sections 1–7 plus 10–12 of a Claude-parity checklist (inline visuals, file
>    reading and generation, voice mode, an in-app camera, a grouped and virtualised
>    history drawer, a bundled directory of tool servers with a one-line answer to
>    what a turn can do, a platform pass and an accessibility pass). None of that surface
>    was ever tested
>    by these personas, so **the absence of a finding below says nothing about it.**
>    The accessibility pass matters most to this file, because
>    [Morgan](05-morgan-accessibility.md) is the report it overlaps: it took the app to 87
>    labels, 78 roles, 52 hints, 25 state props and `accessibilityViewIsModal` on all eight
>    modals, and added an end-of-turn screen-reader announcement that did not exist when
>    Morgan ran. It also inherits Morgan's own closing caveat — **TalkBack itself is still
>    unverified**, so the pass is a set of properties in the tree, not a measured
>    experience ([flaws.md](../flaws.md) §3).
> 3. **The one honest gap this report opened is still open.** Its measurements came
>    from a live gateway with real credentials; the current record has no working key
>    ([progress.md](../../progress.md) "Known gaps"), so the timing numbers below —
>    2.6–3.1 s to first token, 77–349 ms search, 7.6 s to failure — are the **only**
>    live-gateway measurements this repository has. That is why the file is kept.
>
> Current status lives in [progress.md](../../progress.md),
> [progress-v1.1.md](../../progress-v1.1.md) and
> [docs/flaws.md](../flaws.md) — not here.

**Scope.** Five personas, 21 scenarios, one live gateway. Phase 1 functionality only; multimodal, Skills, MCP and the offline queue were out of scope and were not tested.

**Method.** The app was driven end to end against the supplied OpenAI-compatible gateway (`claude-opus-5`) with real credentials — real streaming completions, real model discovery, real mid-stream connection loss, real offline relaunch. Timings are measured, contrast ratios are computed from the palette source, touch targets are measured in dp, and tap counts are counted. Where a finding could only be established from source, or could not be verified off a physical Android device, it says so.

**Reports.** [Maya — New User](01-maya-new-user.md) · [Alex — Power User](02-alex-power-user.md) · [Jordan — Researcher](03-jordan-researcher.md) · [Casey — Mobile-First](04-casey-mobile-first.md) · [Morgan — Accessibility](05-morgan-accessibility.md)

---

## Executive Summary

AgentRouter Mobile is a better-engineered application than its current defect list suggests, and the two facts are related. The transports know the difference between an Anthropic thinking budget and an OpenAI reasoning effort and hide the wrong control. The retry policy refuses to fail over once bytes have arrived, because that would duplicate the answer and the billing. Search says whether each hit came from the index or a scan. Disabled buttons explain themselves in a visible sentence. A dropped connection keeps the 450 words that already arrived. Almost everything hard is done well.

What is missing is the last inch: the app is generous with capability and stingy about telling you what it just did. **28 issues** were confirmed, and a striking number of them are not absent features but finished features that never reached the screen — archive is fully implemented in SQLite and unreachable from the UI; the sampling validator is correct and runs one moment too late; the tag filter is applied to one of the two search passes; the token counts arrive from the gateway and are rendered as zeros when they are merely unknown.

**Three findings are Critical.**

The first is the worst first-run experience I can construct: the connection test probes a hardcoded Anthropic model rather than the model the user configured, so a working gateway is reported as `403 Forbidden`, and a successful discovery of four models never updates the profile's default. A new user's setup appears to fail and their first message is addressed to a model the gateway does not serve. Both symptoms come from hardcoded model ids in an app whose premise is gateway neutrality. The fix is small.

The other two are accessibility, and together they close the app to two user groups. There is **no focus indicator anywhere** — 26 of 26 sampled focus stops computed `outline: none` with no substitute — so keyboard and switch-access users navigate blind, on screens whose action lists end in *Delete conversation*. And **no text input has an accessible name**, because the shared `Field` component renders its label as a visual sibling only; a TalkBack user reaching provider setup finds three unnamed edit boxes, one of which wants a URL and one a secret. Setup is not merely awkward for them, it is unachievable.

Below that sit eleven High issues, of which the most consequential pattern is **failure debris**: every failed turn permanently appends an empty assistant bubble with the error text baked into it, *Dismiss* clears only the banner, and the stub then becomes part of the history sent back to the model — and it corrupts Home's row previews on the way. All five personas hit this independently, from four different starting points. It is one lifecycle bug with the widest blast radius in the report.

The one genuinely good piece of news for scheduling: **eight of the 28 issues live in three shared components.** `Badge`, `Button` and `Segmented` cause every undersized touch target and the entire 11pt type problem; `Field` causes both the missing input names and the missing inline validation; `SwitchRow` causes the unlabelled switches. The app's consistency, which is a design strength, is also the reason a handful of small fixes move the accessibility and touch-target numbers from failing to passing across every screen at once.

Total remediation for all 28 issues is estimated at **~22 engineering days**, of which the three Criticals and the six cheapest Highs — roughly **5 days** — remove every blocker.

---

## Issues Ranked by Severity

### Critical (3)

| ID | Issue | Persona | Source |
|---|---|---|---|
| UX-01 | Connection test probes a hardcoded model, so a working gateway reports `403`; discovery never updates `defaultModel` | Maya | [openai.ts:772](src/transports/openai.ts:772), [models.ts:142](src/stores/models.ts:142) |
| UX-02 | No focus indicator anywhere — 26/26 focus stops computed `outline: none`, no `box-shadow` substitute | Morgan | [ui.tsx](src/components/ui.tsx) |
| UX-03 | No text input has an accessible name; TalkBack users cannot complete provider setup | Morgan | [ui.tsx:560](src/components/ui.tsx:560) |

### High (11)

| ID | Issue | Persona |
|---|---|---|
| UX-04 | Failed turns append a permanent empty bubble with the error baked in; *Dismiss* leaves it | Maya, Alex, Casey |
| UX-05 | Out-of-range sampling values save silently, fail 7s later, with no route back to the field | Alex |
| UX-06 | Active tag filter is ignored by the message-search pass, returning out-of-filter hits | Jordan |
| UX-07 | Archive/restore fully built in SQLite, entirely absent from the UI; delete has no undo | Jordan |
| UX-08 | Touch targets below 48dp app-wide: chips 19dp, segments 34dp, buttons 42dp | Casey |
| UX-09 | `textFaint` fails WCAG AA on every light surface (2.75–3.20) and dark `surfaceAlt` (3.44) | Morgan |
| UX-10 | No offline or gateway-unreachable indicator anywhere; banner claims reachable while down | Maya, Casey, Morgan |
| UX-11 | Message actions have no tap affordance and no keyboard activation — six features unreachable | Casey, Morgan |
| UX-12 | Sheets do not trap focus; Escape does not dismiss | Morgan |
| UX-13 | Thinking switch, composer token gauge and "All" chip lack accessible names or state | Morgan |
| UX-14 | Deleting a provider silently re-routes its conversations to a different gateway | Morgan |

### Medium (13)

| ID | Issue | Persona |
|---|---|---|
| UX-15 | Model name visible only in the empty state; invisible once messages exist | Maya |
| UX-16 | 2.6–3.1s to first token against a <500ms target, with a static `Streaming · 0s` label | Maya |
| UX-17 | Retry backoff is labelled "Streaming" with a running counter; retries are invisible | Casey |
| UX-18 | Unknown token counts are rendered as literal zeros (`0 thinking`, `0 in · 0 out`) | Alex, Casey |
| UX-19 | Composer token estimate reads 11 where the gateway bills ~7,200 | Alex |
| UX-20 | Cost is hidden until per-model pricing is entered by hand, with no hint it exists | Alex |
| UX-21 | Debug log rows are expandable with no affordance, no role and no focus stop | Alex, Morgan |
| UX-22 | Row shows "No messages yet" alongside "6 messages" | Jordan |
| UX-23 | "Nothing matched" renders for a measured 247ms before hits arrive | Jordan |
| UX-24 | Provider setup takes 8 taps against a 4–5 target | Maya |
| UX-25 | Providers screen lists every profile three times, in three sections | Maya |
| UX-26 | 11pt type carries meaning (badges, subtitles, token gauge, disabled reasons) | Morgan |
| UX-27 | Chat screen has no keyboard-dismiss gesture and risks double-adjust (unverified on device) | Casey |

### Low (1)

| ID | Issue | Persona |
|---|---|---|
| UX-28 | No Top K control on either transport, and no note explaining the omission | Alex |

> **On the issue count.** The brief anticipated 15–25 issues with 2–3 Critical. The Critical count landed at 3; the total came in at 28. I have not compressed further, because each ticket has a distinct repair. They do collapse into roughly **18 units of work** — UX-08 and UX-26 are one change to three primitives, UX-03 and UX-05 are one change to `Field`, UX-16/17/18 are one "distinguish unknown from zero and name the phase" rule, and UX-04 largely subsumes UX-22.

---

## Issues Grouped by Theme

### Setup & Onboarding — UX-01, UX-14, UX-24, UX-25
The one area where a defect stops a user completely rather than annoying them. The gateway works, the key works, discovery works, and the screen that exists to confirm all three reports failure — because the probe model and the default model are both hardcoded Anthropic ids in an app built for arbitrary gateways. Around that, setup costs 8 taps instead of 4–5 and the Providers screen renders each profile three times in three sections with three purposes. UX-14 belongs here too: profile *deletion* is the reverse of setup, and it currently re-points conversations at whatever gateway happens to be active, silently.

### Chat & Messaging — UX-04, UX-11, UX-15, UX-16, UX-17, UX-18, UX-22
Streaming, editing, forking and partial-response preservation all work. What is missing is truthful narration of state. The waiting phase, the retry phase and the streaming phase are all called "Streaming". Token counts that were never reported are printed as `0`. The model you are talking to is named only on the screen where there is nothing to read. And a failed turn writes itself permanently into the transcript, which then corrupts the Home preview for that conversation. Six of the app's best features — Copy, both Edit variants, Regenerate, Fork, Delete — are behind an unadvertised long-press.

### Settings & Controls — UX-05, UX-19, UX-20, UX-21, UX-28
Per-conversation sampling with transport-aware controls is the right architecture, and the validator that guards it is correct. It simply runs at request-build time rather than on edit, so an impossible temperature is accepted silently and surfaces as a network-shaped failure seven seconds later. The transparency surfaces are similarly complete-but-hidden: the Debug log holds full request and response bodies behind a tap nothing advertises, cost is computed but never shown until prices are typed in by hand, and the composer's token gauge — the only pre-spend signal — is off by roughly 600× on this gateway.

### Search & Organization — UX-06, UX-07, UX-22, UX-23
The strongest and the weakest area in the same theme. Search returns in 77–349ms including offline, snippets are properly windowed, and every result declares whether it came from the index or a scan. Then the tag filter is passed to the title pass and not the message pass, so filtered search returns results the filter just excluded while the chip stays highlighted; the empty state renders 247ms before the hits it is denying; and archive — schema, query and mutation all finished — has no screen, leaving permanent deletion as the only way to shorten the list.

### Mobile Performance — UX-08, UX-10, UX-27
Taps register first time and scrolling behaves, including during a stream. Every interactive target is nonetheless under Android's 48dp minimum, worst at 19dp for the tag chip row — a horizontal scroller of small chips being the hardest thing to hit one-handed. The app also survives losing signal gracefully and then never mentions that it has: no indicator on Home, in the header or in the composer, so the user discovers it by waiting 7.6 seconds for a failure. Keyboard handling on the chat screen (no dismiss gesture, a plausible double-adjust between `KeyboardAvoidingView` and edge-to-edge `resize`) needs a device to confirm.

### Accessibility — UX-02, UX-03, UX-09, UX-11, UX-12, UX-13, UX-26
Foundations are unusually strong: three deliberate surface levels, a palette where six of seven text tones clear 4.5:1 in both themes, coherent tab order with no traps, errors expressed as sentences rather than colour, decorative avatars correctly hidden, and a thinking toggle that announces its own word count. On top of that foundation, three shared components withhold the essentials — no focus ring anywhere, no accessible name on any input, no label on any switch — and one colour (`textFaint`, used for the entire explanatory layer) fails contrast on every surface it appears on.

---

## Cross-Persona Patterns

**1. Finished logic that never reached a screen.** This is the defining shape of the report. `archived` has a column, a `where` clause and an update path, and no button (UX-07). The sampling validator is written and correct, and runs after the user has already sent (UX-05). `searchMessages` supports scoping, and the caller omits the argument (UX-06). Pricing renders a formatted cost, and nothing populates prices (UX-20). Five of the eleven High issues are of this kind, which is why the remediation estimate is as low as it is — most of the work is already paid for.

**2. Unknown is rendered as zero.** `0 thinking` under a visible thinking block. `0 in · 0 out` after 450 words arrived. `11 / 200k` where the gateway will bill 7,200. A missing number and a zero mean opposite things to a user watching their spend, and the app currently prints the same glyph for both (UX-18, UX-19, UX-20). A single "unknown vs zero" convention — the app already has one, in the `guessed` and `unlisted` badges — would fix all of them consistently.

**3. Failures are durable, useful state is invisible.** Error text is written into the SQLite transcript and survives dismissal, reload and forking (UX-04). Meanwhile the model you are using (UX-15), the fact that you are offline (UX-10), the retry in progress (UX-17) and the deleted provider you are now talking to (UX-14) are shown nowhere. The app's persistence and its visibility are inverted: it remembers what should be transient and hides what should be persistent.

**4. Three components carry eight defects.** `Badge`, `Button` and `Segmented` produce every undersized touch target *and*, via `fontSize.xs`, the entire sub-12pt type problem (UX-08, UX-26). `Field` produces both the missing input names and the missing inline validation (UX-03, UX-05). `SwitchRow` produces the unlabelled switches (UX-13). And the absence of any focus styling in the primitive layer produces UX-02 on every screen simultaneously. Consistency cuts both ways, and here it cuts favourably: the same discipline that spread the defects will spread the fixes.

**5. Hardcoded Anthropic ids in a gateway-neutral app.** `pickProbeModel`'s preferred list, the seeded `defaultModel`, and the fallback chain that ends at `seedProfiles()[0]` all assume Anthropic's current model names. Every one of them misfires on a third-party gateway, which is the app's actual use case (UX-01, UX-14).

**6. The explanatory layer is the least legible layer.** What makes this app pleasant to learn is its subtitles: "Everything after this message is deleted, then it is sent again", "Paste an API key first", "Gateways sometimes serve ids they do not list". Nearly all of that copy renders at 11pt in `textFaint`, i.e. the smallest size at the worst contrast in the app (2.75–3.20:1 in light mode). The single best thing about the interface is rendered in its least readable style (UX-09, UX-26).

**7. Long-press-only is both a discoverability and an access failure.** The same missing `onPress` hides six features from ~60% of sighted touch users and removes them entirely for keyboard and switch-access users (UX-11). Casey and Morgan arrived at it from opposite directions and it is one line of code.

**8. Every persona hit UX-04.** Maya via a cold offline send, Alex via an invalid temperature, Casey via a mid-stream kill, Jordan via the corrupted Home preview it leaves behind. Four independent routes into one lifecycle bug is the strongest signal in the dataset about what to fix first.

---

## Top 10 Fixes

Ranked by user-visible value per engineering hour, not by severity alone.

| # | Fix | Resolves | Effort | Why here |
|---|---|---|---|---|
| 1 | Probe the **configured** model, falling back to `discovered[0]`; set `defaultModel` from discovery when the current one is not in the set, and say so in the test output | UX-01 | 0.5d | Turns the worst first-run experience in the app into the best one. Two functions. |
| 2 | Add `accessibilityLabel={label}`, `accessibilityHint={hint}` and `accessibilityInvalid` to the `TextInput` inside `Field` | UX-03 | 0.25d | Unblocks setup for screen-reader users. Four lines, every form in the app. |
| 3 | `minHeight: 48` on `Button` and `Segmented`; vertical `hitSlop` on `Badge` chips; `⋯` hitSlop 12 → 17 | UX-08 | 0.5d | Brings 100% of targets to the platform minimum without a single layout change. |
| 4 | Render a focus ring in the shared primitives (`Button`, `Segmented`, `Row`, `Badge`, `Field`, message bubble) | UX-02 | 1d | The one change that makes keyboard use possible at all, and makes every other keyboard defect diagnosable. |
| 5 | Pass `tag` into `searchMessages` and filter hits to the tagged conversation set | UX-06 | 0.25d | One argument. Stops the two organisational features from contradicting each other. |
| 6 | Stop persisting contentless failed turns: keep the attempt in the store for retry, drop it from the transcript on dismiss; move error text out of the message body into the banner; derive Home previews from the last message *with text* | UX-04, UX-22 | 1.5d | The bug all five personas hit, by four different routes. |
| 7 | Darken light `textFaint` to ~`#6b7280`, lighten dark to ~`#8b93a1`, raise disabled opacity 0.45 → 0.6, `fontSize.xs` 11 → 12 | UX-09, UX-26 | 0.5d | Moves the palette from failing to passing AA. Pure token change; re-measure after. |
| 8 | Wire `archive`/`unarchive` into `useChat`, add *Archive* to the row menu and an `Archived` chip to the existing filter row; make delete archive-first with an *Undo* snackbar | UX-07 | 2.5d | Highest value-to-remaining-work ratio in the app: schema, query and mutation are done. |
| 9 | Run the existing validator on change in *Model controls*, surface errors through `Field`'s `error` prop, show ranges in placeholders, and add *Edit request* to the failure banner | UX-05 | 1d | Composes with fix 2 — same component, ship together. |
| 10 | Name the phases (`connecting` / `retrying (2 of 3)` / `streaming`), tint the gateway banner with `· unreachable` on network failure, and print `not reported` instead of `0` for absent counts | UX-10, UX-16, UX-17, UX-18 | 1.5d | Four issues, one principle: say what is actually happening. |

Fixes 1–5 and 7 total **3 days** and clear all three Criticals plus two Highs.

---

## Effort Estimate

| Band | Issues | Estimate |
|---|---|---|
| Critical | 3 | 1.75d |
| High | 11 | 10.25d |
| Medium | 13 | 7d |
| Low | 1 | 0.5d |
| Device verification (TalkBack, FPS, keyboard behaviour on physical Android) | — | 2d |
| **Total** | **28** | **~21.5 engineering days** |

Suggested phasing for one engineer:

- **Sprint 1 — 5 days.** Top 10 fixes 1–5, 7, 9. Clears every Critical, three Highs and the whole touch-target and contrast surface. This is the release that changes the app's reception.
- **Sprint 2 — 6 days.** Failed-turn lifecycle (fix 6), archive and undo (fix 8), status and offline truthfulness (fix 10), keyboard activation for message actions (UX-11), focus trap and Escape (UX-12), deleted-provider guard (UX-14), switch and gauge labels (UX-13).
- **Sprint 3 — 6 days.** Remaining Mediums: token-estimate calibration, default pricing table, Debug log affordances, search empty-state gating, setup tap reduction, Providers screen consolidation, model-name in header, Top K.
- **Sprint 4 — 2 days.** On-device verification: TalkBack pass, Accessibility Scanner, FPS during a 1,000-word streamed reply with code and math blocks, and keyboard behaviour with a tall IME.

With two engineers the accessibility track (fixes 2, 4, 7, UX-11, UX-12, UX-13, UX-26) runs parallel to the chat/data track (fixes 1, 5, 6, 8, 10), compressing to about **two and a half weeks**.

---

## Success Metrics

Each metric is measurable with the harness used for this test, so the same pass can be re-run as a regression check.

**Setup**
- Taps from Home to a verified working provider: **≤5** (currently 8).
- Connection-test false-failure rate on a gateway that serves its own discovered models: **0%** (currently 100%).
- Conversations created with a model the gateway does not serve: **0%** (currently 100% on a custom gateway).

**Chat reliability**
- Contentless assistant messages persisted after a failure: **0** (currently 1 per failure, permanently).
- Failed attempts removable from the transcript in ≤1 tap: **100%** (currently 0%).
- Conversation rows whose preview contradicts their message count: **0** (currently any conversation ending in a failed turn).
- Status label matching actual transport phase: **100%** (currently "Streaming" covers connecting, retrying and streaming).

**Numbers the user is asked to trust**
- Token-count segments printed as `0` when the value is unknown: **0**.
- Composer estimate within **±25%** of billed `prompt_tokens` after one calibrated turn (currently off by ~600×).
- Turns showing a cost figure out of the box: **≥90%** for well-known model families (currently 0%).

**Search & organisation**
- Filtered-search results outside the active filter: **0** (currently non-zero whenever both are used).
- Time showing "Nothing matched" before both passes resolve: **0ms** (currently 247ms).
- Search latency: **<1s** — already met at 77–349ms, including offline. Hold it.
- Archive → view → restore → permanent delete round-trip completable: **yes** (currently impossible).
- Deletions reversible within 5 seconds: **100%** (currently 0%).

**Mobile**
- Interactive targets with ≥48dp effective touch area: **100%** (currently 0%).
- Median FPS while streaming a 1,000-word reply containing a code block and a math block, on a mid-range device, release build: **≥58** (not yet measured).
- Keyboard-dismiss gesture available on the chat screen: **yes** (currently no).

**Accessibility**
- Focus stops with a visible indicator: **100%** (currently 0/26 sampled).
- Text inputs with an accessible name: **100%** (currently 0%).
- Interactive controls with an accessible name and correct state: **100%** (currently missing on switches, the token gauge and the "All" chip).
- Palette text/surface pairs below 4.5:1: **0** (currently 7 — `textFaint` on three surfaces in light, one in dark, plus disabled labels in both).
- Text conveying information below 12pt: **0** (currently all badges, subtitles, gauges and disabled reasons).
- Features reachable only by long-press: **0** (currently 6).
- Android Accessibility Scanner findings on Home, chat and Settings: **0**.

---

## Testing Notes and Limitations

Recorded so the report can be judged fairly, and so a follow-up pass knows what still needs a device.

**Verified against the live gateway:** provider setup and connection test, model discovery (4 models), streaming completions with thinking, multi-turn conversations, message editing, regeneration and forking, tagging, tag filtering, search (title and message passes, online and offline), mid-stream connection loss, cold sends while offline, retry-and-backoff timing, offline cold launch, and the model, sampling and reasoning controls.

**Reviewed in source, not exercised:** all destructive confirmations — delete conversation, delete message, remove API key, delete profile — because they route through `Alert.alert`, which is a no-op in the web build used as the harness. They are reported nowhere in this document as working or broken.

**Not measurable in this harness, deferred to a device:** frame rate during streaming (FlashList v2 on web absolutely-positions recycled rows, so any DOM-derived FPS figure would describe the harness); TalkBack announcement quality, ordering and interruption behaviour; and the keyboard-avoidance behaviour in UX-27.

**Excluded as harness artifacts, not product defects:** the absence of FTS5 in the web SQLite build (the app degraded to `LIKE`, logged it, and labelled every result `scan` — correct behaviour, and a positive finding); missing SPA fallback on the static file server producing 404s on route reload; and an early wave of "could not reach the gateway" failures traced to a duplicate `Access-Control-Allow-Origin` header in the test proxy, which was fixed before any network finding in this report was recorded.

**Credentials:** the supplied gateway key reached only the app's own storage, request headers to the user's own gateway, and two throwaway `curl` verifications. No credential material was written into the repository, and the app itself redacts the key in its debug log.

