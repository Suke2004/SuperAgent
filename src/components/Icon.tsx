/**
 * The icon family, behind one door.
 *
 * Feather, chosen over Ionicons because every icon in it is a 24×24 two-pixel
 * outline stroke — the same weight as the hairline borders and the serif-free body
 * text this design is built from. Ionicons mixes filled and outline variants of the
 * same concept, and a screen that shows both reads as two design systems.
 *
 * Callers never name a Feather glyph directly; they name a *role* from
 * {@link ICONS}. Two reasons, and the first is the one that matters:
 *
 *  - **The family stays swappable.** One map to edit, not forty call sites.
 *  - **The same idea gets the same glyph everywhere.** "Close" was `✕` in the
 *    search field, `×` on an attachment chip and `×` again on the context note,
 *    all at different sizes and weights. A role name makes divergence impossible
 *    rather than merely discouraged.
 *
 * `allowFontScaling` is off. These are not text: a glyph inside a fixed 36dp disc
 * that grows with the system font scale clips against the disc or slides off
 * centre. Everything an icon *means* is carried by the `accessibilityLabel` on the
 * control around it, which does scale, and which a screen reader reads instead.
 */

import Feather from '@expo/vector-icons/Feather';

import { useTheme } from '@/theme';
import type { Palette } from '@/theme';

/**
 * Role → glyph.
 *
 * Named for what the control does, not what the picture is, so a rename of the
 * underlying glyph is a one-line change here.
 */
export const ICONS = {
  /* Navigation and structure */
  menu: 'menu',
  back: 'chevron-left',
  chevron: 'chevron-right',
  expand: 'chevron-down',
  collapse: 'chevron-up',
  more: 'more-horizontal',
  close: 'x',
  check: 'check',
  external: 'external-link',

  /* The drawer's places */
  newChat: 'plus-circle',
  chats: 'message-square',
  projects: 'folder',
  files: 'paperclip',
  skills: 'zap',
  prompts: 'book-open',
  memory: 'bookmark',
  usage: 'bar-chart-2',
  settings: 'settings',
  account: 'user',

  /* The composer */
  send: 'arrow-up',
  stop: 'square',
  attach: 'plus',
  mic: 'mic',
  /**
   * Voice mode, as distinct from `mic`.
   *
   * Feather's `activity` — the ECG trace — rather than a second microphone. `mic` already
   * means "dictate into the box you are looking at"; this opens a screen where the phone
   * talks back, and two microphones side by side in the same row would be a coin toss.
   */
  voice: 'activity',
  model: 'cpu',

  /**
   * The camera — see `@/components/chat/CameraMode`.
   *
   * `flash` and `flashOff` are two glyphs for one control on purpose. The button cycles
   * `off → auto → on`, and a single `zap` that only changes its label leaves the state
   * readable exclusively to a screen reader; the struck-through `zap-off` is the one state
   * worth seeing at a glance, because it is the one where nothing will happen.
   */
  camera: 'camera',
  flash: 'zap',
  flashOff: 'zap-off',
  flip: 'rotate-cw',

  /* Settings groups */
  gateway: 'globe',
  models: 'sliders',
  servers: 'server',
  tools: 'tool',
  appearance: 'moon',
  data: 'database',
  privacy: 'lock',
  diagnostics: 'terminal',
  backup: 'download-cloud',

  /* Message and list actions */
  search: 'search',
  copy: 'copy',
  edit: 'edit-2',
  retry: 'refresh-cw',
  branch: 'git-branch',
  pin: 'bookmark',
  archive: 'archive',
  trash: 'trash-2',
  share: 'share-2',
  tag: 'tag',
  quote: 'corner-up-left',

  /* Status */
  info: 'info',
  warning: 'alert-triangle',
  error: 'alert-circle',
  success: 'check-circle',
  offline: 'wifi-off',

  /* Tool steps — what a call in the transcript did. See `@/chat/toolLabel`. */
  calendar: 'calendar',
  mail: 'mail',
} as const;

export type IconName = keyof typeof ICONS;

/**
 * The sizes an icon is allowed to be.
 *
 * A scale rather than free numbers, for the same reason spacing is a scale: three
 * icons at 17, 18 and 20dp in one row look like a mistake, because they are one.
 *
 *  - `sm` sits inside dense text — a chevron beside a 13pt value.
 *  - `md` is the default: settings rows, drawer rows, composer controls.
 *  - `lg` is a header button.
 *  - `xl` is an empty state's illustration.
 */
export const iconSize = { sm: 14, md: 18, lg: 22, xl: 40 } as const;

export type IconSize = keyof typeof iconSize;

export function Icon({
  name,
  size = 'md',
  tone = 'textDim',
  color,
}: {
  name: IconName;
  size?: IconSize | number;
  /** A palette key, so an icon cannot pick a colour the theme does not have. */
  tone?: keyof Palette;
  /** Escape hatch for the two places that need a colour from outside the palette. */
  color?: string;
}) {
  const t = useTheme();
  return (
    <Feather
      name={ICONS[name]}
      size={typeof size === 'number' ? size : iconSize[size]}
      color={color ?? t.colors[tone]}
      allowFontScaling={false}
      // The label lives on the control, never on the glyph: a row that announces
      // "settings icon, Settings, button" is a row read twice.
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
