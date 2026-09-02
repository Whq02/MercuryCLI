/**
 * A bash command whose first line is a bare `# comment` (a `#!` shebang does
 * not count) yields that line with the `#` prefix stripped; every other
 * command yields undefined.
 *
 * Fullscreen mode leans on this as the terse tool-use label AND as the
 * collapse-group ⎿ hint — the one line Mercury wrote for the human to read.
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const [head = ''] = command.split('\n', 1)
  const firstLine = head.trim()
  if (firstLine.startsWith('#!')) return undefined // shebang, not a comment
  if (!firstLine.startsWith('#')) return undefined
  const label = firstLine.replace(/^#+\s*/, '')
  return label === '' ? undefined : label
}
