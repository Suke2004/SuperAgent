/**
 * "Jump to the newest message."
 *
 * A floating disc over the bottom of the transcript, shown only while the user has
 * scrolled away from the end. It exists because of what the list does *not* do: the
 * transcript keeps the visible content anchored, so scrolling up during a reply means
 * the reply carries on arriving somewhere the user cannot see, with nothing on screen to
 * say so and a long drag to get back.
 *
 * ## Mounted always, faded conditionally
 *
 * The disc stays in the tree and animates its opacity rather than being conditionally
 * rendered. Mounting it on demand would put a fresh view over the transcript on the
 * frame it appears, which cannot cross-fade — it would pop — and would drop the
 * out-animation entirely, because a component removed from the tree has nowhere to play
 * one. `pointerEvents` follows the visibility instead, so an invisible disc does not eat
 * taps meant for the message underneath it.
 */

import { Pressable, StyleSheet } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';

import { Icon } from '@/components/Icon';
import { usePressFeedback, useTransition } from '@/components/motion';
import { targetSlop, useFocusRing } from '@/components/ui';
import { useTheme } from '@/theme';

/** Matches the composer's send disc: the two are the only floating circles in the app. */
const SIZE = 36;

/** How far it sits below its resting place while hidden, in dp. */
const DROP = 8;

export function ScrollDownButton({ visible, onPress }: { visible: boolean; onPress: () => void }) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const { pressStyle, pressHandlers, onPressHaptic } = usePressFeedback();
  const shown = useTransition(visible);
  const slop = targetSlop(SIZE, SIZE);

  const appear = useAnimatedStyle(() => ({
    opacity: shown.value,
    // It arrives from below, i.e. from the direction it sends you. A disc that faded in
    // on the spot would be a notification; this one is a nudge toward the bottom edge.
    transform: [{ translateY: (1 - shown.value) * DROP }],
  }));

  return (
    <Reanimated.View
      style={[
        {
          position: 'absolute',
          bottom: t.spacing.md,
          alignSelf: 'center',
        },
        appear,
      ]}
      // `none` rather than `box-none`: while hidden the whole subtree has to be
      // untouchable, including the pressable inside it.
      pointerEvents={visible ? 'auto' : 'none'}
      // Hidden from the screen reader as well as from touch. A button that is invisible
      // and inert but still in the accessibility tree is worse than one that pops:
      // it is announced with no way to reach it.
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    >
      <Reanimated.View style={pressStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Jump to the latest message"
          onPress={() => {
            onPressHaptic();
            onPress();
          }}
          {...handlers}
          {...pressHandlers}
          {...(slop ? { hitSlop: slop } : {})}
          style={({ pressed }) => [
            {
              width: SIZE,
              height: SIZE,
              borderRadius: SIZE / 2,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: t.colors.borderStrong,
              // A raised surface, not the accent: this is a navigation convenience
              // sitting on top of the conversation, and the accent in this app means
              // "the thing you came here to press".
              backgroundColor: pressed ? t.colors.surfaceActive : t.colors.surface,
            },
            ring,
          ]}
        >
          <Icon name="expand" tone="textDim" />
        </Pressable>
      </Reanimated.View>
    </Reanimated.View>
  );
}
