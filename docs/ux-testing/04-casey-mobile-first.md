# Agent 4 — CASEY, The Mobile-First User

> **Historical record — see [the status box on the consolidated report](00-consolidated-report.md)
> before trusting anything below.** Dated 2026-09-01, against a Phase 1 app then called
> AgentRouter Mobile; it is now SuperAgent. Casey's findings are closed, and two of them
> shaped how the app is built rather than getting a local patch: every undersized target
> is now made up in `hitSlop` against `MIN_TARGET = 48`
> ([ui.tsx:66](src/components/ui.tsx:66)) *"rather than by inflating the design"*, and the
> long-press-only message actions became a menu that opens where you pressed. The
> keyboard double-adjust this report could only mark *unverified on device* was
> reproduced on hardware and fixed. Kept unedited because the mid-stream connection kill
> and the 7.6 s time-to-failure were measured against a live gateway.

**Persona.** Uses the app one-handed, on a phone, on the move, on a flaky connection. Thumbs, not fingertips. Judges software by whether the first tap works and whether losing signal loses work.

**Session.** 375×812 viewport (a standard phone form factor), conversations with five or more messages and long generated replies, plus a mid-stream connection kill. Where a measurement is only meaningful on a real device, it is marked as such rather than guessed at.

**Scenarios run.** 4.1 Touch Responsiveness · 4.2 Scroll Performance · 4.3 Network Resilience · 4.4 Keyboard & Input.

---

## 4.1 Touch Responsiveness

Every tap registered on the first attempt, and no control needed a double tap. There is no perceptible lag between press and response, and pressed states are visible (`surfaceActive` is a distinct level in the palette, not an opacity trick).

The problem is size, and it is systemic rather than incidental: the components that build every screen are all below the platform minimum.

### CASEY-01 · Touch targets are below Android's 48dp minimum across the entire app

- **Severity:** High
- **Frequency:** Always
- **Impact:** Android's accessibility guidance and Material's minimum are both 48×48dp. Measured heights: **tag filter chips 19dp**, **segmented-control options 34dp**, **standard buttons 42dp** (68×42 for *Send*), **sheet Cancel 40dp**, and the conversation-options `⋯` at **15×25dp** (39×49 with its `hitSlop={12}`). Nothing meets 48dp, and the tag chips are at 40% of it. One-handed, in motion, the chip row is the worst of them: eight chips at 19dp tall in a horizontal scroller means a mis-tap either selects the wrong tag or scrolls the row, and the user cannot tell which happened because both produce a visible change. Because all of these come from three shared primitives, the whole app inherits the problem and no screen can be fixed individually.
- **Reproduction:**
  1. Open the app at a 375×812 viewport.
  2. Measure the tag filter chips on Home. **Expected:** ≥48dp. **Actual:** ~19dp (`Badge` uses `paddingVertical: 2` around `fontSize.xs` = 11).
  3. Measure a segmented-control option in `⋯` → *Model controls*. **Expected:** ≥48dp. **Actual:** 34dp (`Segmented` uses `paddingVertical: spacing.sm` = 8).
  4. Measure any primary button, e.g. *Send*. **Expected:** ≥48dp. **Actual:** 42dp (`Button` computes `vPad = spacing.sm + 2` = 10).
  5. Measure the `⋯` header control. **Expected:** ≥48dp of touchable area. **Actual:** a 15×25dp glyph, 39×49 including `hitSlop`.
- **Root cause:** `Badge`, `Button` and `Segmented` in [ui.tsx](src/components/ui.tsx) — three primitives, roughly six lines of padding between them.
- **% of users affected:** 100%, and disproportionately users with larger hands, tremor, or a moving vehicle.
- **Suggested fix:** set `minHeight: 48` on `Button` and `Segmented`, and give the tag chips a `hitSlop` of at least 15 vertically (they should stay visually small — a 48dp-tall chip row would dominate Home — but their touch area must not). Raise the `⋯` `hitSlop` from 12 to 17. This is the cheapest high-severity fix in the whole report: three primitives, no layout redesign, and it fixes every screen at once.
- **Related section:** 4.1 Touch Responsiveness

### CASEY-02 · Message actions are reachable only by long-press, with nothing indicating they exist

- **Severity:** Medium
- **Frequency:** Always
- **Impact:** Copy, *Edit and resend*, *Edit in place*, *Regenerate*, *Fork* and *Delete* are the app's best features (see [Alex 2.3](02-alex-power-user.md)) and all six are behind an unadvertised 300ms long-press on the message bubble. `MessageView` binds `onLongPress` and no `onPress`, and no chevron, overflow dot or hint appears on the bubble. A mobile user's habitual gesture on a message is a tap; tapping does nothing, so the reasonable conclusion is that messages are not interactive. There is an `accessibilityHint` reading "Long press for message actions", but a hint is only spoken by a screen reader — a sighted user never receives it. The same pattern on Home rows is better handled, because that row *also* responds to tap (it opens the conversation), so the long-press is a bonus rather than the only door.
- **Reproduction:**
  1. Open a conversation with several messages.
  2. Look for any visual indication that a message can be acted on. **Expected:** an overflow affordance, or a tap that reveals actions. **Actual:** nothing.
  3. Tap an assistant message. **Expected:** an action sheet, or at minimum some response. **Actual:** nothing happens.
  4. Long-press for 300ms. **Actual:** the full action sheet appears.
- **% of users affected:** ~60% will not discover the actions unaided.
- **Suggested fix:** keep the long-press and add a tap. Either open the same sheet on tap of a small overflow glyph in the message footer (the footer already renders the timestamp and usage, so there is a home for it), or reveal a compact action row under the most recent message. Adding `onPress` also fixes the keyboard-accessibility half of this problem — see [Morgan 5.1](05-morgan-accessibility.md), where the absence of `onPress` makes all six actions unreachable without a touchscreen.
- **Related section:** 4.1 Touch Responsiveness · overlaps Morgan 5.1

---

## 4.2 Scroll Performance

Scrolling was exercised over conversations with 5–8 messages including replies of several hundred words, both idle and during a live stream. Behaviour was correct: rapid flicks did not blank rows, scrolling up during a stream stayed put rather than being yanked back to the bottom, and returning to a conversation restored its position.

**I could not honestly measure frame rate.** The list is `@shopify/flash-list`, and on the web build FlashList v2 renders recycled rows with absolute positioning, so DOM order, `innerText` order and `getBoundingClientRect` are all unreliable proxies for what is on screen. Any FPS figure I produced from this harness would be a number about the harness, not the app. Two consequences worth recording honestly:

- The configuration is right in principle. The chat list sets `maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}` ([app/chat/[id].tsx:411](app/chat/[id].tsx:411)), which is exactly the pattern that keeps a streaming transcript pinned to the bottom *unless* the user has scrolled away — the 0.2 threshold means autoscroll resumes only when they are within 20% of the bottom. That is the behaviour the scenario asks for, and it is declared rather than hand-rolled.
- **60 FPS during streaming remains unverified.** It needs a physical Android device with a release build and a systrace or the Perfetto FPS overlay. I recommend measuring it against a 1,000-word reply with a code block and a math block, since `CodeBlock` and `MathView` are the heaviest renderers in the transcript.

Mid-stream throttling is handled thoughtfully in the store: `publish(event.type !== 'text_delta' && event.type !== 'thinking_delta')` means high-frequency text deltas are batched while rare structural events publish immediately. That is the correct shape for keeping a stream cheap, and it suggests the FPS answer is likely to be good — but "likely" is as far as this harness can take it.

---

## 4.3 Network Resilience

The gateway was killed mid-stream, after roughly 450 words of a reply had arrived, and then killed before a cold send.

The core behaviour is **right**, and it is the thing most clients get wrong: **the partial reply is kept.** The 450 words that arrived stayed on screen and in the database. No crash, no stuck spinner, no lost draft. The error is plain English with a next step — *"Could not reach the gateway at all. Check connectivity, or try the backup domain."* — the turn is labelled `Failed · 7s · claude-opus-5`, and *Try again* is offered. Cold sends failed in 7.6s and 5.6s, which is the documented retry policy with exponential backoff and full jitter behaving correctly.

Three things go wrong around that good core. Two are covered elsewhere and referenced here because this is where a mobile user meets them: the failure debris is permanent ([MAYA-06](01-maya-new-user.md)) and there is no connection indicator anywhere ([MAYA-07](01-maya-new-user.md)). The third is specific to interrupted streams.

### CASEY-03 · An interrupted stream reports `0 in · 0 out` after receiving hundreds of words, and the retry status claims to be "Streaming"

- **Severity:** Medium
- **Frequency:** Always, on any interrupted or retried request
- **Impact:** Two separate lies in the status line of a failure, both hitting a user who is specifically trying to work out what happened and what it cost. First: after ~450 words of a reply arrived and the connection dropped, the message footer read `0 in · 0 out`. The input tokens were certainly billed and the output partially so, but the app reports zero because the `usage` payload only arrives in the final SSE event, which never came. Casey's reasonable reading is that the failed attempt was free — it was not. Second: during the retry-backoff window the status label reads `Streaming` with an incrementing seconds counter, sampled at every 500ms from 0s through 5s, while the app is in fact sitting in backoff after a failed connection attempt with nothing streaming at all. Retries are entirely invisible; the user sees a 5–7 second "Streaming" state and then a network error, and cannot distinguish a slow model from three failed connections.
- **Reproduction:**
  1. Start a long reply and let ~400 words arrive.
  2. Kill the network mid-stream.
  3. Read the failed message's footer. **Expected:** `7.2k in · ~600 out (partial)`, or "usage unknown". **Actual:** `0 in · 0 out`.
  4. With the network still down, send another message and sample the status label every 500ms.
  5. **Expected:** `connecting` → `retrying (2 of 3)` → the failure.
  6. **Actual:** `Streaming · 0s` … `Streaming · 5s`, then `Failed · 5s`.
- **% of users affected:** ~90% — anyone on mobile data.
- **Suggested fix:** estimate partial output from the text actually received and render it as `~600 out (partial)`, and show input tokens from the pre-send estimate rather than zero — the same "distinguish zero from unknown" fix as [ALEX-03](02-alex-power-user.md). Separately, surface the retry state the transport already tracks: label the phases `connecting` / `retrying (2 of 3)` / `streaming` instead of calling all of them "Streaming". The retry machinery is well built; it is simply silent.
- **Related section:** 4.3 Network Resilience

---

## 4.4 Keyboard & Input

A 353-character message was composed and sent. The composer is `multiline` with `maxHeight: 140` ([Composer.tsx:179](src/components/chat/Composer.tsx:179)), so on Android it grows to roughly five lines and then scrolls internally — a sensible cap that keeps the transcript visible while composing something long. *Send* stayed on screen at the bottom of the viewport throughout (measured at y=742 in an 812pt viewport, fully visible), and the character counter tracked the draft live (`274 / 200k`, plus a `+N draft` segment).

Text selection works properly, which matters more than it sounds: `Body`, `CodeBlock`, thinking blocks and math blocks all pass `selectable`, so long-pressing inside a reply gives the native Android selection handles and the system cut/copy/paste bar. On top of that there is an explicit *Copy* action in the message sheet for whole-message copying, and code blocks have their own *Copy* button. Between them, getting text out of this app is easy — a common failure point in React Native chat clients, handled here.

`submitBehavior` is set explicitly (`submit` when send-on-Enter is enabled, `newline` otherwise) with a matching `returnKeyType`, which is the right fix for a real Android quirk: without an explicit value a multiline `TextInput` does neither reliably.

One gap, and it is unverified off-device.

### CASEY-04 · The chat screen has no keyboard-dismiss gesture, and its keyboard avoidance risks double-adjusting

- **Severity:** Medium
- **Frequency:** Likely often on Android — **unverified on device**
- **Impact:** Two related things, both flowing from the chat screen being the one screen that does not use the shared `Screen` wrapper. `Screen` sets `keyboardShouldPersistTaps="handled"` and `keyboardDismissMode="interactive"` ([ui.tsx:56](src/components/ui.tsx:56)); the chat screen renders a `FlashList` directly and sets neither. So on the app's most-used screen there is no drag-to-dismiss gesture and no guarantee that a tap landing on a message while the keyboard is up will register rather than being swallowed by the dismiss. Separately, `KeyboardAvoidingView behavior="padding"` at [app/chat/[id].tsx:392](app/chat/[id].tsx:392) combines with `"edgeToEdgeEnabled": true` in `app.json` and Expo's default `resize` soft-input mode; `resize` already shrinks the window when the keyboard opens, so adding padding on top is the classic double-adjust that leaves a keyboard-height gap above the composer.
- **Reproduction (needs a physical Android device):**
  1. Open a conversation and tap the composer to raise the keyboard.
  2. Drag downward over the transcript. **Expected:** the keyboard follows the drag. **Actual (predicted):** nothing; the keyboard only closes via the system back gesture.
  3. With the keyboard up, tap a message to long-press it. **Expected:** the press registers. **Actual (predicted):** the first press may be consumed dismissing the keyboard.
  4. Observe the gap between the composer and the top of the keyboard. **Expected:** none. **Actual (predicted):** a gap roughly the keyboard's height, or a visible jump as both adjustments apply.
- **% of users affected:** ~80% if the double-adjust reproduces; the missing dismiss gesture affects 100%.
- **Suggested fix:** add `keyboardDismissMode="interactive"` and `keyboardShouldPersistTaps="handled"` to the chat `FlashList` regardless — they are unconditionally correct here. For the avoidance, set `softwareKeyboardLayoutMode` explicitly in `app.json` and pick one mechanism: either `"pan"` plus `KeyboardAvoidingView`, or keep the default `resize` and drop the `KeyboardAvoidingView`. Verify on a device with a tall keyboard (e.g. Gboard with the number row) before choosing.
- **Related section:** 4.4 Keyboard & Input

---

## What works well

**1. A dropped connection does not lose what already arrived.** 450 words of a reply survived the network dying mid-stream, on screen and in the database, and the error that followed named the problem and offered a next step. Most chat clients discard a partial response, or worse, leave the bubble spinning forever. This one keeps the text, marks the turn `Failed`, offers *Try again*, and — a detail I only noticed in the source — refuses to fail over to the backup domain once bytes have arrived, because retrying elsewhere would duplicate both the visible answer and the credits. Someone thought carefully about the mid-stream case specifically.

**2. One button, and it is always the right button.** The composer's primary control is *Send* when idle, *Stop* (danger-styled) while streaming, and *Stopping…* while the abort is in flight — with "Waiting for the connection to close." shown as visible text under it. One thumb position, no hunting, no ambiguity about whether a tap will send or cancel, and the transitional state is named instead of being a dead button. For one-handed use this is exactly right, and the *Stop* affordance being impossible to miss matters when a model is generating a thousand words you did not want.

**3. Text is selectable everywhere, and copying is a first-class action.** Reply bodies, code blocks, thinking blocks and math all set `selectable`, so native Android selection handles and the system paste bar work as expected. Code blocks carry their own *Copy* button and every message has a *Copy* action with a disabled-state reason when there is nothing to copy. Getting content out of a React Native chat app is often surprisingly hard; here it works three different ways.

---

## Summary

| ID | Severity | Issue |
|---|---|---|
| CASEY-01 | High | Touch targets below 48dp app-wide (chips 19dp, segments 34dp, buttons 42dp) |
| CASEY-02 | Medium | Message actions long-press-only with no visible affordance |
| CASEY-03 | Medium | Interrupted streams report `0 in · 0 out`; retries labelled "Streaming" |
| CASEY-04 | Medium | No keyboard-dismiss gesture in chat; double-adjust risk (unverified on device) |

**Not measured:** 60 FPS during streaming, and the keyboard behaviour in CASEY-04. Both need a physical Android device; the web harness cannot produce an honest number for either.

Casey's verdict: the app behaves well when the network misbehaves, which is the hard part, and is harder to hit accurately than it should be, which is the easy part. Three padding values stand between it and meeting the platform's touch guidance.

