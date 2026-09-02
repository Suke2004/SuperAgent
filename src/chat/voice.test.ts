/**
 * The script voice mode speaks, and the styles it speaks in.
 *
 * Two properties carry the feature, and they are the two tested hardest:
 *
 *  - **No step is longer than {@link MAX_STEP}.** It is both the utterance handed to an
 *    engine that refuses long input and the run of text highlighted on screen, so a step
 *    that escapes the cap breaks the speech *and* the sync at once.
 *  - **The page numbering is derived, never a second opinion.** The dots and the
 *    highlight read the same array, so `page` has to follow the index by construction.
 */

import {
  DEFAULT_STYLE,
  MAX_STEP,
  SPEEDS,
  STEPS_PER_PAGE,
  VOICE_STYLES,
  pageCount,
  speakableText,
  speechOptions,
  styleById,
  voiceScript,
} from './voice';

describe('speakableText', () => {
  it('flattens markdown into something worth hearing', () => {
    const text = speakableText(
      [
        '# Heading',
        '',
        'Some **bold** and `code` and [a link](https://example.com).',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '',
        '- one',
        '- two',
      ].join('\n'),
    );

    expect(text).toContain('Heading');
    expect(text).toContain('Some bold and code and a link.');
    // The URL is not read out, and the fence is summarised rather than spelled.
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('const x');
    expect(text).toContain('code block');
    expect(text).toContain('one');
  });
});

describe('voiceScript', () => {
  it('makes one step per paragraph and per bullet', () => {
    const steps = voiceScript(['First thought.', '', '- one', '- two', '- three'].join('\n'));
    expect(steps.map((step) => step.text)).toEqual(['First thought.', 'one', 'two', 'three']);
  });

  it('joins the wrapped lines of one paragraph back into one step', () => {
    // Hard-wrapped prose is one thought, and four steps out of it would be four
    // highlights and four utterances with a gap in the middle of a sentence.
    const steps = voiceScript(['A sentence that has been', 'wrapped across two lines.'].join('\n'));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.text).toBe('A sentence that has been wrapped across two lines.');
  });

  it('never reads a code block out, but says one was there', () => {
    const steps = voiceScript(['Here it is:', '', '```js', 'const x = 1;', '', 'const y = 2;', '```', '', 'Done.'].join('\n'));
    expect(steps.map((s) => s.text)).toEqual(['Here it is:', 'code block.', 'Done.']);
  });

  it('drops a rule but announces an image', () => {
    // Two different kinds of "not prose". A horizontal rule read as "dash dash dash" is
    // noise, so it goes; a picture is something on the screen that the person listening
    // cannot see, and one word telling them it is there beats silence.
    const steps = voiceScript(['Real text.', '', '---', '', '| --- | --- |', '', '![](a.png)'].join('\n'));
    expect(steps.map((s) => s.text)).toEqual(['Real text.', 'image.']);
  });

  it('keeps every step inside the cap, however it was written', () => {
    const long = [
      // Sentences that individually fit but together do not.
      `${'Short sentence here. '.repeat(40)}`,
      '',
      // One run with no punctuation at all: the hard-wrap path.
      'x'.repeat(900),
      '',
      // Punctuation that must not be treated as a sentence end.
      'Version 3.5 costs 1.25 e.g. about right.',
    ].join('\n');

    const steps = voiceScript(long);
    for (const step of steps) expect(step.text.length).toBeLessThanOrEqual(MAX_STEP);
    // The abbreviation and the decimals stayed in one piece rather than becoming five.
    expect(steps.some((s) => s.text === 'Version 3.5 costs 1.25 e.g. about right.')).toBe(true);
  });

  it('pages by position, so the dots cannot disagree with the highlight', () => {
    const steps = voiceScript(Array.from({ length: 7 }, (_, i) => `Point ${i}.`).join('\n\n'));
    expect(steps).toHaveLength(7);
    expect(steps.map((s) => s.page)).toEqual([0, 0, 0, 1, 1, 1, 2]);
    expect(pageCount(steps)).toBe(3);
    expect(STEPS_PER_PAGE).toBe(3);
  });

  it('has nothing to say about nothing', () => {
    expect(voiceScript('')).toEqual([]);
    expect(voiceScript('   \n\n  ')).toEqual([]);
    expect(pageCount([])).toBe(0);
  });
});

describe('voice styles', () => {
  it('offers the five the checklist names', () => {
    expect(VOICE_STYLES.map((style) => style.label)).toEqual(['Buttery', 'Airy', 'Mellow', 'Glassy', 'Rounded']);
  });

  it('always resolves to a real style, including from a stored id that has gone', () => {
    expect(styleById('airy').label).toBe('Airy');
    expect(styleById('velvet').id).toBe(DEFAULT_STYLE);
    expect(styleById('').id).toBe(DEFAULT_STYLE);
  });

  it('scales the rate by the speed and keeps it inside what an engine can say', () => {
    expect(speechOptions('mellow', 1)).toEqual({ pitch: 1, rate: 0.95 });
    // The one that matters: a fast style at the fastest speed still lands under 2.
    for (const style of VOICE_STYLES) {
      for (const speed of SPEEDS) {
        const { rate } = speechOptions(style.id, speed);
        expect(rate).toBeGreaterThanOrEqual(0.5);
        expect(rate).toBeLessThanOrEqual(2);
      }
    }
    // A missing speed is treated as normal, not as silence.
    expect(speechOptions('mellow', 0).rate).toBe(0.95);
  });
});
