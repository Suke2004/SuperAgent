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
 * The bounds are loose by design — an order of magnitude above what these cost
 * today, because CI runners are shared and a tight bound would fail for reasons
 * that have nothing to do with the code. They catch a change in *complexity*,
 * not a change in constant factors.
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

describe('the conversation list', () => {
  const conversations = Array.from({ length: 500 }, (_, i) => conversation(i));

  it('groups 500 conversations into rows quickly', () => {
    let rows = 0;
    const ms = elapsed(() => {
      rows = buildRows(conversations, NOW).length;
    });
    // Every conversation plus at most one heading per group.
    expect(rows).toBeGreaterThan(500);
    expect(rows).toBeLessThan(510);
    expect(ms).toBeLessThan(150);
  });

  it('filters and counts tags without rescanning per row', () => {
    const ms = elapsed(() => {
      for (const query of ['conv', 'conversation 4', 'opus', 'nothing matches this']) {
        filterConversations(conversations, { query });
      }
      tagCounts(conversations);
    });
    expect(ms).toBeLessThan(150);
  });
});

describe('a 1,000-message transcript', () => {
  it('parses every message body inside the first-paint budget', () => {
    const sources = Array.from({ length: 1000 }, (_, i) => markdown(i));
    let blocks = 0;
    const ms = elapsed(() => {
      for (const source of sources) blocks += parseMarkdown(source).length;
    });

    expect(blocks).toBeGreaterThan(1000);
    // Well under the 2 s first-paint criterion, and this is the whole
    // transcript: FlashList only parses the handful of rows it mounts, so the
    // budget here is deliberately the pessimistic case.
    expect(ms).toBeLessThan(2000);
  });
});
