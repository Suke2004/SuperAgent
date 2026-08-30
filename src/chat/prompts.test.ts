/**
 * Prompt templates: the substitution, and the cases that are easy to get wrong.
 */

import { fillPrompt, isComplete, MAX_PROMPT_CHARS, validatePrompt, variablesIn } from './prompts';

describe('finding the variables', () => {
  it('reads them in first-appearance order, without duplicates', () => {
    expect(variablesIn('Review {{diff}} for {{concern}}, then re-check {{diff}}.')).toEqual(['diff', 'concern']);
  });

  it('tolerates whitespace inside the braces and ignores an unclosed one', () => {
    expect(variablesIn('{{ name }} and {{unclosed plus {single}')).toEqual(['name']);
  });

  it('allows spaces and hyphens inside a name, since people write prose there', () => {
    expect(variablesIn('Review {{pull request}} for {{style-guide}} problems')).toEqual([
      'pull request',
      'style-guide',
    ]);
  });

  it('finds nothing in a template with no variables', () => {
    expect(variablesIn('Just a prompt.')).toEqual([]);
  });
});

describe('filling one in', () => {
  it('substitutes every occurrence', () => {
    expect(fillPrompt('{{a}} then {{a}} then {{b}}', { a: 'X', b: 'Y' })).toBe('X then X then Y');
  });

  it('leaves an unfilled variable visible rather than blanking it', () => {
    // An empty substitution produces a prompt that reads as complete and is not.
    expect(fillPrompt('Summarise {{document}}', {})).toBe('Summarise {{document}}');
    expect(fillPrompt('Summarise {{document}}', { document: '   ' })).toBe('Summarise {{document}}');
  });

  it('treats a value containing $1 as text, not as a replacement pattern', () => {
    expect(fillPrompt('Fix {{what}}', { what: 'the $1 and $& handling' })).toBe('Fix the $1 and $& handling');
  });

  it('knows when a template is ready to send', () => {
    expect(isComplete('{{a}} {{b}}', { a: 'x' })).toBe(false);
    expect(isComplete('{{a}} {{b}}', { a: 'x', b: 'y' })).toBe(true);
    expect(isComplete('no variables', {})).toBe(true);
  });
});

describe('validation', () => {
  it('rejects an empty title or body, and names the limit it exceeded', () => {
    expect(validatePrompt({ title: '', body: 'x' })).toMatch(/title/);
    expect(validatePrompt({ title: 'x', body: '  ' })).toMatch(/no text/);
    expect(validatePrompt({ title: 'x', body: 'y'.repeat(MAX_PROMPT_CHARS + 1) })).toMatch(/limit/);
    expect(validatePrompt({ title: 'Review', body: 'Review {{diff}}' })).toBeNull();
  });
});
