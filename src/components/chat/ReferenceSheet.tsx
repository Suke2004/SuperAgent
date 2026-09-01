/**
 * "What did I say about this in the other chat?"
 *
 * A full-text search over every *other* conversation's messages, whose result is a
 * quote dropped into the current draft. The current conversation is filtered out:
 * its own messages are already in the request, and quoting one back would spend
 * tokens restating what the model can already see.
 *
 * The search is the same two-pass `searchMessages` the list screen uses, debounced
 * the same way, and each hit says which pass found it for the same reason it does
 * there — an FTS hit is a word match, a `like` hit is a substring the index could
 * not have found.
 */

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useDialogKeys } from '@/components/dialog';
import { SheetShell } from '@/components/Sheet';
import { Badge, Body, Button, Divider, Field, Inline, Spinner, useKeyboardHeight } from '@/components/ui';
import { searchMessages } from '@/db/conversations';
import type { SearchHit } from '@/db/conversations';
import { useTheme } from '@/theme';

/** Same as the list screen: one query after the typing stops, not one per key. */
const DEBOUNCE_MS = 250;
const MIN_LENGTH = 2;

export function ReferenceSheet({
  visible,
  excludeConversationId,
  busy,
  onPick,
  onClose,
}: {
  visible: boolean;
  excludeConversationId: string;
  /** True while the picked message is being read out of the database. */
  busy: boolean;
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  // The field autofocuses, so this sheet is always over a keyboard. Lifted on the shell's
  // panel rather than inside the body, for the same reason as `PromptSheet`: the surface
  // has to stop above the keys, not merely its contents.
  const keyboardHeight = useKeyboardHeight();

  return (
    <SheetShell visible={visible} onClose={onClose} label="Cancel" lift={keyboardHeight}>
      {/* Mounted only while open, so the query is not still sitting there next
          time — the same reason `PromptSheet` does this. The shell deliberately keeps
          its own panel mounted for one exit animation, so this gate is what resets. */}
      {visible ? (
        <ReferenceBody excludeConversationId={excludeConversationId} busy={busy} onPick={onPick} onClose={onClose} />
      ) : null}
    </SheetShell>
  );
}

function ReferenceBody({
  excludeConversationId,
  busy,
  onPick,
  onClose,
}: {
  excludeConversationId: string;
  busy: boolean;
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const trap = useDialogKeys(true, onClose);

  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; hits: SearchHit[] } | null>(null);

  const trimmed = query.trim();
  const searchable = trimmed.length >= MIN_LENGTH;
  const fresh = found?.query === trimmed;
  const hits = searchable && fresh && found ? found.hits.filter((h) => h.conversationId !== excludeConversationId) : [];

  useEffect(() => {
    if (!searchable) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchMessages(trimmed)
        .then((rows) => {
          if (!cancelled) setFound({ query: trimmed, hits: rows });
        })
        .catch(() => {
          // Recording an empty result rather than leaving it unset, so a failed
          // query does not retry on every render. `searchMessages` logged it.
          if (!cancelled) setFound({ query: trimmed, hits: [] });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, searchable]);

  return (
    <View ref={trap} style={{ paddingBottom: t.spacing.xl }}>
      <View style={{ paddingHorizontal: t.spacing.md, gap: t.spacing.sm }}>
        <Body weight="700">Bring in a message</Body>
        <Field
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="sentences"
          placeholder="Search your other chats"
          returnKeyType="search"
          hint="The message you pick is quoted into this chat's draft, where you can edit or delete it before sending."
        />
      </View>
      <Divider />
      <ScrollView keyboardShouldPersistTaps="handled">
          {busy ? (
            <View style={{ padding: t.spacing.lg }}>
              <Spinner label="Reading the message" />
            </View>
          ) : !searchable ? (
            <View style={{ padding: t.spacing.md }}>
              <Body size="sm" tone="faint">
                Type at least two characters.
              </Body>
            </View>
          ) : !fresh ? (
            <View style={{ padding: t.spacing.lg }}>
              <Spinner label="Searching" />
            </View>
          ) : hits.length ? (
            hits.map((hit) => (
              <Pressable
                key={hit.messageId}
                onPress={() => onPick(hit)}
                accessibilityRole="button"
                accessibilityHint={`Quotes this message from ${hit.conversationTitle}`}
                style={({ pressed }) => ({
                  paddingHorizontal: t.spacing.md,
                  paddingVertical: t.spacing.sm,
                  gap: 2,
                  backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
                })}
              >
                <Inline gap="sm">
                  <Body size="sm" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {hit.conversationTitle}
                  </Body>
                  <Badge label={hit.role === 'user' ? 'You' : 'Reply'} tone="neutral" />
                  <Badge label={hit.via === 'fts' ? 'index' : 'scan'} tone="neutral" />
                </Inline>
                <Body size="sm" tone="dim" numberOfLines={2}>
                  {hit.snippet}
                </Body>
              </Pressable>
            ))
          ) : (
            <View style={{ padding: t.spacing.md }}>
              <Body size="sm" tone="faint">
                No message in another chat contains that.
              </Body>
            </View>
          )}
      </ScrollView>
      <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md }}>
        <Button label="Cancel" variant="ghost" full onPress={onClose} />
      </View>
    </View>
  );
}
