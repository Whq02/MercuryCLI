const CONTROL_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[ -/]*[0-~]/g

function renderLine(line: string): string {
  const cells: string[] = []
  let cursor = 0
  for (const ch of line) {
    if (ch === '\r') {
      cursor = 0
      continue
    }
    if (ch === '\b') {
      if (cursor > 0) cursor -= 1
      continue
    }
    if ((ch < ' ' && ch !== '\t') || ch === '\x7f') continue
    cells[cursor] = ch
    cursor += 1
  }
  let out = ''
  for (let i = 0; i < cells.length; i++) out += cells[i] ?? ' '
  return out
}

export function readableTerminalText(text: string): string {
  return text
    .replace(CONTROL_SEQUENCE, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(renderLine)
    .join('\n')
}

export function readableTerminalLines(lines: readonly string[]): string[] {
  return readableTerminalText(lines.join('\n')).split('\n')
}
