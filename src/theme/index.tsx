/**
 * Theme.
 *
 * Two palettes and a resolver. The app is information-dense by intent — the point
 * is exposing controls the official clients hide — so the palettes lean on a small
 * number of surface levels and one accent, rather than colour-coding everything.
 *
 * Colours are plain hex strings and spacing is a fixed scale, so components never
 * compute a colour at render time.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';

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
  text: string;
  textDim: string;
  /** Placeholder and disabled text. Deliberately still legible. */
  textFaint: string;
  accent: string;
  accentText: string;
  accentSoft: string;
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
  bg: '#ffffff',
  surface: '#f6f7f9',
  surfaceAlt: '#eceef2',
  surfaceActive: '#e2e5ea',
  border: '#dcdfe5',
  borderStrong: '#b9bec8',
  text: '#14161a',
  textDim: '#5b616e',
  textFaint: '#8b909c',
  accent: '#0b6efd',
  accentText: '#ffffff',
  accentSoft: '#e5efff',
  danger: '#c8322b',
  dangerSoft: '#fdeceb',
  warning: '#9a6200',
  warningSoft: '#fff4e0',
  success: '#127a45',
  successSoft: '#e7f6ec',
  userBubble: '#e5efff',
  userBubbleText: '#14161a',
  assistantText: '#14161a',
  thinkingBg: '#f4f1fb',
  thinkingText: '#4a3f68',
  thinkingBorder: '#ddd4f0',
};

const dark: Palette = {
  bg: '#0f1114',
  surface: '#171a1f',
  surfaceAlt: '#1f232a',
  surfaceActive: '#282d36',
  border: '#2a2f38',
  borderStrong: '#3d444f',
  text: '#e8eaee',
  textDim: '#9aa1ad',
  textFaint: '#6e7684',
  accent: '#4c9aff',
  accentText: '#0b1220',
  accentSoft: '#152740',
  danger: '#ff6b60',
  dangerSoft: '#37201e',
  warning: '#e0a132',
  warningSoft: '#332918',
  success: '#4fc27f',
  successSoft: '#16301f',
  userBubble: '#1e2a3d',
  userBubbleText: '#e8eaee',
  assistantText: '#e8eaee',
  thinkingBg: '#1c1a26',
  thinkingText: '#b6abd6',
  thinkingBorder: '#312b45',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

export const fontSize = {
  xs: 11,
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

export interface Theme {
  scheme: ResolvedScheme;
  colors: Palette;
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
  monoFont: string;
}

function buildTheme(scheme: ResolvedScheme): Theme {
  return { scheme, colors: scheme === 'dark' ? dark : light, spacing, radius, fontSize, monoFont };
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
