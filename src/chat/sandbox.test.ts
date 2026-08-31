/**
 * The sandbox protocol and queue.
 *
 * The engine itself needs a WebView, so what is tested here is everything around it:
 * the argument rules, the message boundary, and the promise never being left hanging.
 * A `run_code` that neither resolves nor rejects stalls the turn forever, so the
 * timeout and the teardown have tests of their own.
 */

import {
  MAX_CODE_CHARS,
  MAX_OUTPUT_CHARS,
  parseRunCode,
  parseSandboxMessage,
  registerSandbox,
  deliverSandboxMessage,
  runInSandbox,
  SANDBOX_HTML,
  sandboxRequest,
} from '@/chat/sandbox';

afterEach(() => registerSandbox(null));

describe('parseRunCode', () => {
  it('accepts a program', () => {
    expect(parseRunCode({ code: '2 + 2' })).toEqual({ ok: true, code: '2 + 2' });
  });

  it('refuses an empty or missing one, with a reason naming the field', () => {
    for (const input of [{}, { code: '   ' }, { code: 4 }, null, 'nope']) {
      const result = parseRunCode(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('code');
    }
  });

  it('refuses a program past the ceiling', () => {
    const result = parseRunCode({ code: 'x'.repeat(MAX_CODE_CHARS + 1) });
    expect(result.ok).toBe(false);
  });
});

describe('parseSandboxMessage', () => {
  it('reads a result', () => {
    expect(parseSandboxMessage(JSON.stringify({ id: 'run_1', ok: true, output: '4' }))).toEqual({
      id: 'run_1',
      ok: true,
      output: '4',
    });
  });

  it('ignores anything that is not one', () => {
    for (const raw of ['', 'null', '[]', '{}', '{"id":1,"ok":true}', '{"id":"a"}', 'not json']) {
      expect(parseSandboxMessage(raw)).toBeNull();
    }
  });

  it('caps the output, because the page choosing its own size is the point of a cap', () => {
    const message = parseSandboxMessage(JSON.stringify({ id: 'a', ok: true, output: 'x'.repeat(MAX_OUTPUT_CHARS * 2) }));
    expect(message?.output).toHaveLength(MAX_OUTPUT_CHARS);
  });
});

describe('the runner document', () => {
  it('permits no source but its own inline script', () => {
    expect(SANDBOX_HTML).toContain("default-src 'none'");
    expect(SANDBOX_HTML).toContain("script-src 'unsafe-inline'");
    expect(SANDBOX_HTML).not.toMatch(/https?:\/\//);
  });
});

describe('runInSandbox', () => {
  it('resolves with what the page posted back', async () => {
    const posted: string[] = [];
    registerSandbox((message) => posted.push(message));
    const run = runInSandbox('2 + 2');
    const sent = JSON.parse(posted[0] ?? '{}') as { id: string; code: string };
    expect(sent.code).toBe('2 + 2');
    deliverSandboxMessage(JSON.stringify({ id: sent.id, ok: true, output: '4' }));
    await expect(run).resolves.toEqual({ ok: true, output: '4' });
  });

  it('answers rather than throwing when nothing is mounted', async () => {
    await expect(runInSandbox('2 + 2')).resolves.toEqual({
      ok: false,
      output: 'The sandbox is not available on this screen.',
    });
  });

  it('gives up on a program that never answers', async () => {
    registerSandbox(() => {});
    const result = await runInSandbox('while (true) {}', 5);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('did not finish');
  });

  it('fails waiting runs when the sandbox goes away', async () => {
    registerSandbox(() => {});
    const run = runInSandbox('2 + 2');
    registerSandbox(null);
    await expect(run).resolves.toEqual({ ok: false, output: 'The sandbox closed before this finished.' });
  });

  it('ignores a reply to a run that already timed out', async () => {
    registerSandbox(() => {});
    const result = await runInSandbox('slow()', 5);
    expect(result.ok).toBe(false);
    // The late reply has nothing to resolve, and must not throw on the way past.
    expect(() => deliverSandboxMessage(JSON.stringify({ id: 'run_1', ok: true, output: 'late' }))).not.toThrow();
  });
});

describe('sandboxRequest', () => {
  it('is JSON, so a program full of quotes cannot break out of the message', () => {
    const message = sandboxRequest('run_1', 'console.log("\\" ); alert(1); //")');
    expect(JSON.parse(message)).toEqual({ id: 'run_1', code: 'console.log("\\" ); alert(1); //")' });
  });
});
