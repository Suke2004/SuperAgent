# Agent 1 — MAYA, The New User

> **Historical record — see [the status box on the consolidated report](00-consolidated-report.md)
> before trusting anything below.** Dated 2026-09-01, against a Phase 1 app then called
> AgentRouter Mobile; it is now SuperAgent. Maya's own findings have since been
> addressed: the hardcoded probe model is `pickProbeModel`
> ([openai.ts:276](src/transports/openai.ts:276)), which now also says *"switch the
> profile to a listed model"* rather than reporting `403`; the offline gap is
> [OfflineBanner.tsx](src/components/OfflineBanner.tsx); and the model name reached the
> header. Kept unedited because the first-run timings here are the only ones measured
> against a live gateway with real credentials.

**Persona.** First-time user. Has an API key from a gateway a friend recommended, no mental model of "transports", "profiles" or "capability flags". Wants to be talking to a model inside two minutes.

**Session.** Fresh database, real gateway (`https://api.justwoker.icu/`, OpenAI-compatible, model `claude-opus-5`), web export of the Expo app driven through Chrome DevTools, with a local CORS proxy standing in for Android's absence of CORS. Timings are wall-clock from the harness; anything that could not be measured off-device is marked.

**Scenarios run.** 1.1 Initial Setup · 1.2 First Message · 1.3 Navigation & Discovery · 1.4 Error Recovery.

---

## 1.1 Initial Setup

Adding the gateway took **8 taps**, against the 4–5 target: Settings → Providers → *Custom URL* → Base URL field → API key field → Name field → *Save & use* → *Test connection*. The two text-entry stops are unavoidable; the excess comes from the transport picker sitting above the fields with no default, and from the connection test being a separate deliberate action rather than part of saving.

Instruction copy is a genuine strength. The transport picker explains itself in one sentence ("AgentRouter is the default: paste its API key and the app supplies the correct URL. Choose Custom URL only for another compatible gateway."), and the key field says exactly where the secret goes ("Saved only in the Android Keystore. It is never written to app storage or logs.").

The discovery progress indicator works: *Test connection* runs as visible ordered steps with per-step durations, and model discovery reported four models (`claude-opus-4-8`, `claude-opus-4-8-thinking`, `claude-opus-5`, `claude-opus-5-thinking`).

And then it failed anyway.

### MAYA-01 · Connection test reports failure for a working gateway, and the default model is never updated by discovery

- **Severity:** Critical
- **Frequency:** Always (on any gateway that does not serve Anthropic's current model ids)
- **Impact:** The single most important moment in the app — "is my key working?" — returns a red failure for a gateway that is working perfectly. The new user's only reasonable conclusion is that the key or the URL is wrong, and the next action is to re-check credentials that were never the problem. Compounding it, the first message a user sends is addressed to a model this gateway does not serve, so the recovery path also fails.
- **Reproduction:**
  1. Settings → Providers → *Custom URL*.
  2. Base URL `https://api.justwoker.icu/v1`, paste the API key, name it `claude`, *Save & use*.
  3. Tap *Test connection*.
  4. **Expected:** discovery succeeds, then a chat probe against a model this gateway actually serves, and a green result.
  5. **Actual:** `Model discovery worked but claude-opus-4-8 could not be called: 403 Forbidden.` `claude-opus-4-8` was chosen by the app, not by the user.
  6. Leave Settings, start a new conversation and look at the model in the empty state.
  7. **Expected:** one of the four discovered models.
  8. **Actual:** `claude-opus-4-6` — a hardcoded id that appeared in neither the discovery result nor the probe.
- **Root cause:** `pickProbeModel` in [openai.ts:772](src/transports/openai.ts:772) carries a hardcoded `preferred` list and prefers it over the configured model; [anthropic.ts:275](src/transports/anthropic.ts:275) mirrors it. Separately, `ingest` in [models.ts:142](src/stores/models.ts:142) never touches the profile's `defaultModel`, so a successful discovery leaves the seeded `claude-opus-4-6` in place.
- **% of users affected:** ~100% of Custom-URL users; near 0% of users on the built-in AgentRouter profiles, which is why it is easy to miss.
- **Suggested fix:** probe the profile's configured model first and fall back to `discovered[0]`, using the hardcoded list only when discovery returned nothing. In `ingest`, if the profile's `defaultModel` is not in the discovered set, set it to the first discovered id and say so in the test output ("Default model set to `claude-opus-5`."). Two small changes; they convert the worst first-run experience in the app into the best one.
- **Related section:** 1.1 Initial Setup

### MAYA-02 · Adding a provider takes 8 taps against a 4–5 target

- **Severity:** Medium
- **Frequency:** Always
- **Impact:** Setup is the only screen every user must complete and the only one they cannot skip. Each extra stop is a place to abandon.
- **Reproduction:**
  1. From Home, tap *Settings*.
  2. Tap *Providers*.
  3. Tap *Custom URL*.
  4. Tap the Base URL field, type it.
  5. Tap the API key field, paste.
  6. Tap the Name field, type.
  7. Tap *Save & use*.
  8. Tap *Test connection*.
  9. **Expected:** 4–5 taps.
  10. **Actual:** 8.
- **% of users affected:** 100%
- **Suggested fix:** run the connection test automatically on save (it is already non-destructive and already has a retry-free policy), and default the name to the base URL's host so the field can be skipped. That is 8 → 6. Getting to 5 means dropping the transport picker to a single "Paste your key or URL" field that infers the transport from the URL shape — the app already knows that `/v1` implies OpenAI-compatible and its absence implies Anthropic.
- **Related section:** 1.1 Initial Setup

### MAYA-03 · The Providers screen lists every profile three times

- **Severity:** Medium
- **Frequency:** Always
- **Impact:** With three profiles saved the screen renders nine profile rows across *Saved profiles*, *Switch active profile* and *Danger zone*. A new user reading top to bottom meets the same three names three times in three different visual treatments and has to work out that they are the same three objects. It also means the screen's length grows at 3× the rate of the user's profile count.
- **Reproduction:**
  1. Settings → Providers with the two seeded AgentRouter profiles plus one added profile.
  2. Read the screen top to bottom.
  3. **Expected:** one row per profile, with activation and deletion reachable from it.
  4. **Actual:** `SAVED PROFILES` lists all three; `SWITCH ACTIVE PROFILE` lists all three again as radios; `DANGER ZONE` lists all three again as *Delete …* rows.
- **% of users affected:** 100%
- **Suggested fix:** collapse to one section. Put the active-profile radio inline on the saved-profile row, and move *Delete* into the profile detail screen that the `›` already opens — deletion of a specific profile belongs next to that profile's settings, not in a shared list. Also consider not seeding two keyless AgentRouter profiles; they arrive labelled "No key" and are pure noise for a Custom-URL user.
- **Related section:** 1.1 Initial Setup

---

## 1.2 First Message

Typed "What can you help me with?" into a fresh conversation. The composer is unmistakable — full-width input, `Message` placeholder, a primary *Send* button beside it — and the input is where a phone user's thumb already is. Streaming rendered token by token, and the reply's footer gave a real accounting: `5:41 PM · 7.2k in · 329 out · 0 thinking`.

Two problems, one of them the reason the app feels slow.

### MAYA-04 · Time to first token is 2.6–3.1s, and the waiting state does not acknowledge it

- **Severity:** Medium
- **Frequency:** Always on this gateway
- **Impact:** The target is under 500ms. Measured 2.6s, 3.1s and under 3.5s on the second turn. The gateway is the direct cause — it injects a large hidden system prompt, which is why a 6-token question bills 7,200 input tokens — so the app cannot fix the latency. But it can fix the *experience* of the latency, and right now the only feedback is a small `Streaming · 0s` label with an elapsed-seconds counter, which reads as "nothing is happening" for the first two seconds and does not distinguish "connecting" from "the model is thinking" from "tokens are arriving".
- **Reproduction:**
  1. New conversation, model `claude-opus-5`.
  2. Send "What can you help me with?" and time the first visible character.
  3. **Expected:** first token under 500ms, or an explicit acknowledgement that the request is in flight.
  4. **Actual:** 2.6–3.1s of a static `Streaming · 0s` label, then text.
- **% of users affected:** 100% on gateways with a comparable prompt overhead.
- **Suggested fix:** name the phases the store already tracks — `connecting` → `waiting for the model` → `streaming` — instead of labelling all of them "Streaming", and show an indeterminate pulse rather than a `0s` counter until the first byte. If the response has not started after ~2s, add a one-line hint that the gateway prepends a system prompt, which also explains the input-token count that is about to surprise the user.
- **Related section:** 1.2 First Message

### MAYA-05 · The model name disappears as soon as the conversation has messages

- **Severity:** Medium
- **Frequency:** Always
- **Impact:** "Which model am I talking to?" is the question a new user asks most often after the first reply, and the app answers it only in the state where there is nothing to read. The empty state says `Send a message and claude-opus-5 answers below.`; the moment a message exists that text is replaced by the transcript, and the header shows only the conversation title. The model is then three taps away (`⋯` → *Model*), and each assistant footer carries usage but not the model id.
- **Reproduction:**
  1. Open a new conversation. Note `claude-opus-5` in the empty state.
  2. Send any message and wait for the reply.
  3. **Expected:** the model stays visible, e.g. as a header subtitle.
  4. **Actual:** the header shows the title alone; the model id is not on screen anywhere.
- **% of users affected:** 100%
- **Suggested fix:** put the model id in the navigation header as a subtitle under the title. The conversation-options sheet already renders exactly this string (`claude-opus-5 · 6 messages`), so the value and the formatting exist; they are one level too deep.
- **Related section:** 1.2 First Message

---

## 1.3 Navigation & Discovery

This scenario went well and is worth stating plainly, because it is the counterweight to the setup findings.

From Home, everything in the brief is reachable in **one tap or zero**: *New conversation*, *Settings* and *Debug log* are visible buttons, and the search field is always on screen and needs no tap to find (one to focus). Settings is therefore **1 tap** from Home and **2** from a conversation, inside the ≤2 target. The model selector is **3 taps** from a conversation (`⋯` → *Model* → the id) and the sheet is correctly scoped: "Applies to the next message, not the ones already sent."

Auto-titling is the standout. Sending the first message renames the conversation from its placeholder to a summary of what was asked, so Home is readable after a week without the user ever naming anything.

## 1.4 Error Recovery

Tested by stopping the gateway entirely and sending cold, twice. No crash, no stuck spinner, no lost draft, and the error text is plain English with an actionable second clause: *"Could not reach the gateway at all. Check connectivity, or try the backup domain."* The failure surfaced after **7.6s** on the first attempt and **5.6s** on the second — that is the retry policy doing its job with exponential backoff, and the turn is correctly marked `Failed · 7s · claude-opus-5`.

What goes wrong is the cleanup.

### MAYA-06 · A failed turn leaves permanent debris in the transcript, and *Dismiss* does not remove it

- **Severity:** High
- **Frequency:** Always, on every failed turn
- **Impact:** Every failure permanently scars the conversation. The transcript keeps an empty assistant bubble reading *"This message has no content. It was probably interrupted before the first token."*, with the error string baked in beneath it and a footer of `0 in · 0 out`, and *Dismiss* clears only the banner. After two offline sends the conversation contained two of these stubs interleaved with real content, and they are now part of the history that gets sent back to the model on the next turn. The same error text is also shown twice at once — once inline in the transcript, once in the banner — which reads as two separate failures. And there is no route back to whatever caused it: the only buttons are *Try again* and *Dismiss*.
- **Reproduction:**
  1. Open a conversation with existing messages. Make the gateway unreachable.
  2. Type anything and tap *Send*.
  3. Wait ~7s for `Failed`.
  4. **Expected:** the error is transient; dismissing it removes the failed turn, or offers *Remove this attempt*.
  5. **Actual:** an empty assistant bubble with the error text inside it, plus the same text in the banner. Tap *Dismiss* — the banner goes, the stub and its embedded error text stay, permanently.
  6. Reload the app. The stub is still there, and Home's row preview for that conversation now reads *"No messages yet"* because the preview is taken from the last message's text (see [Jordan's report](03-jordan-researcher.md)).
- **% of users affected:** 100% of users who ever lose connectivity mid-request — on mobile, effectively everyone.
- **Suggested fix:** treat a turn that produced zero content blocks as a failed *attempt*, not a message: keep it in the store for the retry, drop it from the transcript when the error is dismissed. Where a partial response exists, keep the partial text but move the error out of the message body into the transient banner so the transcript holds only model output. Add *Edit request* alongside *Try again* so a failure caused by a bad parameter has a route back to the field.
- **Related section:** 1.4 Error Recovery

### MAYA-07 · Nothing anywhere in the app indicates that the gateway is unreachable

- **Severity:** High
- **Frequency:** Always, while offline
- **Impact:** The app looks completely healthy with no network. Launched with the gateway down, it booted cleanly and rendered all seven conversations, their previews, the tag chips and the `TODAY · 7` grouping from local SQLite — and the banner at the top of Home still advertised `http://localhost:8742/v1 · claude-opus-5` exactly as it does when connected. There is no indicator anywhere: not on Home, not in the chat header, not in the composer. The user discovers they are offline by composing a message, sending it, and waiting seven seconds for a failure.
- **Reproduction:**
  1. Use the app normally so conversations are cached.
  2. Stop the gateway (or enable airplane mode) and relaunch.
  3. **Expected:** conversations still readable, plus a visible offline or "gateway unreachable" state.
  4. **Actual:** conversations render perfectly; the gateway banner is unchanged; sending fails after 7.6s.
- **% of users affected:** ~90% — anyone who uses the app on a phone will hit a dead zone.
- **Suggested fix:** the store already knows the last request failed with `kind === 'network'`. Use it: tint the gateway banner and append *· unreachable*, and show a one-line strip above the composer. Offline reading works genuinely well here, so the fix is purely about telling the truth in the banner, not about new capability.
- **Related section:** 1.4 Error Recovery · overlaps Casey 4.3 and Morgan 5.4

---

## What works well

**1. The connection test is the most honest diagnostic I have seen in a mobile client.** It runs as ordered steps, each with its own duration, and it quotes the gateway's own words rather than paraphrasing them. `Model discovery worked but claude-opus-4-8 could not be called: 403 Forbidden` told me exactly which call failed, with which model, and what the server said. The bug in MAYA-01 is that it probes the wrong model — but the reason I could diagnose that in one read is the quality of this screen. Fix the model choice and this becomes a genuine feature.

**2. Disabled controls explain themselves in visible text, not in a tooltip.** `Button` renders its `disabledReason` as a line of copy under the button and also exposes it as an accessibility hint, so *Save & use AgentRouter* sits above the words "Paste an API key first." A new user never has to guess why a button is grey. This is a pattern most apps get wrong, and it is applied consistently — the composer does the same thing with a full-width note when sending is blocked.

**3. Navigation costs nothing and the app names conversations for you.** Search, *New conversation*, *Settings* and *Debug log* are all on the Home screen at zero or one tap, and the first message auto-titles the conversation, so after a week of use Home is a readable list of topics instead of a column of "New chat". For a persona who does not yet know what any of the settings mean, being able to ignore all of them and still end up with an organised app is the difference between coming back and not.

---

## Summary

| ID | Severity | Issue |
|---|---|---|
| MAYA-01 | Critical | Connection test probes a hardcoded model; discovery never updates `defaultModel` |
| MAYA-06 | High | Failed turns leave permanent empty bubbles with the error baked in |
| MAYA-07 | High | No offline or gateway-unreachable indicator anywhere |
| MAYA-02 | Medium | Provider setup takes 8 taps against a 4–5 target |
| MAYA-03 | Medium | Providers screen lists every profile three times |
| MAYA-04 | Medium | 2.6–3.1s to first token with a misleading `Streaming · 0s` label |
| MAYA-05 | Medium | Model name visible only in the empty state |

Maya can get to a working conversation, and once there the app is pleasant and fast to navigate. She cannot get there *without help*, because the one screen that is supposed to confirm her setup tells her it failed when it succeeded.

