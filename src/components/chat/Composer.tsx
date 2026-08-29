/**
 * The composer.
 *
 * Three things share this bar, and the second is the one that earns its place:
 *
 * 1. The input, which grows with its content up to a clamp and then scrolls.
 * 2. The context-pressure gauge. It is measured against *usable* space —
 *    `window - maxTokens` — because the failure a user actually hits is not "request
 *    too large", which the gateway rejects clearly, but a reply that stops after
 *    three words because the prompt left no room for it. A gauge against the raw
 *    window would read 60% at the exact moment replies start getting truncated.
 * 3. Send, which becomes Stop while a turn is running. One button, because there is
 *    never a moment when both actions are available, and two would mean aiming.
 *
 * The input and its controls live inside one rounded box: the readout, the model chip
 * and the send disc sit on a row beneath the text, so the whole thing reads as a sheet
 * being written on rather than a text field with a toolbar bolted to it.
 *
 * When sending is impossible the button says why rather than greying out silently —
 * a missing API key and an invalid sampling parameter are both fixable, and neither
 * is guessable from a dimmed button.
 */

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Body, Button, Note, targetSlop, useFocusRing } from '@/components/ui';
import { contextPressure, estimateTextTokens, formatTokens } from '@/lib/tokens';
import type { PressureLevel } from '@/lib/tokens';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme';
import type { Palette } from '@/theme';

/** Roughly six lines at body size; past that the transcript disappears. */
const MAX_INPUT_HEIGHT = 140;

/** The circular send button. Smaller than 48dp by design; hitSlop makes it up. */
const SEND_SIZE = 36;

const LEVEL_COLOR: Record<PressureLevel, keyof Palette> = {
  ok: 'accentFill',
  warn: 'warning',
  critical: 'danger',
  over: 'danger',
};

function pressureNote(level: PressureLevel, remaining: number, strategy: string): string | null {
  switch (level) {
    case 'ok':
      return null;
    case 'warn':
      return `${formatTokens(remaining)} of usable context left.`;
    case 'critical':
      return `Only ${formatTokens(remaining)} of usable context left — replies will start getting cut short.`;
    case 'over':
      return strategy === 'drop_oldest'
        ? 'Over the usable window. The oldest messages will be dropped from this request.'
        : strategy === 'summarise'
          ? 'Over the usable window. Older messages will be summarised before sending.'
          : 'Over the usable window. Trim the conversation, exclude some messages, or lower max tokens.';
    default:
      return null;
  }
}

/** A hairline gauge rather than a progress bar: it is a reading, not a task. */
function Gauge({ ratio, level }: { ratio: number; level: PressureLevel }) {
  const t = useTheme();
  return (
    <View
      style={{
        height: 3,
        borderRadius: 2,
        backgroundColor: t.colors.surfaceAlt,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${Math.min(100, Math.max(0, ratio * 100))}%`,
          height: '100%',
          backgroundColor: t.colors[LEVEL_COLOR[level]],
        }}
      />
    </View>
  );
}

/**
 * Send.
 *
 * A clay disc rather than a labelled button: it is the one action in the app that
 * needs no explanation, and giving it the accent puts the only saturated colour on
 * the screen exactly where the user's thumb goes. When it *is* unavailable the reason
 * is spelled out above the box, not hidden in a dimmed label.
 */
function SendButton({ onPress, disabled, reason }: { onPress: () => void; disabled: boolean; reason?: string }) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const slop = targetSlop(SEND_SIZE, SEND_SIZE);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Send"
      accessibilityState={{ disabled }}
      {...(disabled && reason !== undefined ? { accessibilityHint: reason } : {})}
      disabled={disabled}
      onPress={onPress}
      {...handlers}
      {...(slop ? { hitSlop: slop } : {})}
      style={({ pressed }) => [
        {
          width: SEND_SIZE,
          height: SEND_SIZE,
          borderRadius: SEND_SIZE / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.colors.accent,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        ring,
      ]}
    >
      <Text style={{ color: t.colors.accentText, fontSize: t.fontSize.md, fontWeight: '700' }}>↑</Text>
    </Pressable>
  );
}

/** The model in play, as a chip on the composer's bottom row. */
function ModelChip({ model, onPress }: { model: string; onPress?: () => void }) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const body = (
    <Text numberOfLines={1} style={{ color: t.colors.textDim, fontSize: t.fontSize.xs, maxWidth: 150 }}>
      {onPress ? `${model} ⌄` : model}
    </Text>
  );
  const box = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.border,
    borderRadius: t.radius.pill,
    paddingHorizontal: t.spacing.sm + 2,
    paddingVertical: 4,
  };
  if (!onPress) return <View style={box}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Model: ${model}`}
      accessibilityHint="Change the model for this conversation"
      onPress={onPress}
      {...handlers}
      hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
      style={({ pressed }) => [box, { backgroundColor: pressed ? t.colors.surfaceActive : 'transparent' }, ring]}
    >
      {body}
    </Pressable>
  );
}

export function Composer({
  value,
  onChangeText,
  onSend,
  onStop,
  streaming,
  aborting = false,
  disabledReason,
  baseTokens,
  window: contextWindow,
  reserved,
  calibration,
  model,
  onPressModel,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  aborting?: boolean;
  /** Why sending is impossible right now, in the user's terms. */
  disabledReason?: string;
  /** Tokens the conversation already costs, without the draft. */
  baseTokens: number;
  window: number;
  /** Room held back for the reply — `max_tokens` for this conversation. */
  reserved: number;
  /**
   * Correction learned from this model's own reported prompt counts, and how many
   * turns it is based on. `1` and `0` mean nothing has been measured yet.
   */
  calibration?: { factor: number; samples: number };
  /** Shown on the bottom row, so the model in play is visible while typing. */
  model?: string;
  /** Present ⇒ the model chip opens the picker. */
  onPressModel?: () => void;
}) {
  const t = useTheme();
  const liveCount = useSettings((s) => s.liveTokenCount);
  const warnAt = useSettings((s) => s.contextWarnAt);
  const strategy = useSettings((s) => s.contextStrategy);
  const sendOnEnter = useSettings((s) => s.sendOnEnter);

  const factor = calibration?.factor ?? 1;

  const draftTokens = useMemo(
    () => (liveCount && value ? Math.round(estimateTextTokens(value) * factor) : 0),
    [liveCount, value, factor],
  );

  const pressure = useMemo(
    () => contextPressure(Math.round(baseTokens * factor) + draftTokens, contextWindow, reserved, warnAt),
    [baseTokens, factor, draftTokens, contextWindow, reserved, warnAt],
  );

  const empty = value.trim().length === 0;
  const blocked = disabledReason !== undefined;
  const note = pressureNote(pressure.level, pressure.remaining, strategy);

  return (
    <View
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: t.colors.border,
        backgroundColor: t.colors.bg,
        paddingHorizontal: t.spacing.md,
        paddingTop: t.spacing.sm,
        paddingBottom: t.spacing.md,
        gap: t.spacing.xs,
      }}
    >
      {liveCount ? <Gauge ratio={pressure.ratio} level={pressure.level} /> : null}

      {/* Full width rather than under the button: the reason is a sentence, and a
          sentence wrapped into a 90pt column beside the input is unreadable. */}
      {blocked ? <Note tone="danger">{disabledReason}</Note> : null}

      {/* One rounded box holds the input and its controls, so the composer reads as a
          single object the user is writing inside rather than a toolbar. */}
      <View
        style={{
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.borderStrong,
          borderRadius: t.radius.xl,
          backgroundColor: t.colors.surface,
          paddingHorizontal: t.spacing.md,
          paddingTop: t.spacing.sm + 2,
          paddingBottom: t.spacing.sm,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Reply to Jarvis…"
          placeholderTextColor={t.colors.textFaint}
          multiline
          // `submit` makes Enter send; `newline` keeps it as a line break. Without
          // an explicit value a multiline input on Android does neither reliably.
          submitBehavior={sendOnEnter ? 'submit' : 'newline'}
          onSubmitEditing={sendOnEnter && !empty && !streaming && !blocked ? onSend : undefined}
          returnKeyType={sendOnEnter ? 'send' : 'default'}
          accessibilityLabel="Message"
          style={{
            maxHeight: MAX_INPUT_HEIGHT,
            // The input is the whole box's interior, so it carries no chrome of its
            // own; the 24dp floor keeps an empty composer from collapsing.
            minHeight: 24,
            color: t.colors.text,
            fontSize: t.fontSize.md,
            padding: 0,
            textAlignVertical: 'top',
          }}
        />

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.spacing.sm,
            marginTop: t.spacing.sm,
            minHeight: SEND_SIZE,
          }}
        >
          {model !== undefined ? <ModelChip model={model} {...(onPressModel ? { onPress: onPressModel } : {})} /> : null}

          {liveCount ? (
            <Body
              size="xs"
              tone="faint"
              mono
              // The `~` is doing real work: this is an estimate, and the gauge above is
              // only as good as it. Once the model's own reported counts have corrected
              // it, say so — an uncalibrated 70% and a calibrated 70% deserve different
              // amounts of trust, and the user is the one who has to decide how much.
              accessibilityLabel={
                calibration && calibration.samples > 0
                  ? `About ${formatTokens(pressure.used)} of ${formatTokens(pressure.window)} usable context, calibrated against ${calibration.samples} reported ${calibration.samples === 1 ? 'turn' : 'turns'}`
                  : `About ${formatTokens(pressure.used)} of ${formatTokens(pressure.window)} usable context, estimated`
              }
            >
              {`~${formatTokens(pressure.used)} / ${formatTokens(pressure.window)}`}
            </Body>
          ) : null}
          {liveCount && calibration && calibration.samples > 0 ? (
            <Body size="xs" tone="faint">
              {`×${calibration.factor.toFixed(2)}`}
            </Body>
          ) : null}
          {liveCount && draftTokens > 0 ? (
            <Body size="xs" tone="faint" mono>
              {`+${formatTokens(draftTokens)}`}
            </Body>
          ) : null}

          <View style={{ flex: 1 }} />

          {streaming ? (
            <Button
              label={aborting ? 'Stopping…' : 'Stop'}
              onPress={onStop}
              variant="danger"
              size="sm"
              disabled={aborting}
              {...(aborting ? { disabledReason: 'Waiting for the connection to close.' } : {})}
            />
          ) : (
            <SendButton
              onPress={onSend}
              disabled={empty || blocked}
              {...(blocked ? { reason: disabledReason } : empty ? { reason: 'Write a message first.' } : {})}
            />
          )}
        </View>
      </View>

      {/* The pressure sentence sits under the box: it is prose, and prose on the
          control row would push the token readout out of the line. */}
      {liveCount && note ? (
        <Body size="xs" tone={pressure.level === 'warn' ? 'warning' : 'danger'}>
          {note}
        </Body>
      ) : null}
    </View>
  );
}
