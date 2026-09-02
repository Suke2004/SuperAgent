# 07 — Deployment

**SuperAgent · Build, Release, Rollback and Support**

| | |
|---|---|
| **Version** | 1.3 |
| **Status** | Current — 1.0.0 built, v1.1 feature work landed and unreleased; alpha distribution, no store listing yet |
| **Audience** | Whoever is cutting a release, and whoever has to undo one |
| **Distribution** | Direct Android APK (EAS `preview` / `production`), with an EAS Update channel per profile for JavaScript-only fixes, plus a static web export for layout checks |
| **Companion docs** | [05_Data_Model.md](05_Data_Model.md) · [06_Eng_Plan.md](06_Eng_Plan.md) · [PRD.md](PRD.md) · [TRD.md](TRD.md) · [GUIDELINES.md](GUIDELINES.md) · [flaws.md](flaws.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [progress.md](../progress.md) |

---

## Executive summary

This document is the operational runbook: how a commit becomes an APK on someone's phone, what must be true before that happens, how the release is communicated, and — the part that matters most — how it is undone when it turns out to be wrong. It is written to be followed under pressure, so the checklists are literal and the rollback procedure comes with commands rather than principles.

The deployment model is unusual and every decision here follows from it. There is **no server to deploy**, so there is no blue/green, no canary percentage, and no feature flag service. There is **no store listing yet**, so distribution is a direct APK link to a known list of testers. There is **no telemetry**, so a bad release is discovered by a human telling us, which means the release must be communicated well enough that testers know what to look for and reachable enough that they can tell us quickly. And crucially: **an APK that crashes on launch cannot be fixed remotely.** `expo-updates` can push a JavaScript-only fix over the air, but only to an app that gets far enough to check for updates. A native crash or a startup failure is beyond its reach, and the only recovery is for every affected user to install the previous APK by hand.

That asymmetry drives the two hard rules in this document. First, **the build checklist in §6.2 is all-or-nothing** — every gate green, plus a physical-device pass on two real handsets, before an artefact is shared with anyone. Second, **the previous release's APK is kept, downloadable, and its exact commit tagged**, forever, because rollback is a re-install and re-installs need a file.

Read §6 to cut a release, §7 to run the device protocol, and §10 before you need it rather than while you need it. Version, artefact and cadence policy is in §2 and §9.

---

## 1. Build artefacts

| Artefact | Produced by | Purpose | Distributed to | Retained |
|---|---|---|---|---|
| **Preview APK** | `pnpm run build:preview` (`eas build -p android --profile preview`) | The normal release artefact today | beta testers, direct link | every release, forever |
| **Production APK** | `pnpm run build:production` | 1.0 and after; store-ready signing, `autoIncrement` on | public | every release, forever |
| **Development build** | `pnpm run build:dev` | Native debugging with the dev client | maintainer only | not retained |
| **Local APK** | `pnpm run build:preview:local` | Build without EAS queue time; offline. Needs Android SDK tooling and a path with no spaces — see [flaws.md](flaws.md) §6 | maintainer only | not retained |
| **OTA update** | `pnpm run update:preview` / `update:production` | A JavaScript-only fix reaching an installed APK without a re-install | whoever is on that channel | EAS retains the manifest |
| **Android export** | `npx expo export --platform android` | The fourth gate: catches an unresolvable route | CI and maintainer | deleted after the check |
| **Web export** | `npx expo export -p web` | Layout and Markdown-rendering checks on a large screen (iPad, desktop) | maintainer only | not retained |
| **Release notes** | hand-written, per tag | What changed, what to look for, what is known-broken | testers, in the release | with the tag, forever |
| **Source tag** | `git tag vX.Y.Z` | The exact commit an artefact came from | repository | forever |

Two retention rules that are not optional:

**Every shipped APK is kept and stays downloadable.** Rollback is a re-install (§10). An artefact that has been deleted is a rollback that cannot happen.

**Every shipped APK has a tag pointing at its exact commit.** "The build from last Tuesday" is not a recoverable state. EAS retains build metadata, but the tag is what lets someone rebuild from source when EAS's retention window has passed.

**An OTA update is not an artefact you can roll back by re-installing.** It reaches a device that already has an APK, so undoing one is `pnpm run update:rollback` (§10.2), not a file. And it can only ever carry JavaScript: the `runtimeVersion` policy is `appVersion`, so an update is scoped to the native surface its APK was built with. Anything touching a native module, a config plugin or `app.json` is a build.

**The web export is a diagnostic, not a product.** It is genuinely useful — it renders Markdown and layout on a screen large enough to see spacing problems, and an iPad is a fast way to check both. But it is not a supported target: there is no browser Keystore, so a key lives in a page variable for the session and nowhere else (deliberately not `localStorage`, which any injected script can read and which survives the tab closing). The app says so on screen once per session. Nothing sensitive should be entered into a web export.

---

## 2. Versioning

### 2.1 Semantic versioning, interpreted for a client app

`MAJOR.MINOR.PATCH`, where the promise being versioned is **the user's data and habits**, not an API:

| Bump | Meaning here | Examples |
|---|---|---|
| **MAJOR** | A user must do something, or something they relied on is gone | a migration that cannot be reversed; removing a provider kind; changing where keys are stored |
| **MINOR** | New capability, everything existing keeps working | attachments; MCP tools; the summarise strategy |
| **PATCH** | Fixes and polish only, no new surface | error-message wording; an index; a crash fix |

A **schema migration alone does not force a MAJOR bump** — additive, defaulted migrations ([05_Data_Model.md](05_Data_Model.md) §10.1) are invisible to the user. What forces MAJOR is *irreversibility*: once a device has run a migration that a previous app version cannot read, rolling back that device means data loss. Any migration with that property must be called out in the release notes and shipped as a MAJOR, precisely so that a rollback decision is made with the cost visible.

### 2.2 The four version numbers, and how they relate

There are four, they are not the same thing, and confusing them is how an OTA update reaches a binary that cannot run it.

> **OTA is on.** `app.json` sets `updates.enabled: true` with
> `checkAutomatically: "ON_LOAD"` and `fallbackToCacheTimeout: 0`. It was switched *off*
> once, on the reasoning that nothing in the repo published a bundle; that stopped being
> true and the decision was reversed in `0803d51` — both halves are kept in
> [flaws.md](flaws.md) §2.7 with the trade written out. Everything below about channels,
> `runtimeVersion` and Path B is live. The outstanding piece is **`expo-updates` code
> signing**, which is what would remove the remaining trust in the EAS project id;
> §2.7 records it as open rather than closed.
>
> One consequence worth stating here because it changes what a hotfix feels like: a
> downloaded bundle takes effect on the **next cold start**, and a chat app is one people
> leave resident for days. Settings shows a *Restart to finish updating* row while one is
> pending (`useUpdates().isUpdatePending`), so the wait is optional — doing nothing
> arrives at the same place.

```
app.json                                       meaning
├─ expo.version           "1.0.0"    ← the SemVer users see; also the
│                                       runtimeVersion source (policy: appVersion)
├─ expo.android.versionCode  1       ← monotonic integer; Android's upgrade
│                                       comparison. MUST increase every build
│                                       that is installed over another
├─ expo.runtimeVersion.policy "appVersion"
│                                    ← the native/JS compatibility fence:
│                                       an OTA bundle only reaches binaries
│                                       whose version string matches
└─ expo.updates.url  https://u.expo.dev/<projectId>
                                     ← where the app checks for OTA bundles

eas.json
└─ cli.appVersionSource  "local"     ← version lives in app.json, in git —
                                        not in EAS's remote counter
```

**`appVersionSource: "local"`** means git is the source of truth for the version. The alternative, EAS's remote auto-increment, is convenient and produces a repository where you cannot tell from the source what version a commit built. With `local`, the version bump is a reviewable commit, and `git tag v1.2.0` and `app.json` cannot disagree.

**`runtimeVersion.policy: "appVersion"`** is the safety property that makes OTA updates usable at all. An OTA bundle is JavaScript; if the JS expects a native module the installed binary does not have, the app crashes on load — and now it crashes *because of an update*, which is the worst failure mode available, since the user cannot undo it. Tying `runtimeVersion` to the version string means a bundle only ever reaches binaries built from a compatible version. The rule that follows: **any change that touches native code — a new Expo module, an SDK upgrade, a dependency with native code — requires a version bump and a new build, never an OTA.**

### 2.3 The `versionCode` rule

`android.versionCode` is currently `1`. Android refuses to install a package whose `versionCode` is lower than the installed one, so:

- **Increment `versionCode` on every build that anyone installs.** Two artefacts sharing a `versionCode` cannot replace each other and produce a confusing "app not installed" failure.
- **Rollback needs a plan for this**, because the previous release has a *lower* `versionCode` and therefore cannot be installed over the bad one. §10 covers the two options: uninstall-then-install (loses data), or re-issue the old code under a higher `versionCode` (keeps data). Decide which before you need it.

---

## 3. EAS build profiles

All three profiles produce an Android **APK**, not an AAB. That is deliberate: distribution is a direct download today, and an AAB is only useful to the Play Store, which cannot install it for a tester on a link.

```jsonc
{
  "cli": { "version": ">= 12.0.0", "appVersionSource": "local" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "android": { "buildType": "apk" }
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "channel": "preview"
    },
    "production": {
      "autoIncrement": false,
      "android": { "buildType": "apk" },
      "channel": "production"
    }
  },
  "submit": { "production": {} }
}
```

| Profile | Signing | Channel | Used for | Who gets it |
|---|---|---|---|---|
| `development` | debug | — | native debugging with the dev client | maintainer |
| `preview` | internal release keystore | `preview` | **the current release path** | beta testers |
| `production` | production keystore | `production` | 1.0 onward | public |

**Channels are the OTA routing.** A build carries a channel; `eas update --branch <branch>` publishes a bundle to a branch, and the channel maps a build to the branch it listens to. The consequence worth internalising: publishing an update to the `preview` channel reaches every installed preview build whose `runtimeVersion` matches, immediately, with no review step. That is a powerful hotfix mechanism and an easy way to break every tester at once, so §10.2 gates it.

**`autoIncrement: false` on production** is a consequence of `appVersionSource: local`: the version comes from `app.json`, so EAS must not silently change it. The bump is a commit.

### 3.1 Pinned dependencies that exist for build reasons

These pins are load-bearing. Unpinning any of them without a device pass is how a build breaks in a way that looks unrelated.

| Package | Pin | Why |
|---|---|---|
| `react-native-reanimated` | `4.5.1` | C++ ABI compatibility with Expo SDK 57; a mismatch crashes at native init |
| `react-native-worklets` | `0.10.4` | Must match the reanimated pin exactly |
| `expo-updates` | `57.0.18` | Satisfies EAS's `minimumReleaseAge` policy; a newer version was rejected by the build servers |

Supporting configuration that is equally load-bearing: `.npmrc` sets `legacy-peer-deps=true`; `pnpm-workspace.yaml` uses the pnpm v11 `allowBuilds` syntax (`onlyBuiltDependencies: unrs-resolver`) so EAS's build servers permit that package's install script; `metro.config.js` adds `wasm` to `assetExts` for the syntax highlighter. Each of these was a build failure before it was a line of config, which is why they are listed rather than left to be rediscovered.

---

## 4. The pipeline, end to end

```
 DEVELOPER                CI (GitHub Actions)          EAS                  DEVICE
     │                          │                       │                     │
     ├ branch, commit           │                       │                     │
     ├ push ──────────────────► │                       │                     │
     │                          ├ pnpm install --frozen-lockfile              │
     │                          ├ typecheck ─┐          │                     │
     │                          ├ lint       ├ GATE 1-3 │                     │
     │                          ├ test       ┘          │                     │
     │                          │                       │                     │
     │  ◄─── red: fix and push again ───┤               │                     │
     │                          │ green                 │                     │
     ├ merge to main ─────────► │ (gates run again)      │                     │
     │                          │                       │                     │
     ├ bump version + versionCode in app.json           │                     │
     ├ update CHANGELOG.md      │                       │                     │
     ├ git tag vX.Y.Z ────────► │ build-apk.yml          │                     │
     │                          ├ gates AGAIN ──────────►│                     │
     │                          ├ eas build --profile   ├ queue               │
     │                          │   preview --no-wait   ├ install deps        │
     │                          │                       ├ prebuild            │
     │                          │                       ├ gradle assemble     │
     │                          │                       ├ sign                │
     │                          │  ◄── artefact URL ────┤                     │
     │  ◄── download APK ───────┴───────────────────────┘                     │
     │                                                                        │
     ├ GATE 4: physical device protocol (§7) on Pixel 6 + Samsung S22 ────────►│
     │         (and iPad for the web export, layout only)                     │
     │                                                                        │
     ├ ✗ fail → do not distribute; fix, new patch version, start over         │
     ├ ✓ pass → publish release notes + APK link to testers ─────────────────►│
     │                                                                        │
     └ watch: tester reports, no telemetry ◄──────────────────────────────────┘
```

The gates run three times (PR, merge, tag) and that is intentional. A tag can point at any commit; re-running costs about a minute of CI and removes the possibility of a release built from something that never passed.

**Gate 4 is human and it is not optional.** Nothing before it covers rendering, gestures, or real network transitions ([06_Eng_Plan.md](06_Eng_Plan.md) §7.1). An artefact that has not been on a physical handset has not been tested; it has been type-checked.

---

## 5. Environments

There are four, and only two of them can tell you anything about real behaviour.

| Environment | What it is | Fidelity | Good for | Blind to |
|---|---|---|---|---|
| **Local dev** | Metro + Expo Go / dev client on the maintainer's handset | high for JS, partial for native | iteration, logic | release-mode perf, minification, signing |
| **Android emulator** | AVD on a desktop | medium | flows, layout, migrations, permission dialogs | scroll performance (desktop CPU), real network transitions, camera, Keystore backing |
| **Physical devices** | Pixel 6 (reference), Samsung S22 (second) | **the truth** | everything | nothing that matters |
| **Web export** | static export in a browser / iPad Safari | low | Markdown rendering, large-screen layout | all native behaviour; there is no Keystore, so a web key is session memory only |

The emulator's most dangerous property is that it makes scrolling look fine. A desktop CPU renders a 1,000-message FlashList smoothly while a mid-range phone drops frames, so every performance target in [06_Eng_Plan.md](06_Eng_Plan.md) §12 is defined on the Pixel 6 and emulator numbers are recorded but never used as a gate.

**Beta testers are the fifth environment**, and the only one with real usage patterns: real key management, real network conditions, real conversation lengths. Five to ten of them, known by name, because with no telemetry the feedback channel is a conversation.

---

## 6. Release process

### 6.1 The steps

```bash
git switch main && git pull
```

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm run gates
```

Then, in order:

1. **Bump the version.** `pnpm run release:patch` (or `minor`/`major`) sets `expo.version` per §2.1 and increments `expo.android.versionCode`, via `scripts/bump-version.mjs`. One commit, message `chore(release): vX.Y.Z`.
2. **Write the release notes** into `CHANGELOG.md` (§11), including the "what to look for" and "known issues" sections. Written before the build, so it reflects what was intended rather than what is remembered afterwards. Mark every entry that **needs a rebuild** — an OTA update cannot deliver it.
3. **Tag.** `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push --follow-tags`. The tag triggers `build-apk.yml`.
4. **Wait for EAS**, then download the APK from the build page.
5. **Run the device protocol** (§7) on both handsets. Record the result in the release notes, including anything that was checked and looked odd but was accepted.
6. **If the protocol fails:** stop. Do not distribute. Fix, bump PATCH, and start again at step 1. A failed protocol never becomes "ship it and note it".
7. **Distribute**: APK link plus release notes to the tester list.
8. **Archive**: the APK stored where it stays downloadable, filed under its tag.
9. **Update `progress.md`** with the release, the real gate output, and any decision made during the release.

### 6.2 Build checklist — every line must be true

**Source**
- [ ] On `main`, up to date, working tree clean (`git status` empty)
- [ ] Lockfile unchanged by the install (`--frozen-lockfile` did not error)
- [ ] No debug-only code: no `mirrorToConsole` left on, no hard-coded origin, no test key
- [ ] No stale `dist/` from the export gate left behind

**Gates**
- [ ] `pnpm run typecheck` — clean
- [ ] `pnpm run lint` — clean
- [ ] `pnpm test` — all pass; count recorded in the release notes, not remembered
- [ ] `npx expo export --platform android` — succeeds, then `dist/` removed
- [ ] Coverage above the floors in `jest.config.js`, and the floors not lowered to get there
- [ ] CI green on the tagged commit

**Version**
- [ ] `expo.version` bumped per §2.1
- [ ] `expo.android.versionCode` incremented
- [ ] Tag matches `expo.version` exactly
- [ ] If any migration is irreversible, this is a MAJOR and the notes say so
- [ ] `SCHEMA_VERSION` in `src/db/ddl.ts` matches the migrations actually present, and no landed migration was edited

**Security**
- [ ] Redaction tests present and passing ([06_Eng_Plan.md](06_Eng_Plan.md) §7.3)
- [ ] No API key in the repository, the lockfile, `app.json`, `eas.json`, or CI secrets
- [ ] `EXPO_TOKEN` is the only CI secret
- [ ] Exported/shared artefacts from testing contain no key (spot-check one)
- [ ] `allowBackup="false"`, the `dataExtractionRules` exclusions, `expo.sqlite.useSQLCipher=true` and `cleartextTrafficPermitted="false"` all confirmed in the *generated* project, not just in the plugin source
- [ ] `allowWebFetch`, `allowWebSearch` and `allowRunCode` still default to false
- [ ] The WebView CSP is still `default-src 'none'` and was not widened to make something render

**Device (§7)**
- [ ] Pixel 6 protocol pass, steps 1–33 and 36–68
- [ ] Samsung S22 protocol pass, steps 1–33 and 36–68
- [ ] iPad web-export layout check, steps 34–35 (Markdown, spacing, tap targets)
- [ ] Performance spot-checks: cold start, 1,000-message transcript, mid-stream backgrounding
- [ ] The build is new enough to contain every native module the release notes claim

**Release**
- [ ] `CHANGELOG.md` updated with changes, what to look for, and known issues
- [ ] Every entry that needs a rebuild is marked as such
- [ ] APK size recorded and compared with the previous release (§8)
- [ ] Previous release's APK still downloadable and its tag still present
- [ ] Rollback plan for *this* release written down (§10 — which option, and why)

---

## 7. Physical-device test protocol

Three devices, three different jobs. The protocol is scripted because a freeform "have a play with it" pass finds the bugs you already expect.

| Device | Role | Why this one |
|---|---|---|
| **Pixel 6** (Android 14) | reference | Stock Android, mid-range GPU by current standards, the device every performance target is defined on |
| **Samsung Galaxy S22** | second implementation | One UI changes gesture handling, keyboard behaviour, back-navigation and battery optimisation — the most likely source of a bug the Pixel does not show |
| **iPad** (Safari, web export) | large-screen layout | Fast way to see Markdown rendering and spacing at width. **Layout only** — never enter a real key |

### 7.1 The protocol

Run in order. Each step has a pass condition; "seems fine" is not one.

**A. Install and first run**
1. Install the APK over the previous version (do not uninstall first). → Installs; existing conversations, providers and settings all present.
2. Cold start, stopwatch. → Interactive in <2 s.
3. No key configured: attempt to send. → A clear "no key saved" message naming Settings → Providers, **not** a 401.

**B. Setup**
4. Add a provider, paste a key, run Test connection. → Steps reported individually; success on the last.
5. Check the key display. → Fingerprint only (`abcd…wxyz (51 chars)`), never the key.
6. Discover models. → Catalogue populates; a previously-set per-model override survives the refresh.

**C. Chat and streaming**
7. Send a short message. → First token <1 s on Wi-Fi; text streams smoothly, not in one jump.
8. Send a message expecting a long reply; scroll up while it streams. → The view does **not** get yanked to the bottom; the content you are reading stays put.
9. Reply containing code, a table, a list, and a link. → All render; code highlighted; no raw Markdown leaking.
10. Background the app mid-stream, wait 20 s, return. → Either the stream continued or it failed cleanly with a readable error. No duplicate assistant message, no half-rendered bubble.
11. Force-stop mid-stream, relaunch. → The **user's** message is present. The partial reply is expected to be absent ([05_Data_Model.md](05_Data_Model.md) §12.3) — confirm the transcript is coherent, not corrupt.
12. Stop a stream with the stop control. → Stops promptly; the partial reply is kept and marked as stopped.

**D. Network failure**
13. Turn on airplane mode mid-stream. → Retries, then a `network` error with a retry affordance. Never a silent hang.
14. With `autoFailover` on, make the primary origin unreachable and send. → Fails over to the parity origin; the transcript's `meta` shows which origin answered.
15. Wi-Fi → cellular hand-off mid-stream. → Either completes or fails cleanly; no duplicated content.
16. Enter a deliberately wrong key and send. → `key_rejected` with a Settings hint. **Must not fail over** — check the log shows one origin, one attempt.

**E. Persistence and search**
17. Relaunch; open an old conversation. → Full transcript, correct order, previews match what the list showed.
18. Search a phrase from an old message. → Instant filter section and full-text section both behave; hits are justified by visible text.
19. Search a CJK phrase. → Results returned (via the `LIKE` fallback); no empty state where content exists.
20. Delete a conversation. → Gone, with its messages and tags. Open the usage report → **its spend is still there** ([05_Data_Model.md](05_Data_Model.md) §5.2).
21. Pin, archive, tag; relaunch. → All three survive; pinned group sits above `Today`.

**F. Scale and performance**
22. Open a seeded 1,000-message conversation. → First paint <2 s.
23. Scroll it hard, top to bottom. → No blank rows that stay blank; no visible stutter.
24. Open a list of 500 conversations. → <400 ms; scrolling smooth.
25. Attach several images, then scroll past them. → Memory stays under 250 MB in the profiler.

**G. Accessibility and touch**
26. Enable TalkBack; navigate the transcript. → Read in order; controls labelled.
27. Check tap targets on the composer, stop control and list rows. → All ≥44 dp; no accidental adjacent hits.
28. System font size at maximum. → No clipped text, no unreachable button.
29. Dark mode and light mode. → Contrast ≥4.5:1 for body text in both.

**H. Security spot-checks (every release, no exceptions)**
30. Open the debug log after several requests. → Key nowhere. `Authorization` / `x-api-key` values show `[REDACTED]`.
31. Copy the log; paste into a notes app; search for the key's first six characters. → No match.
32. Export a conversation whose system prompt contains a key-shaped string. → Redacted in the file.
33. Uninstall, then reinstall. → No conversations, no providers, no stored key; first-run state. **There is no in-app "clear all data" action** — Settings has backup, restore and per-item deletion, and nothing that wipes — so uninstalling is the only complete erase, and it is the one that must be verified ([05_Data_Model.md](05_Data_Model.md) §13.3). The database key goes with it, which is why a restored backup carries settings, providers, skills, prompts and servers but never keys or conversations.

**I. iPad (web export, layout only)**
34. Markdown-heavy reply at width. → Tables do not overflow; code blocks scroll rather than clipping; spacing sane.
35. Touch responsiveness of list and composer. → No hover-only affordances; nothing requires a mouse.

Everything from here on exists only in a build that includes the native module behind it.
Steps 36–68 are the ones the gates structurally cannot see ([flaws.md](flaws.md) §3), so a
release that skips them has verified nothing about them. Sections R, S and T (69–79) are
the exception in the other direction: no native module, so they run on any recent build —
but they are just as invisible to the gates, because what they check is a frame rate, a
gesture, a server this project does not run, and a synthesised voice.

**J. Attachments, and files arriving from elsewhere** (`expo-image-picker`, `expo-document-picker`, `intentFilters`)
36. Attach an image far over the edge limit. → Downscaled through the quality ladder and sent, not refused. The sheet says what it did.
37. Attach a file over its ceiling (a PDF >8 MB, a `.docx` >4 MB, a text file >1 MB). → Refused with the actual reason and the actual limit, not a generic failure.
38. Fill a conversation to twenty attachments, then try one more. → Refused, and the attach sheet shows remaining slots *before* the attempt.
39. From a file manager, "open with" → SuperAgent on a `.pdf`, a `.docx` and a `.txt`. → The app opens on a new conversation with the file attached. **Requires a build that has the `intentFilters` block**; on an older APK the app does not appear in the chooser at all, which is the expected failure, not a bug.
40. "Share to" from a gallery or file manager. → SuperAgent is **not** offered. `ACTION_SEND` is deliberately unhandled ([flaws.md](flaws.md) §3a) — if it *is* offered and then does nothing, that is a regression.

**K. Files the model writes** (`expo-file-system`, `expo-print`, `expo-sharing`)
41. Ask for a file (`write_file`), a PDF (`create_pdf`), and each of `.docx`/`.xlsx`/`.pptx` (`create_document`). → Five files land, each named safely, each referenced from the message.
42. Open each one. → Text previews inline, an image renders, a PDF opens in the system viewer, an Office file opens in the read-only preview **and says why it is read-only**.
43. Save one to a folder. → The system folder picker appears; the copy lands where chosen. Deny the picker → the share sheet appears as the fallback rather than a dead end.
44. Clear app data, relaunch. → The generated files are gone with it. They live in the app sandbox and are not backup-eligible.

**L. Speech** (`expo-speech`, `expo-speech-recognition`, `RECORD_AUDIO`)
45. Hold the composer microphone and dictate a sentence. → Text lands in the **draft**, editable before sending. Release mid-word → whatever was recognised is kept, not discarded.
46. Deny the microphone permission, then try again. → A readable explanation, not a silent no-op.
47. "Read aloud" on a reply containing code, a table and a heading. → Speaks the prose, skips what cannot be spoken sensibly, highlights the current run in the transcript. On Android the highlight moves a **paragraph** at a time — that is `expo-speech` reporting word boundaries on iOS only, not a bug.
48. Voice mode: enter, speak, let it send, hear the reply, speak again. → The loop closes without a tap. Change style and speed mid-session → both take effect on the next utterance. On a device with **no installed TTS voice**, the app says so rather than falling silent.

**M. What a reply can render** (`react-native-webview`)
49. A reply with a ```chart fence of each supported kind. → Bar, line and scatter draw with views and text. A spec with 7 series or 500 points → falls back to a code block **carrying the reason**, never an empty box.
50. A reply with an HTML artifact. → Opens in the panel. Try to make it navigate away or load a remote script → refused and reported. There is no route back into the app.
51. `run_code` with an infinite loop. → Abandoned after five seconds with a readable outcome, app still responsive.
52. A reply with mermaid, LaTeX and terminal output. → All three render; none of them execute.

**N. Motion, icons and gestures** (`react-native-gesture-handler`, `expo-blur`, `expo-linear-gradient`, `@expo/vector-icons`)
53. Open and close the drawer by drag, and by tap. → It follows the finger, settles in the same direction it came from, and is reachable without the gesture.
54. Long-press a message and a list row. → The menu opens **at the touch point**. Every action in it is also reachable from a visible control.
55. Swipe a conversation row. → The action fires; the same action exists in the row's own menu.
56. Turn on **Reduce Motion** in Android settings and repeat 53–55. → Decorative motion is gone; the drawer and sheets still move *from the edge they belong to*, only faster. A sheet that now appears instantly is a regression.
57. System font size at maximum, again. → Icons stay the size they were (they do not font-scale, by design) and nothing clips against a 36 dp disc. TalkBack still announces what each icon-only control does, because the meaning is on the label, not the glyph.

**O. Tools, approval and plan mode**
58. With `confirmToolCalls` on, trigger a tool. → The approval sheet appears; "always allow" survives a relaunch. Deny one → the model receives a `tool_result` saying so, and the conversation is not left hanging.
59. Turn on `run_code` and `fetch_url`, confirm they were **off** before you did. → Both default off, and so does web search.
60. In plan mode, ask for a file to be written. → Refused at the router with an explanation, and the refusal comes back as a tool result. No file appears in the document directory.

**P. Projects and context**
61. Put two conversations in a project with instructions and a knowledge document. → Both inherit the instructions; the document is fenced and labelled as source material in the request. Delete the project → the conversations survive with no project.
62. Drive a conversation to the context warning. → The pressure figure includes the tool manifest. Switch strategy to `summarise` → it summarises rather than truncating mid-reply.

**Q. The in-app camera** (`expo-camera`, `CAMERA`) — new in the 2026-09-02 build, and the
least emulator-faithful surface in the app. Every step here needs a phone; an AVD's virtual
camera will pass 63 and tell you nothing about 64–68.
63. Deny the camera permission at the prompt, then reopen the camera. → An explanation and an *Allow the camera* button, not a black screen. Deny it permanently ("don't ask again") → the button becomes *Open Settings* and lands on this app's permission page.
64. Hold the phone in portrait and photograph a page of text. → The preview is upright, the shot matches what the preview showed, and the text is legible in the review thumbnail. A preview that is rotated 90° or stretched is the classic `expo-camera` aspect-ratio failure and is a **release blocker**, not a cosmetic one.
65. Take four photos, drop the second by tapping it, then press *use*. → Three attachments land in the composer in the order they were taken, and the status line counted down correctly while shooting. Check the cache afterwards (`adb shell run-as org.lyric.agentrouter ls cache`) → **no leftover JPEGs**, including the dropped one.
66. Cycle the flash on the back camera in a dark room: `off → auto → on`. → The lamp actually fires on `on`, and `auto` fires only in the dark. Then switch to the front camera. → The cycle becomes `off → screen flash`, the mode resets to `off` rather than carrying `on` across, and screen flash brightens the display for the exposure.
67. Open the camera, then background the app and return. → The preview resumes. Open another app that uses the camera, then come back → either the preview resumes or the screen says the camera is in use; a frozen black rectangle with live buttons is a bug.
68. Fill a message to eight attachments, then open the camera. → The shutter is disabled with "that is as many photos as this message can carry", and the attach sheet said so before the camera opened.

**R. The drawer** — no new module, so this one *does* reach an installed build over the
update channel. It is still three things no gate can see: a group heading, a frame rate
and a gesture that has to lose an argument with a scroller.
69. Open the drawer on an account with chats older than a week. → Headings read *Pinned*, *Today*, *Yesterday*, *This week*, *Older*, each with a count, in that order, and nothing appears under a heading it does not belong to. A pinned chat from March is under *Pinned* and nowhere else.
70. Scroll the drawer through 400 chats. → It stays smooth and the account footer stays put at the bottom; the old build mounted every row and the list is now virtualised, so this is the step that proves it. Then drag *sideways* from the middle of the list → the panel follows the finger and closes. Drag vertically first, then sideways without lifting → the list keeps scrolling and the panel does not move. Both directions matter: one arbitration bug looks like the other from a distance.
71. Type into the drawer's search box. → Headings disappear and the list becomes one run under *Matches*, best match first. Close the drawer and reopen it → the box is **empty** and the whole history is back. Leave the app open past midnight, then reopen the drawer → yesterday's chats have moved out of *Today*, because the clock is re-read on each open.

**S. Connectors** — no new module either, so it also ships over the update channel. What
no gate can reach here is *someone else's server*. `catalog.test.ts` proves every bundled
URL is one the add form would accept; only these steps prove one still answers.
72. Settings → MCP servers → *Browse connectors*, and tap the first entry that says *No sign-in*. → The add form opens with the URL, transport and auth kind already filled in, and a note saying what the server can see. Save → it connects on its own and reports how many tools it found. If it does not, the entry is **stale**: fix the URL in `src/mcp/catalog.ts`, do not fix it only on the device.
73. Go back to *Browse connectors*. → That entry now carries an *Added* badge; the rest do not. Search for a connector by something other than its name — *issues*, *payments* — → it is found. Search for nonsense → an empty state that points at *Add by URL*, not a blank screen.
74. Tap an entry that says *Sign in*. → Save, then *Sign in* from its menu: the browser opens, and coming back lands in the app and discovers tools without a second tap. This is the one step that exercises dynamic client registration against a server nobody here controls.
75. In a conversation, open ⋯ and read the *Tools* row. → It names the writers, then whatever is switched on. Tap it → Settings → Built-in tools; turn *run code* on and come back → the row says `code`. Switch a server on from *MCP servers* → the row gains `N tools from 1 server`. Turn plan mode on → the row says *writing blocked* and the server tools say *blocked*, while `web pages` and `code` stay, because plan mode blocks by effect and those two read.

**T. Screen reader, motion and text size** — no new module, so this group ships over the
update channel too. It is the group with the widest gap between what the code says and
what a gate can prove: 87 `accessibilityLabel`s, eight live regions and a Reduce Motion
subscription are all invisible to typecheck, lint and Jest alike, and the transcript's
*absence* of a live region is a deliberate design decision that only TalkBack can confirm.
Run every step in this group with TalkBack actually on, not with it merely enabled.
76. TalkBack on. Send a message and wait without touching the screen. → When the turn ends, one announcement: *"Reply ready, N words"*. It must **not** read the reply as it streams — a transcript that re-reads itself from the top on every delta is the failure this design exists to avoid, and hearing the first sentence twice is the symptom. Press stop mid-reply → nothing is announced. Send another, background the app before it finishes → the notification banner arrives instead and nothing is spoken on return; exactly one of the two speaks per turn.
77. TalkBack on, open the drawer, then swipe-explore past its edge. → Focus stays inside the panel and never reaches the transcript behind it. Same for the ⋯ menu, an artifact preview and the camera. Then the back gesture → the surface closes rather than the app.
78. Turn Android's *Remove animations* on **while the app is open**. → The busy mark stops turning and breathes instead; the drawer opens without the page behind it shrinking; a button still dips under a finger, because the dip is what confirms the touch landed. Turn it back off → the spin returns, with no relaunch either way.
79. Android *Settings → Display → Font size*, largest setting. → Settings rows and message text grow and nothing is clipped or overlapped; the stepper's `−` and `+` stay inside their boxes and the icon discs are unchanged, because both opt out of scaling by design. Read one long reply end to end at that size → no horizontal scroll, and a code block still scrolls sideways on its own.

### 7.2 Recording the result

Every run produces a line in the release notes:

```
Device pass v1.2.0 — 2026-09-26
  Pixel 6 (Android 14):    79/79 pass
  Samsung S22 (One UI 6):  78/79 pass — step 8 (scroll anchor) shows a ~100 ms
                           settle after the keyboard dismisses. Accepted;
                           filed as issue #41, not a release blocker.
  iPad (Safari, web):      2/2 pass  (steps 34–35 only)
```

A partial pass is allowed only with the deviation named, its impact assessed, and an issue filed. "78/79, don't remember which one" is a failed pass.

**A step skipped because the build predates its module is a failed pass, not a partial
one.** Steps 36–68 each depend on a native module, and an APK built before that module
was added cannot exercise them at all — an OTA update does not change that, because
updates are scoped to the `runtimeVersion` their APK was built with. If the build is too
old, the answer is a rebuild, not an asterisk.

---

## 8. APK size

Target: **<60 MB**. The constraint is that this is a direct download, often over cellular, from a link — there is no store to stream it.

### 8.1 Where the bytes are

| Contributor | Rough share | Lever |
|---|---|---|
| React Native + Hermes runtime, per-ABI native libs | dominant | ABI splits; drop unused architectures |
| Expo modules actually linked | large | remove any module the app does not use — autolinking includes what is installed |
| JS bundle (minified, Hermes bytecode) | modest | tree-shaking; avoid barrel imports that defeat it |
| Syntax-highlighting grammars (`refractor`) + the `wasm` asset | modest | register only the languages that are rendered |
| Fonts and icons | small | subset; ship one icon family, not three |
| App icon and splash assets | small | compress; correct densities only |

### 8.2 The levers, in the order worth pulling

1. **Remove unused Expo modules.** Autolinking links whatever is installed. A module removed from `package.json` is native code removed from the APK — the highest-leverage single change available.
2. **ABI splits.** Shipping `arm64-v8a` alone (with `armeabi-v7a` only if a tester needs it) removes a full copy of every native library. The cost is that "the APK" becomes "the APK for your device", which matters for a direct-download distribution — so this is a decision to make consciously, not a default.
3. **Limit highlighter languages.** `refractor` grammars are cheap individually and expensive collectively. Register the ten languages people actually paste.
4. **Compress images properly.** PNG → WebP where alpha is needed, aggressive quantisation where it is not. Ship only the densities Android will use.
5. **Verify tree-shaking is actually happening.** Deep imports (`import x from 'lib/x'`) rather than barrels (`import { x } from 'lib'`) let the bundler drop the rest. Check the bundle, do not assume.
6. **Do not ship source maps in the APK.** Keep them for symbolication, out of the artefact.

### 8.3 Measuring, and the rule

```bash
npx expo export -p android --dump-sourcemap --output-dir /tmp/bundle-check
```

Record the APK size in every release's notes and compare with the previous release. **A size increase of more than 10% in one release requires an explanation in the notes.** Not a prohibition — a new native module can legitimately cost that — but an unexplained jump is usually an accidentally-linked dependency, and it is far cheaper to notice in the release than six versions later.

---

## 9. Release cadence

**Monthly, synchronised with Expo SDK releases.** Between releases, `main` accumulates merged work; nothing ships from `main` without a tag.

```
Month N              Month N+1            Month N+2
├─ Sprint A          ├─ Sprint C          ├─ Sprint E
├─ Sprint B          ├─ Sprint D          ├─ Sprint F
└─ RELEASE vX.Y.0    └─ RELEASE vX.Y+1.0  └─ RELEASE vX.Y+2.0
   (+ SDK check)        (+ SDK check)        (+ SDK check)

Off-cadence: PATCH releases for a P1 bug, any time (§10).
```

**Why sync with the SDK.** An Expo SDK upgrade is the highest-risk routine change this project makes — it moves React Native, Hermes, native module ABIs and the build toolchain at once, and it has already broken a build here (the reanimated/worklets ABI pin, §3.1). It therefore *requires* a full device pass. Doing the SDK upgrade in the same release window as the feature work means one device pass serves both. Doing them separately means two passes a month, which in practice means one of them gets skipped.

**But: the SDK upgrade is its own commit and its own PR**, never mixed into a feature commit. When the release breaks, the first question is "was it the SDK or the features", and a mixed commit makes that unanswerable.

**Cadence discipline over date discipline.** If a sprint's work is not device-verified when the window arrives, the release ships without it. A monthly cadence with a shifting scope is sustainable; a fixed scope with a shifting date is how a release ends up untested.

---

## 10. Rollback

### 10.1 Triage: what kind of failure is this?

```
                    A critical bug is reported post-release
                                    │
                    ┌───────────────▼───────────────┐
                    │ Does the app launch and reach  │
                    │ the update check?              │
                    └───────┬───────────────┬────────┘
                        NO  │               │ YES
            ┌───────────────▼──┐     ┌──────▼─────────────────────┐
            │ CRASH ON LAUNCH  │     │ Is the fix JavaScript-only? │
            │ OTA cannot help  │     └──────┬──────────────┬───────┘
            │ — the app never   │        YES │              │ NO (native /
            │ gets far enough   │            │              │  SDK / module)
            └───────────┬──────┘     ┌───────▼──────┐  ┌────▼──────────┐
                        │            │ OTA HOTFIX   │  │ NEW BUILD     │
            ┌───────────▼──────┐     │ eas update   │  │ PATCH release │
            │ PATH A            │     │ (§10.2)      │  │ (§6)          │
            │ Re-install the    │     └──────────────┘  └───────────────┘
            │ previous APK      │
            │ (§10.3)           │
            └───────────────────┘
```

The decision hinges on one question — **does the app reach the update check** — because `expo-updates` is the only remote lever available, and it requires a running app. This is why "APK crashes on launch" is the scenario the whole rollback plan is built around: it is the one case where every remote option is off the table.

### 10.2 Path B — OTA hotfix (JS-only, app still launches)

```bash
pnpm run update:preview
```

Gated, because this reaches every matching installed build immediately with no review:

- [ ] The fix is **JavaScript only** — no new native module, no SDK change, no config plugin, no `app.json` edit
- [ ] `runtimeVersion` unchanged, so the bundle is compatible with installed binaries (§2.2). The policy is `appVersion`, so bumping `expo.version` **silently removes every installed device from the channel** — that is a build, not an update
- [ ] All four gates green, including a device pass **of the hotfix**, on the previous APK, before publishing
- [ ] Published to the `preview` branch first; `production` (`pnpm run update:production`) only after the preview testers confirm
- [ ] Testers told what changed — a silent OTA that changes behaviour is indistinguishable from a bug
- [ ] The same fix committed, tagged and rolled into the next full build (an OTA is not a substitute for source history)

To undo one:

```bash
pnpm run update:rollback
```

**If in doubt, do not OTA.** A bad OTA reaches everyone at once and cannot be undone except by another OTA, which requires the app to still be launching — the exact assumption that just proved unreliable. `fallbackToCacheTimeout: 0` limits the damage in one specific way and no other: a device that cannot reach the channel launches on the bundle it already has, so a network problem is never a startup problem. It does nothing about a bundle that downloads successfully and is broken.

### 10.3 Path A — the APK crashes on launch

This is the critical case. Order matters; the first two steps take a minute and protect everyone who has not installed yet.

1. **Stop the spread.** Remove the APK link, or replace it with the previous release's. Every minute the bad link is live is another affected install.
2. **Announce, immediately and plainly.** "vX.Y.Z crashes on launch. Do not install. If you have it, install vX.Y.(Z−1) from <link>. Your conversations are safe." Say it before you know the cause; testers need the instruction, not the diagnosis.
3. **Choose the re-install mechanism**, because Android will not install a lower `versionCode` over a higher one (§2.3):

| Option | Command / action | Data | When |
|---|---|---|---|
| **A1 — re-issue the old code under a higher `versionCode`** | check out the previous tag, bump `versionCode` only, rebuild, distribute | **preserved** | the default; costs one EAS build (~15 min) |
| **A2 — uninstall then install the old APK** | `adb uninstall org.lyric.agentrouter` then install | **lost** (SQLite, AsyncStorage, SecureStore all cleared) | only if a build is impossible and the user accepts the loss |

```bash
git checkout v1.2.0
```

Then bump `android.versionCode` above the broken release's value, commit as `chore(rollback): re-issue v1.2.0 as versionCode N+2`, tag `v1.2.0-r2`, and build. **A1 is the default**, because A2 destroys a user's entire history to fix a launch crash, and that trade is almost never worth it.

4. **Verify the rollback artefact on a device** before distributing it. A rushed rollback build that also fails is a much worse position than the one you were in.
5. **Then diagnose.** Reproduce with the dev client, find the cause, and add a check to the protocol in §7 that would have caught it. Every launch crash that reaches a release is a missing protocol step.
6. **Re-release as a PATCH** through the normal process (§6). Never re-use the broken version number — a version that means two different binaries is a support nightmare.

### 10.4 The case that cannot be rolled back

**A migration that a previous version cannot read.** Once a device has upgraded its schema, installing the older APK gives an app that opens a database from the future. Depending on the change, it reads wrong data or fails to open at all — and `PRAGMA user_version` migrations have no `down` path.

This is why §2.1 ties irreversibility to a MAJOR bump, and why [05_Data_Model.md](05_Data_Model.md) §10.1 insists on additive, defaulted migrations. An additive column is readable by an older binary, which simply ignores it — so the ordinary migration is rollback-safe by construction.

Before shipping any migration, answer one question in writing in the release notes: **can the previous version open this database?** If the answer is no, the release is a MAJOR, the notes say rollback means data loss, and an export prompt before the migration is worth considering.

### 10.5 Rollback readiness (verify quarterly, not during an incident)

- [ ] The previous release's APK is downloadable *right now* — click the link
- [ ] Its tag exists and `git checkout <tag> && pnpm install && pnpm test` still works
- [ ] The tester announcement channel reaches everyone within an hour
- [ ] `versionCode` history is recorded somewhere findable (Appendix A.2)
- [ ] Every shipped migration since the last release is known to be readable by the previous version, or is documented as not
- [ ] An EAS build can be produced today (token valid, quota available)
- [ ] `pnpm run update:rollback` works against the `preview` branch — an untested rollback path is not a rollback path
- [ ] The published update history is known: which bundle each channel currently serves, and what `runtimeVersion` it targets

---

## 11. Release communication

### 11.1 `CHANGELOG.md`

Lives at the repository root ([../CHANGELOG.md](../CHANGELOG.md)). Keep-a-Changelog shape, with two additions this project needs — a "what to look for" section, because testers with no telemetry are the monitoring system, and an explicit known-issues list.

```markdown
## [1.1.0] — 2026-09-26

### Added
- Attach an Office document (`.docx`/`.xlsx`/`.pptx`) to a message, or hand one in
  from another app through "open with". **Needs a rebuild** (`expo-share-intent`
  intent filters are native).
- The model can write a file, a PDF or an Office document, and you can preview it
  and save a copy to a folder you pick. **Needs a rebuild** (`expo-print`,
  `expo-sharing`).
- Voice mode: dictate a message, have a reply read aloud, or hold a hands-free
  conversation. **Needs a rebuild** (`expo-speech-recognition`).
- Charts from a ```chart fence, drawn with views and text — no new dependency.

### Changed
- A stream now reveals by writing rather than by appearing; pacing is a property
  of the transcript, not of the network. JS only.
- Every duration, icon and colour comes from one vocabulary, so the same idea
  cannot look different on another screen. JS only.

### Fixed
- Conversation previews no longer change after a relaunch. JS only.

### Known issues
- A partial reply is still lost if Android kills the app mid-stream. Your own
  message is always kept. (Tracked as D-10.)
- Spoken-run highlighting advances per utterance, not per word: `expo-speech`
  reports word boundaries on iOS only.
- Samsung S22: the scroll anchor settles ~100 ms after the keyboard dismisses. (#41)

### Please check
- Attach a large photo on a slow connection and tell me whether the size
  warning appears *before* the upload.
- Long conversations: does the gauge match what actually gets rejected?
- Voice mode on a device with no TTS voice installed: does it say so, or fall silent?

### Release facts
- Gates: typecheck ✓ · lint ✓ · 1603 tests / 80 suites ✓ · android export ✓
- Coverage: 70.1 % stmts · 66.2 % branch · 64.5 % funcs · 71.6 % lines (floors 66/63/58/68)
- Device pass: Pixel 6 79/79 · Samsung S22 78/79 (#41)
- APK: 54.2 MB (previous 52.8 MB, +2.6% — speech and print native code)
- Schema: user_version 8 (was 6). Previous version can read this database: yes,
  additive columns only.
- Reachable by OTA: the Changed and Fixed entries. The Added entries are not.
```

The **Release facts** block exists because it is the answer to every question asked later during an incident: what passed, on what, how big, and is rollback safe. Writing it takes two minutes and removes the need to reconstruct it under pressure.

Two conventions the OTA channel forces (§10.2):

- **Mark every entry `Needs a rebuild` or `JS only`.** Without it, nobody can tell which half of a release an update can carry, and the answer gets guessed during an incident. An entry that names a new native module is always a rebuild.
- **State what the channel currently serves.** A tester on the right `versionCode` and the wrong bundle is a bug report about code you did not ship.

### 11.2 What to say, and what not to

| Do | Don't |
|---|---|
| Lead with what the user can now do | Lead with internals ("refactored the transport layer") |
| State known issues before they are discovered | Let a tester find a known bug and lose trust |
| Ask for specific observations | Ask "does it work?" — the answer is always yes until it isn't |
| Name the devices it was verified on | Imply broader verification than happened |
| Say plainly when something is a workaround | Present a mitigation as a fix |

**Announcing a security-relevant fix.** Say that there was one, say what a user should do, and do not publish an exploitable detail before the fix is installed. For an app with no server, "install the update" is the entire remediation, so the ask is simple — but it must be unambiguous about urgency.

---

## 12. Support and feedback

With no telemetry, the support loop *is* the monitoring system. It has to be short and low-friction, and it has to produce artefacts a maintainer can act on.

```
   TESTER                          MAINTAINER
     │                                 │
     ├ hits a problem                  │
     ├ opens the debug log             │
     ├ taps "copy log"  ─── redacted   │
     │   (safe by construction:        │
     │    nothing unredacted is        │
     │    ever in the buffer)          │
     ├ pastes it with:                 │
     │   · what they did               │
     │   · what happened               │
     │   · device + app version ──────►│
     │                                 ├ read the gateway request id
     │                                 ├ read timings, retries, which origin
     │                                 ├ read the stream sample if it is a parse bug
     │                                 ├ reproduce with a fixture from the log
     │                                 ├ add a regression test FIRST
     │                                 ├ fix
     │                                 ├ add a §7 protocol step if it should
     │                                 │   have been caught
     │◄─── "fixed in vX.Y.Z, here's ───┤
     │      what changed"              │
```

Three properties make this work:

**The log is safe to share by construction.** Redaction happens at the write boundary ([05_Data_Model.md](05_Data_Model.md) §13.1), so the buffer never contains a secret. A tester can paste it without reading it first, which is the difference between a report we get and one we do not.

**The gateway request id is in the log.** When the problem is on the gateway's side, that id is the only thing that makes the conversation with them possible.

**Every bug produces a test and, where relevant, a protocol step.** A fix without a test is a bug scheduled for a later release. A launch crash without a new §7 step is the same crash waiting for a different cause.

### 12.1 Report template to give testers

```
App version:        (Settings → About)
Device / Android:   e.g. Pixel 6 / Android 14
What I did:
What I expected:
What happened:
Debug log:          (Settings → Debug log → Copy)
```

---

## 13. Success metrics for a release

| Metric | Target | How it is measured without telemetry |
|---|---|---|
| **Crash-free sessions** | **>99%** | Tester reports plus Android's own crash dialog counts over a 4-week window. With ~10 testers this is a coarse instrument — treat "two independent reports of the same crash" as a failed release regardless of the computed rate |
| **Average message latency** | **<500 ms** overhead above gateway time | `meta.latencyMs` minus reported gateway time, aggregated in the debug/performance screen |
| Time to first token | <1 s on Wi-Fi | `meta.firstTokenMs` |
| Cold start | <2 s | device protocol step 2 |
| 1,000-message transcript first paint | <2 s | device protocol step 22 |
| Rollbacks per quarter | 0 | count |
| Releases shipping with a failed device pass | **0** | policy, verifiable in the notes |
| Unexplained APK size jumps | 0 | notes comparison (§8.3) |
| Reports of a leaked secret | **0** | any single occurrence is a P0 |
| Days from a P1 report to a fix in a tester's hands | ≤3 | issue timestamps |

**On the 99% figure.** It is the right target and it is a weak measurement at this scale: ten testers do not generate enough sessions for a percentage to be meaningful, and the denominator is unobservable anyway. So the operative rule is the qualitative one — *two independent reports of the same crash fails the release* — and the percentage is what we hold ourselves to once there is a population large enough to compute it. Claiming a precise crash-free rate from ten users would be a number with no evidence behind it, which is worse than an honest "no crashes reported by any of the ten testers in four weeks".

---

## Appendix A — Reference

### A.1 Commands

All four gates, as one command:

```bash
pnpm run gates
```

The export gate, which `gates` does not include, and its cleanup:

```bash
npx expo export --platform android
```

```bash
rm -rf dist
```

Version, tag and commit in one step (choose the level from §2.1):

```bash
pnpm run release:patch
```

Build an installable APK through EAS:

```bash
pnpm run build:preview
```

Build one on this machine instead, when EAS is unavailable:

```bash
pnpm run build:preview:local
```

Production profile:

```bash
pnpm run build:production
```

Publish and undo an OTA update (§10.2):

```bash
pnpm run update:preview
```

```bash
pnpm run update:rollback
```

Install and watch a build on a connected device:

```bash
adb install -r app-release.apk
```

```bash
adb logcat --pid=$(adb shell pidof -s org.lyric.agentrouter)
```

There is no `build:apk` script, and no supported web build target — `pnpm run web` is a layout diagnostic (§4.2), not an artefact.

### A.2 Release ledger (maintain this table every release)

| Version | `versionCode` | Date | Tag | APK size | Schema | Prev version can read DB? | Device pass | Notes |
|---|---|---|---|---|---|---|---|---|
| 0.1.0 | 1 | — | `v0.1.0` | — | 1 | n/a | — | first alpha |
| 1.0.0 | 1 | — | `v1.0.0` | — | 6 | yes (additive) | — | built, not distributed |
| 1.1.0 | — | *unreleased* | — | — | 8 | yes (additive) | pending | v1.1 feature work landed; needs a rebuild for the native modules added since 1.0.0 |
| | | | | | | | | |

The "prev version can read DB?" column is the rollback-safety record and the reason this table exists. During an incident it answers, in one glance, whether Path A1 is safe.

**The 1.1.0 row is the one to read before shipping anything.** Every native module added since the 1.0.0 binary — speech recognition, print, sharing, the intent filters — is absent from it. An OTA cannot deliver them, so the first 1.1.0 artefact must be a build, and the §7 protocol steps that exercise them (36–68) cannot pass on an older APK.

### A.3 Project identifiers

| Item | Value |
|---|---|
| Product name | SuperAgent (`APP_NAME`, `src/lib/app.ts`) |
| Package slug | `agentrouter-mobile` — identity, deliberately not renamed |
| Android package | `org.lyric.agentrouter` |
| URL scheme | `jarvis://` — identity; changing it breaks OAuth redirects |
| `expo.version` / `versionCode` | `1.0.0` / `1` |
| EAS project id | `1203a4d2-78ca-407d-a3fb-058ee83ceb50` |
| Updates URL | `https://u.expo.dev/1203a4d2-78ca-407d-a3fb-058ee83ceb50` |
| Updates | `enabled: true`, `checkAutomatically: ON_LOAD`, `fallbackToCacheTimeout: 0` |
| `runtimeVersion.policy` | `appVersion` |
| `appVersionSource` | `local` |
| Config plugins | `expo-router`, `expo-splash-screen`, `expo-sqlite`, `expo-secure-store`, `expo-image-picker`, `expo-speech-recognition`, `./plugins/with-no-backup.js`, `./plugins/with-system-ca-only.js` |
| Primary gateway origin (Anthropic convention) | `https://agentrouter.org` + `POST /v1/messages` |
| OpenAI-compatible origin | `https://agentrouter.org/v1` + `POST /chat/completions` |
| Parity / fallback origin | `https://ps.air-outer.com` |
| CI secret | `EXPO_TOKEN` (the only one) |

The two local plugins are security posture, not convenience: `with-no-backup.js` keeps the encrypted database out of Android's backup transport, and `with-system-ca-only.js` refuses cleartext and user-added CAs in release builds. Removing either is a security change and belongs in the release notes as one.

### A.4 Environment fidelity, at a glance

| | Local dev | Emulator | Pixel 6 | S22 | iPad web |
|---|---|---|---|---|---|
| JS logic | ✓ | ✓ | ✓ | ✓ | ✓ |
| Native modules | partial | ✓ | ✓ | ✓ | ✗ |
| Release-mode perf | ✗ | misleading | ✓ | ✓ | ✗ |
| Real network transitions | ✗ | ✗ | ✓ | ✓ | ✗ |
| Keystore / SecureStore | partial | partial | ✓ | ✓ | ✗ (in-memory for the session) |
| SQLCipher | ✓ (native) | ✓ | ✓ | ✓ | WASM, unencrypted |
| Image / document picker | partial | partial | ✓ | ✓ | ✗ |
| In-app camera (`expo-camera`) | ✗ | virtual scene only | ✓ | ✓ | ✗ |
| Speech recognition and TTS | ✗ | depends on the image | ✓ | ✓ | ✗ |
| Print / share sheet | ✗ | partial | ✓ | ✓ | ✗ |
| Inbound `ACTION_VIEW` intent ("open with") | ✗ | ✓ | ✓ | ✓ | ✗ |
| Biometric app lock | ✗ | enrollable | ✓ | ✓ | ✗ |
| OEM gesture behaviour | ✗ | ✗ | stock | **One UI** | ✗ |
| Large-screen layout | ✗ | ✓ | ✗ | ✗ | ✓ |

The camera row is the one worth reading twice. An emulator's virtual camera renders a
rotating test scene and reports a sensor that does not exist, which is enough to prove the
viewfinder mounts and the shutter returns a file — and proves nothing about orientation,
aspect ratio, focus, the flash lamp or the front camera's screen flash. Those are §7.2
device steps and there is no substitute for them.

## Appendix B — Checklists (quick reference)

### B.1 Pre-release
See §6.2 for the full list. The six that are most often skipped and least safe to skip:
- [ ] `versionCode` incremented (a build that cannot install over the last one is not a release)
- [ ] Device pass on **both** handsets, recorded with numbers — all 79 steps, not the ones the build supports
- [ ] The build is newer than every native module in the release (§7.2); a step skipped for build age is a failed pass
- [ ] Previous APK verified downloadable *before* shipping the new one
- [ ] "Can the previous version read this database?" answered in writing
- [ ] Redaction spot-check: copy the log, search for the key

### B.2 Incident (a critical bug is reported)
- [ ] Triage with §10.1: does the app reach the update check?
- [ ] Pull the download link **first**, before diagnosing
- [ ] Announce with an instruction, not a diagnosis
- [ ] If the fix is JS-only, check every gate in §10.2 before publishing — and note that bumping `expo.version` drops every installed device off the channel
- [ ] Choose A1 (re-issue with a higher `versionCode`, data preserved) over A2 (uninstall, data lost)
- [ ] Verify the rollback artefact on a device before distributing it
- [ ] Add the §7 protocol step that would have caught it
- [ ] Re-release as a PATCH; never re-use the broken version number

### B.3 Expo SDK upgrade
- [ ] Its own branch, its own PR, no feature work mixed in
- [ ] Check the pins in §3.1 against the new SDK's expectations before building
- [ ] `pnpm install --frozen-lockfile` reproduces cleanly
- [ ] Full four gates plus the complete §7 protocol — an SDK upgrade is a full release, not a patch
- [ ] APK size compared; a jump here is expected but should still be explained
- [ ] Only then merge, and release on the normal monthly cadence

## Appendix C — Glossary

| Term | Meaning here |
|---|---|
| **AAB** | Android App Bundle; Play-Store-only format. Not used — see §3 |
| **ABI split** | Building per-CPU-architecture APKs to cut size |
| **Channel** | EAS routing between a build and the OTA branch it listens to |
| **Device pass** | A completed §7 protocol run on a physical handset, with numbers |
| **Gate** | A check that blocks progress; four of them ([06_Eng_Plan.md](06_Eng_Plan.md) §8) |
| **OTA** | Over-the-air JS-only update via `expo-updates` |
| **Path A / Path B** | Rollback by re-install / recovery by OTA (§10.1) |
| **`runtimeVersion`** | The native↔JS compatibility fence; here derived from `expo.version` |
| **Release facts** | The block in each changelog entry recording gates, device pass, size and schema |
| **`versionCode`** | Android's monotonic upgrade integer; must always increase |
| **Web export** | Static browser build; a layout diagnostic, never a supported target |

---

## Ownership and maintenance

| | |
|---|---|
| **Owner** | The maintainer (`Suke2004`) — whoever cuts releases owns this document |
| **Update at** | Every release: the ledger in A.2, and anything the release proved wrong |
| **Update immediately when** | A build profile changes · a dependency pin is added or removed · the device set changes · the rollback procedure is exercised (record what actually happened) · CI workflows change · distribution moves to a store |
| **Do not update for** | Feature work that does not change the build or release process |
| **Verify quarterly** | §10.5 rollback readiness — links, tags, tokens, and the migration-readability record |
| **Staleness signal** | If the release ledger's last row predates the newest git tag, this document is stale |

Cross-references: sprint sequencing, gates and the risk register are in [06_Eng_Plan.md](06_Eng_Plan.md); schema and migration-reversibility rules in [05_Data_Model.md](05_Data_Model.md); product scope in [PRD.md](PRD.md); transport and gateway conventions in [TRD.md](TRD.md); the standing rules a change is held to in [GUIDELINES.md](GUIDELINES.md); known limitations in [flaws.md](flaws.md); layering in [ARCHITECTURE.md](../ARCHITECTURE.md); user-facing instructions in [USAGE.md](USAGE.md); current status in [progress.md](../progress.md).

**One note on verification, stated plainly:** the gates in this document have been run and are green — typecheck, lint, and 1,603 tests across 80 suites in about five seconds plain and eight with coverage, above every floor in `jest.config.js`. (Two earlier revisions quoted "about eight seconds" and then "about eleven", the second blaming the estimator-calibration suite for ten of them; that suite runs in 0.64 s and the eleven seconds was a cold filesystem cache. The lesson is in [06_Eng_Plan.md](06_Eng_Plan.md) §11, D-19.) What has *not* been run is anything requiring EAS credentials or a handset: no build was triggered, no OTA was published, and the §7 device protocol has never been executed against a build containing the native modules v1.1 added — **nor the ones added after it**, since Sections 1–6 of the Claude-parity checklist landed on top and put `expo-speech-recognition`, `expo-print`, `expo-sharing`, `react-native-webview`, `app.json`'s `intentFilters` and now **`expo-camera`** on the same wrong side of that line. That gap is the outstanding one, `expo-camera` is the newest and largest part of it — six protocol steps of its own, §7 section Q — and the first act of the next release is to close it. Parity Sections 7, 10, 11 and 12 (the history drawer; the connector directory with the per-conversation tool summary; the pending-update row; the screen-reader announcement) are the items on the *right* side of that line: not one of them added a dependency or any native code, so all of them ship over the update channel — and not one of them is verified either, because what they claim is a frame rate, a gesture, an endpoint on somebody else's server and a synthesised voice. That is §7 steps 69–79, sections R, S and T.

## Document history

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.0 | 2026-08-29 | Architecture review | Initial issue. Artefact inventory with retention rules; SemVer interpreted for a client app, including when a migration forces MAJOR; the four version numbers (`version`, `versionCode`, `runtimeVersion`, `appVersionSource`) and how they interact; the three EAS profiles and the load-bearing dependency pins behind them; end-to-end pipeline diagram with gates running at PR, merge and tag; four environments with an honest fidelity matrix; a step-by-step release process and an all-or-nothing build checklist; a 35-step physical-device protocol across Pixel 6, Samsung S22 and iPad-for-web, with a recording format; APK size levers and the >10% explanation rule; monthly cadence synchronised to Expo SDK releases with the reasoning; a rollback plan built around the case where OTA cannot help, including the `versionCode` problem and the data-preserving A1 path; the migration case that cannot be rolled back; changelog format with a "Release facts" block; the support loop that substitutes for telemetry; and release success metrics with an honest account of why >99% crash-free is a weak measurement at ten testers. |
| 1.1 | 2026-09-02 | Documentation reconciliation | Rewritten against the shipped v1.1 surface. The OTA channel is live (`updates.enabled: true`), so Path B is a real path: §10.2 now uses `pnpm run update:preview`, names `pnpm run update:rollback`, and states that the `appVersion` runtime policy silently drops every installed device off the channel when `expo.version` moves. Every command replaced with a script that exists — `build:apk` and `build:apk:local` never did. The device protocol grew from 35 steps to **62**, adding groups J–P for attachments and inbound intents, files the model writes, speech, what a reply can render, motion and gestures, tools and plan mode, and projects; each step names the native module behind it, and a step skipped because the build predates its module is recorded as a **failed** pass, not a partial one. Changelog entries now carry a `Needs a rebuild` / `JS only` marker, because without it nobody can tell which half of a release an OTA can carry. Corrected: the web build's key handling (an in-memory page variable, not `localStorage`), the release ledger (rows for 1.0.0 and the unreleased 1.1.0), the stale reference to four export directories that no longer exist, the "671 tests / 17 suites" release-facts template, and the claim that the gates had never been run. |
| 1.2 | 2026-09-02 | Claude-parity sweep (checklist §§1–7, 10) | The device protocol grew from 62 steps to **75**, and the reason each group was added is now the group's own first line. New: **Q. Camera** (63–68, `expo-camera`) — the only new native module in this batch, and the one that makes the whole protocol a rebuild gate again; **R. History drawer** (69–71) — grouped headings, a swipe that must not fight the transcript's, and a list that stays smooth at four hundred conversations; **S. Connectors** (72–75) — the bundled directory in `src/mcp/catalog.ts`, where a failure means *the entry is stale*, and the per-conversation `Tools` summary against plan mode. Sections R and S carry a warning of their own in §7's preamble: no native module, so they reach an installed build over the update channel, but they are no more verified for it, because a frame rate and somebody else's endpoint are exactly what a gate cannot see. Release facts refreshed to the measured numbers (**1,600 tests / 80 suites**, `70.1 % stmts · 66.2 % branch · 64.5 % funcs · 71.6 % lines`) and the §7.2 recording sample re-cut against 75 so the example still shows a real near-miss. |
| 1.3 | 2026-09-02 | Parity §§11–12 (platform and accessibility) | **A stale claim in §2.2 corrected, and it was the most consequential one in the document.** The callout above the version diagram still read *"OTA is currently switched off — `updates.enabled: false`, `checkAutomatically: "NEVER"`"*, which had been untrue since `0803d51`; [flaws.md](flaws.md) §2.7 recorded the reversal and this document did not, so a reader following the runbook would have concluded Path B was theoretical. It now says OTA is on, names the three mitigations by reference, and keeps `expo-updates` code signing as the open item. It also states the consequence that changes what a hotfix *feels* like: a downloaded bundle takes effect on the next **cold start**, and a chat app is one people leave resident, so Settings carries a *Restart to finish updating* row while one is pending. The protocol grows from 75 steps to **79** with **T. Screen reader, motion and text size** (76–79) — the group with the widest gap between what the code claims and what a gate can prove, since 87 `accessibilityLabel`s, eight live regions, a Reduce Motion subscription and the transcript's deliberate *absence* of a live region are all invisible to typecheck, lint and Jest alike. Step 76 is the one that matters: one *"Reply ready, N words"* announcement per finished turn, and never the reply read aloud as it streams. §7's preamble and the §7.2 sample re-cut against 79. |

