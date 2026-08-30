/**
 * Secret redaction.
 *
 * The API key must never reach a log line, a debug entry, an export file, or a
 * crash message. Two mechanisms, deliberately overlapping:
 *
 * 1. Exact-match redaction of secrets registered at runtime. This is the
 *    reliable one — when the key is loaded from SecureStore we register it, and
 *    from then on any string containing it is scrubbed regardless of shape.
 * 2. Pattern redaction, as a backstop for secrets we were never told about
 *    (a key pasted into a system prompt, a bearer token in an MCP header).
 *
 * Anything user-facing that might contain a key goes through `redact()`.
 */

const MIN_SECRET_LENGTH = 8;

/** Registered exact secrets, longest-first so overlapping keys redact fully. */
let secrets: string[] = [];

const PATTERNS: { re: RegExp; replace: string }[] = [
  // OpenAI-style and most gateway-issued keys.
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{8,}/g, replace: '[REDACTED_KEY]' },
  // Anthropic-style.
  { re: /\bsk-ant-[A-Za-z0-9_\-]{8,}/g, replace: '[REDACTED_KEY]' },
  // Authorization headers in any casing, including the scheme.
  {
    re: /\b(authorization|x-api-key|api-key|proxy-authorization)(\s*[:=]\s*)(?:"|')?(?:bearer\s+)?[A-Za-z0-9._\-~+/]{8,}={0,2}(?:"|')?/gi,
    replace: '$1$2[REDACTED]',
  },
  // Bare `Bearer <token>` anywhere in free text.
  { re: /\bBearer\s+[A-Za-z0-9._\-~+/]{8,}={0,2}/gi, replace: 'Bearer [REDACTED]' },
  // JSON fields that conventionally hold secrets.
  {
    re: /("(?:api_?key|apiKey|token|access_token|refresh_token|client_secret|password)"\s*:\s*)"[^"]{4,}"/gi,
    replace: '$1"[REDACTED]"',
  },
];

/**
 * Register a secret for exact-match redaction. Safe to call repeatedly with the
 * same value. Values shorter than {@link MIN_SECRET_LENGTH} are ignored, since
 * redacting a short string would mangle unrelated text.
 */
export function registerSecret(secret: string | null | undefined): void {
  if (!secret) return;
  const trimmed = secret.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  if (secrets.includes(trimmed)) return;
  secrets = [...secrets, trimmed].sort((a, b) => b.length - a.length);
}

/** Forget a specific secret (e.g. the key was changed or cleared). */
export function unregisterSecret(secret: string | null | undefined): void {
  if (!secret) return;
  const trimmed = secret.trim();
  secrets = secrets.filter((s) => s !== trimmed);
}

/** Drop every registered secret. Used by tests and by "clear all data". */
export function clearRegisteredSecrets(): void {
  secrets = [];
}

/** Number of registered secrets. Exposed for diagnostics and tests only. */
export function registeredSecretCount(): number {
  return secrets.length;
}

/** Redact a string. Never throws. */
export function redactString(input: string): string {
  let out = input;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  for (const { re, replace } of PATTERNS) {
    // Patterns are global; reset lastIndex defensively in case of reuse.
    re.lastIndex = 0;
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Deep-redact any JSON-ish value. Object keys that look secret-bearing get
 * their values replaced outright, which catches values that no pattern would
 * match (a short custom header token, for instance).
 */
const SECRET_KEY_RE =
  /^(?:authorization|proxy-authorization|x-api-key|api-?key|apikey|token|access_?token|refresh_?token|id_?token|client_?secret|secret|password|passwd|pwd|cookie|set-cookie|code_?verifier)$/i;

export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]' as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen)) as unknown as T;
  }

  if (value instanceof Error) {
    const clone = new Error(redactString(value.message));
    clone.name = value.name;
    if (value.stack) clone.stack = redactString(value.stack);
    return clone as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redact(item, seen);
  }
  return out as unknown as T;
}

/**
 * Header names a profile is not allowed to set.
 *
 * `SECRET_KEY_RE` names the credential-bearing ones: the key lives in the Keystore
 * and is attached at request time, so an `authorization` typed into the extra-headers
 * box can only do harm — it would be persisted to AsyncStorage in cleartext, which
 * is exactly the one place the key must never reach. `user-agent` is here for a
 * different reason: the app sends one honest, static UA, and circumventing the
 * gateway's client allowlist by wearing another client's name is a bannable offence,
 * so the box must not be a way to do it.
 */
export function isForbiddenHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return SECRET_KEY_RE.test(lower) || lower === 'user-agent';
}

/**
 * Drop headers a profile must not carry, by name or by the look of the value.
 *
 * The value test is `redactString`: if redaction would rewrite it, it is a secret
 * by the app's own definition, whatever it was called. Returns a fresh object;
 * callers store the result rather than the input.
 */
export function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (isForbiddenHeaderName(name)) continue;
    if (redactString(value) !== value) continue;
    out[name] = value;
  }
  return out;
}

/**
 * A display fingerprint for a key: enough to tell two keys apart in the UI
 * without revealing either. Never logged alongside the key itself.
 *
 * It used to read `sk-a…9f0c (48 chars)`, which is four real characters of the
 * secret plus its exact length — the two things an offline guess wants most, on a
 * screen anyone holding the phone can photograph, and in a screenshot pasted into
 * a support thread. A hash prefix tells two keys apart just as well and tells an
 * attacker nothing: `a3f1c8` is not a substring of anything.
 *
 * FNV-1a rather than SHA-256 because this is a label, not a MAC — it must be
 * synchronous (`expo-crypto`'s digest is async and this is called during render)
 * and it only has to be stable and collision-shy across the handful of keys one
 * person owns. The salt is the point: without it the same key produces the same
 * label in every install of the app, which turns the label into a global
 * identifier for the key. It is a build-time constant rather than a per-install
 * random value so a fingerprint stays comparable across a reinstall.
 *
 * ponytail: FNV-1a with a fixed salt. Not preimage-resistant against someone who
 * reads this source and brute-forces a candidate key — but a candidate key can be
 * tested against the gateway directly, so the hash is not the weak link. Move to a
 * real KDF only if fingerprints ever leave the device.
 */
const FINGERPRINT_SALT = 'agentrouter-mobile/key-fingerprint/v1';

export function keyFingerprint(secret: string | null | undefined): string {
  if (!secret) return '(none)';
  const trimmed = secret.trim();
  if (!trimmed) return '(none)';
  const input = `${FINGERPRINT_SALT}:${trimmed}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // The 32-bit FNV prime, as shifts, because `hash * 16777619` loses precision.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return `#${hash.toString(16).padStart(8, '0')}`;
}
