import { createScanner } from '../../ink/input/scanner.js'

export function shellLiveTailBudget(columns: number, rows: number): number {
  return Math.max(0, Math.min(columns >= 100 ? 6 : 3, rows - 14))
}

export function shellLiveTailLines(content: string, budget: number): string[] {
  if (budget <= 0 || content === '') return []
  const lines: string[] = []
  let styles = ''
  let line = ''
  let hasText = false
  let rewrite = false
  const push = (): void => {
    lines.push(line)
    if (lines.length > budget) lines.shift()
    line = styles
    hasText = false
    rewrite = false
  }
  for (const token of createScanner().feed(content.replace(/\r\n/g, '\n'))) {
    if (token.kind === 'csi' && /^\u001b\[[\d;:]*m$/.test(token.value)) {
      styles = /^\u001b\[(?:0)?m$/.test(token.value) ? token.value : styles + token.value
      line += token.value
    } else if (token.kind === 'text') {
      const text = token.value.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/g, '')
      for (const part of text.split(/(\r|\n)/)) {
        if (part === '\n') push()
        else if (part === '\r') rewrite = true
        else if (part !== '') {
          if (rewrite) line = styles
          rewrite = false
          line += part
          hasText = true
        }
      }
    }
  }
  if (hasText) push()
  return lines
}
