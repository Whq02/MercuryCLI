import chalk from 'chalk'
import ansiRegex from 'ansi-regex'

import { colorStripped } from '../ink/colorize.js'
import { supportsHyperlinks } from '../ink/session/capabilities.js'

const OSC8_START = '\u001b]8;;'
const OSC8_END = '\u0007'

export function createHyperlink(
  url: string,
  content?: string,
  options?: { supportsHyperlinks?: boolean },
): string {
  const supported = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!supported) return url
  const text = colorStripped() ? (content ?? url) : chalk.blue(content ?? url)
  return `${OSC8_START}${url}${OSC8_END}${text}${OSC8_START}${OSC8_END}`
}

export function linkifyCodeUrls(text: string): string {
  if (!supportsHyperlinks() || !text.includes('http') || text.includes(OSC8_START)) return text
  const escapes = ansiRegex()
  const offsets: number[] = []
  let plain = ''
  let from = 0
  for (const match of text.matchAll(escapes)) {
    for (; from < match.index; from++) { offsets.push(from); plain += text[from] }
    from += match[0].length
  }
  for (; from < text.length; from++) { offsets.push(from); plain += text[from] }
  const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const inserts: { start: number; end: number; url: string }[] = []
  for (const match of plain.matchAll(/https?:\/\/[^\s<>"'`\x00-\x1f\x7f]+/g)) {
    let url = match[0]
    while (url.length > 0) {
      const tail = url.at(-1)!
      const open = closing[tail]
      if (/[.,;!?]/.test(tail) || (open !== undefined && url.split(tail).length > url.split(open).length)) url = url.slice(0, -1)
      else break
    }
    if (url === 'http://' || url === 'https://') continue
    inserts.push({ start: offsets[match.index]!, end: offsets[match.index + url.length - 1]! + 1, url })
  }
  for (const { start, end, url } of inserts.reverse()) text = text.slice(0, start) + OSC8_START + url + OSC8_END + text.slice(start, end) + OSC8_START + OSC8_END + text.slice(end)
  return text
}
