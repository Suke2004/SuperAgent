/**
 * The mandated redaction test: **the API key never appears in the debug log.**
 *
 * This is one of two tests that block the 1.0 gate, and it is written as a
 * *search of the artefact* rather than as a check of any one call site. The
 * question it asks is the question that matters — "is the key anywhere in what a
 * user could copy, screenshot or export?" — and it asks it of the entries buffer
 * and of `toText()` together, walking every string in the structure.
 *
 * Written that way on purpose. A test that asserted `redactString` works would
 * pass forever while a new field on `RequestEntry` quietly bypassed the boundary.
 * `containsSecret()` below walks whatever the buffer happens to hold, so a field
 * added without redaction fails this test rather than shipping.
 *
 * The design being verified is that redaction happens at the **write** boundary,
 * so the buffer never holds a secret at any point. That is what makes copying the
 * log safe by construction instead of by remembering to scrub at display time.
 */

import { debugLog, safeStringify } from '@/lib/log';
import {
  clearRegisteredSecrets,
  isForbiddenHeaderName,
  keyFingerprint,
  redact,
  redactString,
  registerSecret,
  registeredSecretCount,
  safeHeaders,
  unregisterSecret,
} from '@/lib/redact';

/** A realistic gateway key. Long, high-entropy, and shaped like the real thing. */
const KEY = 'sk-ant-api03-7Fq2mZx9Lp0RtVw4Nc8JhY6Kd1Bs3Ge5Aa7Uo9Ii2Ee4Oo6Uu8Yy0Tt';

/** A second one, to catch redaction that only ever handles the newest key. */
const OTHER_KEY = 'sk-proj-Qq1Ww2Ee3Rr4Tt5Yy6Uu7Ii8Oo9Pp0Aa1Ss2Dd3Ff4Gg5Hh6Jj7Kk8Ll9';

/** Every string anywhere in a value, however deeply nested. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value instanceof Error) {
    out.push(value.message);
    if (value.stack) out.push(value.stack);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      strings(item, out);
    }
  }
  return out;
}

/**
 * The actual assertion, applied to everything a user can get at.
 *
 * Both a structural walk and a flat serialisation, because the two fail
 * differently: the walk catches a key hidden in a nested body, and the
 * serialisation catches one that only appears once `toText()` formats it.
 */
function logLeaks(secret: string): string[] {
  const found: string[] = [];
  for (const value of strings(debugLog.getEntries())) {
    if (value.includes(secret)) found.push(value);
  }
  if (safeStringify(debugLog.getEntries()).includes(secret)) found.push('<serialised entries>');
  if (debugLog.toText().includes(secret)) found.push('<toText()>');
  return found;
}

beforeEach(() => {
  debugLog.clear();
  debugLog.setEnabled(true);
  clearRegisteredSecrets();
  registerSecret(KEY);
});

afterEach(() => {
  debugLog.clear();
  clearRegisteredSecrets();
});

describe('the API key never reaches the debug log', () => {
  it('is absent from a request logged with an Authorization header', () => {
    const handle = debugLog.request({
      transport: 'anthropic',
      method: 'POST',
      url: 'https://agentrouter.org/v1/messages',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hello' }] },
    });
    handle.gotResponse(200, 'OK', { 'request-id': 'req_abc123' });
    handle.finish({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }] });

    expect(logLeaks(KEY)).toEqual([]);
    // And the entry is still useful — redaction must not blank the whole header.
    expect(debugLog.toText()).toContain('agentrouter.org');
    expect(debugLog.toText()).toContain('REDACTED');
  });

  it('is absent when the key is in the URL rather than a header', () => {
    // Not how this app authenticates, but a gateway that accepted `?key=` would
    // put the secret somewhere the header redaction never looks.
    const handle = debugLog.request({
      transport: 'openai',
      method: 'GET',
      url: `https://agentrouter.org/v1/models?api_key=${KEY}`,
      headers: {},
    });
    handle.finish();
    expect(logLeaks(KEY)).toEqual([]);
  });

  it('is absent when the key is inside a request body', () => {
    const handle = debugLog.request({
      transport: 'openai',
      method: 'POST',
      url: 'https://agentrouter.org/v1/chat/completions',
      headers: {},
      // A system prompt into which a user pasted their own key. The pattern
      // backstop, not the registered-secret path, is what has to catch this one.
      body: { messages: [{ role: 'system', content: `use this token: ${OTHER_KEY}` }] },
    });
    handle.finish();
    expect(logLeaks(OTHER_KEY)).toEqual([]);
  });

  it('is absent from a response body that echoes it back', () => {
    // Real gateways do this in error payloads: "invalid key: sk-…".
    const handle = debugLog.request({
      transport: 'anthropic',
      method: 'POST',
      url: 'https://agentrouter.org/v1/messages',
      headers: { authorization: `Bearer ${KEY}` },
    });
    handle.gotResponse(401, 'Unauthorized');
    handle.finish({ error: { message: `invalid api key: ${KEY}`, type: 'unauthorized_client_error' } });
    expect(logLeaks(KEY)).toEqual([]);
  });

  it('is absent from a thrown error, including its stack', () => {
    const handle = debugLog.request({
      transport: 'anthropic',
      method: 'POST',
      url: 'https://agentrouter.org/v1/messages',
      headers: {},
    });
    handle.fail(new Error(`fetch failed for Bearer ${KEY}`));
    expect(logLeaks(KEY)).toEqual([]);
  });

  it('is absent from a raw stream sample', () => {
    const handle = debugLog.request({
      transport: 'anthropic',
      method: 'POST',
      url: 'https://agentrouter.org/v1/messages',
      headers: {},
    });
    handle.streamChunk(`data: {"type":"error","error":{"message":"bad key ${KEY}"}}\n\n`);
    handle.finish();
    expect(logLeaks(KEY)).toEqual([]);
  });

  it('is absent from a plain message log and its data payload', () => {
    debugLog.message('error', 'transport', `request failed with key ${KEY}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      nested: { deeper: [{ apiKey: KEY }] },
    });
    expect(logLeaks(KEY)).toEqual([]);
  });

  it('is absent even for a key registered after the entry was written', () => {
    // The pattern backstop is what covers this window: a key loaded from
    // SecureStore mid-session is registered late, and anything logged before
    // that must still have been scrubbed on the way in.
    clearRegisteredSecrets();
    debugLog.message('info', 'transport', `sending with ${OTHER_KEY}`);
    registerSecret(OTHER_KEY);
    expect(logLeaks(OTHER_KEY)).toEqual([]);
  });

  it('scrubs every registered key, not just the most recent', () => {
    registerSecret(OTHER_KEY);
    debugLog.message('info', 'transport', `keys: ${KEY} and ${OTHER_KEY}`);
    expect(logLeaks(KEY)).toEqual([]);
    expect(logLeaks(OTHER_KEY)).toEqual([]);
  });

  it('leaves nothing behind when the log is disabled', () => {
    debugLog.clear();
    debugLog.setEnabled(false);
    debugLog.message('error', 'transport', `key ${KEY}`);
    const handle = debugLog.request({
      transport: 'anthropic',
      method: 'POST',
      url: `https://agentrouter.org/?k=${KEY}`,
      headers: { authorization: `Bearer ${KEY}` },
    });
    handle.finish({ key: KEY });
    expect(debugLog.getEntries()).toEqual([]);
    expect(logLeaks(KEY)).toEqual([]);
    debugLog.setEnabled(true);
  });

  it('holds no secret in the buffer even before anything is displayed', () => {
    // The point of redacting at the write boundary: there is no window in which
    // the buffer holds the key and a display-time scrub is what saves us.
    debugLog.message('error', 'transport', `key ${KEY}`);
    const raw = debugLog.getEntries();
    expect(safeStringify(raw)).not.toContain(KEY);
    expect(safeStringify(raw)).toContain('REDACTED');
  });
});

describe('redaction of values that are not log entries', () => {
  it('replaces secret-bearing object keys outright, whatever the value looks like', () => {
    // A short custom header token matches no pattern and is registered nowhere;
    // the key name is the only signal available.
    const out = redact({ headers: { 'x-api-key': 'abc123', accept: 'text/event-stream' } });
    expect(out.headers['x-api-key']).toBe('[REDACTED]');
    expect(out.headers.accept).toBe('text/event-stream');
  });

  it('survives a circular structure instead of overflowing the stack', () => {
    const node: Record<string, unknown> = { token: KEY };
    node.self = node;
    const out = redact(node) as Record<string, unknown>;
    expect(out.token).toBe('[REDACTED]');
    expect(out.self).toBe('[Circular]');
  });

  it('redacts an Error while keeping it an Error', () => {
    const out = redact(new TypeError(`bad key ${KEY}`));
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe('TypeError');
    expect(out.message).not.toContain(KEY);
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The user prefers TypeScript, runs Postgres 16, and dislikes Bearer bonds.';
    expect(redactString(prose)).toBe(prose);
  });

  it('ignores secrets too short to redact safely', () => {
    // Redacting "abc" would mangle every word containing it.
    clearRegisteredSecrets();
    registerSecret('abc');
    expect(registeredSecretCount()).toBe(0);
    expect(redactString('abcdefg is a fine string')).toBe('abcdefg is a fine string');
  });

  it('forgets a key on unregister', () => {
    expect(redactString(`x ${KEY}`)).not.toContain(KEY);
    unregisterSecret(KEY);
    // The pattern backstop still catches this particular shape, which is the
    // point of having two mechanisms — but the exact-match path is gone.
    expect(registeredSecretCount()).toBe(0);
  });
});

describe('the key fingerprint shown in the UI', () => {
  it('identifies a key without carrying any of it, or its length', () => {
    const print = keyFingerprint(KEY);
    expect(print).toMatch(/^#[0-9a-f]{8}$/);
    expect(print).not.toContain(KEY);
    // The two things the old `sk-a…9f0c (48 chars)` form leaked, on a screen anyone
    // holding the phone can photograph: real characters, and the exact length.
    expect(print).not.toContain(KEY.slice(0, 4));
    expect(print).not.toContain(KEY.slice(-4));
    expect(print).not.toContain(String(KEY.length));
  });

  it('is stable for one key and different for another, which is all the UI needs', () => {
    expect(keyFingerprint(KEY)).toBe(keyFingerprint(KEY));
    // Trailing whitespace is a paste artefact, not a different key.
    expect(keyFingerprint(`  ${KEY}\n`)).toBe(keyFingerprint(KEY));
    expect(keyFingerprint(`${KEY}x`)).not.toBe(keyFingerprint(KEY));
    // One flipped character has to move the label, or two keys read as one.
    expect(keyFingerprint('sk-aaaaaaaa')).not.toBe(keyFingerprint('sk-aaaaaaab'));
  });

  it('says nothing for no key at all', () => {
    expect(keyFingerprint(null)).toBe('(none)');
    expect(keyFingerprint('')).toBe('(none)');
    expect(keyFingerprint('   ')).toBe('(none)');
  });

  it('is safe to log — it never reaches the buffer as a secret', () => {
    debugLog.message('info', 'providers', `using key ${keyFingerprint(KEY)}`);
    expect(logLeaks(KEY)).toEqual([]);
  });
});

describe('the header screen a provider profile passes through', () => {
  it('drops credential headers by name, whatever their casing', () => {
    expect(safeHeaders({ Authorization: `Bearer ${KEY}`, 'X-Api-Key': 'abc', 'anthropic-beta': 'ok' })).toEqual({
      'anthropic-beta': 'ok',
    });
    expect(isForbiddenHeaderName(' AUTHORIZATION ')).toBe(true);
    expect(isForbiddenHeaderName('cookie')).toBe(true);
  });

  it('drops a secret-looking value even under an innocent name', () => {
    // The name tells you nothing; the value is a key by the app's own definition.
    expect(safeHeaders({ 'x-note': KEY })).toEqual({});
  });

  it('refuses to let the app wear another client’s name', () => {
    expect(isForbiddenHeaderName('User-Agent')).toBe(true);
    expect(safeHeaders({ 'user-agent': 'SomeOtherClient/1.0' })).toEqual({});
  });

  it('passes ordinary headers through, and handles no headers at all', () => {
    expect(safeHeaders({ 'anthropic-beta': 'prompt-caching-2024-07-31' })).toEqual({
      'anthropic-beta': 'prompt-caching-2024-07-31',
    });
    expect(safeHeaders(undefined)).toEqual({});
  });
});
