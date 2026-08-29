/**
 * One stored message in the transcript.
 *
 * The interesting decisions are about what the row admits to. A message that was
 * truncated at `max_tokens`, retried without `temperature`, sent to a fallback
 * base URL, or excluded from the context window looks exactly like a normal one
 * unless the row says so — and each of those changes what the reply means. So the
 * badges and notes here are not decoration; they are the difference between a
 * transcript you can reason about and one you can only read.
 *
 * Errors are shown verbatim. The gateway's own message names the actual problem
 * ("model not found", "credit balance too low", a rejected parameter), and
 * replacing it with "Something went wrong" would discard the only useful thing in
 * the response.
 */

import { memo } from 'react';
import { Pressable, View } from 'react-native';

import { ContentBlocks } from '@/components/chat/ContentBlocks';
import { Badge, Body, Inline, MIN_TARGET, Note, verticalSlop } from '@/components/ui';
import type { StoredMessage } from '@/db/conversations';
import { estimateCost, formatCost, formatUsage } from '@/lib/tokens';
import type { ModelPricing } from '@/lib/tokens';
import { whenBucket } from '@/lib/when';
import { useTheme } from '@/theme';
import type { StopReason } from '@/transports/types';

/** A bubble that reaches the far edge stops reading as one side of a dialogue. */
const BUBBLE_MAX_WIDTH = '86%';

function formatWhen(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (whenBucket(at, now) === 'today') return time;
  return `${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * The stop reasons worth interrupting the reader for.
 *
 * `end_turn` and `tool_use` are the normal ones and say nothing. The rest each
 * mean the text above is not the whole answer.
 */
function stopNote(reason: StopReason | undefined): { tone: 'warning' | 'danger' | 'info'; text: string } | null {
  switch (reason) {
    case 'max_tokens':
      return {
        tone: 'warning',
        text: 'Cut off at the output limit — this reply is incomplete. Raise max tokens for this conversation, or ask it to continue.',
      };
    case 'stop_sequence':
      return { tone: 'info', text: 'Ended at one of your stop sequences.' };
    case 'content_filter':
      return { tone: 'danger', text: 'The provider stopped this reply on a content filter.' };
    case 'pause_turn':
      return {
        tone: 'info',
        text: 'The model paused a long turn and expects to be asked to continue. This is not the end of its answer.',
      };
    case 'aborted':
      return { tone: 'info', text: 'You stopped this reply.' };
    default:
      return null;
  }
}

function MetaBadges({ message }: { message: StoredMessage }) {
  const meta = message.meta;
  const badges: { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }[] = [];

  if (message.excluded) badges.push({ label: 'Excluded from context', tone: 'warning' });
  if (meta?.editedAt !== undefined) badges.push({ label: 'Edited', tone: 'neutral' });
  if (meta?.regeneratedFrom !== undefined) badges.push({ label: 'Regenerated', tone: 'neutral' });
  if (meta?.aborted) badges.push({ label: 'Stopped', tone: 'warning' });
  if (meta?.modelOverride && message.model) badges.push({ label: message.model, tone: 'accent' });
  if (meta?.effort !== undefined) badges.push({ label: `Effort: ${meta.effort}`, tone: 'neutral' });
  if (meta?.toolRounds !== undefined && meta.toolRounds > 0) {
    badges.push({ label: meta.toolRounds === 1 ? '1 tool round' : `${meta.toolRounds} tool rounds`, tone: 'neutral' });
  }
  for (const skill of meta?.skillsInvoked ?? []) badges.push({ label: skill, tone: 'accent' });

  if (badges.length === 0) return null;

  return (
    <Inline gap="xs">
      {badges.map((badge) => (
        <Badge key={badge.label} label={badge.label} tone={badge.tone} />
      ))}
    </Inline>
  );
}

function Footer({
  message,
  now,
  pricing,
  onExplainCost,
}: {
  message: StoredMessage;
  now: number;
  pricing?: ModelPricing;
  onExplainCost?: (message: StoredMessage) => void;
}) {
  const usage = message.usage;
  const cost = usage ? estimateCost(usage, pricing) : null;
  const parts = [formatWhen(message.createdAt, now)];
  const reported = usage ? formatUsage(usage) : '';
  if (reported) parts.push(reported);
  // Assistant turns always have a token cost; an assistant row with no usage means
  // the gateway did not say what it was, and that is worth one word rather than a
  // silent gap that reads like a free reply.
  else if (message.role === 'assistant' && !message.error) parts.push('tokens not reported');
  if (cost) parts.push(`~$${formatCost(cost.total)}`);

  const label = parts.join('  ·  ');

  // The cost is an estimate from a hand-maintained price table, and the `~` alone
  // does not say so. Tapping it opens the explanation rather than putting a
  // paragraph of caveat in every row.
  if (cost && onExplainCost) {
    return (
      <Pressable
        onPress={() => onExplainCost(message)}
        accessibilityRole="button"
        accessibilityLabel={`${label}. Estimated cost.`}
        accessibilityHint="Explains how this estimate was calculated"
        hitSlop={verticalSlop(MIN_TARGET)}
      >
        <Body size="xs" tone="faint">
          {label}
        </Body>
      </Pressable>
    );
  }

  return (
    <Body size="xs" tone="faint">
      {label}
    </Body>
  );
}

function MessageViewInner({
  message,
  now,
  pricing,
  thinkingExpanded,
  onAction,
  onExplainCost,
}: {
  message: StoredMessage;
  now: number;
  pricing?: ModelPricing;
  thinkingExpanded: boolean;
  onAction?: (message: StoredMessage) => void;
  onExplainCost?: (message: StoredMessage) => void;
}) {
  const t = useTheme();

  // A tool result comes back as a `user` message by API convention, but it is not
  // something the user said. Rendering it in the user's bubble would misattribute
  // machine output to a person.
  const isToolTurn =
    message.content.length > 0 && message.content.every((block) => block.type === 'tool_result');
  const asUser = message.role === 'user' && !isToolTurn;

  const stop = stopNote(message.stopReason);
  const dropped = message.meta?.droppedParams ?? [];

  const body = (
    <View style={{ gap: t.spacing.xs }}>
      <MetaBadges message={message} />
      <ContentBlocks blocks={message.content} thinkingExpanded={thinkingExpanded} />

      {message.error ? <Note tone="danger" mono>{message.error}</Note> : null}
      {stop ? <Note tone={stop.tone}>{stop.text}</Note> : null}
      {dropped.length > 0 ? (
        <Note tone="warning">
          {`The gateway rejected ${dropped.join(', ')} and the request was retried without ${dropped.length === 1 ? 'it' : 'them'}.`}
        </Note>
      ) : null}
      {message.meta?.failedOverTo ? (
        <Note tone="warning">{`Sent via the fallback base URL: ${message.meta.failedOverTo}`}</Note>
      ) : null}

      <Footer
        message={message}
        now={now}
        {...(pricing ? { pricing } : {})}
        {...(onExplainCost ? { onExplainCost } : {})}
      />
    </View>
  );

  return (
    <Pressable
      // Tap as well as long-press. A long-press-only affordance is undiscoverable —
      // there is nothing on screen that hints at it — and it is also the one gesture
      // a switch-control or screen-reader user is least able to produce.
      onPress={onAction ? () => onAction(message) : undefined}
      onLongPress={onAction ? () => onAction(message) : undefined}
      delayLongPress={300}
      accessibilityRole={onAction ? 'button' : undefined}
      accessibilityHint={onAction ? 'Opens message actions' : undefined}
      style={{
        alignItems: asUser ? 'flex-end' : 'stretch',
        // Excluded messages are still readable — they are part of the record — but
        // they are visibly not part of what the model will see next.
        opacity: message.excluded ? 0.5 : 1,
      }}
    >
      {asUser ? (
        <View
          style={{
            maxWidth: BUBBLE_MAX_WIDTH,
            backgroundColor: t.colors.userBubble,
            borderRadius: t.radius.lg,
            paddingHorizontal: t.spacing.md,
            paddingVertical: t.spacing.sm,
          }}
        >
          {body}
        </View>
      ) : (
        <View
          style={
            isToolTurn
              ? {
                  borderLeftWidth: 2,
                  borderLeftColor: t.colors.border,
                  paddingLeft: t.spacing.sm,
                }
              : null
          }
        >
          {body}
        </View>
      )}
    </Pressable>
  );
}

/**
 * Memoised because a transcript re-renders on every stream delta.
 *
 * The comparison is deliberately shallow on the fields that can actually change
 * for an already-stored message: the store replaces the message object on edit, so
 * identity is enough for content, and the rest are primitives.
 */
export const MessageView = memo(MessageViewInner);
