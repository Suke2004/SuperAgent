/**
 * The Jarvis mark.
 *
 * Four arms turning clockwise from a common centre — pure orthogonal geometry, so
 * it is built from absolutely-positioned `View`s rather than SVG. `react-native-svg`
 * is not a dependency and the mark does not need it.
 *
 * Two rules the geometry encodes deliberately:
 *  - it rotates *clockwise* only, never anticlockwise;
 *  - it stays upright, never on the 45° diagonal.
 *
 * Motion uses RN's built-in `Animated`. `react-native-reanimated` is listed in
 * package.json but unused and its babel plugin is not configured, so reaching for it
 * here would mean a build-config change for one spinner.
 */

import { memo, useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

export type GlyphState = 'idle' | 'thinking' | 'writing' | 'error';

/** One full turn, in ms. Slow enough to read as deliberate rather than as a loader. */
const SPIN_MS = 6500;
/** The reduced-motion substitute: a breath, at the same tempo as the dot pulse. */
const PULSE_MS = 1200;

/**
 * Geometry on a 64-unit grid, scaled by `size / 64` at render.
 *
 * Each arm is an L: a bar out from the centre, then a bar turning clockwise off its
 * end. `w` is the stroke width; the bars overlap at the corner by design so the turn
 * reads as one continuous limb.
 */
const GRID = 64;
const C = 32;

interface Bar {
  /** Left, top, width, height — in grid units, before scaling. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stroke width and arm reach, per weight. Small sizes need a fatter, shorter arm. */
function geometry(stroke: number, reach: number, turn: number): { bars: Bar[]; dots: Bar[] } {
  const half = stroke / 2;
  // Each limb is two overlapping rects whose *centrelines* meet at the arm's end, so
  // the corner is square and the turn reads as one continuous stroke.
  const bars: Bar[] = [
    // Up, then right.
    { x: C - half, y: C - reach - half, w: stroke, h: reach + stroke },
    { x: C - half, y: C - reach - half, w: turn + stroke, h: stroke },
    // Right, then down.
    { x: C - half, y: C - half, w: reach + stroke, h: stroke },
    { x: C + reach - half, y: C - half, w: stroke, h: turn + stroke },
    // Down, then left.
    { x: C - half, y: C - half, w: stroke, h: reach + stroke },
    { x: C - turn - half, y: C + reach - half, w: turn + stroke, h: stroke },
    // Left, then up.
    { x: C - reach - half, y: C - half, w: reach + stroke, h: stroke },
    { x: C - reach - half, y: C - turn - half, w: stroke, h: turn + stroke },
  ];
  // Four accent points in the pockets between the arms; they pulse in sequence.
  const r = Math.max(1.6, stroke * 0.48);
  const d = reach * 0.55;
  const dots: Bar[] = [
    { x: C + d - r, y: C - d - r, w: r * 2, h: r * 2 },
    { x: C + d - r, y: C + d - r, w: r * 2, h: r * 2 },
    { x: C - d - r, y: C + d - r, w: r * 2, h: r * 2 },
    { x: C - d - r, y: C - d - r, w: r * 2, h: r * 2 },
  ];
  return { bars, dots };
}

/**
 * Below this the four dots stop being legible and start reading as noise, so the
 * mark is drawn with a heavier stroke and no dots.
 */
const DOT_MIN_SIZE = 34;

/**
 * Where in the pulse cycle each dot peaks.
 *
 * Spread rather than evenly quartered so no dot peaks at the cycle boundary, where
 * its ramp would be one-sided.
 */
const DOT_PEAKS = [0.5, 0.3, 0.1, 0.9] as const;
const DOT_LOW = 0.28;

export interface GlyphProps {
  /** Rendered edge length in dp. Defaults to a size that fits a message gutter. */
  size?: number;
  /**
   * What the mark is reporting.
   *
   * `thinking` turns; `writing` and `idle` are dead still, because a spinner that
   * never stops stops meaning anything; `error` breaks to the danger colour.
   */
  state?: GlyphState;
  /** Overrides the state-derived colour. */
  color?: string;
  style?: StyleProp<ViewStyle>;
  /**
   * Screen-reader label. Defaults to nothing: the mark almost always sits beside
   * text that already says what it means, and a second announcement is noise.
   */
  label?: string;
}

function GlyphInner({ size = 22, state = 'idle', color, style, label }: GlyphProps) {
  const t = useTheme();
  // Lazy `useState` rather than `useRef`: these values are read during render to build
  // the interpolations, and a ref read in render is exactly what it is not for.
  const [spin] = useState(() => new Animated.Value(0));
  const [pulse] = useState(() => new Animated.Value(0));
  // State, not a ref, because it decides what gets rendered *and* which animation runs;
  // as a ref, flipping the system setting mid-session would not restart the loop.
  const [reduceMotion, setReduceMotion] = useState(false);
  const animating = state === 'thinking';

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (!cancelled) setReduceMotion(on);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => {
      setReduceMotion(on);
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (!animating) {
      spin.stopAnimation();
      pulse.stopAnimation();
      // Reset rather than freeze mid-turn: a mark stopped at 43° looks broken.
      spin.setValue(0);
      pulse.setValue(0);
      return;
    }
    // Rotation runs 0 → 1 mapped to 0 → 90°, so every loop lands on a pose
    // indistinguishable from the start and the repeat is seamless.
    const rotate = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: SPIN_MS / 4,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const breathe = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: PULSE_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    // Reduce Motion swaps the turn for the same opacity breath the dots use, so the
    // mark still reads as "working" without anything travelling across the screen.
    if (reduceMotion) {
      breathe.start();
      return () => breathe.stop();
    }
    rotate.start();
    breathe.start();
    return () => {
      rotate.stop();
      breathe.stop();
    };
  }, [animating, spin, pulse, reduceMotion]);

  const scale = size / GRID;
  const heavy = size < DOT_MIN_SIZE;
  const { bars, dots } = geometry(heavy ? 6 : 4.4, heavy ? 21 : 23, heavy ? 13 : 14);
  const stroke =
    color ?? (state === 'error' ? t.colors.danger : state === 'idle' ? t.colors.textFaint : t.colors.accentFill);

  const rotation = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });
  // `pulse` is a linear 0→1 sawtooth; each dot reads a triangle off it that peaks at a
  // different point in the cycle, which is what makes the four fire in sequence from
  // one driver rather than four.
  const dotOpacity = DOT_PEAKS.map((p) =>
    pulse.interpolate({ inputRange: [0, p, 1], outputRange: [DOT_LOW, 1, DOT_LOW] }),
  );
  const breath = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.45, 1, 0.45] });
  const bodyOpacity = animating && reduceMotion ? breath : 1;

  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessible={label !== undefined}
      accessibilityRole={label !== undefined ? 'image' : undefined}
      accessibilityLabel={label}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { opacity: bodyOpacity, transform: [{ rotate: rotation }] },
        ]}
      >
        {bars.map((b, i) => (
          <View
            key={`arm-${i}`}
            style={{
              position: 'absolute',
              left: b.x * scale,
              top: b.y * scale,
              width: b.w * scale,
              height: b.h * scale,
              backgroundColor: stroke,
              // An error state breaks the limbs apart; a whole mark would read as fine.
              opacity: state === 'error' && i % 2 === 1 ? 0.35 : 1,
            }}
          />
        ))}
        {!heavy &&
          state !== 'error' &&
          dots.map((d, i) => (
            <Animated.View
              key={`dot-${i}`}
              style={{
                position: 'absolute',
                left: d.x * scale,
                top: d.y * scale,
                width: d.w * scale,
                height: d.h * scale,
                borderRadius: (d.w * scale) / 2,
                backgroundColor: stroke,
                opacity: animating ? dotOpacity[i] : 0.42,
              }}
            />
          ))}
      </Animated.View>
    </View>
  );
}

export const Glyph = memo(GlyphInner);
