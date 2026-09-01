/**
 * "Your reply is ready", when the app is not the thing on screen.
 *
 * A long turn is the one case where a phone app has to shout: the user asked a
 * question, put the phone down, and the answer arrives with nothing to say so. Every
 * decision about *whether* to shout and *what* the line says is in {@link replyNotice},
 * which is pure and tested; the rest of this file is the thin edge that talks to
 * expo-notifications and can only be exercised on a device.
 *
 * Local notifications only. There is no push token, no server, and nothing leaves the
 * phone — the "background task" is this app's own stream, which the OS may still kill,
 * so this is a courtesy and never the record of what happened. That record is the
 * transcript.
 *
 * ponytail: the OS toggle is the only off switch. Android and iOS both give the user
 * per-app notification control, and an in-app duplicate of it would be a second source
 * of truth for a boolean the platform already owns. Add one if a user asks to keep
 * notifications on for other things but not for replies.
 */

import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { APP_NAME } from '@/lib/app';
import { log } from '@/lib/log';

/** How much of the reply the banner shows. Two lines' worth at a typical width. */
const PREVIEW = 110;

export interface ReplyNoticeInput {
  /** The conversation's title, or a fallback when it has not been named yet. */
  title: string;
  /** What the model said, as plain text. */
  text: string;
  /** Whether the app was in the foreground when the turn finished. */
  foreground: boolean;
  /** How the turn ended. An abort was the user's own doing and says nothing. */
  stopReason?: string | undefined;
}

/**
 * The banner for a finished turn, or `null` for the turns that must stay silent.
 *
 * Silent on purpose: a turn that finished while the user was watching it (they can
 * see the answer), a turn they cancelled (they know), and a turn that produced no
 * text (there is nothing to announce, and the failure is already in the transcript
 * with a Try again next to it).
 */
export function replyNotice(input: ReplyNoticeInput): { title: string; body: string } | null {
  if (input.foreground) return null;
  if (input.stopReason === 'aborted') return null;
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const body = text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1).trimEnd()}…` : text;
  return { title: input.title.trim() || APP_NAME, body };
}

let primed = false;

/**
 * Ask once, in the foreground, at a moment the request makes sense.
 *
 * Called as a turn starts rather than at launch: "allow notifications?" on top of a
 * first launch has no context, and the same dialog a second after the user sent
 * something long does. A denial is remembered by the OS and never asked again, which
 * is why nothing here retries.
 */
export async function primeNotifications(): Promise<void> {
  if (primed) return;
  primed = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        // Foreground turns never reach here — `replyNotice` drops them — so anything
        // that arrives while the app is open came from elsewhere and is shown.
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    if (Platform.OS === 'android') {
      // Android 8+ drops a notification with no channel on the floor, silently.
      await Notifications.setNotificationChannelAsync('replies', {
        name: 'Replies',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted && current.canAskAgain) await Notifications.requestPermissionsAsync();
  } catch (error) {
    // A phone that will not do notifications is not a phone that cannot chat.
    log.warn('notify', 'Could not set up notifications', { error: String(error) });
  }
}

/**
 * Posts the banner for a finished turn, if there is one to post.
 *
 * `conversationId` rides along as data so a tap can open the conversation the reply
 * is in — see {@link onNotificationTap}.
 */
export async function notifyReplyReady(input: Omit<ReplyNoticeInput, 'foreground'> & { conversationId: string }): Promise<void> {
  const notice = replyNotice({ ...input, foreground: AppState.currentState === 'active' });
  if (!notice) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { ...notice, data: { conversationId: input.conversationId } },
      trigger: null,
    });
  } catch (error) {
    log.warn('notify', 'Could not post the reply notification', { error: String(error) });
  }
}

/** The conversation a tapped notification points at, or `null` if it names none. */
export function tappedConversation(response: Notifications.NotificationResponse): string | null {
  const data = response.notification.request.content.data;
  const id = typeof data === 'object' && data !== null ? (data as { conversationId?: unknown }).conversationId : null;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Runs `open` when a reply notification is tapped, including the tap that started
 * the app — `getLastNotificationResponseAsync` is the cold-start half, and without it
 * a tap from a killed app lands on the home screen instead of the conversation.
 */
export function onNotificationTap(open: (conversationId: string) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const id = tappedConversation(response);
    if (id) open(id);
  });
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    const id = response ? tappedConversation(response) : null;
    if (id) open(id);
  });
  return () => subscription.remove();
}
