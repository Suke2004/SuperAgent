/**
 * Model detail.
 *
 * Where the hand-editable half of the registry lives. Every flag here changes what
 * the rest of the app will *offer*: turning off `tools` removes the model from
 * MCP-enabled conversations, and `contextWindow` drives the pressure indicator, so
 * a wrong value shows up as a bad warning rather than a silent failure.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import {
  Badge,
  Body,
  Button,
  Field,
  Inline,
  Note,
  Row,
  Screen,
  Section,
  Stack,
  Stepper,
  SwitchRow,
} from '@/components/ui';
import { useModels } from '@/stores/models';
import { useProviders } from '@/stores/providers';
import { useTheme } from '@/theme';

export default function ModelDetail() {
  const t = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ key: string }>();
  const key = decodeURIComponent(params.key ?? '');

  const entry = useModels((s) => s.entries[key]);
  const updateCapabilities = useModels((s) => s.updateCapabilities);
  const updateWireHints = useModels((s) => s.updateWireHints);
  const setPricing = useModels((s) => s.setPricing);
  const setHidden = useModels((s) => s.setHidden);
  const resetToGuess = useModels((s) => s.resetToGuess);
  const remove = useModels((s) => s.remove);
  const profiles = useProviders((s) => s.profiles);

  const [inputPrice, setInputPrice] = useState(entry?.pricing ? String(entry.pricing.inputPerMTok) : '');
  const [outputPrice, setOutputPrice] = useState(entry?.pricing ? String(entry.pricing.outputPerMTok) : '');

  if (!entry) {
    return (
      <Screen>
        <Note tone="danger">That model is no longer in the registry.</Note>
        <View style={{ marginTop: t.spacing.md }}>
          <Button label="Back to models" onPress={() => router.replace('/settings/models')} />
        </View>
      </Screen>
    );
  }

  const profile = profiles.find((p) => p.id === entry.profileId);
  const isAnthropic = profile?.kind === 'anthropic';
  const caps = entry.capabilities;

  function commitPricing() {
    const input = Number.parseFloat(inputPrice);
    const output = Number.parseFloat(outputPrice);
    if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
      setPricing(key, { inputPerMTok: input, outputPerMTok: output });
    } else if (!inputPrice.trim() && !outputPrice.trim()) {
      setPricing(key, undefined);
    }
  }

  return (
    <Screen>
      <Stack gap="lg">
        <View style={{ gap: t.spacing.xs }}>
          <Body size="lg" weight="700" mono selectable>
            {entry.id}
          </Body>
          <Inline gap="sm">
            <Badge label={profile?.name ?? 'Orphaned profile'} tone="accent" />
            {entry.guessed ? <Badge label="Flags guessed" tone="warning" /> : <Badge label="Flags set by you" tone="success" />}
            {entry.present ? <Badge label="Listed by gateway" tone="success" /> : <Badge label="Unlisted" tone="warning" />}
          </Inline>
          {entry.ownedBy ? (
            <Body size="sm" tone="faint">{`owned_by: ${entry.ownedBy}`}</Body>
          ) : null}
        </View>

        {entry.guessed ? (
          <Note>
            These flags were inferred from the model id, not reported by the gateway. `/v1/models` returns almost no
            metadata, so anything below may be wrong — correcting it here is what makes the controls and the context
            warnings accurate.
          </Note>
        ) : null}

        <Section title="Capabilities">
          <SwitchRow
            first
            label="Vision"
            subtitle="Allows image attachments. Off blocks the composer's attach button with an explanation."
            value={caps.vision}
            onChange={(v) => updateCapabilities(key, { vision: v })}
          />
          <SwitchRow
            label="Documents"
            subtitle={
              isAnthropic
                ? 'Allows native PDF and text document blocks for this model.'
                : 'Used when importing documents into a conversation.'
            }
            value={caps.documents}
            onChange={(v) => updateCapabilities(key, { documents: v })}
          />
          <SwitchRow
            label="Tool use"
            subtitle="Required for skills and MCP tools."
            value={caps.tools}
            onChange={(v) => updateCapabilities(key, { tools: v })}
          />
          <SwitchRow
            label="Reasoning"
            subtitle={
              isAnthropic
                ? 'Enables the extended-thinking budget slider on this transport.'
                : 'Enables the reasoning_effort selector. Sent only for models flagged here.'
            }
            value={caps.reasoning}
            onChange={(v) => updateCapabilities(key, { reasoning: v })}
          />
          <SwitchRow
            label="Extended effort ladder"
            subtitle="Accepts xhigh and max. Where thinking cannot be disabled — that combination is a 400."
            value={caps.extendedEffort ?? false}
            onChange={(v) => updateCapabilities(key, { extendedEffort: v })}
            disabled={!caps.reasoning || !isAnthropic}
            disabledReason={
              !isAnthropic
                ? 'The effort ladder above high is an Anthropic-path concept. The OpenAI path takes reasoning_effort instead.'
                : 'Turn Reasoning on first.'
            }
          />
        </Section>

        <Section title="Limits" note="Context window drives the pressure indicator; max output is the ceiling the sampling controls clamp to.">
          <Stepper
            first
            label="Context window"
            value={caps.contextWindow}
            onChange={(v) => updateCapabilities(key, { contextWindow: v })}
            step={16_000}
            min={4_000}
            max={2_000_000}
            format={(v) => `${Math.round(v / 1000)}k`}
          />
          <Stepper
            label="Max output tokens"
            value={caps.maxOutputTokens}
            onChange={(v) => updateCapabilities(key, { maxOutputTokens: v })}
            step={4_096}
            min={1_024}
            max={200_000}
            format={(v) => v.toLocaleString()}
          />
        </Section>

        <Section
          title="Wire quirks"
          note="Only matters on the OpenAI path. A wrong setting costs one extra round trip: the adapter renames and retries once, then tells you which parameter it changed."
        >
          <SwitchRow
            first
            label="Use max_completion_tokens"
            subtitle="Newer reasoning families reject max_tokens outright."
            value={entry.wireHints.maxTokensField === 'max_completion_tokens'}
            onChange={(v) => updateWireHints(key, { maxTokensField: v ? 'max_completion_tokens' : 'max_tokens' })}
            disabled={isAnthropic}
            disabledReason="The Anthropic path always uses max_tokens; there is no alias."
          />
        </Section>

        <Section
          title="Pricing (estimate)"
          note="Per million tokens, in whatever currency your gateway bills. Typed in by hand: the gateway does not publish its rates, so nothing here is checked against what it actually charges — every cost in the app is an estimate from these two numbers. Left blank, usage is reported in tokens with no cost at all rather than a guess."
        >
          <Stack gap="md" style={{ padding: t.spacing.md }}>
            <Inline gap="md" wrap={false}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Input / MTok"
                  value={inputPrice}
                  onChangeText={setInputPrice}
                  onBlur={commitPricing}
                  keyboardType="decimal-pad"
                  mono
                  placeholder="0.00"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Output / MTok"
                  value={outputPrice}
                  onChangeText={setOutputPrice}
                  onBlur={commitPricing}
                  keyboardType="decimal-pad"
                  mono
                  placeholder="0.00"
                />
              </View>
            </Inline>
            {entry.pricing ? (
              <Body size="xs" tone="faint">
                {`Saved: ${entry.pricing.inputPerMTok} in / ${entry.pricing.outputPerMTok} out per million tokens.`}
              </Body>
            ) : null}
          </Stack>
        </Section>

        <Section title="Visibility">
          <SwitchRow
            first
            label="Hide from the model picker"
            subtitle="Keeps the flags and pricing; just stops offering it."
            value={entry.hidden}
            onChange={(v) => setHidden(key, v)}
          />
          <Row
            label="Reset flags to the guess"
            subtitle="Re-derives capabilities and wire hints from the model id"
            onPress={() => resetToGuess(key)}
          />
          <Row
            destructive
            label="Remove from registry"
            subtitle="A refresh will re-add it if the gateway still lists it"
            onPress={() =>
              Alert.alert('Remove model', `Forget ${entry.id} and its flags?`, [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Remove',
                  style: 'destructive',
                  onPress: () => {
                    remove(key);
                    router.back();
                  },
                },
              ])
            }
          />
        </Section>
      </Stack>
    </Screen>
  );
}
