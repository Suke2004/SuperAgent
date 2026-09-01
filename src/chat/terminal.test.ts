/**
 * Tests for the ANSI reader.
 *
 * Every case here is a real thing a shell emits, taken from what `git`, `npm`, `pip`
 * and `curl` actually print: SGR colour runs, a progress bar redrawing its own line,
 * a `\b` rubout, a tab-aligned table. The assertions are on the spans rather than on
 * a string, because the whole point of the module is the styling — a test that only
 * checked the text would pass with every colour dropped.
 */

import { looksLikeTerminal, parseTerminal, plainTerminal } from '@/chat/terminal';

/** ESC, spelled once so the expectations below stay readable. */
const E = '\x1b';

/** A line's text, ignoring how it was styled. */
const text = (line: { text: string }[]): string => line.map((span) => span.text).join('');

describe('looksLikeTerminal', () => {
  it('recognises a colour escape', () => {
    expect(looksLikeTerminal(`${E}[32mok${E}[0m`)).toBe(true);
  });

  it('recognises a progress bar redrawing its line', () => {
    expect(looksLikeTerminal('10%\r20%\r')).toBe(true);
  });

  it('is false for prose, JSON and a Windows line ending', () => {
    expect(looksLikeTerminal('The file was written.')).toBe(false);
    expect(looksLikeTerminal('{"ok":true,"path":"a.txt"}')).toBe(false);
    expect(looksLikeTerminal('first\r\nsecond\r\n')).toBe(false);
  });
});

describe('parseTerminal', () => {
  it('splits plain output into lines and drops the trailing blank', () => {
    const { lines, dropped } = parseTerminal('first\nsecond\n');
    expect(lines.map(text)).toEqual(['first', 'second']);
    expect(dropped).toBe(0);
  });

  it('reads a colour run and ends it at the reset', () => {
    const { lines } = parseTerminal(`${E}[32mpassed${E}[0m tests`);
    expect(lines[0]).toEqual([
      { text: 'passed', color: 'green' },
      { text: ' tests' },
    ]);
  });

  it('keeps a style across a line break, as a shell does', () => {
    const { lines } = parseTerminal(`${E}[31mone\ntwo${E}[0m`);
    expect(lines[0]).toEqual([{ text: 'one', color: 'red' }]);
    expect(lines[1]).toEqual([{ text: 'two', color: 'red' }]);
  });

  it('collapses a bright colour onto its base and carries bold', () => {
    const { lines } = parseTerminal(`${E}[1;91mfatal${E}[0m`);
    expect(lines[0]).toEqual([{ text: 'fatal', color: 'red', bold: true }]);
  });

  it('reads git status, which sets colours without resetting between them', () => {
    const { lines } = parseTerminal(`${E}[32mA${E}[m  a.ts\n${E}[31mD${E}[m  b.ts`);
    expect(lines[0]).toEqual([{ text: 'A', color: 'green' }, { text: '  a.ts' }]);
    expect(lines[1]).toEqual([{ text: 'D', color: 'red' }, { text: '  b.ts' }]);
  });

  it('merges neighbouring text of the same style into one span', () => {
    // Naively this is one span per escape; a 500-line build log then renders as
    // thousands of `Text` nodes.
    const { lines } = parseTerminal(`a${E}[39mb${E}[39mc`);
    expect(lines[0]).toHaveLength(1);
    expect(lines[0]?.[0]).toEqual({ text: 'abc' });
  });

  it('ends 22 for both bold and dim, and 39 for the colour alone', () => {
    const { lines } = parseTerminal(`${E}[1;2;34mx${E}[22my${E}[39mz`);
    expect(lines[0]).toEqual([
      { text: 'x', color: 'blue', bold: true, dim: true },
      { text: 'y', color: 'blue' },
      { text: 'z' },
    ]);
  });

  it('shows only the last state of a progress bar', () => {
    const { lines } = parseTerminal('Downloading  10%\rDownloading  55%\rDownloading 100%\ndone');
    expect(lines.map(text)).toEqual(['Downloading 100%', 'done']);
  });

  it('honours a backspace rubout', () => {
    const { lines } = parseTerminal('passwordd\b\ndone');
    expect(lines.map(text)).toEqual(['password', 'done']);
  });

  it('does not underflow on a backspace at the start of a line', () => {
    const { lines } = parseTerminal('\b\bhi');
    expect(lines.map(text)).toEqual(['hi']);
  });

  it('expands tabs to eight-column stops, so a table lines up', () => {
    const { lines } = parseTerminal('id\tname\nlonger-id\tname');
    expect(lines[0] ? text(lines[0]) : '').toBe('id      name');
    expect(lines[1] ? text(lines[1]) : '').toBe('longer-id       name');
  });

  it('expands a tab from where the line already is, across a colour change', () => {
    const { lines } = parseTerminal(`ab${E}[32m\tx`);
    expect(lines[0] ? text(lines[0]) : '').toBe('ab      x');
  });

  it('drops cursor movement and mode changes rather than printing them', () => {
    const { lines } = parseTerminal(`${E}[2K${E}[1A${E}[?25lworking${E}[?25h`);
    expect(lines.map(text)).toEqual(['working']);
  });

  it('swallows a window-title sequence instead of leaking it as text', () => {
    const { lines } = parseTerminal(`${E}]0;user@host: ~/src\x07$ ls`);
    expect(lines.map(text)).toEqual(['$ ls']);
  });

  it('keeps the last lines and reports how many went', () => {
    const many = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n');
    const { lines, dropped } = parseTerminal(many, 5);
    expect(dropped).toBe(7);
    expect(lines.map(text)).toEqual(['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
  });

  it('caps a single absurdly long line', () => {
    const { lines } = parseTerminal('x'.repeat(5_000));
    expect(lines[0] ? text(lines[0]).length : 0).toBe(2_000);
  });

  it('is empty for empty output, so the view can say the command printed nothing', () => {
    expect(parseTerminal('').lines).toEqual([]);
    expect(parseTerminal('\n\n').lines).toEqual([]);
  });

  it('keeps a blank line between paragraphs of output', () => {
    const { lines } = parseTerminal('one\n\ntwo');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual([]);
  });
});

describe('plainTerminal', () => {
  it('is the text a terminal would have shown, with nothing to escape', () => {
    expect(plainTerminal(`${E}[32mok${E}[0m\rdone\n`)).toBe('done');
  });

  it('keeps every line, however long the log', () => {
    const many = Array.from({ length: 900 }, (_, index) => `line ${index}`).join('\n');
    expect(plainTerminal(many).split('\n')).toHaveLength(900);
  });
});
