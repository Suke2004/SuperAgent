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
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDialogKeys } from '@/components/dialog';
import { Icon, iconSize } from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { Body, Divider, Field, Heading, SkeletonRows, MIN_TARGET } from '@/components/ui';
import { filterConversations } from '@/chat/list';
import type { Conversation } from '@/db/conversations';
import { APP_NAME } from '@/lib/app';
import { useChat } from '@/stores/chat';
import { useProviders } from '@/stores/providers';
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
  /** Leading icon. Required in spirit: a drawer with some rows iconed reads as broken. */
  icon: IconName;
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
  /**
   * The active gateway profile, read here rather than passed in.
   *
   * This app has no user account, so the footer names the thing that actually
   * answers the "whose credits am I spending" question the reference app answers
   * with a person's name. The component already reads the chat store directly; a
   * prop for this would only be a longer path to the same subscription.
   */
  const profiles = useProviders((s) => s.profiles);
  const activeProfileId = useProviders((s) => s.activeId);
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
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
   * A rotation while the drawer is closed leaves the panel parked at the *old*
   * width, which is a sliver of it visible down the edge on the wider screen. Nothing
   * animates here — there is nothing on screen to animate.
   */
  useEffect(() => {
    if (!visible) offset.setValue(-width);
  }, [width, visible, offset]);

  /**
   * Drag-to-close.
   *
   * **Capture phase**, which is the whole reason this works: the list inside the panel
   * is a `ScrollView`, and in the bubbling phase the child that is already under the
   * finger wins the responder — so a horizontal drag anywhere over the chat rows was
   * being handed to a vertical scroller that had nothing to do with it, and the panel
   * never moved. Capturing lets the panel claim the gesture first, and only for a
   * gesture that is unambiguously horizontal and leftward: a vertical one still
   * belongs to the list, and a tap still belongs to the row under the finger.
   *
   * Rightward drag is ignored — the panel is already fully open, and letting it
   * rubber-band right would only invent a state to animate back from.
   */
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          gesture.dx < -6 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        // Once the drag is ours, the scroller may not ask for it back mid-gesture.
        onPanResponderTerminationRequest: () => false,
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
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.scrim, opacity: backdropOpacity }]}>
          <Pressable onPress={onClose} accessibilityLabel="Close the chat list" style={{ flex: 1 }} />
        </Animated.View>

        <Animated.View
          {...pan.panHandlers}
          style={{
            // Absolute rather than a flex child: the panel is a layer over the screen,
            // and as a laid-out sibling of the backdrop its height depended on the
            // parent's flex direction — which is how it ended up a sliver on one screen
            // size and full height on another.
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width,
            transform: [{ translateX: offset }],
            backgroundColor: t.colors.surface,
            borderTopRightRadius: t.radius.lg,
            borderBottomRightRadius: t.radius.lg,
            // The rounded corners have to clip the rows, or a row's pressed background
            // squares them off again.
            overflow: 'hidden',
            paddingTop: insets.top + t.spacing.md,
            paddingBottom: Math.max(t.spacing.md, insets.bottom),
          }}
        >
          {/* The trap is on an inner view: `accessibilityViewIsModal` on the animated
              panel would be re-evaluated on every frame of the transform. */}
          <Pressable ref={trap} onPress={() => {}} accessibilityViewIsModal style={{ flex: 1 }}>
            {/* The wordmark, in the serif. It is the one place the app says its own
                name at rest, and it doubles as the drawer's heading — which is why
                there is no second "Chats" title under it. */}
            <View
              accessibilityRole="header"
              style={{ paddingHorizontal: t.spacing.md, paddingBottom: t.spacing.md }}
            >
              <Heading style={{ fontSize: t.fontSize.xxl }}>{APP_NAME}</Heading>
            </View>

            <ScrollView
              // `flex: 1`, or the scroller sizes itself to its content: four hundred
              // chats then push the account footer off the bottom of the screen and
              // there is nothing left that scrolls. This is the one line that makes the
              // list usable at any length.
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: t.spacing.md }}
              keyboardShouldPersistTaps="handled"
              // A drag that started vertically stays vertical, so it cannot fight the
              // panel's own horizontal gesture halfway down the list.
              directionalLockEnabled
            >
              {/* Actions first, because they are a fixed short list and the history
                  below is unbounded — a nav row under 400 chats is a nav row nobody
                  reaches. Hidden while searching: a filter over the chats should not
                  leave unrelated rows sitting above the results. */}
              {query ? null : (
                <>
                  <GroupLabel>Actions</GroupLabel>
                  {/* The only accent row in the drawer. One coloured row is a
                      primary action; two are a decorated list. */}
                  <NavRow icon="newChat" label="New chat" accent onPress={onNew} />
                  <NavRow icon="chats" label="Chats" onPress={onAllConversations} />
                  <NavRow icon="quote" label="Bring in a message…" onPress={onReference} />
                  {links.map((link) => (
                    <NavRow
                      key={link.label}
                      icon={link.icon}
                      label={link.label}
                      {...(link.detail !== undefined ? { detail: link.detail } : {})}
                      onPress={link.onPress}
                    />
                  ))}
                  <Divider />
                </>
              )}

              <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md }}>
                <Field
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search chats"
                  returnKeyType="search"
                  right={
                    query ? (
                      <Pressable
                        onPress={() => setQuery('')}
                        accessibilityRole="button"
                        accessibilityLabel="Clear search"
                        hitSlop={12}
                      >
                        <Icon name="close" tone="textFaint" />
                      </Pressable>
                    ) : (
                      <Icon name="search" tone="textFaint" />
                    )
                  }
                />
              </View>

              <GroupLabel>{query ? 'Matches' : 'History'}</GroupLabel>

              {listLoading && !conversations.length ? (
                <View style={{ paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm }}>
                  <SkeletonRows count={6} label="Loading your chats" />
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

            {/* Account, pinned to the bottom rather than scrolling with the history:
                it is about the app, not about this list, and it is the row a user
                goes looking for when they want out of the drawer entirely. */}
            <Divider />
            <AccountFooter
              name={activeProfile?.name ?? 'No provider'}
              {...(activeProfile ? {} : { detail: 'Add one in Settings' })}
              onPress={onSettings}
            />
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** A section heading in the drawer. The same tier as `Section`'s title on a screen. */
function GroupLabel({ children }: { children: string }) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="header"
      style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md, paddingBottom: t.spacing.xs }}
    >
      <Body size="xs" tone="faint" weight="600" style={{ letterSpacing: 0.9, textTransform: 'uppercase' }}>
        {children}
      </Body>
    </View>
  );
}

/**
 * One icon-and-label row: a place to go, or the action that starts a chat.
 *
 * The icon gutter is a fixed width so every label in the drawer starts on the same
 * vertical line — including the chat titles below, which have no icon and pay the
 * same left padding instead.
 */
function NavRow({
  icon,
  label,
  detail,
  accent,
  onPress,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  /** The primary action. Exactly one row in the drawer wears this. */
  accent?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(detail !== undefined ? { accessibilityHint: detail } : {})}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingHorizontal: t.spacing.md,
        paddingVertical: t.spacing.sm + 2,
        minHeight: MIN_TARGET,
        backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
      })}
    >
      <View style={{ width: iconSize.lg, alignItems: 'center' }}>
        <Icon name={icon} size="lg" tone={accent ? 'accent' : 'textDim'} />
      </View>
      <Body size="md" tone={accent ? 'accent' : 'normal'} weight={accent ? '600' : '400'} style={{ flex: 1 }} numberOfLines={1}>
        {label}
      </Body>
      {detail !== undefined ? (
        <Body size="xs" tone="faint" numberOfLines={1}>
          {detail}
        </Body>
      ) : null}
    </Pressable>
  );
}

/**
 * The account row.
 *
 * Initials in a disc rather than an icon, because this row identifies *which* of
 * several things is active — and a generic person glyph would look identical for
 * every profile, which is the one thing it must not do.
 */
function AccountFooter({
  name,
  detail,
  onPress,
}: {
  name: string;
  detail?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Settings. Active provider: ${name}`}
      accessibilityHint="Opens Settings"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingHorizontal: t.spacing.md,
        paddingVertical: t.spacing.sm + 2,
        minHeight: MIN_TARGET,
        backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
      })}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.colors.accentSoft,
        }}
      >
        {/* Fixed metrics: the disc does not grow, so neither may the initials. The
            row's own accessibility label carries the name at a scalable size. */}
        <Text
          allowFontScaling={false}
          style={{ color: t.colors.accent, fontSize: t.fontSize.xs, fontWeight: '700' }}
        >
          {initials || '—'}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Body size="sm" weight="600" numberOfLines={1}>
          {name}
        </Body>
        {detail !== undefined ? (
          <Body size="xs" tone="faint" numberOfLines={1}>
            {detail}
          </Body>
        ) : null}
      </View>
      <Icon name="settings" size="lg" tone="textDim" />
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
        // The active row is a soft accent fill with a clay bar down its left edge.
        // The bar is what makes it findable in a peripheral glance at forty rows;
        // the fill alone reads as a pressed state that got stuck. Both replaced the
        // "Here" badge that used to say the same thing in words, twice over — the
        // announced `selected` state is what a screen reader needs, and it is free.
        borderLeftWidth: 3,
        borderLeftColor: current ? t.colors.accentFill : 'transparent',
        paddingLeft: t.spacing.md - 3,
        paddingRight: t.spacing.md,
        paddingVertical: t.spacing.sm,
        gap: 2,
        backgroundColor: pressed ? t.colors.surfaceActive : current ? t.colors.accentSoft : 'transparent',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
        {conversation.pinned ? <Icon name="pin" size="sm" tone="accent" /> : null}
        <Body size="sm" weight="600" numberOfLines={1} style={{ flex: 1 }}>
          {conversation.title}
        </Body>
      </View>
      <Body size="xs" tone="faint" numberOfLines={1}>
        {conversation.preview ?? 'No messages yet'}
      </Body>
    </Pressable>
  );
}
