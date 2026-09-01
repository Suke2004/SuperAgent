/**
 * Three dots, breathing in sequence: the model has the question and has not started
 * answering yet.
 *
 * The gap this fills is a specific one. {@link StreamView} already names the phase in
 * words, which is the honest answer to "what is it doing" — but words do not tell you
 * whether the *connection* is still alive, and a phase label that has read "Connecting"
 * for eight seconds is indistinguishable from a frozen screen. A pulse is proof of life
 * that costs no reading.
 *
 * It disappears the moment the first token lands, which is the other half of the design:
 * a placeholder that outlives the thing it stood in for turns into decoration.
 *
 * ## One driver, three phases
 *
 * A single 0→1 sawtooth repeating forever, with each dot reading a triangle off it that
 * peaks at a different point in the cycle. Three separate loops would be three chances
 * for the tempo to drift apart, and drifting dots read as a rendering fault rather than
 * as a wave. Same trick as {@link Glyph}'s accent dots, and deliberately at the same
 * tempo — the mark is spinning in the gutter two dozen pixels away, and two pulses at
 * slightly different rates in one glance is a beat frequency the eye picks out
 * immediately even though nobody can say what is wrong.
 */

import Reanimated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { useEffect } from 'react';
import { View } from 'react-native';

import { PULSE_MS } from '@/constants/animations';
import { useReducedMotion } from '@/components/motion';
import { useTheme } from '@/theme';

const SIZE = 6;

/**
 * Where in the cycle each dot peaks.
 *
 * Not evenly spaced across `[0, 1]`: a peak at 0 or 1 sits on the cycle boundary, where
 * the ramp is one-sided and the dot appears to snap rather than swell.
 */
const PEAKS = [0.2, 0.4, 0.6] as const;

const LOW = 0.25;

export function ThinkingDots({ label }: { label: string }) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const phase = useSharedValue(0);

  useEffect(() => {
    // Not reversed: the wave has a direction, left to right, and a reversing loop would
    // run it backwards every other pass.
    phase.value = withRepeat(withTiming(1, { duration: PULSE_MS, easing: Easing.linear }), -1, false);
  }, [phase]);

  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: SIZE - 1, height: SIZE * 2 }}
      accessible
      accessibilityRole="progressbar"
      // The dots say nothing on their own, so the label carries the phase the sighted
      // user reads beside them. `live` is deliberately absent: `StreamView`'s phase text
      // already announces, and two announcements for one state is noise.
      accessibilityLabel={label}
    >
      {PEAKS.map((peak, i) => (
        <Dot key={i} phase={phase} peak={peak} color={t.colors.textFaint} reduced={reduced} />
      ))}
    </View>
  );
}

/**
 * Its own component because `useAnimatedStyle` is a hook, and three of them cannot be
 * called from inside a `.map` in the parent.
 */
function Dot({
  phase,
  peak,
  color,
  reduced,
}: {
  phase: SharedValue<number>;
  peak: number;
  color: string;
  reduced: boolean;
}) {
  const style = useAnimatedStyle(() => {
    // Distance from this dot's peak, wrapped so the cycle is continuous across the
    // boundary — without the wrap the dot nearest 1.0 has a visible discontinuity.
    const raw = Math.abs(phase.value - peak);
    const distance = Math.min(raw, 1 - raw);
    // A triangle: full at the peak, faded a third of a cycle away. Reduce Motion keeps
    // the pulse — it is proof the request is alive, not decoration — but flattens it to a
    // third of its depth, since nothing here travels and only the contrast is worth
    // softening.
    const ramp = Math.max(0, 1 - distance / 0.33);
    const depth = reduced ? (1 - LOW) / 3 : 1 - LOW;
    return { opacity: 1 - depth * (1 - ramp) };
  });

  return (
    <Reanimated.View
      style={[{ width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: color }, style]}
    />
  );
}
