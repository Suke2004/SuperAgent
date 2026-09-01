/**
 * Every duration, curve and spring the app is allowed to use.
 *
 * The point is not tidiness, it is that two things which look like the same gesture
 * must take the same time. A drawer that opens in 240ms next to a sheet that rises in
 * 400ms reads as two apps, and nobody ever notices *why* — they just feel that one of
 * them is slow. So the numbers live here, are named for the job rather than the value,
 * and no component gets to invent one.
 *
 * ## Why this file imports nothing
 *
 * Not `react-native`, not `react-native-reanimated`. Two reasons, and they are both
 * load-bearing:
 *
 * 1. **The test runner is `node`.** `jest.config.js` runs with `testEnvironment: 'node'`
 *    and no RN preset, deliberately, so the pure-logic suite stays fast. A single
 *    `import { Easing } from 'react-native-reanimated'` here would make this module
 *    untestable and take {@link scaleDuration} down with it.
 * 2. **It is read by both animation systems.** Most of the app is moving to Reanimated,
 *    but {@link Glyph} and {@link Skeleton} drive RN's core `Animated` with the native
 *    driver, which is genuinely off-thread for opacity and transform. Plain numbers
 *    are the only currency both accept.
 *
 * The cost is that cubic-bezier curves are exported as control-point tuples rather
 * than as built `Easing` objects, so call sites spread them: `Easing.bezier(...curve.exit)`.
 * That is one spread against keeping the timings testable, and the spread loses.
 *
 * Spring configs need no such compromise — Reanimated's `withSpring` takes a plain
 * object, so {@link spring} entries are passed straight through.
 */

/**
 * How long things take, in ms.
 *
 * The scale is deliberately coarse. Four durations covers everything the app does, and
 * a fifth would only ever be used to split a difference nobody can see.
 */
export const duration = {
  /**
   * A control acknowledging a finger: a press dip, a colour change, a chevron turning.
   *
   * Short enough to feel like the surface itself responded rather than something
   * animating in response. Above about 120ms a press stops feeling connected to the
   * touch and starts feeling like a delay.
   */
  press: 110,

  /**
   * The default for something appearing, disappearing or moving in place — a bubble
   * arriving, a toast, a crossfade, a scroll-to-bottom button.
   */
  quick: 180,

  /**
   * A surface that takes over part of the screen: the drawer, a bottom sheet, the
   * artifact panel.
   *
   * The 250–300ms band is where a large panel reads as substantial without reading as
   * sluggish; 260 sits in it and matches the drawer's existing hand-tuned open.
   */
  panel: 260,

  /**
   * Dismissal, for the same panels.
   *
   * Faster than the entrance on purpose, and this asymmetry is the single most
   * effective trick in the file. An entrance is information — the user needs time to
   * see what arrived and where it came from. A dismissal is the user saying "gone";
   * making them wait the same 260ms for something they have already finished with is
   * what makes an interface feel heavy.
   */
  exit: 170,
} as const;

/**
 * Cubic-bezier control points, as `[x1, y1, x2, y2]`.
 *
 * Spread into whichever `Easing.bezier` is in scope. Names describe the motion's
 * shape, not a design-tool preset, because the preset names (`easeInOutQuad`) say
 * nothing about when to reach for them.
 */
export const curve = {
  /**
   * The everyday curve: leaves promptly, arrives gently. Material's standard easing,
   * which is what most platform motion is, including the bits of Android the app sits
   * next to.
   */
  standard: [0.4, 0.0, 0.2, 1.0],

  /**
   * For something entering from off-screen. Decelerates hard into place, so the eye
   * has already caught it before it stops.
   */
  enter: [0.0, 0.0, 0.2, 1.0],

  /**
   * For something leaving. Accelerates away — no lingering, because a surface that
   * eases out slowly looks like it is having second thoughts.
   */
  exit: [0.4, 0.0, 1.0, 1.0],
} as const;

/**
 * Spring configs, as plain objects for `withSpring`.
 *
 * Springs are used where a gesture hands off to an animation — a half-swiped row
 * settling back, a sheet released mid-drag — because a spring carries the velocity the
 * finger left behind and a timing curve throws it away. Everything else uses a
 * duration, since a spring's arrival time is a consequence of its physics rather than
 * something you can promise.
 *
 * All three are critically damped or near it. Overshoot is a decision, not a default:
 * a bottom sheet that bounces past its resting height and settles back looks playful
 * once and cheap by the fiftieth time you open it.
 */
export const spring = {
  /**
   * A panel or sheet settling. Heavier mass, so it reads as a physical object with
   * some weight to it rather than a card on a rubber band.
   */
  panel: { damping: 30, stiffness: 260, mass: 0.9 },

  /**
   * A control springing back under a finger — a press releasing, a row snapping home.
   * Stiff and light, so it is done almost before it is noticed.
   */
  snappy: { damping: 22, stiffness: 400, mass: 0.5 },

  /**
   * The one config allowed a little overshoot, for a discrete state change that
   * benefits from a hint of life: an icon swapping, a badge landing. Never for
   * anything the size of a panel.
   */
  bouncy: { damping: 14, stiffness: 320, mass: 0.6 },
} as const;

/**
 * Stagger step between siblings animating in, in ms.
 *
 * Small on purpose. A 12-item list at 50ms a step takes 600ms to finish arriving,
 * which is long enough to be a wait rather than a flourish. 28ms is enough to read as
 * a sequence and short enough that the whole list is settled quickly.
 */
export const STAGGER_MS = 28;

/**
 * Cap on how many siblings actually stagger.
 *
 * Past this they all animate together. Without a cap, a long list's last rows arrive
 * seconds late, and on a recycling list they arrive after the user has scrolled to
 * them, which looks like a rendering bug rather than a transition.
 */
export const STAGGER_MAX = 8;

/**
 * One half-cycle of a continuous pulse, in ms.
 *
 * Not part of {@link duration} because it is not a transition: nothing has arrived when
 * it finishes, it simply turns around. It lives here so everything in the app that
 * breathes — the mark while it thinks, the thinking dots, a listening mic — breathes at
 * the same tempo. Two pulses at slightly different rates on one screen is a drifting
 * beat-frequency effect that is genuinely unpleasant to look at and very hard to name.
 *
 * 1200ms is a shade slower than a resting human breath, which is what keeps it reading
 * as "alive and waiting" rather than as a loading indicator.
 */
export const PULSE_MS = 1200;

/**
 * The duration to actually use, given the OS accessibility setting.
 *
 * Reduce Motion is collapsed to near-zero rather than to zero, and this matters more
 * than it looks. A `0` duration in Reanimated and in core `Animated` still schedules a
 * frame, but several call sites take a completion callback that does real work —
 * unmounting a modal, focusing a field — and a genuinely instant animation can invoke
 * it inside the same commit that started it. One frame is imperceptible and keeps
 * every callback firing in the order the code was written for.
 *
 * Motion that *carries meaning* should not route through here. When a sheet slides up
 * from the bottom edge, the slide is what says "this came from down there and swiping
 * down puts it back" — an instant appearance loses that, and Reduce Motion asks for
 * less movement, not for less comprehensible software. Use {@link REDUCED_MS} directly
 * for the decorative layer (a stagger, a pulse, a shimmer) and keep the positional
 * move, just shorter.
 *
 * @param ms Intended duration.
 * @param reduce Whether the OS asked for reduced motion.
 */
export function scaleDuration(ms: number, reduce: boolean): number {
  return reduce ? REDUCED_MS : ms;
}

/** One frame at 60fps, rounded. See {@link scaleDuration} for why it is not zero. */
export const REDUCED_MS = 16;
