/**
 * The artifact preview: a rendered code block, full screen, and nothing else.
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
 */

import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { useDialogKeys } from '@/components/dialog';
import { Body, Note, Spinner } from '@/components/ui';
import { artifactDocument } from '@/chat/artifact';
import type { ArtifactKind } from '@/chat/artifact';
import { useTheme } from '@/theme';

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

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      onShow={() => {
        started.current = false;
        setLoading(true);
        setBlocked(null);
      }}
    >
      <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
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
      </View>
    </Modal>
  );
}
