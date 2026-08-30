/**
 * Reading a message out loud, through the system voice.
 *
 * `expo-speech` wraps Android's own TextToSpeech engine: no audio leaves the
 * device, no key is involved, and whatever voice the user has installed is the
 * voice they get. Nothing here is configurable — a rate and pitch slider is a
 * settings screen for a feature that is mostly used to listen to one paragraph
 * while doing something else.
 *
 * The two functions are separate because only one of them is worth a test: the
 * text a TTS engine should receive is not the Markdown on screen, and a few
 * engines really do say "asterisk asterisk" out of a bold run.
 */

import * as Speech from 'expo-speech';

/**
 * Markdown flattened into something worth hearing.
 *
 * Fences go entirely: an engine reading `const x = 1;` aloud is noise, and the
 * code is still on screen. Inline markers are stripped rather than escaped, and
 * link text is kept while the URL is dropped — nobody wants a URL read out.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code block. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' image. ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Speaks the text, or stops if the engine is already talking.
 *
 * One action rather than two: the menu entry that started the reading is the one
 * the user reaches for to stop it, and asking the engine what it is doing is
 * cheaper than keeping a copy of that state in React.
 */
export async function speakOrStop(markdown: string): Promise<'speaking' | 'stopped'> {
  if (await Speech.isSpeakingAsync()) {
    await Speech.stop();
    return 'stopped';
  }
  const text = speakableText(markdown);
  if (!text) return 'stopped';
  Speech.speak(text);
  return 'speaking';
}
