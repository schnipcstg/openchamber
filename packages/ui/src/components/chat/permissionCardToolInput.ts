import type { Part } from '@opencode-ai/sdk/v2';

/**
 * Resolve the arguments of the tool call a permission request belongs to.
 *
 * OpenCode asks for MCP tool permission with an empty `metadata` payload, so the
 * permission card has no upstream detail to render. The tool part for the same
 * `callID` is already in the directory-scoped sync store and carries the input
 * the MCP server will receive, so reading it is authoritative rather than a
 * reconstruction of the call.
 *
 * Returns `undefined` when the part has not arrived yet or carries no input, so
 * callers keep their existing empty rendering instead of showing `{}`.
 */
export const getPermissionToolInput = (
  parts: readonly Part[] | undefined,
  callID: string | undefined,
): Record<string, unknown> | undefined => {
  if (!parts || !callID) return undefined;

  for (const part of parts) {
    if (part.type !== 'tool' || part.callID !== callID) continue;
    const input = (part.state as { input?: unknown }).input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const record = input as Record<string, unknown>;
    return Object.keys(record).length > 0 ? record : undefined;
  }

  return undefined;
};
