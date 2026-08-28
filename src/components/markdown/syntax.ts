/**
 * Colours for the twelve highlighter roles, per scheme.
 *
 * Kept beside the highlighter that defines the roles rather than in `Palette`,
 * because nothing outside a code block needs them and twelve more theme keys
 * would obscure the ones every screen uses. Pre-built and frozen for the same
 * reason the themes are: a code block must not compute a colour at render time.
 *
 * The two sets are adapted from GitHub's light and dark syntax themes, which are
 * contrast-tested against backgrounds close to our `surfaceAlt`.
 */

import type { ResolvedScheme } from '@/theme';
import type { TokenColor } from '@/components/markdown/highlight';

export type SyntaxColors = Readonly<Record<TokenColor, string>>;

const dark: SyntaxColors = {
  plain: '#e8eaee',
  comment: '#7d8590',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  number: '#79c0ff',
  function: '#d2a8ff',
  type: '#ffa657',
  operator: '#79c0ff',
  punctuation: '#9aa1ad',
  variable: '#ffa198',
  deleted: '#ff6b60',
  inserted: '#4fc27f',
};

const light: SyntaxColors = {
  plain: '#14161a',
  comment: '#6a737d',
  keyword: '#cf222e',
  string: '#0a3069',
  number: '#0550ae',
  function: '#8250df',
  type: '#953800',
  operator: '#0550ae',
  punctuation: '#57606a',
  variable: '#953800',
  deleted: '#c8322b',
  inserted: '#127a45',
};

const BY_SCHEME: Readonly<Record<ResolvedScheme, SyntaxColors>> = { light, dark };

export function syntaxColors(scheme: ResolvedScheme): SyntaxColors {
  return BY_SCHEME[scheme];
}

/**
 * Roles rendered in italic.
 *
 * Only comments. Android synthesises an oblique for `monospace` rather than
 * loading a true italic face, and it is legible for prose but not for code.
 */
export const SYNTAX_ITALIC: ReadonlySet<TokenColor> = new Set<TokenColor>(['comment']);
