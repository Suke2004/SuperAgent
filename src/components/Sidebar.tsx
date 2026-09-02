/**
 * The chat history, as a drawer over the conversation.
 *
 * The app opens on a chat, so the list is no longer the thing you arrive at — and a
 * history you have to navigate away from the conversation to read is a history you
 * stop reading. This is the same rows as the list screen, grouped by the same
 * `buildRows` and virtualised through the same FlashList, minus everything that
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
 * *beside* this one — a cross-fade would say it replaced the screen. Both run off one
 * shared value on the UI thread so a drag can take over the same value the animation
 * was driving, and the modal stays mounted through the exit so the panel is visible on
 * the way out. Dragging it away is the gesture people try first, and a drawer that only
 * closes by tapping the backdrop feels stuck.
 *
 * That one value is `drawerProgress`, and it is a *module* value rather than local
 * state: the screen underneath scales down and shifts right as the panel comes in, and
 * being in another native window it cannot be handed anything through React. See
 * {@link drawerProgress}.
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDialogKeys } from '@/components/dialog';
import { Icon, iconSize } from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { drawerProgress, useReducedMotion } from '@/components/motion';
import { Body, Divider, Field, Heading, SkeletonRows, MIN_TARGET } from '@/components/ui';
import { curve, duration, spring } from '@/constants/animations';
import { drawerRows } from '@/chat/list';
import type { ListRow } from '@/chat/list';
import type { Conversation } from '@/db/conversations';
import { APP_NAME } from '@/lib/app';
import { useChat } from '@/stores/chat';
import { useProviders } from '@/stores/providers';
import { useTheme } from '@/theme';

/** Same proportions as Claude's: most of the width, capped so it is not a screen. */
const WIDTH_FRACTION = 0.86;
const MAX_WIDTH = 360;

/**
 * Opening is the gesture that wants to feel unhurried; closing wants to get out of the
 * way. Both come from `@/constants/animations` — `duration.panel` is the drawer's old
 * hand-tuned 240 rounded into the 250–300ms band the brief asks for, and `duration.exit`
 * is the same 170-odd it always closed in.
 */
const OPEN_MS = duration.panel;
const CLOSE_MS = duration.exit;

/** Past this much of the panel dragged away, releasing closes it rather than snapping back. */
const CLOSE_FRACTION = 0.35;
/** A flick closes it regardless of distance. dp per second, which is what the gesture reports. */
const CLOSE_VELOCITY = 500;

/**
 * Drag-to-close.
 *
 * The predecessor here was a **capture-phase** `PanResponder`, and the reason is worth
 * keeping: the list inside the panel is a scroller, and in the bubbling phase the child
 * already under the finger wins the responder — so a horizontal drag over the chat rows
 * went to a vertical scroller that had nothing to do with it and the panel never moved.
 *
 * Gesture Handler solves the same problem properly instead of racing it. The list is
 * *its* `ScrollView`, so both handlers are in one arbitration: `activeOffsetX` means this
 * pan does not begin until the finger has committed sideways, and `failOffsetY` means
 * that once it has gone vertical instead, the pan is out for the rest of the drag and
 * the scroller keeps it. No capture, and nothing to refuse to hand back.
 *
 * Rightward drag is clamped away — the panel is already fully open, and letting it
 * rubber-band right would only invent a state to animate back from.
 *
 * A module-level factory rather than three lines in the component, because
 * {@link drawerProgress} lives outside React and the React Compiler will not allow a
 * component body to write to it — reasonably, since from inside a component that is
 * indistinguishable from smuggling state out of the render. Here there is no component
 * to be confused about it.
 *
 * @param grabbed Scratch space for where a drag started, so a second drag continues the
 *   first instead of jumping the panel to the finger.
 */
function drawerPan(width: number, grabbed: SharedValue<number>, onClose: () => void) {
  const settle = () => {
    'worklet';
    drawerProgress.value = withSpring(1, spring.panel);
  };

  return (
    Gesture.Pan()
      .activeOffsetX([-12, 12])
      .failOffsetY([-16, 16])
      .onBegin(() => {
        grabbed.value = drawerProgress.value;
      })
      .onChange((event) => {
        drawerProgress.value = Math.min(1, Math.max(0, grabbed.value + event.translationX / width));
      })
      .onEnd((event) => {
        if (drawerProgress.value < 1 - CLOSE_FRACTION || event.velocityX < -CLOSE_VELOCITY) {
          // Handed to `onClose`, so the screen's state changes and the effect in the
          // component runs the exit — the gesture and a backdrop tap then close the
          // drawer by exactly the same path.
          runOnJS(onClose)();
          return;
        }
        settle();
      })
      // A cancelled gesture — a call arriving, a system pan taking over — must not leave
      // the panel parked half-open with nothing running.
      .onFinalize((_event, success) => {
        if (!success) settle();
      })
  );
}

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
  const reduced = useReducedMotion();
  const { width: screenWidth } = useWindowDimensions();
  const width = Math.min(MAX_WIDTH, Math.round(screenWidth * WIDTH_FRACTION));

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
   * Where the drag started, as a fraction. Held so a second drag continues the first
   * rather than jumping the panel to wherever the finger happens to be.
   */
  const grabbed = useSharedValue(0);
  const pan = drawerPan(width, grabbed, onClose);

  useEffect(() => {
    if (visible) {
      // Reduce Motion shortens the slide and keeps its direction: this move is what says
      // the drawer came from the left edge and belongs back there, which an instant
      // appearance throws away. See `scaleDuration`'s note on positional motion.
      drawerProgress.value = withTiming(1, {
        duration: reduced ? duration.quick : OPEN_MS,
        easing: Easing.bezier(...curve.enter),
      });
      return;
    }
    drawerProgress.value = withTiming(
      0,
      { duration: reduced ? duration.press : CLOSE_MS, easing: Easing.bezier(...curve.exit) },
      (finished) => {
        // Timing rather than a spring on the way out for the same reason as `SheetShell`:
        // this callback unmounts the modal, and a spring's tail would hold an invisible
        // panel mounted for a hundred milliseconds after it had gone.
        if (finished) runOnJS(setMounted)(false);
      },
    );
  }, [visible, reduced]);

  const backdrop = useAnimatedStyle(() => ({ opacity: drawerProgress.value }));
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: -width * (1 - drawerProgress.value) }] }));

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Reanimated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.scrim }, backdrop]}>
          <Pressable onPress={onClose} accessibilityLabel="Close the chat list" style={{ flex: 1 }} />
        </Reanimated.View>

        <GestureDetector gesture={pan}>
          <Reanimated.View
            style={[
              {
                // Absolute rather than a flex child: the panel is a layer over the screen,
                // and as a laid-out sibling of the backdrop its height depended on the
                // parent's flex direction — which is how it ended up a sliver on one screen
                // size and full height on another.
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width,
                backgroundColor: t.colors.surface,
                borderTopRightRadius: t.radius.lg,
                borderBottomRightRadius: t.radius.lg,
                // The rounded corners have to clip the rows, or a row's pressed background
                // squares them off again.
                overflow: 'hidden',
                paddingTop: insets.top + t.spacing.md,
                paddingBottom: Math.max(t.spacing.md, insets.bottom),
              },
              slide,
            ]}
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

            <DrawerHistory
              currentId={currentId}
              onOpen={onOpen}
              onNew={onNew}
              onAllConversations={onAllConversations}
              onReference={onReference}
              links={links}
            />

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
          </Reanimated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}

/**
 * The searchable, grouped, virtualised history — everything between the wordmark and
 * the account footer.
 *
 * Its own component for one reason that is not decomposition for its own sake: it is
 * mounted only while the drawer is, because RN's `Modal` renders nothing when it is
 * closed. So `useState(() => Date.now())` here reads the clock *on each open*, which
 * is what the group headings need and what the parent could not give them — the
 * parent outlives every open, and a render-phase `Date.now()` is impure and rightly
 * rejected by `react-hooks/purity`. Per-open is also the correct staleness: the
 * alternative is re-bucketing on every keystroke, and "Today" becoming "Yesterday"
 * under a finger at midnight is a worse answer than one a few minutes old.
 *
 * `query` lives here for the same reason, and gains something by it: a search no
 * longer survives the close, so the drawer always reopens on the whole history
 * rather than on whatever was typed into it last week.
 */
function DrawerHistory({
  currentId,
  onOpen,
  onNew,
  onAllConversations,
  onReference,
  links,
}: {
  currentId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onAllConversations: () => void;
  onReference: () => void;
  links: readonly SidebarLink[];
}) {
  const t = useTheme();
  const conversations = useChat((s) => s.conversations);
  const listLoading = useChat((s) => s.listLoading);
  const [query, setQuery] = useState('');
  const [now] = useState(() => Date.now());

  /**
   * The same grouped rows the list screen builds, from the same function.
   *
   * The drawer used to render one flat run of chats under a single "History"
   * heading, which is the one place it diverged from the screen it is derived from:
   * pinned chats stayed wherever their timestamp put them, and forty rows had
   * nothing to tell you where last week ended. `buildRows` already answered both,
   * so {@link drawerRows} is a reuse of it rather than a second implementation —
   * and the one thing the drawer does differently, flattening the groups while a
   * search is running, is a decision with a test rather than a branch in JSX.
   *
   * Titles, previews, models and tags — the fast pass only. Message text is what
   * `onReference` is for, and mixing "open this chat" and "quote this line" into one
   * result list is how you paste a paragraph when you meant to navigate.
   */
  const rows = useMemo<readonly ListRow[]>(() => drawerRows(conversations, query, now), [conversations, query, now]);

  return (
    <FlashList
      // Virtualised, where this used to be a `.map()` inside a ScrollView. Four
      // hundred chats meant four hundred mounted rows every time the drawer opened,
      // on the same data the list screen has always paged through a FlashList.
      // `renderScrollComponent` keeps Gesture Handler's scroller, which is what puts
      // the panel's horizontal pan and this vertical one in one arbitration; the
      // default RN scroller would take the drag back and the panel would stop
      // following the finger over the rows.
      data={rows}
      renderScrollComponent={ScrollView}
      // Read from the closure by every row and absent from `data`, so without this a
      // recycled cell keeps the previously open chat's marker.
      extraData={currentId}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.kind}
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <GroupLabel count={item.count}>{item.label}</GroupLabel>
        ) : (
          <Row
            conversation={item.conversation}
            current={item.conversation.id === currentId}
            onPress={() => onOpen(item.conversation.id)}
          />
        )
      }
      ListHeaderComponent={
        <>
          {/* Actions first, because they are a fixed short list and the history
              below is unbounded — a nav row under 400 chats is a nav row nobody
              reaches. Hidden while searching: a filter over the chats should not
              leave unrelated rows sitting above the results. */}
          {query ? null : (
            <>
              <GroupLabel>Actions</GroupLabel>
              {/* The only accent row in the drawer. One coloured row is a primary
                  action; two are a decorated list. */}
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

          {/* Only while searching. Unsearched, every group below carries its own
              heading, and a "History" label above "Pinned" would be a heading over
              a heading. */}
          {query ? <GroupLabel>Matches</GroupLabel> : null}
        </>
      }
      ListEmptyComponent={
        listLoading && !conversations.length ? (
          <View style={{ paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm }}>
            <SkeletonRows count={6} label="Loading your chats" />
          </View>
        ) : (
          <View style={{ padding: t.spacing.md }}>
            <Body size="sm" tone="faint">
              {query ? 'No chat title, model or tag matches that.' : 'No other chats yet.'}
            </Body>
          </View>
        )
      }
      // `flex: 1`, or the list sizes itself to its content: four hundred chats then
      // push the account footer off the bottom of the screen and there is nothing
      // left that scrolls. This is the one line that makes the list usable at any
      // length.
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: t.spacing.md }}
      keyboardShouldPersistTaps="handled"
      // A drag that started vertically stays vertical, so it cannot fight the
      // panel's own horizontal gesture halfway down the list.
      directionalLockEnabled
    />
  );
}

/**
 * A section heading in the drawer. The same tier as `Section`'s title on a screen.
 *
 * `count` is what the date groups carry — "TODAY · 4" — matching the list screen's
 * headings so the same corpus reads the same way in both places. It is announced as
 * part of the header, because a screen reader landing on "Today" wants to know how
 * far the group runs before deciding to skip it.
 */
function GroupLabel({ children, count }: { children: string; count?: number }) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="header"
      style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md, paddingBottom: t.spacing.xs }}
    >
      <Body size="xs" tone="faint" weight="600" style={{ letterSpacing: 0.9, textTransform: 'uppercase' }}>
        {count === undefined ? children : `${children} · ${count}`}
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
