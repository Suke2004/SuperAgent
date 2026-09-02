/**
 * Voice mode: hold to talk, listen to the answer, walk away with the thread intact.
 *
 * A full-screen `Modal` over the chat screen rather than a route of its own, and that is
 * the design decision the whole feature rests on. "Seamless handoff back to text
 * preserving the thread" is not a feature to be built if voice mode never left the
 * conversation in the first place: it sends through the same `send(id, …)` every message
 * goes through, so closing it reveals the transcript with the spoken exchange already in
 * it, scrolled and rendered like any other turn. A separate screen would have needed its
 * own copy of the thread and a merge.
 *
 * ## What is on screen, and why in that order
 *
 * Top to bottom: the way out, the state, the answer, where you are in it, what was heard,
 * and the button. Reversed from a normal screen on purpose — in voice mode the user's
 * hands are on the bottom third and their eyes are on the middle, so the controls sit
 * under the thumb and the answer sits where it is read.
 *
 * ## Sync without word boundaries
 *
 * `expo-speech` reports word boundaries on iOS only, so the highlight is not driven by
 * asking the engine where it has reached. `@/chat/voice` cuts the reply into short steps
 * and this speaks **one step per utterance**, advancing on the engine's own `onDone`. The
 * highlighted step is therefore the step that was just spoken, exactly, on both platforms,
 * and the pages the dots count are groups of the same steps — one array, one cursor, no
 * second numbering to disagree with the first.
 *
 * ## Push-to-talk, and what release means
 *
 * Held, not toggled: a room that is always being listened to is a different product, and
 * one nobody asked this app to be. Release does not send the last thing seen — the
 * recogniser emits its *final* transcript after being asked to stop, so the send hangs off
 * `useDictation`'s `onEnd`, which fires once that has arrived and never after an error.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { speakStep, stopSpeaking } from '@/chat/speech';
import { SPEEDS, VOICE_STYLES, pageCount, speechOptions, styleById, voiceScript } from '@/chat/voice';
import { Icon } from '@/components/Icon';
import { useBreath, usePressFeedback, useReducedMotion } from '@/components/motion';
import { Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import { Body, MIN_TARGET, Note, useFocusRing } from '@/components/ui';
import { useDictation } from '@/lib/dictation';
import * as haptics from '@/lib/haptics';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme';

import { ThinkingDots } from './ThinkingDots';

/** The talk button's diameter. Large because it is held, and held by a thumb. */
const TALK = 96;

/** The state the whole screen is describing. Exactly one of these is true. */
type Stage = 'idle' | 'listening' | 'thinking' | 'speaking';

export function VoiceMode(props: {
  visible: boolean;
  onClose: () => void;
  /** The completed reply to read out. Empty before the first answer. */
  reply: string;
  /** The partial reply while it is still arriving, for something to watch. */
  live: string;
  streaming: boolean;
  /** Sends a spoken message on the same conversation the transcript belongs to. */
  onSend: (text: string) => void;
  /** Abandons the turn in flight. */
  onAbort: () => void;
  model: string;
  /** The chat screen's own model list, so both pickers agree on what is offered. */
  modelActions: readonly SheetAction[];
  /** The chat screen's own attach sheet: camera, gallery, documents. */
  attachActions: readonly SheetAction[];
  /** How many attachments are staged, so the button can say so. */
  staged: number;
}) {
  return (
    <Modal
      visible={props.visible}
      animationType="fade"
      onRequestClose={props.onClose}
      statusBarTranslucent
      // Mounted only while open. The dictation hook inside releases the microphone on
      // unmount, and a voice screen that keeps the mic between visits is the one bug in
      // here a user would notice from across the room.
    >
      {props.visible ? <VoiceBody {...props} /> : null}
    </Modal>
  );
}

function VoiceBody({
  onClose,
  reply,
  live,
  streaming,
  onSend,
  onAbort,
  model,
  modelActions,
  attachActions,
  staged,
}: Parameters<typeof VoiceMode>[0]) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();

  const voiceStyle = useSettings((s) => s.voiceStyle);
  const speechRate = useSettings((s) => s.speechRate);
  const setSetting = useSettings((s) => s.set);
  const options = useMemo(() => speechOptions(voiceStyle, speechRate), [voiceStyle, speechRate]);

  const [heard, setHeard] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [step, setStep] = useState(0);
  const [page, setPage] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [styleSheet, setStyleSheet] = useState(false);
  const [modelSheet, setModelSheet] = useState(false);
  const [attachSheet, setAttachSheet] = useState(false);

  const steps = useMemo(() => voiceScript(reply), [reply]);
  const pages = pageCount(steps);

  /**
   * The latest transcript, for the send that happens outside React's update cycle.
   *
   * `onEnd` fires from a native event listener, and reading `heard` there would read
   * whatever it was when the listener was registered. The state is still needed as well —
   * it is what puts the words on screen while they are being said.
   */
  const latest = useRef('');
  /** Which reading is current. Bumped to orphan the chain a stop or a new reply left behind. */
  const run = useRef(0);
  /** The reply this component has already read, so a re-render does not read it twice. */
  const spokenFor = useRef('');

  const scroller = useRef<ScrollView>(null);
  const pageWidth = Math.max(1, width - t.spacing.lg * 2);

  const stop = useCallback(() => {
    run.current += 1;
    setSpeaking(false);
    void stopSpeaking();
  }, []);

  /**
   * Reads from `index` to the end, one utterance at a time.
   *
   * The generation token is what makes stopping reliable: `onDone` arrives from the native
   * engine some time after the call that queued it, so a chain interrupted by a stop or by
   * a fresh reply would otherwise wake up and carry on talking over its replacement.
   */
  const speakFrom = useCallback(
    (index: number) => {
      run.current += 1;
      const token = run.current;
      setSpeaking(true);
      const next = (at: number): void => {
        if (token !== run.current) return;
        const current = steps[at];
        if (!current) {
          setSpeaking(false);
          return;
        }
        setStep(at);
        setPage(current.page);
        speakStep(current.text, options, {
          onDone: () => next(at + 1),
          onError: (message) => {
            if (token !== run.current) return;
            setSpeaking(false);
            setNote(message);
          },
        });
      };
      next(index);
    },
    [steps, options],
  );

  // A finished reply reads itself. The ref rather than a dependency on `streaming` alone:
  // this effect also runs when the style changes, and re-reading the same answer from the
  // top because the user chose a different pitch is not what they asked for.
  useEffect(() => {
    if (streaming || !reply || reply === spokenFor.current) return;
    spokenFor.current = reply;
    setStep(0);
    setHeard('');
    latest.current = '';
    speakFrom(0);
  }, [reply, streaming, speakFrom]);

  // Leaving takes the engine with it. Closing the sheet while it talks and hearing the
  // rest of the answer from behind the transcript is the failure this prevents.
  useEffect(() => () => void stopSpeaking(), []);

  const send = useCallback(() => {
    const text = latest.current.trim();
    latest.current = '';
    if (!text) return;
    haptics.confirm();
    onSend(text);
  }, [onSend]);

  const dictation = useDictation(
    useCallback((text: string) => {
      latest.current = text;
      setHeard(text);
    }, []),
    { onEnd: send },
  );

  const stage: Stage = dictation.listening ? 'listening' : streaming ? 'thinking' : speaking ? 'speaking' : 'idle';
  const status = {
    idle: steps.length ? 'Hold to reply' : 'Hold to talk',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
  }[stage];

  const hold = () => {
    if (streaming) return;
    stop();
    setNote(null);
    setHeard('');
    latest.current = '';
    haptics.tap();
    void dictation.start();
  };

  const jump = (to: number) => {
    setPage(to);
    scroller.current?.scrollTo({ x: to * pageWidth, animated: !reduced });
  };

  // Following the voice, not fighting the finger: only while speaking, and only when the
  // spoken page is not the one already shown.
  useEffect(() => {
    if (!speaking) return;
    const target = steps[step]?.page ?? 0;
    scroller.current?.scrollTo({ x: target * pageWidth, animated: !reduced });
  }, [speaking, step, steps, pageWidth, reduced]);

  const styleActions: SheetAction[] = [
    // No `setStyleSheet(false)` in either handler: `Sheet` closes itself before it runs
    // the action, so a second close here would only be a second render.
    ...VOICE_STYLES.map((candidate) => ({
      label: candidate.label,
      subtitle: candidate.id === voiceStyle ? `${candidate.hint} · current` : candidate.hint,
      onPress: () => setSetting('voiceStyle', candidate.id),
    })),
    ...SPEEDS.map((speed) => ({
      label: `${speed}× speed`,
      subtitle: speed === speechRate ? 'Current' : 'Applies to the next thing said',
      onPress: () => setSetting('speechRate', speed),
    })),
  ];

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.colors.bg,
        paddingTop: insets.top + t.spacing.sm,
        paddingBottom: insets.bottom + t.spacing.md,
      }}
      accessibilityViewIsModal
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: t.spacing.md,
          gap: t.spacing.sm,
        }}
      >
        <Disc label="Back to the conversation" icon="close" onPress={onClose} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexShrink: 1, minWidth: 0 }}>
          <Chip label={styleById(voiceStyle).label} hint="Change the voice and the speed" onPress={() => setStyleSheet(true)} />
          <Chip label={model} hint="Change the model for this conversation" onPress={() => setModelSheet(true)} />
        </View>
      </View>

      <VoiceStage stage={stage} status={status} />

      <View style={{ flex: 1, paddingHorizontal: t.spacing.lg, justifyContent: 'center' }}>
        {note ? (
          <Note tone="warning" live>
            {note}
          </Note>
        ) : null}
        {dictation.error ? (
          <Note tone="warning" live>
            {dictation.error}
          </Note>
        ) : null}

        {streaming && live ? (
          // The partial answer, unpaged: it is still growing, so a page count would
          // change under the user's finger. Read, not spoken — nothing is said until the
          // reply is whole, because an engine fed a stream stutters on every commit.
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: t.spacing.md }}>
            <Body size="xl" tone="dim">
              {live}
            </Body>
          </ScrollView>
        ) : steps.length ? (
          <ScrollView
            ref={scroller}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(event) => setPage(Math.round(event.nativeEvent.contentOffset.x / pageWidth))}
            style={{ flex: 1 }}
          >
            {Array.from({ length: pages }, (_, index) => (
              // Vertically scrollable inside a horizontally paged parent: three long steps
              // at this type size overflow a short phone, and clipping the end of an answer
              // to keep the pager tidy is the wrong trade. Opposite axes, so the two can
              // never compete for the same gesture.
              <ScrollView
                key={index}
                style={{ width: pageWidth }}
                contentContainerStyle={{ gap: t.spacing.md, flexGrow: 1, justifyContent: 'center' }}
              >
                {steps.map((item, at) =>
                  item.page === index ? (
                    <Body
                      key={at}
                      size="xl"
                      // The highlight. Full-strength text for the step being spoken and the
                      // dim tier for its neighbours — contrast rather than a background
                      // wash, which at this size reads as a selection the user made.
                      tone={speaking && at === step ? 'normal' : 'dim'}
                      weight={speaking && at === step ? '600' : '400'}
                      selectable
                    >
                      {item.text}
                    </Body>
                  ) : null,
                )}
              </ScrollView>
            ))}
          </ScrollView>
        ) : (
          <Body size="lg" tone="faint">
            Hold the button and say what you want. The answer is read back to you, and
            everything said here stays in this conversation.
          </Body>
        )}
      </View>

      {pages > 1 && !streaming ? <Dots count={pages} current={page} onJump={jump} /> : null}

      {heard ? (
        <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm }}>
          <Body size="sm" tone="dim" numberOfLines={2}>
            {heard}
          </Body>
        </View>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: t.spacing.xl,
          gap: t.spacing.md,
        }}
      >
        <Disc
          label={staged ? `Attach — ${staged} staged` : 'Attach a file or take a photo'}
          icon="attach"
          onPress={() => setAttachSheet(true)}
        />
        <TalkButton
          listening={dictation.listening}
          disabled={!dictation.available || streaming}
          reason={!dictation.available ? 'This device has no speech recogniser.' : 'Wait for the answer, or stop it first.'}
          onPressIn={hold}
          onPressOut={() => dictation.stop()}
        />
        {/* One stop, for whichever thing is running. Two buttons that are each dead most
            of the time is worse than one whose label says what it will do. */}
        <Disc
          label={streaming ? 'Stop answering' : 'Stop speaking'}
          icon="stop"
          disabled={!streaming && !speaking}
          onPress={() => {
            haptics.warn();
            if (streaming) onAbort();
            else stop();
          }}
        />
      </View>

      <Sheet
        visible={styleSheet}
        title="Voice"
        subtitle="Pitch and rate over the voice already on this phone"
        // The dependency, stated where the choice is made rather than in a release note.
        body="Buttery, Airy, Mellow, Glassy and Rounded are five deliveries of your device's own text-to-speech voice, not five recorded ones. The named voices in Anthropic's app come from a hosted speech model, and this build has no endpoint for it."
        actions={styleActions}
        onClose={() => setStyleSheet(false)}
      />
      <Sheet
        visible={modelSheet}
        title="Model"
        subtitle="Applies to the next message, not the ones already sent"
        actions={modelActions}
        onClose={() => setModelSheet(false)}
      />
      <Sheet
        visible={attachSheet}
        title="Attach"
        subtitle="Goes with the next thing you say"
        actions={attachActions}
        onClose={() => setAttachSheet(false)}
      />
    </View>
  );
}

/**
 * The state, as a mark and a word.
 *
 * Both, not either. The word is what a screen reader announces and what settles an
 * ambiguity the mark cannot — "Thinking" and "Speaking" are two very different waits. The
 * mark is what makes it readable at arm's length, and while listening it breathes, for the
 * reason `MicButton` does: a disc that looks identical whether or not the microphone is
 * open is the one control on a phone where the user has to be certain.
 */
function VoiceStage({ stage, status }: { stage: Stage; status: string }) {
  const t = useTheme();
  const breath = useBreath(stage === 'listening' || stage === 'speaking');
  const colour =
    stage === 'listening' ? t.colors.danger : stage === 'speaking' ? t.colors.accentFill : t.colors.textFaint;

  return (
    <View style={{ alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.lg }}>
      {stage === 'thinking' ? (
        <ThinkingDots label="Working on the answer" />
      ) : (
        <Reanimated.View
          style={[{ width: 14, height: 14, borderRadius: 7, backgroundColor: colour }, breath]}
        />
      )}
      {/* `live` rather than a silent label: the state is the one thing on this screen a
          user who cannot see it has to be told, and it changes without them acting. */}
      <Body size="sm" tone="dim" style={{ letterSpacing: 0.4 }} live>
        {status}
      </Body>
    </View>
  );
}

/**
 * Where you are in the answer.
 *
 * One accessible element, not one per dot, and announced as a sentence — `VariantPager`
 * learned this the hard way: a screen reader stopping on eight identical dots is how a
 * pager becomes unusable. Each dot is still individually tappable for a sighted user, with
 * the row's own label carrying the position.
 */
function Dots({ count, current, onJump }: { count: number; current: number; onJump: (to: number) => void }) {
  const t = useTheme();
  return (
    <View
      style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: t.spacing.sm, paddingVertical: t.spacing.md }}
      accessible
      accessibilityLabel={`Part ${current + 1} of ${count}`}
      accessibilityHint="Swipe the answer sideways to move between parts"
    >
      {Array.from({ length: count }, (_, index) => (
        <Pressable
          key={index}
          onPress={() => onJump(index)}
          hitSlop={{ top: 14, bottom: 14, left: 6, right: 6 }}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: index === current ? t.colors.accentFill : t.colors.border,
            }}
          />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The talk button. Held, not tapped.
 *
 * `onPressIn`/`onPressOut` rather than a long-press gesture: a long press has a delay
 * before it fires, and half a second of a held button doing nothing is half a second of
 * speech the recogniser never heard. The press feedback hook is deliberately *not* used
 * here — its scale-down is tuned for a tap, and on a button held for eight seconds a
 * permanent 3% shrink reads as a rendering fault. The fill does the work instead.
 */
function TalkButton({
  listening,
  disabled,
  reason,
  onPressIn,
  onPressOut,
}: {
  listening: boolean;
  disabled: boolean;
  reason: string;
  onPressIn: () => void;
  onPressOut: () => void;
}) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const breath = useBreath(listening);

  return (
    <Reanimated.View style={breath}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listening ? 'Release to send' : 'Hold to talk'}
        accessibilityState={{ disabled, busy: listening }}
        accessibilityHint={disabled ? reason : 'Hold while you speak, then let go and the message is sent'}
        disabled={disabled}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        {...handlers}
        style={[
          {
            width: TALK,
            height: TALK,
            borderRadius: TALK / 2,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: listening ? 2 : StyleSheet.hairlineWidth,
            borderColor: listening ? t.colors.danger : t.colors.borderStrong,
            backgroundColor: listening ? t.colors.dangerSoft : t.colors.surface,
            opacity: disabled ? 0.45 : 1,
          },
          ring,
        ]}
      >
        <Icon name="mic" size={32} tone={listening ? 'danger' : 'text'} />
      </Pressable>
    </Reanimated.View>
  );
}

/** A round icon button. The same disc the composer uses, at the size a thumb wants. */
function Disc({
  label,
  icon,
  onPress,
  disabled,
}: {
  label: string;
  icon: 'close' | 'attach' | 'stop';
  onPress: () => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const { pressStyle, pressHandlers, onPressHaptic } = usePressFeedback({ disabled, haptic: icon !== 'stop' });

  return (
    <Reanimated.View style={pressStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled}
        onPress={() => {
          onPressHaptic();
          onPress();
        }}
        {...handlers}
        {...pressHandlers}
        style={({ pressed }) => [
          {
            width: MIN_TARGET,
            height: MIN_TARGET,
            borderRadius: MIN_TARGET / 2,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.colors.border,
            backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
            opacity: disabled ? 0.35 : 1,
          },
          ring,
        ]}
      >
        <Icon name={icon} size="lg" tone="textDim" />
      </Pressable>
    </Reanimated.View>
  );
}

/** A pill that opens a sheet. The composer's `ModelChip`, without the composer's row. */
function Chip({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const { pressStyle, pressHandlers, onPressHaptic } = usePressFeedback();

  return (
    <Reanimated.View style={[{ flexShrink: 1, minWidth: 0 }, pressStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        onPress={() => {
          onPressHaptic();
          onPress();
        }}
        {...handlers}
        {...pressHandlers}
        hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            flexShrink: 1,
            minWidth: 0,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.colors.border,
            borderRadius: t.radius.pill,
            paddingHorizontal: t.spacing.sm + 2,
            paddingVertical: 5,
            backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
          },
          ring,
        ]}
      >
        <Body size="xs" tone="dim" numberOfLines={1}>
          {label}
        </Body>
        <Icon name="expand" size="sm" tone="textFaint" />
      </Pressable>
    </Reanimated.View>
  );
}
