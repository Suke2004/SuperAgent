/**
 * The engine door: the stop half of the toggle, and one step of a script.
 *
 * `expo-speech` is mocked — it is a native module, and the two things worth pinning about
 * a wrapper this thin are that a second tap stops rather than starting a second reading
 * over the top of the first, and that an *interrupted* step does not advance the script.
 * The text-flattening pass moved to `@/chat/voice`, which needs no mock at all.
 */

// Built inside the factory, not outside it: `jest.mock` is hoisted above the
// imports, so a `const` declared out here is still undefined when the factory runs.
// `__esModule` matters too — without it the interop hands `import * as Speech` a
// module whose only key is `default`.
jest.mock('expo-speech', () => ({
  __esModule: true,
  speak: jest.fn(),
  stop: jest.fn(async () => {}),
  isSpeakingAsync: jest.fn(async () => false),
}));

import * as Speech from 'expo-speech';

import { speakOrStop, speakStep, stopSpeaking } from './speech';

const speech = Speech as unknown as { speak: jest.Mock; stop: jest.Mock; isSpeakingAsync: jest.Mock };

test('a second tap stops instead of starting a second reading', async () => {
  speech.isSpeakingAsync.mockResolvedValueOnce(false);
  expect(await speakOrStop('Hello there.')).toBe('speaking');
  expect(speech.speak).toHaveBeenCalledWith('Hello there.', {});

  speech.isSpeakingAsync.mockResolvedValueOnce(true);
  expect(await speakOrStop('Hello there.')).toBe('stopped');
  expect(speech.stop).toHaveBeenCalled();
  expect(speech.speak).toHaveBeenCalledTimes(1);
});

test('a message with nothing speakable in it does not start the engine', async () => {
  speech.isSpeakingAsync.mockResolvedValueOnce(false);
  expect(await speakOrStop('   ')).toBe('stopped');
  expect(speech.speak).not.toHaveBeenCalled();
});

test('the chosen style reaches the engine', async () => {
  speech.isSpeakingAsync.mockResolvedValueOnce(false);
  await speakOrStop('Hello.', { pitch: 0.9, rate: 1.2 });
  expect(speech.speak).toHaveBeenCalledWith('Hello.', { pitch: 0.9, rate: 1.2 });
});

test('a step advances on done and stays put when it is interrupted', () => {
  const onDone = jest.fn();
  const onError = jest.fn();
  speakStep('One step.', { pitch: 1, rate: 1 }, { onDone, onError });

  const options = speech.speak.mock.calls[0]?.[1] as {
    pitch: number;
    onDone: () => void;
    onStopped?: () => void;
    onError: (error: Error) => void;
  };
  expect(options.pitch).toBe(1);

  // The interrupt path: `stop()` routes to `onStopped`, which this deliberately does not
  // hand a handler — advancing there is how a stopped reply carries on talking.
  expect(options.onStopped).toBeUndefined();

  options.onDone();
  expect(onDone).toHaveBeenCalledTimes(1);

  options.onError(new Error('engine is missing a voice'));
  expect(onError).toHaveBeenCalledWith('engine is missing a voice');
});

test('stopping empties the queue', async () => {
  await stopSpeaking();
  expect(speech.stop).toHaveBeenCalled();
});
