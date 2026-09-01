/**
 * The composer.
 *
 * Five things share this bar, and the second is the one that earns its place:
 *
 * 1. The input, which grows with its content up to a clamp and then scrolls.
 * 2. The context-pressure gauge. It is measured against *usable* space —
 *    `window - maxTokens` — because the failure a user actually hits is not "request
 *    too large", which the gateway rejects clearly, but a reply that stops after
 *    three words because the prompt left no room for it. A gauge against the raw
 *    window would read 60% at the exact moment replies start getting truncated.
 * 3. Send, which becomes Stop while a turn is running. One button, because there is
 *    never a moment when both actions are available, and two would mean aiming.
 * 4. The attachment strip, above the input, showing what will go with the message.
 *    Every staged item is removable in one tap and the strip states the whole set's
 *    size and token cost, because an image is the one thing a user attaches without
 *    any sense of what it costs — and it is ~2,500 tokens each, every turn from here
 *    on, not just this one.
 * 5. The mic, which dictates into the draft rather than sending. See `@/lib/dictation`
 *    for why that is not a voice mode.
 *
 * The input and its controls live inside one rounded box: the readout, the model chip
 * and the send disc sit on a row beneath the text, so the whole thing reads as a sheet
 * being written on rather than a text field with a toolbar bolted to it.
 *
 * When sending is impossible the button says why rather than greying out silently —
 * a missing API key and an invalid sampling parameter are both fixable, and neither
 * is guessable from a dimmed button.
 */

import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Reanimated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { attachmentTokens, describeAttachments } from '@/chat/attachments';
import { APP_NAME } from '@/lib/app';
import { useDictation } from '@/lib/dictation';
import * as haptics from '@/lib/haptics';
import { Icon } from '@/components/Icon';
import { useBreath, usePressFeedback, useTransition } from '@/components/motion';
import { Body, Button, Note, targetSlop, useFocusRing } from '@/components/ui';
import { contextPressure, estimateTextTokens, formatTokens } from '@/lib/tokens';
import type { ContextPressure, PressureLevel } from '@/lib/tokens';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme';
import type { Palette } from '@/theme';
import type { ContentBlock } from '@/transports/types';

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
 *
 * ## The fill follows the draft
 *
 * Empty draft ⇒ a grey disc with a faint mark; the first character ⇒ it fills with clay
 * over {@link duration.quick}. This is the composer's whole tactile story: the button
 * *becomes* available rather than being permanently lit and rejecting you. It also means
 * the accent appears on screen exactly when there is something to send, so the eye is
 * pulled to the send target at the moment it matters and not before.
 *
 * The disc deliberately stays mounted and stays a target when empty. Hiding it, or
 * swapping it for the mic the way some chat apps do, would take the `disabledReason`
 * with it — and "why can I not send this?" is a question this app answers in words.
 *
 * Two icons are stacked and crossfaded rather than one icon changing colour, because
 * `color` on a font glyph is a prop and props do not interpolate. Both are the same
 * glyph at the same size, so the crossfade reads as a single mark changing tone.
 */
function SendButton({ onPress, disabled, reason }: { onPress: () => void; disabled: boolean; reason?: string }) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  // `haptic: false` — the send's own `confirm()` fires from the screen's send handler.
  // Two buzzes 40ms apart is not twice the feedback, it is one mushy buzz.
  const { pressStyle, pressHandlers } = usePressFeedback({ disabled, haptic: false });
  const slop = targetSlop(SEND_SIZE, SEND_SIZE);

  const live = useTransition(!disabled);

  const fill = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(live.value, [0, 1], [t.colors.surfaceActive, t.colors.accent]),
  }));
  const liveIcon = useAnimatedStyle(() => ({ opacity: live.value }));
  const idleIcon = useAnimatedStyle(() => ({ opacity: 1 - live.value }));

  return (
    <Reanimated.View
      style={[
        {
          width: SEND_SIZE,
          height: SEND_SIZE,
          borderRadius: SEND_SIZE / 2,
        },
        fill,
        pressStyle,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        accessibilityState={{ disabled }}
        {...(disabled && reason !== undefined ? { accessibilityHint: reason } : {})}
        disabled={disabled}
        onPress={onPress}
        {...handlers}
        {...pressHandlers}
        {...(slop ? { hitSlop: slop } : {})}
        style={[
          {
            flex: 1,
            borderRadius: SEND_SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
          },
          ring,
        ]}
      >
        {/* Fixed metrics: the disc is a fixed 36dp, so a mark that grows with the
            system font scale clips against it or slides off centre. The label the
            screen reader announces is on the Pressable and scales as text should. */}
        <Reanimated.View style={liveIcon}>
          <Icon name="send" size="lg" color={t.colors.accentText} />
        </Reanimated.View>
        <Reanimated.View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }, idleIcon]}>
          <Icon name="send" size="lg" color={t.colors.textFaint} />
        </Reanimated.View>
      </Pressable>
    </Reanimated.View>
  );
}

/** Square thumbnail size for a staged attachment. */
const THUMB_SIZE = 64;

/**
 * One shared empty array for the un-attached case.
 *
 * A fresh `[]` per render would be a new dependency identity every time, which
 * re-runs the token memo below on every keystroke — the one memo in this file that
 * has to stay cheap.
 */
const EMPTY_ATTACHMENTS: readonly ContentBlock[] = [];

/** What a staged block should be called in a label, without reading its bytes. */
function describeBlock(block: ContentBlock, index: number): string {
  if (block.type === 'image') return `image ${index + 1}`;
  if (block.type === 'document') return block.name ?? `document ${index + 1}`;
  return `attachment ${index + 1}`;
}

/**
 * One staged attachment, with its own remove control.
 *
 * The remove target is the badge, not the whole tile: tapping the tile itself does
 * nothing on purpose, because the two plausible meanings of that tap — "look at
 * this" and "get rid of this" — are not both undoable, and a photo removed by a
 * mis-aimed thumb has to be picked, resized and re-encoded again.
 */
function AttachmentChip({
  block,
  onRemove,
  label,
}: {
  block: ContentBlock;
  onRemove: () => void;
  label: string;
}) {
  const t = useTheme();
  const { pressStyle, pressHandlers } = usePressFeedback({ haptic: false });
  const tile = {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: t.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surfaceAlt,
    overflow: 'hidden' as const,
  };

  return (
    <View style={{ width: THUMB_SIZE }}>
      <View style={tile}>
        {block.type === 'image' ? (
          <Image
            source={{ uri: `data:${block.mediaType};base64,${block.data}` }}
            accessibilityIgnoresInvertColors
            accessibilityLabel={label}
            resizeMode="cover"
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 4 }}>
            <Body size="xs" tone="dim" numberOfLines={3} style={{ textAlign: 'center' }}>
              {block.type === 'document' ? (block.name ?? 'Document') : 'Attachment'}
            </Body>
          </View>
        )}
      </View>

      {/* The badge is absolutely positioned, so the animated wrapper has to carry the
          position and the badge itself fill it: a transform on a statically-positioned
          child of a `width: THUMB_SIZE` box would scale it about the wrong origin and
          drag it back inside the tile. */}
      <Reanimated.View style={[{ position: 'absolute', top: -6, right: -6 }, pressStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          onPress={() => {
            // `warn`, not `tap`: removing a staged attachment is the one press in the
            // composer that destroys something, and the photo is gone from the strip
            // with no undo.
            haptics.warn();
            onRemove();
          }}
          hitSlop={12}
          {...pressHandlers}
          style={({ pressed }) => ({
            width: 22,
            height: 22,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? t.colors.danger : t.colors.surfaceActive,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.colors.borderStrong,
          })}
        >
          <Icon name="close" size={12} tone="text" />
        </Pressable>
      </Reanimated.View>
    </View>
  );
}

/** The paperclip. Its own disc so the reason it is unavailable has somewhere to go. */
function AttachButton({ onPress, disabled, reason }: { onPress: () => void; disabled: boolean; reason?: string }) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const { pressStyle, pressHandlers, onPressHaptic } = usePressFeedback({ disabled });
  const slop = targetSlop(SEND_SIZE, SEND_SIZE);
  return (
    <Reanimated.View style={pressStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Attach"
        accessibilityState={{ disabled }}
        {...(disabled && reason !== undefined ? { accessibilityHint: reason } : {})}
        disabled={disabled}
        onPress={() => {
          onPressHaptic();
          onPress();
        }}
        {...handlers}
        {...pressHandlers}
        {...(slop ? { hitSlop: slop } : {})}
        style={({ pressed }) => [
          {
            width: SEND_SIZE,
            height: SEND_SIZE,
            borderRadius: SEND_SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.colors.border,
            backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
            opacity: disabled ? 0.45 : 1,
          },
          ring,
        ]}
      >
        <Icon name="attach" size="lg" tone="textDim" />
      </Pressable>
    </Reanimated.View>
  );
}

/**
 * The mic. Same disc as Attach, and a filled one while it is listening — a mic that
 * looks identical whether or not it is recording is the one control on a phone where
 * the user needs to be certain.
 *
 * While it listens the disc breathes: a slow opacity pulse on the danger fill, which is
 * the one place in the app where a *continuous* animation is the correct answer. A
 * static red ring cannot distinguish "armed" from "frozen", and a dictation session that
 * has silently died looks exactly like one that is working.
 */
function MicButton({ listening, onPress }: { listening: boolean; onPress: () => void }) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const { pressStyle, pressHandlers, onPressHaptic } = usePressFeedback();
  const breath = useBreath(listening);
  const slop = targetSlop(SEND_SIZE, SEND_SIZE);
  return (
    <Reanimated.View style={[pressStyle, breath]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listening ? 'Stop dictating' : 'Dictate a message'}
        accessibilityState={{ selected: listening }}
        accessibilityHint={listening ? undefined : 'Speak, and the words appear in the message to edit before sending'}
        onPress={() => {
          onPressHaptic();
          onPress();
        }}
        {...handlers}
        {...pressHandlers}
        {...(slop ? { hitSlop: slop } : {})}
        style={({ pressed }) => [
          {
            width: SEND_SIZE,
            height: SEND_SIZE,
            borderRadius: SEND_SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: listening ? t.colors.danger : t.colors.border,
            backgroundColor: listening ? t.colors.dangerSoft : pressed ? t.colors.surfaceActive : 'transparent',
          },
          ring,
        ]}
      >
        <Icon name="mic" tone={listening ? 'danger' : 'textDim'} />
      </Pressable>
    </Reanimated.View>
  );
}

/** The model in play, as a chip on the composer's bottom row. */
function ModelChip({ model, onPress }: { model: string; onPress?: () => void }) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const { pressStyle, pressHandlers, onPressHaptic } = usePressFeedback();
  const body = (
    // `flexShrink` and no fixed width: a long model id gives up its room to the send
    // button rather than pushing it past the right edge. See the row below.
    <Text numberOfLines={1} style={{ color: t.colors.textDim, fontSize: t.fontSize.xs, flexShrink: 1 }}>
      {model}
    </Text>
  );
  const box = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    flexShrink: 1,
    minWidth: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.border,
    borderRadius: t.radius.pill,
    paddingHorizontal: t.spacing.sm + 2,
    paddingVertical: 4,
  };
  if (!onPress) return <View style={box}>{body}</View>;
  return (
    // `flexShrink` has to be on the animated wrapper as well as the box inside it: the
    // wrapper is now the child the row measures, and a rigid wrapper around a shrinkable
    // box is what pushes Send off the right edge on a long model id.
    <Reanimated.View style={[{ flexShrink: 1, minWidth: 0 }, pressStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Model: ${model}`}
        accessibilityHint="Change the model for this conversation"
        onPress={() => {
          onPressHaptic();
          onPress();
        }}
        {...handlers}
        {...pressHandlers}
        hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
        style={({ pressed }) => [box, { backgroundColor: pressed ? t.colors.surfaceActive : 'transparent' }, ring]}
      >
        {body}
        {/* The chevron is what makes the chip look like a control rather than a
            read-out; it is only drawn when there is somewhere to go. */}
        <Icon name="expand" size="sm" tone="textFaint" />
      </Pressable>
    </Reanimated.View>
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
  attachments,
  onAttach,
  onRemoveAttachment,
  attachDisabledReason,
  attachmentCaveat,
  contextNote,
  onDismissContextNote,
  onContinue,
}: {
  value: string;
  onChangeText: (text: string) => void;
  /**
   * Send. Handed the pressure reading this bar is showing, so the screen can ask
   * for a confirmation without recomputing it — two computations of the same
   * number are two chances for the dialog and the gauge to disagree.
   */
  onSend: (pressure: ContextPressure) => void;
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
  /** Staged attachments. Their cost is in the gauge before they are sent. */
  attachments?: readonly ContentBlock[];
  /** Present ⇒ the attach button is shown. */
  onAttach?: () => void;
  onRemoveAttachment?: (index: number) => void;
  /** Why attaching is impossible — a model without vision, usually. */
  attachDisabledReason?: string;
  /** Something lossy about how a staged attachment will be sent. */
  attachmentCaveat?: string;
  /** What the last turn's context handling did, if anything. Dismissable. */
  contextNote?: string;
  onDismissContextNote?: () => void;
  /**
   * Present ⇒ the note gets a Continue button.
   *
   * Only for a turn a cap stopped. "Send again to continue it" was the old
   * instruction, and it asked the user to type something they did not want to say
   * in order to press a button that was not there.
   */
  onContinue?: () => void;
}) {
  const t = useTheme();
  const liveCount = useSettings((s) => s.liveTokenCount);
  const warnAt = useSettings((s) => s.contextWarnAt);
  const strategy = useSettings((s) => s.contextStrategy);
  const sendOnEnter = useSettings((s) => s.sendOnEnter);

  /**
   * Whether the readout is showing exact figures.
   *
   * `~4.2k / 200k` is the right default — it is an estimate, and false precision
   * invites the user to trust a character-ratio guess to the token. But when the
   * gauge is amber the next question is always "by how much?", and rounding to
   * 100-token steps is exactly where that answer disappears.
   */
  const [exact, setExact] = useState(false);

  /**
   * Whether the input holds the keyboard.
   *
   * Drives a border that warms from `borderStrong` to the accent while the user is
   * typing, which is the composer's one piece of ambient state: on a phone the keyboard
   * covers half the screen and the box's own edge is the only thing left that can say
   * *this* is where the next keystroke lands.
   *
   * The background deliberately does not move with it. In the light palette the box is
   * already pure white — every other surface in the theme is darker than it — so a
   * "lift" on focus can only be rendered as a dim, and a text field that greys out the
   * moment you tap it says the opposite of what focus means.
   */
  const [focused, setFocused] = useState(false);
  const focus = useTransition(focused);
  const boxFocus = useAnimatedStyle(() => ({
    borderColor: interpolateColor(focus.value, [0, 1], [t.colors.borderStrong, t.colors.accentFill]),
  }));

  // Dictation writes straight into the draft, so it needs nothing from the screen
  // above: the composer already owns the draft's text.
  const dictation = useDictation(onChangeText);

  const factor = calibration?.factor ?? 1;
  const staged = attachments ?? EMPTY_ATTACHMENTS;

  const draftTokens = useMemo(
    () => (liveCount && value ? Math.round(estimateTextTokens(value) * factor) : 0),
    [liveCount, value, factor],
  );

  /**
   * Attachments are *not* multiplied by the calibration factor.
   *
   * The factor corrects a character-ratio estimate of prose against what the model
   * reported for prose. An image's cost is a different quantity entirely — a flat
   * per-image figure from the provider's own pixel rule — and scaling it by a
   * correction derived from text would make the gauge worse, not better.
   */
  const attachedTokens = useMemo(() => (liveCount ? attachmentTokens(staged) : 0), [liveCount, staged]);

  const pressure = useMemo(
    () =>
      contextPressure(
        Math.round(baseTokens * factor) + draftTokens + attachedTokens,
        contextWindow,
        reserved,
        warnAt,
      ),
    [baseTokens, factor, draftTokens, attachedTokens, contextWindow, reserved, warnAt],
  );

  // An attachment on its own is a message: "what is this?" is a reasonable thing to
  // send with a photo and no words.
  const empty = value.trim().length === 0 && staged.length === 0;
  const blocked = disabledReason !== undefined;
  const note = pressureNote(pressure.level, pressure.remaining, strategy);
  const stagedSummary = staged.length ? describeAttachments(staged) : '';

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

      {/* What the last turn did to the history, above the input rather than in the
          transcript: it is a fact about the request, not something anybody said. It
          announces itself (`live`) because "older turns were summarised" changes what
          the next reply can be expected to remember, and it is dismissable because it
          describes something already done — there is no action left to take. */}
      {contextNote !== undefined && contextNote.length > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Note tone="info" live>
              {contextNote}
            </Note>
          </View>
          {onContinue ? <Button label="Continue" onPress={onContinue} size="sm" /> : null}
          {onDismissContextNote ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss context note"
              onPress={onDismissContextNote}
              hitSlop={12}
              style={{ paddingTop: t.spacing.sm, paddingHorizontal: 4 }}
            >
              <Icon name="close" tone="textFaint" />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Full width rather than under the button: the reason is a sentence, and a
          sentence wrapped into a 90pt column beside the input is unreadable. */}
      {blocked ? <Note tone="danger">{disabledReason}</Note> : null}

      {/* Dictation failures are not send failures, so they get their own line rather
          than the blocked-send slot. Nothing to dismiss: the next mic press clears it. */}
      {dictation.error ? <Note tone="warning">{dictation.error}</Note> : null}

      {/* The strip sits above the input, not below it: what is about to be sent
          belongs on the same side of the box as the transcript it is joining. */}
      {staged.length > 0 ? (
        <View style={{ gap: t.spacing.xs }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: t.spacing.sm, paddingVertical: 6, paddingHorizontal: 6 }}
          >
            {staged.map((block, index) => (
              <AttachmentChip
                key={index}
                block={block}
                label={describeBlock(block, index)}
                onRemove={() => onRemoveAttachment?.(index)}
              />
            ))}
          </ScrollView>

          {/* The set's size and token cost, because an image is the one thing a
              user attaches with no sense of what it will cost every turn. */}
          <Body size="xs" tone="faint">
            {stagedSummary}
          </Body>

          {attachmentCaveat !== undefined ? <Note tone="warning">{attachmentCaveat}</Note> : null}
        </View>
      ) : null}

      {/* One rounded box holds the input and its controls, so the composer reads as a
          single object the user is writing inside rather than a toolbar. */}
      <Reanimated.View
        style={[
          {
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: t.radius.xl,
            backgroundColor: t.colors.surface,
            paddingHorizontal: t.spacing.md,
            paddingTop: t.spacing.sm + 2,
            paddingBottom: t.spacing.sm,
          },
          boxFocus,
        ]}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={`Reply to ${APP_NAME}…`}
          placeholderTextColor={t.colors.textFaint}
          multiline
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          // `submit` makes Enter send; `newline` keeps it as a line break. Without
          // an explicit value a multiline input on Android does neither reliably.
          submitBehavior={sendOnEnter ? 'submit' : 'newline'}
          onSubmitEditing={sendOnEnter && !empty && !streaming && !blocked ? () => onSend(pressure) : undefined}
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
          {/* Everything left of the send button lives in one shrinking group.
              Without it, a long model id and an exact token readout pushed Send
              off the right edge of the screen — the one control in the app that
              must never be unreachable. `minWidth: 0` is what actually lets a row
              of Texts shrink; `flexShrink` alone does nothing to them. */}
          <View
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: t.spacing.sm,
              overflow: 'hidden',
            }}
          >
            {onAttach ? (
              <AttachButton
                onPress={onAttach}
                disabled={attachDisabledReason !== undefined}
                {...(attachDisabledReason !== undefined ? { reason: attachDisabledReason } : {})}
              />
            ) : null}

            {dictation.available && !streaming ? (
              <MicButton
                listening={dictation.listening}
                onPress={() => (dictation.listening ? dictation.stop() : void dictation.start(value))}
              />
            ) : null}

            {model !== undefined ? (
              <ModelChip model={model} {...(onPressModel ? { onPress: onPressModel } : {})} />
            ) : null}
            {liveCount ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setExact((on) => !on)}
                hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                style={{ flexShrink: 1, minWidth: 0 }}
                accessibilityLabel={
                  calibration && calibration.samples > 0
                    ? `About ${formatTokens(pressure.used)} of ${formatTokens(pressure.window)} usable context, calibrated against ${calibration.samples} reported ${calibration.samples === 1 ? 'turn' : 'turns'}`
                    : `About ${formatTokens(pressure.used)} of ${formatTokens(pressure.window)} usable context, estimated`
                }
                accessibilityHint={exact ? 'Show rounded token counts' : 'Show exact token counts'}
              >
                {/* The `~` is doing real work: this is an estimate, and the gauge above is
                    only as good as it. Once the model's own reported counts have corrected
                    it, say so — an uncalibrated 70% and a calibrated 70% deserve different
                    amounts of trust, and the user is the one who has to decide how much. */}
                <Body size="xs" tone="faint" mono numberOfLines={1}>
                  {exact
                    ? `~${pressure.used.toLocaleString()} / ${(pressure.window - pressure.reserved).toLocaleString()} usable · ${pressure.reserved.toLocaleString()} reserved`
                    : `~${formatTokens(pressure.used)} / ${formatTokens(pressure.window)}`}
                </Body>
              </Pressable>
            ) : null}
            {liveCount && calibration && calibration.samples > 0 ? (
              <Body size="xs" tone="faint" numberOfLines={1}>
                {`×${calibration.factor.toFixed(2)}`}
              </Body>
            ) : null}
            {liveCount && draftTokens > 0 ? (
              <Body size="xs" tone="faint" mono numberOfLines={1}>
                {`+${formatTokens(draftTokens)}`}
              </Body>
            ) : null}
          </View>

          {/* Never shrinks, never wraps, always on screen. */}
          <View style={{ flexShrink: 0, flexGrow: 0 }}>
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
                onPress={() => onSend(pressure)}
                disabled={empty || blocked}
                {...(blocked ? { reason: disabledReason } : empty ? { reason: 'Write a message first.' } : {})}
              />
            )}
          </View>
        </View>
      </Reanimated.View>

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
