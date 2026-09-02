/**
 * The transient confirmation.
 *
 * ## Why this exists next to `Note` and `Alert`
 *
 * Three things wanted saying and none of the existing three could say them. `Note` is
 * part of a screen's layout, so it reflows whatever is under it and stays until the
 * screen changes — right for "this profile has no key", wrong for "archived". `Alert`
 * takes the whole screen hostage and demands a tap, which for a confirmation the user
 * already knows about is a second interruption for the same event. And several call
 * sites had simply been keeping the outcome in state and rendering it forever, which is
 * how a screen ends up with last week's "Saved." still on it.
 *
 * So: one line, at the bottom, gone by itself. It overlays rather than occupying, which
 * is the whole point — nothing on the screen behind it moves.
 *
 * ## Why the queue is a module value
 *
 * `toast()` is called from event handlers on nine screens, several of them inside a
 * `Modal` — a separate native window, so no provider mounted in the navigator can reach
 * them. The same constraint that put `drawerProgress` at module scope applies here, and
 * for the same reason. `useSyncExternalStore` is React's own supported way to read a
 * value like that, so the host stays a normal component with no subscription of its own
 * to get wrong.
 *
 * ponytail: one slot, not a queue. Two toasts within three seconds means the second
 * replaces the first, which is the right answer for confirmations of *different*
 * actions and the wrong one for a batch — no call site does the latter. Give it a list
 * if one ever does.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useReducedMotion } from '@/components/motion';
import { curve, duration, spring } from '@/constants/animations';
import { useTheme } from '@/theme';

/** How long a toast stays up, in ms, measured from when it finished arriving. */
const TOAST_MS = 3_400;

/** How far it starts below its resting place, in dp. Enough to read as arriving. */
const TRAVEL = 64;

/** Downward drag, in dp, past which letting go dismisses instead of springing back. */
const DISMISS_DP = 24;

/** Downward velocity, in dp/s, that dismisses regardless of distance. */
const DISMISS_VELOCITY = 500;

export interface ToastMessage {
  /** Bumped per call, and used as the host's key: a new toast replays the animation. */
  id: number;
  text: string;
  tone: 'neutral' | 'danger';
}

let current: ToastMessage | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function publish(next: ToastMessage | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Say something, briefly.
 *
 * Callable from anywhere, including outside React. Nothing awaits it and nothing can
 * fail: a confirmation that could throw would be worse than no confirmation.
 *
 * @param text One line, past tense, naming what happened. "Archived 3 conversations."
 * @param tone `danger` for something that went wrong but did not need a dialog.
 */
export function toast(text: string, tone: ToastMessage['tone'] = 'neutral'): void {
  counter += 1;
  publish({ id: counter, text, tone });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The overlay. Mounted once, in the root layout, above the navigator.
 *
 * Renders nothing at all when there is no message, so the common case costs one
 * subscription and no views — it is not an invisible full-screen layer sitting over
 * every screen in the app waiting for touches to pass through it.
 */
export function ToastHost() {
  const message = useSyncExternalStore(subscribe, () => current);
  // Keyed, so the whole thing — timer, gesture, shared values — is rebuilt per message
  // rather than trying to re-drive an animation that is already halfway somewhere.
  return message ? <Toast key={message.id} message={message} /> : null;
}

function Toast({ message }: { message: ToastMessage }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  /**
   * Whether this toast is the one still on screen.
   *
   * Checked before clearing, because the module holds one slot: a toast whose timer
   * fires *after* it has already been replaced would otherwise dismiss its successor
   * three seconds early.
   */
  const [id] = useState(message.id);

  /** 0 → resting, 1 → fully off the bottom edge. Drives travel and fade together. */
  const gone = useSharedValue(1);
  /** Extra downward offset from the finger, in dp. Independent of `gone`. */
  const drag = useSharedValue(0);

  /**
   * Written above the hooks that read `gone` and `drag`, which is not cosmetic — see the
   * same note in `Sheet`. The React Compiler rejects a mutation written after the hook
   * a shared value was passed to.
   */
  const clear = (): void => {
    if (current?.id === id) publish(null);
  };

  const leave = (): void => {
    'worklet';
    gone.value = withTiming(
      1,
      { duration: duration.exit, easing: Easing.bezier(...curve.exit) },
      (finished) => {
        if (finished) runOnJS(clear)();
      },
    );
  };

  const pan = Gesture.Pan()
    // Downward only. There is nothing above a toast to drag it towards, and letting it
    // travel up would lift it into the composer it is reporting on.
    .onChange((event) => {
      drag.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (drag.value > DISMISS_DP || event.velocityY > DISMISS_VELOCITY) {
        leave();
        return;
      }
      drag.value = withSpring(0, spring.snappy);
    });

  useEffect(() => {
    // Reduce Motion keeps the direction and loses the spring's settle: the toast coming
    // *up from the bottom edge* is what says it can be pushed back down, and that is
    // information, not decoration.
    gone.value = reduced
      ? withTiming(0, { duration: duration.quick, easing: Easing.bezier(...curve.enter) })
      : withSpring(0, spring.panel);
    const timer = setTimeout(() => {
      gone.value = withTiming(
        1,
        { duration: duration.exit, easing: Easing.bezier(...curve.exit) },
        (finished) => {
          if (finished) runOnJS(clear)();
        },
      );
    }, TOAST_MS);
    return () => clearTimeout(timer);
    // `clear` is stable in effect — it closes over `id`, which came from `useState` and
    // never changes for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, gone]);

  const slide = useAnimatedStyle(() => ({
    opacity: 1 - gone.value,
    transform: [{ translateY: gone.value * TRAVEL + drag.value }],
  }));

  return (
    <Reanimated.View
      // Absolute over the navigator, and only as wide as it needs to be: the strip of
      // screen either side of a short toast still belongs to the screen underneath.
      pointerEvents="box-none"
      style={[
        {
          position: 'absolute',
          left: t.spacing.md,
          right: t.spacing.md,
          bottom: insets.bottom + t.spacing.lg,
        },
        slide,
      ]}
    >
      <GestureDetector gesture={pan}>
        <View>
          <Pressable
            // Tapping dismisses as well as swiping. A toast has nothing to open, so the
            // only thing a tap on it can reasonably mean is "yes, I saw it".
            onPress={leave}
            accessibilityRole="button"
            accessibilityLabel={message.text}
            accessibilityHint="Dismisses this message"
            // Announced without stealing focus. The action that caused this already
            // happened; a screen reader that jumped here would lose the user's place.
            accessibilityLiveRegion="polite"
            style={{
              backgroundColor: t.colors.surfaceAlt,
              borderColor: message.tone === 'danger' ? t.colors.danger : t.colors.border,
              borderWidth: StyleSheet.hairlineWidth,
              borderRadius: t.radius.md,
              paddingHorizontal: t.spacing.md,
              paddingVertical: t.spacing.sm,
              // The one elevation in the app, because this is the one thing that is
              // genuinely above the page rather than part of it.
              elevation: 6,
            }}
          >
            <Text
              numberOfLines={2}
              style={{
                color: message.tone === 'danger' ? t.colors.danger : t.colors.text,
                fontSize: t.fontSize.sm,
              }}
            >
              {message.text}
            </Text>
          </Pressable>
        </View>
      </GestureDetector>
    </Reanimated.View>
  );
}
