/**
 * Appearance and rendering.
 *
 * Rendering is not cosmetic here: markdown, code highlighting and the thinking pane
 * are where the reading happens, so the toggles that affect them live together with
 * the theme rather than being scattered through the chat UI.
 */

import { Note, Row, Screen, Section, Segmented, Stack, Stepper, SwitchRow } from '@/components/ui';
import { useSettings } from '@/stores/settings';
import type { ContextStrategy } from '@/stores/settings';
import { useTheme } from '@/theme';
import type { ThemeMode } from '@/theme';

const THEME_OPTIONS = [
  { value: 'system' as ThemeMode, label: 'System' },
  { value: 'light' as ThemeMode, label: 'Light' },
  { value: 'dark' as ThemeMode, label: 'Dark' },
];

const STRATEGY_OPTIONS = [
  { value: 'warn' as ContextStrategy, label: 'Warn' },
  { value: 'drop_oldest' as ContextStrategy, label: 'Drop oldest' },
  { value: 'summarise' as ContextStrategy, label: 'Summarise' },
];

export default function Appearance() {
  const t = useTheme();
  const settings = useSettings();

  return (
    <Screen>
      <Section title="Theme">
        <Stack gap="sm" style={{ padding: t.spacing.md }}>
          <Segmented options={THEME_OPTIONS} value={settings.themeMode} onChange={(v) => settings.set('themeMode', v)} />
        </Stack>
      </Section>

      <Section title="Message rendering">
        <SwitchRow
          first
          label="Render markdown"
          subtitle="Off shows the raw text the model actually produced — useful when a table or code fence looks wrong."
          value={settings.renderMarkdown}
          onChange={(v) => settings.set('renderMarkdown', v)}
        />
        <SwitchRow
          label="Expand reasoning by default"
          subtitle="The collapsed/expanded choice is remembered either way."
          value={settings.showThinkingByDefault}
          onChange={(v) => settings.set('showThinkingByDefault', v)}
        />
        <SwitchRow
          label="Live token count in the composer"
          subtitle="Recounts as you type. Turn off on very long conversations if typing feels heavy."
          value={settings.liveTokenCount}
          onChange={(v) => settings.set('liveTokenCount', v)}
        />
        <SwitchRow
          label="Send on Enter"
          subtitle="Off puts a newline in the draft and keeps sending on the button."
          value={settings.sendOnEnter}
          onChange={(v) => settings.set('sendOnEnter', v)}
        />
      </Section>

      <Section
        title="Context window pressure"
        note="Applies when the conversation approaches the active model's context window, as recorded in the model registry."
      >
        <Stack gap="sm" style={{ padding: t.spacing.md }}>
          <Segmented
            options={STRATEGY_OPTIONS}
            value={settings.contextStrategy}
            onChange={(v) => settings.set('contextStrategy', v)}
          />
          <Note>
            {settings.contextStrategy === 'warn'
              ? 'Warn only. Nothing is removed; the send button stays enabled and the gateway decides.'
              : settings.contextStrategy === 'drop_oldest'
                ? 'Oldest turns are omitted from the request once the window fills. They stay in the transcript, marked as excluded.'
                : 'Oldest turns are replaced by a model-written summary. Costs one extra request when it triggers.'}
          </Note>
        </Stack>
        <Stepper
          label="Warn at"
          value={Math.round(settings.contextWarnAt * 100)}
          onChange={(v) => settings.set('contextWarnAt', v / 100)}
          step={5}
          min={50}
          max={95}
          format={(v) => `${v}%`}
        />
      </Section>

      <Section
        title="Token usage"
        note="Both of these reduce what each turn costs. They change the request, never the transcript."
      >
        <SwitchRow
          first
          label="Prompt caching"
          subtitle="Asks the provider to store the unchanging start of each request. A cached read costs a tenth of the normal input price; writing one costs a quarter more, so it pays off from the second turn onwards."
          value={settings.promptCaching}
          onChange={(v) => settings.set('promptCaching', v)}
        />
        <SwitchRow
          label="Trim reasoning before turns"
          subtitle="When the window fills, drop replayed reasoning and shorten long tool results first, and only leave out whole messages if that is not enough. Off goes straight to leaving out messages."
          value={settings.progressiveTrim}
          onChange={(v) => settings.set('progressiveTrim', v)}
        />
      </Section>

      <Section title="Speech">
        <SwitchRow
          first
          label="Read replies aloud"
          subtitle="Uses the system voice. Arrives with Phase 3."
          value={settings.ttsEnabled}
          onChange={(v) => settings.set('ttsEnabled', v)}
        />
      </Section>

      <Section title="Reset">
        <Row
          first
          destructive
          label="Reset all preferences"
          subtitle="Conversations, profiles and keys are untouched"
          onPress={() => settings.reset()}
        />
      </Section>
    </Screen>
  );
}
