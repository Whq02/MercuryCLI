
export const TOOL_USE_LINE_MAX_CHARS = 160

export function oneLineCommandDisplay(
  command: string,
  maxChars: number = TOOL_USE_LINE_MAX_CHARS,
): string {
  const folded = command
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .join(' ↵ ')
  if (folded.length > maxChars) {
    return `${folded.slice(0, maxChars).trimEnd()}…`
  }
  return folded
}
