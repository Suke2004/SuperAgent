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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';
import type { Palette, Theme } from '@/theme';

import { Glyph } from './Glyph';

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
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: off, busy: Boolean(busy) }}
        accessibilityHint={off ? disabledReason : undefined}
        disabled={off}
        onPress={onPress}
        {...handlers}
        {...(slop ? { hitSlop: slop } : {})}
        style={({ pressed }) => [
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
            opacity: off ? 0.6 : pressed ? 0.75 : 1,
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
      {chevron ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: t.colors.textFaint, fontSize: t.fontSize.lg }}
        >
          ›
        </Text>
      ) : null}
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
  value,
  onChange,
  disabled,
  disabledReason,
  first,
}: {
  label: string;
  subtitle?: string;
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
  const active = options.find((o) => o.value === value);
  const minHeight = size === 'sm' ? 40 : MIN_TARGET;
  const slop = verticalSlop(minHeight);

  return (
    <View style={{ gap: t.spacing.xs }}>
      <View
        accessibilityRole="radiogroup"
        {...(label !== undefined ? { accessibilityLabel: label } : {})}
        style={{
          flexDirection: 'row',
          backgroundColor: t.colors.surfaceAlt,
          borderRadius: t.radius.lg,
          padding: 2,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
        }}
      >
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
          backgroundColor: selected ? t.colors.surface : 'transparent',
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
      <Text style={{ color: t.colors.text, fontSize: t.fontSize.lg }}>{glyph}</Text>
    </Pressable>
  );
}

/**
 * Busy indicator.
 *
 * The Jarvis mark rather than a platform spinner: the app's one long wait is a model
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
export function Empty({ title, body }: { title: string; body?: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.xxl }}>
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
