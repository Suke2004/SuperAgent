/**
 * Theme.
 *
 * Two palettes and a resolver. The app is information-dense by intent — the point
 * is exposing controls the official clients hide — so the palettes lean on a small
 * number of surface levels and one accent, rather than colour-coding everything.
 *
 * Colours are plain hex strings and spacing is a fixed scale, so components never
 * compute a colour at render time.
 *
 * The palettes are warm paper (light) and warm charcoal (dark) with a single clay
 * accent, so the two schemes read as one product rather than two skins. Every ratio
 * in the comments below was measured, not estimated; the clay used for *text* is
 * darker than the clay used for *fills* because the brighter tone fails AA at body
 * size (3.98:1 on the ivory background).
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedScheme = 'light' | 'dark';

export interface Palette {
  /** App background. */
  bg: string;
  /** Cards, composer, list rows. */
  surface: string;
  /** One level above `surface`: code blocks, thinking panes, inputs. */
  surfaceAlt: string;
  /** Pressed/selected background. */
  surfaceActive: string;
  border: string;
  borderStrong: string;
  /**
   * The wash behind a modal, sheet or drawer.
   *
   * One token for both schemes, and deliberately *not* derived from either palette:
   * a scrim's job is to darken whatever is behind it, and a scrim tinted with the
   * light palette's paper leaves the page underneath legible enough to keep
   * competing with the sheet on top of it.
   */
  scrim: string;
  text: string;
  textDim: string;
  /**
   * Placeholder and disabled text.
   *
   * Held to WCAG AA (4.5:1) against `bg` rather than to a designer's idea of
   * "quiet", because in this app the faint tier carries token counts, timestamps
   * and disabled explanations — content, not decoration.
   */
  textFaint: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  /**
   * Decorative clay: the brighter tone, for fills and large marks only.
   *
   * Kept separate from `accent` because the on-brand clay measures 3.98:1 on the
   * light background — fine for a 24pt logo or a filled bar, not for the 13pt
   * labels that `accent` carries.
   */
  accentFill: string;
  /**
   * Focus ring.
   *
   * A separate token from `accent`: the ring has to be visible against the accent
   * itself (a focused primary button) as well as against every surface level, and
   * one colour cannot do both jobs.
   */
  focus: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  success: string;
  successSoft: string;
  /** User message bubble. */
  userBubble: string;
  userBubbleText: string;
  /** Assistant messages sit on the page, not in a bubble, for long-form reading. */
  assistantText: string;
  /** Thinking/reasoning pane, visually distinct from the answer. */
  thinkingBg: string;
  thinkingText: string;
  thinkingBorder: string;
}

const light: Palette = {
  bg: '#faf9f5',
  surface: '#ffffff',
  surfaceAlt: '#f0eee6',
  surfaceActive: '#e6e3d9',
  border: '#e3e0d6',
  borderStrong: '#d3cfc2',
  scrim: '#00000066',
  // 15.8:1 on bg, 14.3:1 on the sunk surface.
  text: '#1f1e1d',
  // 8.7:1 on bg, 7.9:1 on the sunk surface.
  textDim: '#4a4842',
  // 5.3:1 on bg and 4.8:1 on the sunk surface. The warmer #74716a measured 4.6:1 on
  // bg but only 4.2:1 on #f0eee6, and this tier appears inside code-block and
  // thinking-pane headers, so the sunk level is the one that has to pass.
  textFaint: '#6b6862',
  // 5.6:1 on bg, 5.1:1 on the sunk surface, and white on it is 5.9:1 — one value
  // works as both link text and a filled button. See `accentFill` for the brighter
  // decorative clay.
  accent: '#a34a29',
  accentText: '#ffffff',
  accentSoft: '#f7ece7',
  accentFill: '#c1603c',
  // 15.8:1 on bg. The ring is drawn outside the control (outlineOffset), so it is
  // read against the page rather than against a filled accent button.
  focus: '#1f1e1d',
  danger: '#a8231b',
  dangerSoft: '#fbeae7',
  warning: '#7a5200',
  warningSoft: '#f9f0dd',
  success: '#2f6b43',
  successSoft: '#e8f1e9',
  userBubble: '#f0eee6',
  userBubbleText: '#1f1e1d',
  assistantText: '#1f1e1d',
  thinkingBg: '#f4f1ea',
  thinkingText: '#4a4842',
  thinkingBorder: '#e3e0d6',
};

const dark: Palette = {
  bg: '#262624',
  surface: '#30302e',
  surfaceAlt: '#1f1e1d',
  surfaceActive: '#3d3d39',
  border: '#3d3d39',
  borderStrong: '#4d4c47',
  scrim: '#00000099',
  // 13.8:1 on bg, 12.0:1 on surface.
  text: '#f5f4ef',
  textDim: '#d8d5cc',
  // 5.8:1 on bg, 5.1:1 on surface.
  textFaint: '#a3a099',
  // 5.8:1 on bg, 5.1:1 on surface. Claude's #d97757 measured 4.9:1 on bg but 4.2:1
  // on `surface`, where most labels actually sit, so the text tone is lifted.
  accent: '#e08b6e',
  // Dark ink on clay is 6.4:1; white on the same fill is only 3.1:1.
  accentText: '#1f1e1d',
  accentSoft: '#3a2b24',
  accentFill: '#d97757',
  // 14.1:1 on bg.
  focus: '#fff5ef',
  danger: '#ff9d8f',
  dangerSoft: '#3a2422',
  warning: '#e0a86b',
  warningSoft: '#352c1d',
  success: '#7fc494',
  successSoft: '#22301f',
  userBubble: '#1f1e1d',
  userBubbleText: '#f5f4ef',
  assistantText: '#f5f4ef',
  thinkingBg: '#2b2b28',
  thinkingText: '#d8d5cc',
  thinkingBorder: '#3d3d39',
};

/**
 * The chart series ramp, in the order series are drawn.
 *
 * Deliberately not a `Palette` token: every entry there is one colour, and
 * `keyof Palette` is the type a `tone` prop is checked against — an array in that
 * union would type-check as a colour and then render as nothing.
 *
 * A chart is the one place in this app where colour *is* the information rather than
 * decoration, so these differ in lightness as well as hue and the chart draws a legend
 * beside them: a reader who cannot separate the clay from the green can still separate
 * dark from light, and read the names either way. Each measures at least 3:1 against
 * its own `bg`, which is the WCAG 1.4.11 floor for a graphic that carries meaning.
 *
 * Six, which is `MAX_SERIES` in `@/components/markdown/chart` — past that a phone
 * cannot tell them apart, so the chart refuses rather than cycling the ramp.
 */
export const SERIES: Record<ResolvedScheme, readonly string[]> = {
  light: ['#c1603c', '#3f6f8f', '#3f7a52', '#8a6bab', '#a8802a', '#b04a7a'],
  dark: ['#d97757', '#7ab0d4', '#7fc494', '#b79ae0', '#e0b95f', '#e88fb5'],
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;

export const fontSize = {
  /**
   * Decorative only — never the sole carrier of meaning.
   *
   * Kept at 11pt for things like a badge's `●`/`○` glyph, where the information is
   * also in the accessible label. Anything a user has to *read* uses `xs` or larger.
   */
  micro: 11,
  xs: 12,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 26,
  /** Code blocks and inline code. */
  code: 13,
} as const;

/** The monospace family each platform actually has. */
export const monoFont = 'monospace';

/**
 * The serif family each platform actually has, for headings and the wordmark.
 *
 * Body copy stays sans: the serif is an identity cue on names and titles, not a
 * reading face. Android ships Noto Serif under the `serif` alias; iOS resolves
 * Georgia, and Times New Roman is the web fallback.
 */
export const serifFont = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia, "Times New Roman", serif',
}) as string;

export interface Theme {
  scheme: ResolvedScheme;
  colors: Palette;
  /** The chart ramp for this scheme. See {@link SERIES}. */
  series: readonly string[];
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
  monoFont: string;
  serifFont: string;
}

function buildTheme(scheme: ResolvedScheme): Theme {
  return {
    scheme,
    colors: scheme === 'dark' ? dark : light,
    series: SERIES[scheme],
    spacing,
    radius,
    fontSize,
    monoFont,
    serifFont,
  };
}

const THEMES: Record<ResolvedScheme, Theme> = { light: buildTheme('light'), dark: buildTheme('dark') };

const ThemeContext = createContext<Theme>(THEMES.dark);

export function ThemeProvider({ mode, children }: { mode: ThemeMode; children: ReactNode }) {
  const system = useColorScheme();
  const scheme: ResolvedScheme = mode === 'system' ? (system === 'light' ? 'light' : 'dark') : mode;
  // Themes are pre-built, so this only re-runs when the scheme actually flips.
  const theme = useMemo(() => THEMES[scheme], [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** Resolve a mode against the OS setting without needing a hook. */
export function resolveScheme(mode: ThemeMode, system: ResolvedScheme | null | undefined): ResolvedScheme {
  if (mode !== 'system') return mode;
  return system === 'light' ? 'light' : 'dark';
}
