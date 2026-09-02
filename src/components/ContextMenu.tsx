/**
 * A menu that opens where you pressed.
 *
 * ## Why not the bottom sheet
 *
 * {@link Sheet} is the right shape for a menu you reached by *deciding* to — a row's ⋯,
 * a settings action — because it arrives from a predictable edge and lists everything
 * with room to explain itself. It is the wrong shape for a long-press. A long-press says
 * "this thing, here", and answering it at the far bottom of the screen breaks the link
 * between the object and its actions: the user's finger is on a message and the menu
 * about that message is 600dp away, over a transcript that is now hidden behind it.
 *
 * So this one opens at the press, over a blurred screen, and scales out of the corner
 * nearest the finger. The blur is not decoration — it is what makes an unlabelled
 * floating card obviously *about* the thing it is covering, by taking everything else
 * out of focus at once.
 *
 * ## Why the anchor is the touch point
 *
 * The alternative is the pressed element's bounds, which means a ref and a
 * `measureInWindow` on every element that can be long-pressed, an async measurement in
 * the middle of a gesture, and a menu that cannot open until it resolves. A
 * `GestureResponderEvent` already carries `pageX`/`pageY`, which is where the user is
 * looking, and it is what every platform's own context menu anchors to.
 *
 * ## Why nothing is measured
 *
 * Placing a card relative to a point needs its height, and measuring it means rendering
 * it somewhere wrong for a frame first. Instead the side with more room wins and the
 * card is pinned to the anchor by *that* edge — `top` when it opens downwards, `bottom`
 * when it opens up — with a `maxHeight` of whatever that space is. Flexbox then sizes
 * it, the scroll view absorbs an overflow, and no frame is ever spent in the wrong
 * place.
 */

import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions } from 'react-native';
import { BlurView } from 'expo-blur';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useDialogKeys } from '@/components/dialog';
import { useReducedMotion } from '@/components/motion';
import type { SheetAction } from '@/components/Sheet';
import { Body } from '@/components/ui';
import { curve, duration, REDUCED_MS } from '@/constants/animations';
import { useTheme } from '@/theme';

/** Where the finger was, in window coordinates. From `event.nativeEvent.pageX`/`pageY`. */
export interface Anchor {
  x: number;
  y: number;
}

/** Read an anchor out of the press event that opened the menu. */
export function anchorOf(event: { nativeEvent: { pageX: number; pageY: number } }): Anchor {
  return { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
}

/** The card's width, in dp, unless the screen is narrower than it plus its margins. */
const CARD_WIDTH = 268;

/** Gap between the finger and the card, in dp. Enough that the card is not under it. */
const OFFSET = 12;

/** How much smaller the card starts. Small: this is a menu appearing, not a zoom. */
const START_SCALE = 0.9;

export function ContextMenu({
  visible,
  anchor,
  actions,
  onClose,
}: {
  visible: boolean;
  /** Null only before the first open, which is also when `visible` is false. */
  anchor: Anchor | null;
  actions: readonly SheetAction[];
  onClose: () => void;
}) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const window = useWindowDimensions();
  const trap = useDialogKeys(visible, onClose);

  /** Kept mounted through the exit, exactly as {@link SheetShell} does. */
  const [mounted, setMounted] = useState(visible);
  const [wasVisible, setWasVisible] = useState(visible);

  /** 0 → not there, 1 → open. Drives the blur, the fade and the scale together. */
  const progress = useSharedValue(visible ? 1 : 0);

  const finishClose = (): void => setMounted(false);

  /**
   * Both halves of the transition, adjusted during render rather than from an effect —
   * the pattern the sheets use, and for the same reason: the modal has to be mounted on
   * the frame the animation starts, or the first frame shows a full-size card that then
   * animates from nowhere.
   *
   * Written *above* the `useAnimatedStyle` calls that read `progress`, which is not
   * cosmetic. The React Compiler's immutability rule rejects a mutation written after
   * the hook a value was passed to, and it is right to.
   */
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) {
      setMounted(true);
      progress.value = withTiming(1, {
        duration: reduced ? REDUCED_MS : duration.quick,
        easing: Easing.bezier(...curve.enter),
      });
    } else {
      progress.value = withTiming(
        0,
        { duration: reduced ? REDUCED_MS : duration.exit, easing: Easing.bezier(...curve.exit) },
        (finished) => {
          if (finished) runOnJS(finishClose)();
        },
      );
    }
  }

  const veil = useAnimatedStyle(() => ({ opacity: progress.value }));
  const card = useAnimatedStyle(() => ({
    opacity: progress.value,
    // Scale is the decorative half — it says "this came out of that point" — so Reduce
    // Motion drops it entirely and keeps the fade, which conveys the same arrival
    // without anything travelling. See `scaleDuration`'s note on meaningful motion.
    transform: reduced
      ? []
      : [{ scale: START_SCALE + (1 - START_SCALE) * progress.value }],
  }));

  if (!mounted || !anchor) return null;

  const width = Math.min(CARD_WIDTH, window.width - 2 * t.spacing.md);
  // Left-aligned to the finger, then pushed back inside the screen. Both margins are
  // enforced, so a press in the last 20dp of a narrow screen still gets a whole card.
  const left = Math.max(t.spacing.md, Math.min(anchor.x, window.width - width - t.spacing.md));
  /** Downwards when there is more room below the finger than above it. */
  const downwards = anchor.y < window.height / 2;
  const room = (downwards ? window.height - anchor.y : anchor.y) - OFFSET - t.spacing.lg;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Reanimated.View style={[StyleSheet.absoluteFill, veil]}>
        {/* Blur *and* a scrim. The blur alone is too gentle to read as a modal state on
            a light theme, and on a device that refuses to blur — `expo-blur` degrades to
            a plain translucent view — the scrim is the whole effect. */}
        <BlurView
          intensity={24}
          tint={t.scheme === 'dark' ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close menu"
          style={{ flex: 1, backgroundColor: t.colors.scrim }}
        />
      </Reanimated.View>

      <Reanimated.View
        ref={trap}
        accessibilityViewIsModal
        style={[
          {
            position: 'absolute',
            left,
            width,
            maxHeight: room,
            ...(downwards ? { top: anchor.y + OFFSET } : { bottom: window.height - anchor.y + OFFSET }),
            backgroundColor: t.colors.surface,
            borderColor: t.colors.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: t.radius.md,
            // Out of the corner nearest the finger, which is the corner the card is
            // pinned by. A static style: the origin never changes while the menu is open.
            transformOrigin: downwards ? 'left top' : 'left bottom',
            overflow: 'hidden',
            elevation: 8,
          },
          card,
        ]}
      >
        <ScrollView>
          {actions.map((action) => (
            <Pressable
              key={action.label}
              disabled={action.disabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: Boolean(action.disabled) }}
              accessibilityHint={action.disabled ? action.disabledReason : action.subtitle}
              onPress={() => {
                // Close first: several of these navigate, and a menu still mounted over
                // a push is a menu over the wrong screen.
                onClose();
                action.onPress();
              }}
              style={({ pressed }) => ({
                paddingHorizontal: t.spacing.md,
                paddingVertical: t.spacing.sm,
                gap: 1,
                opacity: action.disabled ? 0.45 : 1,
                backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
              })}
            >
              <Text
                style={{
                  color: action.destructive ? t.colors.danger : t.colors.text,
                  fontSize: t.fontSize.sm,
                }}
              >
                {action.label}
              </Text>
              {/* Clamped to one line, where the sheet let a subtitle wrap. The
                  explanations are worth keeping — "Duplicate" alone does not say it
                  renames — but a menu you are aiming at cannot afford three-line rows,
                  and the full text is still in the accessibility hint. */}
              {action.disabled && action.disabledReason ? (
                <Body size="xs" tone="faint" numberOfLines={2}>
                  {action.disabledReason}
                </Body>
              ) : action.subtitle ? (
                <Body size="xs" tone="faint" numberOfLines={1}>
                  {action.subtitle}
                </Body>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      </Reanimated.View>
    </Modal>
  );
}
