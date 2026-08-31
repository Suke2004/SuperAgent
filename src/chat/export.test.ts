/**
 * Export, and the second of the two security tests that gate 1.0.
 *
 * The gating test is `describe('the API key never leaves in an export')`. It is
 * written the way `src/lib/redact.test.ts` is written, and for the same reason:
 * it **greps the produced artefact** rather than asserting that some call site
 * calls `redactString`. A call-site assertion passes forever after someone adds a
 * new field to the exporter and forgets the wrapper. A grep over the finished
 * text fails, which is the only version of this test worth having.
 *
 * So the fixture is deliberately hostile. The key is planted in every field an
 * export touches — title, system prompt, tags, message text, a text block, a
 * thinking block, tool-call arguments (nested, and as an object *key*), a tool
 * result, an error message, the conversation config and a message's meta — and
 * both formats are then searched for it. Adding an exported field without
 * redaction means adding it to a fixture that already contains the key, and the
 * test catches it.
 */

import {
  EXPORT_SCHEMA_VERSION,
  exportConversation,
  exportConversations,
  exportFilename,
} from '@/chat/export';
import type { ExportInput } from '@/chat/export';
import type { Conversation, StoredMessage } from '@/db/conversations';
import { clearRegisteredSecrets, registerSecret } from '@/lib/redact';
import type { ContentBlock } from '@/transports/types';

const KEY = 'sk-ant-api03-VERYSECRETKEYVALUE-not-in-any-export-1234567890';
const AT = Date.UTC(2026, 7, 30, 12, 0, 0);

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'Kestrel notes',
    createdAt: AT - 60_000,
    updatedAt: AT,
    pinned: false,
    archived: false,
    profileId: 'profile-1',
    model: 'claude-opus-5',
    config: {},
    tags: [],
    ...over,
  };
}

function message(over: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    conversationId: 'conv-1',
    seq: 1,
    role: 'user',
    createdAt: AT,
    content: [{ type: 'text', text: 'hello' }],
    text: 'hello',
    excluded: false,
    ...over,
  };
}

function simple(): ExportInput {
  return {
    conversation: conversation({ tags: ['work'], systemPrompt: 'Be brief.' }),
    messages: [
      message({ id: 'm1', seq: 1, role: 'user', content: [{ type: 'text', text: 'How do kestrels hunt?' }], text: 'How do kestrels hunt?' }),
      message({
        id: 'm2',
        seq: 2,
        role: 'assistant',
        content: [{ type: 'text', text: 'They hover.' }],
        text: 'They hover.',
        model: 'claude-opus-5',
        usage: { input: 120, output: 40, cacheRead: 900 },
        stopReason: 'end_turn',
      }),
    ],
  };
}

/** Every field an export touches, each carrying the key. */
function hostile(): ExportInput {
  const blocks: ContentBlock[] = [
    { type: 'text', text: `my key is ${KEY}, please remember it` },
    { type: 'thinking', text: `the user pasted ${KEY}`, signature: KEY },
    { type: 'image', mediaType: 'image/jpeg', data: 'aaaabbbbccccdddd' },
    { type: 'document', mediaType: 'text/plain', name: `notes-${KEY}.txt`, text: `contents mentioning ${KEY}` },
    {
      type: 'tool_use',
      id: `tool-${KEY}`,
      name: 'fetch',
      input: { url: 'https://example.com', headers: { authorization: `Bearer ${KEY}` }, [KEY]: 'as a key' },
    },
    { type: 'tool_result', toolUseId: `tool-${KEY}`, content: `server said ${KEY}`, isError: true },
  ];

  return {
    conversation: conversation({
      title: `Notes about ${KEY}`,
      systemPrompt: `You may use ${KEY} to authenticate.`,
      tags: ['work', KEY],
      config: { systemPromptOverride: KEY } as Conversation['config'],
      forkedFromId: 'conv-0',
    }),
    messages: [
      message({
        id: 'm1',
        content: blocks,
        text: `flattened preview containing ${KEY}`,
        error: `401 from the gateway: invalid key ${KEY}`,
        usage: { input: 10, output: 20, thinking: 5, cacheWrite: 1 },
        meta: { failedOverTo: `https://backup.example.com?key=${KEY}` },
      }),
    ],
  };
}

beforeEach(() => {
  clearRegisteredSecrets();
});

afterEach(() => {
  clearRegisteredSecrets();
});

describe('the API key never leaves in an export', () => {
  it('is absent from a Markdown export of a conversation that mentions it everywhere', () => {
    registerSecret(KEY);
    const out = exportConversation(hostile(), 'markdown', {
      includeThinking: true,
      now: AT,
    });

    // The gate. Not "contains [REDACTED]" — the key itself, nowhere.
    expect(out.text).not.toContain(KEY);
    expect(out.text).toContain('[REDACTED]');
  });

  it('is absent from a JSON export, including tool arguments and object keys', () => {
    registerSecret(KEY);
    const out = exportConversation(hostile(), 'json', { includeThinking: true, now: AT });

    expect(out.text).not.toContain(KEY);
    // And the artefact is still parseable, so redaction did not corrupt it: the
    // replacement text contains nothing JSON escapes, which is why the final
    // whole-artefact pass is safe to run after `JSON.stringify`.
    expect(() => JSON.parse(out.text)).not.toThrow();
  });

  it('is absent from a bundle of several conversations', () => {
    registerSecret(KEY);
    const inputs = [hostile(), hostile(), simple()];
    for (const format of ['markdown', 'json'] as const) {
      const out = exportConversations(inputs, format, { includeThinking: true, now: AT });
      expect(out.text).not.toContain(KEY);
    }
  });

  it('is absent from the filename, which is a string the OS keeps', () => {
    registerSecret(KEY);
    const out = exportConversation(hostile(), 'markdown', { now: AT });
    expect(out.filename).not.toContain(KEY);
    expect(out.filename).not.toContain('sk-ant');
  });

  it('is caught by the pattern backstop even when it was never registered', () => {
    // The realistic leak: a key pasted into a system prompt on a different
    // device, restored from a backup, and never passed through `registerSecret`
    // in this process. Exact-match redaction cannot know about it.
    const out = exportConversation(hostile(), 'json', { includeThinking: true, now: AT });
    expect(out.text).not.toContain(KEY);
  });

  it('never leaves the key in a thinking block that the user opted into', () => {
    registerSecret(KEY);
    const withThinking = exportConversation(hostile(), 'markdown', {
      includeThinking: true,
      now: AT,
    });
    expect(withThinking.text).toContain('**Thinking**');
    expect(withThinking.text).not.toContain(KEY);
  });
});

describe('what an export contains', () => {
  it('leads with the title, the model and the timestamps', () => {
    const out = exportConversation(simple(), 'markdown', { now: AT });
    expect(out.text).toContain('# Kestrel notes');
    expect(out.text).toContain('- Model: `claude-opus-5`');
    expect(out.text).toContain('2026-08-30T12:00:00.000Z');
  });

  it('labels the roles in words rather than API names', () => {
    const out = exportConversation(simple(), 'markdown', { now: AT });
    expect(out.text).toContain('## You');
    expect(out.text).toContain('## Assistant');
  });

  it('includes the system prompt, which is half of why a reply reads as it does', () => {
    expect(exportConversation(simple(), 'markdown', { now: AT }).text).toContain('## System prompt');
  });

  it('carries a schema version so a future importer can refuse the file', () => {
    const parsed = JSON.parse(exportConversation(simple(), 'json', { now: AT }).text);
    expect(parsed.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(parsed.exportedAt).toBe('2026-08-30T12:00:00.000Z');
    expect(parsed.conversation.messages).toHaveLength(2);
  });

  it('reports byte length rather than string length, for the confirmation', () => {
    const out = exportConversation(
      { conversation: conversation({ title: 'Em — dash' }), messages: [] },
      'markdown',
      { now: AT },
    );
    // One em dash is three bytes, so the two numbers differ and the file size
    // shown to the user is the file's, not the string's.
    expect(out.bytes).toBeGreaterThan(out.text.length);
  });

  it('says how many messages it wrote', () => {
    expect(exportConversation(simple(), 'json', { now: AT }).messages).toBe(2);
  });

  it('does not pretend an empty conversation had content', () => {
    const out = exportConversation({ conversation: conversation(), messages: [] }, 'markdown', { now: AT });
    expect(out.text).toContain('*No messages.*');
    expect(out.messages).toBe(0);
  });
});

describe('attachments', () => {
  it('describes an image instead of carrying four megabytes of base64', () => {
    const data = 'A'.repeat(4000);
    const input: ExportInput = {
      conversation: conversation(),
      messages: [
        message({ id: 'm1', content: [{ type: 'image', mediaType: 'image/png', data }], text: '' }),
      ],
    };

    const md = exportConversation(input, 'markdown', { now: AT });
    expect(md.text).not.toContain(data);
    expect(md.text).toContain('[image: image/png');
    expect(md.text).toContain('not included in this export');

    const json = JSON.parse(exportConversation(input, 'json', { now: AT }).text);
    const block = json.conversation.messages[0].content[0];
    expect(block).toEqual({ type: 'image', mediaType: 'image/png', bytes: 3000, included: false });
    expect(block.data).toBeUndefined();
  });

  it('keeps document text that was extracted on device, because the model saw it', () => {
    const input: ExportInput = {
      conversation: conversation(),
      messages: [
        message({
          id: 'm1',
          content: [{ type: 'document', mediaType: 'text/plain', name: 'brief.txt', text: 'the brief said no' }],
          text: '',
        }),
      ],
    };
    const out = exportConversation(input, 'markdown', { now: AT });
    expect(out.text).toContain('brief.txt');
    expect(out.text).toContain('the brief said no');
  });

  it('drops a document’s base64 while recording that it was there', () => {
    const input: ExportInput = {
      conversation: conversation(),
      messages: [
        message({
          id: 'm1',
          content: [{ type: 'document', mediaType: 'application/pdf', name: 'scan.pdf', data: 'B'.repeat(400) }],
          text: '',
        }),
      ],
    };
    const json = JSON.parse(exportConversation(input, 'json', { now: AT }).text);
    const block = json.conversation.messages[0].content[0];
    expect(block.included).toBe(false);
    expect(block.bytes).toBe(300);
    expect(JSON.stringify(json)).not.toContain('BBBB');
  });
});

describe('citations', () => {
  const cited: ExportInput = {
    conversation: conversation(),
    messages: [
      message({
        id: 'm1',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'SDK 57 is out.',
            citations: [
              { url: 'https://expo.dev/sdk-57', title: 'Expo SDK 57', citedText: 'SDK 57 ships RN 0.86.' },
              { url: 'https://example.test/notes' },
            ],
          },
        ],
        text: 'SDK 57 is out.',
      }),
    ],
  };

  it('lists the sources under the answer, quoting the passage', () => {
    const out = exportConversation(cited, 'markdown', { now: AT });
    expect(out.text).toContain('- [Expo SDK 57](https://expo.dev/sdk-57)');
    expect(out.text).toContain('> SDK 57 ships RN 0.86.');
    // No title: the URL stands in for one, so there is still something to click.
    expect(out.text).toContain('- [https://example.test/notes](https://example.test/notes)');
  });

  it('keeps them structured in JSON', () => {
    const json = JSON.parse(exportConversation(cited, 'json', { now: AT }).text);
    expect(json.conversation.messages[0].content[0].citations).toEqual([
      { url: 'https://expo.dev/sdk-57', title: 'Expo SDK 57', citedText: 'SDK 57 ships RN 0.86.' },
      { url: 'https://example.test/notes' },
    ]);
  });

  it('says nothing extra about a text block with no citations', () => {
    const json = JSON.parse(exportConversation(simple(), 'json', { now: AT }).text);
    expect(json.conversation.messages[0].content[0].citations).toBeUndefined();
  });
});

describe('the options', () => {
  it('leaves thinking out by default, because it is not what the user meant', () => {
    const input: ExportInput = {
      conversation: conversation(),
      messages: [
        message({
          id: 'm1',
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'they probably meant the other thing' },
            { type: 'text', text: 'Yes.' },
          ],
          text: 'Yes.',
        }),
      ],
    };

    const off = exportConversation(input, 'markdown', { now: AT });
    expect(off.text).not.toContain('the other thing');
    expect(off.text).toContain('Yes.');

    const on = exportConversation(input, 'markdown', { includeThinking: true, now: AT });
    expect(on.text).toContain('the other thing');
    // Blockquoted and labelled, so it cannot be read as the reply.
    expect(on.text).toContain('> **Thinking**');
  });

  it('omits thinking blocks from JSON entirely rather than emitting an empty one', () => {
    const input: ExportInput = {
      conversation: conversation(),
      messages: [
        message({ id: 'm1', content: [{ type: 'thinking', text: 'hm' }, { type: 'text', text: 'ok' }], text: 'ok' }),
      ],
    };
    const json = JSON.parse(exportConversation(input, 'json', { now: AT }).text);
    expect(json.conversation.messages[0].content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('includes excluded messages by default and marks them', () => {
    const input: ExportInput = {
      conversation: conversation(),
      messages: [
        message({ id: 'm1', text: 'kept', content: [{ type: 'text', text: 'kept' }] }),
        message({ id: 'm2', seq: 2, excluded: true, text: 'dropped', content: [{ type: 'text', text: 'dropped' }] }),
      ],
    };

    const all = exportConversation(input, 'markdown', { now: AT });
    expect(all.messages).toBe(2);
    expect(all.text).toContain('omitted from the request');

    const only = exportConversation(input, 'markdown', { includeExcluded: false, now: AT });
    expect(only.messages).toBe(1);
    expect(only.text).not.toContain('dropped');
  });

  it('drops token counts and settings when metadata is turned off', () => {
    const with_ = exportConversation(simple(), 'markdown', { now: AT });
    expect(with_.text).toContain('*Tokens: in 120 · out 40 · cache read 900*');

    const without = exportConversation(simple(), 'markdown', { includeMetadata: false, now: AT });
    expect(without.text).not.toContain('Tokens:');

    const json = JSON.parse(exportConversation(simple(), 'json', { includeMetadata: false, now: AT }).text);
    expect(json.conversation.config).toBeUndefined();
    expect(json.conversation.messages[1].usage).toBeUndefined();
  });

  it('reports absent usage as absent rather than as zero', () => {
    // The same asymmetry `StoredMessage.usage` encodes: a gateway that reported
    // nothing must not read as a free turn.
    const input: ExportInput = {
      conversation: conversation(),
      messages: [message({ id: 'm1', usage: { output: 7 } })],
    };
    const out = exportConversation(input, 'markdown', { now: AT });
    expect(out.text).toContain('*Tokens: out 7*');
    expect(out.text).not.toContain('in 0');
  });
});

describe('filenames', () => {
  it('slugs the title and stamps the date', () => {
    expect(exportFilename('Kestrel notes', 'markdown', AT)).toBe('kestrel-notes-2026-08-30.md');
    expect(exportFilename('Kestrel notes', 'json', AT)).toBe('kestrel-notes-2026-08-30.json');
  });

  it('strips everything a filesystem might object to', () => {
    expect(exportFilename('a/b\\c:d*e?f"g<h>i|j', 'markdown', AT)).toBe('a-b-c-d-e-f-g-h-i-j-2026-08-30.md');
  });

  it('falls back to a name rather than producing a dotfile', () => {
    // A title of only punctuation or only emoji slugs to nothing, and
    // `-2026-08-30.md` is a file some share targets silently hide.
    expect(exportFilename('!!!', 'markdown', AT)).toBe('conversation-2026-08-30.md');
    expect(exportFilename('', 'json', AT)).toBe('conversation-2026-08-30.json');
  });

  it('truncates a long title instead of handing the OS a 900-character name', () => {
    const name = exportFilename('word '.repeat(100), 'markdown', AT);
    expect(name.length).toBeLessThanOrEqual(60 + '-2026-08-30.md'.length);
  });
});

describe('several conversations at once', () => {
  it('takes the single-conversation path when there is only one', () => {
    const out = exportConversations([simple()], 'markdown', { now: AT });
    expect(out.filename).toBe('kestrel-notes-2026-08-30.md');
  });

  it('names the bundle by count, since no one title describes it', () => {
    const out = exportConversations([simple(), simple()], 'json', { now: AT });
    expect(out.filename).toBe('superagent-2-conversations-2026-08-30.json');
  });

  it('separates Markdown conversations with a rule and totals the messages', () => {
    const out = exportConversations([simple(), simple()], 'markdown', { now: AT });
    expect(out.text).toContain('# 2 conversations');
    expect(out.text.split('\n---\n')).toHaveLength(2);
    expect(out.messages).toBe(4);
  });

  it('puts them in an array under the same envelope', () => {
    const parsed = JSON.parse(exportConversations([simple(), simple()], 'json', { now: AT }).text);
    expect(parsed.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.conversation).toBeUndefined();
  });

  it('produces a well-formed artefact for an empty selection', () => {
    // Reachable: the last selected conversation can be deleted from another
    // screen between the tap and the export.
    const out = exportConversations([], 'json', { now: AT });
    expect(JSON.parse(out.text).conversations).toEqual([]);
    expect(out.messages).toBe(0);
  });
});

describe('awkward data', () => {
  it('survives a cycle in tool-call arguments rather than throwing', () => {
    const input: Record<string, unknown> = { name: 'self' };
    input.self = input;
    const doc: ExportInput = {
      conversation: conversation(),
      messages: [
        message({ id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'loop', input }], text: '' }),
      ],
    };

    expect(() => exportConversation(doc, 'markdown', { now: AT })).not.toThrow();
    const json = JSON.parse(exportConversation(doc, 'json', { now: AT }).text);
    expect(json.conversation.messages[0].content[0].input.self).toBe('[Circular]');
  });

  it('falls back to the flattened text when every block is an attachment', () => {
    const doc: ExportInput = {
      conversation: conversation(),
      messages: [
        message({
          id: 'm1',
          content: [{ type: 'image', mediaType: 'image/png', data: 'aaaa' }],
          text: 'a photo of a kestrel',
        }),
      ],
    };
    // The image descriptor is there, so the fallback should not fire — but a
    // message with no renderable blocks at all still needs a body.
    const empty: ExportInput = {
      conversation: conversation(),
      messages: [message({ id: 'm1', content: [], text: '' })],
    };
    expect(exportConversation(doc, 'markdown', { now: AT }).text).toContain('[image: image/png');
    expect(exportConversation(empty, 'markdown', { now: AT }).text).toContain('*(no text)*');
  });

  it('quotes the gateway’s own error wording rather than a paraphrase', () => {
    const doc: ExportInput = {
      conversation: conversation(),
      messages: [message({ id: 'm1', error: 'model_not_found: no such model `gpt-9`' })],
    };
    expect(exportConversation(doc, 'markdown', { now: AT }).text).toContain(
      '> **Error:** model_not_found: no such model `gpt-9`',
    );
  });

  it('notes a per-message model override, because the transcript is history', () => {
    const doc: ExportInput = {
      conversation: conversation({ model: 'claude-opus-5' }),
      messages: [message({ id: 'm1', role: 'assistant', model: 'claude-haiku-4-5-20251001' })],
    };
    expect(exportConversation(doc, 'markdown', { now: AT }).text).toContain('`claude-haiku-4-5-20251001`');
  });

  it('marks an edited and an aborted message', () => {
    const doc: ExportInput = {
      conversation: conversation(),
      messages: [message({ id: 'm1', meta: { editedAt: AT, aborted: true } })],
    };
    const text = exportConversation(doc, 'markdown', { now: AT }).text;
    expect(text).toContain('edited');
    expect(text).toContain('stopped early');
  });
});
