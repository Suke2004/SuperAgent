/**
 * Tests for the block→text projection.
 *
 * This is the contract in `docs/05_Data_Model.md` §8.3, and it has four readers
 * that never see each other: the FTS index, the list preview, the derived title
 * and the memory extractor. The cases worth pinning are the ones where a block has
 * no text of its own — an image, a PDF whose bytes cannot be read — because that is
 * where "searching for the filename finds the message" is either true or silently
 * not.
 */

import { DEFAULT_TITLE, flattenContent, previewOf } from '@/db/content';
import type { ContentBlock } from '@/transports/types';

describe('flattenContent', () => {
  it('is empty for no blocks', () => {
    expect(flattenContent([])).toBe('');
  });

  it('joins text blocks with a blank line', () => {
    expect(flattenContent([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])).toBe('one\n\ntwo');
  });

  it('leaves thinking out, so a search lands on the answer', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', text: 'the user probably means pelicans' },
      { type: 'text', text: 'Pelicans.' },
    ];
    expect(flattenContent(blocks)).toBe('Pelicans.');
  });

  it('marks an image so a conversation can be found by having had one', () => {
    expect(flattenContent([{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }])).toBe('[image]');
  });

  it('never leaks base64 into the index', () => {
    const flat = flattenContent([{ type: 'image', mediaType: 'image/jpeg', data: 'SECRETBYTES' }]);
    expect(flat).not.toContain('SECRETBYTES');
  });

  it('indexes a PDF by its name, the only handle the user has on it', () => {
    const blocks: ContentBlock[] = [
      { type: 'document', mediaType: 'application/pdf', name: 'invoice-2026.pdf', data: 'AAAA' },
    ];
    expect(flattenContent(blocks)).toBe('invoice-2026.pdf');
  });

  it('indexes a text document by name and contents, name first', () => {
    const blocks: ContentBlock[] = [
      { type: 'document', mediaType: 'text/plain', name: 'notes.txt', text: 'buy milk' },
    ];
    expect(flattenContent(blocks)).toBe('notes.txt\n\nbuy milk');
  });

  it('survives a document with neither name nor text', () => {
    expect(flattenContent([{ type: 'document', mediaType: 'application/pdf' }])).toBe('');
  });

  it('names a tool call and inlines its result', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_result', toolUseId: 't1', content: 'export const a = 1;' },
    ];
    expect(flattenContent(blocks)).toBe('[tool read_file]\n\nexport const a = 1;');
  });

  it('trims the edges rather than leaving a leading blank line', () => {
    expect(flattenContent([{ type: 'text', text: '\n  hello  \n' }])).toBe('hello');
  });
});

describe('previewOf', () => {
  it('takes the first non-empty line', () => {
    expect(previewOf('\n\nfirst\nsecond')).toBe('first');
  });

  it('strips a markdown heading marker, which is not part of the sentence', () => {
    expect(previewOf('## Results\nbody')).toBe('Results');
  });

  it('is empty for whitespace only', () => {
    expect(previewOf('   \n\t')).toBe('');
  });

  it('ellipsises a long line to a fixed width', () => {
    const preview = previewOf('x'.repeat(400));
    expect(preview).toHaveLength(160);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('leaves a line exactly at the limit alone', () => {
    expect(previewOf('x'.repeat(160))).toHaveLength(160);
    expect(previewOf('x'.repeat(160)).endsWith('…')).toBe(false);
  });
});

describe('DEFAULT_TITLE', () => {
  it('is the string the chat store compares against to decide a title is automatic', () => {
    expect(DEFAULT_TITLE).toBe('New conversation');
  });
});
