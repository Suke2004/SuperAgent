/**
 * Cost guards for the two list-shaped workloads Phase 2 promises numbers for:
 * a 1,000-message transcript and a 500-conversation list.
 *
 * These are not benchmarks. The acceptance criteria that matter — 55 fps while
 * scrolling a Pixel 6, first paint under two seconds — are properties of the
 * native renderer and stay a manual device gate; nothing measurable in Jest
 * stands in for them. What *is* measurable is the JavaScript that has to finish
 * before FlashList can lay out a single row, and that is where the regressions
 * actually come from: a markdown parser that starts backtracking, a row builder
 * that turns accidentally quadratic, a filter that recomputes a haystack per
 * keystroke.
 *
 * The bounds are ratios, not clock readings, and that is the whole point: each
 * guard measures a quarter of the input and then all of it, and asserts the
 * larger run cost about four times the smaller. A wall-clock ceiling conflates
 * a slow algorithm with a busy machine — all three of these guards have failed
 * on a loaded machine while the code was fine. A ratio cannot, because both
 * halves are measured under the same load. They catch a change in *complexity*,
 * never a change in constant factors.
 */

import { buildRows, filterConversations, tagCounts } from '@/chat/list';
import type { Conversation } from '@/db/conversations';
import { parseMarkdown } from '@/components/markdown/blocks';

const NOW = 1_700_000_000_000;

function conversation(i: number): Conversation {
  return {
    id: `c${i}`,
    title: `Conversation ${i}`,
    createdAt: NOW - i * 3_600_000,
    updatedAt: NOW - i * 3_600_000,
    pinned: i % 25 === 0,
    archived: false,
    profileId: 'p1',
    model: i % 2 ? 'claude-opus-5' : 'claude-sonnet-5',
    config: {},
    tags: [`tag${i % 12}`, 'all'],
    preview: `A preview line for conversation ${i}`,
    messageCount: 20,
  };
}

/** A message body with every construct the renderer has a branch for. */
function markdown(i: number): string {
  return [
    `## Heading ${i}`,
    '',
    `Some **bold** and _italic_ prose with \`inline code\` and a [link](https://example.com/${i}).`,
    '',
    '- a list item',
    '- another one with $x^2 + y^2$ in it',
    '',
    '```ts',
    `const value = ${i};`,
    'export function f(): number { return value; }',
    '```',
    '',
    '> a quote',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
  ].join('\n');
}

function elapsed(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

/**
 * Load only ever *adds* time, so the fastest of a few runs is the cleanest
 * estimate of what the code costs. A single reading measures the machine as
 * much as the algorithm — this suite has failed on a loaded machine before.
 */
function fastest(work: () => void, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, elapsed(work));
  return best;
}

/**
 * How much four times the input is allowed to cost. Linear is 4; quadratic is
 * 16. Three times linear leaves room for cache effects and timer jitter while
 * still landing well below the shape this is here to catch.
 */
const LINEAR_ENOUGH = 12;

/** Repeats keep a measured unit far enough above timer resolution to divide. */
const REPS = 20;

const QUERIES = ['conv', 'conversation 4', 'opus', 'nothing matches this'];

describe('the conversation list', () => {
  const conversations = Array.from({ length: 500 }, (_, i) => conversation(i));
  const quarter = conversations.slice(0, 125);

  it('groups conversations into rows in linear time', () => {
    let rows = 0;
    const group = (list: Conversation[]) => () => {
      for (let r = 0; r < REPS; r++) rows = buildRows(list, NOW).length;
    };
    const part = fastest(group(quarter));
    const whole = fastest(group(conversations));

    // Every conversation plus at most one heading per group.
    expect(rows).toBeGreaterThan(500);
    expect(rows).toBeLessThan(510);
    expect(whole / part).toBeLessThan(LINEAR_ENOUGH);
  });

  it('filters and counts tags without rescanning per row', () => {
    const search = (list: Conversation[]) => () => {
      for (let r = 0; r < REPS; r++) {
        for (const query of QUERIES) filterConversations(list, { query });
        tagCounts(list);
      }
    };
    const part = fastest(search(quarter));
    const whole = fastest(search(conversations));

    expect(whole / part).toBeLessThan(LINEAR_ENOUGH);
  });
});

describe('a 1,000-message transcript', () => {
  it('parses every message body without super-linear cost', () => {
    const sources = Array.from({ length: 1000 }, (_, i) => markdown(i));
    const quarter = sources.slice(0, 250);
    let blocks = 0;

    // The 2 s first-paint criterion is a device property; a wall-clock bound
    // here fails when the machine is busy, which says nothing about the parser.
    const part = fastest(() => {
      for (const source of quarter) parseMarkdown(source);
    });
    const whole = fastest(() => {
      blocks = 0;
      for (const source of sources) blocks += parseMarkdown(source).length;
    });

    expect(blocks).toBeGreaterThan(1000);
    expect(whole / part).toBeLessThan(LINEAR_ENOUGH);
  });
});
