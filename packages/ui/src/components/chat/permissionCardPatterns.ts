/**
 * A bare `*` conveys no scope to the user, and it is what OpenCode sends for MCP
 * tool permission where approval is actually scoped to the permission key.
 */
const WILDCARD_PATTERN = '*';

const isInformativePattern = (pattern: string): boolean => pattern !== WILDCARD_PATTERN;

export const getVisiblePermissionPatterns = (patterns: string[], renderedCommand: string): string[] => {
  const informative = patterns.filter(isInformativePattern);
  if (!renderedCommand) return informative;
  return informative.filter((pattern) => pattern !== renderedCommand);
};

export const getVisibleAlwaysPatterns = (always: string[]): string[] => always.filter(isInformativePattern);
