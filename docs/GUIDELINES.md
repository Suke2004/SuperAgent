# Contributing guidelines

**SuperAgent / AgentRouter Mobile ("Jarvis") — how to change this app without breaking it**

| | |
|---|---|
| **Audience** | Anyone writing code in this repository, human or agent |
| **Status** | Normative. Where this file disagrees with a habit from another project, this file wins. |
| **Companion docs** | [../README.md](../README.md) · [../ARCHITECTURE.md](../ARCHITECTURE.md) · [05_Data_Model.md](05_Data_Model.md) · [06_Eng_Plan.md](06_Eng_Plan.md) · [07_Deployment.md](07_Deployment.md) · [flaws.md](flaws.md) · [USAGE.md](USAGE.md) · [../progress.md](../progress.md) |

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
   tests with coverage. A change that cannot pass the gates is not finished.
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

Rules about the gates themselves:

- **Zero TypeScript errors, always.** There is no allowance for "it's only a type
  error"; `strict` and `noUncheckedIndexedAccess` are on deliberately.
- **Zero ESLint errors.** Warnings are tolerated only where they already exist
  (`import/first` in a handful of test files that mock before importing); do not add
  new ones.
- **The coverage thresholds in `jest.config.js` are a ratchet, not a target.** They
  sit two points under the current measurement. Raise them when a run comes in
  comfortably higher. **Never lower them to make a red run green** — that is the one
  edit that makes the gate meaningless.
- **A native change cannot be verified by the gates at all.** See §11.

---

## 2. Where code goes

```
app/                 expo-router screens. Routing and layout only.
src/components/      Reusable UI. `ui.tsx` holds the primitives.
src/stores/          Zustand state. The only thing screens talk to.
src/chat/            Pure chat logic: prompts, memory, trimming, export, tools.
src/db/              SQLite. `ddl.ts` is the schema, `schema.ts` opens it.
src/transports/      Provider wire formats. Anthropic and OpenAI dialects.
src/mcp/             MCP client, protocol and OAuth.
src/lib/             Cross-cutting: log, redact, secureKey, storage, appLock.
src/theme/           Tokens. Nothing hard-codes a colour or a spacing value.
```

**The dependency direction is one-way: `app/` → `stores/` → `db/`+`chat/`+`transports/`
→ `lib/`.** A screen never writes SQL and never calls a transport. A store never
imports a screen. `lib/` imports nothing from the layers above it.

**Put logic where it can be tested.** The single most useful habit in this codebase
is extracting the decision from the IO: `src/db/cipher.ts` exists precisely so the
SQL-interpolation guard has a unit test without a device, and `src/db/schema.ts`
keeps the native calls it cannot test. Do the same for any new native-touching
module.

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
| **SQLite** (`expo-sqlite`, WAL) | Unbounded, queryable or historical data: conversations, messages, tags, usage events, memories, MCP servers, skills | **Yes** — SQLCipher, AES-256, key in the Keystore |
| **AsyncStorage** (`zustand/persist`) | Bounded config objects read at boot and rewritten wholesale: provider profiles, model metadata, settings | **No — plaintext on a rooted device** |
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
- **Persisting on every keystroke is a bug.** A multi-line field held in local state
  and committed on blur is the pattern (see the default system prompt in
  `app/settings/prompts.tsx`); AsyncStorage writes are not free.

---

## 8. UI and accessibility

- **Compose from `src/components/ui.tsx`** — `Screen`, `Section`, `Row`, `Field`,
  `Button`, `Note`, `Empty`, `Spinner`, `SwitchRow`, `Inline`. Do not hand-roll a
  control that exists there; extend the primitive instead.
- **No hard-coded colours, spacings or font sizes.** `useTheme()` tokens only, so
  dark mode and the accent choice keep working.
- **Every interactive element needs an accessible label**, and a hint where the
  outcome is not obvious from the label (`accessibilityHint="Opens edit and delete"`).
  A disabled control states *why* it is disabled (`disabledReason`) rather than being
  inert and mysterious.
- **Long lists use `@shopify/flash-list`** with keyset paging from the database, not
  `.map()` over everything.
- **Destructive actions confirm, and the confirmation says what is actually lost** —
  including platform truths the user cannot see, like the clipboard keeping a copy.
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
  guard; restored settings through the same store `validate` the form uses. Add your
  path to the existing boundary rather than creating a second one.
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
- **Assert the negative for security properties.** "The key does not appear in the
  export" is checked by grepping the produced artefact, not by trusting the code path.

---

## 11. Dependencies and native changes

- **Adding a dependency is a decision that needs a reason in the commit.** Prefer the
  stdlib, then an already-installed package, then a few lines of our own. `expo-sharing`
  was dropped from the plan for exactly this reason.
- **Expo SDK modules are the default choice** for anything native, pinned to the SDK's
  own range (`~57.0.x`). Do not float a native module's version.
- **A new native module or config-plugin flag means the APK must be rebuilt**, and
  **the gates cannot verify it at all.** SQLCipher, `expo-speech` and
  `expo-local-authentication` are all in this category. When you land one:
  1. Say so explicitly in the PR or handover — "this changes the native build".
  2. Add it to the rebuild note in [../progress.md](../progress.md).
  3. Do not claim it works until an APK has run on a device.
- **`expo-updates` is deliberately disabled.** Re-enabling OTA means re-accepting a
  remote-code channel; it does not happen without code signing.
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
  [USAGE.md](USAGE.md) for anything a user can see, [flaws.md](flaws.md) for findings
  and their fixes, [../progress.md](../progress.md) for what is built and what is next.
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
2. `npx expo export --platform android` — catches an unresolvable route, which is the
   one thing `typedRoutes` cannot do here (`.expo/types/` is generated by the dev
   server and gitignored, so CI structurally cannot have it).
3. `pnpm run build:apk`, then install on a real device.
4. **On-device smoke pass:** first launch on an *existing* install (this is what
   exercises the database migration and the plaintext→encrypted conversion), a real
   send, a background/foreground cycle mid-stream, an export, and the app lock if it
   is enabled.
5. **Grep the export artefact for the key.** Automated in
   `src/chat/export.test.ts`, worth eyeballing once on a real transcript.
6. Confirm `allowBackup: false` and the no-backup config plugin are still in the built
   manifest — they are the reason a restored install cannot carry credentials.
7. Update [../progress.md](../progress.md): what was verified on hardware, and what
   remains verified only by the gates.

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
  mitigation.
- There is **no request concurrency cap**: a semaphore has its own deadlock and
  starvation modes, against a bound the single-conversation UI already imposes.
- Components are **structurally untested**, on purpose.
- Backgrounded streaming **cannot** be fixed in the managed workflow. It needs a
  foreground service. What exists instead is honest handling of the consequence.

---
