/**
 * `jarvis://new?q=…` — the deep link that starts a conversation with something in it.
 *
 * A route rather than a handler, because expo-router already turns the app's `scheme`
 * into a linking config: `jarvis://chat/<id>` lands on `chat/[id]` with no code at all,
 * and this file is only needed because "new" is a verb, not a screen.
 *
 * **The text goes in the composer; it is not sent.** A URL is untrusted input — it can
 * come from a web page, a QR code or another app — and a link that could make this app
 * spend money on somebody's API key without a tap is a hole, not a feature. So the
 * shortcut saves the typing and leaves the decision.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Body, Button, Spinner } from '@/components/ui';
import { launchTarget, linkedPrompt } from '@/chat/launch';
import { useChat } from '@/stores/chat';
import { useTheme } from '@/theme';

export default function NewConversation() {
  const t = useTheme();
  const router = useRouter();
  const { q } = useLocalSearchParams<{ q?: string | string[] }>();
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The newest empty conversation is reused, the way a cold start does it, so a
        // shortcut tapped five times leaves one chat behind rather than five.
        await useChat.getState().loadList({ archived: false });
        const id = launchTarget(useChat.getState().conversations) ?? (await useChat.getState().start());
        const prompt = linkedPrompt(q);
        if (prompt) useChat.getState().setDraft(id, prompt);
        if (!cancelled) router.replace({ pathname: '/chat/[id]', params: { id } });
      } catch (error) {
        if (!cancelled) setFailed(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q, router]);

  if (failed !== null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: t.spacing.lg, padding: t.spacing.xl }}>
        <Body>{`Could not start a conversation. ${failed}`}</Body>
        <Button label="Go to conversations" onPress={() => router.replace('/')} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Spinner />
    </View>
  );
}
