/**
 * Voice mode's script: a reply cut into the pieces it is spoken and shown in.
 *
 * The pure half of {@link VoiceMode}, and the reason the sync between the voice and the
 * highlight is not guesswork. `expo-speech` reports word boundaries on iOS only, so
 * "highlight the sentence being read" cannot be driven by asking the engine where it has
 * reached. Instead the reply is cut into short steps here and spoken **one step per
 * utterance**, so the engine's own `onDone` is the cursor: whatever step was just handed
 * over is the step on screen, exactly, on every platform.
 *
 * That single decision also produces the paginated view for free. Steps are grouped into
 * pages of {@link STEPS_PER_PAGE}, so the dots and the swipe are a view over the same
 * array the speech is walking — there is no second numbering to disagree with the first.
 *
 * ## The five named styles are not Anthropic's five voices
 *
 * See {@link VOICE_STYLES}. This module has no TTS provider behind it: the engine is the
 * one already on the phone.
 */

/** Which style is speaking. Persisted in settings, so the ids are part of the format. */
export type VoiceStyleId = 'buttery' | 'airy' | 'mellow' | 'glassy' | 'rounded';

export interface VoiceStyle {
  id: VoiceStyleId;
  label: string;
  /** What it actually does, said plainly, for the row that offers it. */
  hint: string;
  /** `1.0` is the engine's own pitch. */
  pitch: number;
  /** `1.0` is the engine's own rate, before the user's speed multiplier. */
  rate: number;
}

/**
 * The five styles, and an honest account of what they are.
 *
 * The names come from the Claude app, where they are five *recorded* voices served by a
 * hosted TTS model. There is no such endpoint here — `expo-speech` drives the phone's own
 * TextToSpeech engine, so the voice is whichever one the user has installed, and the only
 * things this app can move are pitch and rate. So each style is a pitch/rate recipe over
 * that voice: five audibly different deliveries, chosen to sit roughly where the names
 * suggest, and *not* five different voices.
 *
 * That distinction is stated in the picker rather than left for the user to discover,
 * because a preset called "Glassy" that turns out to be the same voice at +20% pitch is
 * only a disappointment if the app implied otherwise. Wiring the real five is a provider
 * decision, not a code one: it needs an audio endpoint, an audio player (`expo-audio` is
 * not installed) and a per-character bill, and every one of those is a thing the user has
 * to agree to before it is worth building.
 *
 * The numbers stay inside 0.85–1.2 pitch and 0.9–1.05 rate. Wider is available and sounds
 * broken — Android's engine goes cartoonish above 1.3 and unintelligible below 0.7.
 */
export const VOICE_STYLES: readonly VoiceStyle[] = [
  { id: 'buttery', label: 'Buttery', hint: 'Low and unhurried', pitch: 0.9, rate: 0.92 },
  { id: 'airy', label: 'Airy', hint: 'Light, a little quicker', pitch: 1.15, rate: 1.05 },
  { id: 'mellow', label: 'Mellow', hint: 'Even, the plainest of the five', pitch: 1, rate: 0.95 },
  { id: 'glassy', label: 'Glassy', hint: 'Bright and clipped', pitch: 1.2, rate: 1 },
  { id: 'rounded', label: 'Rounded', hint: 'Warm and full', pitch: 0.85, rate: 1 },
] as const;

/** The style that is used when nothing has been chosen, and when a stored id has gone. */
export const DEFAULT_STYLE: VoiceStyleId = 'mellow';

/**
 * A style by id, never undefined.
 *
 * Takes a `string` rather than a `VoiceStyleId` on purpose: the argument comes out of
 * persisted settings, which is data from a previous version of this app and may name a
 * style that no longer exists. Falling back beats a crash, and beats `undefined` leaking
 * into `Speech.speak` where it would silently mean "engine default".
 */
export function styleById(id: string): VoiceStyle {
  return VOICE_STYLES.find((style) => style.id === id) ?? VOICE_STYLES.find((s) => s.id === DEFAULT_STYLE) ?? VOICE_STYLES[0]!;
}

/** The playback speeds offered. A list, not a slider: four choices fit one row of chips. */
export const SPEEDS = [0.75, 1, 1.25, 1.5] as const;

/**
 * What to hand the engine: the style's pitch, and its rate scaled by the user's speed.
 *
 * Multiplied rather than replaced, so "Buttery at 1.5×" is still recognisably Buttery.
 * Clamped because the two numbers are independent — a 1.05 style at 1.5× lands at 1.58,
 * which is past where Android's engine stays intelligible.
 */
export function speechOptions(styleId: string, speed: number): { pitch: number; rate: number } {
  const style = styleById(styleId);
  return { pitch: style.pitch, rate: Math.min(2, Math.max(0.5, style.rate * (speed || 1))) };
}

/**
 * Markdown flattened into something worth hearing.
 *
 * Fences go entirely: an engine reading `const x = 1;` aloud is noise, and the code is
 * still on screen. Inline markers are stripped rather than escaped, and link text is kept
 * while the URL is dropped — nobody wants a URL read out.
 *
 * Lives here rather than beside `Speech.speak` because it is the one part of reading a
 * message aloud that is worth a test, and a few engines really do say "asterisk asterisk"
 * out of a bold run.
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
 * The most one step may be.
 *
 * Two ceilings meet here and the smaller one wins. `Speech.maxSpeechInputLength` is 4000
 * on Android, so an utterance has to stay under that to be spoken at all — but a *step*
 * is also the unit that gets highlighted, and 4000 characters of highlight is a wall of
 * text with no cursor in it. 240 is about three lines at the size voice mode renders,
 * which is a glanceable key point.
 */
export const MAX_STEP = 240;

/** How many steps share a page, and therefore how many dots a long reply gets. */
export const STEPS_PER_PAGE = 3;

export interface VoiceStep {
  /** Spoken and shown. One string, so the two can never drift apart. */
  text: string;
  /** Which page it appears on. Zero-based. */
  page: number;
}

/**
 * Splits `text` after sentence-ending punctuation.
 *
 * No lookbehind assertion. Hermes has not always supported one, and the same cut is
 * available by capturing the terminator — `String.split` with a capture group interleaves
 * the captures into the result, so the pieces are stitched back together below.
 *
 * The `(?=…)` guard is what keeps `e.g.` and `3.5` in one piece: a split only happens
 * where the next non-space character could start a sentence.
 */
function sentences(text: string): string[] {
  const parts = text.split(/([.!?])\s+(?=[A-Z0-9"'“([])/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const piece = `${parts[i] ?? ''}${parts[i + 1] ?? ''}`.trim();
    if (piece) out.push(piece);
  }
  return out;
}

/** Cuts an over-long run at the last word boundary that fits, repeatedly. */
function hardWrap(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_STEP) {
    const window = rest.slice(0, MAX_STEP);
    const space = window.lastIndexOf(' ');
    const cut = space > MAX_STEP / 2 ? space : MAX_STEP;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Whether a line starts a block of its own rather than continuing the one above.
 *
 * A bullet and a heading are each a key point; the wrapped second line of a paragraph is
 * not. Checked before flattening, because {@link speakableText} is what removes the
 * markers this looks for.
 */
function startsBlock(line: string): boolean {
  return /^\s{0,3}([-*+]\s|\d+[.)]\s|#{1,6}\s|>\s?)/.test(line);
}

/**
 * A reply, as the ordered steps voice mode speaks and paints.
 *
 * The order of operations matters and is the only subtle thing here:
 *
 *  1. **Fences first.** A code block contains blank lines, so splitting on blank lines
 *     before removing it shatters the fence into steps that each read out a line of code.
 *  2. **Then blocks**, on blank lines and on any line that begins a bullet or heading.
 *  3. **Then flatten** each block, and drop the ones that were only punctuation.
 *  4. **Then cap.** A block past {@link MAX_STEP} is split at sentences and regrouped, and
 *     a single sentence still past it is wrapped at a word.
 *
 * @param markdown The reply as stored. Empty in, empty out — a script with no steps is
 *   what {@link VoiceMode} shows before the first answer arrives.
 * @param perPage Overridable for a test; there is no caller that changes it.
 */
export function voiceScript(markdown: string, perPage: number = STEPS_PER_PAGE): VoiceStep[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '\n\ncode block.\n\n');

  const blocks: string[] = [];
  for (const paragraph of withoutCode.split(/\n{2,}/)) {
    let current = '';
    for (const line of paragraph.split('\n')) {
      if (!line.trim()) continue;
      if (startsBlock(line) && current) {
        blocks.push(current);
        current = line;
      } else {
        current = current ? `${current} ${line.trim()}` : line;
      }
    }
    if (current) blocks.push(current);
  }

  const texts: string[] = [];
  for (const block of blocks) {
    const flat = speakableText(block);
    // A block that flattens to nothing was a horizontal rule, a bare image or a table
    // border. Speaking "dash dash dash" is worse than skipping it.
    if (!/[A-Za-z0-9]/.test(flat)) continue;
    if (flat.length <= MAX_STEP) {
      texts.push(flat);
      continue;
    }
    let run = '';
    for (const sentence of sentences(flat)) {
      for (const piece of sentence.length > MAX_STEP ? hardWrap(sentence) : [sentence]) {
        if (run && run.length + 1 + piece.length > MAX_STEP) {
          texts.push(run);
          run = piece;
        } else {
          run = run ? `${run} ${piece}` : piece;
        }
      }
    }
    if (run) texts.push(run);
  }

  return texts.map((text, index) => ({ text, page: Math.floor(index / Math.max(1, perPage)) }));
}

/** How many pages a script fills. Zero for an empty one, so a dot row can be skipped. */
export function pageCount(steps: readonly VoiceStep[]): number {
  return steps.length === 0 ? 0 : (steps[steps.length - 1]?.page ?? 0) + 1;
}
