# Flaws, gaps and security findings

Audit of the tree at commit `f6db5a5` (branch `claude/chat-first-launch-and-sidebar`),
2026-08-30. Nothing here is a feature request — the outstanding feature work is in
[06_Eng_Plan.md](06_Eng_Plan.md) and `progress.md`. This file is the list of things
that are wrong, missing, or unverified in what already exists.

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

### 1a. The 401 classifier draws the wrong conclusion

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

### 1c. The "cannot be overridden" claim in the header editor is only half true

[`app/settings/provider/[id].tsx:333`](../app/settings/provider/[id].tsx) says the
Authorization header cannot be overridden. True for `Authorization` with a capital
A only — `buildHeaders` applies auth last, so that key wins. But `User-Agent` and a
lowercase `authorization` both pass straight through `this.extraHeaders`. So the
"honest, static User-Agent, never impersonate another client" guarantee in
[`src/transports/http.ts:35`](../src/transports/http.ts) is a **default, not an
enforcement**, and a lowercase `authorization` produces two conflicting header
entries whose precedence is decided by the native networking layer.

### 1d. Knock-on effects of the 401

- `GET /v1/models` is behind the same gate, so discovery cannot run pre-auth and
  `adoptDiscoveredModel` can never correct the seeded model id. A fresh install is
  stuck on a guess.
- `withFailover` only fails over on `kind: 'network'` (correct — a 401 means the
  primary is up), so the backup domain is untested code in practice.

---

## 2. Security and data leakage

Ordered by impact.

### 2.1 Android auto-backup is enabled — the whole chat history is backup-eligible

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

### 2.2 The database is plaintext and there is no app lock

`SQLite.openDatabaseAsync` with no SQLCipher; no `expo-local-authentication`
anywhere in the tree. Anyone holding an unlocked phone reads everything; root or a
userdebug build reads it without unlocking. Defensible for a personal app, but it
means the considerable care taken over the credential protects the credential only
— and the transcript is usually the more sensitive asset.

### 2.3 `profile.headers` is persisted plaintext to AsyncStorage

[`src/stores/providers.ts:238`](../src/stores/providers.ts) partializes `profiles`
wholesale, `headers` included. The type comment says "Never holds the key" and
nothing validates it, while the UI invites exactly the kind of header that does.
The redactor's `SECRET_KEY_RE` scrubs `authorization`/`x-api-key` from the debug log
and from exports, but not from the store write.

Fix: screen at the settings boundary — reject a secret-looking header key, or route
its value into SecureStore beside the API key.

### 2.4 `keyFingerprint` leaks last-4 and exact length into plaintext storage

[`src/lib/redact.ts:122`](../src/lib/redact.ts) returns `sk-a…9f0c (48 chars)`.
That string is persisted to AsyncStorage, rendered in the UI, and permitted in
exports. First-4 is `sk-` and free; last-4 plus exact length is real, if small,
credential disclosure sitting in the one storage tier that is not protected. A
salted hash prefix distinguishes two keys just as well.

### 2.5 Memories are stored and replayed with no review gate

`memoryEnabled: true` by default, and `distil()` writes straight to the table.
Model-authored text is then prepended to the system prompt of **every** later
conversation. The redaction screen blocks secrets; nothing blocks *instructions*.

Attach a document, let the distiller decide a line in it is a durable user
preference, and the result is persistent cross-conversation prompt injection that
outlives the chat it entered through. The new "bring in a message" quoting feature
widens the same surface, though that one at least lands visibly in the draft.

Fix: a one-tap confirm the first time each memory is stored.

### 2.6 The web fallback writes the raw key to `localStorage`

[`src/lib/secureKey.ts:39`](../src/lib/secureKey.ts). Correctly labelled
development-only, but `npm run web` is a package.json script and
`react-native-web` is a dependency, so it is one command from real. Any injected
script reads it, and it persists across sessions.

### 2.7 `expo-updates` is an unpinned remote-code channel

`updates.url` points at the EAS project, `runtimeVersion: appVersion`, and no
`checkAutomatically` or `fallbackToCacheTimeout` configuration. Whoever controls
that project id can replace the JS bundle inside an installed APK. Presumably
intended — but it is the largest single trust dependency in the app and appears in
no threat model.

### 2.8 The key stays in the heap for the process lifetime

`clearCache()` exists in `secureKey.ts` and is called from nowhere in app code.
`gateway.ts`'s transport cache holds an `HttpClient` holding `apiKey` as a field,
with no eviction on background or foreground. Low severity on modern Android; an
`AppState` hook closes it if heap dumps are in scope.

### 2.9 Clipboard

Whole-transcript copy with no sensitivity flag and no clear-after-timeout. On
Android it stays readable to other apps until overwritten.

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

**Streaming dies when the app is backgrounded.** No foreground service, no
notification, no resume. Android suspends the socket and the idle timeout
eventually kills it. For long thinking-budget requests this is the worst
real-world defect in the app, and it cannot be fixed in JS.

**No request concurrency limit.** Two chats streaming at once are two uncapped
requests against an undocumented rate limit — the fastest route to a 429 or a ban
on a gateway of this kind.

**Nothing has ever run on a physical device.** Not the keyboard fix under
edge-to-edge, not FlashList anchoring mid-stream, not the attachment pipeline, not
the share sheet. 1012 tests, none of which touch a real Android surface — and the
attachment pipeline is the part least substitutable by unit tests.

**`.expo/types/` has never been generated**, so `experiments.typedRoutes: true`
enforces nothing and route-path typos are invisible. Newly relevant: the sidebar
work added three `router.replace`/`navigate` call sites.

**Components are structurally untested by design.** `jest.config.js` matches
`*.test.ts` only. The purity split is a good decision; the consequence is that
`app/chat/[id].tsx` — the largest and most stateful file in the app — has zero
coverage. `selectTools`/`describeWithheldTools` are built with no call site (D-13).

**No key rotation or revocation path** beyond delete-and-repaste. No expiry or
last-used tracking on a credential that gates paid credits.

---

## 4. Fix queue, ascending size

1. `android.allowBackup: false` + `dataExtractionRules` in `app.json` (§2.1).
2. The 401 misclassification in `errors.ts` (§1a).
3. A secret-header guard on the providers store (§2.3).
4. A fingerprint that does not carry last-4 (§2.4).
5. A confirm gate before a distilled memory is stored (§2.5).
