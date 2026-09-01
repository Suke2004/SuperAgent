/**
 * Debug log.
 *
 * A ring buffer of requests and messages, kept in memory only, with the API key
 * redacted at the point of writing rather than on display — so the buffer itself
 * never holds a secret, and neither does anything copied out of it.
 */

import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { Badge, Body, Button, Empty, Inline, MIN_TARGET, Note, Screen, Section, Stack } from '@/components/ui';
import { debugLog, safeStringify } from '@/lib/log';
import type { DebugEntry, RequestEntry } from '@/lib/log';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme';

function statusTone(entry: RequestEntry): 'success' | 'danger' | 'warning' | 'neutral' {
  if (entry.error) return 'danger';
  if (entry.status === undefined) return 'neutral';
  if (entry.status >= 500) return 'danger';
  if (entry.status === 429) return 'warning';
  if (entry.status >= 400) return 'danger';
  return 'success';
}

/**
 * One log entry, collapsed to a line until asked.
 *
 * Every row here is expandable and nothing said so: no role, no state, and no
 * chevron, so the only way to find the bodies and headers was to tap a row that
 * looked like static text and see what happened. A screen reader had it worse —
 * "429 12:04 anthropic POST https://…" with no hint that there was anything else.
 *
 * `defaultOpen` exists because the newest entry is the reason the screen was opened.
 * State is per-mounted-card and cards are keyed by entry id, so a newer entry
 * arriving opens itself without collapsing whatever the user was already reading.
 */
function EntryCard({ entry, defaultOpen = false }: { entry: DebugEntry; defaultOpen?: boolean }) {
  const t = useTheme();
  const [open, setOpen] = useState(defaultOpen);
  const time = new Date(entry.at).toLocaleTimeString();

  /** `▾`/`▸` plus the state on the row itself, because the glyph alone is decoration. */
  const chevron = (
    <Body size="xs" tone="faint" accessibilityLabel={open ? 'Expanded' : 'Collapsed'}>
      {open ? '▾' : '▸'}
    </Body>
  );

  if (entry.kind === 'message') {
    const tone = entry.level === 'error' ? 'danger' : entry.level === 'warn' ? 'warning' : 'neutral';
    const expandable = entry.data !== undefined;
    return (
      <Pressable
        onPress={expandable ? () => setOpen((v) => !v) : undefined}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityState={expandable ? { expanded: open } : undefined}
        accessibilityHint={expandable ? (open ? 'Hides the logged data' : 'Shows the logged data') : undefined}
        style={{ paddingVertical: t.spacing.sm, gap: 4, minHeight: expandable ? MIN_TARGET : undefined }}
      >
        <Inline gap="sm">
          {expandable ? chevron : null}
          <Badge label={entry.level} tone={tone} />
          <Body size="xs" tone="faint">
            {time}
          </Body>
          <Body size="xs" tone="dim" weight="700">
            {entry.scope}
          </Body>
        </Inline>
        <Body size="sm" selectable>
          {entry.message}
        </Body>
        {open && entry.data !== undefined ? (
          <Body size="xs" tone="faint" mono selectable>
            {safeStringify(entry.data, 2)}
          </Body>
        ) : null}
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={() => setOpen((v) => !v)}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityHint={open ? 'Hides the headers and bodies' : 'Shows the headers, request and response bodies'}
      style={{ paddingVertical: t.spacing.sm, gap: 4, minHeight: MIN_TARGET }}
    >
      <Inline gap="sm">
        {chevron}
        <Badge
          label={entry.status !== undefined ? String(entry.status) : entry.error ? 'error' : '…'}
          tone={statusTone(entry)}
        />
        <Body size="xs" tone="faint">
          {time}
        </Body>
        <Body size="xs" tone="dim" weight="700">
          {entry.transport}
        </Body>
        {entry.durationMs !== undefined ? (
          <Body size="xs" tone="faint">{`${entry.durationMs} ms`}</Body>
        ) : null}
        {entry.streamEvents !== undefined ? (
          <Body size="xs" tone="faint">{`${entry.streamEvents} events`}</Body>
        ) : null}
        {entry.droppedParam ? <Badge label={`dropped ${entry.droppedParam}`} tone="warning" /> : null}
        {entry.retryOf ? <Badge label="retry" tone="neutral" /> : null}
      </Inline>
      <Body size="sm" mono numberOfLines={open ? undefined : 1} selectable>
        {`${entry.method} ${entry.url}`}
      </Body>
      {open ? (
        <Stack gap="sm" style={{ marginTop: t.spacing.xs }}>
          {entry.gatewayRequestId ? (
            <Body size="xs" tone="faint" mono selectable>
              {`Request-Id: ${entry.gatewayRequestId}`}
            </Body>
          ) : null}
          <Body size="xs" tone="dim" mono selectable>
            {safeStringify(entry.headers, 2)}
          </Body>
          {entry.body !== undefined ? (
            <Body size="xs" tone="faint" mono selectable>
              {safeStringify(entry.body, 2)}
            </Body>
          ) : null}
          {entry.error ? <Note tone="danger" mono>{entry.error}</Note> : null}
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
      ) : null}
    </Pressable>
  );
}

export default function DebugScreen() {
  const t = useTheme();
  const enabled = useSettings((s) => s.debugLogEnabled);
  const [entries, setEntries] = useState<DebugEntry[]>(() => debugLog.getEntries());
  const [copied, setCopied] = useState(false);

  useEffect(() => debugLog.subscribe(setEntries), []);

  const newestFirst = [...entries].reverse();

  return (
    <Screen>
      {enabled ? null : (
        <View style={{ marginBottom: t.spacing.md }}>
          <Note tone="warning">
            The debug log is turned off, so nothing new is being recorded. Settings → Diagnostics.
          </Note>
        </View>
      )}

      <Inline gap="md" style={{ marginBottom: t.spacing.md }}>
        <Button
          label={copied ? 'Copied' : 'Copy all'}
          variant="primary"
          disabled={entries.length === 0}
          disabledReason="Nothing logged yet."
          onPress={() => {
            void Clipboard.setStringAsync(debugLog.toText());
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        />
        <Button
          label="Clear"
          variant="danger"
          disabled={entries.length === 0}
          disabledReason="Nothing logged yet."
          onPress={() => debugLog.clear()}
        />
      </Inline>

      <Note>
        Kept in memory only — never written to disk or uploaded. The API key is replaced with a fingerprint before
        anything enters the buffer, so copying this out is safe.
      </Note>

      <View style={{ height: t.spacing.md }} />

      <Section title={`Entries (${entries.length})`}>
        {newestFirst.length === 0 ? (
          <Empty icon="diagnostics" title="Nothing logged yet" body="Run a connection test or send a message, then come back." />
        ) : (
          newestFirst.map((entry, index) => (
            <View
              key={entry.id}
              style={{
                paddingHorizontal: t.spacing.md,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: t.colors.border,
              }}
            >
              <EntryCard entry={entry} defaultOpen={index === 0} />
            </View>
          ))
        )}
      </Section>
    </Screen>
  );
}
