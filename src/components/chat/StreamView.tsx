/**
 * The live turn, rendered as the transcript's footer.
 *
 * Separate from {@link MessageView} because a stream is not a message yet: it has
 * a phase, an elapsed clock, half-parsed tool arguments, and no id. Trying to make
 * one component serve both would mean a `StoredMessage` with most of its fields
 * optional, and every consumer then guessing which state it was in.
 *
 * The phase label is the point of this component. A request that is being prepared,
 * summarised, connected, streamed or saved all look identical from outside — a
 * spinner — and the four of them fail for entirely different reasons. Naming the
 * phase turns "it's stuck" into "it's stuck connecting", which is actionable.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CodeBlock } from '@/components/markdown/CodeBlock';
import { Markdown } from '@/components/markdown/Markdown';
import { Badge, Body, Button, Inline, Note, Spinner } from '@/components/ui';
import { estimateTextTokens } from '@/lib/tokens';
import { formatDuration, formatRate } from '@/lib/when';
import type { StreamPhase, StreamState } from '@/stores/chat';
import { useTheme } from '@/theme';

const PHASE_LABEL: Record<StreamPhase, string> = {
  preparing: 'Preparing the request',
  summarising: 'Summarising older messages',
  connecting: 'Connecting',
  streaming: 'Streaming',
  saving: 'Saving',
};

/**
 * A clock that ticks while a stream is open.
 *
 * One interval per open stream, and there is at most one open stream per
 * conversation, so this is not the fifty-timers problem it would be in a row.
 *
 * When `running` goes false the ticking stops and the elapsed time freezes at the
 * failure, which is what you want to read afterwards. A restart moves `startedAt`
 * forward past the last tick, and the clamp below reports that as zero until the
 * next second lands — correct, and cheaper than re-seeding from an effect.
 */
function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  return Math.max(0, now - startedAt);
}

function PartialTool({ name, partialJson }: { name: string; partialJson: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.spacing.xs }}>
      <Inline gap="sm">
        <Badge label="Tool" tone="accent" />
        <Body size="sm" mono weight="600">
          {name || 'unnamed'}
        </Body>
        <Body size="xs" tone="faint">
          arguments arriving
        </Body>
      </Inline>
      {partialJson ? <CodeBlock code={partialJson} lang="json" /> : null}
    </View>
  );
}

/**
 * Live thinking.
 *
 * Always expanded, unlike a stored thinking block. While a stream is running the
 * thinking is the only thing on screen, and collapsing it would leave a spinner
 * and nothing else for however long the model deliberates.
 */
function LiveThinking({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.colors.thinkingBg,
        borderColor: t.colors.thinkingBorder,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: t.radius.md,
        padding: t.spacing.sm,
        gap: t.spacing.xs,
      }}
    >
      <Badge label="Thinking" tone="neutral" />
      <Body
        size="sm"
        style={{ color: t.colors.thinkingText, lineHeight: Math.round(t.fontSize.sm * 1.5) }}
      >
        {text}
      </Body>
    </View>
  );
}

export function StreamView({
  stream,
  showThinking,
  onStop,
  onDismiss,
  onRetry,
}: {
  stream: StreamState;
  showThinking: boolean;
  onStop: () => void;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  const t = useTheme();
  const failed = stream.error !== undefined;
  const elapsed = useElapsed(stream.startedAt, !failed);

  // The gateway reports output tokens on its own schedule — Anthropic mid-stream,
  // OpenAI only at the end — so the count is estimated until it arrives, and the
  // tilde says which of the two you are looking at.
  const reported = stream.usage.output;
  const tokens = reported ?? estimateTextTokens(stream.text + stream.thinking);
  const rate = formatRate(tokens, elapsed);

  const phase = stream.aborting ? 'Stopping' : PHASE_LABEL[stream.phase];

  return (
    <View style={{ gap: t.spacing.sm }}>
      <Inline gap="sm">
        {failed ? <Badge label="Failed" tone="danger" /> : <Spinner label={phase} />}
        <Body size="xs" tone="faint" mono>
          {formatDuration(elapsed)}
        </Body>
        {rate ? (
          <Body size="xs" tone="faint" mono>
            {reported === undefined ? `~${rate}` : rate}
          </Body>
        ) : null}
        <Badge label={stream.model} tone="neutral" />
      </Inline>

      {stream.thinking && showThinking ? <LiveThinking text={stream.thinking} /> : null}
      {stream.text ? <Markdown source={stream.text} /> : null}

      {stream.toolCalls.map((call) => (
        <PartialTool key={call.id} name={call.name} partialJson={call.partialJson} />
      ))}

      {stream.failover ? (
        <Note tone="warning">
          {`${stream.failover.from} was unreachable; retrying against ${stream.failover.to}.`}
        </Note>
      ) : null}

      {stream.droppedParams.map((dropped) => (
        <Note key={dropped.param} tone="warning">
          {`${dropped.param} was rejected and dropped: ${dropped.message}`}
        </Note>
      ))}

      {/* Verbatim. The gateway's wording names the actual problem. */}
      {stream.error ? <Note tone="danger" mono>{stream.error}</Note> : null}

      <Inline gap="sm">
        {failed ? (
          <>
            {onRetry ? <Button label="Try again" onPress={onRetry} variant="secondary" size="sm" /> : null}
            <Button label="Dismiss" onPress={onDismiss} variant="ghost" size="sm" />
          </>
        ) : (
          <Button
            label={stream.aborting ? 'Stopping…' : 'Stop'}
            onPress={onStop}
            variant="secondary"
            size="sm"
            disabled={stream.aborting}
            {...(stream.aborting
              ? { disabledReason: 'Waiting for the connection to close.' }
              : {})}
          />
        )}
      </Inline>
    </View>
  );
}
