/**
 * The artifact preview: a rendered code block in a panel over the transcript.
 *
 * A `Modal` over a locked-down `WebView`. The document it loads is built by
 * `@/chat/artifact`, which is where the content security policy and the reasoning
 * behind it live; what this file owns is the part a policy cannot express — that the
 * WebView is not allowed to *go* anywhere.
 *
 * Three refusals, all deliberate:
 *
 * - `originWhitelist={[]}` plus `onShouldStartLoadWithRequest` returning false for
 *   everything after the first load. A tapped link, a `window.location`, a form post:
 *   all dead. Without this a hostile artifact needs one `<a>` and one tap to put the
 *   user on somebody else's page inside an app that holds their API keys.
 * - No file access, no storage, no media capture. The artifact is a picture, not a
 *   program with a device attached.
 * - `incognito`, so nothing it does survives the modal closing.
 *
 * JavaScript is on. An SVG chart or a small interactive page is most of why anyone
 * wants this, and inline script that can reach neither the network nor the filesystem
 * is a calculator in a locked room.
 *
 * ## Why a side panel rather than a full screen
 *
 * It used to be `animationType="slide"` over the whole window, which is the shape of a
 * *screen* — and a screen is a place you have gone, not a thing you are looking at
 * alongside the conversation that produced it. The panel keeps a strip of the transcript
 * visible at the left edge, and the transcript itself shifts left and shrinks behind it
 * (see {@link useScenePush}), so the relationship between the two is on screen: the
 * artifact came from *that*, and *that* is still there.
 *
 * On a phone the strip is all the room there is — this is not a two-pane layout, and
 * pretending otherwise would leave the preview too narrow to be a preview. That is the
 * honest limit of the effect at this width.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { WebView } from 'react-native-webview';

import { useDialogKeys } from '@/components/dialog';
import { panelProgress, useReducedMotion } from '@/components/motion';
import { Body, Note, Spinner } from '@/components/ui';
import { artifactDocument } from '@/chat/artifact';
import type { ArtifactKind } from '@/chat/artifact';
import { curve, duration, spring } from '@/constants/animations';
import { useTheme } from '@/theme';

/** How much of the window the panel leaves showing at the left edge, as a fraction. */
const PEEK = 0.08;

/** Rightward drag, as a fraction of the panel's width, that dismisses on release. */
const DISMISS_FRACTION = 1 / 3;

/** Rightward velocity, in dp/s, that dismisses regardless of distance. */
const DISMISS_VELOCITY = 700;

/**
 * The pan, built outside the component.
 *
 * `panelProgress` is a module value, and the React Compiler will not allow a component
 * body to write to one at all — the same constraint the drawer's `drawerPan` was hoisted
 * for, and the same fix. See `Sidebar`.
 */
function panelPan(width: number, grabbed: { value: number }, onClose: () => void) {
  const settle = (): void => {
    'worklet';
    panelProgress.value = withSpring(1, spring.panel);
  };
  return Gesture.Pan()
    // Horizontal only, and only after 12dp: the WebView underneath scrolls, and a
    // vertical drag on an artifact belongs to the artifact.
    .activeOffsetX([-12, 12])
    .failOffsetY([-16, 16])
    .onBegin(() => {
      grabbed.value = panelProgress.value;
    })
    .onChange((event) => {
      // Rightward closes, so progress falls as translation grows. Clamped at 1: dragging
      // left would pull the panel off its own left edge and show a gap.
      panelProgress.value = Math.min(1, Math.max(0, grabbed.value - event.translationX / width));
    })
    .onEnd((event) => {
      if (panelProgress.value < 1 - DISMISS_FRACTION || event.velocityX > DISMISS_VELOCITY) {
        // `onClose` rather than animating from here: the screen owns `visible`, and a
        // panel that dismissed itself silently would leave the app thinking it is open.
        runOnJS(onClose)();
        return;
      }
      settle();
    })
    // A cancelled gesture — a phone call, a rotation mid-drag — otherwise leaves the
    // panel parked half-open with no finger on it.
    .onFinalize((_event, success) => {
      if (!success) settle();
    });
}

export function ArtifactPreview({
  visible,
  code,
  kind,
  onClose,
}: {
  visible: boolean;
  code: string;
  kind: ArtifactKind;
  onClose: () => void;
}) {
  const t = useTheme();
  const trap = useDialogKeys(visible, onClose);
  const reduced = useReducedMotion();
  const window = useWindowDimensions();
  const [loading, setLoading] = useState(true);
  /** Set when the artifact tried to navigate. Shown, not hidden: it is worth knowing. */
  const [blocked, setBlocked] = useState<string | null>(null);
  /**
   * Whether the document itself has been handed over yet.
   *
   * `onShouldStartLoadWithRequest` fires for the `source={{ html }}` load too, so a
   * blanket `false` would render nothing at all. The first request is the document; every
   * one after it is the artifact trying to leave.
   */
  const started = useRef(false);

  /** Kept mounted through the exit, as {@link SheetShell} is, and for the same reason. */
  const [mounted, setMounted] = useState(visible);
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setMounted(true);
  }

  const width = window.width * (1 - PEEK);
  const grabbed = useSharedValue(0);
  const pan = panelPan(width, grabbed, onClose);

  useEffect(() => {
    if (visible) {
      panelProgress.value = reduced
        ? withTiming(1, { duration: duration.quick, easing: Easing.bezier(...curve.enter) })
        : withSpring(1, spring.panel);
      return;
    }
    // Timing out, not a spring: the completion callback unmounts the modal, and a
    // spring's arrival time is a consequence of its physics rather than a promise it can
    // keep. A spring's tail would hold an invisible panel — and its WebView — mounted.
    panelProgress.value = withTiming(
      0,
      { duration: duration.exit, easing: Easing.bezier(...curve.exit) },
      (finished) => {
        if (finished) runOnJS(setMounted)(false);
      },
    );
  }, [visible, reduced]);

  /**
   * Put the scene back when this component is unmounted rather than told to hide.
   *
   * `CodeBlock` mounts the preview to open it and unmounts it to close — it has to, or a
   * transcript with twenty fences in it holds twenty WebViews. So `visible: false` never
   * arrives, the exit effect above never runs, and {@link panelProgress} is left at `1`
   * for the rest of the session: the transcript underneath keeps the 6% shrink, the 14dp
   * shift and the rounded corners {@link useScenePush} gave it, and the *next* preview
   * slides in from a value that is already `1`, so it pops instead. A module value has to
   * be returned by whoever moved it.
   *
   * Its own effect, not the one above: that one's cleanup would also run whenever
   * `visible` or `reduced` changed, and undo the animation it had just started.
   */
  useEffect(
    () => () => {
      panelProgress.value = withTiming(0, { duration: duration.exit, easing: Easing.bezier(...curve.exit) });
    },
    [],
  );

  const backdrop = useAnimatedStyle(() => ({ opacity: panelProgress.value }));
  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: width * (1 - panelProgress.value) }],
  }));

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      // Both halves of the transition are ours; `Modal`'s own would apply on top.
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      onShow={() => {
        started.current = false;
        setLoading(true);
        setBlocked(null);
      }}
    >
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {/* The peek. Tapping it closes, which is the "tap outside" half of the gesture
            pair — and it is also why the panel is not full width: a dismissal you can
            reach without aiming at a control needs somewhere to aim at. */}
        <Reanimated.View style={[StyleSheet.absoluteFill, backdrop]}>
          <Pressable
            onPress={onClose}
            accessibilityLabel="Close the preview"
            style={{ flex: 1, backgroundColor: t.colors.scrim }}
          />
        </Reanimated.View>

        <GestureDetector gesture={pan}>
          <Reanimated.View
            accessibilityViewIsModal
            style={[
              {
                position: 'absolute',
                right: 0,
                top: 0,
                bottom: 0,
                width,
                backgroundColor: t.colors.bg,
                borderTopLeftRadius: t.radius.lg,
                borderBottomLeftRadius: t.radius.lg,
                overflow: 'hidden',
              },
              slide,
            ]}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: t.spacing.md,
                paddingTop: t.spacing.xxl,
                paddingBottom: t.spacing.sm,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: t.colors.border,
              }}
            >
              <Body>{kind === 'svg' ? 'SVG preview' : 'HTML preview'}</Body>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close the preview"
                onPress={onClose}
                hitSlop={12}
                ref={trap}
                style={({ pressed }) => ({
                  paddingHorizontal: t.spacing.sm,
                  paddingVertical: t.spacing.xs,
                  borderRadius: t.radius.sm,
                  backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
                })}
              >
                <Text style={{ color: t.colors.accent, fontSize: t.fontSize.sm, fontWeight: '700' }}>Done</Text>
              </Pressable>
            </View>

            {blocked ? (
              <View style={{ padding: t.spacing.md }}>
                <Note tone="warning" live>
                  {`This preview tried to open ${blocked}. It was not allowed to — a preview cannot navigate anywhere. Nothing was loaded.`}
                </Note>
              </View>
            ) : null}

            <View style={{ flex: 1 }}>
              <WebView
                // Sandbox first. Every one of these is a refusal, not a preference.
                originWhitelist={[]}
                source={{ html: artifactDocument(code, kind) }}
                javaScriptEnabled
                allowFileAccess={false}
                allowFileAccessFromFileURLs={false}
                allowUniversalAccessFromFileURLs={false}
                allowsInlineMediaPlayback={false}
                mediaPlaybackRequiresUserAction
                domStorageEnabled={false}
                thirdPartyCookiesEnabled={false}
                sharedCookiesEnabled={false}
                incognito
                // A popup would be a second WebView this code never configured.
                setSupportMultipleWindows={false}
                onShouldStartLoadWithRequest={(request) => {
                  if (!started.current) {
                    started.current = true;
                    return true;
                  }
                  setBlocked(request.url.slice(0, 80));
                  return false;
                }}
                onLoadEnd={() => setLoading(false)}
                style={{ flex: 1, backgroundColor: '#ffffff' }}
              />
              {loading ? (
                <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                  <Spinner label="Rendering" />
                </View>
              ) : null}
            </View>

            <View style={{ padding: t.spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.border }}>
              <Body tone="dim" size="sm">
                Rendered on this device with no network access. The model wrote this — it can be wrong, and it cannot
                reach your keys, your files or the internet from here.
              </Body>
            </View>
          </Reanimated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}
