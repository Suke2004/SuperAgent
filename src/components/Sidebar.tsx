/**
 * The chat history, as a drawer over the conversation.
 *
 * The app now opens on a chat, so the list is no longer the thing you arrive at —
 * and a history you have to navigate away from the conversation to read is a
 * history you stop reading. This is the same rows as the list screen, minus
 * everything that screen does that a drawer should not: no bulk selection, no
 * export, no archive toggle, no tag filter. Those still live on the full list,
 * one tap away at the bottom.
 *
 * A `Modal` rather than an animated absolute panel: it gets the Android back
 * button, the iOS focus trap and the same escape/tab handling as the sheets for
 * free, and "collapsed" is then genuinely unmounted rather than a view sitting
 * off-screen intercepting nothing.
 */

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDialogKeys } from '@/components/dialog';
import { Badge, Body, Button, Divider, Field, Inline, Spinner } from '@/components/ui';
import { filterConversations } from '@/chat/list';
import type { Conversation } from '@/db/conversations';
import { useChat } from '@/stores/chat';
import { useTheme } from '@/theme';

export function Sidebar({
  visible,
  currentId,
  onClose,
  onOpen,
  onNew,
  onAllConversations,
  onSettings,
  onReference,
}: {
  visible: boolean;
  /** Marked in the list, and not offered as somewhere to navigate to. */
  currentId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onAllConversations: () => void;
  onSettings: () => void;
  /** Opens the "bring in a message from another chat" search. */
  onReference: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const trap = useDialogKeys(visible, onClose);

  const conversations = useChat((s) => s.conversations);
  const listLoading = useChat((s) => s.listLoading);
  const [query, setQuery] = useState('');

  // Titles, previews, models and tags — the fast pass only. Message text is what
  // `onReference` is for, and mixing "open this chat" and "quote this line" into
  // one result list is how you paste a paragraph when you meant to navigate.
  const filtered = useMemo(() => filterConversations(conversations, { query }), [conversations, query]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close the chat list"
        style={{ flex: 1, backgroundColor: '#00000088', flexDirection: 'row' }}
      >
        <Pressable
          ref={trap}
          onPress={() => {}}
          accessibilityViewIsModal
          style={{
            width: '86%',
            maxWidth: 360,
            flex: 1,
            backgroundColor: t.colors.surface,
            borderTopRightRadius: t.radius.lg,
            borderBottomRightRadius: t.radius.lg,
            paddingTop: insets.top + t.spacing.md,
            paddingBottom: Math.max(t.spacing.md, insets.bottom),
          }}
        >
          <View style={{ paddingHorizontal: t.spacing.md, gap: t.spacing.sm }}>
            <Body weight="700">Chats</Body>
            <Button label="New chat" variant="primary" full onPress={onNew} />
            <Field
              value={query}
              onChangeText={setQuery}
              placeholder="Filter by title, model or tag"
              returnKeyType="search"
            />
          </View>

          <Divider />

          <ScrollView keyboardShouldPersistTaps="handled">
            {listLoading && !conversations.length ? (
              <View style={{ padding: t.spacing.lg }}>
                <Spinner label="Loading" />
              </View>
            ) : filtered.length ? (
              filtered.map((conversation) => (
                <Row
                  key={conversation.id}
                  conversation={conversation}
                  current={conversation.id === currentId}
                  onPress={() => onOpen(conversation.id)}
                />
              ))
            ) : (
              <View style={{ padding: t.spacing.md }}>
                <Body size="sm" tone="faint">
                  {query ? 'No chat title, model or tag matches that.' : 'No other chats yet.'}
                </Body>
              </View>
            )}
          </ScrollView>

          <Divider />
          <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md, gap: t.spacing.sm }}>
            <Button label="Bring in a message…" full onPress={onReference} />
            <Inline gap="sm">
              <Button label="All chats" size="sm" onPress={onAllConversations} />
              <Button label="Settings" size="sm" onPress={onSettings} />
            </Inline>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  conversation,
  current,
  onPress,
}: {
  conversation: Conversation;
  current: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={current}
      accessibilityRole="button"
      accessibilityState={{ selected: current }}
      accessibilityHint={current ? 'This is the chat you are in' : 'Opens this chat'}
      style={({ pressed }) => ({
        paddingHorizontal: t.spacing.md,
        paddingVertical: t.spacing.sm,
        gap: 2,
        backgroundColor: pressed ? t.colors.surfaceActive : current ? t.colors.bg : 'transparent',
      })}
    >
      <Inline gap="sm">
        {conversation.pinned ? <Badge label="Pinned" tone="accent" /> : null}
        <Body size="sm" weight="600" numberOfLines={1} style={{ flex: 1 }}>
          {conversation.title}
        </Body>
        {current ? <Badge label="Here" tone="accent" /> : null}
      </Inline>
      <Body size="xs" tone="faint" numberOfLines={1}>
        {conversation.preview ?? 'No messages yet'}
      </Body>
    </Pressable>
  );
}
