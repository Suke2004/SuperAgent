/**
 * Provider profile list.
 *
 * One active profile at a time, switched manually. Both AgentRouter transports ship
 * as separate profiles rather than as a toggle on one, because they are genuinely
 * different endpoints with different capabilities — and having both visible from the
 * first launch is what makes the /v1 distinction obvious instead of surprising.
 *
 * Every profile used to appear three times on this screen: once to edit, once to
 * activate, once to delete. Three lists of the same four things, and the only way to
 * know which one you were in was the heading you had already scrolled past. Now each
 * profile is one row — pressing it makes it active, the Edit link opens everything
 * else, and deleting lives on the profile's own screen where the consequences can be
 * spelled out.
 */

import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import {
  Badge,
  Body,
  Button,
  Field,
  Inline,
  MIN_TARGET,
  Note,
  Row,
  Screen,
  Section,
  Segmented,
  Stack,
  verticalSlop,
} from '@/components/ui';
import { invalidateTransports } from '@/lib/gateway';
import { verifyProfile } from '@/lib/verify';
import { AGENTROUTER_ORIGIN, useProviders } from '@/stores/providers';
import { useTheme } from '@/theme';
import type { ConnectionTestResult, TransportKind } from '@/transports/types';

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

  /**
   * What the connection test made of the profile that was just saved.
   *
   * Rendered on the screen rather than only announced in an alert: this is the one
   * moment where "did that work?" is the whole question, and an alert that has been
   * dismissed cannot be re-read.
   */
  const [setupResult, setSetupResult] = useState<{
    profileId: string;
    outcome: ConnectionTestResult;
    discovered: number;
    adopted: string | null;
  } | null>(null);

  /**
   * The name a blank field will get, shown as the placeholder rather than left to be
   * discovered after saving. One less field to fill in that anyone would fill in the
   * same way.
   */
  const derivedName = useMemo(() => (baseUrl.trim() ? customProfileName(baseUrl.trim()) : ''), [baseUrl]);

  async function saveSetup() {
    const key = setupKey.trim();
    if (!key) return;

    setSavingSetup(true);
    setSetupResult(null);
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

      // Tested here, not left for the user to go and find. Saving a key and then
      // discovering on the first message that the URL was wrong, or that the seeded
      // default model is not served, is two screens and a failed turn of feedback
      // for something the app can answer in one request — and the test is also
      // where the model list comes from, so skipping it left the pickers empty.
      const verified = await verifyProfile(id);
      setSetupResult({ profileId: id, ...verified });
      const label = useProviders.getState().byId(id)?.name ?? 'Provider';
      Alert.alert(
        verified.outcome.ok ? 'Provider ready' : 'Saved, but the test failed',
        verified.outcome.ok
          ? `${label} is active.${verified.discovered ? ` ${verified.discovered} model${verified.discovered === 1 ? '' : 's'} found.` : ''}`
          : `${label} is saved and active, but: ${verified.outcome.summary}`,
      );
    } catch (error) {
      if (createdId) removeProfile(createdId);
      Alert.alert('Could not save provider', error instanceof Error ? error.message : 'The API key could not be saved.');
    } finally {
      setSavingSetup(false);
    }
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
                label="Base URL"
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://example.org"
                mono
                keyboardType="url"
                hint="Paste the origin. The /v1 suffix is added or removed to match the selected transport."
              />
              {/* Below the URL, because its placeholder is derived from it: with a
                  host typed in there is nothing left to decide here. */}
              <Field
                label="Profile name (optional)"
                value={name}
                onChangeText={setName}
                placeholder={derivedName || 'My gateway'}
                autoCapitalize="words"
                {...(derivedName ? { hint: `Left blank, this profile is called "${derivedName}".` } : {})}
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

          {/* The test the save just ran, in place. `Alert` says the same thing, but
              it is gone as soon as it is dismissed and it is a no-op on web. */}
          {setupResult ? (
            <Stack gap="sm">
              <Note tone={setupResult.outcome.ok ? 'success' : 'danger'} live>
                {setupResult.outcome.ok
                  ? `Connected.${setupResult.discovered ? ` ${setupResult.discovered} model${setupResult.discovered === 1 ? '' : 's'} discovered.` : ' The gateway did not list any models — pick one by id in the chat.'}`
                  : `Saved and active, but the connection test failed: ${setupResult.outcome.summary}`}
              </Note>
              {setupResult.adopted ? (
                <Note tone="info">
                  {`The default model was changed to ${setupResult.adopted}, because the gateway does not serve the one this app guessed.`}
                </Note>
              ) : null}
              {setupResult.outcome.ok ? null : (
                <Button
                  label="Open profile to fix it"
                  onPress={() => router.push(`/settings/provider/${setupResult.profileId}`)}
                />
              )}
            </Stack>
          ) : null}
        </Stack>
      </Section>

      {/*
        One row per profile. Pressing it makes it active — the thing done most often,
        so it gets the whole row — and Edit opens everything else, deletion included.
      */}
      <Section
        title="Profiles"
        note="Tap a profile to make new conversations use it. Edit opens its URL, key, transport, connection test and delete."
      >
        {profiles.map((profile, index) => {
          const active = profile.id === activeId;
          return (
            <Row
              key={profile.id}
              first={index === 0}
              role="radio"
              checked={active}
              label={profile.name}
              subtitle={`${profile.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'} · ${profile.baseUrl}`}
              accessibilityLabel={`${profile.name}, ${profile.hasKey ? 'key saved' : 'no key saved'}`}
              accessibilityHint={active ? 'Already in use by new conversations' : 'Makes new conversations use this profile'}
              onPress={() => {
                setActive(profile.id);
                invalidateTransports();
              }}
              right={
                <Inline gap="xs" wrap={false}>
                  {profile.hasKey ? null : <Badge label="No key" tone="danger" />}
                  {active ? <Badge label="In use" tone="accent" /> : null}
                  <Pressable
                    onPress={() => router.push(`/settings/provider/${profile.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${profile.name}`}
                    hitSlop={verticalSlop(MIN_TARGET)}
                  >
                    <Body tone="accent" size="sm">
                      Edit
                    </Body>
                  </Pressable>
                </Inline>
              }
            />
          );
        })}
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

      <Note>
        A duplicated profile starts without a key. Keystore entries are keyed by profile id, and sharing one key
        across two profiles would make &quot;which key did I revoke?&quot; unanswerable.
      </Note>
    </Screen>
  );
}
