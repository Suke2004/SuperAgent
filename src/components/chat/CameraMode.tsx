/**
 * The in-app camera: photograph something, then ask about it.
 *
 * A full-screen `Modal` over the chat screen, like `VoiceMode` and for the same reason —
 * the shots have to land in the composer of the conversation the user was already in, and a
 * route of its own would have needed its own copy of what is staged plus a merge on the way
 * back.
 *
 * ## What this has that the system camera does not
 *
 * `expo-image-picker`'s `launchCameraAsync` already worked and is still there behind
 * *Take a photo → System camera*. What it cannot do is the thing people actually do with a
 * camera in a chat app: **take four photos of the same page and keep the one that is in
 * focus.** It returns one asset and closes, so four photos is four round trips through
 * another app, with no way to compare them and no way to drop one. That is the whole
 * argument for a viewfinder inside the app, and the review strip is the feature — not the
 * preview.
 *
 * ## Nothing is encoded until you leave
 *
 * The shutter writes a JPEG to this app's cache and pushes a path. No resize, no base64, no
 * work on the JS thread at all — see `@/chat/camera`. *Use* runs the whole session through
 * `captureShots` in one sequential pass, which is where the existing single-bitmap-at-a-time
 * guarantee comes from, and *retake* and *close* delete the files.
 *
 * ## The permission is asked for here, not at the sheet
 *
 * `useCameraPermissions` rather than a check in the attach sheet, because the honest place
 * to ask is the screen that needs it: a user who taps *Camera* has just said what they want,
 * and the system dialog then arrives with the viewfinder behind it. A permanent refusal
 * turns into the same *Open Settings* action the pickers use, from the same `openAppSettings`.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useRef, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { openAppSettings } from '@/chat/attach';
import {
  describeSession,
  flashFor,
  flashLabel,
  nextFlash,
  shotName,
  type Facing,
  type Flash,
  type Shot,
} from '@/chat/camera';
import { Icon, type IconName } from '@/components/Icon';
import { usePressFeedback } from '@/components/motion';
import { Body, Button, MIN_TARGET, Note, useFocusRing } from '@/components/ui';
import * as haptics from '@/lib/haptics';
import { log } from '@/lib/log';
import { useTheme } from '@/theme';

/** The shutter's diameter. Large, round, centred and unmistakable — it is pressed by feel. */
const SHUTTER = 76;

/** A review thumbnail's edge. Big enough to tell a blurred page from a sharp one. */
const THUMB = 56;

export function CameraMode(props: {
  visible: boolean;
  onClose: () => void;
  /** Encodes and stages the session. Resolves when the composer has the blocks. */
  onUse: (shots: readonly Shot[]) => Promise<void>;
  /** Deletes abandoned shots. The caller owns the cache, so the caller sweeps it. */
  onDiscard: (shots: readonly Shot[]) => void;
  /** How many more attachments this message and this chat can carry. */
  left: number;
}) {
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
      // Mounted only while open, like `VoiceMode`: `CameraView` holds the camera open for
      // as long as it exists, and an app with a live camera behind the transcript is the
      // one bug here that would end up in a review.
    >
      {props.visible ? <CameraBody {...props} /> : null}
    </Modal>
  );
}

function CameraBody({ onClose, onUse, onDiscard, left }: Parameters<typeof CameraMode>[0]) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();

  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<Facing>('back');
  const [flash, setFlash] = useState<Flash>('off');
  const [ready, setReady] = useState(false);
  const [shots, setShots] = useState<readonly Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // `left` is what the composer had room for when the camera opened; every shot taken since
  // is one of those slots spoken for. Counted here rather than re-asked of the store,
  // because nothing can stage an attachment while this modal is up.
  const room = Math.max(0, left - shots.length);
  const canShoot = ready && !busy && room > 0;

  /**
   * Fires the shutter.
   *
   * `setBusy` spans the native call and nothing else: `takePictureAsync` takes a few
   * hundred milliseconds and a second press inside that window is a second file with no
   * `onPictureSaved` to match it. The encode is not in here at all, which is the point.
   */
  const shoot = useCallback(async () => {
    if (!camera.current) return;
    setBusy(true);
    setNote(null);
    try {
      const picture = await camera.current.takePictureAsync({
        // Full quality on the way out of the sensor. The size control is the resize ladder
        // in `attach.ts`, one step later, and compressing twice only adds artefacts to
        // pixels that are about to be resampled — the same reasoning as `pickImages`.
        quality: 1,
        // No EXIF, so no GPS coordinates ride along with a photo of a whiteboard.
        exif: false,
        skipProcessing: false,
      });
      if (!picture?.uri) {
        setNote('The camera returned nothing. Try again.');
        return;
      }
      haptics.tap();
      setShots((current) => [
        ...current,
        {
          uri: picture.uri,
          width: picture.width,
          height: picture.height,
          fileName: shotName(current.length),
        },
      ]);
    } catch (error) {
      log.warn('camera', 'could not take a picture', error);
      setNote('That photo could not be taken. The camera may be in use by another app.');
    } finally {
      setBusy(false);
    }
  }, []);

  /** Drops one shot and deletes its file. The strip is the only way in. */
  const remove = useCallback(
    (index: number) => {
      haptics.warn();
      setShots((current) => {
        const gone = current[index];
        if (gone) onDiscard([gone]);
        return current.filter((_, at) => at !== index);
      });
    },
    [onDiscard],
  );

  const use = useCallback(async () => {
    if (!shots.length) return;
    setBusy(true);
    try {
      haptics.confirm();
      await onUse(shots);
      // Cleared before closing so a reopened camera does not start with the last session's
      // shots — whose files `captureShots` has already deleted.
      setShots([]);
      onClose();
    } finally {
      setBusy(false);
    }
  }, [shots, onUse, onClose]);

  /** Leaving without using them. Everything taken in this session goes. */
  const cancel = useCallback(() => {
    if (shots.length) onDiscard(shots);
    setShots([]);
    onClose();
  }, [shots, onDiscard, onClose]);

  const flip = () => {
    haptics.tap();
    const next: Facing = facing === 'back' ? 'front' : 'back';
    setFacing(next);
    // Re-validated rather than carried across: there is no lamp on the front of a phone.
    // Computed out here and not inside `setFacing`'s updater — a second `setState` called
    // from inside an updater runs twice under React's development double-invoke, and a
    // flash mode is exactly the kind of state where running the transition twice lands
    // somewhere else.
    setFlash((mode) => flashFor(mode, next));
  };

  if (!permission) {
    // The hook has not answered yet. One frame, usually — a spinner here would flash.
    return <Shell insets={insets} />;
  }

  if (!permission.granted) {
    return (
      <Shell insets={insets}>
        <View style={{ flex: 1, justifyContent: 'center', gap: t.spacing.lg, paddingHorizontal: t.spacing.lg }}>
          <Body size="lg">
            {permission.canAskAgain
              ? 'The camera is needed to take a photo. The photo stays on this device until you press send.'
              : 'Camera access is turned off for this app. Open Settings → Permissions to allow it.'}
          </Body>
          <View style={{ gap: t.spacing.sm }}>
            {permission.canAskAgain ? (
              <Button label="Allow the camera" onPress={() => void requestPermission()} />
            ) : (
              <Button label="Open Settings" onPress={() => void openAppSettings()} />
            )}
            <Button label="Not now" variant="ghost" onPress={cancel} />
          </View>
        </View>
      </Shell>
    );
  }

  return (
    <Shell insets={insets}>
      <View style={{ flex: 1 }}>
        <CameraView
          ref={camera}
          style={StyleSheet.absoluteFill}
          facing={facing}
          flash={flash}
          mode="picture"
          // The app never records video, so the microphone is never opened. Stated as a
          // prop as well as in the config plugin, because the plugin only governs the
          // manifest and this governs the session.
          mute
          onCameraReady={() => setReady(true)}
          onMountError={(event) => {
            log.warn('camera', 'mount error', event);
            setNote('The camera could not be started. Another app may be using it.');
          }}
          animateShutter={false}
        />

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: t.spacing.md,
            gap: t.spacing.sm,
          }}
        >
          <Disc label="Close the camera" icon="close" onPress={cancel} />
          <Disc
            label={flashLabel(flash)}
            icon={flash === 'off' ? 'flashOff' : 'flash'}
            hint="Cycles through the flash modes this camera has."
            onPress={() => {
              setFlash((mode) => nextFlash(mode, facing));
            }}
          />
        </View>

        <View style={{ flex: 1 }} />

        {note ? (
          <View style={{ paddingHorizontal: t.spacing.md, paddingBottom: t.spacing.sm }}>
            <Note tone="warning" live>
              {note}
            </Note>
          </View>
        ) : null}

        {shots.length ? <Strip shots={shots} onRemove={remove} /> : null}

        <View
          style={{
            paddingHorizontal: t.spacing.md,
            paddingBottom: t.spacing.sm,
            alignItems: 'center',
          }}
        >
          {/* `live`, because the count changes without the user having touched this row. */}
          <Caption live>{describeSession(shots.length, room)}</Caption>
        </View>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: t.spacing.xl,
            paddingBottom: t.spacing.md,
            gap: t.spacing.md,
          }}
        >
          <Disc label="Switch camera" icon="flip" disabled={busy} onPress={flip} />
          <Shutter
            disabled={!canShoot}
            reason={
              !ready
                ? 'The camera is still starting.'
                : room <= 0
                  ? 'That is as many photos as this message can carry. Remove one to take another.'
                  : 'A photo is being taken.'
            }
            onPress={() => void shoot()}
          />
          {/* A spacer rather than a disabled button. *Use* has nothing to mean before the
              first photo, and a greyed control the user has to reason about is worse than
              a control that is not there yet — the status line above already says what to
              do. It appears the instant there is something to use. */}
          {shots.length ? (
            <Disc
              label={`Use ${shots.length === 1 ? 'this photo' : `these ${shots.length} photos`}`}
              hint="Adds them to the message. Nothing is sent until you press send."
              icon="check"
              disabled={busy}
              onPress={() => void use()}
              emphasis
            />
          ) : (
            <View style={{ width: MIN_TARGET, height: MIN_TARGET }} />
          )}
        </View>
      </View>
    </Shell>
  );
}

/**
 * The black frame everything sits in.
 *
 * Its own component because the permission screen and the viewfinder need the identical
 * insets and background, and a viewfinder that jumps when permission is granted is a
 * flicker with no cause the user can see.
 */
function Shell({
  insets,
  children,
}: {
  insets: { top: number; bottom: number };
  children?: React.ReactNode;
}) {
  return (
    <View
      style={{
        flex: 1,
        // Black rather than the theme surface: the viewfinder fills this, and any other
        // colour shows as a seam down the side of the preview on a non-4:3 sensor.
        backgroundColor: '#000000',
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
      accessibilityViewIsModal
    >
      {children}
    </View>
  );
}

/**
 * What has been taken so far, and the way to drop one.
 *
 * Horizontal, newest last, and each thumbnail is its own button that removes itself. A
 * separate delete mode would be a mode; a long-press would be undiscoverable. The label
 * says what tapping does, because a thumbnail that deletes on tap is otherwise a trap.
 */
function Strip({ shots, onRemove }: { shots: readonly Shot[]; onRemove: (index: number) => void }) {
  const t = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: t.spacing.sm, paddingHorizontal: t.spacing.md, paddingBottom: t.spacing.sm }}
    >
      {shots.map((shot, index) => (
        <Pressable
          key={shot.uri}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${shot.fileName}`}
          onPress={() => onRemove(index)}
          style={{
            width: THUMB,
            height: THUMB,
            borderRadius: t.radius.sm,
            overflow: 'hidden',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: '#ffffff66',
          }}
        >
          <Image
            source={{ uri: shot.uri }}
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            style={{ width: '100%', height: '100%' }}
          />
          <View
            style={{
              position: 'absolute',
              right: 2,
              top: 2,
              borderRadius: t.radius.pill,
              backgroundColor: '#000000aa',
              padding: 2,
            }}
          >
            <Icon name="close" size="sm" color="#ffffff" />
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/**
 * The shutter.
 *
 * The one control on this screen that is not an icon in a circle, because it is the one
 * pressed without looking at it. Disabled states carry the reason as a hint rather than
 * greying out silently — "the camera is still starting" and "that is the limit" are two
 * very different waits and only one of them ends.
 */
function Shutter({ disabled, reason, onPress }: { disabled: boolean; reason: string; onPress: () => void }) {
  const { ring, handlers } = useFocusRing();
  const { pressStyle, pressHandlers } = usePressFeedback({ disabled, haptic: false });

  return (
    <Reanimated.View style={pressStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Take a photo"
        accessibilityState={{ disabled }}
        accessibilityHint={disabled ? reason : 'Adds the photo to this message. Nothing is sent until you press send.'}
        disabled={disabled}
        onPress={onPress}
        {...handlers}
        {...pressHandlers}
        style={[
          {
            width: SHUTTER,
            height: SHUTTER,
            borderRadius: SHUTTER / 2,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 3,
            borderColor: '#ffffff',
            backgroundColor: '#ffffff33',
            opacity: disabled ? 0.4 : 1,
          },
          ring,
        ]}
      >
        <View
          style={{
            width: SHUTTER - 18,
            height: SHUTTER - 18,
            borderRadius: (SHUTTER - 18) / 2,
            backgroundColor: '#ffffff',
          }}
        />
      </Pressable>
    </Reanimated.View>
  );
}

/**
 * A round icon button on the viewfinder.
 *
 * `VoiceMode`'s `Disc`, retuned for a preview instead of a surface. Every colour here is a
 * literal rather than a palette key, and that is the deliberate part: the theme's `border`
 * and `textDim` are picked for contrast against paper, and over a camera frame they are
 * invisible in a bright room and invisible again in a dark one. Translucent white on a
 * translucent black scrim is legible over any frame, which is the only requirement a
 * control on top of live video actually has.
 *
 * `emphasis` is the confirm state, and it uses the app's accent with its own paired
 * foreground — the one place a theme colour is right, because *Use* is the same action
 * here as a primary `Button` anywhere else.
 */
function Disc({
  label,
  hint,
  icon,
  onPress,
  disabled,
  emphasis,
}: {
  label: string;
  hint?: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  emphasis?: boolean;
}) {
  const t = useTheme();
  const { ring, handlers } = useFocusRing();
  const { pressStyle, pressHandlers, onPressHaptic } = usePressFeedback({ disabled });

  return (
    <Reanimated.View style={pressStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: Boolean(disabled) }}
        {...(hint ? { accessibilityHint: hint } : {})}
        disabled={disabled}
        onPress={() => {
          onPressHaptic();
          onPress();
        }}
        {...handlers}
        {...pressHandlers}
        style={({ pressed }) => [
          {
            width: MIN_TARGET,
            height: MIN_TARGET,
            borderRadius: MIN_TARGET / 2,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: emphasis ? t.colors.accent : '#ffffff66',
            backgroundColor: emphasis ? t.colors.accent : pressed ? '#ffffff33' : '#00000066',
            opacity: disabled ? 0.35 : 1,
          },
          ring,
        ]}
      >
        <Icon name={icon} size="lg" color={emphasis ? t.colors.accentText : '#ffffff'} />
      </Pressable>
    </Reanimated.View>
  );
}

/**
 * The status line.
 *
 * White on black, so not one of `Body`'s tones — those are all palette keys, and none of
 * them is "over a photograph". The `style` override is applied after the tone, so this is
 * the sanctioned way through.
 */
function Caption({ children, live }: { children: string; live?: boolean }) {
  return (
    <Body size="sm" style={{ color: '#ffffff', opacity: 0.85 }} live={live}>
      {children}
    </Body>
  );
}
