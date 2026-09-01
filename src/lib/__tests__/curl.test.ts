/**
 * The curl command is runnable, and never carries a key.
 *
 * Both halves matter. A command that does not survive an apostrophe in the prompt is
 * worse than useless — it silently replays something other than what was sent — and a
 * command that carries the key is a secret in whatever the developer pasted it into.
 */

import { toCurl } from '@/lib/curl';
import type { RequestEntry } from '@/lib/log';
import { clearRegisteredSecrets, redact, registerSecret } from '@/lib/redact';

function entry(overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    kind: 'request',
    id: 'req_1',
    at: 0,
    transport: 'anthropic',
    method: 'POST',
    url: 'https://gateway.test/v1/messages',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': 'sk-ant-abcdef123456' },
    body: { model: 'claude-opus-5', messages: [{ role: 'user', content: "don't stop" }] },
    ...overrides,
  };
}

afterEach(() => clearRegisteredSecrets());

test('the body survives an apostrophe', () => {
  const command = toCurl(entry());

  // Closed, escaped, reopened — the shell's only way to get a quote into a quoted
  // string. A bare `'` here would end the argument and hand curl the rest as flags.
  expect(command).toContain(String.raw`don'\''t stop`);
  expect(command).toContain('-X POST');
  expect(command).toContain('-N'); // A stream, so curl must not buffer.
});

test('the key is a placeholder, because the entry never held one', () => {
  registerSecret('super-secret-gateway-key');
  // Entries are redacted on the way into the log, so that is what the builder sees.
  const logged = entry({
    headers: { 'x-api-key': 'super-secret-gateway-key' },
    body: { prompt: 'my key is super-secret-gateway-key' },
  });
  const command = toCurl({ ...logged, headers: redact(logged.headers), body: redact(logged.body) });

  expect(command).not.toContain('super-secret-gateway-key');
  expect(command).toContain('[REDACTED');
  expect(command).toContain('# The key is redacted.');
});

test('a GET needs no method and no body', () => {
  const command = toCurl(entry({ method: 'GET', headers: {}, body: undefined, url: 'https://gateway.test/v1/models' }));

  expect(command).not.toContain('-X');
  expect(command).not.toContain('--data-raw');
  expect(command).toContain(`curl 'https://gateway.test/v1/models'`);
});
