/**
 * Monitor tool name — split into its own lightweight module (mirrors
 * TaskListTool/SendMessageTool constants) so prose builders like
 * services/loopFire.ts can reference the name without importing the full tool
 * module (zod schemas, spawnShellTask, the notification queue).
 */
export const MONITOR_TOOL_NAME = 'Monitor'
