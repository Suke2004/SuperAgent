/**
 * Settings backup and restore.
 *
 * The file is built by the pure `@/chat/backup`; this screen is the plumbing —
 * gather from the stores, hand the text to the share sheet, and merge a picked file
 * back in. Two things it says out loud rather than implying:
 *
 *  - **No keys.** A restored provider profile is complete except for its API key,
 *    which the user re-enters once. Same for MCP tokens. That is the point of the
 *    Keystore, not a limitation of the file.
 *  - **Merge, never overwrite.** A name that already exists is skipped and counted,
 *    so restoring the same file twice does nothing the second time. Import is the
 *    one action here that a user cannot undo with another tap.
 *
 * Conversations are not in a settings backup; the export screen owns those.
 */

import { useState } from 'react';
import { Alert, Share, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import { Body, Button, Inline, Note, Row, Screen, Section, Spinner } from '@/components/ui';
import { buildBackup, headersOf, parseBackup } from '@/chat/backup';
import type { Backup, BackupResult } from '@/chat/backup';
import { SHARE_BYTE_LIMIT } from '@/chat/deliver';
import { log } from '@/lib/log';
import { useMcp } from '@/stores/mcp';
import { entryKey, useModels } from '@/stores/models';
import { usePrompts } from '@/stores/prompts';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';
import { useSkills } from '@/stores/skills';
import { useTheme } from '@/theme';
import type { McpAuthKind } from '@/db/mcp';
import type { McpTransportKind } from '@/mcp/protocol';
import type { TransportKind } from '@/transports/types';

export default function BackupScreen() {
  const t = useTheme();
  const profiles = useProviders((s) => s.profiles);
  const skillCount = useSkills((s) => s.skills.length);
  const promptCount = usePrompts((s) => s.prompts.length);
  const serverCount = useMcp((s) => s.servers.length);
  const modelCount = useModels((s) => Object.keys(s.entries).length);

  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const build = (): BackupResult => buildBackup(gather());

  const share = async (): Promise<void> => {
    const result = build();
    // Same ceiling as an export: Android's Binder parcel fails opaquely above it,
    // so a large file is copied instead and the swap is stated, not hidden.
    if (result.bytes > SHARE_BYTE_LIMIT) {
      await Clipboard.setStringAsync(result.text);
      setOutcome(`Too large for the share sheet (${kb(result.bytes)}) — copied to the clipboard instead.`);
      return;
    }
    const action = await Share.share({ message: result.text, title: result.filename });
    setOutcome(action.action === Share.dismissedAction ? null : `Shared ${result.filename} (${kb(result.bytes)}).`);
  };

  const copy = async (): Promise<void> => {
    const result = build();
    await Clipboard.setStringAsync(result.text);
    setOutcome(`Copied ${kb(result.bytes)} of JSON.`);
  };

  const pick = async (): Promise<void> => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ['application/json', 'text/*'],
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;

    let text: string;
    try {
      text = await new File(asset.uri).text();
    } catch (error) {
      log.warn('backup', 'could not read the picked file', error);
      setOutcome('That file could not be read from storage.');
      return;
    }

    const parsed = parseBackup(text);
    if (!parsed.ok) {
      setOutcome(parsed.reason);
      return;
    }
    confirm(parsed.backup, async () => {
      setBusy(true);
      try {
        setOutcome(await restore(parsed.backup));
      } catch (error) {
        log.error('backup', 'restore failed part-way', error);
        setOutcome('The restore stopped part-way. Whatever was added before it stopped is kept.');
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <Screen>
      <Section
        title="Back up"
        note={
          'Preferences, provider profiles, model overrides, skills, prompts and MCP servers. No API keys, no OAuth ' +
          'tokens and no conversations — keys stay in the Android Keystore, and conversations have their own export.'
        }
      >
        <Row first label="Profiles" value={String(profiles.length)} />
        <Row label="Model overrides" value={String(modelCount)} />
        <Row label="Skills" value={String(skillCount)} />
        <Row label="Prompts" value={String(promptCount)} />
        <Row label="MCP servers" value={String(serverCount)} />
      </Section>

      <Inline gap="md">
        <Button label="Share backup" onPress={() => void share()} />
        <Button label="Copy JSON" variant="ghost" onPress={() => void copy()} />
      </Inline>

      <Section
        title="Restore"
        note="Adds what is missing and skips anything whose name you already have. Nothing is overwritten or deleted."
      >
        <Row
          first
          chevron
          label="Restore from a file…"
          subtitle="Pick a backup JSON from storage"
          onPress={() => void pick()}
        />
      </Section>

      {busy ? (
        <View style={{ padding: t.spacing.md }}>
          <Spinner label="Restoring" />
        </View>
      ) : null}

      {outcome ? (
        <View style={{ paddingHorizontal: t.spacing.md }}>
          <Note tone="info">{outcome}</Note>
        </View>
      ) : null}

      <View style={{ padding: t.spacing.md }}>
        <Body tone="dim" size="sm">
          A restored profile has no API key. Open Settings → Providers and paste it once; everything else is already
          set.
        </Body>
      </View>
    </Screen>
  );
}

/** Reads every store the file covers. Settings are picked by dropping the actions. */
function gather(): Parameters<typeof buildBackup>[0] {
  const profiles = useProviders.getState().profiles;
  const nameOf = new Map(profiles.map((profile) => [profile.id, profile.name]));
  return {
    settings: Object.fromEntries(
      Object.entries(useSettings.getState()).filter(([, value]) => typeof value !== 'function'),
    ),
    profiles,
    models: useModels
      .getState()
      .list()
      .flatMap((entry) => {
        const profile = nameOf.get(entry.profileId);
        // An override whose profile is gone cannot be resolved on the way back in,
        // so it is left out rather than written as an orphan.
        if (!profile) return [];
        return [
          {
            profile,
            id: entry.id,
            capabilities: entry.capabilities as unknown as Record<string, unknown>,
            wireHints: entry.wireHints as unknown as Record<string, unknown>,
            ...(entry.pricing ? { pricing: entry.pricing } : {}),
            hidden: entry.hidden,
          },
        ];
      }),
    skills: useSkills.getState().skills,
    prompts: usePrompts.getState().prompts,
    servers: useMcp.getState().servers,
  };
}

function confirm(backup: Backup, go: () => Promise<void>): void {
  const parts = [
    `${backup.profiles.length} profiles`,
    `${backup.models.length} model overrides`,
    `${backup.skills.length} skills`,
    `${backup.prompts.length} prompts`,
    `${backup.servers.length} MCP servers`,
  ];
  Alert.alert(
    'Restore this backup?',
    `It holds ${parts.join(', ')}, plus your preferences. Existing entries are kept as they are; preferences are ` +
      'replaced with the ones in the file.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore', onPress: () => void go() },
    ],
  );
}

/**
 * Merges the file into the live stores and reports what it did.
 *
 * Order matters once: profiles come before models, because a model override is
 * keyed by the profile id that only exists after the profile does.
 */
async function restore(backup: Backup): Promise<string> {
  let settings = 0;
  const live = useSettings.getState() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(backup.settings)) {
    // Only keys the app already has, and only when the type matches: a backup is a
    // file from storage, and a hand-edited one must not be able to install a
    // `themeMode` of `42` that then crashes the theme.
    if (!(key in live) || typeof live[key] === 'function') continue;
    if (typeof live[key] !== typeof value) continue;
    useSettings.getState().set(key as 'themeMode', value as never);
    settings += 1;
  }

  let addedProfiles = 0;
  for (const profile of backup.profiles) {
    // `getState()` inside the loop, as the four loops below do: a snapshot taken before
    // it would not contain the profiles this loop is adding, and nothing enforces unique
    // profile names — so a file holding two called "Home" (which `duplicateProfile` and a
    // hand-edit both produce) installed both, and the name-keyed `idOf` map below then
    // gave one of the two every model override and left the other bare.
    if (useProviders.getState().profiles.some((existing) => existing.name === profile.name)) continue;
    if (profile.kind !== 'anthropic' && profile.kind !== 'openai') continue;
    useProviders.getState().addProfile({
      name: profile.name,
      kind: profile.kind as TransportKind,
      baseUrl: profile.baseUrl,
      ...(profile.fallbackBaseUrl ? { fallbackBaseUrl: profile.fallbackBaseUrl } : {}),
      ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
      headers: headersOf(profile),
    });
    addedProfiles += 1;
  }

  const idOf = new Map(useProviders.getState().profiles.map((profile) => [profile.name, profile.id]));
  let models = 0;
  for (const model of backup.models) {
    const profileId = idOf.get(model.profile);
    if (!profileId) continue;
    const key = entryKey(profileId, model.id);
    if (!useModels.getState().get(key)) useModels.getState().addManual(profileId, model.id);
    useModels.getState().updateCapabilities(key, model.capabilities);
    useModels.getState().updateWireHints(key, model.wireHints);
    if (model.pricing) useModels.getState().setPricing(key, model.pricing);
    if (model.hidden) useModels.getState().setHidden(key, true);
    models += 1;
  }

  await useSkills.getState().load();
  let skills = 0;
  for (const skill of backup.skills) {
    if (useSkills.getState().skills.some((existing) => existing.name === skill.name)) continue;
    const result = await useSkills.getState().create(skill);
    if (result.ok) skills += 1;
  }

  await usePrompts.getState().load();
  let prompts = 0;
  for (const prompt of backup.prompts) {
    if (usePrompts.getState().prompts.some((existing) => existing.title === prompt.title)) continue;
    const result = await usePrompts.getState().create(prompt);
    if (result.ok) prompts += 1;
  }

  await useMcp.getState().load();
  let servers = 0;
  for (const server of backup.servers) {
    if (useMcp.getState().servers.some((existing) => existing.name === server.name)) continue;
    const result = await useMcp.getState().create({
      name: server.name,
      url: server.url,
      transport: server.transport === 'sse' ? 'sse' : ('http' as McpTransportKind),
      authKind: authKindOf(server.authKind),
      headers: headersOf(server),
    });
    if (result.ok) servers += 1;
  }

  const added = [
    `${settings} preferences`,
    `${addedProfiles} profiles`,
    `${models} model overrides`,
    `${skills} skills`,
    `${prompts} prompts`,
    `${servers} MCP servers`,
  ].join(', ');
  const needKeys = addedProfiles > 0 ? ' Restored profiles need their API key entered before they will connect.' : '';
  return `Restored ${added}. Anything already present was left alone.${needKeys}`;
}

function authKindOf(value: string): McpAuthKind {
  return value === 'bearer' || value === 'oauth' ? value : 'none';
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}
