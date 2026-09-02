/**
 * Reading a message out loud, through the system voice.
 *
 * `expo-speech` wraps the platform's own TextToSpeech engine: no audio leaves the device,
 * no key is involved, and whatever voice the user has installed is the voice they get.
 * What *is* configurable is pitch and rate, which is what {@link VOICE_STYLES} spends —
 * see `@/chat/voice` for why five named styles are five deliveries of one voice rather
 * than five voices.
 *
 * Everything worth testing lives next door in `@/chat/voice`, which imports nothing
 * native. This module is the door to the engine and almost nothing else: two ways to
 * start it, one way to stop it.
 */

import * as Speech from 'expo-speech';

import { speakableText } from '@/chat/voice';

/** Pitch and rate, as {@link speechOptions} produces them. */
export interface SpeakStyle {
  pitch: number;
  rate: number;
}

/**
 * Speaks the text, or stops if the engine is already talking.
 *
 * One action rather than two: the menu entry that started the reading is the one the user
 * reaches for to stop it, and asking the engine what it is doing is cheaper than keeping a
 * copy of that state in React.
 *
 * @param style The chosen voice style, from settings. Absent leaves the engine's own
 *   pitch and rate alone, which is what every caller did before styles existed.
 */
export async function speakOrStop(markdown: string, style?: SpeakStyle): Promise<'speaking' | 'stopped'> {
  if (await Speech.isSpeakingAsync()) {
    await Speech.stop();
    return 'stopped';
  }
  const text = speakableText(markdown);
  if (!text) return 'stopped';
  Speech.speak(text, style ?? {});
  return 'speaking';
}

/**
 * Speaks one step of a script and says when it has finished.
 *
 * The building block voice mode chains: `onDone` is what advances the highlight, so the
 * text on screen is the text the engine just finished rather than an estimate of where it
 * has reached. `expo-speech` only reports word boundaries on iOS, so this — one utterance
 * per step — is the only sync that works on both platforms.
 *
 * `onDone` deliberately does **not** fire when {@link stopSpeaking} interrupts: Android
 * routes an interrupted utterance to `onStopped`, and a caller that advanced on both would
 * carry on talking after the user pressed stop.
 */
export function speakStep(
  text: string,
  style: SpeakStyle,
  handlers: { onDone: () => void; onError: (message: string) => void },
): void {
  Speech.speak(text, {
    ...style,
    onDone: handlers.onDone,
    onError: (error: Error) => handlers.onError(error.message || 'The voice engine stopped.'),
  });
}

/** Interrupts whatever is being said and empties the queue. */
export async function stopSpeaking(): Promise<void> {
  await Speech.stop();
}
