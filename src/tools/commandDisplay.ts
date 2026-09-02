// The ONE-LINE tool-header law: the transcript's
// tool-call header is one row ("one line always" — AssistantToolUseMessage
// composes it as a single truncate-middle Text), but both shell tools'
// non-verbose renderers could return up to TWO source lines — a newline in
// the returned string painted a second row, or a mid-slice left a cut row
// trailed by blanks. The fold: newline runs become a visible ' ↵ ' marker
// (the structure stays honest — the marker says "this command has more
// lines"), then the character cap cuts with an ellipsis. Verbose paths and
// consent cards keep their own multi-line laws; this is the HEADER's.

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
