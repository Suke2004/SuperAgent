/**
 * The code sandbox: `run_code`, and the JavaScript engine it runs in.
 *
 * The gap this closes is arithmetic. A model asked to check a column of numbers or
 * parse a CSV it was just handed does it by predicting the answer, and it is wrong in
 * ways nobody can see. Given somewhere to run three lines of JavaScript it stops
 * guessing.
 *
 * **This is not a shell.** `@/chat/builtins` says there is no `run_command` and none is
 * planned, and that still holds: what runs here is JavaScript inside a WebView with a
 * `default-src 'none'` policy, no network, no storage, no filesystem and no bridge to
 * the app beyond one string in and one string out. It cannot read the transcript, the
 * database or a key. That is the whole reason it can be offered at all — the code being
 * run was written by a model that may have been reading an attacker's web page a moment
 * earlier, so the sandbox has to hold against the code, not merely against accidents.
 *
 * Synchronous only. A promise the runner does not await is a result nobody sees, so the
 * tool description says so and the return value of the last expression is the answer.
 *
 * The runner document, the wire format and the queue all live here rather than in the
 * WebView component, so the protocol can be tested in node with a fake host. The
 * component is `@/components/CodeSandbox`, and its only job is to be the browser.
 */

import { log } from '@/lib/log';

/** Longest program accepted. Past this it is a library, not a calculation. */
export const MAX_CODE_CHARS = 20_000;

/** Longest output kept. A runaway loop printing per iteration stops being evidence. */
export const MAX_OUTPUT_CHARS = 20_000;

/**
 * How long a program may run before the answer is that it did not finish.
 *
 * A WebView cannot be interrupted from outside, so this is a deadline on the *reply*,
 * not on the code: an infinite loop keeps spinning in a hidden view until the sandbox
 * is torn down. Five seconds is long enough for anything worth calling a tool for and
 * short enough that the user is still watching when it gives up.
 */
export const RUN_TIMEOUT_MS = 5_000;

export type CodeRequest = { ok: true; code: string } | { ok: false; reason: string };

/** Validates a `run_code` call. */
export function parseRunCode(input: unknown): CodeRequest {
  const record =
    input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  if (!code.trim()) return { ok: false, reason: 'run_code needs "code" — the JavaScript to run.' };
  if (code.length > MAX_CODE_CHARS) {
    return {
      ok: false,
      reason: `That is ${code.length.toLocaleString()} characters; the limit is ${MAX_CODE_CHARS.toLocaleString()}.`,
    };
  }
  return { ok: true, code };
}

/** What the sandbox posts back. Anything else on the channel is discarded. */
export interface SandboxResult {
  id: string;
  ok: boolean;
  output: string;
}

/**
 * One message off the WebView channel, or `null` when it is not one of ours.
 *
 * Validated field by field rather than cast: this is a boundary, the sender is a page
 * running model-written code, and a `postMessage` of `{}` should be ignored rather than
 * resolve some pending run with `undefined`.
 */
export function parseSandboxMessage(raw: string): SandboxResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.ok !== 'boolean') return null;
  const output = typeof record.output === 'string' ? record.output : '';
  return { id: record.id, ok: record.ok, output: output.slice(0, MAX_OUTPUT_CHARS) };
}

/**
 * The document the sandbox loads.
 *
 * `console.log` is captured because printing is how a person writes a scratch
 * calculation, and the value of the last expression is appended because `2 + 2` with no
 * `console.log` is the other way they write one. Indirect `eval` keeps the program out
 * of this function's scope, so the runner's own variables are not in reach.
 *
 * The policy is the same shape as an artifact's and for the same reason: with no source
 * permitted for anything, there is no channel out of the page. `postMessage` back to
 * the app is not a network request and is unaffected.
 *
 * `'unsafe-eval'` is in the policy because the runner *is* an `eval`, and without it
 * every single call failed with `EvalError: Evaluating a string as JavaScript violates
 * the following Content Security Policy directive` — the tool was dead on arrival. It
 * grants nothing a page with `script-src 'unsafe-inline'` did not already have: inline
 * script can already write whatever it likes. What keeps this safe is `default-src
 * 'none'`, which leaves the code with nowhere to send anything.
 */
export const SANDBOX_HTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'">
<script>
(function () {
  function send(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  function show(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  function handle(event) {
    var request;
    try { request = JSON.parse(event.data); } catch (e) { return; }
    if (!request || typeof request.id !== 'string' || typeof request.code !== 'string') return;
    var lines = [];
    var print = function () {
      for (var i = 0; i < arguments.length; i += 1) lines.push(show(arguments[i]));
    };
    console.log = print;
    console.info = print;
    console.warn = print;
    console.error = print;
    try {
      var value = eval.call(null, request.code);
      if (value !== undefined) lines.push(show(value));
      send({ id: request.id, ok: true, output: lines.join('\\n') });
    } catch (error) {
      lines.push(show(error));
      send({ id: request.id, ok: false, output: lines.join('\\n') });
    }
  }
  // Android delivers to the document, iOS to the window. Both, so one file works on both.
  document.addEventListener('message', handle);
  window.addEventListener('message', handle);
})();
</script></head><body></body></html>`;

/** The JSON the host posts into the page. */
export function sandboxRequest(id: string, code: string): string {
  return JSON.stringify({ id, code });
}

/* -------------------------------------------------------------------------- */
/* The queue                                                                   */
/* -------------------------------------------------------------------------- */

interface Pending {
  resolve(result: { ok: boolean; output: string }): void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let post: ((message: string) => void) | null = null;
/** Asks the host to throw the engine away and load a fresh one. */
let reload: (() => void) | null = null;
let counter = 0;

/**
 * Called by the WebView host when it is ready, and with `null` when it goes away.
 *
 * Runs waiting on a host that has just unmounted are failed rather than left hanging:
 * a tool result that never arrives stalls the turn forever, and "the sandbox closed" is
 * something the model can report.
 *
 * `onReload` is how a wedged engine gets replaced. A program that loops forever cannot
 * be interrupted from outside the WebView, so once a run has timed out that renderer is
 * spinning at 100% until something tears it down — which on Android ends with the
 * system killing the renderer process and taking the app with it. The host hands over a
 * remount so the timeout can do that deliberately instead.
 */
export function registerSandbox(next: ((message: string) => void) | null, onReload?: () => void): void {
  post = next;
  reload = next ? (onReload ?? null) : null;
  if (next) return;
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, output: 'The sandbox closed before this finished.' });
    pending.delete(id);
  }
}

/** Called by the host for every message off the channel. */
export function deliverSandboxMessage(raw: string): void {
  const result = parseSandboxMessage(raw);
  if (!result) return;
  const entry = pending.get(result.id);
  if (!entry) return; // A late reply to a run that already timed out.
  clearTimeout(entry.timer);
  pending.delete(result.id);
  entry.resolve({ ok: result.ok, output: result.output });
}

/**
 * Runs one program and resolves with what it printed.
 *
 * Never rejects: every outcome — no sandbox, a timeout, a thrown error — is a tool
 * result the model should see and can act on, and an exception here would surface as a
 * failed turn instead.
 */
export function runInSandbox(code: string, timeoutMs = RUN_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
  const send = post;
  if (!send) {
    log.warn('sandbox', 'run_code was called with no sandbox mounted');
    return Promise.resolve({ ok: false, output: 'The sandbox is not available on this screen.' });
  }
  counter += 1;
  const id = `run_${counter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // The engine is still running that loop. Replace it, or every later run queues
      // behind a spinning renderer and Android eventually kills the process.
      reload?.();
      resolve({
        ok: false,
        output: `The code did not finish within ${Math.round(timeoutMs / 1000)} seconds. It may be looping.`,
      });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    send(sandboxRequest(id, code));
  });
}
