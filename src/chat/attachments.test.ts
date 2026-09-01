/**
 * Tests for the pure half of attachments.
 *
 * The bias here is towards the *refusals*, not the happy path. Every acceptance
 * criterion in Sprint 7/8 that a user can hit on a real phone is a refusal — a
 * photo that will not shrink, eight attachments already staged, a 60 MB PDF, a
 * model with no vision flag — and each one has to produce a sentence containing
 * both numbers involved. A refusal that says "too large" is a bug this file is
 * meant to catch, so the assertions check wording, not just `ok: false`.
 */

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_EXTRACTED_CHARS,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_EDGE,
  admitDocument,
  admitImage,
  attachmentSize,
  attachmentTokens,
  base64Bytes,
  boundExtractedText,
  describeAttachments,
  documentCaveat,
  documentSupport,
  formatBytes,
  imageBlock,
  imageSupport,
  isTextualDocument,
  mediaTypeFor,
  planResize,
} from '@/chat/attachments';
import { DEFAULT_CAPABILITIES } from '@/transports/support';
import type { ModelCapabilities } from '@/transports/support';
import type { ContentBlock } from '@/transports/types';

const caps = (patch: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  ...DEFAULT_CAPABILITIES,
  ...patch,
});

/** `n` base64 characters. Content is irrelevant; only the length is measured. */
const chars = (n: number): string => 'A'.repeat(n);

const image = (n: number): ContentBlock => imageBlock('image/jpeg', chars(n));

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('planResize', () => {
  it('leaves an image already within the limit alone', () => {
    expect(planResize({ width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
      resized: false,
      blind: false,
    });
  });

  it('treats the limit itself as within the limit', () => {
    const plan = planResize({ width: MAX_IMAGE_EDGE, height: 400 });
    expect(plan.resized).toBe(false);
  });

  it('scales a 12 MP photo down to the long edge, keeping the ratio', () => {
    const plan = planResize({ width: 4032, height: 3024 });
    expect(plan.resized).toBe(true);
    expect(plan.width).toBe(MAX_IMAGE_EDGE);
    // 3024 × (1568 / 4032) = 1176, exactly 3:4 preserved.
    expect(plan.height).toBe(1176);
  });

  it('scales by the long edge when the image is portrait', () => {
    const plan = planResize({ width: 3024, height: 4032 });
    expect(plan.height).toBe(MAX_IMAGE_EDGE);
    expect(plan.width).toBe(1176);
  });

  it('never rounds a panorama down to a zero-height resize', () => {
    const plan = planResize({ width: 8000, height: 1 });
    expect(plan.width).toBe(MAX_IMAGE_EDGE);
    expect(plan.height).toBe(1);
  });

  it('clamps blind when the platform reported no dimensions', () => {
    // `ImagePickerAsset` documents width/height as possibly zero.
    for (const source of [
      { width: 0, height: 0 },
      { width: 4032, height: 0 },
      { width: Number.NaN, height: 100 },
      { width: -1, height: -1 },
    ]) {
      const plan = planResize(source);
      expect(plan).toEqual({ width: MAX_IMAGE_EDGE, height: null, resized: true, blind: true });
    }
  });

  it('honours an explicit max edge', () => {
    expect(planResize({ width: 400, height: 200 }, 100)).toMatchObject({ width: 100, height: 50 });
  });
});

describe('base64Bytes', () => {
  it('is zero for an empty string', () => {
    expect(base64Bytes('')).toBe(0);
  });

  it('subtracts single and double padding', () => {
    // "AAAA" → 3 bytes, "AAA=" → 2, "AA==" → 1.
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(base64Bytes('AA==')).toBe(1);
  });

  it('is within a byte of the three-quarters rule for a large payload', () => {
    expect(base64Bytes(chars(1_000_000))).toBe(750_000);
  });
});

describe('formatBytes', () => {
  it('uses decimal units, matching what Android file managers show', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1_000)).toBe('1 kB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(60_000_000)).toBe('60 MB');
  });

  it('drops the decimal above 10 MB, where it is noise', () => {
    expect(formatBytes(12_340_000)).toBe('12 MB');
  });
});

describe('attachmentSize', () => {
  it('counts only images and documents', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'thinking', text: 'deliberating' },
      image(400),
    ];
    expect(attachmentSize(blocks)).toMatchObject({ count: 1, base64Chars: 400, bytes: 300 });
  });

  it('bills every image at the flat per-image figure regardless of its size', () => {
    expect(attachmentTokens([image(100)])).toBe(2_500);
    expect(attachmentTokens([image(1_000_000)])).toBe(2_500);
    expect(attachmentTokens([image(100), image(100)])).toBe(5_000);
  });

  it('bills a text document on its extracted text, not its bytes', () => {
    const doc: ContentBlock = { type: 'document', mediaType: 'text/plain', name: 'a.txt', text: chars(380) };
    expect(attachmentTokens([doc])).toBeGreaterThan(0);
    expect(attachmentTokens([doc])).toBeLessThan(2_500);
  });

  it('is zero for nothing', () => {
    expect(attachmentSize([])).toEqual({ count: 0, base64Chars: 0, bytes: 0, tokens: 0 });
  });
});

describe('admitImage', () => {
  it('accepts a small JPEG onto an empty message', () => {
    expect(admitImage([], { mediaType: 'image/jpeg', data: chars(1_000) })).toEqual({ ok: true });
  });

  it('refuses a format the models do not read, naming the ones they do', () => {
    const admission = admitImage([], { mediaType: 'image/tiff', data: chars(10) });
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toContain('image/tiff');
    expect(admission.reason).toContain('JPEG');
  });

  it('refuses the ninth attachment and says the limit', () => {
    const staged = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => image(10));
    const admission = admitImage(staged, { mediaType: 'image/jpeg', data: chars(10) });
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toContain(String(MAX_ATTACHMENTS_PER_MESSAGE));
  });

  it('refuses an image still over the per-image cap after the ladder, with both numbers', () => {
    const admission = admitImage([], { mediaType: 'image/jpeg', data: chars(MAX_IMAGE_BASE64_CHARS + 1) });
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error('unreachable');
    // Its own size, the resize it already had, and the limit it missed.
    expect(admission.reason).toContain('1.1 MB');
    expect(admission.reason).toContain(`${MAX_IMAGE_EDGE}px`);
    expect(admission.reason).toContain('1.1 MB');
    expect(admission.reason).toMatch(/crop/i);
  });

  it('refuses when the message budget is the binding limit rather than the image', () => {
    // Three images each inside the per-image cap, together over the per-message one.
    const staged = [image(1_400_000), image(1_400_000), image(1_400_000)];
    const admission = admitImage(staged, { mediaType: 'image/jpeg', data: chars(1_400_000) });
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toMatch(/in one message/);
    expect(admission.reason).toMatch(/MB/);
  });

  it('checks the type before the count, so a wrong format is not blamed on the limit', () => {
    const staged = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => image(10));
    const admission = admitImage(staged, { mediaType: 'image/tiff', data: chars(10) });
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toContain('image/tiff');
  });
});

describe('admitDocument', () => {
  it('accepts a PDF whose reported size is inside the limit', () => {
    expect(admitDocument([], { mediaType: 'application/pdf', name: 'a.pdf', size: 200_000 })).toEqual({ ok: true });
  });

  it('refuses a 60 MB PDF on the reported size, before anything is read', () => {
    const admission = admitDocument([], { mediaType: 'application/pdf', name: 'annual.pdf', size: 60_000_000 });
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toContain('annual.pdf');
    expect(admission.reason).toContain('60 MB');
    expect(admission.reason).toContain('8.0 MB');
    expect(admission.reason).toMatch(/Nothing has been read yet/);
  });

  it('holds a text file to a tighter limit than a PDF', () => {
    const big = { mediaType: 'text/plain', name: 'log.txt', size: 2_000_000 };
    const admission = admitDocument([], big);
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toContain('1.0 MB');
    // The same size as a PDF would have been fine.
    expect(admitDocument([], { ...big, mediaType: 'application/pdf', name: 'log.pdf' })).toEqual({ ok: true });
  });

  it('refuses a type that can be neither read nor sent', () => {
    const admission = admitDocument([], { mediaType: 'application/zip', name: 'bundle.zip', size: 10 });
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toContain('bundle.zip');
    expect(admission.reason).toContain('application/zip');
  });

  it('accepts a file with no reported size, since only reading it can tell', () => {
    expect(admitDocument([], { mediaType: 'text/markdown', name: 'notes.md' })).toEqual({ ok: true });
  });

  it('gives an Office file its own, larger ceiling — it is compressed', () => {
    const docx = { mediaType: DOCX, name: 'report.docx' };
    // Over the text limit, under the Office one.
    expect(admitDocument([], { ...docx, size: 2_000_000 })).toEqual({ ok: true });
    const admission = admitDocument([], { ...docx, size: 5_000_000 });
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toContain('an Office file');
  });

  it('accepts an Office file the system typed as a wildcard', () => {
    expect(admitDocument([], { mediaType: 'application/octet-stream', name: 'Q3.xlsx', size: 10 })).toEqual({
      ok: true,
    });
  });

  it('counts a PDF against the per-message byte budget as base64', () => {
    const staged = [image(1_400_000), image(1_400_000)];
    const admission = admitDocument(staged, { mediaType: 'application/pdf', name: 'a.pdf', size: 2_000_000 });
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toMatch(/in one message/);
  });

  it('refuses the ninth attachment whatever it is', () => {
    const staged = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => image(10));
    const admission = admitDocument(staged, { mediaType: 'text/plain', name: 'a.txt', size: 1 });
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toContain(String(MAX_ATTACHMENTS_PER_MESSAGE));
  });

  it('infers textuality from the extension when the type is a wildcard', () => {
    expect(admitDocument([], { mediaType: 'application/octet-stream', name: 'README.md', size: 10 })).toEqual({
      ok: true,
    });
  });
});

describe('imageSupport', () => {
  it('allows images when the vision flag is on', () => {
    expect(imageSupport(caps({ vision: true }))).toEqual({ supported: true, reason: '' });
  });

  it('refuses without the flag and says where the flag lives', () => {
    const support = imageSupport(caps({ vision: false }));
    expect(support.supported).toBe(false);
    expect(support.reason).toContain('Settings → Models');
  });

  it('refuses when nothing is known about the model at all', () => {
    expect(imageSupport(undefined).supported).toBe(false);
  });
});

describe('documentSupport', () => {
  it('sends a PDF natively on Anthropic with the documents flag', () => {
    expect(documentSupport('anthropic', caps({ documents: true }), 'application/pdf')).toEqual({
      supported: true,
      reason: '',
      native: true,
    });
  });

  it('refuses a PDF on Anthropic without the flag, naming the flag', () => {
    const support = documentSupport('anthropic', caps({ documents: false }), 'application/pdf');
    expect(support.supported).toBe(false);
    expect(support.reason).toContain('Documents');
  });

  it('refuses a PDF on an OpenAI-compatible profile, and explains why', () => {
    const support = documentSupport('openai', caps({ documents: true }), 'application/pdf');
    expect(support.supported).toBe(false);
    expect(support.native).toBe(false);
    expect(support.reason).toMatch(/OpenAI-compatible/);
  });

  it('accepts a text file on either transport, natively only on Anthropic', () => {
    expect(documentSupport('openai', caps(), 'text/plain')).toMatchObject({ supported: true, native: false });
    expect(documentSupport('anthropic', caps({ documents: true }), 'text/plain')).toMatchObject({
      supported: true,
      native: true,
    });
  });

  it('refuses a binary type outright', () => {
    const support = documentSupport('anthropic', caps({ documents: true }), 'application/zip');
    expect(support.supported).toBe(false);
  });

  it('takes an Office file on either transport, never natively', () => {
    // No API has a `.docx` block, so it is the extracted text or nothing — which is
    // also why the capability flags do not come into it.
    expect(documentSupport('openai', caps(), DOCX)).toMatchObject({ supported: true, native: false });
    expect(documentSupport('anthropic', caps({ documents: true }), DOCX)).toMatchObject({
      supported: true,
      native: false,
    });
  });
});

describe('documentCaveat', () => {
  it('says nothing for a natively supported PDF', () => {
    expect(
      documentCaveat('anthropic', caps({ documents: true }), {
        type: 'document',
        mediaType: 'application/pdf',
        name: 'a.pdf',
        data: chars(100),
      }),
    ).toBeUndefined();
  });

  it('warns before sending that an OpenAI profile only gets the extracted text', () => {
    const caveat = documentCaveat('openai', caps(), {
      type: 'document',
      mediaType: 'text/csv',
      name: 'rows.csv',
      text: 'a,b\n1,2',
    });
    expect(caveat).toContain('rows.csv');
    expect(caveat).toMatch(/extracted on this device/);
  });

  it('is blunt when there is no text and no document block either', () => {
    const caveat = documentCaveat('openai', caps(), {
      type: 'document',
      mediaType: 'text/plain',
      name: 'empty.txt',
    });
    expect(caveat).toMatch(/only see the file name/);
  });

  it('passes an outright refusal through as the caveat', () => {
    const caveat = documentCaveat('openai', caps(), {
      type: 'document',
      mediaType: 'application/pdf',
      name: 'a.pdf',
      data: chars(10),
    });
    expect(caveat).toMatch(/OpenAI-compatible/);
  });

  it('says nothing for text on Anthropic, where text is the native form anyway', () => {
    expect(
      documentCaveat('anthropic', caps({ documents: false }), {
        type: 'document',
        mediaType: 'text/plain',
        name: 'a.txt',
        text: 'hello',
      }),
    ).toBeUndefined();
  });

  it('always names what an Office file loses, on Anthropic too', () => {
    // The loss is the format's, not the profile's: a spreadsheet arrives as its cells
    // and nothing else, wherever it is sent.
    const caveat = documentCaveat('anthropic', caps({ documents: true }), {
      type: 'document',
      mediaType: DOCX,
      name: 'report.docx',
      text: 'Findings',
    });
    expect(caveat).toContain('report.docx');
    expect(caveat).toMatch(/Layout, styling, images and cell formatting/);
  });
});

describe('boundExtractedText', () => {
  it('leaves a short document untouched', () => {
    expect(boundExtractedText('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('elides the middle rather than the end, keeping the conclusion', () => {
    const raw = `${'a'.repeat(500)}CONCLUSION`;
    const { text, truncated } = boundExtractedText(raw, 200);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith('CONCLUSION')).toBe(true);
    expect(text.startsWith('aaa')).toBe(true);
  });

  it('uses the shipped cap by default', () => {
    expect(boundExtractedText('x'.repeat(MAX_EXTRACTED_CHARS)).truncated).toBe(false);
    expect(boundExtractedText('x'.repeat(MAX_EXTRACTED_CHARS + 1)).truncated).toBe(true);
  });
});

describe('mediaTypeFor', () => {
  it('prefers what the system reported', () => {
    expect(mediaTypeFor('a.txt', 'application/pdf')).toBe('application/pdf');
  });

  it('falls back to the extension when the system said octet-stream', () => {
    expect(mediaTypeFor('README.md', 'application/octet-stream')).toBe('text/markdown');
    expect(mediaTypeFor('a.pdf', '*/*')).toBe('application/pdf');
  });

  it('lowercases what it is given', () => {
    expect(mediaTypeFor('a.PDF', undefined)).toBe('application/pdf');
    expect(mediaTypeFor(undefined, 'TEXT/Plain')).toBe('text/plain');
  });

  it('returns an empty string when there is nothing to go on', () => {
    expect(mediaTypeFor(undefined, undefined)).toBe('');
    expect(mediaTypeFor('noextension', undefined)).toBe('');
  });
});

describe('isTextualDocument', () => {
  it('accepts anything under text/, and the named application types', () => {
    expect(isTextualDocument('text/x-python')).toBe(true);
    expect(isTextualDocument('application/json')).toBe(true);
  });

  it('rejects a PDF, which needs the native path', () => {
    expect(isTextualDocument('application/pdf')).toBe(false);
  });

  it('falls back to the name when the type is useless', () => {
    expect(isTextualDocument('application/octet-stream', 'notes.md')).toBe(true);
    expect(isTextualDocument('application/octet-stream', 'photo.png')).toBe(false);
    expect(isTextualDocument('application/octet-stream')).toBe(false);
  });
});

describe('describeAttachments', () => {
  it('is empty when nothing is staged, so the strip can hide itself', () => {
    expect(describeAttachments([])).toBe('');
    expect(describeAttachments([{ type: 'text', text: 'hi' }])).toBe('');
  });

  it('states the kinds, the size and the token cost', () => {
    const line = describeAttachments([
      image(1_400_000),
      { type: 'document', mediaType: 'application/pdf', name: 'a.pdf', data: chars(400_000) },
    ]);
    expect(line).toContain('1 image');
    expect(line).toContain('1 document');
    expect(line).toContain('MB');
    expect(line).toMatch(/~[\d,]+ tokens/);
  });

  it('pluralises on the count', () => {
    expect(describeAttachments([image(10), image(10)])).toContain('2 images');
  });
});
