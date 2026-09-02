# Contributing guidelines

**SuperAgent — how to change this app without breaking it**

| | |
|---|---|
| **Audience** | Anyone writing code in this repository, human or agent |
| **Status** | Normative. Where this file disagrees with a habit from another project, this file wins. |
| **Companion docs** | [../README.md](../README.md) · [../ARCHITECTURE.md](../ARCHITECTURE.md) · [PRD.md](PRD.md) · [TRD.md](TRD.md) · [05_Data_Model.md](05_Data_Model.md) · [06_Eng_Plan.md](06_Eng_Plan.md) · [07_Deployment.md](07_Deployment.md) · [flaws.md](flaws.md) · [USAGE.md](USAGE.md) · [../CHANGELOG.md](../CHANGELOG.md) · [../progress.md](../progress.md) · [../progress-v1.1.md](../progress-v1.1.md) |

The app is called SuperAgent, from one constant (`src/lib/app.ts`). The slug
`agentrouter-mobile`, the Android package `org.lyric.agentrouter` and the `jarvis://`
scheme are identity rather than presentation and do not change — renaming them orphans
installs and OAuth redirects.

---

## 0. The five rules that matter most

Everything below is detail. If you only read one section, read this one.

1. **A key never leaves the Keystore for anywhere else.** Not a Zustand store, not
   AsyncStorage, not SQLite, not a log line, not an export. `src/lib/secureKey.ts` is
   the only module that reads one.
2. **The app is offline-first and there is no server.** A bad write is permanent —
   there is nothing to reconcile against and no cloud copy to re-download. Weigh
   schema and migration changes accordingly.
3. **`pnpm run gates` must pass before you call anything done.** Typecheck, lint and
   tests with coverage — plus the bundle gate (§1) whenever imports or assets moved. A
   change that cannot pass the gates is not finished.
4. **Comments explain *why*, never *what*.** This codebase is dense with rationale
   because the decisions are non-obvious. Match that. A comment restating the code is
   noise; a missing comment on a deliberate trade-off is a future regression.
5. **Model output, file contents, deep links and restored backups are untrusted
   input.** Every one of them has a validation boundary already; put your change on
   the safe side of it rather than adding a second door.

---

## 1. Gates, and the order to run them

```bash
pnpm run gates
```

That is `typecheck && lint && test:coverage`. Individually:

```bash
pnpm run typecheck
```

```bash
pnpm run lint
```

```bash
pnpm test
```

And the one gate `pnpm run gates` does **not** include — CI runs it as a separate step, and it is the only check that proves the app can still be bundled:

```bash
pnpm expo export --platform android --output-dir .expo-export
```

Typecheck, lint and tests all run against the module graph Jest builds under
`testEnvironment: 'node'`. Metro builds a different one. A `require` cycle, a missing
asset, a native-only import pulled into a shared module — none of those fail the first
three gates and all of them fail the bundle. Run it before calling a change that
touched imports, assets or a `.tsx` entry point done. `.expo-export/` is gitignored.

Rules about the gates themselves:

- **Zero TypeScript errors, always.** There is no allowance for "it's only a type
  error"; `strict` and `noUncheckedIndexedAccess` are on deliberately.
- **Zero ESLint errors.** Warnings are tolerated only where they already exist
  (`import/first` in a handful of test files that mock before importing); do not add
  new ones.
- **The coverage thresholds in `jest.config.js` are a ratchet, not a target.** They
  sit a few points under the current measurement — 66 / 63 / 58 / 68 against a run of
  70.1 % statements, 66.2 % branches, 64.5 % functions, 71.6 % lines. Raise them when a
  run comes in comfortably higher. **Never lower them to make a red run green** — that
  is the one edit that makes the gate meaningless.
- **The suite is fast and must stay fast.** 1,603 tests in 80 suites in about five
  seconds (six to eight with coverage), because nothing in it touches a device or a
  network. A test that needs either is a test in the wrong place. The target in
  [06_Eng_Plan.md](06_Eng_Plan.md) §12 (P-12, under ten seconds) is met — but only warm:
  a cold first run on Windows is several times that, so quote the number from a second
  run or not at all. An earlier revision of this file blamed
  `src/stores/calibration.test.ts` for ten of eleven seconds; it runs in 0.64 s, and the
  eleven seconds was a cold cache being read as a slow suite.
- **A native change cannot be verified by the gates at all.** See §11.

---

## 2. Where code goes

```
app/                 expo-router screens. Routing and layout only.
                     `+native-intent.tsx` runs before any React tree exists.
src/components/      Reusable UI. `ui.tsx` holds the primitives.
                     `motion.tsx` holds motion behaviour, `Icon.tsx` the role map.
src/constants/       `animations.ts` — every duration, curve, spring and stagger.
src/stores/          Zustand state. The only thing screens talk to.
src/chat/            Pure chat logic: prompts, memory, trimming, export, tools,
                     attachments, OOXML, voice scripting, camera sessions, charts,
                     previews.
src/db/              SQLite. `ddl.ts` is the schema, `schema.ts` opens it.
src/transports/      Provider wire formats. Anthropic and OpenAI dialects.
src/mcp/             MCP client, protocol, OAuth, and `catalog.ts` — bundled connector
                     data, not a registry client.
src/lib/             Cross-cutting: log, redact, secureKey, storage, appLock, dictation.
src/theme/           Tokens, and `SERIES` — the six chart colours. Nothing
                     hard-codes a colour or a spacing value.
```

**The dependency direction is one-way: `app/` → `stores/` → `db/`+`chat/`+`transports/`
→ `lib/`.** A screen never writes SQL and never calls a transport. A store never
imports a screen. `lib/` imports nothing from the layers above it.

**Three vocabularies exist so divergence is impossible rather than discouraged.**
`src/constants/animations.ts` for motion, the theme palette for colour, `ICONS` in
`src/components/Icon.tsx` for iconography. A new duration is a constant added there, not
a literal at a call site; a new icon is a *role* (`send`, not `arrow-up`), so the family
is swappable in one file and the same idea cannot pick a different picture on another
screen. `src/components/motion.tsx` deliberately imports almost nothing: `ui.tsx` imports
`Glyph`, so a hook exported from either for the other would close an import cycle.

**Put logic where it can be tested.** The single most useful habit in this codebase
is extracting the decision from the IO: `src/db/cipher.ts` exists precisely so the
SQL-interpolation guard has a unit test without a device, and `src/db/schema.ts`
keeps the native calls it cannot test. The pattern that falls out of it is a pure `.ts`
module paired with a thin `.tsx` view — `voice.ts`/`VoiceMode.tsx`,
`camera.ts`/`CameraMode.tsx`, `chart.ts`/`ChartView.tsx`, `preview.ts`/`FilePreview.tsx`,
`toolLabel.ts`/`ContentBlocks.tsx`, `office.ts`+`ooxml.ts`/`FilePreview.tsx`,
`incoming.ts`/`+native-intent.tsx`, `attachments.ts`/`attach.ts`,
`typewriter.ts`/`StreamView.tsx`. Do the same for any new native-touching module.
`camera.ts` is the clearest illustration of what the split buys and what it does not:
the flash cycle, the remaining-slot arithmetic and the status-line wording are 22 tests
on a Node runner, and none of them can tell you whether the preview is upright.

---

## 3. TypeScript house style

- **No `any`.** No `as unknown as T` to silence a real mismatch. `unknown` plus a
  narrowing check is the right shape for anything parsed.
- **No non-null `!`.** `noUncheckedIndexedAccess` is on, so an index access is
  `T | undefined` and you handle it. `array[0]?.field` or an explicit guard.
- **Optional properties are omitted, not set to `undefined`.** The idiom throughout
  is a conditional spread:
  ```ts
  ...(title ? { title } : {})
  ```
  This matters beyond taste: an adapter that sees a key with `undefined` may send
  `null` on the wire, and a stored config with a key meaning "the default" is a key
  someone has to interpret later. Write the key only when it says something.
- **`@/` is the import alias for `src/`.** Relative imports only within the same
  directory (`./cipher`).
- **Import order** is enforced by `eslint-config-expo`: node builtins, packages,
  then `@/`, then relative. Type-only imports on their own line
  (`import type { Memory } from '@/chat/memory'`).
- **Exported functions get a doc comment when the reason for them is not obvious from
  the name.** Internal helpers usually do not need one.
- **Prefer a pure function over a class**, and a module-level constant over a config
  option that never changes. There is no dependency-injection container here and
  nothing wants one; transports take an injected `fetch` and that is the extent of it.

---

## 4. The three storage tiers, and the rule for each

Full detail is in [05_Data_Model.md](05_Data_Model.md). The allocation rule:

| Tier | What belongs there | Encrypted? |
|---|---|---|
| **SQLite** (`expo-sqlite`, WAL) | Unbounded, queryable or historical data: conversations, messages, tags, usage events, memories, MCP servers, skills, prompts, projects | **Yes** — SQLCipher, AES-256, key in the Keystore |
| **AsyncStorage** (`zustand/persist`) | Bounded config objects read at boot and rewritten wholesale: provider profiles, model metadata, settings, estimator calibration | **No — plaintext on a rooted device** |
| **SecureStore** (Android Keystore) | Credentials, and nothing else | Yes — hardware-backed |

Three hard rules:

1. **`partialize` is a security control, not a size optimisation.** Everything it
   returns lands in plaintext AsyncStorage. Review every addition to one with that
   framing, and note that the providers store has an active secret-header guard
   because "the type comment says it never holds a key" was not enough.
2. **Never widen a SecureStore slot's purpose.** One slot per thing: `apiKey.<pid>`
   per profile, `agentrouter.dbKey` for the database, MCP bearer tokens per server.
3. **Do not add `requireAuthentication` to the database key.** It would deny the app
   database access whenever the device is locked, which breaks the offline send
   queue and background delivery. The app lock (`src/lib/appLock.ts`) is the
   user-facing gate and is a separate control.

**A fourth store exists and is deliberately not a tier.** Files the model writes go to
the app's document directory in plaintext, inside the same sandbox, removed with the app
and not backup-eligible. `src/chat/files.ts` is the only module that writes there, and
the only place a copy leaves the sandbox — through the system folder picker, share sheet
as fallback. It is not a tier because nothing secret may go in it: what is in there is
what the model just wrote, which the user is about to read anyway.

---

## 5. Secrets and logging

- **`src/lib/log.ts` is the only way to write a log line.** `console.*` is not banned
  by lint (the gateway's own error text is the point of the debug log) but going
  around `log` skips redaction, which is the entire reason the wrapper exists.
- **Every secret loaded is registered with `src/lib/redact.ts`** so the redactor can
  scrub it from any log line, export or crash message. If you introduce a new secret,
  `registerSecret` it on load and `unregisterSecret` it on replacement.
- **`isForbiddenHeaderName` / the header scrub is the boundary for user-typed
  headers.** Extending it is cheap; working around it is a finding.
- **Never store a redacted stand-in.** A memory reading "the user's key is
  [REDACTED]" is worth nothing and looks like a bug — the rule everywhere is *drop the
  candidate*, not store it degraded.
- **Fingerprints must not carry last-4 or exact length.** That was a real finding
  ([flaws.md](flaws.md) §2.4).
- **The app sends one honest, static `User-Agent`.** It is enforced after the spread
  of user headers, in both `transports/http.ts` and `mcp/client.ts`, because wearing
  another client's name to pass an allowlist is a bannable offence. Do not make it
  configurable.

---

## 6. Changing the database

`src/db/ddl.ts` holds `SCHEMA_VERSION`, the numbered `MIGRATIONS` array indexed by
the version being migrated *from*, and the FTS5 DDL. `src/db/schema.ts` opens the
file, keys it, and runs the migrations.

- **Migrations are append-only.** Never edit a shipped migration; add the next one
  and bump `SCHEMA_VERSION`. `PRAGMA user_version` is set inside the same transaction
  as the change, so a killed process either has the whole migration or none of it.
- **Prefer a JSON column to a new column.** `conversations.config` exists precisely
  so a new per-conversation knob needs no migration. Add the field to
  `ConversationConfig`, document what absent means, and you are done.
- **A new user-facing default must be safe when the field is absent.** The
  per-conversation memory flag is opt-out only (`false` does something; absent and
  `true` both defer to the global setting) for exactly this reason.
- **Touching `messages` means touching the FTS index.** It is external-content FTS5
  with triggers; a write path that bypasses them silently desynchronises search.
  There is a startup drift check (`integrity-check rank=1`) but it cannot see every
  case — `VACUUM` in particular.
- **`PRAGMA key` comes before every other statement**, including `journal_mode`. On
  an encrypted database, anything issued before the key fails.
- **Tests run against `ddl.ts` via `node:sqlite`**, never `schema.ts`, which is why
  no native module needs mocking. Keep that split: new DDL is testable, new native
  calls are not.
- **A destructive change needs a crash-safe shape.** The plaintext→encrypted
  conversion is the worked example: export to a scratch file, then two moves rather
  than delete-then-move, plus a recovery branch for a process killed mid-swap, plus
  explicit cleanup of `-wal`/`-shm` siblings. Copy that pattern rather than trusting
  a single rename.

---

## 7. Stores

- **One store per concern, Zustand 5, `persist` only where the data is config.**
  `useChat` is deliberately *not* persisted: it is rebuilt from SQLite, which is the
  source of truth for anything a user typed.
- **Actions are never persisted.** Every `partialize` names the data keys explicitly
  rather than stripping functions.
- **Outside React, use `getState()`** — `getSetting(key)` for settings,
  `useStore.getState().action()` elsewhere. Adapters and the background queue run
  where hooks do not exist.
- **A store action that can fail returns a result, not a throw**
  (`{ ok: false, reason }`), because the caller is usually a screen that needs to put
  the reason next to a field.
- **Derive, do not mirror.** The app lock gate is `appLockEnabled && !unlocked`
  computed at render, not a second boolean kept in sync by an effect. React Compiler
  lint flags the latter and it is right to.
- **Never call the clock in a render body.** `react-hooks/purity` rejects `Date.now()`
  there — and so does the render-phase state-adjustment block that
  `react-hooks/set-state-in-effect` otherwise pushes you towards, which between them
  leave a permanently-mounted component no legal way to re-read the time. A value that
  must be fresh belongs to a component that **mounts** when it should be read, with
  `useState(() => Date.now())`: a lazy initializer is allowed. `DrawerHistory` in
  `src/components/Sidebar.tsx` exists for that reason and no other — RN's `Modal`
  renders nothing while closed, so mounting it *is* opening the drawer. Reach for this
  before reaching for a disable comment.
- **Persisting on every keystroke is a bug.** A multi-line field held in local state
  and committed on blur is the pattern (see the default system prompt in
  `app/settings/prompts.tsx`); AsyncStorage writes are not free.
- **A persisted setting is never typed as a narrow union.** `voiceStyle` is a `string`,
  not `VoiceStyleId`, precisely because it is persisted: a build that drops a style would
  otherwise rehydrate a value its own type calls impossible. `styleById` is the one
  reader and it falls back rather than trusting it.

---

## 8. UI and accessibility

- **Compose from `src/components/ui.tsx`** — `Screen`, `Section`, `Row`, `Field`,
  `Button`, `Note`, `Empty`, `Spinner`, `SwitchRow`, `Inline`. Do not hand-roll a
  control that exists there; extend the primitive instead. Sheets go through one
  `SheetShell`, not a per-screen copy.
- **No hard-coded colours, spacings or font sizes.** `useTheme()` tokens only, so
  dark mode and the accent choice keep working. The same rule covers durations
  (`src/constants/animations.ts`) and icons (a role in `ICONS`).
- **Every interactive element needs an accessible label**, and a hint where the
  outcome is not obvious from the label (`accessibilityHint="Opens edit and delete"`).
  A disabled control states *why* it is disabled (`disabledReason`) rather than being
  inert and mysterious.
- **An icon is never the only carrier of meaning.** Icons do not scale with the system
  font — a glyph in a fixed 36 dp disc that grows clips against it — so everything the
  icon *means* lives on the accessibility label of the control around it, which does
  scale. Where the glyph is a **character** in a fixed box rather than a drawn icon
  (`＋`, `−`, `↑`), give that `<Text>` `allowFontScaling={false}` and leave the label
  beside it scaling. The rule is per-element, not per-screen: opt the *box that cannot
  grow* out, never the text a reader is meant to read.
- **A gesture is never the only route to an action.** Anything reachable by swipe or
  long-press is also reachable from a visible control. A long-press menu opens at the
  touch point rather than at a fixed corner, so the finger is already there.
- **Reduce Motion is not an off switch.** Decorative motion collapses to `REDUCED_MS`;
  positional motion keeps its direction and only shortens, because a sheet that appears
  instantly no longer says which edge it came from or which way to throw it back.
- **Never put an `accessibilityLiveRegion` on streaming text.** TalkBack restarts from
  the top of a live region every time its contents change, so a region over a token
  stream reads the reply from the beginning several times a second — the most hostile
  possible output, produced by the prop that looks most like the right one. A live
  region goes on something that changes **once**: a status line, a toast, an error. What
  a screen reader gets instead of a stream is a single announcement when the turn ends
  (`replyAnnouncement` in `src/lib/notify.ts`), and exactly one of that announcement and
  the background notification fires per turn — `notifyReplyReady` reads `AppState` once
  and branches, so the two can never both speak or both stay silent.
- **Waiting says what it is waiting for.** A skeleton in the shape of the content, or a
  labelled step — not a bare spinner.
- **Long lists use `@shopify/flash-list`** with keyset paging from the database, not
  `.map()` over everything. Two things a recycled list needs and a `.map()` does not:
  `getItemType` for every distinct row shape, since a heading recycled into a
  conversation cell inherits its geometry, and `extraData` for anything a row reads from
  the closure rather than from `data` — a cell that survives a re-render keeps the old
  value otherwise. A virtualised list inside a horizontally-pannable container renders
  through Gesture Handler's `ScrollView` (`renderScrollComponent`), so the two gestures
  arbitrate as one instead of fighting.
- **Two views of the same data share one row builder.** The conversation list and the
  history drawer both call `src/chat/list.ts`; where they differ, the difference is an
  exported function with tests (`drawerRows`) rather than a ternary in JSX, because Jest
  cannot reach a `.tsx` file here. A heading that reads *Older · 34* in one view and
  *Older · 35* in the other is a bug no gate would catch.
- **One piece of state gets one control.** A global setting lives on exactly one screen;
  where another surface needs it, that surface *reports* the value and navigates. The
  three built-in tool switches were **moved** out of the settings hub to
  `app/settings/tools.tsx` rather than copied into the conversation menu — the ⋯ menu's
  *Tools* row renders `summariseTools` and pushes that screen. Two switches over one
  boolean is a bug waiting for the second one to be edited, and it makes the answer to
  "is web fetch on?" depend on which screen you asked. The same rule points outwards:
  **if the platform already owns the control, we do not build a second one.** There is no
  in-app haptics switch because Android Settings has *Touch feedback*, and no in-app
  notification toggle because the OS owns the channel — an app-level copy would be a
  switch that can disagree with the one the user already found.
- **A shortcut into a form is not a second way to create the thing.** The connector
  directory prefills the MCP add form and saves nothing; the user confirms the URL and
  the form's own `validate` runs either way. If a shortcut ever writes directly, it
  becomes a second validation path free to drift from the first.
- **Destructive actions confirm, and the confirmation says what is actually lost** —
  including platform truths the user cannot see, like the clipboard keeping a copy.
  Destructive confirmations carry a haptic on activation.
- **Components are not unit-tested by design** (`jest.config.js` matches `*.test.ts`,
  never `.tsx`). That is the trade for the purity split, and it raises the bar on
  keeping logic out of `.tsx` files: if you find yourself wanting to test a screen,
  the logic you want to test belongs in `src/chat/` or a store.

---

## 9. Networking, transports and untrusted input

- **Transports take an injected `fetch`.** That is what makes the whole suite runnable
  in `node` with no device, so keep it.
- **HTTPS only. No plaintext origin is accepted**, and user-store CAs are refused by
  `plugins/with-system-ca-only.js`.
- **Every request has a timeout and an abort path.** A stream that dies must leave the
  partial reply stored and marked aborted, never discarded silently.
- **Errors carry a kind, and the kind must not claim more than the response proves.**
  `client_rejected` and `key_rejected` were merged into one `unauthorized` because a
  no-key request returns the identical body — inventing a distinction the wire does
  not support is worse than admitting the ambiguity.
- **Anything arriving from outside is validated at one boundary and only there:**
  model output through the block parser and `parseMemory`; deep links through the
  `state` nonce match; skill archives through the frontmatter parser and the zip
  guard; restored settings through the same store `validate` the form uses; inbound
  files through `src/chat/incoming.ts`. Add your path to the existing boundary rather
  than creating a second one.
- **Two of those boundaries refuse rather than sanitise, and must stay refusals.**
  An "open with" intent is accepted only as a `content://` URI from a system provider —
  `file://` is refused with the reason shown, because `file:///data/data/<package>/…`
  can name this app's own encrypted database. And untrusted markup or model-written
  JavaScript loads *only* in the sealed WebView (`default-src 'none'`, inline style and
  script and nothing else, no bridge, no network, no storage, navigation away refused,
  `run_code` abandoned after five seconds). **Never widen that CSP to make something
  render.** The engine that runs model output is deliberately not the engine holding the
  keys.
- **`fetch_url` re-checks the address it landed on**, not just the one it was given, so a
  public host cannot redirect the fetch onto a link-local or private address.
- **A tool that reaches outside the app or executes model output ships off.**
  `allowWebFetch`, `allowWebSearch` and `allowRunCode` all default to false, and a new
  tool of that shape defaults the same way.
- **Assume a hostile app can fire your deep link.** On Android any installed app can
  declare the same scheme, so match on a nonce, not on the URL prefix.

---

## 10. Tests

- **Every non-trivial change leaves one runnable check behind** — the smallest thing
  that fails if the logic breaks. A branch, a loop, a parser, a money path or a
  security path qualifies; a one-line pass-through does not.
- **Test the behaviour that prevents the failure, not the implementation that
  achieves it.** `src/chat/memory.test.ts` is the model: its four groups are the four
  failure modes the module was written against, in order.
- **Name the test after the property.** `'blocks the exactly-equal case, which leaves
  zero'` beats `'test maxTokens 3'`.
- **Comment a test when the input choice is load-bearing** — e.g. why the
  `MAX_PER_TURN` fixture uses deliberately unrelated sentences (near-duplicates would
  be folded first, and the test would then be measuring the wrong limit).
- **Database tests use real SQLite** (`node:sqlite`) against `ddl.ts`. Do not mock a
  database when a real one is available in-process.
- **Do not mock native modules.** If a module cannot be tested without a mock, split
  the decision out of it (§2).
- **The `node` test environment is a design constraint, not a setting.** `testMatch` is
  `*.test.ts` only, `roots` is `src/`, and there is no setup file — so any module a test
  can reach must keep `react-native` out of its import graph. One `react-native` import
  in a tested module's graph breaks the whole suite, not one test. This is why
  `saveToFolder` reaches `expo-file-system/legacy` through a dynamic `import()` and why
  `files.ts` and `attach.ts` branch on whether a picker is *available* rather than on
  `Platform.OS`.
- **Do not assert on wall-clock timing.** `src/chat/list-cost.test.ts` is the one place
  that measures anything, and it used to hold absolute ceilings — 2,000 ms for a
  1,000-body markdown parse, 150 ms for the two list guards. This file predicted they were
  "the most likely test to flake on a loaded machine" and on 2026-09-02 they did, twice,
  under nothing more exotic than a second Jest run on the same box. They are now **ratios**:
  each guard times a quarter of the input, then all of it, and asserts the larger run cost
  under 12× the smaller (linear is 4, quadratic is 16). Both halves meet the same load, so
  load cancels. Two details that make it work and should not be dropped — `fastest()` takes
  the *minimum* of three runs, because contention only ever adds time, and each unit repeats
  its work 20× so the measurement stays far enough above timer resolution to divide. If you
  need a new cost guard, measure a shape, never a duration.
- **Assert the negative for security properties.** "The key does not appear in the
  export" is checked by grepping the produced artefact, not by trusting the code path.
- **Where an import cycle forces two modules to know the same thing, the test that can
  see both is where the agreement lives.** `src/chat/plan.ts` imports
  `src/chat/builtins.ts`, so `summariseTools` cannot ask `blockedInPlanMode` which tools
  plan mode blocks — the *writing blocked* wording is a deliberate copy, and
  `builtins.test.ts` asserts the copy still matches the real split. Prefer deleting the
  duplication; when the import graph forbids that, a red test is a much cheaper way to
  find out than a user reading a tool summary that contradicts the gate.
- **Do not test that somebody else's server is up.** `src/mcp/catalog.test.ts` checks the
  eleven bundled connector URLs against this app's own `parseServerUrl` and
  `qualifyToolName`, so no entry can ship that the add form would reject. It does not
  check that anything answers, because a suite that goes red during a vendor outage is a
  suite people learn to ignore. Liveness belongs in the device protocol
  ([07_Deployment.md](07_Deployment.md) §7 step 72), which also says what a failure
  means: the entry is stale, fix the catalogue, not the handset.

---

## 11. Dependencies and native changes

- **Adding a dependency is a decision that needs a reason in the commit.** Prefer the
  stdlib, then an already-installed package, then a few lines of our own. Four features
  landed with no new dependency at all and that is the bar: charts are views and text
  (no chart library, no `react-native-svg`), `.docx`/`.xlsx`/`.pptx` are generated XML
  through the already-present `fflate`, spoken replies use the OS engine (no audio
  library), and the code sandbox is the WebView that was already there for artifacts.
  The connector directory is the fifth and the cheapest: eleven vendor endpoints as a
  frozen array in `src/mcp/catalog.ts`, no registry client and no network call, reaching
  the same add-form path a hand-typed URL takes. `expo-camera` is the one that cleared
  the bar rather than being talked out of it: a viewfinder is a native surface, and there
  is no way to take several photos in a row and keep two of them without one.
- **Expo SDK modules are the default choice** for anything native, pinned to the SDK's
  own range (`~57.0.x`). Do not float a native module's version.
- **Ask a config plugin for less, not more.** A native module's default flags are the
  vendor's, not ours: `expo-camera` is configured `recordAudioAndroid: false` (the app
  never records video, so the manifest must not claim `RECORD_AUDIO` on the camera's
  account) and `barcodeScannerEnabled: false` (which drops ML Kit from the APK
  entirely). Read the plugin's source before you set a flag — in `expo-image-picker`,
  `cameraPermission: false` does not mean "unused", it calls `withBlockedPermissions`
  and strips `android.permission.CAMERA` from the merged manifest, which would disable
  `expo-camera` with nothing failing anywhere a gate can see.
- **A new native module or config-plugin flag means the APK must be rebuilt**, and
  **the gates cannot verify it at all.** The list is long now: SQLCipher, `expo-camera`,
  `expo-speech`, `expo-speech-recognition`, `expo-local-authentication`, `expo-print`,
  `expo-sharing`, `react-native-webview`, `react-native-gesture-handler`, `expo-blur`,
  `expo-linear-gradient`, `@expo/vector-icons`, and the `intentFilters` block in
  `app.json`. When you land one:
  1. Say so explicitly in the PR or handover — "this changes the native build".
  2. Add it to the rebuild note in [../progress.md](../progress.md) and mark the
     CHANGELOG entry **needs a rebuild**.
  3. Do not claim it works until an APK has run on a device.
- **`expo-updates` is enabled, and that is remote-code trust taken deliberately.** It is
  the only route a JavaScript security fix has to a device that installed an APK by hand.
  The mitigations are load-bearing, not decorative: the channel is signed by Expo, the
  `runtimeVersion` policy is `appVersion` so an update cannot cross a native boundary, and
  `fallbackToCacheTimeout: 0` means a slow or hostile network delays nothing and falls
  back to the bundle already on the device. Do not change any of the three without
  re-reading why they are there. **An OTA update cannot ship a native change** — if your
  fix touches a native module, a config plugin or `app.json`, it is a build.
- **Check `pnpm audit` on every Expo or React Native bump** and record the verdict in
  [flaws.md](flaws.md) §5, including advisories deliberately not overridden because
  they live in build tooling that never reaches the device.

---

## 12. Documentation discipline

- **Code comments say why.** If the explanation is longer than the code, the code is
  probably wrong — but a deliberate trade-off with a known ceiling always gets a
  comment naming the ceiling.
- **When behaviour changes, the doc that describes it changes in the same commit.**
  The map: [05_Data_Model.md](05_Data_Model.md) for storage and schema,
  [../ARCHITECTURE.md](../ARCHITECTURE.md) for the layer map and security posture,
  [TRD.md](TRD.md) for technical requirements and quality gates, [PRD.md](PRD.md) for
  product scope and non-goals, [USAGE.md](USAGE.md) for anything a user can see,
  [../SECURITY.md](../SECURITY.md) for scope and accepted risk,
  [flaws.md](flaws.md) for findings and their fixes,
  [../CHANGELOG.md](../CHANGELOG.md) for the release-facing summary, and
  [../progress.md](../progress.md) (plus [../progress-v1.1.md](../progress-v1.1.md)) for
  what is built and what is next.
- **A cross-reference is a fact and goes stale like one.** If you renumber a section,
  grep for references to the old number before you finish — `USAGE.md` §8.1 became §15.1
  and the references in `CHANGELOG.md` and `SECURITY.md` had to move with it.
- **A finding is never deleted once fixed** — the fix is recorded under it. The
  original reasoning is the useful part, and a file that deletes its closed items
  reads as if the app were never wrong.
- **Retract wrong claims explicitly rather than quietly editing them.** `flaws.md`
  §2.2 says in as many words that its own earlier "encryption is impossible in managed
  Expo" claim was false. That is the required shape: someone who read the old version
  needs to know it changed.
- **Do not create new top-level docs.** The set above is complete; add a section to an
  existing file.

---

## 13. Before a release build

Run in order, and do not skip a step because the last build was fine:

1. `pnpm run gates` — clean.
2. `pnpm expo export --platform android --output-dir .expo-export` — the bundle gate
   (§1). It catches an unresolvable route, which is the one thing `typedRoutes` cannot do
   here (`.expo/types/` is generated by the dev server and gitignored, so CI structurally
   cannot have it), and any import that only Metro resolves differently from Jest.
   `.expo-export/` is gitignored, so there is nothing to clean up afterwards.
3. `pnpm run build:preview` (or `build:preview:local` with Android SDK tooling present),
   then install on a real device. `build:production` is the same APK on the `production`
   channel with `autoIncrement` on.
4. **On-device smoke pass:** first launch on an *existing* install (this is what
   exercises the database migration and the plaintext→encrypted conversion), a real
   send, a background/foreground cycle mid-stream, an export, and the app lock if it
   is enabled. Add the native surfaces the gates cannot see: dictation, read-aloud,
   voice mode, the camera (photograph a page of text and check the preview is upright —
   a rotated or stretched preview is a release blocker, and an emulator will not show
   you), the drawer at a few hundred chats, a chart, a generated document and its
   preview, "open with" from a file manager, and a `run_code` call. Add one connector
   from the directory end to end — it is the one step whose failure means *the bundled
   entry is stale*, not that the build is broken. Then the four things no gate here can
   even attempt: **TalkBack** through a whole turn (one announcement when the reply
   lands, not a stream read from the top), the **largest** system font size on the
   settings steppers and composer, **Reduce Motion** on (motion shortens, the spinner
   still turns), and a sheet with a screen reader running to confirm focus stays inside
   it. The full 79-step protocol is [07_Deployment.md](07_Deployment.md) §7.
5. **Grep the export artefact for the key.** Automated in
   `src/chat/export.test.ts`, worth eyeballing once on a real transcript.
6. Confirm `allowBackup: false` and the no-backup config plugin are still in the built
   manifest — they are the reason a restored install cannot carry credentials. Confirm
   at the same time that `app/src/main/res/xml/network_security_config.xml` in the
   *generated* project still says `cleartextTrafficPermitted="false"`; the permissive
   copy belongs to `src/debug` only.
7. Update [../CHANGELOG.md](../CHANGELOG.md) — Added / Changed / Fixed / Known issues /
   Release facts, per [07_Deployment.md](07_Deployment.md) §11.1 — and bump both
   `expo.version` and `expo.android.versionCode` in `app.json`. `pnpm run release:patch`
   (or `minor`/`major`) does both via `scripts/bump-version.mjs`.
8. Update [../progress.md](../progress.md): what was verified on hardware, and what
   remains verified only by the gates.
9. **A JavaScript-only fix can go out as an update instead** — `pnpm run update:preview`
   or `update:production`, with `update:rollback` if it goes wrong. Anything touching a
   native module, a config plugin or `app.json` cannot: it is scoped to the
   `runtimeVersion` the APK was built with, so it ships as a new build. To check one
   landed, open Settings on the device: an *Update → Restart to finish updating* row
   appears only while a downloaded bundle is pending, and tapping it applies the bundle
   without waiting for the OS to kill the app. No row means nothing was downloaded —
   check the channel and the `runtimeVersion`, not the device.

---

## 14. Decisions not to silently undo

Each of these was reasoned through and is recorded in `flaws.md` or `progress.md`.
Reversing one is allowed; doing it without reading why it is there is not.

- The database key is **not** auth-gated, and there is **no escrow** — clearing app
  data destroys the conversations by design.
- Global memory off costs **exactly nothing**: no prompt block *and* no distillation
  request. A per-conversation flag cannot switch it back on.
- The default system prompt is **copied in at conversation creation**, not prepended at
  send time, so editing it later leaves tuned conversations alone and the stored
  transcript matches what was actually sent.
- Stop sequences are **newline-separated and untrimmed** — a comma is a legitimate
  stop sequence and so is a trailing space.
- Certificate pinning is **deliberately absent**: users point this app at their own
  gateway origins, so pinning a certificate we do not control turns an operator's
  rotation into what looks like a network outage. The system-CA-only config is the
  mitigation, and **cleartext is refused in the release network security config** with
  the permissive copy scoped to `src/debug` — do not collapse the two files back into
  one to silence a dev-server complaint.
- There is **no request concurrency cap**: a semaphore has its own deadlock and
  starvation modes, against a bound the single-conversation UI already imposes.
- Components are **structurally untested**, on purpose.
- Backgrounded streaming **cannot** be fixed in the managed workflow. It needs a
  foreground service. What exists instead is honest handling of the consequence.
- **Charts are drawn with views and text**, not a canvas and not `react-native-svg`. The
  cost is a small set of supported shapes, and anything outside it returns
  `{kind: 'unsupported', why}` so the fence degrades to a code block with a reason. The
  benefit is that a chart cannot execute, which is the point when the spec came from a
  model.
- **The five voice styles are pitch and rate on the device's own voice**, not five
  recordings, and the picker says so. `expo-speech` reports word boundaries on iOS only,
  which is why the script is one utterance per step driven by `onDone` and why the
  highlight moves a paragraph at a time on Android. Never let a step exceed `MAX_STEP`:
  it is both the utterance handed to an engine that refuses long input *and* the run of
  text highlighted on screen, so an escaped cap breaks the speech and the sync at once.
- **A generated Office file is read-only in the app**, and says why. The reader recovers
  words, not layout, so a save would silently drop the formatting.
- **The in-app camera is the only camera, and a shot is encoded once at the end.** The
  `expo-image-picker` hand-off to the system camera was deleted rather than kept as a
  fallback — it needs the same `CAMERA` permission and the same `ingestAssets` pipeline,
  so two rows would be a fork with no basis for choosing. Shots stay as file URIs until
  the user presses *use*; encoding on the shutter would hold several decoded bitmaps at
  once, which is the exact shape `ingestAssets` is sequential to avoid. `discardShots`
  is what makes that affordable, so do not remove it — an abandoned session must delete
  its own JPEGs.
- **`ACTION_SEND` is left unhandled rather than half-pretended.** Android delivers a
  shared payload in `EXTRA_TEXT` / `EXTRA_STREAM`, and both `Linking.getInitialURL()` and
  Expo Router's `+native-intent.tsx` see only `getIntent().getData()` — so "share to this
  app" cannot be written in JavaScript at all, however the route is arranged.
  `ACTION_VIEW` ("open with") works and is what ships. Building the other half means a
  native dependency, a manifest `intent-filter` and a rebuild, so it is recorded as a
  flagged gap rather than a half-working row that appears in the share sheet and drops
  the file.
- **Attachment bytes never reach SQLite or an export.** They live in memory for the
  turn. The ceiling that follows — twenty per conversation, base64 in the request body —
  is a stated limitation, not a bug to work around by persisting them.
- **The connector directory is a dated snapshot that prefills a form, and every part of
  that is load-bearing.** `CATALOG_AS_OF` is the knowledge cutoff, not the build date —
  the build date is the flattering number. Each entry carries a vendor `docs` URL because
  endpoints move, and a `reach` line that is vendor documentation rather than anything
  this app enforces: the approval gate, not that sentence, is what stands between the
  model and a tool. Tapping an entry **saves nothing**. If a connector fails, the entry is
  stale — fix `src/mcp/catalog.ts` so every install gets the fix, never just the handset.
- **The three writing built-ins have no switch, and the screen says so** rather than
  showing three switches that are always on. They write into this app's own cache and go
  nowhere until the user picks a destination, so there is no reach to withhold; plan mode
  still blocks them by effect. A writer that ever reaches outside the sandbox needs a
  switch, and that is the moment to revisit this.
- **Settings' *Restart to finish updating* row is not a second update mechanism.** It is
  `reloadAsync()` on an already-downloaded bundle, shown only while `useUpdates()` reports
  one pending. It does not check, download, choose or roll back — `expo-updates` still
  owns all of that on its `ON_LOAD` schedule. The row exists because the alternative was
  a bundle sitting on disk until the OS happened to kill the app, which for a resident
  app can be days. Do not grow it into a *Check for updates* button: that is a second
  policy over the same state, and the honest version of it is "restart the app".
- **A draft does not survive process death**, and that is a storage decision rather than
  a missing feature. Persisting it means AsyncStorage in `src/stores/chat.ts`'s import
  graph and a rehydrate-versus-keystroke race — the restored draft can land on top of
  what the user is already typing. The draft survives navigation, which is the case that
  actually happens.

---
