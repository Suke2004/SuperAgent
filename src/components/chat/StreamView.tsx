/**
 * The live turn, rendered as the transcript's footer.
 *
 * Separate from {@link MessageView} because a stream is not a message yet: it has
 * a phase, an elapsed clock, half-parsed tool arguments, and no id. Trying to make
 * one component serve both would mean a `StoredMessage` with most of its fields
 * optional, and every consumer then guessing which state it was in.
 *
 * The phase label is the point of this component. A request that is being prepared,
 * summarised, connected, retried, streamed or saved all look identical from outside —
 * a spinner — and they fail for entirely different reasons. Naming the phase turns
 * "it's stuck" into "it's stuck connecting", which is actionable. A backoff wait goes
 * further and shows the gateway's reason plus a countdown, because a silent 20-second
 * sleep is the single most convincing impression of a hang this app can give.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CodeBlock } from '@/components/markdown/CodeBlock';
import { Markdown } from '@/components/markdown/Markdown';
import { Glyph } from '@/components/Glyph';
import { Badge, Body, Button, Inline, Note } from '@/components/ui';
import { APP_NAME } from '@/lib/app';
import { estimateTextTokens } from '@/lib/tokens';
import { formatDuration, formatRate } from '@/lib/when';
import type { RetryState, StreamPhase, StreamState } from '@/stores/chat';
import { useTheme } from '@/theme';

const PHASE_LABEL: Record<StreamPhase, string> = {
  preparing: 'Preparing the request',
  summarising: 'Summarising older messages',
  connecting: 'Connecting',
  retrying: 'Waiting to retry',
  streaming: 'Streaming',
  tools: 'Running tools',
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

/**
 * Whole seconds left on a backoff sleep, or `undefined` when nothing is waiting.
 *
 * A wait with no visible clock is the same "is it stuck?" problem the phase label
 * solves, one level down: "retrying in 8s" is a promise the UI can be held to, while
 * "retrying" is not. Ticks at 250ms so the number does not appear to skip.
 */
function useRetryCountdown(retry: RetryState | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  const at = retry?.at;

  useEffect(() => {
    if (at === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [at]);

  if (!retry) return undefined;
  // `now` can be older than this wait, because the first render after a retry is
  // scheduled happens before the interval has ticked. Clamped to the full delay
  // rather than resetting the clock from inside the effect: a stale `now` would
  // otherwise read as *more* than the wait actually is.
  const remaining = Math.min(retry.delayMs, retry.at + retry.delayMs - now);
  return Math.max(0, Math.ceil(remaining / 1000));
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
  onEditRequest,
}: {
  stream: StreamState;
  showThinking: boolean;
  onStop: () => void;
  onDismiss: () => void;
  onRetry?: () => void;
  /**
   * Opens the sampling controls.
   *
   * "Try again" is the wrong and only answer when the failure was caused by the
   * request itself — a temperature the gateway refuses, a thinking budget above
   * `max_tokens` — because retrying an invalid request reproduces the error. This
   * puts the thing that has to change one tap from the message saying it is wrong.
   */
  onEditRequest?: () => void;
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

  // Time to first byte, frozen once it lands. It is the number that separates "the
  // gateway is slow to answer" from "the model is slow to write", and after the fact
  // the total duration cannot tell you which of the two you waited on.
  const ttft = stream.firstByteAt === undefined ? undefined : stream.firstByteAt - stream.startedAt;
  const remaining = useRetryCountdown(failed ? undefined : stream.retry);

  const phase = stream.aborting ? 'Stopping' : PHASE_LABEL[stream.phase];
  const shownRate = rate ? (reported === undefined ? `~${rate}` : rate) : undefined;

  return (
    // Same gutter as a stored assistant turn, so the live reply does not shift
    // sideways the moment it is saved. The mark in the gutter is the only moving
    // thing on the screen: it turns while the model works and stops when it stops.
    <View style={{ flexDirection: 'row', gap: t.spacing.md }}>
      <Glyph
        size={20}
        state={failed ? 'error' : 'thinking'}
        style={{ marginTop: 2 }}
        label={failed ? `${APP_NAME}, failed turn` : `${APP_NAME} is working`}
      />
      <View style={{ flex: 1, minWidth: 0, gap: t.spacing.sm }}>
        <Inline gap="sm">
          {failed ? (
            <Badge label="Failed" tone="danger" />
          ) : (
            <Body size="xs" tone="dim" live>
              {phase}
            </Body>
          )}
          <Body size="xs" tone="faint" mono>
            {formatDuration(elapsed)}
          </Body>
          {ttft !== undefined ? (
            <Body size="xs" tone="faint" mono accessibilityLabel={`First byte after ${formatDuration(ttft)}`}>
              {`${formatDuration(ttft)} to first byte`}
            </Body>
          ) : null}
          {/* While streaming, the rate rides on the Stop pill instead — one reading of
              it per screen. Once the turn has failed there is no pill to carry it. */}
          {failed && shownRate ? (
            <Body size="xs" tone="faint" mono>
              {shownRate}
            </Body>
          ) : null}
          <Badge label={stream.model} tone="neutral" />
        </Inline>

        {/* The backoff, named and counted down. Live so a screen reader hears the wait
            start rather than discovering it on the next swipe. */}
        {stream.retry && !failed ? (
          <Note tone="warning" live>
            {`Attempt ${stream.retry.attempt} failed: ${stream.retry.message} · retrying${
              remaining ? ` in ${remaining}s` : ' now'
            }.`}
          </Note>
        ) : null}

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
              {onEditRequest ? (
                <Button label="Edit request" onPress={onEditRequest} variant="ghost" size="sm" />
              ) : null}
              <Button label="Dismiss" onPress={onDismiss} variant="ghost" size="sm" />
            </>
          ) : (
            <Button
              label={
                stream.aborting ? 'Stopping…' : shownRate ? `Stop · ${shownRate}` : 'Stop'
              }
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
    </View>
  );
}
