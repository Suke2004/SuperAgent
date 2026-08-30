import {
  boundSummary,
  needsRecompression,
  summaryRequestBody,
  SUMMARY_CHAR_BUDGET,
} from '@/chat/summary';

describe('boundSummary', () => {
  it('leaves a summary inside the budget alone, trimmed', () => {
    expect(boundSummary('  notes about the earlier turns  ')).toBe('notes about the earlier turns');
  });

  it('never returns more than the budget', () => {
    const long = 'sentence. '.repeat(1_000);
    expect(boundSummary(long).length).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET);
  });

  /**
   * The termination guarantee. A summary of summaries only terminates if repeated
   * bounding is not itself a growth step, so re-bounding a bounded summary has to
   * be a fixed point.
   */
  it('is idempotent, so summary-of-summaries terminates', () => {
    const once = boundSummary('a'.repeat(10_000));
    expect(boundSummary(once)).toBe(once);
  });

  it('says that it dropped something, so the model does not finish a cut sentence', () => {
    expect(boundSummary('word '.repeat(2_000))).toContain('[Older notes dropped');
  });

  it('cuts at a boundary rather than mid-word when one is near the end', () => {
    const text = `${'para one. '.repeat(150)}\n\ntail`;
    const out = boundSummary(text);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET);
    const head = out.split('[Older notes dropped')[0]?.trimEnd() ?? '';
    // The kept part is a prefix of the input, and the input continues with
    // punctuation or a space — never halfway through a word.
    expect(text.startsWith(head)).toBe(true);
    expect(/[A-Za-z]/.test(text.charAt(head.length))).toBe(false);
  });

  it('honours a smaller explicit budget', () => {
    expect(boundSummary('x'.repeat(500), 120).length).toBeLessThanOrEqual(120);
  });
});

describe('needsRecompression', () => {
  it('is false with no summary yet', () => {
    expect(needsRecompression(undefined)).toBe(false);
    expect(needsRecompression('')).toBe(false);
  });

  it('is false well under the budget and true near it', () => {
    expect(needsRecompression('x'.repeat(Math.floor(SUMMARY_CHAR_BUDGET * 0.5)))).toBe(false);
    expect(needsRecompression('x'.repeat(Math.floor(SUMMARY_CHAR_BUDGET * 0.8)))).toBe(true);
  });
});

describe('summaryRequestBody', () => {
  it('asks for fresh notes when there are none, and states the budget', () => {
    const body = summaryRequestBody(undefined, 'user: hi');
    expect(body).toContain('user: hi');
    expect(body).toContain(String(SUMMARY_CHAR_BUDGET));
    expect(body).not.toContain('Existing notes');
  });

  it('asks to merge when the existing notes are small', () => {
    const body = summaryRequestBody('old notes', 'user: hi');
    expect(body).toContain('Existing notes');
    expect(body).toContain('Merge the existing notes');
    expect(body).not.toContain('rewrite them');
  });

  it('asks to rewrite rather than append when the notes are near the limit', () => {
    const body = summaryRequestBody('x'.repeat(SUMMARY_CHAR_BUDGET - 1), 'user: hi');
    expect(body).toContain('rewrite them');
    expect(body).toContain('rather than appending');
  });
});
