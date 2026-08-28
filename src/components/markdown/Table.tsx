/**
 * A GFM table.
 *
 * Tables are the one markdown block that cannot be made to fit a phone. The
 * choice is between wrapping every cell down to a column of single letters and
 * letting the table keep its shape behind a horizontal scroller; this takes the
 * second, for the same reason code blocks do.
 *
 * Column widths are estimated from content length rather than measured. React
 * Native cannot measure text before laying it out, so the alternatives are a
 * two-pass layout that visibly reflows — bad in a streaming transcript, where the
 * table is rebuilt on every delta — or an estimate that is stable from the first
 * frame. The estimate is deliberately crude and clamped at both ends: it only has
 * to allocate space in roughly the right proportion, since a cell that needs more
 * room still wraps inside its column.
 */

import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { inlineText } from '@/components/markdown/blocks';
import type { Align, InlineToken } from '@/components/markdown/blocks';
import { InlineText } from '@/components/markdown/Inline';
import { useTheme } from '@/theme';

/** Average glyph width as a fraction of font size, for the body font. */
const CHAR_EM = 0.55;
/** Narrow enough for a column of `yes`/`no`, wide enough to not look broken. */
const MIN_COL = 56;
/** Past this a cell wraps instead of widening; three of these still fit a scroll. */
const MAX_COL = 220;

function columnWidths(
  columns: number,
  head: readonly InlineToken[][],
  rows: readonly InlineToken[][][],
  size: number,
  padding: number,
): number[] {
  const longest = new Array<number>(columns).fill(0);

  const measure = (cells: readonly InlineToken[][]) => {
    for (let index = 0; index < columns; index += 1) {
      const cell = cells[index];
      if (!cell) continue;
      // The longest word matters as much as the total: a column holding one
      // 30-character identifier cannot usefully be narrower than that word.
      const text = inlineText(cell);
      const word = text.split(/\s+/).reduce((max, part) => Math.max(max, part.length), 0);
      const current = longest[index] ?? 0;
      longest[index] = Math.max(current, Math.min(text.length, Math.max(word, 12)));
    }
  };

  measure(head);
  for (const row of rows) measure(row);

  return longest.map((chars) =>
    Math.round(Math.min(MAX_COL, Math.max(MIN_COL, chars * CHAR_EM * size + padding * 2))),
  );
}

function textAlign(align: Align | null | undefined): 'left' | 'center' | 'right' {
  return align ?? 'left';
}

export function Table({
  head,
  rows,
  align,
}: {
  head: InlineToken[][];
  rows: InlineToken[][][];
  align: (Align | null)[];
}) {
  const t = useTheme();
  const size = t.fontSize.sm;
  const padding = t.spacing.sm;

  // Rows are not guaranteed to agree with the header on width — a malformed table
  // still has to render — so the grid is as wide as its widest row.
  const columns = useMemo(
    () => rows.reduce((max, row) => Math.max(max, row.length), head.length),
    [head, rows],
  );

  const widths = useMemo(
    () => columnWidths(columns, head, rows, size, padding),
    [columns, head, rows, size, padding],
  );

  if (columns === 0) return null;

  return (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.border,
        borderRadius: t.radius.md,
        overflow: 'hidden',
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        // Same reason as a code block: without the lock, a vertical drag that
        // starts inside the table is claimed by this scroller and the transcript
        // stops moving.
        directionalLockEnabled
      >
        <View>
          <View style={{ flexDirection: 'row', backgroundColor: t.colors.surfaceAlt }}>
            {Array.from({ length: columns }, (_, index) => (
              <View
                key={index}
                style={{
                  width: widths[index],
                  paddingHorizontal: padding,
                  paddingVertical: t.spacing.xs,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: t.colors.borderStrong,
                }}
              >
                <InlineText
                  tokens={head[index] ?? []}
                  size={size}
                  color={t.colors.text}
                  style={{ fontWeight: '700', textAlign: textAlign(align[index]) }}
                />
              </View>
            ))}
          </View>

          {rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={{
                flexDirection: 'row',
                // Zebra striping rather than a grid of rules: on a small screen
                // the rules cost more attention than they return.
                backgroundColor: rowIndex % 2 === 1 ? t.colors.surface : 'transparent',
              }}
            >
              {Array.from({ length: columns }, (_, index) => (
                <View
                  key={index}
                  style={{
                    width: widths[index],
                    paddingHorizontal: padding,
                    paddingVertical: t.spacing.xs,
                  }}
                >
                  <InlineText
                    tokens={row[index] ?? []}
                    size={size}
                    color={t.colors.textDim}
                    style={{ textAlign: textAlign(align[index]) }}
                  />
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
