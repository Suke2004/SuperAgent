/**
 * The token-estimator calibration fold.
 *
 * Tested through `foldSample` rather than the store: the store is zustand plus
 * persistence, and neither has an opinion worth asserting. The clamping does.
 *
 * Imported from a path that pulls in `@/lib/storage` transitively, which is why this
 * file only ever calls the pure export — the suite runs in `node` with no
 * AsyncStorage. If that import chain ever fails, split the helper into its own module
 * rather than mocking the platform.
 */

import { foldSample, foldToolSample } from '@/stores/calibration';

describe('foldSample', () => {
  it('takes the first believable sample whole', () => {
    // Nothing to smooth against, so the ratio is the factor.
    expect(foldSample(undefined, 1_000, 1_200)).toBeCloseTo(1.2, 10);
  });

  it('moves a quarter of the way to a new sample', () => {
    // 1 + 0.25 * (1.4 - 1) = 1.1
    expect(foldSample(1, 1_000, 1_400)).toBeCloseTo(1.1, 10);
  });

  it('converges towards a steady ratio without overshooting it', () => {
    let factor = foldSample(undefined, 1_000, 1_000) as number;
    for (let i = 0; i < 40; i += 1) {
      factor = foldSample(factor, 1_000, 1_300) as number;
    }
    expect(factor).toBeGreaterThan(1.29);
    expect(factor).toBeLessThanOrEqual(1.3);
  });

  it('ignores samples too small for the ratio to mean anything', () => {
    // A two-word prompt's rounding error is larger than the signal.
    expect(foldSample(1, 10, 12)).toBeNull();
    expect(foldSample(1, 1_000, 199)).toBeNull();
  });

  it('ignores ratios that are more likely a different metric than estimator error', () => {
    // A gateway reporting total tokens, or billing units, rather than prompt tokens.
    expect(foldSample(1, 1_000, 5_000)).toBeNull();
    expect(foldSample(1, 5_000, 1_000)).toBeNull();
  });

  it('keeps the boundary ratios, which are merely a bad estimate', () => {
    expect(foldSample(undefined, 1_000, 2_000)).toBeCloseTo(2, 10);
    expect(foldSample(undefined, 2_000, 1_000)).toBeCloseTo(0.5, 10);
  });

  it('rejects a zero estimate rather than returning Infinity', () => {
    expect(foldSample(1, 0, 1_000)).toBeNull();
  });
});

describe('foldToolSample', () => {
  it('measures the manifest as what the prose factor could not explain', () => {
    // 4_000 estimated, 1_000 of it tools. Prose factor 1, so prose explains 3_000 of
    // the 4_200 reported and the remaining 1_200 is the manifest: 1.2×.
    expect(foldToolSample(undefined, 4_000, 4_200, 1_000, 1)).toBeCloseTo(1.2, 10);
  });

  it('uses the prose factor rather than assuming the prose was right', () => {
    // Prose 3_000 at 1.1 explains 3_300; 4_500 reported leaves 1_200 for 1_000 of
    // tools. Without the factor this would read as 1.5× and blame the manifest for
    // an error the prose estimator already knows about.
    expect(foldToolSample(undefined, 4_000, 4_500, 1_000, 1.1)).toBeCloseTo(1.2, 10);
  });

  it('smooths like the prose fold does', () => {
    // 1 + 0.25 * (1.2 - 1)
    expect(foldToolSample(1, 4_000, 4_200, 1_000, 1)).toBeCloseTo(1.05, 10);
  });

  it('refuses a manifest too small a share of the request to measure', () => {
    // 1_000 of 20_000 is noise: a 5% prose error is 950 tokens, which would move this
    // ratio by nearly a whole factor of itself.
    expect(foldToolSample(undefined, 20_000, 20_500, 1_000, 1)).toBeNull();
  });

  it('refuses a manifest too small in absolute terms', () => {
    expect(foldToolSample(undefined, 400, 420, 199, 1)).toBeNull();
  });

  it('refuses a residual that is not believable as estimator error', () => {
    // Reported below what the prose alone should cost: the manifest cannot have a
    // negative size, so something other than prompt tokens is being reported.
    expect(foldToolSample(undefined, 4_000, 2_000, 1_000, 1)).toBeNull();
    expect(foldToolSample(undefined, 4_000, 9_000, 1_000, 1)).toBeNull();
  });

  it('rejects a zero estimate rather than dividing by it', () => {
    expect(foldToolSample(undefined, 0, 1_000, 1_000, 1)).toBeNull();
  });
});
