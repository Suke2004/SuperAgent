/**
 * A message's content blocks, rendered.
 *
 * The six block kinds are not variations on a theme — text is prose, thinking is
 * an aside the user has to opt into reading, a tool call is a machine artefact,
 * and an image is neither. Each gets the treatment it needs, and the switch is
 * exhaustive so a seventh kind cannot render as a blank gap.
 *
 * Two things are deliberately reused rather than reinvented: {@link Markdown} for
 * assistant prose, and {@link CodeBlock} for tool arguments and results. The second
 * matters more than it looks — tool JSON is code, so it wants the same
 * non-wrapping horizontal scroller and the same copy button as a fenced block, and
 * a bespoke pretty-printer here would have neither.
 */

import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { CodeBlock } from '@/components/markdown/CodeBlock';
import { Markdown } from '@/components/markdown/Markdown';
import { Badge, Body, Inline, Note } from '@/components/ui';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme';
import type { ContentBlock } from '@/transports/types';

/** Tall enough to see what an attachment is, short enough not to own the screen. */
const IMAGE_HEIGHT = 220;

function assertNever(block: never): null {
  void block;
  return null;
}

/** Pretty JSON, or the raw string when the arguments never finished streaming. */
function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && '_raw' in input) {
    const raw = (input as { _raw?: unknown })._raw;
    if (typeof raw === 'string') return raw;
  }
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * Thinking, collapsed by default.
 *
 * Collapsed because it is usually longer than the answer and reading it is a
 * choice; a transcript that opens with six screens of deliberation buries the
 * reply that was asked for. The header states the size so the choice is informed.
 */
function ThinkingPane({ text, redacted, defaultExpanded }: { text: string; redacted?: string; defaultExpanded: boolean }) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Redacted thinking is an opaque blob with no readable content. Showing its
  // length would imply there is something to expand; there is not.
  if (redacted !== undefined && !text) {
    return (
      <View
        style={{
          backgroundColor: t.colors.thinkingBg,
          borderColor: t.colors.thinkingBorder,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: t.radius.md,
          padding: t.spacing.sm,
        }}
      >
        <Inline gap="sm">
          <Badge label="Thinking" tone="neutral" />
          <Body size="xs" tone="faint">
            Redacted by the provider — encrypted, and replayed unread on the next turn.
          </Body>
        </Inline>
      </View>
    );
  }

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <View
      style={{
        backgroundColor: t.colors.thinkingBg,
        borderColor: t.colors.thinkingBorder,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: t.radius.md,
        overflow: 'hidden',
      }}
    >
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Thinking, ${words} words`}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: t.spacing.sm,
          backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
        })}
      >
        <Inline gap="sm">
          <Badge label="Thinking" tone="neutral" />
          <Body size="xs" tone="faint">
            {words === 1 ? '1 word' : `${words} words`}
          </Body>
        </Inline>
        <Body size="sm" tone="faint">
          {expanded ? '▲' : '▼'}
        </Body>
      </Pressable>

      {expanded ? (
        <View style={{ paddingHorizontal: t.spacing.sm, paddingBottom: t.spacing.sm }}>
          <Body
            size="sm"
            selectable
            style={{ color: t.colors.thinkingText, lineHeight: Math.round(t.fontSize.sm * 1.5) }}
          >
            {text}
          </Body>
        </View>
      ) : null}
    </View>
  );
}

function ToolUse({ name, input }: { name: string; input: unknown }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.spacing.xs }}>
      <Inline gap="sm">
        <Badge label="Tool" tone="accent" />
        <Body size="sm" mono weight="600">
          {name}
        </Body>
      </Inline>
      <CodeBlock code={formatInput(input)} lang="json" />
    </View>
  );
}

function ToolResult({ content, isError }: { content: string; isError?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.spacing.xs }}>
      <Inline gap="sm">
        <Badge label="Result" tone={isError ? 'danger' : 'success'} />
        {isError ? (
          <Body size="xs" tone="danger">
            The tool failed; the model was told so.
          </Body>
        ) : null}
      </Inline>
      {content.trim() ? (
        <CodeBlock code={content} />
      ) : (
        <Body size="sm" tone="faint">
          Empty result.
        </Body>
      )}
    </View>
  );
}

/**
 * An attached image.
 *
 * Rendered from base64 that is already on this device — this is our own
 * attachment, not a third-party fetch, so it does not fall under the rule that
 * keeps {@link Inline}'s markdown images unloaded.
 */
function Attachment({ mediaType, data }: { mediaType: string; data: string }) {
  const t = useTheme();
  return (
    <Image
      source={{ uri: `data:${mediaType};base64,${data}` }}
      accessibilityIgnoresInvertColors
      // `contain` rather than `cover`: a cropped screenshot is a different
      // screenshot, and this is often a screenshot.
      resizeMode="contain"
      style={{
        width: '100%',
        height: IMAGE_HEIGHT,
        borderRadius: t.radius.md,
        backgroundColor: t.colors.surfaceAlt,
      }}
    />
  );
}

function Document({ mediaType, name, text }: { mediaType: string; name?: string; text?: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.border,
        borderRadius: t.radius.md,
        padding: t.spacing.sm,
        gap: t.spacing.xs,
      }}
    >
      <Inline gap="sm">
        <Badge label="Document" tone="neutral" />
        <Body size="sm" weight="600">
          {name ?? 'Attachment'}
        </Body>
      </Inline>
      <Body size="xs" tone="faint" mono>
        {mediaType}
      </Body>
      {text ? (
        <Body size="sm" tone="dim" numberOfLines={4} selectable>
          {text}
        </Body>
      ) : null}
    </View>
  );
}

export function BlockView({
  block,
  markdown,
  thinkingExpanded,
}: {
  block: ContentBlock;
  /** When false, text renders verbatim in a monospaced run. */
  markdown: boolean;
  thinkingExpanded: boolean;
}) {
  switch (block.type) {
    case 'text':
      if (!block.text) return null;
      return markdown ? (
        <Markdown source={block.text} />
      ) : (
        <Body mono selectable>
          {block.text}
        </Body>
      );

    case 'thinking':
      return (
        <ThinkingPane
          text={block.text}
          {...(block.redacted !== undefined ? { redacted: block.redacted } : {})}
          defaultExpanded={thinkingExpanded}
        />
      );

    case 'tool_use':
      return <ToolUse name={block.name} input={block.input} />;

    case 'tool_result':
      return (
        <ToolResult content={block.content} {...(block.isError ? { isError: true } : {})} />
      );

    case 'image':
      return <Attachment mediaType={block.mediaType} data={block.data} />;

    case 'document':
      return (
        <Document
          mediaType={block.mediaType}
          {...(block.name !== undefined ? { name: block.name } : {})}
          {...(block.text !== undefined ? { text: block.text } : {})}
        />
      );

    default:
      return assertNever(block);
  }
}

/**
 * Every block in a message.
 *
 * Blocks are separated by a container `gap` rather than per-block margins, for the
 * same reason {@link Blocks} does it: margins do not collapse here, so two
 * adjacent blocks would each contribute their own space.
 */
export function ContentBlocks({
  blocks,
  thinkingExpanded = false,
}: {
  blocks: readonly ContentBlock[];
  thinkingExpanded?: boolean;
}) {
  const t = useTheme();
  const markdown = useSettings((s) => s.renderMarkdown);

  if (blocks.length === 0) {
    return (
      <Note tone="info">This message has no content. It was probably interrupted before the first token.</Note>
    );
  }

  return (
    <View style={{ gap: t.spacing.sm }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} markdown={markdown} thinkingExpanded={thinkingExpanded} />
      ))}
    </View>
  );
}
