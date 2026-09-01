/**
 * The typewriter's pacing.
 *
 * The load-bearing cases are `always advances` (a step that rounds to zero would strand
 * the last few characters of every reply on screen forever) and `shows a large chunk at
 * once` (the chase exists to smooth a stream, not to animate a paste).
 */

import { TYPEWRITER_LEAD, TYPEWRITER_MAX_LAG, revealStep } from './typewriter';

describe('revealStep', () => {
  it('stays put once caught up', () => {
    expect(revealStep(40, 40)).toBe(40);
  });

  it('follows the buffer down when a retry replaces the text', () => {
    expect(revealStep(400, 0)).toBe(0);
  });

  it('reveals a fraction of the backlog', () => {
    expect(revealStep(0, 80)).toBe(80 / TYPEWRITER_LEAD);
  });

  it('always advances, however small the backlog', () => {
    for (let backlog = 1; backlog < TYPEWRITER_LEAD; backlog += 1) {
      expect(revealStep(100, 100 + backlog)).toBeGreaterThan(100);
    }
  });

  it('shows a large chunk at once rather than crawling through it', () => {
    const total = TYPEWRITER_MAX_LAG + 2;
    expect(revealStep(0, total)).toBe(total);
  });

  it('converges on the buffer instead of overshooting it', () => {
    let shown = 0;
    const total = 300;
    for (let tick = 0; tick < 500 && shown < total; tick += 1) shown = revealStep(shown, total);
    expect(shown).toBe(total);
  });
});
