/**
 * Settings hub.
 *
 * Navigation only, plus the few app-wide toggles that don't warrant their own screen.
 * Anything per-conversation (model, sampling, system prompt) lives with the
 * conversation instead — putting it here would make it look global when it isn't.
 */

import { useRouter } from 'expo-router';

import { Row, Screen, Section, SwitchRow } from '@/components/ui';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';

export default function SettingsHub() {
  const router = useRouter();
  const profiles = useProviders((s) => s.profiles);
  const activeId = useProviders((s) => s.activeId);
  const settings = useSettings();
  const active = profiles.find((p) => p.id === activeId);

  return (
    <Screen>
      <Section title="Gateway">
        <Row
          first
          chevron
          label="Providers"
          value={active?.name ?? 'None'}
          subtitle="Base URL, API key, transport, connection test"
          onPress={() => router.push('/settings/providers')}
        />
        <Row
          chevron
          label="Models"
          subtitle="Discover from /v1/models and edit capability flags"
          onPress={() => router.push('/settings/models')}
        />
        <SwitchRow
          label="Automatic failover"
          subtitle="Retry on the backup domain when the primary is unreachable. Never on a 401 or 429 — those mean the primary answered."
          value={settings.autoFailover}
          onChange={(v) => settings.set('autoFailover', v)}
        />
      </Section>

      <Section title="Appearance">
        <Row
          first
          chevron
          label="Theme and rendering"
          value={settings.themeMode === 'system' ? 'System' : settings.themeMode === 'dark' ? 'Dark' : 'Light'}
          onPress={() => router.push('/settings/appearance')}
        />
      </Section>

      <Section
        title="Diagnostics"
        note="The debug log keeps request and response metadata in memory only, with the API key redacted. It is never uploaded anywhere."
      >
        <Row
          first
          chevron
          label="Debug log"
          subtitle="Requests, status codes, stream events, dropped parameters"
          onPress={() => router.push('/settings/debug')}
        />
        <SwitchRow
          label="Keep the debug log"
          value={settings.debugLogEnabled}
          onChange={(v) => settings.set('debugLogEnabled', v)}
        />
        <SwitchRow
          label="Mirror to the Metro console"
          subtitle="Useful when tethered to a dev machine; noisy otherwise."
          value={settings.debugMirrorToConsole}
          onChange={(v) => settings.set('debugMirrorToConsole', v)}
          disabled={!settings.debugLogEnabled}
          disabledReason="Turn the debug log on first."
        />
      </Section>
    </Screen>
  );
}
