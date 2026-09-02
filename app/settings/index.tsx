/**
 * Settings hub.
 *
 * Navigation only, plus the few app-wide toggles that don't warrant their own screen.
 * Anything per-conversation (model, sampling, system prompt) lives with the
 * conversation instead — putting it here would make it look global when it isn't.
 */

import { useRouter } from 'expo-router';
import { reloadAsync, useUpdates } from 'expo-updates';
import { useEffect, useState } from 'react';

import { Row, Screen, Section, SwitchRow } from '@/components/ui';
import { summariseTools } from '@/chat/builtins';
import { appLockAvailable, unlockApp } from '@/lib/appLock';
import { useMemory } from '@/stores/memory';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';
import { useSkills } from '@/stores/skills';
import { useMcp } from '@/stores/mcp';
import { usePrompts } from '@/stores/prompts';
import { useProjects } from '@/stores/projects';

export default function SettingsHub() {
  const router = useRouter();
  const profiles = useProviders((s) => s.profiles);
  const activeId = useProviders((s) => s.activeId);
  const settings = useSettings();
  const memoryCount = useMemory((s) => s.memories.length);
  const skillCount = useSkills((s) => s.skills.length);
  const serverCount = useMcp((s) => s.servers.length);
  const promptCount = usePrompts((s) => s.prompts.length);
  const projectCount = useProjects((s) => s.projects.length);
  const active = profiles.find((p) => p.id === activeId);
  const [lockAvailable, setLockAvailable] = useState<boolean | null>(null);
  // `false` in a dev client and on web, where there is no update channel to check, so
  // the section below simply never appears rather than needing a platform guard.
  const { isUpdatePending } = useUpdates();

  useEffect(() => {
    void appLockAvailable().then(setLockAvailable);
  }, []);

  return (
    <Screen>
      {/*
        First, and only when there is something to say. An update reaching the device is
        the one route a JavaScript security fix has to an APK that was installed by hand
        (SECURITY.md), and `checkAutomatically: 'ON_LOAD'` already downloaded and verified
        it — but it takes effect on the next *cold* start, and a chat app is one people
        leave resident for days. This row is that wait made optional, not a second update
        mechanism: doing nothing arrives at the same place.
      */}
      {isUpdatePending ? (
        <Section
          title="Update"
          note="Already downloaded and verified. It takes effect the next time the app starts from cold; restarting now is the same thing, sooner."
        >
          <Row
            first
            icon="retry"
            label="Restart to finish updating"
            subtitle="A draft you have typed but not sent is lost — send or copy it first."
            onPress={() => {
              // Nothing to catch: `reloadAsync` either replaces this process or rejects
              // because there was nothing pending after all, and both are fine.
              void reloadAsync().catch(() => {});
            }}
          />
        </Section>
      ) : null}

      <Section title="Gateway">
        <Row
          first
          chevron
          icon="gateway"
          label="Providers"
          value={active?.name ?? 'None'}
          subtitle="Base URL, API key, transport, connection test"
          onPress={() => router.push('/settings/providers')}
        />
        <Row
          chevron
          icon="models"
          label="Models"
          subtitle="Discover from /v1/models and edit capability flags"
          onPress={() => router.push('/settings/models')}
        />
        <SwitchRow
          icon="retry"
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
          icon="memory"
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
          icon="skills"
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
          icon="servers"
          label="MCP servers"
          value={serverCount ? `${serverCount}` : 'None'}
          subtitle="Add by URL, sign in, and choose which tools are offered"
          onPress={() => router.push('/settings/mcp')}
        />
      </Section>

      <Section
        title="Built-in tools"
        note={
          'What the app’s own tools may do, in every conversation. Writing files and rendering documents are always ' +
          'available; reaching the network and running code are not.'
        }
      >
        <Row
          first
          chevron
          icon="tools"
          label="Built-in tools"
          value={summariseTools({
            web: settings.allowWebFetch,
            search: settings.allowWebSearch,
            code: settings.allowRunCode,
            serverTools: 0,
            servers: 0,
            skills: 0,
            plan: false,
          })}
          subtitle="Fetch a page, search the web, run code"
          onPress={() => router.push('/settings/tools')}
        />
      </Section>

      <Section
        title="Prompts"
        note="Templates with {{variables}} you insert into the composer. Inserted from a conversation's menu."
      >
        <Row
          first
          chevron
          icon="prompts"
          label="Prompt library"
          value={promptCount ? `${promptCount}` : 'None'}
          subtitle="Write, edit or delete reusable prompts"
          onPress={() => router.push('/settings/prompts')}
        />
      </Section>

      <Section
        title="Projects"
        note="A project groups conversations around one piece of work, with instructions and documents all of them inherit."
      >
        <Row
          first
          chevron
          icon="projects"
          label="Projects"
          value={projectCount ? `${projectCount}` : 'None'}
          subtitle="Shared instructions and reference documents"
          onPress={() => router.push('/settings/projects')}
        />
      </Section>

      <Section title="Appearance">
        <Row
          first
          chevron
          icon="appearance"
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
          icon="usage"
          label="Usage"
          subtitle="Tokens and estimated cost, by day and by model"
          onPress={() => router.push('/settings/usage')}
        />
        <Row
          chevron
          icon="backup"
          label="Backup and restore"
          subtitle="Settings, providers, skills, prompts and servers — never keys or conversations"
          onPress={() => router.push('/settings/backup')}
        />
      </Section>

      <Section
        title="Privacy"
        note="The transcript database is not encrypted by this app — Android's own file encryption protects it while the device is locked. The app lock covers the case the platform leaves open: an unlocked phone in someone else's hand."
      >
        <SwitchRow
          first
          icon="privacy"
          label="Require unlock to open"
          subtitle={
            lockAvailable === false
              ? 'This device has no fingerprint, face or screen lock enrolled.'
              : 'Fingerprint, face or the device PIN, on every return to the app.'
          }
          value={settings.appLockEnabled}
          onChange={(v) => {
            // Turning it on is confirmed by actually unlocking: a switch that trusts
            // the prompt it never ran is how a user gets locked out of their own
            // conversations by a sensor that does not work.
            if (!v) {
              settings.set('appLockEnabled', false);
              return;
            }
            void unlockApp().then((ok) => {
              if (ok) settings.set('appLockEnabled', true);
            });
          }}
          disabled={lockAvailable !== true}
          disabledReason={
            lockAvailable === null
              ? 'Checking what this device supports…'
              : 'Set up a fingerprint, face unlock or screen lock in Android settings first.'
          }
        />
      </Section>

      <Section
        title="Diagnostics"
        note="The debug log keeps request and response metadata in memory only, with the API key redacted. It is never uploaded anywhere."
      >
        <Row
          first
          chevron
          icon="diagnostics"
          label="Debug log"
          subtitle="Requests, status codes, stream events, dropped parameters"
          onPress={() => router.push('/settings/debug')}
        />
        <SwitchRow
          icon="archive"
          label="Keep the debug log"
          value={settings.debugLogEnabled}
          onChange={(v) => settings.set('debugLogEnabled', v)}
        />
        <SwitchRow
          icon="external"
          label="Mirror to the Metro console"
          subtitle="Useful when tethered to a dev machine; noisy otherwise."
          value={settings.debugMirrorToConsole}
          onChange={(v) => settings.set('debugMirrorToConsole', v)}
          disabled={!settings.debugLogEnabled}
          disabledReason="Turn the debug log on first."
        />
        <SwitchRow
          icon="info"
          label="Developer details on messages"
          subtitle="Adds the raw request, response, tokens and a copy-as-curl button to each reply's ⋯ menu."
          value={settings.devPanelEnabled}
          onChange={(v) => settings.set('devPanelEnabled', v)}
          disabled={!settings.debugLogEnabled}
          disabledReason="The panel reads the debug log, so turn that on first."
        />
      </Section>
    </Screen>
  );
}
