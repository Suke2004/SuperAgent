/**
 * Dictation: speech in, text out.
 *
 * Two consumers, one recogniser. In the composer the transcript lands in the draft as
 * something the user can fix before sending, because on-device recognition gets names,
 * code and jargon wrong often enough that a "speak and it sends" button would mostly send
 * something the user did not say — and because attachments, the model picker and the
 * context gauge all assume a draft exists before a send. In voice mode the same hook is
 * held down like a walkie-talkie and the transcript is sent on release, where the trade is
 * the other way round: hands are busy, and a reply that is slightly misheard is a cheaper
 * failure than a screen that has to be read to be used.
 *
 * Everything stays on the device unless the platform's own recogniser goes to the
 * network, which is the same recogniser the keyboard's mic key uses. No audio is
 * persisted (`recordingOptions` is left off) and nothing is sent anywhere until the
 * user presses send, or lets go.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

import { log } from '@/lib/log';

export interface Dictation {
  /** False when the device has no recogniser. The button is hidden rather than dead. */
  available: boolean;
  listening: boolean;
  /** Why it stopped, when it stopped badly. Cleared on the next start. */
  error?: string;
  /** Asks for permission if needed, then starts. `from` is text to dictate after. */
  start: (from?: string) => Promise<void>;
  /** Stops and keeps what was heard. */
  stop: () => void;
}

/** What {@link useDictation} needs told, beyond where the text goes. */
export interface DictationHandlers {
  /**
   * The session finished cleanly and this is the last of it.
   *
   * What push-to-talk sends on. Not called after an error, and not called for a session
   * some *other* consumer of this hook started — see the ownership ref below.
   */
  onEnd?: () => void;
}

/**
 * What a recognition error means to someone holding a phone.
 *
 * The codes are the platform's; a user reading "no-speech" has to guess whether the
 * app broke or they were too quiet.
 */
function explain(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is off for this app. Turn it on in the system settings to dictate.';
    case 'no-speech':
      return 'Nothing was heard.';
    case 'network':
      return 'The recogniser needs a network connection and could not reach it.';
    case 'language-not-supported':
      return 'This device has no recogniser for the current language.';
    case 'audio-capture':
      return 'The microphone could not be read. Something else may be using it.';
    case 'aborted':
      return '';
    default:
      return `Dictation stopped: ${code}.`;
  }
}

/**
 * Drives one dictation session.
 *
 * `onText` is handed the whole draft each time, not a delta: interim results are
 * revisions of the same sentence, so appending them would spell the sentence out
 * three times over. The text before the mic was pressed is kept as a prefix, which
 * is what makes dictating the end of a half-typed message work.
 *
 * ## Only the instance that started the session hears it
 *
 * `useSpeechRecognitionEvent` is a subscription to a module-wide native event, so *every*
 * mounted instance of this hook receives every result. Two are mounted at once — the
 * composer's and voice mode's — and without the `owns` guard, holding the talk button in
 * voice mode also typed the transcript into the composer's draft behind it. The ref rather
 * than the `listening` state because the guard has to be exact on the same tick the
 * session ends, and a `setListening(false)` has not landed by the time the following
 * `end` event arrives.
 */
export function useDictation(onText: (text: string) => void, handlers?: DictationHandlers): Dictation {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const prefix = useRef('');
  /** Whether the session currently running is this instance's. See the note above. */
  const owns = useRef(false);
  const emit = useRef(onText);
  const ended = useRef(handlers?.onEnd);
  const onEnd = handlers?.onEnd;
  // Kept in an effect rather than assigned during render: the listeners below fire
  // outside render and only need the latest callback, and writing a ref during
  // render is the pattern that breaks under concurrent rendering.
  useEffect(() => {
    emit.current = onText;
    ended.current = onEnd;
  }, [onText, onEnd]);

  const available = ExpoSpeechRecognitionModule.isRecognitionAvailable();

  useSpeechRecognitionEvent('result', (event) => {
    if (!owns.current) return;
    const said = event.results[0]?.transcript?.trim();
    if (!said) return;
    emit.current(prefix.current ? `${prefix.current} ${said}` : said);
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (!owns.current) return;
    // Ownership is dropped here rather than in `end`, which fires straight afterwards:
    // that is what stops a failed session from being sent as if it had finished.
    owns.current = false;
    setListening(false);
    const text = explain(event.error);
    if (text) setError(text);
    // The code only. `event.message` is the platform's own string and has been seen
    // to contain the recognised words, which are the user's speech.
    log.warn('voice', 'dictation stopped with an error', { code: event.error });
  });

  useSpeechRecognitionEvent('end', () => {
    if (!owns.current) return;
    owns.current = false;
    setListening(false);
    ended.current?.();
  });

  // A session left running when the screen goes away holds the microphone open.
  useEffect(() => () => ExpoSpeechRecognitionModule.abort(), []);

  const start = useCallback(async (from = ''): Promise<void> => {
    setError(undefined);
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setError('Dictation needs the microphone. Allow it to speak your message.');
      return;
    }
    prefix.current = from.trim();
    try {
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        // Interim results are the difference between a button that looks broken for
        // four seconds and one that visibly hears you.
        interimResults: true,
        continuous: true,
        requiresOnDeviceRecognition: false,
        addsPunctuation: true,
      });
      owns.current = true;
      setListening(true);
    } catch (thrown) {
      setError(`Dictation could not start: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
  }, []);

  const stop = useCallback((): void => {
    ExpoSpeechRecognitionModule.stop();
    // The button goes quiet at once, but ownership survives until `end`: the recogniser
    // emits its *final* result after being asked to stop, and push-to-talk sends on that
    // `end` rather than on the last interim guess.
    setListening(false);
  }, []);

  return { available, listening, ...(error ? { error } : {}), start, stop };
}
