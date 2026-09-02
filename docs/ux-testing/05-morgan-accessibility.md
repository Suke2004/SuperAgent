# Agent 5 — MORGAN, The Accessibility User

> **Historical record — see [the status box on the consolidated report](00-consolidated-report.md)
> before trusting anything below.** Dated 2026-09-01, against a Phase 1 app then called
> AgentRouter Mobile; it is now SuperAgent. This was the report that found both
> Criticals that closed the app to a user group, and both are fixed: focus is
> `focusRingStyle` ([ui.tsx:113](src/components/ui.tsx:113)) with a `useFocusRing` hook so
> a control cannot forget it, and inputs and switches carry `accessibilityLabel`
> ([ui.tsx:1028](src/components/ui.tsx:1028), [ui.tsx:767](src/components/ui.tsx:767)).
> `textFaint` was retoned to `#6b6862` and now measures 5.3:1 on `bg` and 4.8:1 on the
> sunk surface — the theme source records why the warmer `#74716a` was rejected at 4.2:1
> on `#f0eee6`, which is exactly the reasoning this report asked for
> ([index.tsx:103](src/theme/index.tsx:103)). The 11 pt type problem and every undersized
> target went the same way as Casey's: `MIN_TARGET = 48` plus `hitSlop`.
>
> Two caveats still stand and are worth carrying forward rather than closing: TalkBack
> itself was never run (the findings were read out of the accessibility tree, and that is
> still how they are verified), and there is no automated contrast gate — the ratios in
> the theme source are comments, so a future palette edit can silently undo this.
>
> **A later accessibility pass — Section 12 of the Claude-parity checklist, 2026-09-02 —
> closed two more of the findings here and answered one of the open questions.**
> MORGAN-03's focus half is `accessibilityViewIsModal` on all eight modals, so a reader
> can no longer wander behind an open sheet; the Escape half does not apply on Android,
> where the back gesture dismisses and always did. MORGAN-05's names are in. The answered
> question is the one in *Not verified* below — "interruption behaviour during
> streaming" — and the answer is that **nothing announces during a stream, deliberately.**
> A screen reader re-reads a changing region from the top, so a live region over streaming
> text reads the reply from the beginning several times a second; what ships instead is one
> announcement when the turn ends, and exactly one of that and the background notification
> fires per turn. The verbosity-and-ordering half of that caveat is still open and is now
> steps 76–79 of [07_Deployment.md](../07_Deployment.md) §7.

**Persona.** Navigates by keyboard, uses TalkBack for parts of the day, and needs contrast above 4.5:1 to read comfortably. Also the persona most likely to be using the app in a degraded state — poor light, poor signal, a half-configured install.

**Session.** Keyboard traversal measured stop by stop with computed focus styles captured at each stop; contrast computed from the palette source rather than estimated from screenshots; graceful-degradation paths traced through the stores. TalkBack itself could not be run against a web harness, so screen-reader findings are drawn from the accessibility properties actually present in the tree — which is where the defects are, and is verifiable without the reader.

**Scenarios run.** 5.1 Keyboard Navigation · 5.2 Screen Reader Support · 5.3 Visual Accessibility · 5.4 Offline Fallback · 5.5 Graceful Degradation.

---

## 5.1 Keyboard Navigation

Tab order is **logical**. Traversing the chat screen produced a sensible sequence — back button, *Conversation options*, then the transcript in visual order, then the composer — and Home's ~20 stops run header → chip row → conversation rows → footer actions with no jumps backwards and no unreachable regions. Nothing is skipped that should be reachable, and there are no orphaned stops on background content once a screen is properly on top. That is the hard part of tab order, and it is right.

Everything else about keyboard use is broken.

### MORGAN-01 · There is no focus indicator anywhere in the application

- **Severity:** Critical
- **Frequency:** Always
- **Impact:** A keyboard user cannot see where they are. Every one of the 26 focus stops I sampled reported `outline-style: none` and `box-shadow: none` — measured on the computed style of `document.activeElement` at each stop, not inferred. A search of the entire codebase for `focused`, `onFocus`, `focusVisible` or `outline` returns nothing in application code. So Tab moves an invisible cursor: the user presses Tab an unknown number of times, presses Enter, and finds out afterwards which control they activated. On a screen whose action list ends in *Delete conversation*, that is not a nuisance, it is a data-loss risk. This is also the finding that makes every other keyboard issue worse, because none of them can be diagnosed by the user.
- **Reproduction:**
  1. Open any screen and press Tab repeatedly.
  2. **Expected:** a visible ring, border change or background change on the focused control.
  3. **Actual:** no visual change of any kind. Computed `outlineStyle: 'none'` on every stop; no `boxShadow`.
  4. Repeat in light and dark themes and on Home, chat, Settings and inside a sheet. Same result everywhere.
- **% of users affected:** 100% of keyboard, switch-access and external-keyboard users; ~5–8% of the total user base, for whom the app is close to unusable.
- **Suggested fix:** add focus styling once, in the shared primitives. `Pressable` exposes a focus state on both platforms; render a 2px `accent`-coloured ring (or a `borderStrong` → `accent` border swap) on `Button`, `Segmented`, `Row`, `Badge`, `Field` and the message bubble. Because the whole app is built from six primitives in [ui.tsx](src/components/ui.tsx), this is one focused change rather than an audit — and it is the single highest-leverage accessibility fix available.
- **Related section:** 5.1 Keyboard Navigation

### MORGAN-02 · Message bubbles are focusable buttons that cannot be activated by keyboard

- **Severity:** High
- **Frequency:** Always
- **Impact:** Every message in the transcript is a focus stop announced as a button — `MessageView` sets `accessibilityRole="button"` and an `accessibilityHint` of "Long press for message actions" — but it binds only `onLongPress`, never `onPress`. So the control focuses, claims to be a button, promises actions, and does nothing when activated. I confirmed this directly: focused a user message, dispatched Enter and Space, and the action sheet did not open. That means **Copy, Edit and resend, Edit in place, Regenerate, Fork and Delete are all unreachable** without a touchscreen — six features, including the only way to copy a reply and the only way to correct a question, gated behind a gesture that keyboard and switch-access users cannot perform. Worse than being unavailable, the button role advertises them, so the user knows what they are missing and keeps trying.
- **Reproduction:**
  1. Open a conversation with messages and Tab until focus reaches a message bubble.
  2. **Expected:** Enter or Space opens the message action sheet.
  3. **Actual:** nothing happens. Verified by dispatching both `Enter` and `Space` `keydown`/`keyup` on the focused element and observing that *Regenerate* / *Edit and resend* / *Edit in place* never appear.
  4. Confirm in source: [MessageView.tsx](src/components/chat/MessageView.tsx) passes `onLongPress={onAction ? … : undefined}` with `delayLongPress={300}` and no `onPress`.
- **% of users affected:** 100% of keyboard and switch-access users; also the ~60% of touch users who never discover the long-press ([CASEY-02](04-casey-mobile-first.md)).
- **Suggested fix:** bind `onPress` to the same handler as `onLongPress`, or add a small overflow control in the message footer that both a tap and a keyboard activation can reach. One line fixes discoverability for sighted touch users and access for keyboard users simultaneously — the two findings have the same repair.
- **Related section:** 5.1 Keyboard Navigation · overlaps Casey 4.1

### MORGAN-03 · Sheets do not trap focus, and Escape does not dismiss them

- **Severity:** High
- **Frequency:** Always
- **Impact:** With the conversation-options sheet open, Tab traversal walked out of the sheet and into the screen behind it — from *System prompt*, *Model*, *Model controls*, *Rename*, *Tags*, *Pin to the top*, *Delete conversation*, straight on to the back button, *Conversation options*, the message bubbles and the composer. A keyboard user can therefore focus and activate controls that are visually covered by a modal, including sending a message to a conversation whose options sheet is open. Combined with [MORGAN-01](#morgan-01--there-is-no-focus-indicator-anywhere-in-the-application) — no focus ring — they cannot even tell they have left the sheet. Separately, Escape does not close it: I dispatched `Escape` at the document, body and active element and the sheet stayed open. Dismissal requires the *Cancel* row, a backdrop tap, or the Android back gesture.
- **Reproduction:**
  1. Open a conversation → `⋯`.
  2. Tab through the sheet's rows, then keep going.
  3. **Expected:** focus cycles within the sheet.
  4. **Actual:** after *Delete conversation*, focus moves to the back button and then through the whole chat screen behind the modal.
  5. Press Escape. **Expected:** the sheet closes. **Actual:** it stays open.
- **% of users affected:** 100% of keyboard users; the Escape half also affects tablet and Chromebook users with attached keyboards.
- **Suggested fix:** the sheet is already careful about the *Android* trap — `Sheet.tsx:53` sets `onRequestClose={onClose}` with the comment "Without this the sheet is a trap", and the backdrop is a labelled *Close menu* Pressable. Extend the same care to keyboards: add a keydown listener for `Escape` calling the existing `onClose`, and constrain focus to the sheet's container while `visible` (on web, `aria-modal` plus a focus guard; `accessibilityViewIsModal` covers the native side). The close path exists; only the keyboard route into it is missing.
- **Related section:** 5.1 Keyboard Navigation

---

## 5.2 Screen Reader Support

Several things are labelled properly and deserve credit before the defects: the navigation back control announces as *"AgentRouter, back"*, the thinking toggle announces as *"Thinking, 11 words"* (content-aware, not a bare "toggle"), the sheet backdrop is *"Close menu"*, the `⋯` control is *"Conversation options"*, the composer input is *"Message"*, code blocks expose *"Copy code"*, and — the detail I liked most — the 34×34 initials avatar on each conversation row is explicitly `accessible={false}`, so TalkBack reads the conversation once instead of announcing "M L" before every title. Someone thought about duplicate announcements.

Then there is the largest single accessibility defect in the app.

### MORGAN-04 · No text input in the application has an accessible name

- **Severity:** Critical
- **Frequency:** Always
- **Impact:** `Field` — the shared component behind essentially every text input outside the composer — renders its `label` as a sibling `Text` and never sets `accessibilityLabel`, and never associates its `hint` or `error` with the input either ([ui.tsx:560](src/components/ui.tsx:560)). The label is therefore purely visual. To TalkBack, the entire provider setup is a column of unnamed edit boxes: *Base URL*, *API key*, *Name*, and in *Model controls* *Max output tokens*, *Temperature*, *Top P*. A blind user cannot complete onboarding at all — they arrive at three identical unlabelled fields and one of them needs a URL and one needs a secret, with no way to tell which. Validation messages are equally unlinked, so when a field is wrong the reason is announced (if at all) as loose text somewhere on the screen rather than as part of the field. This blocks the primary task of the app for screen-reader users, which is what makes it Critical rather than High.
- **Reproduction:**
  1. Enable TalkBack. Go Settings → Providers → *Custom URL*.
  2. Swipe to the first input.
  3. **Expected:** "Base URL, edit box" and, on error, the error as part of the field.
  4. **Actual:** "edit box" with no name. Same for the API key and Name fields, and for every field in *Model controls*.
  5. Confirm in source: `Field` renders `{label ? <Text …>{label}</Text> : null}` above a `TextInput` that receives no `accessibilityLabel`, `aria-describedby`, `accessibilityHint` or `accessibilityInvalid`.
- **% of users affected:** 100% of screen-reader users. Setup is unachievable.
- **Suggested fix:** in `Field`, pass `accessibilityLabel={label}` to the `TextInput`, add `accessibilityHint={hint}`, and set `accessibilityInvalid` / `aria-errormessage` when `error` is present. One component, four lines, and it fixes every form in the app at once — including the sampling fields that [ALEX-01](02-alex-power-user.md) recommends adding inline errors to, so the two fixes should ship together.
- **Related section:** 5.2 Screen Reader Support

### MORGAN-05 · The thinking switch, the token gauge and the "All" filter chip lack names or state

- **Severity:** High
- **Frequency:** Always
- **Impact:** Three separate controls whose meaning is carried only by a neighbouring visual element:
  - **`SwitchRow`** renders a bare `<Switch>` in the row's right-hand slot with no `accessibilityLabel`; the label ("Reasoning / thinking", "Automatic failover", "Keep the debug log", "Mirror to the Metro console") is a sibling `Text`. TalkBack announces "off, switch" with no indication of what is off.
  - **The composer token gauge** — `7.0k / 200k`, plus a `+N draft` segment — has no accessible name at all. It is the only signal about context pressure and it announces as two bare numbers.
  - **The "All" tag chip** puts its `accessibilityState` on an inner `View` rather than on the `Pressable` ([index.tsx:418](app/index.tsx:418)), so "no filter applied" is never announced as selected, even though every other chip in the row correctly carries `accessibilityState={{ selected }}` on the Pressable itself. The user can hear which specific tag is active but not that the filter has been cleared.
- **Reproduction:**
  1. With TalkBack on, focus the *Reasoning / thinking* switch in *Model controls*. **Expected:** "Reasoning / thinking, switch, off". **Actual:** "off, switch".
  2. Focus the composer's `7.0k / 200k` text. **Expected:** "Context used, 7,000 of 200,000 tokens". **Actual:** the raw numbers, unnamed.
  3. On Home, focus the `All` chip with no filter applied, then a specific tag chip. **Expected:** both announce selected state. **Actual:** only the tag chips do.
- **% of users affected:** 100% of screen-reader users.
- **Suggested fix:** pass the row's `label` through to the `Switch` as `accessibilityLabel` inside `SwitchRow`; wrap the gauge in a `View` with `accessible` and an `accessibilityLabel` that spells the numbers out; move the `All` chip's `accessibilityState` onto its `Pressable`. All three are one-line moves in existing components.
- **Related section:** 5.2 Screen Reader Support

---

## 5.3 Visual Accessibility

Contrast ratios were computed from the palette in [theme/index.tsx](src/theme/index.tsx) against every surface each colour is actually used on, rather than eyeballed from screenshots. Most of the palette is good: `text`, `textDim`, `danger`, `warning`, `success` and `thinkingText` all clear 4.5:1 in **both** themes on **all three** surface levels. That is a deliberately built palette, not a lucky one.

Two problems, one colour and one size.

Errors are also **not** colour-only — `Note tone="danger"` and `disabledReason` both render actual sentences, so a failure is legible without perceiving red. And no animation approaches the 3-second threshold: sheets slide up over their own height in roughly a quarter of a second, honour Reduce Motion by dropping the spring for a short timing curve, and nothing in the app animates for longer than a transition. The one thing that repeats — the thinking pulse — is a slow opacity breath with no travel, which is not a flash at any rate.

### MORGAN-06 · `textFaint` fails WCAG AA on every surface in light mode and on the raised surface in dark

- **Severity:** High
- **Frequency:** Always
- **Impact:** `textFaint` is not a rare decorative colour — it is the tone used for row subtitles, badge text, timestamps, the composer's token gauge, the "Last discovery" stamp, placeholder text and the `disabledReason` copy that the app relies on to explain disabled buttons. Measured ratios:

  | Colour | Surface | Light | Dark |
  |---|---|---|---|
  | `textFaint` | `bg` | **3.20** | **4.13** |
  | `textFaint` | `surface` | **2.98** | **3.81** |
  | `textFaint` | `surfaceAlt` | **2.75** | **3.44** |
  | disabled label @ 0.45 opacity | `surface` | **2.96** | **3.98** |
  | `accent` | `bg` | 4.50 | pass |

  Every `textFaint` figure fails the 4.5:1 requirement for body text, worst at 2.75 in light mode on `surfaceAlt` — which is where code blocks, thinking panes and inputs live. Disabled labels at 0.45 opacity fail in both themes. And `accent` on `bg` in light mode lands at exactly 4.50, i.e. passing by zero margin: any future darkening of the background or lightening of the accent breaks it silently. The practical result is that the app's explanatory layer — the subtitles that make it self-documenting, which is one of its real strengths — is the least readable text in it.
- **Reproduction:**
  1. In light mode, open Home and read a conversation row's timestamp and the composer's token gauge.
  2. **Expected:** ≥4.5:1 against the surface.
  3. **Actual:** 2.98:1 on `surface`, 2.75:1 on `surfaceAlt`.
  4. Open *Model controls* and read a disabled button's reason text. **Actual:** 2.96:1.
  5. Repeat in dark mode: `textFaint` on `surfaceAlt` measures 3.44:1.
- **% of users affected:** ~15–20% directly (low vision, ageing eyes, colour deficiency), and effectively 100% in bright outdoor light.
- **Suggested fix:** darken light `textFaint` from `#8b909c` to roughly `#6b7280` and lighten dark `textFaint` from `#6e7684` to about `#8b93a1`, then re-measure against all three surfaces. Raise the disabled opacity from 0.45 to ~0.6 and pair it with the existing `disabledReason` text, which already carries the meaning. Give `accent` real headroom in light mode (`#0b6efd` → `#0a5fd8`) so it is not sitting on the boundary. This is a palette change with no layout consequences.
- **Related section:** 5.3 Visual Accessibility

### MORGAN-07 · The smallest type size is 11pt, below the 12pt floor, and it carries meaning

- **Severity:** Medium
- **Frequency:** Always
- **Impact:** `fontSize.xs = 11` and it is not reserved for decoration. It is used for conversation-row subtitles, all `Badge` text (including the `guessed`, `unlisted`, `index` and `scan` provenance labels that make the app trustworthy), the composer token gauge, the "Last discovery" timestamp, sheet subtitles and the `disabledReason` copy. Combined with [MORGAN-06](#morgan-06--textfaint-fails-wcag-aa-on-every-surface-in-light-mode-and-on-the-raised-surface-in-dark) — most of that text is also `textFaint` — the app's entire explanatory layer is 11pt low-contrast type. The `Badge` size also causes the 19dp touch target in [CASEY-01](04-casey-mobile-first.md), so type scale and hit area are the same root cause.
- **Reproduction:**
  1. Open Home and read the model id and message count under a conversation title. Measure: 11pt.
  2. Open Settings → Models and read the `guessed` / `unlisted` badges. Measure: 11pt, `warning` tone.
  3. **Expected:** ≥12pt for any text conveying information.
  4. **Actual:** 11pt throughout, defined once as `fontSize.xs`.
- **% of users affected:** ~20% will struggle; ~100% lose some legibility outdoors.
- **Suggested fix:** raise `fontSize.xs` from 11 to 12 and introduce a genuinely decorative `fontSize.micro = 11` used only where text duplicates something already stated. Verify with the OS font scale at 130% and 200% — a one-point rise is cheap, but the badge and chip layouts should be checked at large font scales at the same time.
- **Related section:** 5.3 Visual Accessibility

---

## 5.4 Offline Fallback

**This is the app's best-behaved scenario.** With the gateway completely unreachable, the app was relaunched cold. It booted without error and rendered everything from local SQLite: all seven conversations, the `TODAY · 7` recency header, per-row previews, model ids, message counts, and the full tag chip row with live counts (`coding · 3`, `ai · 1`, `database · 1`, `ethics · 1`, `learning · 1`, `operations · 1`, `philosophy · 1`). Opening a conversation showed the complete transcript including thinking blocks and code blocks.

**Search works offline too, at full speed.** Querying `Berkeley` — a word appearing once inside a long generated essay — returned the title pass in **77ms** and the message hit in **324ms**, with the correct context snippet, against the local database. That is the payoff of the local-first design and it is worth protecting.

The one defect is that the app does not admit it is offline — covered as [MAYA-07](01-maya-new-user.md), and the reason a user's first indication is a 7.6-second failure. There is a specific accessibility dimension worth adding: with no visual offline indicator there is also no announcement, so a screen-reader user gets no signal at all until the failure, and the failure text is appended into the transcript rather than announced as a live region.

---

## 5.5 Graceful Degradation

Three degraded states were traced. Two are handled well; the third is handled quietly, which is worse than handling it badly.

**No models discovered** is excellent. Settings → Models shows a real empty state — *"Nothing discovered yet. Refresh from the gateway, or add a model id by hand below. Gateways sometimes serve ids they do not list."* — which names the situation, gives two routes out, and explains why the manual route exists. In the chat screen the model picker falls back to `[conversation.model]`, so the list is never empty. The only gap is that the model sheet offers no route to run discovery; that lives four levels away in Settings.

**No provider profiles at all** degrades cleanly too: `Note tone="danger">No provider profiles. Add one first.` rather than an empty screen or a crash. And **stale data** is labelled rather than hidden — a model absent from the last discovery keeps its flags and gains an `unlisted` badge, inferred capabilities carry a `guessed` badge, and the models screen stamps *"Last discovery &lt;timestamp&gt;"*. (That stamp is 11pt `textFaint` and absolute rather than relative, so "three weeks ago" reads the same as "a minute ago" at a glance — a small instance of MORGAN-06/07.)

### MORGAN-08 · Deleting a provider silently re-routes its conversations to a different gateway

- **Severity:** High
- **Frequency:** Always, after a profile is deleted
- **Impact:** When a conversation's profile no longer exists, [chat.ts:490](src/stores/chat.ts:490) resolves it as `useProviders.getState().byId(conversation.profileId) ?? activeProfile()`, and `active()` itself chains `profiles.find(…) ?? profiles[0] ?? seedProfiles()[0]` ([providers.ts:141](src/stores/providers.ts:141)). The intent is sound — the comment says "A deleted active profile must not leave the app with no provider at all" — and it does prevent crashes. But the consequence is that a conversation created against gateway A, after A is deleted, sends its next message to **gateway B**, with A's model id and B's API key, and tells the user nothing. For an app whose stated premise is privacy and control over which gateway sees your data, silently sending a conversation's history to a different provider is a serious failure of that premise, quite apart from the confusing `404 model not found` that usually follows. The chat screen also has no guard for it: `blocked` is computed as `profile && !profile.hasKey ? … : undefined` ([app/chat/[id].tsx:191](app/chat/[id].tsx:191)), so a **missing** profile produces no block at all and *Send* stays enabled.
- **Reproduction:**
  1. Create a second provider profile with a valid key and start a conversation on it.
  2. Settings → Providers → Danger zone → delete that profile.
  3. Reopen the conversation.
  4. **Expected:** a banner saying the provider was deleted, *Send* disabled, and an offer to reassign the conversation to another profile.
  5. **Actual:** the conversation opens normally and *Send* is enabled. Sending dispatches the request to whichever profile is currently active, using the original conversation's model id.
- **% of users affected:** ~15% — anyone who tries more than one gateway and cleans up, which is this app's core use case.
- **Suggested fix:** keep the crash-proof fallback but make it visible and non-silent. Extend the `blocked` computation to `!profile` with the message "The provider for this conversation was deleted. Choose another in Model controls.", and add a *Reassign provider* row to the conversation sheet. Deleting a profile should also offer, at the confirmation step, to reassign or archive its conversations — the count is a single query away.
- **Related section:** 5.5 Graceful Degradation

---

## What works well

**1. The palette was designed for contrast, and it mostly succeeds.** `text`, `textDim`, `danger`, `warning`, `success` and `thinkingText` all clear 4.5:1 against all three surface levels in **both** themes. Three deliberate surface levels rather than opacity stacking, a single accent instead of colour-coded everything, and errors expressed as sentences rather than as red — so a failure is legible without perceiving colour at all. `textFaint` is the one colour that missed, and it missed because it is doing more work than a "faint" tone should. The structure is right; one value needs moving.

**2. Tab order is logical with no traps, and decorative content is correctly hidden.** ~20 stops on Home and 19 in a conversation, all in visual order, nothing skipped, nothing looping. The `⋯` control, the back button, the sheet backdrop, the thinking toggle and the composer all carry real accessible names — and the thinking toggle's name includes its word count, so it announces "Thinking, 11 words" rather than "toggle". The initials avatar on every conversation row is explicitly `accessible={false}`, which is the difference between hearing "Machine Learning Basics" and hearing "M L, Machine Learning Basics". Someone was thinking about what a screen reader should *not* say, which is rarer than thinking about what it should.

**3. Degraded states are named, not hidden.** *"Nothing discovered yet. Refresh from the gateway, or add a model id by hand below."* *"No provider profiles. Add one first."* *"Paste an API key first."* Capability guesses wear a `guessed` badge; models that vanished from a gateway wear `unlisted` and keep the user's hand-edited flags; search results say whether they came from the `index` or a `scan`; and when the full-text index turned out to be unavailable in this build, the app fell back to a linear scan, logged why, kept working and labelled every result accordingly. An app that tells you which of its facts are inferred is an app you can trust with the ones it asserts — and for a screen-reader user, who cannot glance at the whole screen to infer context, those explicit statements are the whole interface.

---

## Summary

| ID | Severity | Issue |
|---|---|---|
| MORGAN-01 | Critical | No focus indicator anywhere (26/26 stops measured `outline: none`) |
| MORGAN-04 | Critical | No text input has an accessible name; setup impossible with TalkBack |
| MORGAN-02 | High | Message bubbles are focusable buttons with no keyboard activation |
| MORGAN-03 | High | Sheets do not trap focus; Escape does not dismiss |
| MORGAN-05 | High | Thinking switch, token gauge and "All" chip lack names or state |
| MORGAN-06 | High | `textFaint` fails WCAG AA (2.75–4.13:1) across surfaces and themes |
| MORGAN-08 | High | Deleted provider silently re-routes conversations to another gateway |
| MORGAN-07 | Medium | 11pt type carries meaning, below the 12pt floor |

**Not verified:** TalkBack itself, which needs a physical Android device. The findings above are all derived from accessibility properties present or absent in the tree, which is where the defects are — but the *quality* of announcements (ordering, verbosity, interruption behaviour during streaming) needs a real reader and a real device.

Morgan's verdict: the foundations are unusually good — a contrast-conscious palette, coherent tab order, honest empty states, correctly hidden decoration — and then three shared components withhold the names and the focus ring that make any of it usable. Two of the three Critical findings in this entire test programme are here, and both are single-component fixes.

