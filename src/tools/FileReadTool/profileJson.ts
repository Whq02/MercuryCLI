import { createReadStream } from 'node:fs'

type Frame = { kind: 'object' | 'array'; path: (string | number)[]; tracked: boolean; state: 'key' | 'keyOrEnd' | 'colon' | 'value' | 'valueOrEnd' | 'commaOrEnd'; key: string; index: number }
type Value = { path: (string | number)[]; value: unknown }
const fields = new Set(['nodes', 'samples', 'timeDeltas', 'startTime', 'endTime'])
const primitiveToken = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?)$/
const whitespace = /\s/
const delimiter = /[\s{}\[\],:]/
const untracked: (string | number)[] = []

export async function* profileJsonValues(file: string, signal: AbortSignal, wanted: (path: (string | number)[]) => boolean | 'array'): AsyncGenerator<Value> {
  const stack: Frame[] = []
  let root = false
  let capture: { path: (string | number)[]; depth: number; parts: string[] } | null = null
  const consume = (text: string): Value | null => {
    const frame = stack[stack.length - 1]
    if (capture) capture.parts.push(text)
    if (frame?.state === 'key' || frame?.state === 'keyOrEnd') {
      if (text === '}' && frame.state === 'keyOrEnd') stack.pop()
      else {
        if (text[0] !== '"') throw new SyntaxError('Expected an object key')
        frame.key = JSON.parse(text)
        frame.state = 'colon'
        return null
      }
    } else if (frame?.state === 'colon') {
      if (text !== ':') throw new SyntaxError('Expected a colon')
      frame.state = 'value'
      return null
    } else if (frame?.state === 'commaOrEnd') {
      if (text === ',') { frame.state = frame.kind === 'object' ? 'key' : 'value'; return null }
      if (text !== (frame.kind === 'object' ? '}' : ']')) throw new SyntaxError('Expected a comma or closing delimiter')
      stack.pop()
    } else if (frame?.state === 'valueOrEnd' && text === ']') stack.pop()
    else {
      if (!frame && root) throw new SyntaxError('More than one JSON value')
      root = true
      const path = frame?.tracked ? [...frame.path, frame.kind === 'object' ? frame.key : frame.index++] : untracked
      if (frame) frame.state = 'commaOrEnd'
      const selected = !capture && (!frame || frame.tracked) && wanted(path)
      if (text === '{' || text === '[') {
        if (selected && selected !== 'array') capture = { path, depth: stack.length, parts: [text] }
        const relative = path[0] === 'profile' ? path.slice(1) : path
        const tracked = (!frame || frame.tracked) && (path.length === 0 || (path.length === 1 && path[0] === 'profile') || fields.has(String(relative[0])))
        stack.push({ kind: text === '{' ? 'object' : 'array', path, tracked, state: text === '{' ? 'keyOrEnd' : 'valueOrEnd', key: '', index: 0 })
        return selected === 'array' && text === '[' ? { path, value: [] } : null
      }
      if (text[0] !== '"' && !primitiveToken.test(text)) throw new SyntaxError('Expected a JSON value')
      if (text[0] === '"' || selected) {
        const value = JSON.parse(text)
        if (selected) return { path, value }
      }
      return null
    }
    if (capture && stack.length === capture.depth) {
      const value = { path: capture.path, value: JSON.parse(capture.parts.join('')) }
      capture = null
      return value
    }
    return null
  }
  const stream = createReadStream(file, { encoding: 'utf8', signal, highWaterMark: 16384 })
  let buffer = '', at = 0
  try {
    for await (const chunk of stream) {
      buffer = buffer.slice(at) + chunk
      at = 0
      while (at < buffer.length) {
        signal.throwIfAborted()
        if (whitespace.test(buffer[at]!)) { at++; continue }
        const start = at, first = buffer[at]!
        if ('{}[],:'.includes(first)) at++
        else if (first === '"') {
          let end = at + 1, escaped = false
          for (; end < buffer.length; end++) {
            const c = buffer[end]!
            if (c === '"' && !escaped) break
            if (c === '\\' && !escaped) escaped = true
            else escaped = false
          }
          if (end === buffer.length) break
          at = end + 1
        } else {
          let end = at
          while (end < buffer.length && !delimiter.test(buffer[end]!)) end++
          if (end === buffer.length) break
          at = end
        }
        const picked = consume(buffer.slice(start, at))
        if (picked) yield picked
      }
    }
    const tail = buffer.slice(at).trim()
    if (tail) { const picked = consume(tail); if (picked) yield picked }
    if (!root || stack.length || capture) throw new SyntaxError('Incomplete JSON report')
  } finally { stream.destroy() }
}
