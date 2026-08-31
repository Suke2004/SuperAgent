/**
 * Dictation: speech in, editable text out.
 *
 * Deliberately *not* a voice mode. The transcript lands in the composer as a draft
 * the user can fix before sending, because on-device recognition gets names, code and
 * jargon wrong often enough that a "speak and it sends" button would mostly send
 * something the user did not say. It is also the only version that works with the
 * rest of the app: attachments, the model picker and the context gauge all assume a
 * draft exists before a send.
 *
 * Everything stays on the device unless the platform's own recogniser goes to the
 * network, which is the same recogniser the keyboard's mic key uses. No audio is
 * persisted (`recordingOptions` is left off) and nothing is sent anywhere until the
 * user presses send.
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
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const prefix = useRef('');
  const emit = useRef(onText);
  // Kept in an effect rather than assigned during render: the listeners below fire
  // outside render and only need the latest callback, and writing a ref during
  // render is the pattern that breaks under concurrent rendering.
  useEffect(() => {
    emit.current = onText;
  }, [onText]);

  const available = ExpoSpeechRecognitionModule.isRecognitionAvailable();

  useSpeechRecognitionEvent('result', (event) => {
    const said = event.results[0]?.transcript?.trim();
    if (!said) return;
    emit.current(prefix.current ? `${prefix.current} ${said}` : said);
  });

  useSpeechRecognitionEvent('error', (event) => {
    setListening(false);
    const text = explain(event.error);
    if (text) setError(text);
    // The code only. `event.message` is the platform's own string and has been seen
    // to contain the recognised words, which are the user's speech.
    log.warn('voice', 'dictation stopped with an error', { code: event.error });
  });

  useSpeechRecognitionEvent('end', () => setListening(false));

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
      setListening(true);
    } catch (thrown) {
      setError(`Dictation could not start: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
  }, []);

  const stop = useCallback((): void => {
    ExpoSpeechRecognitionModule.stop();
    setListening(false);
  }, []);

  return { available, listening, ...(error ? { error } : {}), start, stop };
}
