export function sanitizeToolNameForAnalytics(toolName: string): string {
  return toolName.startsWith('mcp__') ? 'mcp_tool' : toolName
}
