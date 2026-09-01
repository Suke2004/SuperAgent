/**
 * What one reply actually cost and what actually went over the wire.
 *
 * This is the developer's screen, reached from a message's ⋯ menu once
 * `devPanelEnabled` is on. It exists because the two questions that matter when a
 * prompt misbehaves — *what did you send* and *what came back* — cannot be answered
 * from the transcript, and the global debug log answers them for the whole session at
 * once, which is a different and much worse experience when the thing you are
 * comparing is turn 4 against turn 6.
 *
 * The bodies are read from `@/lib/log`'s ring buffer by the ids the turn recorded in
 * `meta.requestIds`. Two consequences, both stated on screen rather than hidden:
 * a restart empties the buffer, and turning the debug log off means nothing was
 * recorded in the first place.
 */

import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Badge, Body, Button, Empty, Inline, Note, Screen, Section, Stack } from '@/components/ui';
import { toCurl } from '@/lib/curl';
import * as haptics from '@/lib/haptics';
import { debugLog, safeStringify } from '@/lib/log';
import type { DebugEntry, RequestEntry } from '@/lib/log';
import { useChat } from '@/stores/chat';
import { useSettings } from '@/stores/settings';
import { formatTokens } from '@/lib/tokens';
import { useTheme } from '@/theme';

/** A copy button that says it worked, since the clipboard gives no feedback of its own. */
function CopyButton({ label, text, variant = 'secondary' }: { label: string; text: string; variant?: 'primary' | 'secondary' }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      label={copied ? 'Copied' : label}
      variant={variant}
      onPress={() => {
        void Clipboard.setStringAsync(text);
        haptics.confirm();
        setCopied(true);
      }}
    />
  );
}

function isRequest(entry: DebugEntry): entry is RequestEntry {
  return entry.kind === 'request';
}

/** One HTTP request in full. Nothing is collapsed: this screen was opened to read it. */
function RequestCard({ entry, index }: { entry: RequestEntry; index: number }) {
  const t = useTheme();
  return (
    <Stack gap="sm" style={{ paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm }}>
      <Inline gap="sm">
        <Badge
          label={entry.status !== undefined ? String(entry.status) : entry.error ? 'error' : '…'}
          tone={entry.error || (entry.status ?? 0) >= 400 ? 'danger' : entry.status ? 'success' : 'neutral'}
        />
        <Body size="xs" tone="dim" weight="700">{`attempt ${index + 1}`}</Body>
        {entry.durationMs !== undefined ? (
          <Body size="xs" tone="faint">{`${entry.durationMs} ms`}</Body>
        ) : null}
        {entry.streamEvents !== undefined ? (
          <Body size="xs" tone="faint">{`${entry.streamEvents} events`}</Body>
        ) : null}
        {entry.droppedParam ? <Badge label={`dropped ${entry.droppedParam}`} tone="warning" /> : null}
        {entry.retryOf ? <Badge label="retry" tone="neutral" /> : null}
      </Inline>

      <Body size="sm" mono selectable>{`${entry.method} ${entry.url}`}</Body>
      {entry.gatewayRequestId ? (
        <Body size="xs" tone="faint" mono selectable>{`Request-Id: ${entry.gatewayRequestId}`}</Body>
      ) : null}

      <Inline gap="sm">
        <CopyButton label="Copy as curl" text={toCurl(entry)} variant="primary" />
        {entry.body !== undefined ? <CopyButton label="Copy request" text={safeStringify(entry.body, 2)} /> : null}
        {entry.responseBody !== undefined ? (
          <CopyButton label="Copy response" text={safeStringify(entry.responseBody, 2)} />
        ) : null}
      </Inline>

      <Body size="xs" tone="dim" mono selectable>
        {safeStringify(entry.headers, 2)}
      </Body>
      {entry.body !== undefined ? (
        <Body size="xs" tone="faint" mono selectable>
          {safeStringify(entry.body, 2)}
        </Body>
      ) : null}
      {entry.error ? (
        <Note tone="danger" mono>
          {entry.error}
        </Note>
      ) : null}
      {entry.responseBody !== undefined ? (
        <Body size="xs" tone="faint" mono selectable>
          {safeStringify(entry.responseBody, 2)}
        </Body>
      ) : null}
      {entry.streamSample ? (
        <Body size="xs" tone="faint" mono selectable>
          {entry.streamSample}
        </Body>
      ) : null}
    </Stack>
  );
}

export default function InspectScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ c?: string; m?: string }>();
  const conversationId = params.c ?? '';
  const messageId = params.m ?? '';
  const message = useChat((state) => state.messages[conversationId]?.find((row) => row.id === messageId));
  const logEnabled = useSettings((s) => s.debugLogEnabled);

  const [entries, setEntries] = useState<DebugEntry[]>(() => debugLog.getEntries());
  useEffect(() => debugLog.subscribe(setEntries), []);

  if (!message) {
    return (
      <Screen>
        <Empty icon="info" title="That message is gone" body="It was deleted while this screen was open." />
        <View style={{ height: t.spacing.md }} />
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  const ids = message.meta?.requestIds ?? [];
  const requests = entries.filter(isRequest).filter((entry) => ids.includes(entry.id));
  const usage = message.usage ?? {};
  const facts: [string, string][] = [
    ['model', message.model ?? '—'],
    ['stop reason', message.stopReason ?? '—'],
    ['sent', new Date(message.createdAt).toLocaleString()],
    ['input', usage.input === undefined ? 'not reported' : formatTokens(usage.input)],
    ['output', usage.output === undefined ? 'not reported' : formatTokens(usage.output)],
    ['cache read', usage.cacheRead === undefined ? '—' : formatTokens(usage.cacheRead)],
    ['cache write', usage.cacheWrite === undefined ? '—' : formatTokens(usage.cacheWrite)],
    ['latency', requests.length ? `${requests.reduce((sum, r) => sum + (r.durationMs ?? 0), 0)} ms` : '—'],
    ['requests', String(ids.length)],
  ];

  return (
    <Screen>
      <Section title="This turn">
        <Stack gap="xs" style={{ paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm }}>
          {facts.map(([label, value]) => (
            <Inline key={label} gap="sm">
              <Body size="xs" tone="faint" style={{ width: 96 }}>
                {label}
              </Body>
              <Body size="sm" mono selectable>
                {value}
              </Body>
            </Inline>
          ))}
        </Stack>
      </Section>

      <View style={{ height: t.spacing.md }} />

      {ids.length === 0 ? (
        <Note tone={logEnabled ? 'info' : 'warning'}>
          {logEnabled
            ? 'This reply was written before the developer panel existed, or it never reached the network.'
            : 'The debug log is off, so this turn recorded nothing. Settings → Diagnostics.'}
        </Note>
      ) : requests.length === 0 ? (
        <Note tone="warning">
          The bodies are gone: the log is kept in memory only, and it is emptied by a restart and trimmed once it is
          full. Send the message again to capture it.
        </Note>
      ) : (
        <Section title={`Requests (${requests.length})`}>
          {requests.map((entry, index) => (
            <View
              key={entry.id}
              style={{ borderTopWidth: index === 0 ? 0 : 1, borderTopColor: t.colors.border }}
            >
              <RequestCard entry={entry} index={index} />
            </View>
          ))}
        </Section>
      )}

      <View style={{ height: t.spacing.md }} />
      <Note>The API key is redacted before anything enters the log, so everything on this screen is safe to paste.</Note>
    </Screen>
  );
}
