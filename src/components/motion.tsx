/**
 * Motion primitives.
 *
 * This module exists to be imported by everything and to import almost nothing. That
 * is not a style preference — it is the fix for a real problem recorded in
 * `ui.tsx`, which carried a *duplicate* copy of {@link useReducedMotion} with a comment
 * explaining why: `ui.tsx` imports `Glyph`, so a hook exported from `ui.tsx` for
 * `Glyph` to use would have closed an import cycle. A third module that imports neither
 * of them breaks the cycle, and both copies collapse into this one.
 *
 * Timings live in `@/constants/animations` and are not restated here. This file holds
 * *behaviour* — how the app reads the accessibility setting, and how a press feels.
 *
 * Deliberately a `.tsx` file even for the parts that are not components. `jest.config.js`
 * collects coverage from `src/**\/*.ts` and runs in a `node` environment with no React
 * Native preset, so a `.ts` module touching `AccessibilityInfo` would be both untestable
 * and counted against the coverage floor. The extension is the boundary between "pure
 * logic, tested" and "needs a device", and it is worth respecting.
 */

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import {
  Easing,
  cancelAnimation,
  makeMutable,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { curve, duration, PULSE_MS, scaleDuration, spring } from '@/constants/animations';
import * as haptics from '@/lib/haptics';

/**
 * Whether the OS is asking for reduced motion.
 *
 * Reads the setting once on mount and then subscribes, because it is a setting a user
 * can reach for *while* the app is open — often precisely because something in it just
 * made them feel unwell. An app that only checks at startup makes them relaunch to be
 * taken seriously.
 *
 * Returns `false` until the first async read resolves. That is the right default: it
 * means one frame of a fresh mount may animate before the setting lands, which is a
 * far smaller failure than starting every animation disabled and having them switch on.
 *
 * State rather than a ref, in every consumer, because this value decides both what is
 * rendered and which animation runs — as a ref, flipping the system setting mid-session
 * would change nothing until something else happened to re-render.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // `.then` rather than an async IIFE: this can reject on web, where the promise
    // resolves against a matchMedia query that older browsers do not implement.
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (!cancelled) setReduced(on);
      })
      .catch(() => {
        /* No setting to read means no reduction asked for. */
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return reduced;
}

/**
 * How far a control shrinks under a finger.
 *
 * 0.97, at the bottom of the 0.96–0.98 band. The whole effect has to be deniable: the
 * user should feel that the surface gave slightly, not see a button perform a shrink.
 * At 0.94 a wide button visibly detaches from the rows either side of it.
 */
const PRESS_SCALE = 0.97;

/** The opacity dip that rides along with the scale. */
const PRESS_OPACITY = 0.9;

/**
 * Press feedback: a shallow scale-down and opacity dip on touch, springing back on
 * release, with a haptic on activation.
 *
 * A hook rather than a `<PressableScale>` component, and that is the important design
 * choice here. Every control in `ui.tsx` already composes {@link useFocusRing} the same
 * way — spread `handlers` onto the `Pressable`, merge `ring` into its style — and it
 * already has an outer `View` for layout. So this drops into the existing shape:
 * promote that outer view to `Animated.View`, spread two more handlers, merge one more
 * style. A wrapper component would have re-parented every call site to add a node that
 * does nothing but hold a transform.
 *
 * ## Why the scale is on the outer view, not the pressable
 *
 * Reanimated needs an `Animated` component to own the transform. Wrapping the outer
 * layout view keeps the pressable itself — with its `hitSlop`, its focus ring and its
 * `pressed` background — completely untouched. Scaling the outer box scales the whole
 * control including its background, which is what the effect looks like on iOS.
 *
 * ## Why the haptic fires on activation, not on touch
 *
 * `onPressIn` is the tempting place and it is wrong. A finger landing on a button inside
 * a scrollable list fires `onPressIn` immediately and then cancels when the touch turns
 * into a drag. The visual dip is free in that situation because it simply springs back;
 * a buzz is not, because there is no way to un-buzz. Buzzing 60ms later on a real press
 * is a far smaller cost than buzzing every time someone scrolls with their thumb over a
 * control.
 *
 * @param options.disabled Skips both the motion and the haptic. A disabled control that
 *   dips under a finger is promising something it will not do.
 * @param options.haptic Set `false` where the press has its own, heavier feedback — a
 *   send that fires `confirm()`, a delete that fires `warn()` — so the two do not stack
 *   into one mushy double buzz.
 */
export function usePressFeedback(options?: { disabled?: boolean; haptic?: boolean }) {
  const disabled = options?.disabled ?? false;
  const haptic = options?.haptic ?? true;
  const reduced = useReducedMotion();

  // 0 → at rest, 1 → held. One driver for both properties, so they cannot drift out of
  // step and there is one value to reason about.
  const held = useSharedValue(0);

  const style = useAnimatedStyle(() => ({
    // Reduce Motion drops the scale and keeps the dip. The dip is what confirms the
    // touch landed; the scale is the decoration on top of it, and it is the part that
    // moves an object across the screen, however slightly.
    transform: [{ scale: reduced ? 1 : 1 - held.value * (1 - PRESS_SCALE) }],
    opacity: 1 - held.value * (1 - PRESS_OPACITY),
  }));

  // Plain functions, not `useCallback`. Two reasons: `Pressable` re-registers its
  // handlers on every render anyway, so memoising them buys nothing; and a shared value
  // named in a hook's dependency array and then assigned inside it trips the React
  // Compiler's immutability rule, which is right to be suspicious — the memo has no way
  // to know the mutation is off-thread and intentional.
  const onPressIn = () => {
    if (disabled) return;
    // Timing in, spring out. Going down should track the finger, so it is a fixed short
    // ramp; coming back up is the control's own recovery, which is what a spring is for.
    held.value = withTiming(1, { duration: scaleDuration(duration.press, reduced) });
  };

  const onPressOut = () => {
    held.value = withSpring(0, spring.snappy);
  };

  const onPress = () => {
    if (!disabled && haptic) haptics.tap();
  };

  return { pressStyle: style, pressHandlers: { onPressIn, onPressOut }, onPressHaptic: onPress };
}

/**
 * A boolean, as something that can be interpolated: `0` when off, `1` when on, easing
 * between the two.
 *
 * The building block for every two-state visual in the app — a field taking focus, the
 * send disc filling as the draft stops being empty, a chevron turning, a backdrop
 * dimming. Returns the raw progress rather than a style, because what it drives differs
 * every time: feed it to `interpolateColor` for a colour, multiply it for a translation,
 * use it directly for an opacity.
 *
 * The assignment lives in an effect on purpose. Setting a shared value in the render
 * body is the classic Reanimated mistake: it re-runs on every unrelated re-render — and
 * the composer re-renders on every keystroke — which restarts the animation from
 * wherever it had reached and means it never actually arrives.
 *
 * @param active Which end to be at.
 * @param ms How long to take. Defaults to {@link duration.quick}, which is right for
 *   anything changing in place; pass {@link duration.panel} for something large.
 */
export function useTransition(active: boolean, ms: number = duration.quick): SharedValue<number> {
  const reduced = useReducedMotion();
  const progress = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(active ? 1 : 0, {
      duration: scaleDuration(ms, reduced),
      easing: Easing.bezier(...curve.standard),
    });
  }, [active, ms, progress, reduced]);

  return progress;
}

/** How faint the breath gets at the bottom of its cycle. */
const BREATH_LOW = 0.55;

/**
 * A slow opacity pulse, for something that is *ongoing* rather than something that
 * arrived.
 *
 * The distinction is the whole reason this exists next to {@link useTransition}. A
 * transition ends, and when it ends the thing it animated is in its final state. A
 * breath never ends, and that is the message: a mic disc that looks the same whether it
 * is recording or has silently died is the one control on a phone where the user has to
 * be certain, and a static red ring cannot tell those two apart.
 *
 * Returns a style rather than progress — unlike a transition there is nothing else it
 * could reasonably drive, and every call site would otherwise write the same
 * `useAnimatedStyle` around it.
 *
 * ## Reduce Motion keeps the pulse
 *
 * Cutting it would be the obvious reading of the setting and the wrong one. Reduce
 * Motion is about movement across the screen — vestibular symptoms come from things
 * travelling, not from things dimming — and this animation is load-bearing state, not
 * decoration. Compare {@link Glyph}, which drops its *rotation* under the same setting
 * and substitutes exactly this breath. What does change is the extreme: the dip is made
 * shallower, so the effect is quieter without going away.
 *
 * @param active Whether to breathe. Going inactive cancels and restores full opacity,
 *   rather than freezing wherever the cycle had reached — a control stopped at 0.6
 *   opacity looks disabled.
 */
export function useBreath(active: boolean) {
  const reduced = useReducedMotion();
  const phase = useSharedValue(1);

  useEffect(() => {
    if (!active) {
      cancelAnimation(phase);
      phase.value = withTiming(1, { duration: duration.press });
      return;
    }
    // `-1` repeats forever, `true` reverses on each pass, so one timing describes both
    // halves of the cycle and the turnaround cannot drift.
    phase.value = withRepeat(
      withTiming(reduced ? 1 - (1 - BREATH_LOW) / 3 : BREATH_LOW, {
        duration: PULSE_MS,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true,
    );
    return () => cancelAnimation(phase);
  }, [active, phase, reduced]);

  return useAnimatedStyle(() => ({ opacity: phase.value }));
}

/**
 * How far the drawer is open: `0` closed, `1` fully open.
 *
 * A module value rather than a hook, because the two things that need it are in
 * different React trees and there is no ancestor to hold a context. The drawer is a
 * `Modal` — a separate native window above the app — so the screen it slid over is not
 * inside it and cannot be reached by a provider that wraps it. Writing the progress
 * here lets `Sidebar` drive the slide and the screen underneath drive its own
 * scale-down off the same number, on the UI thread, with no bridge crossing and no
 * re-render on either side.
 *
 * ponytail: one global, because the app has exactly one drawer and it is modal — two
 * open at once is not a state that exists. If a second drawer ever appears, this
 * becomes a context holding a per-drawer shared value.
 */
export const drawerProgress = makeMutable(0);
