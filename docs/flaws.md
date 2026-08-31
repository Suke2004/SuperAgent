# Flaws, gaps and security findings

Audited at commit `f6db5a5`, 2026-08-30, revised the same day after the second fix
pass, again on 2026-08-31 after cross-checking a third-party audit against the code,
and a fourth time the same day during the V1 release-readiness sweep — §4 items 19–25,
which is where the findings from actually running the build live. Nothing here is a feature request — the outstanding feature work is in
[06_Eng_Plan.md](06_Eng_Plan.md) and `progress.md`. This file is the list of things
that are wrong, missing, or unverified in what already exists.

Every finding is kept even once fixed, with the fix recorded under it: the original
reasoning is the useful part, and a file that deletes its closed items reads as if
the app were never wrong. §4 is the running queue, §5 the dependency audit.

---

## 1. The gateway rejects every request (live, reproduced)

Reproduced from a desktop shell, so it is not a device or React Native problem.
Both domains, both dialects, every User-Agent, and with **no auth header at all**
return the same 401:

```bash
curl -sS -X POST https://agentrouter.org/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Authorization: Bearer sk-invalid' \
  -d '{"model":"claude-opus-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

```
401 {"error":{"message":"unauthorized client detected, contact support for assistance at
     https://discord.gg/aYq5B4RW3"},"message":"UNAUTHENTICATED","success":false,
     "type":"unauthorized_client_error"}
```

Identical for `GET /v1/models`, `POST /v1/chat/completions`, `https://ps.air-outer.com`,
`x-api-key` instead of Bearer, and for UAs `AgentRouterMobile/1.0 (Android)`,
`okhttp/4.12.0`, `python-requests/2.32.3` and curl's default.

Routing is fine: `GET /v1/nonexistent` returns a clean `404 invalid_request_error`
with an `X-Oneapi-Request-Id` header, confirming a one-api/new-api fork and that
requests reach the application layer. URL shape, `anthropic-version`, Bearer auth,
paths and `expo/fetch` resolution all check out. **The failure is server-side gating
that fires before the credential is considered.**

### 1a. The 401 classifier draws the wrong conclusion — ✅ fixed

[`src/transports/errors.ts:453`](../src/transports/errors.ts)

```ts
// Verified live: no-key requests return `unauthorized_client_error`, which is
// the client allowlist rather than the credential.
kind = CLIENT_REJECTED_RE.test(`${parsed.type ?? ''} ${message}`) ? 'client_rejected' : 'key_rejected';
```

Backwards. A **no-key** request returning `unauthorized_client_error` proves the
string carries no information about client identity — it is this gateway's generic
401. Consequences:

- `key_rejected` is dead code against AgentRouter.
- Every wrong, expired or absent key gets the `client_rejected` hint: *"this is
  about identity, not your key… contact gateway support to get this app approved"* —
  sending the user after an allowlist problem they may not have.

Fix: for this gateway, one ambiguous kind whose hint names both causes, credential
first.

### 1b. How to tell allowlist from bad key

Cannot be determined without a real key, and will not be determined by spoofing
another client's identity. With the real token (gitignored file or env var):

```bash
curl -sS -X POST https://agentrouter.org/v1/messages \
  -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
  -H "Authorization: Bearer $AGENTROUTER_KEY" \
  -d '{"model":"claude-opus-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

| Result | Meaning | Next step |
| --- | --- | --- |
| `200` | Gateway is fine; the app has a key-loading or profile fault | Check Settings → Providers shows a fingerprint, and that the **Anthropic** profile is active with base URL `https://agentrouter.org` (no `/v1`) |
| `401 unauthorized_client_error` | The allowlist. These gateways fingerprint a header *set*, not just UA | Add whatever headers the operator specifies via the profile's extra-headers editor |
| `403` | The model id | `claude-opus-5` is a seed guess and cannot self-correct — see 1d |

### 1c. The "cannot be overridden" claim in the header editor is only half true — ✅ fixed

[`app/settings/provider/[id].tsx:333`](../app/settings/provider/[id].tsx) says the
Authorization header cannot be overridden. True for `Authorization` with a capital
A only — `buildHeaders` applied auth last, so that key won. But `User-Agent` and a
lowercase `authorization` both passed straight through `this.extraHeaders`. So the
"honest, static User-Agent, never impersonate another client" guarantee in
[`src/transports/http.ts:35`](../src/transports/http.ts) was a **default, not an
enforcement**, and a lowercase `authorization` produced two conflicting header
entries whose precedence was decided by the native networking layer.

Now enforced in `buildHeaders` itself: any header whose lower-cased name is
`authorization`, `x-api-key` or `user-agent` is deleted after the merge and before
the real ones are set, so the claim holds for every request regardless of what
reached the profile — including one restored from a backup written by an older
build. `src/transports/__tests__/headers.test.ts` asserts all three.

### 1d. Knock-on effects of the 401

- `GET /v1/models` is behind the same gate, so discovery cannot run pre-auth and
  `adoptDiscoveredModel` can never correct the seeded model id. A fresh install is
  stuck on a guess.
- `withFailover` only fails over on `kind: 'network'` (correct — a 401 means the
  primary is up), so the backup domain is untested code in practice.

---

## 2. Security and data leakage

Ordered by impact.

### 2.1 Android auto-backup is enabled — the whole chat history is backup-eligible — ✅ fixed

[`app.json`](../app.json) sets no `android.allowBackup: false` and no
`dataExtractionRules`; the Expo manifest template defaults to `true`. Eligible for
Google Drive backup and for `adb backup`:

- the unencrypted SQLite database — every conversation and every distilled memory;
- every attachment, since images are stored as **base64 in table cells**
  ([`src/db/content.ts`](../src/db/content.ts));
- all of AsyncStorage, including provider profiles and key fingerprints.

The API key itself survives correctly: Keystore material is not backed up, so a
restored SecureStore blob is undecryptable. The transcript has no such protection.
Highest-impact finding, smallest fix.

### 2.2 The database was plaintext — ✅ fixed: SQLCipher, key in the Keystore

**The earlier claim in this section was wrong.** It said `expo-sqlite` in the managed
workflow exposes no key parameter and that encryption therefore needed the bare
workflow. That is false for SDK 57: `expo-sqlite@57.0.1` vendors SQLCipher at
`vendor/sqlcipher`, and its own config plugin accepts `{ android: { useSQLCipher:
true } }`, which sets the gradle property that switches the sources and adds
`-DSQLITE_HAS_CODEC=1`. FTS5 is unaffected. `app.json` now sets it.

The whole file — conversations, messages, memories, MCP server rows — is AES-256 at
rest under a 32-byte CSPRNG key held in one SecureStore slot (`agentrouter.dbKey`,
Android Keystore) and nowhere else. [`src/db/schema.ts`](../src/db/schema.ts)
mints the key before the first statement and issues `PRAGMA key` before any other
pragma, because on an encrypted database every statement before the key fails. The
raw-hex form (`PRAGMA key = "x'<64 hex>'"`) is used rather than a passphrase, which
skips 256k PBKDF2 rounds on every open; the key is already full-entropy.
[`src/db/cipher.ts`](../src/db/cipher.ts) is the whole of the string handling and
imports nothing, so the interpolation guard is unit-tested
([`cipher.test.ts`](../src/db/cipher.test.ts)) without a device.

An existing plaintext database is converted once, on the next open, via
`sqlcipher_export` into `agentrouter.converting.db` followed by **two** moves
(original → `agentrouter.plaintext.db`, converted → the real name) rather than a
delete-then-move, so a process killed mid-swap always leaves one intact copy; the
recovery branch at the top of `convertIfPlaintext` picks it up. Stale `-wal`/`-shm`
siblings are deleted, since they would otherwise be read as belonging to the
encrypted file that took their base name.

Two things this deliberately does not do, and one caveat:

- **No `requireAuthentication` on the key.** It would deny database access whenever
  the device is locked, which breaks the offline send queue and background
  delivery. The app lock below is the user-facing gate; it is a separate concern.
- **No key escrow.** Losing the Keystore entry — app data cleared, app uninstalled
  — means the database is unrecoverable by design. Restoring app data onto a device
  whose Keystore never held the key produces a clear error rather than a corruption
  report, and `allowBackup: false` (§2.1) means that path should not arise.
- **Unverified on-device.** The flag changes the native build, which cannot be
  compiled in the authoring environment. An EAS or local APK run is required before
  this is trusted.

Settings → Privacy → **Require unlock to open**
([`src/lib/appLock.ts`](../src/lib/appLock.ts), `expo-local-authentication`) stays,
and is now complementary rather than a substitute: it gates the app behind the
device's biometric or PIN on cold start and on every return from the background,
off by default, disabled with a reason when nothing is enrolled, and enabling it
requires passing the prompt first so a broken sensor cannot lock a user out.

### 2.3 `profile.headers` is persisted plaintext to AsyncStorage — ✅ fixed

[`src/stores/providers.ts:238`](../src/stores/providers.ts) partializes `profiles`
wholesale, `headers` included. The type comment says "Never holds the key" and
nothing validates it, while the UI invites exactly the kind of header that does.
The redactor's `SECRET_KEY_RE` scrubs `authorization`/`x-api-key` from the debug log
and from exports, but not from the store write.

Fix: screen at the settings boundary — reject a secret-looking header key, or route
its value into SecureStore beside the API key.

### 2.4 `keyFingerprint` leaks last-4 and exact length into plaintext storage — ✅ fixed

[`src/lib/redact.ts:122`](../src/lib/redact.ts) returns `sk-a…9f0c (48 chars)`.
That string is persisted to AsyncStorage, rendered in the UI, and permitted in
exports. First-4 is `sk-` and free; last-4 plus exact length is real, if small,
credential disclosure sitting in the one storage tier that is not protected. A
salted hash prefix distinguishes two keys just as well.

### 2.5 Memories are stored and replayed with no review gate — ✅ fixed

`memoryEnabled: true` by default, and `distil()` writes straight to the table.
Model-authored text is then prepended to the system prompt of **every** later
conversation. The redaction screen blocks secrets; nothing blocks *instructions*.

Attach a document, let the distiller decide a line in it is a durable user
preference, and the result is persistent cross-conversation prompt injection that
outlives the chat it entered through. The new "bring in a message" quoting feature
widens the same surface, though that one at least lands visibly in the draft.

Fix: a one-tap confirm the first time each memory is stored.

### 2.6 The web fallback writes the raw key to `localStorage` — ✅ fixed

[`src/lib/secureKey.ts`](../src/lib/secureKey.ts). Correctly labelled
development-only, but `npm run web` is a package.json script and
`react-native-web` is a dependency, so it was one command from real. Any injected
script read it, and it persisted across sessions.

Fixed by deletion: the `localStorage` path is gone and web keys live in a
module-scoped `Map` for the session only. Re-pasting a key after a refresh is the
whole cost, and web is not a supported target.

### 2.7 `expo-updates` is an unpinned remote-code channel — ✅ fixed

`updates.url` pointed at the EAS project with `runtimeVersion: appVersion` and no
`checkAutomatically` or `fallbackToCacheTimeout` configuration. Whoever controls
that project id could replace the JS bundle inside an installed APK.

Now `updates.enabled: false` with `checkAutomatically: "NEVER"` in
[`app.json`](../app.json). Nothing in the repo publishes an update — there is no
`eas update` script and no release process that expects one — so the channel was
pure attack surface. The dependency stays for the build config; the URL stays so
turning OTA back on is a one-line change, and if it is ever wanted the same change
should add `expo-updates` code signing rather than trusting the project id alone.

### 2.8 The key stays in the heap for the process lifetime — ✅ fixed

`clearCache()` existed in `secureKey.ts` and was called from nowhere in app code,
and `gateway.ts`'s transport cache held an `HttpClient` holding `apiKey` as a field
with no eviction.

[`app/_layout.tsx`](../app/_layout.tsx) now drops both on `AppState` `background`
(`clearCache()` + `invalidateTransports()`) and re-primes the redactor on `active`.
The re-prime is the part that is not optional: `clearCache` unregisters the key from
the redactor, so without a fresh read a log line written before the next request
would lose its protection. The Keystore copy is untouched, so the only cost is one
Keystore read per foregrounding.

### 2.9 Clipboard — ✅ addressed, as honestly as the platform allows

Whole-transcript copy with no sensitivity flag and no clear-after-timeout. On
Android it stays readable to other apps until overwritten.

`expo-clipboard` exposes no `EXTRA_IS_SENSITIVE` equivalent, and clearing the
clipboard on a timer would silently destroy whatever the user copied next — a data
loss bug traded for a marginal secrecy gain. So the export confirmation in both
export paths now says it: *"The clipboard holds it until you copy something else."*
The share sheet remains the default, and is what a large export falls back *from*,
not to.

### 2.10 The network security config permitted cleartext in release builds — ✅ fixed

[`plugins/with-system-ca-only.js`](../plugins/with-system-ca-only.js) wrote one
`network_security_config.xml` with `cleartextTrafficPermitted="true"`, and the comment
said why: Metro talks to a debug build over plain HTTP. True, and it also applied to
the release APK — so "HTTPS enforced, no plaintext origin accepted" was a property of
the app's own URL validation and not of the platform. Nothing the app sends needs
cleartext; a config that permits it is a standing allowance for anything else in the
process, including a dependency added later.

Fixed by writing two files instead of one. `app/src/main/res/xml` gets
`cleartextTrafficPermitted="false"`; `app/src/debug/res/xml` overrides the same
resource name with `true`. AGP resolves the debug source set for a debuggable variant,
so the dev server is unaffected, and the permissive file is absent from a release APK
entirely. Verified from the generated project after `expo prebuild` and from the
merged manifest of an `assembleRelease` build.

### 2.11 `userInterfaceStyle: "automatic"` was a config claim with nothing behind it — ✅ fixed

`expo prebuild` warned: *"userInterfaceStyle: Install expo-system-ui in your project
to enable this feature."* The key was therefore never applied to the native project.
Removed from [`app.json`](../app.json) rather than adding the module: `automatic`
already means "follow the system", the theme reads `useColorScheme()` from React
Native directly ([`src/theme/index.tsx`](../src/theme/index.tsx)), and a dependency
added to make a no-op key real is a dependency added for nothing. Confirmed by
prebuilding again: the warning is gone and the generated manifest is otherwise byte-identical.

### 2.12 The `expo-secure-store` backup-rules warning is benign — no change

`expo prebuild` reports *"Expo-secure-store tried to apply Android Auto Backup rules,
but other backup rules are already present."* The rules it wanted to add are ours:
`plugins/with-no-backup.js` writes `data_extraction_rules.xml` excluding `root`,
`database`, `sharedpref`, `file` and `external` from both `cloud-backup` and
`device-transfer`, and the manifest carries `android:allowBackup="false"` (§2.1).
Nothing is backup-eligible, so there is nothing for secure-store's narrower rules to
protect. Recorded here so the warning is not "fixed" by handing backup configuration
back to a plugin with a smaller exclusion set.

### 2.13 `expo-dev-client` sits in `dependencies` and does not ship in release — no change

A reviewer will read `expo-dev-client` in `dependencies` (not `devDependencies`) as a
debug menu and a launcher shipping in the production APK. It is not, and moving it
would break the development build, which is the only way to run this app at all
(Expo Go cannot load its native modules). `expo-dev-launcher/android/build.gradle`
wires every dev-menu component through a `debugOnly` helper that adds
`releaseImplementation` only when `expo.devlauncher.configureInRelease` is `true`; the
generated `android/gradle.properties` does not set it, so release resolves without
the launcher, the dev menu, or the network inspector. Verify with a rebuild, not a
guess, if that gradle property ever appears.

### What is actually right

No injection or code-execution issues found.

- `safeHref` is a scheme **allowlist** that strips C0/C1 controls, soft hyphen and
  the zero-width/bidi family *before* reading the scheme — the correct order, and
  the part most implementations get wrong.
- No WebView, no `eval`, no `Function()`, no `dangerouslySetInnerHTML`.
- FTS5 `MATCH` expressions are built by a dedicated escaping layer, not
  concatenated.
- `redact()` handles cycles and `Error` stacks; exports redact twice.
- Retry policy is genuinely conservative: 429/5xx/network only, honours
  `Retry-After`, full jitter, elapsed-time cap, never retries mid-stream.

---

## 3. Non-security flaws

**Streaming dies when the app is backgrounded.** Still open, and still not fixable
in JS: it needs a foreground service, which needs a native module and therefore the
bare workflow. Android suspends the socket and the idle timeout eventually kills it.
For long thinking-budget requests this remains the worst real-world defect in the
app. What exists instead is honest handling of the consequence — the partial reply
is kept and marked aborted rather than discarded, and the conversation is queued for
retry when the gateway is next known to be reachable.

**No request concurrency limit — accepted.** Two chats streaming at once are two
uncapped requests. The practical ceiling is low: the UI shows one conversation at a
time, so reaching two concurrent streams means starting one, navigating away, and
starting another. A semaphore in `HttpClient` would be real machinery — with its own
deadlock and starvation modes — against a bound the interface already imposes. Left
undone deliberately rather than forgotten.

**Physical-device verification: done.** The keyboard fix under edge-to-edge,
FlashList anchoring mid-stream, markdown baseline geometry, the attachment pipeline
and the share sheet have all been exercised on a real Android device by the author.
The two things a device run cannot retire are listed above (backgrounded streaming)
and below (`.expo/types/`). Note that `expo-speech` and
`expo-local-authentication` are native modules: both need a dev-client or APK
rebuild before "Read aloud" and the app lock exist on a device running an older
build.

**`.expo/types/` has never been generated**, so `experiments.typedRoutes: true`
enforces nothing and route-path typos are invisible. Generated by the dev server
rather than by any gate, and `.expo/` is gitignored, so CI structurally cannot have
it. Mitigated in practice by `expo export --platform android` in CI, which fails on
a route that does not resolve.

**Components are structurally untested by design.** `jest.config.js` matches
`*.test.ts` only. The purity split is a good decision; the consequence is that
`app/chat/[id].tsx` — the largest and most stateful file in the app — has zero
coverage. `selectTools`/`describeWithheldTools` are built with no call site (D-13).

**No key rotation or revocation path** beyond delete-and-repaste. No expiry or
last-used tracking on a credential that gates paid credits. Unchanged: rotation is
the gateway console's job, and the app cannot revoke a token it can only send.

---

## 4. Fix queue — ✅ everything on it is done

The original five, ascending by size:

1. ✅ `android.allowBackup: false` + `dataExtractionRules` in `app.json` (§2.1) — the
   config plugin `plugins/with-no-backup.js` writes both, because the managed
   workflow has no `AndroidManifest.xml` to edit.
2. ✅ The 401 misclassification in `errors.ts` (§1a) — `client_rejected` and
   `key_rejected` are now one `unauthorized` kind, since a no-key request returns
   the same body and the type therefore carries no information about which it was.
3. ✅ A secret-header guard on the providers store (§2.3).
4. ✅ A fingerprint that does not carry last-4 (§2.4).
5. ✅ A confirm gate before a distilled memory is stored (§2.5).

The second pass, 2026-08-30:

6. ✅ Credential and User-Agent enforcement moved into `buildHeaders` (§1c).
7. ✅ `localStorage` deleted from the web key path (§2.6).
8. ✅ OTA updates disabled (§2.7).
9. ✅ Key and transport caches dropped on background, redactor re-primed on
   foreground (§2.8).
10. ✅ The clipboard's persistence stated in the export confirmation (§2.9).
11. ✅ An optional app lock (§2.2).

The third pass, 2026-08-31 — prompted by a third-party audit ("AgentRouter Mobile —
Full App Audit"), cross-checked finding by finding against the code:

12. ✅ SQLCipher enabled, key in the Keystore, one-time conversion of an existing
    plaintext file (§2.2). This retracts the "not possible in managed Expo" claim
    that §2.2 and the audit both made.
13. ✅ `proxy-authorization` refused alongside `authorization` in the MCP server form
    ([`src/stores/mcp.ts`](../src/stores/mcp.ts)) — the one credential header that
    genuinely slipped past, and since that path is also the only way in from a
    settings restore, a hand-edited backup gets the same refusal the form does. The
    audit's wider claim, that a restored row reaches the database unvalidated, is
    wrong: restore goes through `useMcp.create` → `validate`.
14. ✅ The MCP client enforces its own `User-Agent` and `Authorization` rather than
    merely defaulting them ([`src/mcp/client.ts`](../src/mcp/client.ts)) — §1c fixed
    this in `transports/http.ts` and the same spread order was still here, so a
    configured `User-Agent` used to win.
15. ✅ The OAuth `state` nonce is no longer truncated to 32 characters, and the
    deep-link listener now requires it to match ([`src/mcp/oauth.ts`](../src/mcp/oauth.ts)).
    A forged callback could never obtain a token — the existing `state` check refused
    it — but settling the promise on one would abandon the real callback arriving a
    moment later, so any app declaring the same scheme could have broken the flow
    every time.
16. ✅ The 3-second hydration fallback logs which stores it gave up on
    ([`src/lib/storage.ts`](../src/lib/storage.ts)). It still renders defaults, which
    is the right call, but "my provider profile is gone" is now diagnosable from
    Settings → Debug instead of looking like data loss.
17. ✅ The web build says out loud, once per session, that its in-memory key store is
    a page variable any injected script can read
    ([`src/lib/secureKey.ts`](../src/lib/secureKey.ts)). The comment was not on
    screen when someone pasted a key.
18. ✅ Per-conversation memory opt-out, a default system prompt for new
    conversations, and a stop-sequence field in the model controls — the three
    genuinely missing items from the audit's feature list that were small and
    self-contained. Most of that list was already shipped.

The fourth pass, 2026-08-31 — the pre-release readiness sweep, whose findings came
from running the checks rather than reading the code:

19. ✅ Cleartext refused in the release network security config, permitted only in the
    debug source set (§2.10). Found by reading the *generated* project after
    `expo prebuild`, which is the only place the claim could be checked.
20. ✅ `userInterfaceStyle` removed — a key `expo prebuild` was silently declining to
    apply (§2.11).
21. ✅ `pnpm lint` failed on a file inside `.claude/worktrees/`, agent scratch space that
    is gitignored but was not in `eslint.config.js`'s `globalIgnores`. A gate that fails
    for a reason unrelated to the commit is a gate people learn to ignore.
22. ✅ 45 `import/first` warnings in the suite silenced *at the rule*, scoped to test
    files, because `jest.mock` hoisting is why those imports are in the module body.
    Warnings nobody can act on train people to skim past the ones they can.
23. ✅ `package-lock.json` was tracked despite being gitignored and this being a
    pnpm-only project; `mockups/` was gitignored despite being tracked. Both are the
    same class of bug — `.gitignore` disagreeing with the index — and both make
    `git status` less trustworthy.
24. ✅ `ARCHITECTURE.md` §7 still said the database was plaintext on disk, three passes
    after §2.2 encrypted it.
25. ✅ The open-source surface: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`,
    `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.gitattributes`, issue and PR templates,
    Dependabot, and a README that documents what is in the repository rather than what
    was intended.

Audit findings rejected, with the reason, so they do not come back:

- **Migration 5→6 back-approving memories.** The app is version 1.0.0 / versionCode
  1 and has never been released, so no pre-migration-6 database exists anywhere.
- **Certificate pinning.** Detecting a user-installed CA needs a native module. The
  system-CA-only network security config (`plugins/with-system-ca-only.js`) already
  refuses user-store CAs, which is what pinning was being asked to achieve, and it
  costs nothing at rotation time.
- **Unsanitised skill bodies.** Already handled at
  [`app/settings/skills.tsx:269`](../app/settings/skills.tsx).
- **Backup-restored MCP credentials.** Closed by §2.1 (`allowBackup: false`).
- **A reversible FNV-1a key fingerprint.** The audit is right that FNV-1a is not a
  cryptographic hash, but the fingerprint no longer carries last-4 or exact length
  (§2.4) and its input is a full-entropy API key, so there is nothing to brute-force
  back. It exists to tell two keys apart in the UI, not to protect the key.

What is left is in §3, and each item there now says why it is left rather than
implying it is next: backgrounded streaming needs the bare workflow, the concurrency
cap is machinery against a bound the UI already imposes, `.expo/types/` cannot exist
in CI, and key rotation belongs to the gateway console.

---

## 5. Dependency audit, 2026-08-30

`pnpm audit` and `pnpm audit --prod` report the same three advisories, and all three
are build tooling that never reaches the device:

| Severity | Package | Path | Fix |
| --- | --- | --- | --- |
| high ×2 | `image-size` | `react-native` → `@react-native/community-cli-plugin` → `metro` | None published (`patched: <0.0.0`). Metro is the bundler; it parses images on a dev machine, not on the phone. |
| moderate | `uuid` | `expo` → `@expo/config-plugins` → `xcode` | `>=11.1.1`, unreachable from here: `xcode` writes iOS project files, and this app has no iOS target. |

Neither package is in the app's runtime graph, so no override was added — a forced
resolution on a transitive build dependency is a maintenance liability with no
security gain here. Worth re-running each time Expo or React Native is upgraded.

`js-yaml@5.3.0` was checked by hand because a 5.x line is newer than most tooling
expects: it is the genuine `nodeca/js-yaml` package (`argparse@^2` dependency, same
repository field), not a typosquat.

## 6. The local release build could not be completed on this Windows host, 2026-08-31

`assembleRelease` was attempted four times to close §2.2's "unverified on device"
caveat. It never produced an APK. Every blocker was in the host toolchain, not in the
repository — recorded here so the next person does not re-derive them.

| Blocker | Evidence | Resolution |
| --- | --- | --- |
| Android SDK NDK 27.1.12297006 directory existed but was empty | `[CXX1101] … did not have a source.properties file` | Removed the partial directory; Gradle re-downloaded it, plus NDK 27.0.12077973 for `expo-sqlite` and SDK Platform 36. |
| Only JDK 24 and 25 installed. AGP 8.x supports 17–21; on JDK 25 every `configureCMake*` task fails on a JVM warning AGP treats as process output | `Execution failed for task ':expo-sqlite:configureCMakeRelWithDebInfo[arm64-v8a]' > WARNING: A restricted method in java.lang.System has been called`. Passing `--enable-native-access=ALL-UNNAMED` through `org.gradle.jvmargs` does not reach the worker. | Used the Adoptium 17 JDK that Gradle had already provisioned under `~/.gradle/jdks/`. CMake configure then succeeded. |
| The working-tree path contains a space (`D:\claude skills\mobile app`). The React Native bundle task shells out without quoting. | `:app:createBundleReleaseJsAndAssets` — the JS bundle and sourcemap are written successfully, then `'D:\claude' is not recognized as an internal or external command`. | Not fixable in this repo; it is upstream's quoting. A `subst` drive is not enough, because pnpm's symlinks still resolve to the original absolute path. Copied the tree to `C:\arb` and ran `pnpm install --frozen-lockfile` there. |
| `ninja` loops re-running CMake and gives up, on this host, for four third-party native targets | `ninja: error: manifest 'build.ninja' still dirty after 100 tries` for `react-native-screens`, `react-native-worklets`, `expo-updates`, `expo-sqlite`. Reproduced on the clean `C:\arb` copy, and again with `-PreactNativeArchitectures=arm64-v8a`. CMake's own configure and generate steps report success each time. | Unresolved. No app code is involved — the failing targets are all vendored C++ — and the JS bundle builds. Plausibly the interaction between ninja on Windows and the very long `node_modules/.pnpm/<pkg>@<ver>_<hash>/…/.cxx/…` paths. |

What this does and does not mean:

- **The Android build is unverified, not failing.** Nothing observed points at this
  repository. The documented release path is EAS Build
  ([07_Deployment.md](07_Deployment.md)), which runs Linux with JDK 17 on a
  space-free path, where none of the four blockers exist.
- **§2.2 stays "unverified on device".** SQLCipher's gradle flag is present in the
  generated `android/gradle.properties`, and the encrypted-open path is covered by
  unit tests, but no APK has yet opened a database on hardware.
- Everything the config plugins are responsible for *was* verified in the generated
  project: `allowBackup="false"`, the `dataExtractionRules` exclusions,
  `expo.sqlite.useSQLCipher=true`, and `cleartextTrafficPermitted="false"` in the
  `main` network security config against `"true"` in `debug`.
- To reproduce on a Windows host, use JDK 17 and a path without spaces:

  ```
  set JAVA_HOME=<jdk17>
  cd android && gradlew assembleRelease
  ```
