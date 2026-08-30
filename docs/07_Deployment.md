# 07 — Deployment

**SuperAgent / AgentRouter Mobile · Build, Release, Rollback and Support**

| | |
|---|---|
| **Version** | 1.0 |
| **Status** | Current — pre-1.0; alpha distribution, no store listing yet |
| **Audience** | Whoever is cutting a release, and whoever has to undo one |
| **Distribution** | Direct Android APK (EAS `preview` / `production`), plus a static web export for layout checks |
| **Companion docs** | [05_Data_Model.md](05_Data_Model.md) · [06_Eng_Plan.md](06_Eng_Plan.md) · [PRD.md](../PRD.md) · [TRD.md](../TRD.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [progress.md](../progress.md) |

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
| **Preview APK** | `eas build -p android --profile preview` | The normal release artefact today | beta testers, direct link | every release, forever |
| **Production APK** | `eas build -p android --profile production` | 1.0 and after; store-ready signing | public | every release, forever |
| **Development build** | `eas build --profile development` | Native debugging with the dev client | maintainer only | not retained |
| **Local APK** | `pnpm build:apk:local` | Build without EAS queue time; offline | maintainer only | not retained |
| **Web export** | `npx expo export -p web` | Layout and Markdown-rendering checks on a large screen (iPad, desktop) | maintainer only | not retained |
| **Release notes** | hand-written, per tag | What changed, what to look for, what is known-broken | testers, in the release | with the tag, forever |
| **Source tag** | `git tag vX.Y.Z` | The exact commit an artefact came from | repository | forever |

Two retention rules that are not optional:

**Every shipped APK is kept and stays downloadable.** Rollback is a re-install (§10). An artefact that has been deleted is a rollback that cannot happen.

**Every shipped APK has a tag pointing at its exact commit.** "The build from last Tuesday" is not a recoverable state. EAS retains build metadata, but the tag is what lets someone rebuild from source when EAS's retention window has passed.

**The web export is a diagnostic, not a product.** It is genuinely useful — it renders Markdown and layout on a screen large enough to see spacing problems, and an iPad is a fast way to check both. But it is not a supported target: the browser `localStorage` SecureStore fallback is a development convenience and **must never be treated as security**. Nothing sensitive should be entered into a web export. Four stale export directories (`.tmp-web-export`, `dist-web-check`, `dist-web-final`, `dist-web-test`) currently sit in the working tree; they are debt item D-01 in [06_Eng_Plan.md](06_Eng_Plan.md) and should be deleted and gitignored.

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

> **OTA is currently switched off.** `app.json` sets `updates.enabled: false` and
> `checkAutomatically: "NEVER"` ([flaws.md](flaws.md) §2.7): nothing in the repo
> publishes a bundle, so an open channel was remote-code trust bought for nothing.
> Everything below about channels, `runtimeVersion` and Path B applies from the moment
> it is turned back on — and that change should add `expo-updates` code signing rather
> than trusting the EAS project id alone.

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
pnpm typecheck && pnpm lint && pnpm test
```

Then, in order:

1. **Bump the version.** `app.json` → `expo.version` per §2.1, and `expo.android.versionCode` incremented by one. One commit, message `chore(release): vX.Y.Z`.
2. **Write the release notes** into `CHANGELOG.md` (§11), including the "what to look for" and "known issues" sections. Written before the build, so it reflects what was intended rather than what is remembered afterwards.
3. **Tag.** `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push --follow-tags`. The tag triggers `build-apk.yml`.
4. **Wait for EAS**, then download the APK from the build page.
5. **Run the device protocol** (§7) on both handsets. Record the result in the release notes, including anything that was checked and looked odd but was accepted.
6. **If the protocol fails:** stop. Do not distribute. Fix, bump PATCH, and start again at step 1. A failed protocol never becomes "ship it and note it".
7. **Distribute**: APK link plus release notes to the tester list.
8. **Archive**: the APK stored where it stays downloadable, filed under its tag.
9. **Update `progress.md`** with the release, the real gate output, and any decision made during the release.

### 6.2 Build checklist — every line must be true

**Source**
- [ ] On `main`, up to date, working tree clean (`git status` empty — note D-01's stale export directories)
- [ ] Lockfile unchanged by the install (`--frozen-lockfile` did not error)
- [ ] No debug-only code: no `mirrorToConsole` left on, no hard-coded origin, no test key

**Gates**
- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm test` — all pass; count recorded in the release notes, not remembered
- [ ] CI green on the tagged commit

**Version**
- [ ] `expo.version` bumped per §2.1
- [ ] `expo.android.versionCode` incremented
- [ ] Tag matches `expo.version` exactly
- [ ] If any migration is irreversible, this is a MAJOR and the notes say so

**Security**
- [ ] Redaction tests present and passing ([06_Eng_Plan.md](06_Eng_Plan.md) §7.3)
- [ ] No API key in the repository, the lockfile, `app.json`, `eas.json`, or CI secrets
- [ ] `EXPO_TOKEN` is the only CI secret
- [ ] Exported/shared artefacts from testing contain no key (spot-check one)

**Device (§7)**
- [ ] Pixel 6 protocol pass
- [ ] Samsung S22 protocol pass
- [ ] iPad web-export layout check (Markdown, spacing, tap targets)
- [ ] Performance spot-checks: cold start, 1,000-message transcript, mid-stream backgrounding

**Release**
- [ ] `CHANGELOG.md` updated with changes, what to look for, and known issues
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
25. Attach several images (Phase 3 onward), then scroll past them. → Memory stays under 250 MB in the profiler.

**G. Accessibility and touch**
26. Enable TalkBack; navigate the transcript. → Read in order; controls labelled.
27. Check tap targets on the composer, stop control and list rows. → All ≥44 dp; no accidental adjacent hits.
28. System font size at maximum. → No clipped text, no unreachable button.
29. Dark mode and light mode. → Contrast ≥4.5:1 for body text in both.

**H. Security spot-checks (every release, no exceptions)**
30. Open the debug log after several requests. → Key nowhere. `Authorization` / `x-api-key` values show `[REDACTED]`.
31. Copy the log; paste into a notes app; search for the key's first six characters. → No match.
32. Export a conversation whose system prompt contains a key-shaped string. → Redacted in the file.
33. Clear all data. → Conversations, providers, settings and the stored key all gone; relaunch shows a first-run state.

**I. iPad (web export, layout only)**
34. Markdown-heavy reply at width. → Tables do not overflow; code blocks scroll rather than clipping; spacing sane.
35. Touch responsiveness of list and composer. → No hover-only affordances; nothing requires a mouse.

### 7.2 Recording the result

Every run produces a line in the release notes:

```
Device pass v1.2.0 — 2026-09-26
  Pixel 6 (Android 14):    35/35 pass
  Samsung S22 (One UI 6):  34/35 pass — step 8 (scroll anchor) shows a ~100 ms
                           settle after the keyboard dismisses. Accepted;
                           filed as issue #41, not a release blocker.
  iPad (Safari, web):      2/2 pass
```

A partial pass is allowed only with the deviation named, its impact assessed, and an issue filed. "34/35, don't remember which one" is a failed pass.

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
eas update --branch preview --message "hotfix: <one line>"
```

Gated, because this reaches every matching installed build immediately with no review:

- [ ] The fix is **JavaScript only** — no new native module, no SDK change, no config plugin
- [ ] `runtimeVersion` unchanged, so the bundle is compatible with installed binaries (§2.2)
- [ ] All four gates green, including a device pass **of the hotfix**, on the previous APK, before publishing
- [ ] Published to the `preview` branch first; `production` only after the preview testers confirm
- [ ] Testers told what changed — a silent OTA that changes behaviour is indistinguishable from a bug
- [ ] The same fix committed, tagged and rolled into the next full build (an OTA is not a substitute for source history)

**If in doubt, do not OTA.** A bad OTA reaches everyone at once and cannot be undone except by another OTA, which requires the app to still be launching — the exact assumption that just proved unreliable.

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

---

## 11. Release communication

### 11.1 `CHANGELOG.md`

Keep-a-Changelog shape, with two additions this project needs — a "what to look for" section, because testers with no telemetry are the monitoring system, and an explicit known-issues list.

```markdown
## [1.3.0] — 2026-09-26

### Added
- Attach photos and PDFs to a message (Anthropic profiles send PDFs natively;
  OpenAI-compatible profiles send extracted text and warn in the composer).
- Context-pressure gauge, measured against usable space rather than the raw window.

### Changed
- Conversation list index now covers the archived filter; opening a large list
  is noticeably faster.

### Fixed
- Conversation previews no longer change after a relaunch.

### Known issues
- A partial reply is still lost if Android kills the app mid-stream. Your own
  message is always kept. (Tracked as D-10.)
- Samsung S22: the scroll anchor settles ~100 ms after the keyboard dismisses. (#41)

### Please check
- Attach a large photo on a slow connection and tell me whether the size
  warning appears *before* the upload.
- Long conversations: does the gauge match what actually gets rejected?

### Release facts
- Gates: typecheck ✓ · lint ✓ · 671 tests / 17 suites ✓
- Device pass: Pixel 6 35/35 · Samsung S22 34/35 (#41) · iPad web 2/2
- APK: 54.2 MB (previous 52.8 MB, +2.6% — image picker native code)
- Schema: user_version 1 (unchanged). Previous version can read this database: yes.
```

The **Release facts** block exists because it is the answer to every question asked later during an incident: what passed, on what, how big, and is rollback safe. Writing it takes two minutes and removes the need to reconstruct it under pressure.

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

```bash
pnpm typecheck && pnpm lint && pnpm test
```

```bash
pnpm build:apk
```

```bash
pnpm build:apk:local
```

```bash
eas build --platform android --profile production --non-interactive
```

```bash
eas update --branch preview --message "hotfix: <one line>"
```

```bash
npx expo export -p web --output-dir dist-web
```

```bash
adb install -r app-release.apk
```

```bash
adb logcat --pid=$(adb shell pidof -s org.lyric.agentrouter)
```

### A.2 Release ledger (maintain this table every release)

| Version | `versionCode` | Date | Tag | APK size | Schema | Prev version can read DB? | Device pass | Notes |
|---|---|---|---|---|---|---|---|---|
| 0.1.0 | 1 | — | `v0.1.0` | — | 1 | n/a | — | first alpha (current `app.json` state) |
| | | | | | | | | |

The "prev version can read DB?" column is the rollback-safety record and the reason this table exists. During an incident it answers, in one glance, whether Path A1 is safe.

### A.3 Project identifiers

| Item | Value |
|---|---|
| Android package | `org.lyric.agentrouter` |
| EAS project id | `1203a4d2-78ca-407d-a3fb-058ee83ceb50` |
| Updates URL | `https://u.expo.dev/1203a4d2-78ca-407d-a3fb-058ee83ceb50` |
| `runtimeVersion.policy` | `appVersion` |
| `appVersionSource` | `local` |
| Primary gateway origin (Anthropic convention) | `https://agentrouter.org` + `POST /v1/messages` |
| OpenAI-compatible origin | `https://agentrouter.org/v1` + `POST /chat/completions` |
| Parity / fallback origin | `https://ps.air-outer.com` |
| CI secret | `EXPO_TOKEN` (the only one) |

### A.4 Environment fidelity, at a glance

| | Local dev | Emulator | Pixel 6 | S22 | iPad web |
|---|---|---|---|---|---|
| JS logic | ✓ | ✓ | ✓ | ✓ | ✓ |
| Native modules | partial | ✓ | ✓ | ✓ | ✗ |
| Release-mode perf | ✗ | misleading | ✓ | ✓ | ✗ |
| Real network transitions | ✗ | ✗ | ✓ | ✓ | ✗ |
| Keystore / SecureStore | partial | partial | ✓ | ✓ | ✗ (stub) |
| Camera / picker | partial | partial | ✓ | ✓ | ✗ |
| OEM gesture behaviour | ✗ | ✗ | stock | **One UI** | ✗ |
| Large-screen layout | ✗ | ✓ | ✗ | ✗ | ✓ |

## Appendix B — Checklists (quick reference)

### B.1 Pre-release
See §6.2 for the full list. The five that are most often skipped and least safe to skip:
- [ ] `versionCode` incremented (a build that cannot install over the last one is not a release)
- [ ] Device pass on **both** handsets, recorded with numbers
- [ ] Previous APK verified downloadable *before* shipping the new one
- [ ] "Can the previous version read this database?" answered in writing
- [ ] Redaction spot-check: copy the log, search for the key

### B.2 Incident (a critical bug is reported)
- [ ] Triage with §10.1: does the app reach the update check?
- [ ] Pull the download link **first**, before diagnosing
- [ ] Announce with an instruction, not a diagnosis
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

Cross-references: sprint sequencing, gates and the risk register are in [06_Eng_Plan.md](06_Eng_Plan.md); schema and migration-reversibility rules in [05_Data_Model.md](05_Data_Model.md); product scope in [PRD.md](../PRD.md); transport and gateway conventions in [TRD.md](../TRD.md); layering in [ARCHITECTURE.md](../ARCHITECTURE.md); user-facing instructions in [USAGE.md](../USAGE.md); current status in [progress.md](../progress.md).

**One note on verification, stated plainly:** the commands and gates in this document were not executed while it was written. `node_modules` is absent from this worktree, so `pnpm typecheck`, `pnpm lint` and `pnpm test` could not run, and no EAS build was triggered. Everything here is derived from `package.json`, `eas.json`, `app.json`, `jest.config.js`, `metro.config.js`, `.npmrc` and `pnpm-workspace.yaml` as they exist in the repository. The first act of the next release is to establish a green baseline for real ([06_Eng_Plan.md](06_Eng_Plan.md) Sprint 5).

## Document history

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.0 | 2026-08-29 | Architecture review | Initial issue. Artefact inventory with retention rules; SemVer interpreted for a client app, including when a migration forces MAJOR; the four version numbers (`version`, `versionCode`, `runtimeVersion`, `appVersionSource`) and how they interact; the three EAS profiles and the load-bearing dependency pins behind them; end-to-end pipeline diagram with gates running at PR, merge and tag; four environments with an honest fidelity matrix; a step-by-step release process and an all-or-nothing build checklist; a 35-step physical-device protocol across Pixel 6, Samsung S22 and iPad-for-web, with a recording format; APK size levers and the >10% explanation rule; monthly cadence synchronised to Expo SDK releases with the reasoning; a rollback plan built around the case where OTA cannot help, including the `versionCode` problem and the data-preserving A1 path; the migration case that cannot be rolled back; changelog format with a "Release facts" block; the support loop that substitutes for telemetry; and release success metrics with an honest account of why >99% crash-free is a weak measurement at ten testers. |

