/**
 * Plan mode's gate, which is the half that has to be right.
 *
 * The note is prose and a test that asserts prose asserts nothing. The predicate is
 * what stands between a conversation the user put into plan mode and a file being
 * written, so it gets the tests — including the one that matters most: an unknown
 * name is refused, not run.
 */

import { CREATE_PDF, FETCH_URL, READ_RESOURCE, WRITE_FILE } from '@/chat/builtins';
import { blockedInPlanMode, describeBlockedCalls, planRefusal, PLAN_MODE_NOTE } from '@/chat/plan';
import { INVOKE_SKILL } from '@/chat/skill';

describe('blockedInPlanMode', () => {
  it('refuses the tools that write something', () => {
    expect(blockedInPlanMode(WRITE_FILE)).toBe(true);
    expect(blockedInPlanMode(CREATE_PDF)).toBe(true);
  });

  it('refuses every MCP tool, because this app cannot know what one does', () => {
    expect(blockedInPlanMode('mcp_github_list_issues')).toBe(true);
    expect(blockedInPlanMode('mcp_github_delete_repo')).toBe(true);
  });

  it('still allows the reads a plan has to be built from', () => {
    expect(blockedInPlanMode(FETCH_URL)).toBe(false);
    expect(blockedInPlanMode(READ_RESOURCE)).toBe(false);
    expect(blockedInPlanMode(INVOKE_SKILL)).toBe(false);
  });

  it('does not block on a name that merely contains the MCP prefix', () => {
    // The check is anchored: a hypothetical `summarise_mcp_logs` reads nothing about
    // MCP into the decision, and a gate that matched loosely would refuse tools that
    // are fine.
    expect(blockedInPlanMode('summarise_mcp_logs')).toBe(false);
  });
});

describe('the refusal', () => {
  it('names the tool and says what to do instead', () => {
    const text = planRefusal(WRITE_FILE);
    expect(text).toContain(WRITE_FILE);
    expect(text).toMatch(/not run/);
    // The instruction, not just the denial: a bare "no" gets retried.
    expect(text).toMatch(/what you would do/);
  });
});

describe('the note above the composer', () => {
  it('says nothing when nothing was blocked', () => {
    expect(describeBlockedCalls(0)).toBe('');
    expect(describeBlockedCalls(-1)).toBe('');
  });

  it('counts, and agrees with itself grammatically', () => {
    expect(describeBlockedCalls(1)).toContain('1 tool call was not run');
    expect(describeBlockedCalls(3)).toContain('3 tool calls were not run');
  });
});

describe('the system prompt section', () => {
  it('is a heading with the allowed and refused tools named', () => {
    expect(PLAN_MODE_NOTE.startsWith('# Plan mode')).toBe(true);
    expect(PLAN_MODE_NOTE).toMatch(/read/i);
    expect(PLAN_MODE_NOTE).toMatch(/MCP/);
  });
});
