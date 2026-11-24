const VISIBLE_LINES = 3

export function isOutputLineTruncated(content: string): boolean {
  let pos = -1
  for (let i = 0; i < VISIBLE_LINES + 1; i++) {
    pos = content.indexOf('\n', pos + 1)
    if (pos === -1) return false
  }
  return pos < content.length - 1
}
