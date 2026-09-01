/**
 * Markdown → React Native, one block at a time.
 *
 * The parsing is in {@link parseMarkdown} and the interesting rendering is in
 * {@link CodeBlock}, {@link Table}, {@link BlockMath} and {@link InlineText}; this
 * module is the assembly, and its switch is exhaustive so that a block kind added
 * to the AST cannot quietly render as nothing.
 *
 * Blocks are separated by a container `gap` rather than by margins on each block,
 * because a margin that collapses in CSS does not collapse here — two adjacent
 * blocks would each contribute their own space and the transcript would drift
 * apart. Headings are the one exception: a heading wants more air above it than
 * below, and only when something precedes it.
 */

import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';

import { parseMarkdown } from '@/components/markdown/blocks';
import type { MdBlock } from '@/components/markdown/blocks';
import { CodeBlock } from '@/components/markdown/CodeBlock';
import { InlineText } from '@/components/markdown/Inline';
import { BlockMath } from '@/components/markdown/MathView';
import { MermaidView } from '@/components/markdown/MermaidView';
import { Table } from '@/components/markdown/Table';
import { useTheme } from '@/theme';
import type { Theme } from '@/theme';

/** Wide enough for `10.` at body size; past that the numbers align right anyway. */
const MARKER_WIDTH = 26;

function headingStyle(t: Theme, level: 1 | 2 | 3 | 4 | 5 | 6): { size: number; weight: TextStyle['fontWeight'] } {
  switch (level) {
    case 1:
      return { size: t.fontSize.xxl, weight: '800' };
    case 2:
      return { size: t.fontSize.xl, weight: '800' };
    case 3:
      return { size: t.fontSize.lg, weight: '700' };
    default:
      return { size: t.fontSize.md, weight: '700' };
  }
}

function assertNever(block: never): null {
  void block;
  return null;
}

function BlockView({ block, spacedTop }: { block: MdBlock; spacedTop: boolean }) {
  const t = useTheme();

  switch (block.kind) {
    case 'paragraph':
      return <InlineText tokens={block.tokens} />;

    case 'heading': {
      const { size, weight } = headingStyle(t, block.level);
      return (
        <View style={spacedTop ? { marginTop: t.spacing.md } : null}>
          <InlineText
            tokens={block.tokens}
            size={size}
            style={{ fontWeight: weight, lineHeight: Math.round(size * 1.25) }}
          />
        </View>
      );
    }

    case 'code':
      // A mermaid fence is a diagram first; `MermaidView` falls back to a `CodeBlock`
      // itself for anything it cannot draw, so the source is never lost.
      if (block.lang?.toLowerCase() === 'mermaid') return <MermaidView code={block.code} />;
      return <CodeBlock code={block.code} {...(block.lang ? { lang: block.lang } : {})} />;

    case 'math':
      return <BlockMath latex={block.latex} />;

    case 'quote':
      return (
        <View
          style={{
            borderLeftWidth: 3,
            borderLeftColor: t.colors.borderStrong,
            paddingLeft: t.spacing.md,
            gap: t.spacing.sm,
          }}
        >
          {block.blocks.map((child, index) => (
            <BlockView key={index} block={child} spacedTop={index > 0} />
          ))}
        </View>
      );

    case 'list':
      return <ListBlock block={block} />;

    case 'table':
      return <Table head={block.head} rows={block.rows} align={block.align} />;

    case 'rule':
      return (
        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: t.colors.border,
            marginVertical: t.spacing.xs,
          }}
        />
      );

    default:
      return assertNever(block);
  }
}

function ListBlock({ block }: { block: Extract<MdBlock, { kind: 'list' }> }) {
  const t = useTheme();
  const markerColor = t.colors.textFaint;

  return (
    <View style={{ gap: t.spacing.xs }}>
      {block.items.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View
            style={{
              width: MARKER_WIDTH,
              paddingRight: t.spacing.xs,
              alignItems: block.ordered ? 'flex-end' : 'center',
            }}
          >
            <Text
              // Matching the first line's line height keeps the marker on the
              // baseline of the text it belongs to rather than above it.
              style={{
                color: item.checked === undefined ? markerColor : t.colors.accent,
                fontSize: t.fontSize.md,
                lineHeight: Math.round(t.fontSize.md * 1.45),
              }}
            >
              {item.checked === undefined
                ? block.ordered
                  ? `${block.start + index}.`
                  : '•'
                : item.checked
                  ? '☑'
                  : '☐'}
            </Text>
          </View>
          <View style={{ flex: 1, gap: t.spacing.xs }}>
            {item.blocks.map((child, childIndex) => (
              <BlockView key={childIndex} block={child} spacedTop={false} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A parsed document.
 *
 * Separate from {@link Markdown} so a streaming message can parse once per delta
 * and hold the blocks itself, rather than re-parsing inside the render.
 */
export function Blocks({ blocks }: { blocks: readonly MdBlock[] }) {
  const t = useTheme();
  if (blocks.length === 0) return null;
  return (
    <View style={{ gap: t.spacing.sm }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} spacedTop={index > 0} />
      ))}
    </View>
  );
}

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <Blocks blocks={blocks} />;
}
