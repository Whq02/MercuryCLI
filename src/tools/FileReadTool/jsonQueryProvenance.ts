import { read, readFileSync } from 'node:fs'

function constantQuery(query: string): boolean {
  let dynamicString = false
  const withoutStrings = query.replace(/"(?:\\.|[^"\\])*"/g, value => {
    try { JSON.parse(value); return '0' } catch { dynamicString = true; return value }
  }).replace(/#[^\n]*/g, '')
  if (dynamicString) return false
  const rest = withoutStrings.replace(/\b(?:true|false|null)\b/g, '0').replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*:/g, ':').replace(/(?<![A-Za-z0-9_])\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/g, '')
  return rest.trim() !== '' ? /^[\s{}\[\](),:+*\/%<>=!?&|^\-]*$/.test(rest) : withoutStrings.trim() !== ''
}

export async function jsonQuerySourceLines(fd: number, originsPath: string, shown: number, array: boolean, query: string, signal: AbortSignal): Promise<Array<number | null>> {
  if (shown === 0) return []
  if (constantQuery(query)) return Array.from({ length: shown }, () => null)
  const pairs = readFileSync(originsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as [number, number])
  const wanted = Array.from({ length: shown }, (_, index) => {
    const pair = pairs[array ? 0 : index]
    return pair && Number.isSafeInteger(pair[0]) && pair[0] > 0 && pair[0] === pair[1] ? pair[0] : null
  })
  const targets = new Set(wanted.filter((line): line is number => line !== null))
  if (targets.size === 0) return wanted
  const last = wanted.reduce<number>((maximum, value) => Math.max(maximum, value ?? 0), 0)
  const valid = new Set<number>()
  const buffer = Buffer.alloc(65536)
  let position = 0, line = 1, depth = 0, quoted = false, escaped = false, active = false, scalar = false, startLine = 0, complete = 0, spanning = false
  const finishValue = (): void => { complete++; if (startLine !== line) spanning = true; active = false; scalar = false }
  const finishLine = (): void => {
    if (targets.has(line) && complete > 0 && !spanning) valid.add(line)
    line++; complete = 0; spanning = false
  }
  while (line <= last) {
    signal.throwIfAborted()
    const got = await new Promise<number>((resolve, reject) => read(fd, buffer, 0, buffer.length, position, (error, count) => error ? reject(error) : resolve(count)))
    if (got === 0) {
      if (active && scalar) finishValue()
      finishLine()
      break
    }
    let at = position === 0 && got >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0
    for (; at < got && line <= last; at++) {
      const c = buffer[at]
      const white = c === 32 || c === 9 || c === 10 || c === 13
      if (active && scalar && (white || c === 123 || c === 91 || c === 34)) finishValue()
      if (!active && !white) {
        active = true; startLine = line
        if (c === 123 || c === 91) { depth = 1; scalar = false }
        else if (c === 34) { quoted = true; scalar = false }
        else scalar = true
      } else if (active && !scalar) {
        if (quoted) {
          if (escaped) escaped = false
          else if (c === 92) escaped = true
          else if (c === 34) { quoted = false; if (depth === 0) finishValue() }
        } else if (c === 34) quoted = true
        else if (c === 123 || c === 91) depth++
        else if (c === 125 || c === 93) { depth--; if (depth === 0) finishValue() }
      }
      if (c === 10) finishLine()
    }
    position += got
  }
  signal.throwIfAborted()
  return wanted.map(value => value !== null && valid.has(value) ? value : null)
}
