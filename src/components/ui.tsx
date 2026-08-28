/**
 * Shared UI primitives.
 *
 * The app is a control panel more than it is a chat app, so these lean towards
 * dense, labelled, settings-style layouts: rows with values, fields with hints,
 * and controls that can explain *why* they are disabled rather than just going grey.
 * That last part is a hard requirement from the spec, so `disabledReason` is a
 * first-class prop on the controls rather than something each screen invents.
 */

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { StyleProp, TextInputProps, TextStyle, ViewStyle } from 'react-native';

import { useTheme } from '@/theme';
import type { Palette, Theme } from '@/theme';

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
            color: t.colors.textDim,
            fontSize: t.fontSize.xs,
            fontWeight: '700',
            letterSpacing: 0.8,
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
          borderRadius: t.radius.md,
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
}: {
  gap?: keyof Theme['spacing'];
  wrap?: boolean;
  align?: ViewStyle['alignItems'];
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        { flexDirection: 'row', gap: t.spacing[gap], alignItems: align, flexWrap: wrap ? 'wrap' : 'nowrap' },
        style,
      ]}
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
}: {
  children: ReactNode;
  tone?: TextTone;
  size?: keyof Theme['fontSize'];
  weight?: TextStyle['fontWeight'];
  mono?: boolean;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
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
    <Text style={[base, style]} numberOfLines={numberOfLines} selectable={selectable}>
      {children}
    </Text>
  );
}

export function Heading({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <Text style={[{ color: t.colors.text, fontSize: t.fontSize.xl, fontWeight: '700' }, style]}>{children}</Text>
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
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
  mono?: boolean;
  selectable?: boolean;
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
        borderRadius: t.radius.sm,
        paddingVertical: t.spacing.sm,
        paddingHorizontal: t.spacing.md,
      }}
    >
      <Text style={textStyle} selectable={selectable}>
        {children}
      </Text>
    </View>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}) {
  const t = useTheme();
  const map = {
    neutral: { bg: t.colors.surfaceAlt, fg: t.colors.textDim },
    accent: { bg: t.colors.accentSoft, fg: t.colors.accent },
    success: { bg: t.colors.successSoft, fg: t.colors.success },
    warning: { bg: t.colors.warningSoft, fg: t.colors.warning },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger },
  }[tone];
  return (
    <View
      style={{
        backgroundColor: map.bg,
        borderRadius: t.radius.sm,
        paddingHorizontal: 6,
        paddingVertical: 2,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ color: map.fg, fontSize: t.fontSize.xs, fontWeight: '700' }}>{label}</Text>
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

  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: t.colors.accent, fg: t.colors.accentText, border: t.colors.accent },
    secondary: { bg: t.colors.surfaceAlt, fg: t.colors.text, border: t.colors.border },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger, border: t.colors.danger },
    ghost: { bg: 'transparent', fg: t.colors.accent, border: 'transparent' },
  };
  const c = palette[variant];
  const vPad = size === 'sm' ? t.spacing.xs + 2 : t.spacing.sm + 2;
  const hPad = size === 'sm' ? t.spacing.md : t.spacing.lg;

  return (
    <View style={[full ? { alignSelf: 'stretch' } : { alignSelf: 'flex-start' }, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: off, busy: Boolean(busy) }}
        accessibilityHint={off ? disabledReason : undefined}
        disabled={off}
        onPress={onPress}
        style={({ pressed }) => ({
          backgroundColor: c.bg,
          borderColor: c.border,
          borderWidth: variant === 'ghost' ? 0 : StyleSheet.hairlineWidth,
          borderRadius: t.radius.md,
          paddingVertical: vPad,
          paddingHorizontal: hPad,
          opacity: off ? 0.45 : pressed ? 0.75 : 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: t.spacing.sm,
        })}
      >
        {busy ? <ActivityIndicator size="small" color={c.fg} /> : null}
        <Text style={{ color: c.fg, fontSize: t.fontSize.md, fontWeight: '600' }}>{label}</Text>
      </Pressable>
      {off && disabledReason ? (
        <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, marginTop: 4, maxWidth: 320 }}>
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
}) {
  const t = useTheme();
  const labelColor = destructive ? t.colors.danger : t.colors.text;

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingHorizontal: t.spacing.md,
        paddingVertical: t.spacing.md,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: labelColor, fontSize: t.fontSize.md }}>{label}</Text>
        {subtitle ? (
          <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, lineHeight: 16 }}>{subtitle}</Text>
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
      {chevron ? <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.lg }}>›</Text> : null}
    </View>
  );

  return (
    <View>
      {first ? null : <Divider />}
      {onPress && !disabled ? (
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          style={({ pressed }) => ({ backgroundColor: pressed ? t.colors.surfaceActive : 'transparent' })}
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
      right={
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
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
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
}) {
  const t = useTheme();
  const active = options.find((o) => o.value === value);
  const vPad = size === 'sm' ? 4 : t.spacing.sm;

  return (
    <View style={{ gap: t.spacing.xs }}>
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: t.colors.surfaceAlt,
          borderRadius: t.radius.md,
          padding: 2,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
        }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          const off = option.disabledReason !== undefined;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: off }}
              accessibilityHint={option.disabledReason}
              disabled={off}
              onPress={() => onChange(option.value)}
              style={{
                flex: 1,
                paddingVertical: vPad,
                borderRadius: t.radius.sm,
                backgroundColor: selected ? t.colors.bg : 'transparent',
                opacity: off ? 0.4 : 1,
                alignItems: 'center',
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: selected ? t.colors.text : t.colors.textDim,
                  fontSize: size === 'sm' ? t.fontSize.xs : t.fontSize.sm,
                  fontWeight: selected ? '700' : '500',
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {active?.disabledReason ? (
        <Text style={{ color: t.colors.warning, fontSize: t.fontSize.xs }}>{active.disabledReason}</Text>
      ) : null}
    </View>
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
  { label, value, onChangeText, hint, error, mono, rows, right, ...rest },
  ref,
) {
  const t = useTheme();
  const multiline = (rows ?? 1) > 1;
  const inputStyle: TextStyle = {
    flex: 1,
    color: t.colors.text,
    fontSize: mono ? t.fontSize.code : t.fontSize.md,
    paddingVertical: t.spacing.sm,
    paddingHorizontal: t.spacing.md,
    minHeight: multiline ? (rows ?? 3) * 20 + 16 : 42,
    textAlignVertical: multiline ? 'top' : 'center',
  };
  if (mono) inputStyle.fontFamily = t.monoFont;

  return (
    <View style={{ gap: t.spacing.xs }}>
      {label ? (
        <Text style={{ color: t.colors.textDim, fontSize: t.fontSize.sm, fontWeight: '600' }}>{label}</Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          backgroundColor: t.colors.surfaceAlt,
          borderRadius: t.radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: error ? t.colors.danger : t.colors.border,
        }}
      >
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          multiline={multiline}
          placeholderTextColor={t.colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={inputStyle}
          {...rest}
        />
        {right ? <View style={{ paddingRight: t.spacing.sm }}>{right}</View> : null}
      </View>
      {error ? (
        <Text style={{ color: t.colors.danger, fontSize: t.fontSize.xs }}>{error}</Text>
      ) : hint ? (
        <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, lineHeight: 16 }}>{hint}</Text>
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
  const btn = (text: string, next: number, off: boolean) => (
    <Pressable
      accessibilityRole="button"
      disabled={off}
      onPress={() => onChange(clamp(next))}
      style={({ pressed }) => ({
        width: 36,
        height: 32,
        borderRadius: t.radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? t.colors.surfaceActive : t.colors.surfaceAlt,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.border,
        opacity: off ? 0.35 : 1,
      })}
    >
      <Text style={{ color: t.colors.text, fontSize: t.fontSize.lg }}>{text}</Text>
    </Pressable>
  );

  return (
    <Row
      label={label}
      first={first}
      disabled={disabled}
      {...(disabled && disabledReason ? { subtitle: disabledReason } : {})}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
          <Text
            style={{ color: t.colors.textDim, fontSize: t.fontSize.sm, minWidth: 62, textAlign: 'right' }}
          >
            {format ? format(value) : String(value)}
          </Text>
          {btn('−', value - step, Boolean(disabled) || value <= min)}
          {btn('+', value + step, Boolean(disabled) || value >= max)}
        </View>
      }
    />
  );
}

export function Spinner({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
      <ActivityIndicator size="small" color={t.colors.accent} />
      {label ? <Text style={{ color: t.colors.textDim, fontSize: t.fontSize.sm }}>{label}</Text> : null}
    </View>
  );
}

/** Centred message for an empty list or a screen with nothing to show yet. */
export function Empty({ title, body }: { title: string; body?: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.xxl }}>
      <Text style={{ color: t.colors.textDim, fontSize: t.fontSize.md, fontWeight: '600' }}>{title}</Text>
      {body ? (
        <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.sm, textAlign: 'center', maxWidth: 300 }}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}
