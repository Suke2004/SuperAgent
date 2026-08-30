/**
 * "The gateway could not be reached" — one component, three placements.
 *
 * Home, the chat header and the composer all need to say this, and three separate
 * strings would drift apart within a week. The wording is deliberately about the
 * last attempt rather than about the device: see {@link useReachability} for why
 * this app refuses to claim the user is offline.
 */

import { Badge, Note } from '@/components/ui';
import { useReachability } from '@/stores/reachability';
import { useSendQueue } from '@/stores/queue';

/** `4 minutes`, `just now`. Coarse on purpose: a stopwatch here means nothing. */
function elapsedPhrase(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return 'about a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'about an hour' : `${hours} hours`;
}

/** Full banner, for a screen with room for a sentence. */
export function OfflineBanner() {
  const status = useReachability((s) => s.status);
  const since = useReachability((s) => s.since);
  const detail = useReachability((s) => s.detail);
  const failures = useReachability((s) => s.failures);
  const queued = useSendQueue((s) => s.ids.length);

  if (status !== 'unreachable') return null;

  const when = since ? elapsedPhrase(since) : undefined;
  const forHowLong = when === undefined ? '' : when === 'just now' ? ' just now' : ` for ${when}`;
  const attempts = failures > 1 ? ` ${failures} attempts have failed.` : '';
  // Said only when it is true: a queue count of zero and "will be sent" is the kind
  // of promise that teaches a user to distrust the banner.
  const waiting = queued
    ? ` ${queued === 1 ? 'One conversation is' : `${queued} conversations are`} waiting, and will be retried when the gateway answers again.`
    : ' Sending will keep failing until the connection comes back.';

  return (
    <Note tone="warning" live>
      {`The gateway could not be reached${forHowLong}.${attempts} ${
        detail ?? 'The last request could not connect.'
      }${waiting}`}
    </Note>
  );
}

/** One-word version, for a header or a dense row. */
export function OfflineBadge() {
  const status = useReachability((s) => s.status);
  if (status !== 'unreachable') return null;
  return <Badge label="Unreachable" tone="warning" srLabel="The gateway is not reachable" />;
}
