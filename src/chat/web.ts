/**
 * The one outbound request the model gets to make on its own.
 *
 * Split from `@/chat/builtins` because the rules are the testable part and `fetch`
 * is not. Everything defensive about this tool lives in that module —
 * {@link checkFetchUrl} decides what may be reached — and this one is the mechanics:
 * a GET, a timeout, a byte ceiling, and text out.
 *
 * There is no cookie jar, no redirect to a different scheme, no request body and no
 * header the caller can set. A page cannot turn this into an authenticated request,
 * which is the property that makes the tool safe enough to offer at all.
 */

import { capFetched, checkFetchUrl, htmlToText } from '@/chat/builtins';
import { log } from '@/lib/log';
import { USER_AGENT } from '@/transports/http';

/** Long enough for a slow page, short enough that a turn is not held open. */
export const FETCH_TIMEOUT_MS = 20_000;

/**
 * Bytes read off the wire before giving up.
 *
 * Above the character ceiling on purpose: HTML is mostly markup, so a page that
 * reduces to 60k of text is routinely 300k of source.
 */
export const MAX_FETCH_BYTES = 2_000_000;

export interface FetchOutcome {
  content: string;
  isError?: true;
}

/**
 * Fetches one page as text.
 *
 * Every failure is a *result*, not a throw: the model is waiting on a `tool_result`,
 * and an unanswered call invalidates every later request in the conversation. A
 * refusal says which rule refused, because "could not fetch" tells the model nothing
 * it can act on and it will simply try the same URL again.
 */
export async function fetchAsText(input: unknown): Promise<FetchOutcome> {
  const checked = checkFetchUrl(asUrl(input));
  if (!checked.ok) return { content: checked.reason, isError: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(checked.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    // The URL is logged; the body never is. A fetched page is content, and
    // `redactString` protects credentials rather than content.
    log.info('fetch', 'fetched a page for the model', { status: response.status, host: hostOf(checked.url) });

    // Where it *ended up*, not where it was sent. `checkFetchUrl` guards the address
    // the model supplied; a public host answering `302 http://169.254.169.254/` would
    // otherwise walk straight past it. React Native's fetch follows redirects inside
    // XHR and offers no `redirect: 'manual'`, so the final URL is the only hop this
    // can check — and it is the one that returned the bytes.
    const landed = response.url && response.url !== checked.url ? checkFetchUrl(response.url) : { ok: true as const };
    if (!landed.ok) {
      return { content: `${checked.url} redirected somewhere this tool will not follow: ${landed.reason}`, isError: true };
    }

    const type = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      return { content: `${checked.url} returned HTTP ${response.status}.`, isError: true };
    }
    if (!isTextual(type)) {
      return { content: `${checked.url} is ${type || 'an unknown type'}, which this tool cannot read as text.`, isError: true };
    }

    const raw = (await response.text()).slice(0, MAX_FETCH_BYTES);
    const text = /html/i.test(type) ? htmlToText(raw) : raw.trim();
    if (!text) return { content: `${checked.url} came back empty.`, isError: true };
    return { content: `Fetched ${checked.url}\n\n${capFetched(text)}` };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      content: aborted
        ? `${checked.url} did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds.`
        : `Could not reach ${checked.url}: ${error instanceof Error ? error.message : 'unknown error'}.`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Content types worth handing to a model as text. */
function isTextual(contentType: string): boolean {
  return /^(?:text\/|application\/(?:json|xml|xhtml|javascript|ld\+json))/i.test(contentType.trim());
}

function asUrl(input: unknown): unknown {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as { url?: unknown }).url
    : input;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}
