# Agent 2 — ALEX, The Power User

> **Historical record — see [the status box on the consolidated report](00-consolidated-report.md)
> before trusting anything below.** Dated 2026-09-01, against a Phase 1 app then called
> AgentRouter Mobile; it is now SuperAgent. Alex's own findings have since been
> addressed: `topK` exists on both transports, cost has a screen
> (`app/settings/usage.tsx`), and unknown token counts are optional fields rather than
> printed zeros ([usage.ts](src/chat/usage.ts)). The 600×-off composer estimate is the
> one that grew a mechanism rather than a fix — a persisted calibration store that
> corrects the character-ratio estimate from real reported usage, and deliberately does
> *not* correct the flat per-image figure. Kept unedited because the raw request bodies
> and billed-token comparisons here came from a live gateway.

**Persona.** Uses three gateways, knows what `top_p` does, and chose this app specifically because it exposes the controls the official clients hide. Will read a raw request body for fun. Expects to be trusted with dangerous settings and warned before they cost money.

**Session.** Same environment as Maya: real gateway, OpenAI-compatible transport, `claude-opus-5`, existing conversations with real replies to edit and fork.

**Scenarios run.** 2.1 Sampling Parameters · 2.2 Extended Thinking · 2.3 Advanced Edits · 2.4 Request Transparency.

---

## 2.1 Sampling Parameters

Sampling lives behind `⋯` → *Model controls*, subtitled "Sampling and reasoning for the next message" — **3 taps** from the conversation, which is right for a control this sharp. The sheet holds *Max output tokens*, *Temperature*, *Top P* (OpenAI transports only), a *Reasoning / thinking* switch and, when it is on, an effort segmented control. All numeric fields are monospaced and use the correct keyboard (`number-pad`, `decimal-pad`).

The design decision I most agree with: **sampling is per conversation, not global.** Alex's "summarise this politely" chat and his "brainstorm wildly" chat need different temperatures, and in this app they can have them without a settings round-trip. The sheet is explicit that changes apply to the next message only.

Two problems: one is the worst non-crash bug I found, one is a missing control.

### ALEX-01 · Out-of-range sampling values save silently and fail seven seconds later, with no route back to the field

- **Severity:** High
- **Frequency:** Always
- **Impact:** The validation logic exists and is correct — [validate.ts](src/transports/validate.ts) and `src/chat/request.ts` both know that temperature must be 0–2 and `top_p` must be in (0, 1] — but it runs at *request-build* time, not at edit time. So Alex types Temperature `5` and Top P `3.5`, the sheet accepts both without a murmur, closes, and looks saved. The failure arrives only after he has composed and sent a message: a rejected request, a permanent dead assistant bubble, the error printed twice, and two buttons — *Try again* and *Dismiss* — neither of which goes back to the fields that caused it. *Try again* re-sends the same invalid request. For a user whose entire reason for choosing this app is fine-grained parameter control, the parameter editor being the one place with no feedback is a direct hit on the value proposition.
- **Reproduction:**
  1. Open a conversation → `⋯` → *Model controls*.
  2. Set Temperature to `5` and Top P to `3.5`.
  3. **Expected:** an inline error under each field the moment the value leaves range, and *Save* disabled or a visible warning.
  4. **Actual:** both accepted silently; the sheet closes normally.
  5. Send any message.
  6. **Expected:** at worst, a failure that names the offending parameter and offers to reopen the sheet.
  7. **Actual:** the request fails ~7s later. An empty assistant bubble is appended permanently, the error text appears both inside it and in a banner above the composer, and the only options are *Try again* (which repeats the failure) and *Dismiss* (which leaves the stub behind).
- **% of users affected:** ~25% — only users who open *Model controls*, but that is precisely this app's target audience, and the field is a free-text numeric input with no hint at the valid range.
- **Suggested fix:** call the existing validator on change, not on send. `Field` already accepts an `error` prop; wire the validator's `issues` array into it and show the range in the placeholder (`0–2`, `0–1`). Then add *Edit request* to the failure banner's actions so a parameter-caused failure has a one-tap route back. The rules are already written and already tested — they simply run at the wrong moment.
- **Related section:** 2.1 Sampling Parameters

### ALEX-02 · There is no Top K control for either transport

- **Severity:** Low
- **Frequency:** Always
- **Impact:** *Model controls* offers Max output tokens, Temperature and — on OpenAI transports only — Top P. `top_k` is absent from both transports' UI. It is a real Anthropic Messages parameter and a real expectation for a user who came here for parameter access; its absence is currently silent, so Alex concludes the app cannot send it rather than that the app chose not to expose it.
- **Reproduction:**
  1. `⋯` → *Model controls* on an OpenAI-transport conversation. Note Max output tokens, Temperature, Top P.
  2. Switch to an Anthropic-transport profile and repeat. Note Max output tokens, Temperature — Top P is correctly hidden, because the OpenAI-shaped `top_p` field is transport-specific.
  3. **Expected:** a Top K field, at least on the Anthropic transport.
  4. **Actual:** no Top K anywhere.
- **% of users affected:** ~10% — few users set `top_k`, but the ones who do are exactly this persona.
- **Suggested fix:** add a `topK` integer field gated on transport the same way Top P already is, using the same `Field` + validation path as ALEX-01's fix. If it is deliberately out of scope, say so in the sheet's footer note; a stated omission costs nothing and a silent one reads as a gap.
- **Related section:** 2.1 Sampling Parameters

---

## 2.2 Extended Thinking

The thinking controls are *not* in the header — they are in the same *Model controls* sheet as sampling, as a *Reasoning / thinking* switch that reveals a segmented effort control when enabled. The effort ladder is transport-aware and correct: `minimal · low · medium · high` for OpenAI, `low · medium · high · xhigh · max` for Anthropic, plus a *Thinking budget* stepper (1,024–127,999 in 1,024 steps) on Anthropic only. The app also knows that thinking cannot be *disabled* at `xhigh` or `max` and blocks that combination with a clear explanation rather than letting the API 400 — a genuinely thoughtful piece of validation.

Rendered thinking is visually distinct and well handled: a collapsible `Thinking / 36 words / ▼` block above the answer, on its own purple-tinted surface with its own border, collapsed or expanded per a global default that a conversation can override. Word count rather than character count is the right unit for deciding whether to expand.

### ALEX-03 · A thinking block renders while the same message's footer reports "0 thinking" tokens

- **Severity:** Medium
- **Frequency:** Always on gateways that stream reasoning without reporting reasoning-token counts
- **Impact:** The footer is the app's accounting surface and it contradicts the content directly above it. Alex is trying to answer "what is extended thinking costing me?", and the app shows him 36 words of visible reasoning alongside `0 thinking`. He cannot tell whether the reasoning was free, whether the counter is broken, or whether the tokens are hidden inside the `in`/`out` figures. That uncertainty is worse than no counter at all, because a wrong number gets believed.
- **Reproduction:**
  1. `⋯` → *Model controls* → enable *Reasoning / thinking*, effort `medium`, save.
  2. Send a question that provokes reasoning.
  3. Wait for the reply and read the collapsed `Thinking / N words / ▼` block, then the footer.
  4. **Expected:** a non-zero thinking-token count, or an explicit "not reported by this gateway".
  5. **Actual:** `5:41 PM · 7.2k in · 329 out · 0 thinking` sitting directly beneath a rendered thinking block. The gateway streams `reasoning_content` deltas but never sends a reasoning-token count, and the app renders the absent count as a literal zero.
- **% of users affected:** ~40% — everyone who enables thinking on a gateway that does not report the count, which includes many OpenAI-compatible proxies.
- **Suggested fix:** distinguish zero from unknown. When reasoning content arrived but no reasoning-token count did, render `· thinking not reported` (or estimate from the text and mark it `~`), and omit the segment entirely when thinking was off. The same rule should apply to the `0 in · 0 out` on failed turns, which is the same bug in a different place.
- **Related section:** 2.2 Extended Thinking

---

## 2.3 Advanced Edits

This is the app's strongest area and I have no defects to report against it beyond the discovery problem covered under Casey and Morgan (the actions are reachable only by long-press, with no visible affordance).

Long-pressing any message opens a sheet whose every row states its consequence as a subtitle rather than assuming the user knows:

- **Copy** — disabled with "This message has no text to copy." when the message is empty.
- **Edit and resend** — "Everything after this message is deleted, then it is sent again."
- **Edit in place** — "Only the stored text changes. Nothing is re-sent, so the reply below still answers the old wording."
- **Regenerate** — restricted to assistant messages, disabled with a reason while a stream is live.
- **Fork** — copies the conversation up to and including that message into a new one.
- **Delete** — confirmed.

Those two edit variants are the detail that marks this as built by someone who has actually needed both. Every other client I have used conflates them, and then you cannot fix a typo in a question without throwing away the answer.

Editing a user message at the midpoint and resending correctly truncated everything after it. Regenerating an assistant reply replaced it rather than appending a second one. Forking at the midpoint produced a new conversation containing the prefix, and — a nice touch — **failed turns are dropped from the fork** rather than copied, so a fork taken after a network failure starts clean.

One thing to note rather than file: *Edit and resend* and *Delete* are destructive and both are confirmed, but the confirmations run through `Alert.alert`, which is a no-op on the web build used for this harness. I reviewed them in source and could not exercise them; they are reported as unverified rather than broken. The same applies to *Delete conversation*, key removal and profile deletion.

---

## 2.4 Request Transparency

Settings → *Debug log* is genuinely complete. Each entry expands to the request id, the full header map, the request body, the response body and a stream sample — and `Authorization` is rendered as `[REDACTED]` before it enters the buffer. The screen's own copy is precise about the privacy contract: *"Kept in memory only — never written to disk or uploaded. The API key is replaced with a fingerprint before anything enters the buffer, so copying this out is safe."* Alex can paste a request into a bug report without scrubbing it first. Dropped parameters are logged too, so a gateway silently ignoring `top_p` is visible rather than mysterious.

Three problems, all about how findable and trustworthy the numbers are.

### ALEX-04 · The composer's token estimate is off by roughly 600× against billed usage

- **Severity:** Medium
- **Frequency:** Always on gateways that inject a system prompt
- **Impact:** The composer's `used / window` gauge is computed locally from the transcript. For a fresh conversation with one short question it read **11** tokens; the gateway billed **6,850–7,300** input tokens for the same request, because it prepends a large hidden system prompt. The gauge is the only pre-send signal about context pressure, so a user watching it will believe he has 200k of headroom until the point where he does not. It is the number the app shows *before* spending money, and it is the least accurate number in the app.
- **Reproduction:**
  1. Start a new conversation and type a short question. Read the composer gauge — `11 / 200k`.
  2. Send it. Read the assistant footer — `7.2k in · 329 out`.
  3. **Expected:** an estimate within a reasonable factor of actual, or a correction after the first real response.
  4. **Actual:** 11 estimated, ~7,200 billed. The gauge never learns.
- **% of users affected:** ~100% of users on a gateway with prompt overhead; the discrepancy is smaller but still present on direct API access.
- **Suggested fix:** after the first successful turn, calibrate: store `actual_prompt_tokens − locally_estimated_tokens` per profile as a fixed overhead and add it to the gauge, with the label switching from `~` to a firmer figure once measured. Even a crude one-sample correction turns the gauge from misleading to useful, and the app already receives the actual number in every `usage` payload.
- **Related section:** 2.4 Request Transparency

### ALEX-05 · Cost is invisible until the user hand-enters pricing, and nothing says so

- **Severity:** Medium
- **Frequency:** Always, by default
- **Impact:** `MessageView` appends a formatted cost to the footer only when the model registry holds a `pricing` entry for that profile+model, and pricing is never populated by discovery — `/v1/models` does not return prices. So by default every footer shows tokens and no money, and there is no hint that a cost figure is available at all. The path to enable it (Settings → Models → tap a model → enter input and output per-million prices) is four levels deep and undiscoverable from the place where the cost would be shown. For a persona whose top question is "what did that cost?", the answer is present in the codebase and absent from the screen.
- **Reproduction:**
  1. Complete any turn and read the assistant footer: `5:41 PM · 7.2k in · 329 out · 0 thinking`. No cost.
  2. Look for any affordance in the chat screen that mentions cost or pricing.
  3. **Expected:** either a cost figure, or a tappable "add pricing to see cost".
  4. **Actual:** nothing. Cost appears only after Settings → Models → the model → pricing fields are filled in by hand.
- **% of users affected:** ~100% initially; ~60% permanently, since most users will never find the pricing fields.
- **Suggested fix:** ship a default price table for the well-known model families keyed by id prefix, marked *estimated* the same way capability flags are already marked *guessed* — the app has an established, honest pattern for "we inferred this" and should reuse it. Where no price is known, make the footer's token segment tappable straight to that model's pricing screen.
- **Related section:** 2.4 Request Transparency

### ALEX-06 · Debug log entries are expandable but look and behave like static text

- **Severity:** Medium
- **Frequency:** Always
- **Impact:** Everything valuable in the Debug log is behind a tap that nothing advertises. Each `EntryCard` in [debug.tsx](app/settings/debug.tsx) is a `Pressable` with `onPress` toggling expansion, but it carries no `accessibilityRole`, no chevron, no disclosure triangle and no press feedback. The screen therefore reads as a flat list of one-line summaries, and the request bodies, headers, response bodies and stream samples — the reason the screen exists — are invisible until the user taps a row on speculation. Because there is no role, the row is also skipped by keyboard traversal and announced as plain text by a screen reader, so for those users the content is not merely hidden but unreachable.
- **Reproduction:**
  1. Send a message, then go Settings → *Debug log*.
  2. Read the list without tapping.
  3. **Expected:** a visible disclosure affordance per row.
  4. **Actual:** rows look static; nothing indicates expandability.
  5. Tap a row — request id, headers, body, response body and stream sample all appear.
  6. Traverse the screen with a keyboard.
  7. **Actual:** the rows are not focus stops.
- **% of users affected:** ~30% — everyone who opens the Debug log, which is where users are sent when something goes wrong.
- **Suggested fix:** add `accessibilityRole="button"`, `accessibilityState={{ expanded }}` and a rotating `›`/`⌄` glyph, and expand the newest entry by default so the screen demonstrates its own shape on arrival.
- **Related section:** 2.4 Request Transparency · overlaps Morgan 5.1

---

## What works well

**1. Every message action states its consequence before you commit.** Not "Edit" but two distinct actions — *Edit and resend* ("Everything after this message is deleted, then it is sent again") and *Edit in place* ("Only the stored text changes. Nothing is re-sent, so the reply below still answers the old wording") — each with the cost spelled out in a subtitle. This is the single best piece of interaction design in the app. It respects the user enough to offer the destructive option while making the destruction impossible to trigger accidentally, and it distinguishes two operations that every mainstream client conflates.

**2. Full request and response transparency, with the key redacted at the source.** The Debug log exposes headers, request body, response body and a raw stream sample per request, and `Authorization` is replaced with a fingerprint *before* the entry enters the buffer, not masked at render time. Combined with the explicit in-memory-only guarantee, this is a diagnostic surface Alex can share verbatim in a bug report — which is exactly the workflow a power user needs and almost never gets. Dropped parameters being logged means a gateway quietly ignoring `top_p` becomes visible rather than a mystery.

**3. Sampling and reasoning are scoped per conversation, and the app knows the transport-specific rules.** Temperature and thinking effort belong to the conversation, so different chats can have genuinely different behaviour without a global settings trip. On top of that, the effort ladder changes with the transport (`minimal…high` for OpenAI, `low…max` for Anthropic), Top P is hidden where it does not apply, the thinking budget stepper appears only for Anthropic, and disabling thinking at `xhigh` or `max` is blocked with an explanation of why the API would reject it. That is real knowledge of the wire protocols encoded into the UI, not a generic settings form.

---

## Summary

| ID | Severity | Issue |
|---|---|---|
| ALEX-01 | High | Out-of-range sampling values save silently and fail at send with no route back |
| ALEX-03 | Medium | Thinking block renders while the footer reports `0 thinking` |
| ALEX-04 | Medium | Composer token estimate off by ~600× against billed usage |
| ALEX-05 | Medium | Cost hidden until pricing is entered by hand, with no hint |
| ALEX-06 | Medium | Debug log rows are expandable but have no affordance and no role |
| ALEX-02 | Low | No Top K control on either transport |

Alex gets almost everything he came for. The gap is that the app is generous with control and stingy with feedback about that control: it will let him set an impossible temperature, will not tell him what thinking cost, and will not tell him what anything cost. Every one of those numbers is already flowing through the code.

