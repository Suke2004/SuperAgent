/**
 * Settings hub.
 *
 * Navigation only, plus the few app-wide toggles that don't warrant their own screen.
 * Anything per-conversation (model, sampling, system prompt) lives with the
 * conversation instead — putting it here would make it look global when it isn't.
 */

import { useRouter } from 'expo-router';

import { Row, Screen, Section, SwitchRow } from '@/components/ui';
import { useMemory } from '@/stores/memory';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';
import { useSkills } from '@/stores/skills';
import { useMcp } from '@/stores/mcp';
import { usePrompts } from '@/stores/prompts';

export default function SettingsHub() {
  const router = useRouter();
  const profiles = useProviders((s) => s.profiles);
  const activeId = useProviders((s) => s.activeId);
  const settings = useSettings();
  const memoryCount = useMemory((s) => s.memories.length);
  const skillCount = useSkills((s) => s.skills.length);
  const serverCount = useMcp((s) => s.servers.length);
  const promptCount = usePrompts((s) => s.prompts.length);
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

      <Section
        title="Memory"
        note="Durable notes about you, carried into new conversations. Inspect, edit or delete them here."
      >
        <Row
          first
          chevron
          label="Memory"
          value={settings.memoryEnabled ? `${memoryCount} remembered` : 'Off'}
          subtitle="What the app has learned about you, and the switch that stops it"
          onPress={() => router.push('/settings/memory')}
        />
      </Section>

      <Section
        title="Skills"
        note="Instruction sets you can switch on per conversation. Only the name and description reach the prompt; the instructions are fetched when the model asks for them."
      >
        <Row
          first
          chevron
          label="Skills"
          value={skillCount ? `${skillCount}` : 'None'}
          subtitle="Write, import, edit or delete reusable instructions"
          onPress={() => router.push('/settings/skills')}
        />
      </Section>

      <Section
        title="MCP servers"
        note="Tools lent to a conversation over the network. Streamable HTTP and SSE only; tokens live in the Keystore, never in the database."
      >
        <Row
          first
          chevron
          label="MCP servers"
          value={serverCount ? `${serverCount}` : 'None'}
          subtitle="Add by URL, sign in, and choose which tools are offered"
          onPress={() => router.push('/settings/mcp')}
        />
      </Section>

      <Section
        title="Prompts"
        note="Templates with {{variables}} you insert into the composer. Inserted from a conversation's menu."
      >
        <Row
          first
          chevron
          label="Prompt library"
          value={promptCount ? `${promptCount}` : 'None'}
          subtitle="Write, edit or delete reusable prompts"
          onPress={() => router.push('/settings/prompts')}
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
        title="Data"
        note="What this device has recorded, and a copy of the configuration you would otherwise re-enter by hand."
      >
        <Row
          first
          chevron
          label="Usage"
          subtitle="Tokens and estimated cost, by day and by model"
          onPress={() => router.push('/settings/usage')}
        />
        <Row
          chevron
          label="Backup and restore"
          subtitle="Settings, providers, skills, prompts and servers — never keys or conversations"
          onPress={() => router.push('/settings/backup')}
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
