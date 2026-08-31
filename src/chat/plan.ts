/**
 * Plan mode: propose before acting.
 *
 * A per-conversation switch that lets the model look but not touch. It exists because
 * the tool loop is otherwise all-or-nothing — either a tool runs or it is not offered
 * — and the useful middle state is "read what you need, then tell me what you intend
 * to do before you do it". That is the state you want before a model writes six files
 * or calls an MCP server that books something.
 *
 * Two halves, and both are needed:
 *
 *  1. **The note**, added to the system prompt, so the model knows to plan rather than
 *     discovering it by having calls refused one at a time.
 *  2. **The gate**, {@link blockedInPlanMode}, which is what actually holds. A model
 *     told not to act still acts sometimes, and an instruction is not a control.
 *
 * The split between blocked and allowed is by *effect*, not by who implements the
 * tool. Reading is what makes a plan worth reading: a plan written without looking at
 * the file it proposes to rewrite is a guess. So `invoke_skill`, `fetch_url` and
 * `read_mcp_resource` still run — they take nothing and change nothing — while the
 * two writers and every MCP tool do not. MCP is blocked wholesale because this app
 * cannot know what a third-party tool does; `list_issues` and `delete_repo` arrive
 * through the same door, and guessing from the name is how you guess wrong once.
 *
 * Pure module, no imports from the loop. The loop calls it; the tests call it too.
 */

import { CREATE_PDF, FETCH_URL, READ_RESOURCE, RUN_CODE, WRITE_FILE } from '@/chat/builtins';
import { MCP_TOOL_PREFIX } from '@/mcp/protocol';

/**
 * Built-ins that only read. Everything else is blocked while planning.
 *
 * `run_code` is in here, which reads oddly for a tool called "run" and is right: it
 * changes nothing outside a sandbox with no filesystem and no network, and the sums a
 * model does while planning are exactly the ones a plan should be built on.
 */
const READ_ONLY_BUILTINS = new Set<string>([FETCH_URL, READ_RESOURCE, RUN_CODE]);

/** Built-ins that produce a file. Named so the reason for blocking them is visible. */
const WRITING_BUILTINS = new Set<string>([WRITE_FILE, CREATE_PDF]);

/**
 * Whether plan mode should refuse this call.
 *
 * The default for an unrecognised name is **blocked**, which is the direction a
 * safety gate has to fail in: a tool added later that nobody thought about here must
 * not be executed by a conversation the user put into plan mode. `invoke_skill` is
 * allowed by falling through the write and MCP checks — it loads a Markdown file that
 * ships with the app.
 */
export function blockedInPlanMode(name: string): boolean {
  if (READ_ONLY_BUILTINS.has(name)) return false;
  if (WRITING_BUILTINS.has(name)) return true;
  if (name.startsWith(`${MCP_TOOL_PREFIX}_`)) return true;
  return false;
}

/**
 * The tool result a blocked call gets.
 *
 * Written as an instruction the model can act on rather than a bare refusal. A result
 * saying only "denied" gets retried; one that says what to do instead gets a plan.
 */
export function planRefusal(name: string): string {
  return (
    `Plan mode is on for this conversation, so \`${name}\` was not run and nothing was changed. ` +
    'Do not call it again. Write out what you would do — the steps, in order, and what each one ' +
    'would create or change — and stop there. The user will turn plan mode off if they want it done.'
  );
}

/**
 * The system-prompt section for a conversation in plan mode.
 *
 * Its own heading, and it names the tools that still work, because a model told only
 * "do not use tools" also stops reading — and then plans from memory.
 */
export const PLAN_MODE_NOTE =
  '# Plan mode\n\n' +
  'This conversation is in plan mode. Propose before acting: work out what needs doing and describe it, ' +
  'but do not change anything. You may still read — fetching a page, reading a resource, loading a skill — ' +
  'and you should, because a plan built on guesses is not worth reviewing. Writing files, rendering ' +
  'documents and calling connected MCP tools are all refused while this is on, so calling them wastes a ' +
  'turn. End with the plan itself: the steps in order, and what each one would create or change.';

/**
 * The line shown above the composer when plan mode stopped calls this turn.
 *
 * Returns `''` for none, so the caller can set it unconditionally. The count is in it
 * because "plan mode is on" is already visible in the menu; what is not visible is
 * that the answer just read is a plan and not the work.
 */
export function describeBlockedCalls(count: number): string {
  if (count <= 0) return '';
  return `Plan mode is on, so ${count === 1 ? '1 tool call was' : `${count} tool calls were`} not run. Turn it off in the conversation menu to let the model act.`;
}
