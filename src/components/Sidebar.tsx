/**
 * The chat history, as a drawer over the conversation.
 *
 * The app opens on a chat, so the list is no longer the thing you arrive at — and a
 * history you have to navigate away from the conversation to read is a history you
 * stop reading. This is the same rows as the list screen, minus everything that
 * screen does that a drawer should not: no bulk selection, no export, no archive
 * toggle, no tag filter. Those still live on the full list, one tap away at the
 * bottom.
 *
 * It is also where the app's other places live now — projects, files, skills,
 * prompts, memory, usage. They were behind the ⋯ menu and Settings, which put
 * navigation inside a menu about *this conversation*; a drawer is where you go to
 * leave, so that is where the ways out belong.
 *
 * A `Modal` rather than an animated absolute panel: it gets the Android back
 * button, the iOS focus trap and the same escape/tab handling as the sheets for
 * free, and "collapsed" is then genuinely unmounted rather than a view sitting
 * off-screen intercepting nothing.
 *
 * The panel slides and the backdrop fades because the drawer is a place that is
 * *beside* this one — a cross-fade would say it replaced the screen. Both run on
 * the native driver off one `Animated.Value` so a drag can take over the same
 * value the animation was driving, and the modal stays mounted through the exit so
 * the panel is visible on the way out. Dragging it away is the gesture people try
 * first, and a drawer that only closes by tapping the backdrop feels stuck.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDialogKeys } from '@/components/dialog';
import { Badge, Body, Button, Divider, Field, Spinner } from '@/components/ui';
import { filterConversations } from '@/chat/list';
import type { Conversation } from '@/db/conversations';
import { useChat } from '@/stores/chat';
import { useTheme } from '@/theme';

/** Same proportions as Claude's: most of the width, capped so it is not a screen. */
const WIDTH_FRACTION = 0.86;
const MAX_WIDTH = 360;

/** Opening is the gesture that wants to feel unhurried; closing wants to get out of the way. */
const OPEN_MS = 240;
const CLOSE_MS = 180;

/** Past this much of the panel dragged away, releasing closes it rather than snapping back. */
const CLOSE_FRACTION = 0.35;
/** A flick closes it regardless of distance. dp per millisecond. */
const CLOSE_VELOCITY = 0.5;

/** One entry in the drawer's list of other places. */
export interface SidebarLink {
  label: string;
  /** The state of the thing, not an explanation of it. */
  detail?: string;
  onPress: () => void;
}

export function Sidebar({
  visible,
  currentId,
  onClose,
  onOpen,
  onNew,
  onAllConversations,
  onSettings,
  onReference,
  links = [],
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
  /** Projects, files, skills — the app's other places. Routing stays with the screen. */
  links?: readonly SidebarLink[];
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const trap = useDialogKeys(visible, onClose);
  const { width: screenWidth } = useWindowDimensions();
  const width = Math.min(MAX_WIDTH, Math.round(screenWidth * WIDTH_FRACTION));

  const conversations = useChat((s) => s.conversations);
  const listLoading = useChat((s) => s.listLoading);
  const [query, setQuery] = useState('');

  /**
   * Mounted separately from `visible`.
   *
   * The modal has to outlive the close so the panel can be seen sliding out; without
   * this it vanishes on the first frame and the animation plays to nobody.
   *
   * Opening is adjusted during render rather than in the effect below, because the
   * modal must already be mounted on the frame the slide starts — an effect that
   * mounted it would cost a second render before anything moved, which is exactly the
   * frame the eye notices.
   */
  const [mounted, setMounted] = useState(visible);
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setMounted(true);
  }

  /**
   * How far the panel is pushed off to the left, in dp. 0 is fully open.
   *
   * Lazy `useState` rather than a ref: this is read during render, by the transform
   * and the backdrop's interpolation, which is exactly what a ref is not for.
   */
  const [offset] = useState(() => new Animated.Value(-width));

  useEffect(() => {
    if (visible) {
      Animated.timing(offset, {
        toValue: 0,
        duration: OPEN_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(offset, {
      toValue: -width,
      duration: CLOSE_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, width, offset]);

  /**
   * Drag-to-close.
   *
   * `onMoveShouldSet` rather than `onStartShouldSet`, and only for a horizontal
   * drag: a vertical one belongs to the list, and a tap belongs to the row under
   * the finger. Rightward drag is ignored — the panel is already fully open, and
   * letting it rubber-band right would only invent a state to animate back from.
   */
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dx < -6 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderMove: (_event, gesture) => {
          offset.setValue(Math.max(-width, Math.min(0, gesture.dx)));
        },
        onPanResponderRelease: (_event, gesture) => {
          const far = gesture.dx < -width * CLOSE_FRACTION;
          const flicked = gesture.vx < -CLOSE_VELOCITY;
          if (far || flicked) {
            // Hand it to `onClose` and let the effect above run the exit, so the
            // gesture and the backdrop tap close it exactly the same way.
            onClose();
            return;
          }
          Animated.spring(offset, {
            toValue: 0,
            useNativeDriver: true,
            damping: 20,
            stiffness: 220,
            mass: 0.6,
          }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(offset, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 220, mass: 0.6 }).start();
        },
      }),
    [offset, width, onClose],
  );

  // Titles, previews, models and tags — the fast pass only. Message text is what
  // `onReference` is for, and mixing "open this chat" and "quote this line" into
  // one result list is how you paste a paragraph when you meant to navigate.
  const filtered = useMemo(() => filterConversations(conversations, { query }), [conversations, query]);

  const backdropOpacity = offset.interpolate({
    inputRange: [-width, 0],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#00000088', opacity: backdropOpacity }]}>
          <Pressable onPress={onClose} accessibilityLabel="Close the chat list" style={{ flex: 1 }} />
        </Animated.View>

        <Animated.View
          {...pan.panHandlers}
          style={{
            width,
            flex: 1,
            transform: [{ translateX: offset }],
            backgroundColor: t.colors.surface,
            borderTopRightRadius: t.radius.lg,
            borderBottomRightRadius: t.radius.lg,
            paddingTop: insets.top + t.spacing.md,
            paddingBottom: Math.max(t.spacing.md, insets.bottom),
          }}
        >
          {/* The trap is on an inner view: `accessibilityViewIsModal` on the animated
              panel would be re-evaluated on every frame of the transform. */}
          <Pressable ref={trap} onPress={() => {}} accessibilityViewIsModal style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: t.spacing.md, gap: t.spacing.sm }}>
              <Button label="New chat" variant="primary" full onPress={onNew} />
              <Field
                value={query}
                onChangeText={setQuery}
                placeholder="Search chats"
                returnKeyType="search"
              />
            </View>

            <Divider />

            <ScrollView keyboardShouldPersistTaps="handled">
              {/* The other places first, because they are a fixed short list and the
                  history below is unbounded — a nav row at the bottom of 400 chats is
                  a nav row nobody reaches. Hidden while searching: a filter over the
                  chats should not leave unrelated rows sitting above the results. */}
              {links.length > 0 && !query ? (
                <>
                  {links.map((link) => (
                    <LinkRow key={link.label} link={link} />
                  ))}
                  <Divider />
                </>
              ) : null}

              <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md, paddingBottom: t.spacing.xs }}>
                <Body size="xs" tone="faint" weight="600">
                  {query ? 'Matches' : 'Recents'}
                </Body>
              </View>

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
              <View style={{ flexDirection: 'row', gap: t.spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Button label="All chats" size="sm" full onPress={onAllConversations} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label="Settings" size="sm" full onPress={onSettings} />
                </View>
              </View>
            </View>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** One of the app's other places. Same row metrics as a chat, so the list reads as one. */
function LinkRow({ link }: { link: SidebarLink }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={link.onPress}
      accessibilityRole="button"
      {...(link.detail !== undefined ? { accessibilityHint: link.detail } : {})}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.sm,
        paddingHorizontal: t.spacing.md,
        paddingVertical: t.spacing.sm + 2,
        backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
      })}
    >
      <Body size="sm" weight="600" style={{ flex: 1 }} numberOfLines={1}>
        {link.label}
      </Body>
      {link.detail !== undefined ? (
        <Body size="xs" tone="faint" numberOfLines={1}>
          {link.detail}
        </Body>
      ) : null}
      <Body size="sm" tone="faint">
        ›
      </Body>
    </Pressable>
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
        {conversation.pinned ? <Badge label="Pinned" tone="accent" /> : null}
        <Body size="sm" weight="600" numberOfLines={1} style={{ flex: 1 }}>
          {conversation.title}
        </Body>
        {current ? <Badge label="Here" tone="accent" /> : null}
      </View>
      <Body size="xs" tone="faint" numberOfLines={1}>
        {conversation.preview ?? 'No messages yet'}
      </Body>
    </Pressable>
  );
}
