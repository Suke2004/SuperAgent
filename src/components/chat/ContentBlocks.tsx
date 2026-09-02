/**
 * A message's content blocks, rendered.
 *
 * The seven block kinds are not variations on a theme — text is prose, thinking is
 * an aside the user has to opt into reading, a tool call is a machine artefact,
 * a provider-side search is a list of sources, and an image is none of those. Each
 * gets the treatment it needs, and the switch is exhaustive so an eighth kind
 * cannot render as a blank gap.
 *
 * Two things are deliberately reused rather than reinvented: {@link Markdown} for
 * assistant prose, and {@link CodeBlock} for tool arguments and results. The second
 * matters more than it looks — tool JSON is code, so it wants the same
 * non-wrapping horizontal scroller and the same copy button as a fenced block, and
 * a bespoke pretty-printer here would have neither.
 */

import { useState } from 'react';
import { Alert, Image, Linking, Modal, Pressable, StyleSheet, View } from 'react-native';
import type { ReactNode } from 'react';
import type { ViewStyle } from 'react-native';

import { CodeBlock } from '@/components/markdown/CodeBlock';
import { hostOf, safeHref } from '@/components/markdown/href';
import { Markdown } from '@/components/markdown/Markdown';
import { TerminalView } from '@/components/chat/TerminalView';
import { Icon } from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Badge, Body, Button, Inline, MIN_TARGET, Note, verticalSlop } from '@/components/ui';
import { shareImageData } from '@/chat/files';
import { looksLikeTerminal } from '@/chat/terminal';
import { describeTool } from '@/chat/toolLabel';
import { useTheme } from '@/theme';
import type { Citation, ContentBlock } from '@/transports/types';

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
 * A hairline pill that opens something.
 *
 * Three things in a transcript are asides the reader opts into — the model's
 * thinking, a tool call's arguments, a tool's result — and before this they were a
 * pill, a permanently-open JSON block and a second permanently-open JSON block. They
 * are the same gesture, so they are one component: the reader learns "pill with a
 * chevron means there is more here" once.
 *
 * The summary line is what stays on screen, so it carries the whole message when
 * nobody expands it — which is most of the time. Hence a label that reads as a
 * sentence and, where there is one, the single argument that says which thing it
 * acted on.
 */
function Disclosure({
  icon,
  label,
  detail,
  a11yLabel,
  defaultExpanded,
  children,
}: {
  icon: IconName;
  label: string;
  /** The one recognisable argument, shown after the label and clipped to one line. */
  detail?: string | null;
  /** What a screen reader says instead of the two visible strings. */
  a11yLabel: string;
  defaultExpanded: boolean;
  children: ReactNode;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <View style={{ gap: t.spacing.sm }}>
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={a11yLabel}
        hitSlop={verticalSlop(30)}
        style={({ pressed }) => [
          pillStyle(t.spacing, t.radius.pill, t.colors.border),
          { backgroundColor: pressed ? t.colors.surfaceActive : 'transparent' },
        ]}
      >
        <Icon name={icon} size="sm" tone="textFaint" />
        <Body size="xs" tone="faint">
          {label}
        </Body>
        {detail ? (
          // Shrinks before the label does, and clips rather than wraps: a pill that
          // becomes two lines on a long path stops looking like one step.
          <Body size="xs" tone="faint" mono numberOfLines={1} style={{ flexShrink: 1 }}>
            {detail}
          </Body>
        ) : null}
        <Icon name={expanded ? 'collapse' : 'expand'} size="sm" tone="textFaint" />
      </Pressable>

      {expanded ? children : null}
    </View>
  );
}

/** The pill's box. A function rather than a hook call so both users share one shape. */
function pillStyle(
  spacing: { sm: number; md: number },
  radius: number,
  border: string,
): ViewStyle {
  return {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: border,
    borderRadius: radius,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  };
}

/**
 * Thinking, collapsed by default.
 *
 * Collapsed because it is usually longer than the answer and reading it is a
 * choice; a transcript that opens with six screens of deliberation buries the
 * reply that was asked for. The header states the size so the choice is informed.
 *
 * Collapsed, it is a hairline pill on the page rather than a filled panel: an aside
 * the reader may open, sized like one. Expanded, the reasoning gets its own tinted
 * block so it cannot be mistaken for the answer.
 */
function ThinkingPane({ text, redacted, defaultExpanded }: { text: string; redacted?: string; defaultExpanded: boolean }) {
  const t = useTheme();

  // Redacted thinking is an opaque blob with no readable content. Showing its
  // length would imply there is something to expand; there is not.
  if (redacted !== undefined && !text) {
    return (
      <View style={pillStyle(t.spacing, t.radius.pill, t.colors.border)}>
        <Body size="xs" tone="faint">
          Thought, redacted by the provider — encrypted, and replayed unread on the next turn.
        </Body>
      </View>
    );
  }

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <Disclosure
      icon="memory"
      label={words === 1 ? 'Thought · 1 word' : `Thought · ${words} words`}
      a11yLabel={`Thinking, ${words} words`}
      defaultExpanded={defaultExpanded}
    >
      <View
        style={{
          backgroundColor: t.colors.thinkingBg,
          borderColor: t.colors.thinkingBorder,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: t.radius.md,
          paddingHorizontal: t.spacing.md,
          paddingVertical: t.spacing.sm,
        }}
      >
        <Body
          size="sm"
          selectable
          style={{ color: t.colors.thinkingText, lineHeight: Math.round(t.fontSize.sm * 1.5) }}
        >
          {text}
        </Body>
      </View>
    </Disclosure>
  );
}

/**
 * A tool call, as the step it was.
 *
 * The arguments are still here and still a {@link CodeBlock} — a tool that read the
 * wrong path is a thing you need to be able to see — but they are behind the pill
 * now. What is on the page is "Read a file · src/index.ts", which is what the reader
 * wanted to know and what Claude's own transcript shows.
 *
 * The label comes from {@link describeTool} rather than from a list here, because
 * most of these tools arrive over MCP from servers this app has never heard of.
 */
function ToolUse({ name, input }: { name: string; input: unknown }) {
  const step = describeTool(name, input);
  return (
    <Disclosure
      icon={step.icon}
      label={step.label}
      detail={step.detail}
      // The real tool name goes in the accessibility label and nowhere else: it is
      // what you need when a call went wrong, and noise when it did not.
      a11yLabel={`${step.label}${step.detail ? `, ${step.detail}` : ''}. Tool ${name}. Shows the arguments.`}
      defaultExpanded={false}
    >
      <CodeBlock code={formatInput(input)} lang="json" />
    </Disclosure>
  );
}

/**
 * What a tool sent back.
 *
 * Collapsed like the call — except when it failed. An error is the one result the
 * reader did not choose to look at and needs to see anyway, so a failure opens
 * itself and says so on the pill.
 */
function ToolResult({ content, isError }: { content: string; isError?: boolean }) {
  const t = useTheme();
  const lines = content.trim() ? content.trim().split('\n').length : 0;

  return (
    <Disclosure
      icon={isError ? 'error' : 'success'}
      label={isError ? 'The tool failed' : 'Result'}
      detail={lines > 0 ? (lines === 1 ? '1 line' : `${lines} lines`) : 'empty'}
      a11yLabel={
        isError
          ? 'The tool failed; the model was told so. Shows the output.'
          : `Tool result, ${lines} lines. Shows the output.`
      }
      defaultExpanded={Boolean(isError)}
    >
      {content.trim() ? (
        // A remote shell over MCP is the only shell an unrooted phone can have, and its
        // output arrives here. Rendered as a terminal when it carries escapes or
        // in-place redraws, and as a code block otherwise — the same bargain the
        // artifact preview makes: fall back to legible source rather than guess.
        looksLikeTerminal(content) ? (
          <TerminalView output={content} />
        ) : (
          <CodeBlock code={content} />
        )
      ) : (
        <Body size="sm" tone="faint" style={{ paddingLeft: t.spacing.md }}>
          Empty result.
        </Body>
      )}
    </Disclosure>
  );
}

/**
 * An attached image.
 *
 * Rendered from base64 that is already on this device — this is our own
 * attachment, not a third-party fetch, so it does not fall under the rule that
 * keeps {@link Inline}'s markdown images unloaded.
 *
 * The thumbnail is a fixed-height band in the transcript and a tap opens the
 * full-screen viewer, because the two things a reader wants from an image here are
 * mutually exclusive: "which image was this" wants a small stable row, and "what
 * does it actually say" wants the whole screen. A screenshot of a stack trace is
 * illegible at 220pt and that is the most common thing anyone attaches.
 */
function Attachment({ mediaType, data }: { mediaType: string; data: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const uri = `data:${mediaType};base64,${data}`;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Attached image"
        accessibilityHint="Opens the image full screen"
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        <Image
          source={{ uri }}
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
      </Pressable>

      <Modal
        visible={open}
        transparent
        // Android's hardware back must close the viewer rather than leave the
        // conversation — without this the modal swallows the gesture entirely.
        onRequestClose={() => setOpen(false)}
        animationType="fade"
        accessibilityViewIsModal
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' }}>
          {/* The backdrop is the dismiss target: at full screen there is no chrome
              to aim at, and a tap anywhere is the gesture everyone already tries. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close image"
            onPress={() => setOpen(false)}
            style={{ flex: 1 }}
          >
            <Image
              source={{ uri }}
              accessibilityIgnoresInvertColors
              accessibilityLabel="Attached image, full screen"
              resizeMode="contain"
              style={{ flex: 1, width: '100%' }}
            />
          </Pressable>

          <View style={{ padding: t.spacing.lg, alignItems: 'center', gap: t.spacing.md }}>
            {/* Sharing is where an image *leaves*: Photos, Drive, a message — whichever
                of them the reader has, chosen by the platform rather than by this app.
                A dedicated "save to gallery" would need the media-library permission and
                a native module to reach the same place. */}
            <Button
              label="Share"
              variant="secondary"
              size="sm"
              onPress={() => {
                void shareImageData(mediaType, data).then((shared) => {
                  if (!shared) Alert.alert('Sharing unavailable', 'This device has no share sheet.');
                });
              }}
            />
            <Body size="xs" style={{ color: '#f0ece4' }}>
              Tap the image to close
            </Body>
          </View>
        </View>
      </Modal>
    </>
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

/**
 * A tool the provider ran on its own side, and the pages it came back with.
 *
 * The `raw` wire payload is not shown. It is there to be replayed verbatim on the
 * next turn, and for web search it is the full text of every result page — which is
 * a machine artefact the way a `tool_use` argument blob is not: nobody reads it, and
 * printing it would bury the answer under the sources it was written from.
 *
 * Source URLs come from a third party by way of the model, so they go through the
 * same {@link safeHref} allowlist as a markdown link rather than reaching `openURL`
 * on trust. One that fails the check renders as text.
 */
function SourceChip({ index, title, url }: { index: number; title?: string; url: string }) {
  const t = useTheme();
  const href = safeHref(url);
  const host = hostOf(url);
  /**
   * The domain, not the headline.
   *
   * A chip is a few centimetres wide and a headline is a sentence, so a title-labelled
   * chip is a truncated sentence — which tells the reader less than `reuters.com`
   * does about whether to trust the claim above it. The title is not lost: it is the
   * accessibility label, and it is what the export writes.
   */
  const label = host ?? title?.trim() ?? url;
  const box: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.border,
    borderRadius: t.radius.pill,
    paddingLeft: t.spacing.sm,
    paddingRight: t.spacing.sm,
    paddingVertical: 4,
    maxWidth: '100%',
  };

  if (!href) {
    return (
      <View style={box}>
        <Body size="xs" tone="faint" numberOfLines={1}>
          {`${index}  ${label}`}
        </Body>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Source ${index}: ${title?.trim() || label}`}
      accessibilityHint="Opens the source in your browser"
      hitSlop={verticalSlop(MIN_TARGET)}
      onPress={() => {
        Linking.openURL(href).catch(() => {
          Alert.alert('Could not open link', href);
        });
      }}
      style={({ pressed }) => [box, { backgroundColor: pressed ? t.colors.surfaceActive : t.colors.surfaceAlt }]}
    >
      {/* The number is the anchor to the claim above, so it is the one part that
          keeps full contrast when the domain is dimmed. */}
      <Body size="xs" tone="dim" weight="700">
        {String(index)}
      </Body>
      <Body size="xs" style={{ color: t.colors.accent }} numberOfLines={1}>
        {label}
      </Body>
    </Pressable>
  );
}

function SourceLinks({ sources }: { sources: readonly { title?: string; url: string }[] }) {
  return (
    <Inline gap="xs">
      {sources.map((source, index) => (
        <SourceChip
          key={`${source.url}-${index}`}
          index={index + 1}
          {...(source.title !== undefined ? { title: source.title } : {})}
          url={source.url}
        />
      ))}
    </Inline>
  );
}

function ServerTool({ name, summary, sources }: { name: string; summary?: string; sources?: { title?: string; url: string }[] }) {
  const t = useTheme();
  const step = describeTool(name);
  return (
    <View style={{ gap: t.spacing.sm }}>
      {/* The same pill as a local tool call, but not pressable: there is nothing
          behind it. The provider ran this, and the sources *are* the payload — so they
          stay on the page rather than hiding behind a chevron. */}
      <View style={pillStyle(t.spacing, t.radius.pill, t.colors.border)}>
        <Icon name={step.icon} size="sm" tone="textFaint" />
        <Body size="xs" tone="faint" numberOfLines={1}>
          {summary ?? step.label}
        </Body>
      </View>
      {sources ? <SourceLinks sources={sources} /> : null}
    </View>
  );
}

/**
 * The sources a cited answer was written from.
 *
 * Under the text rather than inline: the provider cites per passage, and a marker
 * threaded into the prose would have to survive markdown rendering to land in the
 * right place. A row of numbered chips under the answer says the same thing and
 * cannot land wrong.
 *
 * `citedText` is not shown. It is a quotation of the source, so on a phone it doubles
 * the height of the block to repeat what the model already paraphrased above it; the
 * export keeps it, where there is room.
 */
function Citations({ citations }: { citations: readonly Citation[] }) {
  const t = useTheme();
  return (
    <View style={{ marginTop: t.spacing.sm }}>
      <SourceLinks sources={citations} />
    </View>
  );
}

export function BlockView({
  block,
  thinkingExpanded,
}: {
  block: ContentBlock;
  thinkingExpanded: boolean;
}) {
  switch (block.type) {
    case 'text': {
      if (!block.text) return null;
      const body = <Markdown source={block.text} />;
      if (!block.citations?.length) return body;
      return (
        <View>
          {body}
          <Citations citations={block.citations} />
        </View>
      );
    }

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

    case 'server_tool':
      return (
        <ServerTool
          name={block.name}
          {...(block.summary !== undefined ? { summary: block.summary } : {})}
          {...(block.sources !== undefined ? { sources: block.sources } : {})}
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

  if (blocks.length === 0) {
    return (
      <Note tone="info">This message has no content. It was probably interrupted before the first token.</Note>
    );
  }

  return (
    <View style={{ gap: t.spacing.sm }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} thinkingExpanded={thinkingExpanded} />
      ))}
    </View>
  );
}
