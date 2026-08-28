/**
 * Provider profile detail.
 *
 * The screen Phase 0 exists for: base URL, API key, transport pick, and a connection
 * test that reports what actually happened rather than a thumbs-up.
 *
 * Text fields hold a local draft and commit on blur. Committing per keystroke would
 * mean normalising the base URL mid-word — typing `https://x.org/v1` would have the
 * `/v` rewritten out from under the cursor.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import {
  Badge,
  Body,
  Button,
  Divider,
  Field,
  Inline,
  Note,
  Row,
  Screen,
  Section,
  Segmented,
  Stack,
} from '@/components/ui';
import { MissingKeyError, invalidateTransports, resolveTransport } from '@/lib/gateway';
import { log } from '@/lib/log';
import { useModels } from '@/stores/models';
import { KNOWN_CLAUDE_MODELS, useProviders } from '@/stores/providers';
import { describeBaseUrlIssue, describeNormalisation, summariseFailure } from '@/transports';
import { GatewayError } from '@/transports/errors';
import type { ConnectionTestResult, TransportKind } from '@/transports/types';
import { useTheme } from '@/theme';

const KIND_OPTIONS = [
  { value: 'anthropic' as TransportKind, label: 'Anthropic' },
  { value: 'openai' as TransportKind, label: 'OpenAI' },
];

export default function ProviderDetail() {
  const t = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const profile = useProviders((s) => s.profiles.find((p) => p.id === id));
  const activeId = useProviders((s) => s.activeId);
  const updateProfile = useProviders((s) => s.updateProfile);
  const setActive = useProviders((s) => s.setActive);
  const saveKey = useProviders((s) => s.saveKey);
  const clearKey = useProviders((s) => s.clearKey);
  const recordTest = useProviders((s) => s.recordTest);
  const ingest = useModels((s) => s.ingest);

  const [name, setName] = useState(profile?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '');
  const [fallback, setFallback] = useState(profile?.fallbackBaseUrl ?? '');
  const [defaultModel, setDefaultModel] = useState(profile?.defaultModel ?? '');
  const [keyInput, setKeyInput] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [headerDraft, setHeaderDraft] = useState({ key: '', value: '' });

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort an in-flight test if the screen goes away, so a slow gateway can't call
  // setState on an unmounted component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const commit = useCallback(() => {
    if (!profile) return;
    const patch: Parameters<typeof updateProfile>[1] = {};
    if (name.trim() && name.trim() !== profile.name) patch.name = name.trim();
    if (baseUrl.trim() && baseUrl.trim() !== profile.baseUrl) patch.baseUrl = baseUrl.trim();
    if (defaultModel.trim() && defaultModel.trim() !== profile.defaultModel) patch.defaultModel = defaultModel.trim();
    const nextFallback = fallback.trim();
    if (nextFallback !== (profile.fallbackBaseUrl ?? '')) {
      patch.fallbackBaseUrl = nextFallback || undefined;
    }
    if (Object.keys(patch).length === 0) return;
    updateProfile(profile.id, patch);
    invalidateTransports(profile.id);
  }, [baseUrl, defaultModel, fallback, name, profile, updateProfile]);

  const normalisationNote = useMemo(
    () => (profile ? describeNormalisation(profile.kind, baseUrl) : null),
    [baseUrl, profile],
  );
  const urlIssue = useMemo(
    () => (profile ? describeBaseUrlIssue(profile.kind, baseUrl) : null),
    [baseUrl, profile],
  );

  if (!profile) {
    return (
      <Screen>
        <Note tone="danger">That profile no longer exists.</Note>
        <View style={{ marginTop: t.spacing.md }}>
          <Button label="Back to providers" onPress={() => router.replace('/settings/providers')} />
        </View>
      </Screen>
    );
  }

  async function runTest() {
    if (!profile) return;
    commit();
    setResult(null);
    setTesting(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { transport } = await resolveTransport({ profileId: profile.id });
      const outcome = await transport.testConnection(controller.signal);
      setResult(outcome);
      recordTest(profile.id, outcome.ok, outcome.summary);
      if (outcome.models?.length) {
        const { added } = ingest(profile.id, outcome.models);
        if (added.length) {
          log.info('models', `Discovered ${added.length} new model(s) on ${profile.name}.`);
        }
      }
    } catch (error) {
      // A missing key is a real, reportable outcome — not a reason to grey the
      // button out. Report it in the same shape as a gateway failure.
      const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
      const outcome: ConnectionTestResult = {
        ok: false,
        steps: [
          {
            label: error instanceof MissingKeyError ? 'API key' : 'Request',
            status: 'failed',
            detail: gatewayError.message,
            error: gatewayError,
          },
        ],
        summary: summariseFailure(gatewayError),
      };
      setResult(outcome);
      recordTest(profile.id, false, outcome.summary);
    } finally {
      setTesting(false);
      abortRef.current = null;
    }
  }

  async function onSaveKey() {
    if (!profile || !keyInput.trim()) return;
    setSavingKey(true);
    try {
      await saveKey(profile.id, keyInput.trim());
      invalidateTransports(profile.id);
      setKeyInput('');
      setRevealKey(false);
    } finally {
      setSavingKey(false);
    }
  }

  const headerEntries = Object.entries(profile.headers);

  return (
    <Screen>
      <Section title="Identity">
        <Stack gap="md" style={{ padding: t.spacing.md }}>
          <Field label="Name" value={name} onChangeText={setName} onBlur={commit} autoCapitalize="words" />
          <Segmented
            options={KIND_OPTIONS}
            value={profile.kind}
            onChange={(kind) => {
              // Changing the kind re-normalises the stored URL, so mirror the result
              // back into the field rather than leaving stale text on screen.
              updateProfile(profile.id, { kind });
              invalidateTransports(profile.id);
              const next = useProviders.getState().byId(profile.id);
              if (next) setBaseUrl(next.baseUrl);
            }}
          />
          <Note>
            {profile.kind === 'anthropic'
              ? 'Anthropic transport: POST <base>/v1/messages. The base URL must NOT end in /v1. Supports extended thinking with an explicit token budget.'
              : 'OpenAI transport: POST <base>/chat/completions and GET <base>/models. The base URL MUST end in /v1. Supports reasoning_effort, seed and the penalty parameters.'}
          </Note>
        </Stack>
      </Section>

      <Section title="Endpoint">
        <Stack gap="md" style={{ padding: t.spacing.md }}>
          <Field
            label="Base URL"
            value={baseUrl}
            onChangeText={setBaseUrl}
            onBlur={commit}
            mono
            keyboardType="url"
            {...(urlIssue ? { error: urlIssue } : {})}
          />
          {normalisationNote ? <Note tone="warning">{normalisationNote}</Note> : null}
          <Field
            label="Fallback origin"
            value={fallback}
            onChangeText={setFallback}
            onBlur={commit}
            mono
            keyboardType="url"
            placeholder="https://ps.air-outer.com"
            hint="Used only when the primary host is unreachable. A 401 or 429 means the primary answered, so those never fail over."
          />
          <Field
            label="Default model"
            value={defaultModel}
            onChangeText={setDefaultModel}
            onBlur={commit}
            mono
            hint={`Known Claude ids: ${KNOWN_CLAUDE_MODELS.join(', ')}. Everything else is discovered from /v1/models.`}
          />
        </Stack>
      </Section>

      <Section
        title="API key"
        note="Stored in the Android Keystore via expo-secure-store. Never written to app storage, logs or exports."
      >
        <Row
          first
          label="Status"
          value={profile.hasKey ? `Saved · ${profile.keyFingerprint}` : 'Not set'}
          right={profile.hasKey ? <Badge label="Keystore" tone="success" /> : <Badge label="Missing" tone="danger" />}
        />
        <Divider />
        <Stack gap="md" style={{ padding: t.spacing.md }}>
          <Field
            label={profile.hasKey ? 'Replace key' : 'Paste key'}
            value={keyInput}
            onChangeText={setKeyInput}
            secureTextEntry={!revealKey}
            mono
            placeholder="sk-…"
            hint="Copy the token from your gateway console. Only the last four characters are ever displayed again."
            right={
              <Pressable onPress={() => setRevealKey((v) => !v)} accessibilityRole="button">
                <Body tone="accent" size="sm">
                  {revealKey ? 'Hide' : 'Show'}
                </Body>
              </Pressable>
            }
          />
          <Inline gap="md">
            <Button
              label="Save key"
              variant="primary"
              busy={savingKey}
              disabled={!keyInput.trim()}
              disabledReason="Paste a token first."
              onPress={() => void onSaveKey()}
            />
            {profile.hasKey ? (
              <Button
                label="Remove key"
                variant="danger"
                onPress={() =>
                  Alert.alert('Remove key', 'Delete this profile’s token from the Keystore?', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Remove',
                      style: 'destructive',
                      onPress: () => {
                        void clearKey(profile.id);
                        invalidateTransports(profile.id);
                      },
                    },
                  ])
                }
              />
            ) : null}
          </Inline>
        </Stack>
      </Section>

      <Section title="Extra headers" note="For things like anthropic-beta. The Authorization header is set automatically and cannot be overridden here.">
        {headerEntries.length === 0 ? (
          <Row first label="None" subtitle="Most setups need none" />
        ) : (
          headerEntries.map(([key, value], index) => (
            <Row
              key={key}
              first={index === 0}
              label={key}
              value={value}
              onPress={() => {
                const next = { ...profile.headers };
                delete next[key];
                updateProfile(profile.id, { headers: next });
                invalidateTransports(profile.id);
              }}
              right={<Badge label="Remove" tone="danger" />}
            />
          ))
        )}
        <Divider />
        <Stack gap="sm" style={{ padding: t.spacing.md }}>
          <Inline gap="sm" wrap={false}>
            <View style={{ flex: 1 }}>
              <Field value={headerDraft.key} onChangeText={(key) => setHeaderDraft((d) => ({ ...d, key }))} placeholder="Header" mono />
            </View>
            <View style={{ flex: 1 }}>
              <Field value={headerDraft.value} onChangeText={(value) => setHeaderDraft((d) => ({ ...d, value }))} placeholder="Value" mono />
            </View>
          </Inline>
          <Button
            label="Add header"
            size="sm"
            disabled={!headerDraft.key.trim() || !headerDraft.value.trim()}
            disabledReason="Both a name and a value are required."
            onPress={() => {
              updateProfile(profile.id, {
                headers: { ...profile.headers, [headerDraft.key.trim()]: headerDraft.value.trim() },
              });
              invalidateTransports(profile.id);
              setHeaderDraft({ key: '', value: '' });
            }}
          />
        </Stack>
      </Section>

      <Section title="Connection test" note="Runs a real request against this profile. Each step reports the gateway's own message, verbatim.">
        <Stack gap="md" style={{ padding: t.spacing.md }}>
          <Inline gap="md">
            <Button label="Test connection" variant="primary" busy={testing} onPress={() => void runTest()} />
            {testing ? <Button label="Cancel" variant="ghost" onPress={() => abortRef.current?.abort()} /> : null}
          </Inline>

          {result ? (
            <Stack gap="sm">
              <Note tone={result.ok ? 'success' : 'danger'}>{result.summary}</Note>
              {result.steps.map((step, index) => (
                <View
                  key={`${step.label}-${index}`}
                  style={{
                    borderLeftWidth: 3,
                    borderLeftColor:
                      step.status === 'ok'
                        ? t.colors.success
                        : step.status === 'failed'
                          ? t.colors.danger
                          : t.colors.borderStrong,
                    paddingLeft: t.spacing.md,
                    gap: 2,
                  }}
                >
                  <Inline gap="sm">
                    <Body size="sm" weight="700">
                      {step.label}
                    </Body>
                    <Badge
                      label={step.status === 'ok' ? 'ok' : step.status}
                      tone={step.status === 'ok' ? 'success' : step.status === 'failed' ? 'danger' : 'neutral'}
                    />
                    {step.durationMs !== undefined ? (
                      <Body size="xs" tone="faint">
                        {`${step.durationMs} ms`}
                      </Body>
                    ) : null}
                  </Inline>
                  <Body size="sm" tone="dim" mono selectable>
                    {step.detail}
                  </Body>
                  {step.error?.hint ? (
                    <Body size="xs" tone="warning">
                      {step.error.hint}
                    </Body>
                  ) : null}
                </View>
              ))}
              {result.models?.length ? (
                <Body size="sm" tone="dim">
                  {`${result.models.length} model(s) discovered and merged into the registry.`}
                </Body>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      </Section>

      <Section title="Use this profile">
        <Row
          first
          label={profile.id === activeId ? 'Already active' : 'Make active'}
          subtitle="New conversations use the active profile"
          disabled={profile.id === activeId}
          onPress={() => {
            setActive(profile.id);
            invalidateTransports();
          }}
        />
      </Section>
    </Screen>
  );
}
