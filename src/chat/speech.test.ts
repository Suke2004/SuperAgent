/**
 * The speakable-text pass, and the stop half of the toggle.
 *
 * `expo-speech` is mocked: it is a native module, and the only thing worth pinning
 * about the wrapper is that a second tap stops rather than starting a second
 * reading over the top of the first.
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

import { speakOrStop, speakableText } from './speech';

const speech = Speech as unknown as { speak: jest.Mock; stop: jest.Mock; isSpeakingAsync: jest.Mock };

test('markdown is flattened into something worth hearing', () => {
  const text = speakableText(
    ['# Heading', '', 'Some **bold** and `code` and [a link](https://example.com).', '', '```ts', 'const x = 1;', '```', '', '- one', '- two'].join('\n'),
  );

  expect(text).toContain('Heading');
  expect(text).toContain('Some bold and code and a link.');
  // The URL is not read out, and the fence is summarised rather than spelled.
  expect(text).not.toContain('example.com');
  expect(text).not.toContain('const x');
  expect(text).toContain('code block');
  expect(text).toContain('one');
});

test('a second tap stops instead of starting a second reading', async () => {
  speech.isSpeakingAsync.mockResolvedValueOnce(false);
  expect(await speakOrStop('Hello there.')).toBe('speaking');
  expect(speech.speak).toHaveBeenCalledWith('Hello there.');

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
