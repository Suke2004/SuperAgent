/**
 * The property worth a test: no credential survives a backup.
 *
 * Registered secrets, pattern-shaped keys, and a bearer token pasted into a header
 * are all thrown at `buildBackup`, and the assertion is on the finished text — the
 * artefact the user shares — rather than on any intermediate object.
 */

import { buildBackup, parseBackup, BACKUP_SCHEMA_VERSION } from '@/chat/backup';
import type { BackupProfile } from '@/chat/backup';
import { clearRegisteredSecrets, registerSecret } from '@/lib/redact';

const KEY = 'sk-live-9f8e7d6c5b4a3210zyxw';

function input(overrides: Partial<Parameters<typeof buildBackup>[0]> = {}): Parameters<typeof buildBackup>[0] {
  return {
    settings: { themeMode: 'dark', maxToolIterations: 5 },
    profiles: [
      {
        name: 'Gateway',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        defaultModel: 'gpt-5',
        headers: { 'X-Trace': 'on' },
      },
    ],
    models: [{ profile: 'Gateway', id: 'gpt-5', capabilities: { vision: true }, wireHints: {}, hidden: false }],
    skills: [{ name: 'reviewer', description: 'Reviews diffs', body: 'Be terse.' }],
    prompts: [{ title: 'Review', body: 'Review {{diff}}.' }],
    servers: [
      { name: 'docs', url: 'https://mcp.example.com/sse', transport: 'sse', authKind: 'none', headers: {} },
    ],
    ...overrides,
  };
}

afterEach(() => clearRegisteredSecrets());

test('a backup carries the configuration and the schema', () => {
  const result = buildBackup(input(), Date.parse('2026-08-30T10:00:00Z'));
  expect(result.filename).toBe('agentrouter-settings-2026-08-30.json');
  expect(result.mimeType).toBe('application/json');
  expect(result.bytes).toBeGreaterThan(0);

  const parsed = parseBackup(result.text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.backup.schema).toBe(BACKUP_SCHEMA_VERSION);
  expect(parsed.backup.settings).toEqual({ themeMode: 'dark', maxToolIterations: 5 });
  expect(parsed.backup.profiles[0]?.name).toBe('Gateway');
  expect(parsed.backup.skills[0]?.body).toBe('Be terse.');
  expect(parsed.backup.prompts[0]?.body).toBe('Review {{diff}}.');
  expect(parsed.backup.servers[0]?.url).toBe('https://mcp.example.com/sse');
});

test('a registered key does not survive, wherever it was hiding', () => {
  registerSecret(KEY);
  const result = buildBackup(
    input({
      settings: { systemPrompt: `Use ${KEY} when asked.` },
      servers: [
        {
          name: 'docs',
          url: 'https://mcp.example.com/sse',
          transport: 'sse',
          authKind: 'bearer',
          headers: { 'X-Api-Key': KEY },
        },
      ],
    }),
  );
  expect(result.text).not.toContain(KEY);
  expect(result.text).toContain('[REDACTED');
});

test('a pattern-shaped token nobody registered is still scrubbed', () => {
  const result = buildBackup(
    input({
      profiles: [
        {
          name: 'Gateway',
          kind: 'openai',
          baseUrl: 'https://api.example.com/v1',
          defaultModel: 'gpt-5',
          headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
        },
      ],
    }),
  );
  expect(result.text).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
});

test('fields the stores may grow later are not spread into the file', () => {
  const result = buildBackup(
    input({
      profiles: [
        {
          name: 'Gateway',
          kind: 'openai',
          baseUrl: 'https://api.example.com/v1',
          defaultModel: 'gpt-5',
          headers: {},
          hasKey: true,
          keyFingerprint: 'sk-l…zyxw (24 chars)',
        } as BackupProfile,
      ],
    }),
  );
  expect(result.text).not.toContain('keyFingerprint');
  expect(result.text).not.toContain('hasKey');
});

test('a backup carries no conversations and no memories', () => {
  const result = buildBackup(input());
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  expect(parsed.conversations).toBeUndefined();
  expect(parsed.messages).toBeUndefined();
  expect(parsed.memories).toBeUndefined();
});

test('a file that is not a backup is refused rather than half-read', () => {
  expect(parseBackup('nonsense{')).toEqual({ ok: false, reason: 'That file is not JSON.' });
  expect(parseBackup('[]').ok).toBe(false);
  expect(parseBackup('{"app":"AgentRouter Mobile"}').ok).toBe(false);
  const newer = parseBackup(JSON.stringify({ schema: BACKUP_SCHEMA_VERSION + 1 }));
  expect(newer.ok).toBe(false);
  if (!newer.ok) expect(newer.reason).toContain('newer version');
});

test('a malformed entry costs that entry, not the restore', () => {
  const parsed = parseBackup(
    JSON.stringify({
      schema: 1,
      skills: [{ name: 'good', description: '', body: 'x' }, { name: 'no body' }, 'not an object'],
      prompts: 'not a list',
    }),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.backup.skills).toHaveLength(1);
  expect(parsed.backup.prompts).toEqual([]);
});
