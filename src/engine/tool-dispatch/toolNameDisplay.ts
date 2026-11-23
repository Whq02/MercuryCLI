export const TOOL_NAME_DISPLAY_LIMIT = 120

export function displayToolName(name: string): string {
  if (name.length <= TOOL_NAME_DISPLAY_LIMIT) return name
  const points = Array.from(name)
  if (points.length <= TOOL_NAME_DISPLAY_LIMIT) return name
  return `${points.slice(0, TOOL_NAME_DISPLAY_LIMIT).join('')}…`
}
