/**
 * A bottom sheet of actions.
 *
 * Android's own long-press menus are `Alert.alert` with three buttons, which is
 * where a seven-action message menu goes to die. This is a `Modal` instead: it
 * scrolls, it can explain why an action is unavailable, and it closes on the
 * hardware back button — which `Alert` on Android will also do, but only by
 * cancelling, and only if you remember to mark a cancel button.
 *
 * Actions that cannot be taken are shown and explained rather than hidden.
 * "Regenerate" vanishing from the menu teaches the user nothing; "Regenerate —
 * needs an API key" tells them what to go and do.
 */

import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  cancelAnimation,
  Easing,
  FadeInDown,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useDialogKeys } from '@/components/dialog';
import { useReducedMotion } from '@/components/motion';
import { curve, duration, REDUCED_MS, spring, STAGGER_MAX, STAGGER_MS } from '@/constants/animations';
import { Body, Button, Divider, Field, Inline, useKeyboardHeight } from '@/components/ui';
import { useTheme } from '@/theme';

/**
 * How far down the sheet has to be dragged, as a fraction of its own height, before
 * letting go dismisses it instead of springing back.
 *
 * A third. Lower and a sheet gets thrown away by the same flick that was meant to scroll
 * its contents; higher and dismissing takes a deliberate haul, which defeats the point of
 * a gesture that exists to be quicker than aiming at a backdrop.
 */
const DISMISS_FRACTION = 1 / 3;

/**
 * Downward velocity, in dp/s, that dismisses regardless of distance.
 *
 * A fast flick is unambiguous even when it covers 20dp, and requiring the distance as
 * well is what makes a sheet feel like it is resisting.
 */
const DISMISS_VELOCITY = 800;

/**
 * The shell every sheet in this file shares: a fading backdrop, a panel that springs up
 * from the bottom edge, and a grab handle that drags it back down.
 *
 * ## Why the animation is not `Modal`'s
 *
 * `animationType="slide"` exists and does roughly this, on the native side, for free. It
 * is not used because it slides the *entire* modal including the backdrop, so the scrim
 * wipes up the screen with the panel rather than fading in place — which reads as one
 * opaque card rather than as a surface arriving over the app — and because it cannot be
 * driven by a finger, so it could not hand off to the drag gesture.
 *
 * ## Why the exit needs its own mounted state
 *
 * `Modal` unmounts its children the instant `visible` goes false, which kills any exit
 * animation stone dead. So `visible` drives the animation and the animation drives
 * unmounting: the panel plays its way out, and only its completion callback drops the
 * modal. The `closing` state is that one frame of bookkeeping.
 *
 * ## Why the gesture is on a handle rather than the panel
 *
 * {@link Sheet} has a `ScrollView` in it. A pan attached to the whole panel competes with
 * that scroll for every drag, and resolving that fight properly means `simultaneous`
 * handlers plus an offset check against the scroll position — a real amount of machinery
 * to make one gesture ambiguous. A 36dp grab handle at the top is unambiguous, and it is
 * also the affordance that tells the user the gesture is there at all.
 */
export function SheetShell({
  visible,
  onClose,
  label,
  lift = 0,
  panelRef,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  /** What the backdrop is called when a screen reader lands on it. */
  label: string;
  /** Extra bottom margin, for a sheet sitting above a keyboard. */
  lift?: number;
  panelRef?: React.Ref<View>;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const reduced = useReducedMotion();
  /**
   * Kept mounted through the exit.
   *
   * Starts equal to `visible` so a sheet that mounts already open — a sheet whose
   * `visible` was true on the first render — does not need a frame to catch up.
   */
  const [mounted, setMounted] = useState(visible);
  /**
   * Opening is adjusted during render rather than from the effect below, matching
   * `Sidebar`: the modal has to be mounted on the same frame the slide starts, and an
   * effect that mounted it would spend a render doing nothing visible first — which is
   * exactly the frame the eye catches.
   */
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setMounted(true);
  }
  /**
   * Whether the panel has ever reported a height.
   *
   * The entrance is a slide over the panel's own height, so it cannot start before the
   * panel has one — an effect that fired on `visible` alone would animate over the
   * placeholder below. This flag is what lets the effect wait for the first layout, and
   * it deliberately stays true afterwards: a reopened sheet is very nearly the height it
   * was last time, and starting immediately from a stale measurement looks right where
   * waiting another frame looks like a stutter.
   */
  const [measured, setMeasured] = useState(false);

  /** 0 → fully off the bottom edge, 1 → resting. */
  const progress = useSharedValue(visible ? 1 : 0);
  /** Extra downward offset from the finger, in dp. Independent of `progress`. */
  const drag = useSharedValue(0);
  /**
   * The panel's own height, measured.
   *
   * A shared value rather than state: it is read on the UI thread every frame, and as
   * React state it would re-render the whole sheet on every layout pass. The 400 is a
   * placeholder that only matters for a first frame no animation reads — see `measured`.
   */
  const height = useSharedValue(400);

  const finishClose = useCallback(() => setMounted(false), []);

  /**
   * Measurement only.
   *
   * Every mutation in this component is either in this function or in the gesture below,
   * and both are written *above* the hooks that consume the values they touch. That order
   * is not cosmetic: the React Compiler's immutability rule rejects a mutation written
   * after the hook a value was passed to, and it is right to — from the compiler's side
   * there is no way to tell an intentional off-thread write from a component quietly
   * rewriting state a hook has already captured.
   */
  const onLayout = (h: number) => {
    height.value = h;
    if (!measured) setMeasured(true);
  };

  const pan = Gesture.Pan()
    .onChange((event) => {
      // Downward only. An upward drag on the handle of a sheet that is already at rest
      // has nowhere to go, and letting it travel would lift the panel off the bottom
      // edge and show the app through the gap underneath it.
      drag.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (drag.value > height.value * DISMISS_FRACTION || event.velocityY > DISMISS_VELOCITY) {
        // `onClose` rather than animating from here: the parent owns `visible`, and a
        // panel that animated itself away without telling anyone would leave the sheet
        // open as far as the rest of the app is concerned.
        runOnJS(onClose)();
        return;
      }
      // Springing back carries the velocity the finger left behind, which is the one
      // place in this file where a spring is not a stylistic choice.
      drag.value = withSpring(0, spring.snappy);
    });

  useEffect(() => {
    if (visible) {
      if (!measured) return;
      // Cancel any in-progress exit tween before opening. Without this, a re-open
      // while the sheet is still sliding out lets the exit's completion callback run
      // after the fact and call `finishClose()`, unmounting a sheet that should be
      // open — which is how the chat menu appeared to do nothing on a second tap.
      // Same fix as `Sidebar`, same root cause.
      cancelAnimation(progress);
      // A drag left over from a previous dismissal, cleared on the way in rather than on
      // the way out: resetting it during the exit would snap the panel back up under the
      // finger that just threw it away.
      drag.value = 0;
      // Reduce Motion keeps the direction — the slide is what says "this came from the
      // bottom edge, and pushing it back down closes it" — and only loses the spring's
      // settle. See `scaleDuration`'s note on meaningful motion.
      progress.value = reduced
        ? withTiming(1, { duration: duration.quick, easing: Easing.bezier(...curve.enter) })
        : withSpring(1, spring.panel);
      return;
    }
    // Timing out, not a spring: an exit has a deadline — the callback unmounts the modal —
    // and a spring's arrival time is a consequence of its physics rather than something it
    // can promise.
    progress.value = withTiming(
      0,
      { duration: duration.exit, easing: Easing.bezier(...curve.exit) },
      (done) => {
        if (done) runOnJS(finishClose)();
      },
    );
  }, [visible, measured, reduced, progress, drag, finishClose]);

  const backdrop = useAnimatedStyle(() => ({ opacity: progress.value }));
  const panel = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * height.value + drag.value }],
  }));

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      // Both halves of the transition are ours, and `Modal`'s own fade would apply on
      // top of them — a double fade on the way in, and on the way out a modal that
      // vanishes before the panel has finished leaving.
      animationType="none"
      // The Android back button. Without this the sheet is a trap.
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Reanimated.View style={[StyleSheet.absoluteFill, backdrop]}>
          <Pressable onPress={onClose} accessibilityLabel={label} style={{ flex: 1, backgroundColor: t.colors.scrim }} />
        </Reanimated.View>

        <Reanimated.View
          ref={panelRef}
          onLayout={(event) => onLayout(event.nativeEvent.layout.height)}
          // iOS's own focus trap: VoiceOver stops offering the screen underneath.
          accessibilityViewIsModal
          style={[
            {
              backgroundColor: t.colors.surface,
              borderTopLeftRadius: t.radius.lg,
              borderTopRightRadius: t.radius.lg,
              marginBottom: lift,
              maxHeight: '90%',
            },
            panel,
          ]}
        >
          <GestureDetector gesture={pan}>
            {/* A view, not the handle pill itself: the grab target is the full-width
                strip across the top of the sheet, and the pill is only what makes it
                visible. Hidden from the screen reader — the backdrop button and the
                hardware back button are the accessible ways out, and "drag handle" as a
                third one is an instruction a screen-reader user cannot follow. */}
            <View
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              style={{ paddingTop: t.spacing.sm, paddingBottom: 2, alignItems: 'center' }}
            >
              <View
                style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.colors.borderStrong }}
              />
            </View>
          </GestureDetector>
          {children}
        </Reanimated.View>
      </View>
    </Modal>
  );
}

export interface SheetAction {
  label: string;
  onPress: () => void;
  /** Rendered in the danger colour. Does not add a confirmation — do that yourself. */
  destructive?: boolean;
  disabled?: boolean;
  /** Why it is unavailable. Shown under the label; required in spirit if disabled. */
  disabledReason?: string;
  subtitle?: string;
}

export function Sheet({
  visible,
  title,
  subtitle,
  body,
  actions,
  onClose,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  /**
   * A paragraph above the actions, for a sheet whose job is to explain something.
   *
   * `subtitle` is clamped to two lines because it describes the thing the actions
   * act on; this is for the sheets that are the explanation.
   */
  body?: string;
  actions: readonly SheetAction[];
  onClose: () => void;
}) {
  const t = useTheme();
  const trap = useDialogKeys(visible, onClose);
  const reduced = useReducedMotion();

  return (
    <SheetShell visible={visible} onClose={onClose} label="Close menu" panelRef={trap}>
      <View style={{ paddingHorizontal: t.spacing.md, paddingBottom: t.spacing.md, gap: 2 }}>
        <Text style={{ color: t.colors.text, fontSize: t.fontSize.md, fontWeight: '700' }}>{title}</Text>
        {subtitle ? (
          <Body size="xs" tone="faint" numberOfLines={2}>
            {subtitle}
          </Body>
        ) : null}
      </View>
      <Divider />

      <ScrollView>
        {body ? (
          <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md }}>
            <Body size="sm" tone="dim">
              {body}
            </Body>
          </View>
        ) : null}
        {actions.map((action, index) => (
          <Reanimated.View
            key={action.label}
            // The rows arrive in sequence rather than as a block, which is the
            // difference between a menu that *opened* and a list that was already
            // there. Capped by `STAGGER_MAX` because past eight rows the tail lands
            // after the user has started reading, and zeroed under Reduce Motion —
            // a stagger is pure decoration, so it collapses rather than shortens.
            entering={FadeInDown.delay(reduced ? 0 : Math.min(index, STAGGER_MAX) * STAGGER_MS)
              .duration(reduced ? REDUCED_MS : duration.quick)
              .reduceMotion(ReduceMotion.System)}
          >
            {index > 0 ? <Divider /> : null}
            <Pressable
              disabled={action.disabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: Boolean(action.disabled) }}
              accessibilityHint={action.disabled ? action.disabledReason : action.subtitle}
              onPress={() => {
                // The action before the close. `onClose` is also the *dismissal* path, so
                // a screen whose dismissal decides something — the MCP approval sheet
                // denies on it, because a turn blocked on a question nothing answers is
                // worse than a refusal — would otherwise answer for the row the user just
                // tapped, and every "Allow" would arrive as a denial. Both are state
                // updates in one event and still commit together, so a row that navigates
                // does not leave the sheet mounted over the new screen either way.
                action.onPress();
                onClose();
              }}
              style={({ pressed }) => ({
                paddingHorizontal: t.spacing.md,
                paddingVertical: t.spacing.md,
                gap: 2,
                opacity: action.disabled ? 0.45 : 1,
                backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
              })}
            >
              <Text
                style={{
                  color: action.destructive ? t.colors.danger : t.colors.text,
                  fontSize: t.fontSize.md,
                }}
              >
                {action.label}
              </Text>
              {action.disabled && action.disabledReason ? (
                <Body size="xs" tone="faint">
                  {action.disabledReason}
                </Body>
              ) : action.subtitle ? (
                <Body size="xs" tone="faint">
                  {action.subtitle}
                </Body>
              ) : null}
            </Pressable>
          </Reanimated.View>
        ))}
        {/* The bottom inset lives inside the scroll view, so a sheet with more actions
            than fit does not reserve a strip of empty surface below the last one. */}
        <View style={{ height: t.spacing.xl }} />
      </ScrollView>
    </SheetShell>
  );
}

/**
 * A sheet that asks for one piece of text.
 *
 * Rename, tags, system prompt and edit-in-place are all this shape, and
 * `Alert.prompt` does not exist on Android.
 *
 * The draft lives in {@link PromptBody}, which exists only while the sheet is
 * open, so mounting *is* the reset: cancelling genuinely discards, and reopening
 * shows the stored value again. That is why there is no effect syncing `initial`
 * into state — a synced draft is the version of this component where an abandoned
 * edit reappears three screens later.
 */
export function PromptSheet(props: PromptSheetProps) {
  // The field autofocuses, so the keyboard is always up while this sheet is open — and an
  // edge-to-edge Android window does not resize for it, so the sheet has to lift itself or
  // it opens underneath the keys. See `useKeyboardHeight`. The lift is on the shell's panel
  // rather than inside the body, so the sheet's *surface* stops above the keyboard instead
  // of its content floating over a strip of surface hidden behind it.
  const keyboardHeight = useKeyboardHeight();

  return (
    <SheetShell visible={props.visible} onClose={props.onCancel} label="Cancel" lift={keyboardHeight}>
      {/* Explicit rather than relying on the shell to unmount: the draft lives in
          {@link PromptBody}, so mounting *is* the state reset, and the shell deliberately
          keeps its panel mounted for one exit animation. */}
      {props.visible ? <PromptBody {...props} /> : null}
    </SheetShell>
  );
}

interface PromptSheetProps {
  visible: boolean;
  title: string;
  hint?: string;
  initial: string;
  placeholder?: string;
  rows?: number;
  confirmLabel?: string;
  /** For fields where clearing is a meaningful action, e.g. the system prompt. */
  allowEmpty?: boolean;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}

function PromptBody({
  title,
  hint,
  initial,
  placeholder,
  rows = 1,
  confirmLabel = 'Save',
  allowEmpty = false,
  onCancel,
  onConfirm,
}: PromptSheetProps) {
  const t = useTheme();
  const [text, setText] = useState(initial);
  const trap = useDialogKeys(true, onCancel);

  const blocked = !allowEmpty && text.trim().length === 0;

  return (
    <View
      ref={trap}
      style={{
        padding: t.spacing.md,
        paddingBottom: t.spacing.xl,
        gap: t.spacing.md,
      }}
    >
      <Text style={{ color: t.colors.text, fontSize: t.fontSize.md, fontWeight: '700' }}>{title}</Text>
      <Field
        value={text}
        onChangeText={setText}
        rows={rows}
        autoFocus
        // `Field` defaults to identifier-friendly input, which is wrong here:
        // every one of these fields is prose the user wrote.
        autoCapitalize="sentences"
        autoCorrect
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(hint !== undefined ? { hint } : {})}
      />
      <Inline gap="sm">
        <Button
          label={confirmLabel}
          onPress={() => onConfirm(text)}
          variant="primary"
          disabled={blocked}
          {...(blocked ? { disabledReason: 'Nothing to save yet.' } : {})}
        />
        <Button label="Cancel" onPress={onCancel} variant="ghost" />
      </Inline>
    </View>
  );
}
