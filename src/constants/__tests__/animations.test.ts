/**
 * The animation tokens are almost all constants, and a test that asserts a constant
 * equals itself is a test that fails every time someone retunes a curve — it locks the
 * file rather than protecting it.
 *
 * So this covers the two things that are not just values: the reduce-motion scaling,
 * and the *relationships* between the durations. Those relationships are the design
 * decision. A future edit that makes the exit slower than the entrance would look
 * plausible in review and feel wrong on a device, which is exactly the kind of mistake
 * worth catching here.
 */

import { REDUCED_MS, curve, duration, scaleDuration, spring, STAGGER_MAX, STAGGER_MS } from '@/constants/animations';

describe('scaleDuration', () => {
  it('passes the duration through when motion is not reduced', () => {
    expect(scaleDuration(duration.panel, false)).toBe(duration.panel);
  });

  it('collapses to one frame, not to zero, when motion is reduced', () => {
    // Zero is the tempting value and the wrong one: completion callbacks that unmount
    // a modal or move focus need a frame to land in. See the note on `scaleDuration`.
    expect(scaleDuration(duration.panel, true)).toBe(REDUCED_MS);
    expect(REDUCED_MS).toBeGreaterThan(0);
  });

  it('reduces every duration to the same floor, however long it started', () => {
    const reduced = Object.values(duration).map((ms) => scaleDuration(ms, true));
    expect(new Set(reduced).size).toBe(1);
  });
});

describe('the duration scale', () => {
  it('dismisses faster than it presents', () => {
    // The asymmetry is deliberate: an entrance is information, a dismissal is the user
    // saying "gone". Inverting this is what makes an interface feel heavy.
    expect(duration.exit).toBeLessThan(duration.panel);
  });

  it('acknowledges a press faster than it moves anything', () => {
    expect(duration.press).toBeLessThan(duration.quick);
    expect(duration.quick).toBeLessThan(duration.panel);
  });

  it('keeps a fully staggered list under a third of a second', () => {
    // The cap exists so a long list does not still be arriving after the user has
    // scrolled past it. If either number grows, this is the budget it has to fit in.
    expect(STAGGER_MS * STAGGER_MAX).toBeLessThan(300);
  });
});

describe('the curves and springs', () => {
  it('gives every curve four control points in the unit x range', () => {
    // `Easing.bezier` takes x1, y1, x2, y2 and the x values must be within [0, 1] or the
    // curve is not a function of time. y may overshoot; x may not.
    for (const [name, points] of Object.entries(curve)) {
      expect(points).toHaveLength(4);
      expect(points[0]).toBeGreaterThanOrEqual(0);
      expect(points[0]).toBeLessThanOrEqual(1);
      expect(points[2]).toBeGreaterThanOrEqual(0);
      expect(points[2]).toBeLessThanOrEqual(1);
      expect(name).toBeTruthy();
    }
  });

  it('keeps every spring damped enough not to oscillate visibly', () => {
    // Damping ratio = damping / (2 * sqrt(stiffness * mass)). Below ~0.5 a spring
    // wobbles more than once on the way in, which on a panel looks broken rather than
    // lively. `bouncy` is the loosest and is still the right side of that line.
    for (const config of Object.values(spring)) {
      const ratio = config.damping / (2 * Math.sqrt(config.stiffness * config.mass));
      expect(ratio).toBeGreaterThan(0.5);
    }
  });
});
