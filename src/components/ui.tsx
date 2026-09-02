/**
 * Shared UI primitives.
 *
 * The app is a control panel more than it is a chat app, so these lean towards
 * dense, labelled, settings-style layouts: rows with values, fields with hints,
 * and controls that can explain *why* they are disabled rather than just going grey.
 * That last part is a hard requirement from the spec, so `disabledReason` is a
 * first-class prop on the controls rather than something each screen invents.
 *
 * Two cross-cutting rules are enforced here rather than per screen, because there
 * are ~26 focus stops and every one of them used to be invisible:
 *
 * - **Every focusable control draws a ring.** {@link useFocusRing} plus
 *   {@link focusRingStyle} put an `outline` on the control while it holds focus.
 *   An outline is used rather than a border because it does not participate in
 *   layout: a focused button must not reflow the row it sits in.
 * - **Every target clears 48dp.** Android's minimum. Where the visual box is
 *   deliberately smaller than that (dense settings rows, `sm` buttons), the
 *   difference is made up with `hitSlop` rather than by inflating the design.
 */

import { forwardRef, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { StyleProp, TextInputProps, TextStyle, ViewProps, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Reanimated, {
  Easing,
  FadeOut,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';
import type { Palette, Theme } from '@/theme';

import { duration, REDUCED_MS, spring } from '@/constants/animations';
import { Glyph } from './Glyph';
import { Icon, iconSize } from './Icon';
import type { IconName } from './Icon';
import { useReducedMotion, usePressFeedback } from './motion';

/* -------------------------------------------------------------------------- */
/* Focus                                                                       */
/* -------------------------------------------------------------------------- */

/** Android's minimum touch target, in dp. */
export const MIN_TARGET = 48;

/**
 * How much of the screen the software keyboard is covering, in dp. `0` when closed.
 *
 * This has to exist because **an edge-to-edge Android window does not resize for
 * the keyboard.** `android.softwareKeyboardLayoutMode: 'resize'` sets
 * `adjustResize`, which only ever worked by shrinking the area inside the system
 * bars — and edge-to-edge (mandatory from Android 15, and on here since the first
 * build) is precisely the mode where the app draws *behind* those bars, so there
 * is nothing left for `adjustResize` to shrink. The keyboard opens over the
 * composer and the composer stays where it was.
 *
 * `keyboardDidShow` rather than `keyboardWillShow`: Android never emits the
 * `Will` events, so anything built on them is an iOS-only fix.
 *
 * The navigation bar is added back on Android because the platform's event
 * deliberately leaves it out: `ReactRootView` reports
 * `imeInsets.bottom - barInsets.bottom`, i.e. the keyboard height measured from
 * the *top of the navigation bar*, on the assumption that the window already
 * stops there. An edge-to-edge window does not — it runs to the bottom of the
 * screen — so lifting by the raw number lands a control one navigation bar short
 * of clear, which is the "it moves, but not far enough" symptom. iOS measures
 * from the bottom of the screen already and needs no correction.
 */
export function useKeyboardHeight(): number {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => setHeight(event.endCoordinates.height));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  if (height === 0) return 0;
  return Platform.OS === 'android' ? height + insets.bottom : height;
}

/**
 * The style a control wears while it holds focus.
 *
 * `outline*` rather than `border*` on purpose: RN 0.76+ implements the W3C outline
 * box, which is painted outside the layout box. A border would change the control's
 * size on focus and shove its neighbours sideways.
 */
export function focusRingStyle(t: Theme, focused: boolean): ViewStyle {
  if (!focused) return {};
  return {
    outlineStyle: 'solid',
    outlineColor: t.colors.focus,
    outlineWidth: 2,
    outlineOffset: 2,
  };
}

/**
 * Focus state for one control.
 *
 * Spread `handlers` onto the `Pressable`/`TextInput` and merge `ring` into its
 * style. Kept as a hook rather than a wrapper component so the primitives below
 * stay single elements — several of them are measured or positioned by callers.
 */
export function useFocusRing(): {
  focused: boolean;
  ring: ViewStyle;
  handlers: { onFocus: () => void; onBlur: () => void };
} {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  const ring = useMemo(() => focusRingStyle(t, focused), [focused, t]);
  return { focused, ring, handlers: { onFocus, onBlur } };
}

/**
 * Pad a target out to 48dp when its visual box is smaller.
 *
 * Returns `undefined` when no padding is needed, so it can be spread straight into
 * a `hitSlop` prop without a conditional at every call site.
 */
export function targetSlop(width: number, height: number): { top: number; bottom: number; left: number; right: number } | undefined {
  const vertical = Math.max(0, Math.ceil((MIN_TARGET - height) / 2));
  const horizontal = Math.max(0, Math.ceil((MIN_TARGET - width) / 2));
  if (vertical === 0 && horizontal === 0) return undefined;
  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}

/**
 * Vertical-only version of {@link targetSlop}.
 *
 * Used for controls that are already wide enough, or that sit next to a sibling
 * close enough that horizontal slop would steal its taps.
 */
export function verticalSlop(height: number): { top: number; bottom: number } | undefined {
  const vertical = Math.max(0, Math.ceil((MIN_TARGET - height) / 2));
  return vertical === 0 ? undefined : { top: vertical, bottom: vertical };
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function Screen({
  children,
  scroll = true,
  padded = true,
  style,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const base: ViewStyle = { flex: 1, backgroundColor: t.colors.bg };
  const pad: ViewStyle = padded
    ? { paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.md, paddingBottom: t.spacing.xxl }
    : {};

  if (!scroll) return <View style={[base, pad, style]}>{children}</View>;
  return (
    <ScrollView
      style={[base, style]}
      contentContainerStyle={[pad, contentStyle]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {children}
    </ScrollView>
  );
}

/** A titled group of rows. `note` is for the explanatory line under a group. */
export function Section({
  title,
  note,
  children,
  style,
}: {
  title?: string;
  note?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View style={[{ marginBottom: t.spacing.xl }, style]}>
      {title ? (
        <Text
          style={{
            color: t.colors.textFaint,
            fontSize: t.fontSize.xs,
            fontWeight: '600',
            letterSpacing: 0.9,
            textTransform: 'uppercase',
            marginBottom: t.spacing.sm,
          }}
        >
          {title}
        </Text>
      ) : null}
      <View
        style={{
          backgroundColor: t.colors.surface,
          borderRadius: t.radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
      {note ? (
        <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, marginTop: t.spacing.sm, lineHeight: 16 }}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** Bare vertical stack, for content that is not a settings group. */
export function Stack({ gap = 'md', children, style }: { gap?: keyof Theme['spacing']; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ gap: t.spacing[gap] }, style]}>{children}</View>;
}

export function Inline({
  gap = 'sm',
  wrap = true,
  align = 'center',
  children,
  style,
  accessibilityRole,
  accessibilityLabel,
}: {
  gap?: keyof Theme['spacing'];
  wrap?: boolean;
  align?: ViewStyle['alignItems'];
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * A row of chips is often a control, not just a layout — a tag filter is a
   * `radiogroup`. Forwarded so callers do not have to add a wrapper `View` whose
   * only job is to carry the role.
   */
  accessibilityRole?: ViewProps['accessibilityRole'];
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        { flexDirection: 'row', gap: t.spacing[gap], alignItems: align, flexWrap: wrap ? 'wrap' : 'nowrap' },
        style,
      ]}
      {...(accessibilityRole ? { accessibilityRole } : {})}
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
    >
      {children}
    </View>
  );
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.colors.border }} />;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                       */
/* -------------------------------------------------------------------------- */

type TextTone = 'normal' | 'dim' | 'faint' | 'accent' | 'danger' | 'warning' | 'success';

const TONE_COLOR: Record<TextTone, keyof Palette> = {
  normal: 'text',
  dim: 'textDim',
  faint: 'textFaint',
  accent: 'accent',
  danger: 'danger',
  warning: 'warning',
  success: 'success',
};

export function Body({
  children,
  tone = 'normal',
  size = 'md',
  weight,
  mono,
  numberOfLines,
  style,
  selectable,
  accessibilityLabel,
  live,
}: {
  children: ReactNode;
  tone?: TextTone;
  size?: keyof Theme['fontSize'];
  weight?: TextStyle['fontWeight'];
  mono?: boolean;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
  /**
   * Spoken text, when the rendered text is compressed for the eye.
   *
   * `2.4s to first byte` and `1.2k tok` are readable glances and poor sentences;
   * this is where the sentence goes.
   */
  accessibilityLabel?: string;
  /** Announce the content when it changes. For values that update in place. */
  live?: boolean;
}) {
  const t = useTheme();
  const base: TextStyle = {
    color: t.colors[TONE_COLOR[tone]],
    fontSize: t.fontSize[size],
    lineHeight: t.fontSize[size] * 1.45,
  };
  if (weight !== undefined) base.fontWeight = weight;
  if (mono) base.fontFamily = t.monoFont;
  return (
    <Text
      style={[base, style]}
      numberOfLines={numberOfLines}
      selectable={selectable}
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      {...(live ? { accessibilityLiveRegion: 'polite' as const } : {})}
    >
      {children}
    </Text>
  );
}

/**
 * A screen or section title.
 *
 * Serif, at a normal weight. In this design the serif is the identity cue — it marks
 * names and titles, while everything a user actually reads at length stays sans.
 */
export function Heading({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <Text
      style={[
        {
          color: t.colors.text,
          fontFamily: t.serifFont,
          fontSize: t.fontSize.xl,
          fontWeight: '400',
          letterSpacing: -0.3,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/**
 * An inline explanatory box.
 *
 * Used for the "this control is unavailable because…" messages the spec asks for,
 * and for gateway error text, which must be shown verbatim.
 */
export function Note({
  tone = 'info',
  children,
  mono,
  selectable = true,
  /** Announce the content when it appears or changes. For errors and status. */
  live,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
  mono?: boolean;
  selectable?: boolean;
  live?: boolean;
}) {
  const t = useTheme();
  const map = {
    info: { bg: t.colors.surfaceAlt, fg: t.colors.textDim, border: t.colors.border },
    warning: { bg: t.colors.warningSoft, fg: t.colors.warning, border: t.colors.warning },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger, border: t.colors.danger },
    success: { bg: t.colors.successSoft, fg: t.colors.success, border: t.colors.success },
  }[tone];

  const textStyle: TextStyle = { color: map.fg, fontSize: t.fontSize.sm, lineHeight: 19 };
  if (mono) {
    textStyle.fontFamily = t.monoFont;
    textStyle.fontSize = t.fontSize.code;
  }

  return (
    <View
      style={{
        backgroundColor: map.bg,
        borderLeftWidth: 3,
        borderLeftColor: map.border,
        borderRadius: t.radius.md,
        paddingVertical: t.spacing.sm + 2,
        paddingHorizontal: t.spacing.md,
      }}
    >
      <Text style={textStyle} selectable={selectable} {...(live ? { accessibilityLiveRegion: 'polite' as const } : {})}>
        {children}
      </Text>
    </View>
  );
}

export function Badge({
  label,
  tone = 'neutral',
  /**
   * What a screen reader should say instead of `label`.
   *
   * Badges are sometimes glyphs — `●` for "showing", `›` for "more" — and a glyph
   * read aloud is noise. Passing the words here keeps the dense visual and gives
   * TalkBack something to say.
   */
  srLabel,
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  srLabel?: string;
}) {
  const t = useTheme();
  // Hairline pills rather than filled chips: the list rows carry several of these at
  // once, and solid blocks of colour would out-shout the message text they annotate.
  // Semantic tones keep their soft fill, because there the colour *is* the message.
  const map = {
    neutral: { bg: 'transparent', fg: t.colors.textFaint, border: t.colors.border },
    accent: { bg: t.colors.accentSoft, fg: t.colors.accent, border: t.colors.accentSoft },
    success: { bg: t.colors.successSoft, fg: t.colors.success, border: t.colors.successSoft },
    warning: { bg: t.colors.warningSoft, fg: t.colors.warning, border: t.colors.warningSoft },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger, border: t.colors.dangerSoft },
  }[tone];
  return (
    <View
      style={{
        backgroundColor: map.bg,
        borderRadius: t.radius.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: map.border,
        paddingHorizontal: t.spacing.sm,
        paddingVertical: 2,
        alignSelf: 'flex-start',
      }}
    >
      <Text
        style={{ color: map.fg, fontSize: t.fontSize.xs, fontWeight: '600', letterSpacing: 0.3 }}
        {...(srLabel !== undefined ? { accessibilityLabel: srLabel } : {})}
      >
        {label}
      </Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'secondary',
  size = 'md',
  disabled,
  /** Shown instead of silently greying out. The spec requires the explanation. */
  disabledReason,
  busy,
  full,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const off = Boolean(disabled) || Boolean(busy);
  const { ring, handlers } = useFocusRing();
  // `haptic` is left on: `Button` is the generic action, and the few presses that carry
  // their own heavier feedback (a send, a delete) fire it from their own handler and
  // pass `haptic: false` where they use this hook directly.
  const { pressStyle, pressHandlers, onPressHaptic } = usePressFeedback({ disabled: off });

  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: t.colors.accent, fg: t.colors.accentText, border: t.colors.accent },
    secondary: { bg: t.colors.surface, fg: t.colors.text, border: t.colors.borderStrong },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger, border: t.colors.danger },
    ghost: { bg: 'transparent', fg: t.colors.accent, border: 'transparent' },
  };
  const c = palette[variant];
  const vPad = size === 'sm' ? t.spacing.xs + 2 : t.spacing.sm + 2;
  const hPad = size === 'sm' ? t.spacing.md : t.spacing.xl;
  // `md` reaches 48dp on its own. `sm` exists for dense toolbars, so it keeps the
  // smaller box and makes up the remainder in hitSlop. Vertical only: horizontal
  // slop would overlap the neighbouring button in an `Inline`.
  const minHeight = size === 'sm' ? 40 : MIN_TARGET;
  const slop = verticalSlop(minHeight);

  return (
    <View style={[full ? { alignSelf: 'stretch' } : { alignSelf: 'flex-start' }, style]}>
      {/* The transform sits on a view wrapping the pressable, not on the outer box:
          the `disabledReason` text below is a sibling of the button, and a press must
          not shrink the sentence explaining why the press did nothing. */}
      <Reanimated.View style={pressStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: off, busy: Boolean(busy) }}
          accessibilityHint={off ? disabledReason : undefined}
          disabled={off}
          onPress={() => {
            onPressHaptic();
            onPress();
          }}
          {...handlers}
          {...pressHandlers}
          {...(slop ? { hitSlop: slop } : {})}
          style={[
            {
              backgroundColor: c.bg,
              borderColor: c.border,
              borderWidth: variant === 'ghost' ? 0 : StyleSheet.hairlineWidth,
              // Pill, per the design language: actions are rounded, containers are not.
              borderRadius: t.radius.pill,
              paddingVertical: vPad,
              paddingHorizontal: hPad,
              minHeight,
              // 0.6, not 0.45: a disabled control still has to be readable, because
              // the label is how the user works out what they are missing.
              // The `pressed` dip is gone — `usePressFeedback` owns that now, and two
              // opacity sources on one control multiply into a much deeper dip than
              // either intended.
              opacity: off ? 0.6 : 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: t.spacing.sm,
            },
            ring,
          ]}
        >
          {busy ? <ActivityIndicator size="small" color={c.fg} /> : null}
          <Text style={{ color: c.fg, fontSize: t.fontSize.md, fontWeight: '600' }}>{label}</Text>
        </Pressable>
      </Reanimated.View>
      {off && disabledReason ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, marginTop: 4, maxWidth: 320 }}
        >
          {disabledReason}
        </Text>
      ) : null}
    </View>
  );
}

/** A settings row. Tappable when `onPress` is given, inert otherwise. */
export function Row({
  label,
  value,
  subtitle,
  icon,
  onPress,
  right,
  chevron,
  destructive,
  disabled,
  first,
  accessibilityLabel,
  accessibilityHint,
  selected,
  role = 'button',
  checked,
  expanded,
}: {
  label: string;
  value?: string;
  subtitle?: string;
  /**
   * Leading icon.
   *
   * Optional because a row is legible without one — the label is the row. It is
   * there for the grouped settings lists, where a column of icons is what lets
   * the eye find "Privacy" in a list of eleven without reading all eleven.
   */
  icon?: IconName;
  onPress?: () => void;
  right?: ReactNode;
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Suppresses the top divider for the first row in a Section. */
  first?: boolean;
  /**
   * Overrides the announced name when the visible `label` is not the whole story —
   * a row labelled "Status" whose meaning is in its `value`, for instance.
   */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Set on rows that act as a choice in a list, so the state is announced. */
  selected?: boolean;
  /**
   * Announced role, when "button" is wrong.
   *
   * `SwitchRow` makes the whole row the target, so the row *is* the switch; a row
   * that expands to reveal detail is a `summary`/`button` with `expanded` state.
   */
  role?: 'button' | 'switch' | 'checkbox' | 'radio';
  /** Checked state for `role: 'switch' | 'checkbox' | 'radio'`. */
  checked?: boolean;
  /** Expanded state for a row that reveals detail in place. */
  expanded?: boolean;
}) {
  const t = useTheme();
  const labelColor = destructive ? t.colors.danger : t.colors.text;
  const { ring, handlers } = useFocusRing();

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingHorizontal: t.spacing.md,
        paddingVertical: t.spacing.md,
        minHeight: MIN_TARGET,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {/* Fixed-width gutter rather than a bare icon: Feather glyphs are not all the
          same drawn width, and letting each one size its own slot leaves the labels
          in a column of rows unaligned by a pixel or two each. */}
      {icon ? (
        <View style={{ width: iconSize.lg, alignItems: 'center' }}>
          <Icon name={icon} tone={destructive ? 'danger' : 'textDim'} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: labelColor, fontSize: t.fontSize.md }}>{label}</Text>
        {subtitle ? (
          <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, lineHeight: 17 }}>{subtitle}</Text>
        ) : null}
      </View>
      {value ? (
        <Text
          numberOfLines={1}
          style={{ color: t.colors.textDim, fontSize: t.fontSize.sm, maxWidth: '48%', textAlign: 'right' }}
        >
          {value}
        </Text>
      ) : null}
      {right}
      {chevron ? <Icon name="chevron" tone="textFaint" /> : null}
    </View>
  );

  return (
    <View>
      {first ? null : <Divider />}
      {onPress && !disabled ? (
        <Pressable
          accessibilityRole={role}
          accessibilityLabel={accessibilityLabel ?? label}
          {...(accessibilityHint !== undefined ? { accessibilityHint } : {})}
          accessibilityState={{
            ...(selected !== undefined ? { selected } : {}),
            ...(checked !== undefined ? { checked } : {}),
            ...(expanded !== undefined ? { expanded } : {}),
          }}
          onPress={onPress}
          {...handlers}
          style={({ pressed }) => [
            { backgroundColor: pressed ? t.colors.surfaceActive : 'transparent' },
            ring,
          ]}
        >
          {content}
        </Pressable>
      ) : (
        content
      )}
    </View>
  );
}

export function SwitchRow({
  label,
  subtitle,
  icon,
  value,
  onChange,
  disabled,
  disabledReason,
  first,
}: {
  label: string;
  subtitle?: string;
  /** Leading icon. Same gutter as {@link Row}, so a mixed group stays one column. */
  icon?: IconName;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
  first?: boolean;
}) {
  const t = useTheme();
  const sub = disabled && disabledReason ? disabledReason : subtitle;
  return (
    <Row
      label={label}
      {...(sub !== undefined ? { subtitle: sub } : {})}
      {...(icon !== undefined ? { icon } : {})}
      first={first}
      disabled={disabled}
      // The whole row toggles. A bare Switch is ~50×30dp, which is under the 48dp
      // minimum on the axis that matters, and "tap the label" is what people try
      // first anyway.
      {...(disabled ? {} : { onPress: () => onChange(!value) })}
      role="switch"
      checked={value}
      accessibilityLabel={label}
      {...(sub !== undefined ? { accessibilityHint: sub } : {})}
      right={
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          // The row already announces the name and state, so the inner Switch is
          // hidden from the accessibility tree rather than duplicating it.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          trackColor={{ false: t.colors.surfaceActive, true: t.colors.accentSoft }}
          thumbColor={value ? t.colors.accent : t.colors.borderStrong}
        />
      }
    />
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Present ⇒ the segment is unavailable and this says why. */
  disabledReason?: string;
}

/** Segmented picker. Used for transport kind, theme mode, reasoning effort. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  label,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
  /** Announced as the group's name, so "Anthropic, selected" has a subject. */
  label?: string;
}) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const active = options.find((o) => o.value === value);
  const minHeight = size === 'sm' ? 40 : MIN_TARGET;
  const slop = verticalSlop(minHeight);

  /**
   * The selected segment's index, as a position rather than a state.
   *
   * The white pill used to be each segment's own `backgroundColor`, which meant the
   * selection teleported: one segment lost its fill and another gained it on the same
   * frame, and nothing on screen connected the two. Sliding one pill between them says
   * "this is the same selection, moved", which is the whole point of a segmented control
   * as opposed to a column of radio buttons.
   *
   * `-1` for a `value` that is not in `options` — a real case while a model list is still
   * loading — and the pill is simply not rendered rather than parked over segment zero
   * claiming a selection that does not exist.
   */
  const index = options.findIndex((o) => o.value === value);
  /** The track's inner width, i.e. minus its 2dp padding on each side. */
  const [trackWidth, setTrackWidth] = useState(0);
  const segmentWidth = options.length > 0 ? trackWidth / options.length : 0;

  const slide = useSharedValue(index);
  useEffect(() => {
    if (index < 0) return;
    // A spring, because the pill is a physical object being moved; Reduce Motion cuts it
    // to a single frame, since a pill that jumps is exactly the old behaviour and the
    // colour change alone still reports the selection.
    slide.value = reduced ? withTiming(index, { duration: REDUCED_MS }) : withSpring(index, spring.snappy);
  }, [index, reduced, slide]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: slide.value * segmentWidth }] }));

  return (
    <View style={{ gap: t.spacing.xs }}>
      <View
        accessibilityRole="radiogroup"
        {...(label !== undefined ? { accessibilityLabel: label } : {})}
        onLayout={(event) => {
          const next = event.nativeEvent.layout.width - 4;
          setTrackWidth((was) => (Math.abs(was - next) < 0.5 ? was : next));
        }}
        style={{
          flexDirection: 'row',
          backgroundColor: t.colors.surfaceAlt,
          borderRadius: t.radius.lg,
          padding: 2,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
        }}
      >
        {/* Behind the segments, and outside the accessibility tree: it is the *drawing*
            of a selection each segment already announces through `accessibilityState`. */}
        {index >= 0 && segmentWidth > 0 ? (
          <Reanimated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              {
                position: 'absolute',
                left: 2,
                top: 2,
                bottom: 2,
                width: segmentWidth,
                borderRadius: t.radius.md,
                backgroundColor: t.colors.surface,
              },
              pill,
            ]}
          />
        ) : null}
        {options.map((option) => (
          <Segment
            key={option.value}
            option={option}
            selected={option.value === value}
            size={size}
            minHeight={minHeight}
            {...(slop ? { slop } : {})}
            onPress={() => onChange(option.value)}
          />
        ))}
      </View>
      {active?.disabledReason ? (
        <Text accessibilityLiveRegion="polite" style={{ color: t.colors.warning, fontSize: t.fontSize.xs }}>
          {active.disabledReason}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One segment.
 *
 * Extracted so each segment can own its focus state — a hook cannot be called
 * inside the `options.map` callback.
 */
function Segment<T extends string>({
  option,
  selected,
  size,
  minHeight,
  slop,
  onPress,
}: {
  option: SegmentOption<T>;
  selected: boolean;
  size: 'sm' | 'md';
  minHeight: number;
  slop?: { top: number; bottom: number };
  onPress: () => void;
}) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const off = option.disabledReason !== undefined;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityState={{ selected, checked: selected, disabled: off }}
      accessibilityHint={option.disabledReason}
      disabled={off}
      onPress={onPress}
      {...handlers}
      {...(slop ? { hitSlop: slop } : {})}
      style={[
        {
          flex: 1,
          paddingVertical: size === 'sm' ? t.spacing.sm : t.spacing.md,
          minHeight,
          borderRadius: t.radius.md,
          // No fill: the sliding pill behind the row draws the selection now, and a
          // second opaque background here would hide it as it arrived.
          opacity: off ? 0.6 : 1,
          alignItems: 'center',
          justifyContent: 'center',
        },
        ring,
      ]}
    >
      <Text
        numberOfLines={1}
        style={{
          color: selected ? t.colors.text : t.colors.textDim,
          fontSize: size === 'sm' ? t.fontSize.xs : t.fontSize.sm,
          fontWeight: selected ? '600' : '500',
        }}
      >
        {option.label}
      </Text>
    </Pressable>
  );
}

export interface FieldProps extends Omit<TextInputProps, 'style' | 'onChangeText' | 'value'> {
  label?: string;
  value: string;
  onChangeText: (next: string) => void;
  hint?: string;
  error?: string;
  mono?: boolean;
  rows?: number;
  right?: ReactNode;
}

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, value, onChangeText, hint, error, mono, rows, right, onFocus, onBlur, ...rest },
  ref,
) {
  const t = useTheme();
  const { focused, ring, handlers } = useFocusRing();
  const multiline = (rows ?? 1) > 1;
  const inputStyle: TextStyle = {
    flex: 1,
    color: t.colors.text,
    fontSize: mono ? t.fontSize.code : t.fontSize.md,
    paddingVertical: t.spacing.sm,
    paddingHorizontal: t.spacing.md,
    minHeight: multiline ? (rows ?? 3) * 20 + 16 : MIN_TARGET,
    textAlignVertical: multiline ? 'top' : 'center',
  };
  if (mono) inputStyle.fontFamily = t.monoFont;

  // The label is a visual sibling of the input, which means it is not the input's
  // *name* — a screen reader lands on an unnamed edit box. There is no
  // `labelledby` in React Native, so the name is set explicitly, and the hint (or
  // the validation message, which matters more) becomes the accessibility hint.
  const describedBy = error ?? hint;

  return (
    <View style={{ gap: t.spacing.xs }}>
      {label ? (
        <Text style={{ color: t.colors.textDim, fontSize: t.fontSize.sm, fontWeight: '600' }}>{label}</Text>
      ) : null}
      <View
        style={[
          {
            flexDirection: 'row',
            alignItems: multiline ? 'flex-start' : 'center',
            backgroundColor: t.colors.surface,
            borderRadius: t.radius.lg,
            borderWidth: error || focused ? 1 : StyleSheet.hairlineWidth,
            borderColor: error ? t.colors.danger : focused ? t.colors.focus : t.colors.borderStrong,
          },
          ring,
        ]}
      >
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          multiline={multiline}
          placeholderTextColor={t.colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          {...(label !== undefined ? { accessibilityLabel: label } : {})}
          {...(describedBy !== undefined ? { accessibilityHint: describedBy } : {})}
          // React Native has no `invalid` accessibility state, so the failure is
          // carried by the hint (read on focus) and by the live-region message
          // below, which fires the moment validation changes.
          style={inputStyle}
          {...rest}
          onFocus={(event) => {
            handlers.onFocus();
            onFocus?.(event);
          }}
          onBlur={(event) => {
            handlers.onBlur();
            onBlur?.(event);
          }}
        />
        {right ? <View style={{ paddingRight: t.spacing.sm }}>{right}</View> : null}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: t.colors.danger, fontSize: t.fontSize.xs }}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, lineHeight: 17 }}>{hint}</Text>
      ) : null}
    </View>
  );
});

/** Numeric stepper. Cheaper than a slider for exact values like max_tokens. */
export function Stepper({
  label,
  value,
  onChange,
  step,
  min,
  max,
  disabled,
  disabledReason,
  format,
  first,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  step: number;
  min: number;
  max: number;
  disabled?: boolean;
  disabledReason?: string;
  format?: (value: number) => string;
  first?: boolean;
}) {
  const t = useTheme();
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  return (
    <Row
      label={label}
      first={first}
      disabled={disabled}
      {...(disabled && disabledReason ? { subtitle: disabledReason } : {})}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: t.colors.textDim, fontSize: t.fontSize.sm, minWidth: 62, textAlign: 'right' }}
          >
            {format ? format(value) : String(value)}
          </Text>
          <StepButton
            glyph="−"
            srLabel={`Decrease ${label}`}
            disabled={Boolean(disabled) || value <= min}
            onPress={() => onChange(clamp(value - step))}
          />
          <StepButton
            glyph="+"
            srLabel={`Increase ${label}`}
            disabled={Boolean(disabled) || value >= max}
            onPress={() => onChange(clamp(value + step))}
          />
        </View>
      }
    />
  );
}

/**
 * One end of a {@link Stepper}.
 *
 * `−` and `+` read as nothing useful aloud, so each carries the name of what it
 * changes. The box stays 40×36 to keep settings rows dense; hitSlop takes it past
 * 48dp on both axes.
 *
 * The glyph does not scale with the system font size, for the same reason `Icon` does
 * not: this is the one control in the file whose box is a fixed height rather than a
 * `minHeight`, so at Android's largest text setting a scaling `+` grows out of a box
 * that cannot grow with it. Everything else here is text and scales.
 */
function StepButton({
  glyph,
  srLabel,
  disabled,
  onPress,
}: {
  glyph: string;
  srLabel: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={srLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      {...handlers}
      style={({ pressed }) => [
        {
          width: 40,
          height: 36,
          borderRadius: t.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? t.colors.surfaceActive : t.colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.borderStrong,
          opacity: disabled ? 0.6 : 1,
        },
        ring,
      ]}
    >
      <Text allowFontScaling={false} style={{ color: t.colors.text, fontSize: t.fontSize.lg }}>
        {glyph}
      </Text>
    </Pressable>
  );
}

/**
 * Busy indicator.
 *
 * The app's mark rather than a platform spinner: the app's one long wait is a model
 * thinking, and the same turning mark stands for it everywhere — in a stream header,
 * on a settings screen doing a reachability probe, on the splash.
 */
export function Spinner({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
      <Glyph size={20} state="thinking" />
      {label ? <Text style={{ color: t.colors.textDim, fontSize: t.fontSize.sm }}>{label}</Text> : null}
    </View>
  );
}

/** Centred message for an empty list or a screen with nothing to show yet. */
export function Empty({ title, body, icon }: { title: string; body?: string; icon?: IconName }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.xxl }}>
      {/* A large, faint outline rather than an illustration. It is the same stroke
          weight as every other icon in the app, so an empty state stays part of the
          design instead of becoming a picture bolted into it — and `textFaint` keeps
          it quieter than the sentence that actually tells the user what to do. */}
      {icon ? (
        <Icon name={icon} size="xl" tone="textFaint" />
      ) : null}
      <Text
        style={{
          color: t.colors.text,
          fontFamily: t.serifFont,
          fontSize: t.fontSize.lg,
          fontWeight: '400',
        }}
      >
        {title}
      </Text>
      {body ? (
        <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.sm, textAlign: 'center', maxWidth: 300 }}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/** One pass of the highlight across a block, in ms. Slow: this is a wait, not a heartbeat. */
const SKELETON_MS = 1100;

/**
 * How long the block sits still between passes, in ms.
 *
 * A highlight that restarts the instant it leaves reads as a barber's pole — a
 * continuous band of movement with no beginning, which is both busier than the wait
 * deserves and impossible to look away from. The pause is what makes it a repeated
 * sweep rather than a loop.
 */
const SKELETON_GAP_MS = 450;

/** How far past each edge the highlight starts and ends, as a fraction of the width. */
const SWEEP_OVERSHOOT = 0.6;

/**
 * A placeholder block, sized like the content that is coming.
 *
 * Preferred over a spinner for anything with a known shape — a list of chat rows, a
 * settings group — because it says *what* is loading and holds the layout still, so
 * the arriving content does not shove the screen. A spinner is kept only for the
 * waits whose result has no shape yet: a reachability probe, a database search.
 *
 * ## The highlight, and why it is a gradient
 *
 * A travelling band of light across the block, which is what says "still working"
 * rather than "this is what the row looks like". It is a three-stop `LinearGradient`
 * translated across a clipped parent, and it has to be a gradient: a plain lighter
 * `View` sliding past has two hard edges, and a hard edge moving across a placeholder
 * looks like a rendering artefact rather than a sheen.
 *
 * Under Reduce Motion the sweep is dropped entirely and the block holds one flat
 * tone. Travel is exactly what the setting is about, and a skeleton is decoration
 * over a wait that the surrounding `accessibilityRole="progressbar"` already
 * announces — so there is nothing to preserve by shortening it.
 */
export function Skeleton({
  width = '100%',
  height = 14,
  radius: r,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const reduce = useReducedMotion();

  /** Measured, because the sweep travels in dp and `width` is usually a percentage. */
  const [measured, setMeasured] = useState(0);
  /** -1 → fully off the left, 1 → fully off the right. */
  const sweep = useSharedValue(-1);

  useEffect(() => {
    if (reduce || measured === 0) return;
    sweep.value = -1;
    sweep.value = withRepeat(
      // The delay is inside the repeated animation rather than between repeats, because
      // `withRepeat` has no notion of a rest — so the pause is the first thing each pass
      // does, holding the block still at the far edge before the next one begins.
      withDelay(SKELETON_GAP_MS, withTiming(1, { duration: SKELETON_MS, easing: Easing.inOut(Easing.quad) })),
      -1,
      false,
    );
    return () => cancelAnimation(sweep);
  }, [measured, reduce, sweep]);

  const shine = useAnimatedStyle(() => ({
    transform: [{ translateX: sweep.value * measured * (1 + SWEEP_OVERSHOOT) }],
  }));

  return (
    <View
      // Hidden from the accessibility tree entirely. There is nothing here to read,
      // and the list or screen around it carries the "Loading" announcement.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        // Guarded, or a percentage width that re-measures to the same number restarts
        // the sweep from the left edge on every layout pass.
        setMeasured((was) => (was === next ? was : next));
      }}
      style={[
        {
          width,
          height,
          borderRadius: r ?? t.radius.sm,
          backgroundColor: t.colors.surfaceAlt,
          // Both load-bearing: the clip is what turns a wide gradient into a band
          // passing a window, and without it the highlight is visible outside the block.
          overflow: 'hidden',
          opacity: reduce ? 0.7 : 0.85,
        },
        style,
      ]}
    >
      {reduce || measured === 0 ? null : (
        <Reanimated.View style={[StyleSheet.absoluteFill, shine]}>
          <LinearGradient
            // Horizontal, and transparent at both ends so the band has no edge of its
            // own — only the middle is lighter than the block it crosses.
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            colors={['transparent', t.colors.surfaceActive, 'transparent']}
            style={StyleSheet.absoluteFill}
          />
        </Reanimated.View>
      )}
    </View>
  );
}

/**
 * A run of two-line skeleton rows, at the metrics of a conversation row.
 *
 * The widths step down the list rather than all matching, because a column of
 * identical bars reads as a broken image; uneven ones read as text.
 *
 * Fades out on the way off, which is the other half of the sweep: the placeholder and
 * the content it stood in for occupy the same space, so an instant swap is a flicker
 * at exactly the moment the user's eye is already there. `exiting` lives here rather
 * than at each call site because there is no case where a skeleton should vanish —
 * every one of them is being replaced by the thing it was shaped like.
 */
export function SkeletonRows({ count = 5, label = 'Loading' }: { count?: number; label?: string }) {
  const t = useTheme();
  const widths: readonly `${number}%`[] = ['78%', '64%', '85%', '55%', '72%'];
  return (
    <Reanimated.View
      exiting={FadeOut.duration(duration.exit).reduceMotion(ReduceMotion.System)}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{ gap: t.spacing.lg }}
    >
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ gap: t.spacing.sm }}>
          <Skeleton width={widths[i % widths.length]} height={15} />
          <Skeleton width="42%" height={11} />
        </View>
      ))}
    </Reanimated.View>
  );
}
