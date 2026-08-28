/**
 * Provider profile list.
 *
 * One active profile at a time, switched manually. Both AgentRouter transports ship
 * as separate profiles rather than as a toggle on one, because they are genuinely
 * different endpoints with different capabilities — and having both visible from the
 * first launch is what makes the /v1 distinction obvious instead of surprising.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { Badge, Body, Button, Field, Inline, Note, Row, Screen, Section, Segmented, Stack } from '@/components/ui';
import { invalidateTransports } from '@/lib/gateway';
import { AGENTROUTER_ORIGIN, useProviders } from '@/stores/providers';
import { useTheme } from '@/theme';
import type { TransportKind } from '@/transports/types';

const KIND_OPTIONS = [
  { value: 'anthropic' as TransportKind, label: 'Anthropic' },
  { value: 'openai' as TransportKind, label: 'OpenAI' },
];

type SetupMode = 'agentrouter' | 'custom';

const SETUP_OPTIONS = [
  { value: 'agentrouter' as SetupMode, label: 'AgentRouter' },
  { value: 'custom' as SetupMode, label: 'Custom URL' },
];

function customProfileName(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || 'Custom provider';
  } catch {
    return 'Custom provider';
  }
}

export default function ProvidersScreen() {
  const t = useTheme();
  const router = useRouter();
  const profiles = useProviders((s) => s.profiles);
  const activeId = useProviders((s) => s.activeId);
  const setActive = useProviders((s) => s.setActive);
  const saveKey = useProviders((s) => s.saveKey);
  const addProfile = useProviders((s) => s.addProfile);
  const duplicateProfile = useProviders((s) => s.duplicateProfile);
  const removeProfile = useProviders((s) => s.removeProfile);

  const [setupMode, setSetupMode] = useState<SetupMode>('agentrouter');
  const [setupKey, setSetupKey] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [savingSetup, setSavingSetup] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [kind, setKind] = useState<TransportKind>('anthropic');

  async function saveSetup() {
    const key = setupKey.trim();
    if (!key) return;

    setSavingSetup(true);
    let createdId: string | null = null;
    try {
      let id: string;
      if (setupMode === 'agentrouter') {
        const expectedBaseUrl = kind === 'openai' ? `${AGENTROUTER_ORIGIN}/v1` : AGENTROUTER_ORIGIN;
        const existing = profiles.find(
          (profile) => profile.kind === kind && profile.baseUrl === expectedBaseUrl,
        );
        id =
          existing?.id ??
          addProfile({
            name: `AgentRouter (${kind === 'anthropic' ? 'Anthropic' : 'OpenAI'})`,
            kind,
            baseUrl: AGENTROUTER_ORIGIN,
          });
        if (!existing) createdId = id;
      } else {
        const url = baseUrl.trim();
        if (!url) return;
        id = addProfile({ name: name.trim() || customProfileName(url), kind, baseUrl: url });
        createdId = id;
      }

      await saveKey(id, key);
      setActive(id);
      invalidateTransports();
      setSetupKey('');
      setRevealKey(false);
      if (setupMode === 'custom') {
        setName('');
        setBaseUrl('');
      }
      Alert.alert('Provider ready', `${useProviders.getState().byId(id)?.name ?? 'Provider'} is now active.`);
    } catch (error) {
      if (createdId) removeProfile(createdId);
      Alert.alert('Could not save provider', error instanceof Error ? error.message : 'The API key could not be saved.');
    } finally {
      setSavingSetup(false);
    }
  }

  function confirmRemove(id: string, label: string) {
    if (profiles.length <= 1) {
      Alert.alert('Keep at least one', 'Deleting the last profile would leave nothing to send requests to.');
      return;
    }
    Alert.alert('Delete profile', `Delete "${label}" and its stored API key?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          removeProfile(id);
          invalidateTransports(id);
        },
      },
    ]);
  }

  return (
    <Screen>
      <Section
        title="Connect a provider"
        note="AgentRouter is the default: paste its API key and the app supplies the correct URL. Choose Custom URL only for another compatible gateway."
      >
        <Stack gap="md" style={{ padding: t.spacing.md }}>
          <Segmented options={SETUP_OPTIONS} value={setupMode} onChange={setSetupMode} />
          <Segmented options={KIND_OPTIONS} value={kind} onChange={setKind} />

          {setupMode === 'agentrouter' ? (
            <Note tone="info">
              {kind === 'anthropic'
                ? 'Uses https://agentrouter.org and the Anthropic Messages API. No base URL is needed.'
                : 'Uses https://agentrouter.org/v1 and the OpenAI-compatible API. No base URL is needed.'}
            </Note>
          ) : (
            <Stack gap="md">
              <Field
                label="Profile name (optional)"
                value={name}
                onChangeText={setName}
                placeholder="My gateway"
                autoCapitalize="words"
              />
              <Field
                label="Base URL"
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://example.org"
                mono
                keyboardType="url"
                hint="Paste the origin. The /v1 suffix is added or removed to match the selected transport."
              />
            </Stack>
          )}

          <Field
            label="API key"
            value={setupKey}
            onChangeText={setSetupKey}
            secureTextEntry={!revealKey}
            mono
            placeholder="sk-…"
            hint="Saved only in the Android Keystore. It is never written to app storage or logs."
            right={
              <Pressable onPress={() => setRevealKey((value) => !value)} accessibilityRole="button">
                <Body tone="accent" size="sm">
                  {revealKey ? 'Hide' : 'Show'}
                </Body>
              </Pressable>
            }
          />
          <Button
            label={setupMode === 'agentrouter' ? 'Save & use AgentRouter' : 'Save & use custom provider'}
            variant="primary"
            busy={savingSetup}
            disabled={!setupKey.trim() || (setupMode === 'custom' && !baseUrl.trim())}
            disabledReason={
              !setupKey.trim()
                ? 'Paste an API key first.'
                : setupMode === 'custom' && !baseUrl.trim()
                  ? 'A base URL is required for a custom provider.'
                  : undefined
            }
            onPress={() => void saveSetup()}
          />
        </Stack>
      </Section>

      <Section
        title="Saved profiles"
        note="Tap a profile to edit its URL, key and transport, or to run a connection test. The radio marks the one new conversations use."
      >
        {profiles.map((profile, index) => (
          <Row
            key={profile.id}
            first={index === 0}
            chevron
            label={profile.name}
            subtitle={`${profile.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'} · ${profile.baseUrl}`}
            onPress={() => router.push(`/settings/provider/${profile.id}`)}
            right={
              <Inline gap="xs" wrap={false}>
                {profile.hasKey ? <Badge label="Key" tone="success" /> : <Badge label="No key" tone="danger" />}
                {profile.id === activeId ? <Badge label="Active" tone="accent" /> : null}
              </Inline>
            }
          />
        ))}
      </Section>

      <Section title="Switch active profile">
        {profiles.map((profile, index) => (
          <Row
            key={profile.id}
            first={index === 0}
            label={profile.name}
            value={profile.id === activeId ? 'In use' : ''}
            onPress={() => {
              setActive(profile.id);
              invalidateTransports();
            }}
            right={
              <Badge
                label={profile.id === activeId ? '●' : '○'}
                tone={profile.id === activeId ? 'accent' : 'neutral'}
              />
            }
          />
        ))}
      </Section>

      <View style={{ alignItems: 'flex-start' }}>
        <Button
          label="Duplicate active"
          onPress={() => {
            const id = duplicateProfile(activeId);
            if (id) router.push(`/settings/provider/${id}`);
          }}
        />
      </View>

      <Section title="Danger zone">
        {profiles.map((profile, index) => (
          <Row
            key={profile.id}
            first={index === 0}
            destructive
            label={`Delete ${profile.name}`}
            subtitle="Also removes the API key from the Android Keystore"
            onPress={() => confirmRemove(profile.id, profile.name)}
          />
        ))}
      </Section>

      <Note>
        A duplicated profile starts without a key. Keystore entries are keyed by profile id, and sharing one key
        across two profiles would make &quot;which key did I revoke?&quot; unanswerable.
      </Note>
    </Screen>
  );
}
