/**
 * A list row that slides left to uncover its actions.
 *
 * ## Why, when there is already a long-press menu
 *
 * The menu is the complete answer — every action, named in words, with a reason
 * attached to the ones that are unavailable — and it stays the only way in for anyone
 * using a screen reader. This is the *fast* answer for the two or three actions a
 * person performs on a list dozens of times a week. It does not replace the menu and
 * deliberately does not try to hold everything the menu holds.
 *
 * ## Living inside a vertical list
 *
 * The whole difficulty is that this pan and the list's scroll want the same finger.
 * `activeOffsetX` means the pan does not begin until the finger has committed
 * horizontally, and `failOffsetY` means that once it has moved vertically instead, the
 * pan gives up for good rather than fighting for the rest of the drag. Without the
 * second one a diagonal flick both scrolls the list and half-opens a row.
 *
 * One-directional, too: the row travels left and stops at zero. Rubber-banding to the
 * right would suggest actions on that side, and there are none.
 */

import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import type { ReactNode } from 'react';

import { Icon } from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Body } from '@/components/ui';
import { spring } from '@/constants/animations';
import * as haptics from '@/lib/haptics';
import { useTheme } from '@/theme';

/**
 * How wide one action is, in dp.
 *
 * 64 rather than the 48dp minimum: three of these have to be distinguishable from each
 * other by position alone while the finger is still on the screen, and 48 puts them
 * close enough together that the wrong one gets hit on the way past.
 */
const ACTION_WIDTH = 64;

/** Past this fraction of the full reveal, letting go opens rather than closes. */
const OPEN_FRACTION = 0.4;

/** Leftward velocity, in dp/s, that opens regardless of distance. */
const OPEN_VELOCITY = 500;

export interface SwipeAction {
  icon: IconName;
  /** Shown under the icon *and* used as the accessibility label. Keep it to one word. */
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

export function SwipeRow({
  actions,
  enabled = true,
  children,
}: {
  actions: readonly SwipeAction[];
  /**
   * False while the list is in selection mode.
   *
   * A row that both toggles a checkbox and hides a Delete button under a swipe is one
   * mis-read gesture away from deleting something the user was trying to tick.
   */
  enabled?: boolean;
  children: ReactNode;
}) {
  const t = useTheme();
  const reveal = actions.length * ACTION_WIDTH;

  /** Current offset, 0 → closed, `-reveal` → fully open. */
  const x = useSharedValue(0);
  /** Where the offset was when this drag began, so a second drag continues the first. */
  const start = useSharedValue(0);

  const pan = Gesture.Pan()
    .enabled(enabled && actions.length > 0)
    // The list gets the benefit of the doubt in both directions: nothing happens here
    // until the finger has travelled 12dp sideways, and it is over for good after 8dp
    // down. A row is much cheaper to re-open than a mis-scrolled list is to find again.
    .activeOffsetX([-12, 12])
    .failOffsetY([-8, 8])
    .onBegin(() => {
      start.value = x.value;
    })
    .onChange((event) => {
      x.value = Math.min(0, Math.max(-reveal, start.value + event.translationX));
    })
    .onEnd((event) => {
      const open = x.value < -reveal * OPEN_FRACTION || event.velocityX < -OPEN_VELOCITY;
      if (open && start.value === 0) runOnJS(haptics.tap)();
      x.value = withSpring(open ? -reveal : 0, spring.snappy);
    });

  /**
   * Written above the `useAnimatedStyle` calls below, and that is not cosmetic: the
   * React Compiler's immutability rule rejects a write to a shared value that has
   * already been handed to a hook, because from its side an intentional off-thread
   * write is indistinguishable from a component rewriting state a hook has captured.
   */
  const close = () => {
    x.value = withSpring(0, spring.snappy);
  };

  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  /**
   * The strip fades with the reveal.
   *
   * Without it the actions are at full strength behind a row that has not moved yet,
   * which shows as a hard edge the instant the drag starts. Tied to distance rather
   * than to a separate timing, so it tracks the finger exactly.
   */
  const strip = useAnimatedStyle(() => ({ opacity: reveal === 0 ? 0 : Math.min(1, -x.value / reveal) }));

  return (
    <View>
      {/* Behind the row, and hidden from the screen reader: a swipe is not a gesture a
          screen-reader user can perform, so announcing three buttons they cannot reach
          would be worse than silence. The long-press menu is their route, and it has
          every one of these actions in it. */}
      <Reanimated.View
        style={[StyleSheet.absoluteFill, { flexDirection: 'row', justifyContent: 'flex-end' }, strip]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={() => {
              // Closed first, so the row is back where it belongs whether the action
              // navigates, opens a confirmation, or removes the row underneath itself.
              close();
              action.onPress();
            }}
            style={({ pressed }) => ({
              width: ACTION_WIDTH,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              backgroundColor: action.destructive
                ? pressed
                  ? t.colors.danger
                  : t.colors.dangerSoft
                : pressed
                  ? t.colors.surfaceActive
                  : t.colors.surfaceAlt,
            })}
          >
            <Icon name={action.icon} tone={action.destructive ? 'danger' : 'textDim'} />
            <Body size="xs" tone={action.destructive ? 'danger' : 'faint'}>
              {action.label}
            </Body>
          </Pressable>
        ))}
      </Reanimated.View>

      <GestureDetector gesture={pan}>
        {/* Opaque, and that is load-bearing: the row's own background is transparent so
            the list's separators and selection tint read correctly, which would let the
            action strip show straight through it. */}
        <Reanimated.View style={[{ backgroundColor: t.colors.bg }, slide]}>{children}</Reanimated.View>
      </GestureDetector>
    </View>
  );
}
