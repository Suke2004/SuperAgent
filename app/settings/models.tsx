/**
 * Model registry.
 *
 * `/v1/models` returns ids and almost nothing else, so the registry pairs what the
 * gateway said with capability flags the user can edit. A refresh updates the first
 * half and never the second — flags that reset on every discovery would not be worth
 * setting.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { Badge, Body, Button, Empty, Field, Inline, Note, Row, Screen, Section, Stack } from '@/components/ui';
import { invalidateTransports, resolveTransport } from '@/lib/gateway';
import * as haptics from '@/lib/haptics';
import { entryKey, useModels } from '@/stores/models';
import { adoptDiscoveredModel, useProviders } from '@/stores/providers';
import { useReachability } from '@/stores/reachability';
import { summariseFailure } from '@/transports';
import { GatewayError } from '@/transports/errors';
import { useTheme } from '@/theme';

export default function ModelsScreen() {
  const t = useTheme();
  const router = useRouter();
  const profiles = useProviders((s) => s.profiles);
  const activeId = useProviders((s) => s.activeId);
  const entries = useModels((s) => s.entries);
  const ingest = useModels((s) => s.ingest);
  const addManual = useModels((s) => s.addManual);
  const clearProfile = useModels((s) => s.clearProfile);
  const lastDiscovery = useModels((s) => s.lastDiscovery);

  const [profileId, setProfileId] = useState(activeId);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [manualId, setManualId] = useState('');

  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const list = Object.values(entries)
    .filter((entry) => entry.profileId === (profile?.id ?? ''))
    .sort((a, b) => a.id.localeCompare(b.id));

  async function refresh() {
    if (!profile) return;
    setRefreshing(true);
    setError(null);
    setOutcome(null);
    try {
      const { transport } = await resolveTransport({ profileId: profile.id });
      const discovered = await transport.listModels();
      const { added, missing } = ingest(profile.id, discovered);
      const parts = [`${discovered.length} model(s) listed`];
      if (added.length) parts.push(`${added.length} new`);
      if (missing.length) parts.push(`${missing.length} no longer listed (kept, flagged)`);
      // A `defaultModel` the gateway does not list fails as a permission error that
      // reads like a bad key, so discovery gets to correct it — and say so.
      const adopted = adoptDiscoveredModel(
        profile.id,
        discovered.map((model) => model.id),
      );
      if (adopted) {
        invalidateTransports(profile.id);
        parts.push(`default model set to ${adopted} (the old one is not served here)`);
      }
      setOutcome(`${parts.join(' · ')}.`);
      // A model list is a round trip like any other, so it is evidence too.
      useReachability.getState().markReachable();
    } catch (err) {
      const gatewayError = err instanceof GatewayError ? err : GatewayError.wrap(err);
      setError(summariseFailure(gatewayError));
      if (gatewayError.kind === 'network') {
        useReachability.getState().markUnreachable(gatewayError.message, profile.baseUrl);
      } else {
        useReachability.getState().markReachable();
      }
    } finally {
      setRefreshing(false);
    }
  }

  if (!profile) {
    return (
      <Screen>
        <Note tone="danger">No provider profiles. Add one first.</Note>
      </Screen>
    );
  }

  const stamp = lastDiscovery[profile.id];

  return (
    <Screen>
      {profiles.length > 1 ? (
        <Section title="Profile">
          {profiles.map((p, index) => (
            <Row
              key={p.id}
              first={index === 0}
              label={p.name}
              value={p.id === profileId ? 'Showing' : ''}
              onPress={() => {
                setProfileId(p.id);
                setError(null);
                setOutcome(null);
              }}
              right={<Badge label={p.id === profileId ? '●' : '○'} tone={p.id === profileId ? 'accent' : 'neutral'} />}
            />
          ))}
        </Section>
      ) : null}

      <Stack gap="md" style={{ marginBottom: t.spacing.lg }}>
        <Inline gap="md">
          <Button label="Refresh from gateway" variant="primary" busy={refreshing} onPress={() => void refresh()} />
          {list.length ? (
            <Button
              label="Forget all"
              variant="danger"
              onPress={() =>
                Alert.alert('Forget models', `Remove all ${list.length} entries and their capability flags?`, [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Forget',
                    style: 'destructive',
                    onPress: () => {
                      haptics.warn();
                      clearProfile(profile.id);
                    },
                  },
                ])
              }
            />
          ) : null}
        </Inline>
        {stamp ? (
          <Body size="xs" tone="faint">
            {`Last discovery ${new Date(stamp).toLocaleString()}`}
          </Body>
        ) : null}
        {outcome ? <Note tone="success">{outcome}</Note> : null}
        {error ? <Note tone="danger">{error}</Note> : null}
      </Stack>

      <Section
        title={`Models (${list.length})`}
        note="Flags are guesses until you edit them. Tap a model to set its context window, output cap, vision and tool support, and pricing."
      >
        {list.length === 0 ? (
          <Empty
            icon="models"
            title="Nothing discovered yet"
            body="Refresh from the gateway, or add a model id by hand below. Gateways sometimes serve ids they do not list."
          />
        ) : (
          list.map((entry, index) => (
            <Row
              key={entry.id}
              first={index === 0}
              chevron
              label={entry.id}
              subtitle={[
                `${(entry.capabilities.contextWindow / 1000).toFixed(0)}k context`,
                `${entry.capabilities.maxOutputTokens} out`,
                entry.ownedBy ?? null,
              ]
                .filter(Boolean)
                .join(' · ')}
              onPress={() => router.push(`/settings/model/${encodeURIComponent(entryKey(profile.id, entry.id))}`)}
              right={
                <Inline gap="xs" wrap={false}>
                  {entry.capabilities.vision ? <Badge label="img" tone="accent" /> : null}
                  {entry.capabilities.tools ? <Badge label="tools" tone="accent" /> : null}
                  {entry.capabilities.reasoning ? <Badge label="think" tone="accent" /> : null}
                  {entry.guessed ? <Badge label="guessed" tone="warning" /> : null}
                  {entry.present ? null : <Badge label="unlisted" tone="warning" />}
                  {entry.hidden ? <Badge label="hidden" tone="neutral" /> : null}
                </Inline>
              }
            />
          ))
        )}
      </Section>

      <Section title="Add by hand">
        <Stack gap="md" style={{ padding: t.spacing.md }}>
          <Field
            label="Model id"
            value={manualId}
            onChangeText={setManualId}
            mono
            placeholder="claude-opus-4-8"
            hint="Marked “unlisted” because the gateway never advertised it, but still offered in the picker."
          />
          <Button
            label="Add model"
            size="sm"
            disabled={!manualId.trim()}
            disabledReason="Enter a model id."
            onPress={() => {
              addManual(profile.id, manualId.trim());
              setManualId('');
            }}
          />
        </Stack>
      </Section>
    </Screen>
  );
}
