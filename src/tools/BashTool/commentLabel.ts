export function extractBashCommentLabel(command: string): string | undefined {
  const [head = ''] = command.split('\n', 1)
  const firstLine = head.trim()
  if (firstLine.startsWith('#!')) return undefined
  if (!firstLine.startsWith('#')) return undefined
  const label = firstLine.replace(/^#+\s*/, '')
  return label === '' ? undefined : label
}
