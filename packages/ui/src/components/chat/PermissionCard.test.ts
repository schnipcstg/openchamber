import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

import { getVisibleAlwaysPatterns, getVisiblePermissionPatterns } from './permissionCardPatterns';
import { getPermissionToolInput } from './permissionCardToolInput';

const toolPart = (callID: string, state: Record<string, unknown>): Part =>
  ({
    id: `part_${callID}`,
    sessionID: 'session_1',
    messageID: 'message_1',
    type: 'tool',
    tool: 'atlassian-mcp-server_getJiraIssue',
    callID,
    state,
  } as unknown as Part);

describe('getVisiblePermissionPatterns', () => {
  test('omits a pattern already rendered as the bash command', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns([command], command)).toEqual([]);
  });

  test('preserves distinct permission patterns', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns(['bunx eslint *', command], command)).toEqual(['bunx eslint *']);
  });

  test('omits the bare wildcard OpenCode sends for MCP tools', () => {
    expect(getVisiblePermissionPatterns(['*'], '')).toEqual([]);
  });

  test('keeps informative patterns alongside a wildcard', () => {
    expect(getVisiblePermissionPatterns(['*', 'git push *'], '')).toEqual(['git push *']);
  });
});

describe('getVisibleAlwaysPatterns', () => {
  test('drops the bare wildcard', () => {
    expect(getVisibleAlwaysPatterns(['*'])).toEqual([]);
  });

  test('keeps real patterns', () => {
    expect(getVisibleAlwaysPatterns(['*', 'bunx eslint *'])).toEqual(['bunx eslint *']);
  });
});

describe('getPermissionToolInput', () => {
  test('returns the input of the matching tool call', () => {
    const parts = [
      toolPart('call_other', { status: 'running', input: { issueIdOrKey: 'OTHER-1' } }),
      toolPart('call_1', { status: 'running', input: { issueIdOrKey: 'PROJ-42' } }),
    ];

    expect(getPermissionToolInput(parts, 'call_1')).toEqual({ issueIdOrKey: 'PROJ-42' });
  });

  test('returns undefined while the pending part has no input yet', () => {
    const parts = [toolPart('call_1', { status: 'pending', input: {}, raw: '' })];

    expect(getPermissionToolInput(parts, 'call_1')).toBe(undefined);
  });

  test('returns undefined when the part has not arrived', () => {
    expect(getPermissionToolInput([], 'call_1')).toBe(undefined);
  });

  test('returns undefined without a call id', () => {
    const parts = [toolPart('call_1', { status: 'running', input: { a: 1 } })];

    expect(getPermissionToolInput(parts, undefined)).toBe(undefined);
  });

  test('ignores non-object input', () => {
    const parts = [toolPart('call_1', { status: 'running', input: 'not-an-object' })];

    expect(getPermissionToolInput(parts, 'call_1')).toBe(undefined);
  });
});
