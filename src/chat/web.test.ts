/**
 * `fetch_url`, the one outbound request the model makes on its own.
 *
 * The address rules are tested next door in `builtins.test.ts`; what is pinned here is
 * the part that only exists once a real response comes back — chiefly that a *redirect*
 * cannot walk past those rules. A public host answering `302 http://169.254.169.254/`
 * is the whole reason the check is repeated against the final URL, and it is the kind
 * of hole that a passing happy-path test hides completely.
 */

import { fetchAsText, MAX_FETCH_BYTES } from '@/chat/web';

/** A response good enough for the code under test. `url` is the hop it landed on. */
function reply(body: string, init: { type?: string; status?: number; url?: string } = {}): Response {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    url: init.url ?? 'https://example.com/',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (init.type ?? 'text/plain') : null) },
    text: async () => body,
  } as unknown as Response;
}

const fetchMock = jest.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

test('a page comes back as text, with the address it came from', async () => {
  fetchMock.mockResolvedValueOnce(reply('<p>Hello</p>', { type: 'text/html' }));

  const outcome = await fetchAsText({ url: 'https://example.com/' });

  expect(outcome.isError).toBeUndefined();
  expect(outcome.content).toContain('Fetched https://example.com/');
  expect(outcome.content).toContain('Hello');
  // No credentials, no body, no caller-set headers: a page cannot turn this into an
  // authenticated request.
  const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(options.method).toBe('GET');
  expect(options).not.toHaveProperty('body');
  expect(Object.keys(options.headers as object).sort()).toEqual(['Accept', 'User-Agent']);
});

test('an address the rules refuse never reaches the network', async () => {
  const outcome = await fetchAsText({ url: 'http://169.254.169.254/latest/meta-data/' });

  expect(outcome.isError).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a redirect onto a private address is refused, not read', async () => {
  fetchMock.mockResolvedValueOnce(reply('root:x:0:0', { url: 'http://169.254.169.254/latest/meta-data/' }));

  const outcome = await fetchAsText({ url: 'https://example.com/redirect' });

  expect(outcome.isError).toBe(true);
  expect(outcome.content).toContain('redirected somewhere this tool will not follow');
  // The body was fetched — nothing can stop that — but it is not handed to the model.
  expect(outcome.content).not.toContain('root:x:0:0');
});

test('a non-text response says what it was instead of guessing', async () => {
  fetchMock.mockResolvedValueOnce(reply('%PDF-1.7', { type: 'application/pdf' }));

  const outcome = await fetchAsText({ url: 'https://example.com/a.pdf' });

  expect(outcome.isError).toBe(true);
  expect(outcome.content).toContain('application/pdf');
});

test('an HTTP error is a result the model can act on, not a thrown turn', async () => {
  fetchMock.mockResolvedValueOnce(reply('nope', { status: 404 }));

  const outcome = await fetchAsText({ url: 'https://example.com/missing' });

  expect(outcome.isError).toBe(true);
  expect(outcome.content).toContain('HTTP 404');
});

test('a page larger than the ceiling is truncated rather than refused', async () => {
  fetchMock.mockResolvedValueOnce(reply('a'.repeat(MAX_FETCH_BYTES * 2)));

  const outcome = await fetchAsText({ url: 'https://example.com/big' });

  expect(outcome.isError).toBeUndefined();
  expect(outcome.content.length).toBeLessThan(MAX_FETCH_BYTES);
});

test('a request that never answers reports the timeout, not a crash', async () => {
  fetchMock.mockRejectedValueOnce(Object.assign(new Error('Aborted'), { name: 'AbortError' }));

  const outcome = await fetchAsText({ url: 'https://example.com/slow' });

  expect(outcome.isError).toBe(true);
  expect(outcome.content).toContain('did not answer within');
});
