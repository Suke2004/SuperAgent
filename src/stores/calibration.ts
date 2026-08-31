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
 *
 * **Tool definitions get their own factor.** They are JSON, not prose, and the
 * character-per-token ratio of `{"type":"object","properties":{…}}` is nothing like
 * that of an English sentence — punctuation-dense text tokenizes far worse than the
 * 3.7 characters the prose estimator assumes. With a tool manifest often the largest
 * part of the prompt, one blended factor is pulled between two different errors and
 * lands on neither. So each turn also yields a *residual* sample: subtract what the
 * prose factor says the prose cost from the reported total, and what is left is the
 * manifest. That residual is only believable when the manifest is a real share of the
 * request — see {@link foldToolSample} — and until it is, tools fall back to the
 * blended factor, which is what they used before this existed.
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

/**
 * Below this share of the estimate, the tool manifest cannot be measured.
 *
 * The residual is `reported − proseFactor × prose`, so all of the prose factor's own
 * error lands in it. When the manifest is a tenth of the request that error swamps the
 * signal and the "measurement" is noise with a decimal point on it. A fifth is the
 * point where a 5% prose error moves the tool ratio by less than a quarter of itself.
 */
const MIN_TOOL_SHARE = 0.2;

export interface Calibration {
  /** Multiply an estimate by this to get a corrected estimate. */
  factor: number;
  /** How many turns are behind it. Shown so the user can judge it. */
  samples: number;
  updatedAt: number;
  /** The same, for tool definitions. Absent until a turn carried enough of them. */
  toolFactor?: number;
  toolSamples?: number;
}

export interface CalibrationState {
  /** Keyed exactly like the model registry: `${profileId}::${model}`. */
  byModel: Record<string, Calibration>;

  /**
   * Folds one turn's evidence in. Ignores samples too small or too odd to trust.
   *
   * `tools` is the part of `estimated` that was tool definitions. Pass it and the
   * manifest gets calibrated separately; omit it and only the blended factor moves.
   */
  record(key: string, estimated: number, reported: number, tools?: number): void;
  /** The correction factor for a model, or 1 when nothing is known. */
  factorFor(key: string): number;
  /** The correction factor for tool definitions, falling back to {@link factorFor}. */
  toolFactorFor(key: string): number;
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

/**
 * The same, for the tool manifest, measured as what the prose factor cannot explain.
 *
 * `estimated` is the whole prompt estimate and `tools` the part of it that was tool
 * definitions, so `estimated − tools` is the prose. Refused when the manifest is too
 * small to measure ({@link MIN_TOOL_SHARE}, {@link MIN_TOKENS}) or when the residual
 * implies a ratio outside the believable band — which is what a gateway reporting
 * something other than prompt tokens looks like from here.
 */
export function foldToolSample(
  previous: number | undefined,
  estimated: number,
  reported: number,
  tools: number,
  proseFactor: number,
): number | null {
  if (tools < MIN_TOKENS || estimated <= 0 || tools / estimated < MIN_TOOL_SHARE) return null;
  const prose = Math.max(0, estimated - tools);
  const residual = reported - prose * (proseFactor > 0 ? proseFactor : 1);
  const ratio = residual / tools;
  if (!Number.isFinite(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) return null;
  return previous === undefined ? ratio : previous + ALPHA * (ratio - previous);
}

export const useCalibration = create<CalibrationState>()(
  persist(
    (set, get) => ({
      byModel: {},

      record(key, estimated, reported, tools) {
        const previous = get().byModel[key];
        const factor = foldSample(previous?.factor, estimated, reported);
        if (factor === null) {
          log.debug('tokens', `Ignoring a calibration sample for ${key}: too small or too odd to trust.`, {
            estimated,
            reported,
          });
          return;
        }

        // Against the *previous* prose factor, not the one this sample just produced:
        // the residual is what the estimator in force at send time could not explain,
        // and folding the new factor back in would measure the manifest against a
        // correction the request never used.
        const toolFactor =
          tools === undefined
            ? null
            : foldToolSample(previous?.toolFactor, estimated, reported, tools, previous?.factor ?? 1);

        set((state) => ({
          byModel: {
            ...state.byModel,
            [key]: {
              ...(previous ?? {}),
              factor,
              samples: (previous?.samples ?? 0) + 1,
              updatedAt: Date.now(),
              ...(toolFactor === null
                ? {}
                : { toolFactor, toolSamples: (previous?.toolSamples ?? 0) + 1 }),
            },
          },
        }));
      },

      factorFor(key) {
        return get().byModel[key]?.factor ?? 1;
      },

      toolFactorFor(key) {
        return get().byModel[key]?.toolFactor ?? get().factorFor(key);
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
