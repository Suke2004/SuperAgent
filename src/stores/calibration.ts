/**
 * How wrong the token estimator is, per model, measured against the gateway.
 *
 * The composer's count is a character-based approximation — this app cannot run the
 * real tokenizer for an arbitrary model behind an arbitrary gateway. On English
 * prose it lands within a few percent; on CJK, code, or base64 it can be out by
 * more than a third, and it is always the *pressure gauge* that pays for it: a
 * conversation reading 70% that is really at 95% truncates the reply with no warning.
 *
 * The fix is not a better estimator, it is evidence. Every completed turn reports
 * `prompt_tokens` for a prompt this app had already estimated, so each turn is one
 * labelled sample of the estimator's error for that model. This store keeps a
 * smoothed ratio of reported ÷ estimated and the composer multiplies by it.
 *
 * Smoothed, not replaced: one turn's ratio also carries the difference between what
 * was estimated and what the gateway actually billed for — cached prefixes, a system
 * prompt the gateway injects, tool schemas — so a single sample is noisy in ways the
 * next one is not. And it is capped: a ratio outside [0.5, 2] is more likely a
 * gateway that reports something other than prompt tokens than an estimator that is
 * twice as wrong as its worst known case.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { log } from '@/lib/log';
import { expectHydration, persistConfig } from '@/lib/storage';

const STORE_NAME = 'token-calibration';

/** Weight of the newest sample. Ten-ish turns to move most of the way. */
const ALPHA = 0.25;

/** Outside this, the sample is not believable as estimator error. */
const MIN_RATIO = 0.5;
const MAX_RATIO = 2;

/** Below this the reported count is too small for the ratio to mean anything. */
const MIN_TOKENS = 200;

export interface Calibration {
  /** Multiply an estimate by this to get a corrected estimate. */
  factor: number;
  /** How many turns are behind it. Shown so the user can judge it. */
  samples: number;
  updatedAt: number;
}

export interface CalibrationState {
  /** Keyed exactly like the model registry: `${profileId}::${model}`. */
  byModel: Record<string, Calibration>;

  /** Folds one turn's evidence in. Ignores samples too small or too odd to trust. */
  record(key: string, estimated: number, reported: number): void;
  /** The correction factor for a model, or 1 when nothing is known. */
  factorFor(key: string): number;
  get(key: string): Calibration | undefined;
  forget(key: string): void;
  reset(): void;
}

/**
 * One turn's evidence folded into a factor, or `null` when the sample is unusable.
 *
 * Pure and exported so the arithmetic is testable without a store: the clamping is
 * the part with the judgement in it, and the part worth pinning down.
 */
export function foldSample(previous: number | undefined, estimated: number, reported: number): number | null {
  if (estimated < MIN_TOKENS || reported < MIN_TOKENS) return null;
  const ratio = reported / estimated;
  if (!Number.isFinite(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) return null;
  return previous === undefined ? ratio : previous + ALPHA * (ratio - previous);
}

export const useCalibration = create<CalibrationState>()(
  persist(
    (set, get) => ({
      byModel: {},

      record(key, estimated, reported) {
        const previous = get().byModel[key];
        const factor = foldSample(previous?.factor, estimated, reported);
        if (factor === null) {
          log.debug('tokens', `Ignoring a calibration sample for ${key}: too small or too odd to trust.`, {
            estimated,
            reported,
          });
          return;
        }

        set((state) => ({
          byModel: {
            ...state.byModel,
            [key]: {
              factor,
              samples: (previous?.samples ?? 0) + 1,
              updatedAt: Date.now(),
            },
          },
        }));
      },

      factorFor(key) {
        return get().byModel[key]?.factor ?? 1;
      },

      get(key) {
        return get().byModel[key];
      },

      forget(key) {
        set((state) => {
          const byModel = { ...state.byModel };
          delete byModel[key];
          return { byModel };
        });
      },

      reset() {
        set({ byModel: {} });
      },
    }),
    persistConfig<CalibrationState>(STORE_NAME, {
      partialize: (state) => ({ byModel: state.byModel }),
    }),
  ),
);

expectHydration(STORE_NAME);

/**
 * Applies a model's correction to an estimate.
 *
 * Rounded, because a token count with a decimal point in it invites more confidence
 * than any of this deserves.
 */
export function calibrated(key: string, estimate: number): number {
  return Math.round(estimate * useCalibration.getState().factorFor(key));
}
