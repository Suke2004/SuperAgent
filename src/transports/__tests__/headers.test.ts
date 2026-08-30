/**
 * Header enforcement.
 *
 * The providers store screens what a user can *save* (`safeHeaders`), but this is
 * the layer every request passes through, including one built from an imported
 * backup or a future caller that skips the store. Two guarantees are asserted here
 * rather than trusted: the credential cannot be displaced or duplicated, and the
 * User-Agent cannot be turned into another client's identity.
 */

import { HttpClient } from '../http';
import { NO_RETRY_POLICY } from '../retry';
import { createMockFetch, jsonResponse } from './testFetch';

function client(headers: Record<string, string>) {
  const mock = createMockFetch([jsonResponse({ ok: true })]);
  const http = new HttpClient({
    transport: 'openai',
    baseUrl: 'https://agentrouter.org/v1',
    apiKey: 'sk-real-key',
    fetchImpl: mock.fetch,
    retryPolicy: NO_RETRY_POLICY,
    headers,
  });
  return { http, mock };
}

async function sentHeaders(headers: Record<string, string>): Promise<Record<string, string>> {
  const { http, mock } = client(headers);
  await http.json({ path: '/models', method: 'GET' });
  return (mock.calls[0]?.init.headers ?? {}) as Record<string, string>;
}

describe('outgoing headers', () => {
  it('drops a lowercase authorization rather than sending two credentials', async () => {
    const sent = await sentHeaders({ authorization: 'Bearer sk-someone-elses' });
    expect(sent.authorization).toBeUndefined();
    expect(sent.Authorization).toBe('Bearer sk-real-key');
  });

  it('refuses an x-api-key smuggled in through the extra headers', async () => {
    const sent = await sentHeaders({ 'X-Api-Key': 'sk-someone-elses' });
    expect(Object.entries(sent).filter(([name]) => name.toLowerCase() === 'x-api-key')).toHaveLength(0);
    expect(sent.Authorization).toBe('Bearer sk-real-key');
  });

  it('keeps the User-Agent honest whatever the profile says', async () => {
    const sent = await sentHeaders({ 'User-Agent': 'okhttp/4.12.0', 'user-agent': 'python-requests/2.32.3' });
    expect(sent['User-Agent']).toBe('AgentRouterMobile/1.0 (Android)');
    expect(Object.entries(sent).filter(([name]) => name.toLowerCase() === 'user-agent')).toHaveLength(1);
  });

  it('still passes an ordinary extra header through', async () => {
    const sent = await sentHeaders({ 'anthropic-version': '2023-06-01' });
    expect(sent['anthropic-version']).toBe('2023-06-01');
  });
});
