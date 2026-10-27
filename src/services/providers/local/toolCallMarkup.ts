import { schemaPropertyType, typeTextBySchema } from './schemaTyping.js'

type ToolCallMarkupShape = 'qwen-xml' | 'json-in-xml' | 'glm-xml' | 'gemma' | 'mistral' | 'json'

interface MarkupToolCall {
  name: string
  argumentsRaw: string
}

interface ToolCallMarkupExtraction {
  shape: ToolCallMarkupShape
  calls: MarkupToolCall[]
  text: string
}

interface MarkupToolFacts {
  name: string
  input_schema?: unknown
}

const GEMMA_QUOTE = '<|"|>'
const NAME = /^[A-Za-z0-9_.:-]+$/

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function coerceValue(text: string, tool: MarkupToolFacts | undefined, key: string): unknown {
  return typeTextBySchema(text, schemaPropertyType(tool?.input_schema, key))
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function stripOneNewline(text: string): string {
  return text.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
}

function balancedJsonEnd(text: string, start: number): number {
  const open = text[start]
  if (open !== '{' && open !== '[') return -1
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

interface Span {
  start: number
  end: number
  call: MarkupToolCall
}

type Reader = (text: string, toolOf: (name: string) => MarkupToolFacts | undefined) => Span[] | null

function argumentsRawOf(args: Record<string, unknown>): string {
  return JSON.stringify(args)
}

function readToolCallEnvelope(text: string, toolOf: (name: string) => MarkupToolFacts | undefined): { shape: ToolCallMarkupShape; spans: Span[] } | null {
  const spans: Span[] = []
  let shape: ToolCallMarkupShape | undefined
  const openTag = /<tool_call>/g
  let match: RegExpExecArray | null
  while ((match = openTag.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length
    const close = text.indexOf('</tool_call>', bodyStart)
    if (close < 0) return null
    const body = text.slice(bodyStart, close)
    const read = readQwenXml(body, toolOf) ?? readJsonInXml(body, toolOf) ?? readGlmXml(body, toolOf)
    if (read === null) return null
    if (shape !== undefined && shape !== read.shape) return null
    shape = read.shape
    spans.push({ start: match.index, end: close + '</tool_call>'.length, call: read.call })
    openTag.lastIndex = close + '</tool_call>'.length
  }
  if (spans.length === 0 || shape === undefined) return null
  if (text.indexOf('</tool_call>') >= 0 && text.split('</tool_call>').length - 1 !== spans.length) return null
  return { shape, spans }
}

function readQwenXml(body: string, toolOf: (name: string) => MarkupToolFacts | undefined): { shape: ToolCallMarkupShape; call: MarkupToolCall } | null {
  const fn = /^\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*$/.exec(body)
  if (fn === null) return null
  const name = fn[1]!
  const tool = toolOf(name)
  if (tool === undefined) return null
  const args: Record<string, unknown> = {}
  const parameters = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g
  let rest = fn[2]!
  let param: RegExpExecArray | null
  while ((param = parameters.exec(fn[2]!)) !== null) {
    args[param[1]!] = coerceValue(stripOneNewline(param[2]!), tool, param[1]!)
    rest = rest.replace(param[0], '')
  }
  if (rest.trim() !== '') return null
  return { shape: 'qwen-xml', call: { name, argumentsRaw: argumentsRawOf(args) } }
}

function readJsonInXml(body: string, toolOf: (name: string) => MarkupToolFacts | undefined): { shape: ToolCallMarkupShape; call: MarkupToolCall } | null {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return null
  const parsed = rec(parseJson(trimmed))
  if (parsed === undefined) return null
  const name = typeof parsed.name === 'string' ? parsed.name : undefined
  if (name === undefined || toolOf(name) === undefined) return null
  const raw = parsed.arguments ?? parsed.parameters ?? {}
  const args = rec(raw) ?? (typeof raw === 'string' ? rec(parseJson(raw)) : undefined)
  if (args === undefined) return null
  return { shape: 'json-in-xml', call: { name, argumentsRaw: argumentsRawOf(args) } }
}

function readGlmXml(body: string, toolOf: (name: string) => MarkupToolFacts | undefined): { shape: ToolCallMarkupShape; call: MarkupToolCall } | null {
  const head = /^\s*([^<\s]+)\s*([\s\S]*)$/.exec(body)
  if (head === null) return null
  const name = head[1]!
  if (!NAME.test(name)) return null
  const tool = toolOf(name)
  if (tool === undefined) return null
  const args: Record<string, unknown> = {}
  const pairs = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
  let rest = head[2]!
  let pair: RegExpExecArray | null
  while ((pair = pairs.exec(head[2]!)) !== null) {
    const key = pair[1]!.trim()
    args[key] = coerceValue(pair[2]!, tool, key)
    rest = rest.replace(pair[0], '')
  }
  if (rest.trim() !== '') return null
  return { shape: 'glm-xml', call: { name, argumentsRaw: argumentsRawOf(args) } }
}

class GemmaReader {
  private at = 0
  constructor(private readonly text: string) {}
  get index(): number {
    return this.at
  }
  private skipSpace(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) this.at += 1
  }
  private peek(): string | undefined {
    return this.text[this.at]
  }
  readObject(): Record<string, unknown> | undefined {
    this.skipSpace()
    if (this.peek() !== '{') return undefined
    this.at += 1
    const out: Record<string, unknown> = {}
    this.skipSpace()
    if (this.peek() === '}') {
      this.at += 1
      return out
    }
    for (;;) {
      this.skipSpace()
      const key = this.readKey()
      if (key === undefined) return undefined
      this.skipSpace()
      if (this.peek() !== ':') return undefined
      this.at += 1
      const value = this.readValue()
      if (value === undefined) return undefined
      out[key] = value.value
      this.skipSpace()
      const next = this.peek()
      if (next === ',') {
        this.at += 1
        continue
      }
      if (next === '}') {
        this.at += 1
        return out
      }
      return undefined
    }
  }
  private readKey(): string | undefined {
    if (this.text.startsWith(GEMMA_QUOTE, this.at)) {
      const value = this.readValue()
      return typeof value?.value === 'string' ? value.value : undefined
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$.-]*/.exec(this.text.slice(this.at))
    if (match === null) return undefined
    this.at += match[0].length
    return match[0]
  }
  private readValue(): { value: unknown } | undefined {
    this.skipSpace()
    if (this.text.startsWith(GEMMA_QUOTE, this.at)) {
      const start = this.at + GEMMA_QUOTE.length
      const end = this.text.indexOf(GEMMA_QUOTE, start)
      if (end < 0) return undefined
      this.at = end + GEMMA_QUOTE.length
      return { value: this.text.slice(start, end) }
    }
    const ch = this.peek()
    if (ch === '{') {
      const object = this.readObject()
      return object === undefined ? undefined : { value: object }
    }
    if (ch === '[') {
      this.at += 1
      const items: unknown[] = []
      this.skipSpace()
      if (this.peek() === ']') {
        this.at += 1
        return { value: items }
      }
      for (;;) {
        const item = this.readValue()
        if (item === undefined) return undefined
        items.push(item.value)
        this.skipSpace()
        const next = this.peek()
        if (next === ',') {
          this.at += 1
          continue
        }
        if (next === ']') {
          this.at += 1
          return { value: items }
        }
        return undefined
      }
    }
    const bare = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.at))
    if (bare === null) return undefined
    this.at += bare[0].length
    const word = bare[0]
    return { value: word === 'true' ? true : word === 'false' ? false : word === 'null' ? null : Number(word) }
  }
}

const readGemma: Reader = (text, toolOf) => {
  const spans: Span[] = []
  const wrapped = /<\|tool_call>\s*call:([A-Za-z0-9_.:-]+)/g
  let match: RegExpExecArray | null
  while ((match = wrapped.exec(text)) !== null) {
    const name = match[1]!
    if (toolOf(name) === undefined) return null
    const reader = new GemmaReader(text.slice(match.index + match[0].length))
    const args = reader.readObject()
    if (args === undefined) return null
    const after = match.index + match[0].length + reader.index
    const close = /^\s*<tool_call\|>/.exec(text.slice(after))
    if (close === null) return null
    spans.push({ start: match.index, end: after + close[0].length, call: { name, argumentsRaw: argumentsRawOf(args) } })
    wrapped.lastIndex = after + close[0].length
  }
  if (spans.length > 0) return text.split('<|tool_call>').length - 1 === spans.length ? spans : null
  const bare = /^\s*call:([A-Za-z0-9_.:-]+)/.exec(text)
  if (bare === null) return null
  const name = bare[1]!
  if (toolOf(name) === undefined) return null
  const reader = new GemmaReader(text.slice(bare[0].length))
  const args = reader.readObject()
  if (args === undefined) return null
  const end = bare[0].length + reader.index
  if (text.slice(end).replace(/<tool_call\|>/g, '').trim() !== '') return null
  return [{ start: 0, end: text.length, call: { name, argumentsRaw: argumentsRawOf(args) } }]
}

const readMistral: Reader = (text, toolOf) => {
  const spans: Span[] = []
  const marker = /\[TOOL_CALLS\]\s*([A-Za-z0-9_.:-]+)\s*\[ARGS\]\s*/g
  let match: RegExpExecArray | null
  while ((match = marker.exec(text)) !== null) {
    const name = match[1]!
    if (toolOf(name) === undefined) return null
    const start = match.index + match[0].length
    const end = balancedJsonEnd(text, start)
    if (end < 0) return null
    const args = rec(parseJson(text.slice(start, end + 1)))
    if (args === undefined) return null
    spans.push({ start: match.index, end: end + 1, call: { name, argumentsRaw: argumentsRawOf(args) } })
    marker.lastIndex = end + 1
  }
  if (spans.length === 0) return null
  return text.split('[TOOL_CALLS]').length - 1 === spans.length ? spans : null
}

type JsonCallRead = MarkupToolCall[] | 'undeclared' | null

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string')
}

function jsonCallOf(value: unknown, toolOf: (name: string) => MarkupToolFacts | undefined, anyName: boolean): MarkupToolCall | 'undeclared' | null {
  const object = rec(value)
  if (object === undefined) return null
  const inner = rec(object.function)
  const callNamed = firstString(object.tool_name, object.tool, object.function, inner?.name)
  const name = callNamed ?? firstString(object.name)
  if (name === undefined || !NAME.test(name)) return null
  const argued = object.arguments ?? inner?.arguments
  const raw = argued ?? (anyName && callNamed === undefined ? undefined : (object.parameters ?? object.input ?? inner?.parameters))
  if (raw === undefined) return null
  const args = rec(raw) ?? (typeof raw === 'string' ? rec(parseJson(raw)) : undefined)
  if (args === undefined) return null
  if (toolOf(name) === undefined) return 'undeclared'
  return { name, argumentsRaw: argumentsRawOf(args) }
}

function jsonCallsOf(value: unknown, toolOf: (name: string) => MarkupToolFacts | undefined, anyName: boolean): JsonCallRead {
  const items = Array.isArray(value) ? value : [value]
  if (items.length === 0) return null
  const calls: MarkupToolCall[] = []
  for (const item of items) {
    const read = jsonCallOf(item, toolOf, anyName)
    if (read === null) return null
    if (read === 'undeclared') return 'undeclared'
    calls.push(read)
  }
  return calls
}

const FENCE_BEFORE = /(?:`{3,}|~{3,})[A-Za-z_-]*[ \t]*\r?\n?[ \t]*$/
const FENCE_AFTER = /^[ \t]*\r?\n?[ \t]*(?:`{3,}|~{3,})/

function readJson(text: string, regions: readonly Region[], toolOf: (name: string) => MarkupToolFacts | undefined, anyName: boolean): Span[] | null {
  const regionAt = (index: number): Region | undefined => regions.find(region => index >= region.start && index < region.end)
  const spans: Span[] = []
  let at = 0
  while (at < text.length) {
    const open = text[at]
    if (open !== '{' && open !== '[') {
      at += 1
      continue
    }
    const close = balancedJsonEnd(text, at)
    if (close < 0) {
      at += 1
      continue
    }
    const region = regionAt(at)
    if (region !== undefined && (region.inner === undefined || text.slice(region.inner.start, region.inner.end).trim() !== text.slice(at, close + 1))) {
      at = close + 1
      continue
    }
    const read = jsonCallsOf(parseJson(text.slice(at, close + 1)), toolOf, anyName)
    if (read === 'undeclared') return null
    if (read === null) {
      at = close + 1
      continue
    }
    let start = at
    let end = close + 1
    if (region !== undefined) {
      start = region.start
      end = region.end
    } else {
      const before = FENCE_BEFORE.exec(text.slice(0, at))
      if (before !== null && regionAt(before.index) === undefined) start = before.index
      const after = FENCE_AFTER.exec(text.slice(close + 1))
      if (after !== null) end += after[0].length
    }
    for (const call of read) spans.push({ start, end, call })
    at = end
  }
  return spans.length > 0 ? spans : null
}

function withoutSpans(text: string, spans: readonly Span[]): string {
  let out = ''
  let cursor = 0
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, span.start)
    cursor = span.end
  }
  out += text.slice(cursor)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

interface Region {
  start: number
  end: number
  inner?: { start: number; end: number }
}

function inlineCodeRegions(text: string, from: number, to: number, regions: Region[]): void {
  const slice = text.slice(from, to)
  const runs = /`+/g
  let match: RegExpExecArray | null
  while ((match = runs.exec(slice)) !== null) {
    const ticks = match[0]
    let searchFrom = match.index + ticks.length
    for (;;) {
      const close = slice.indexOf(ticks, searchFrom)
      if (close < 0) break
      let runEnd = close + ticks.length
      if (slice[runEnd] === '`') {
        while (slice[runEnd] === '`') runEnd += 1
        searchFrom = runEnd
        continue
      }
      regions.push({ start: from + match.index, end: from + runEnd })
      runs.lastIndex = runEnd
      break
    }
  }
}

function codeRegions(text: string): Region[] {
  const regions: Region[] = []
  let fence: { char: string; length: number; start: number; innerStart: number } | undefined
  let proseFrom = 0
  let lineStart = 0
  for (;;) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text.slice(lineStart, lineEnd))
    if (fence === undefined) {
      if (run !== null) {
        inlineCodeRegions(text, proseFrom, lineStart, regions)
        fence = { char: run[1]![0]!, length: run[1]!.length, start: lineStart, innerStart: newline < 0 ? text.length : newline + 1 }
      }
    } else if (run !== null && run[1]![0] === fence.char && run[1]!.length >= fence.length && run[2]!.trim() === '') {
      regions.push({ start: fence.start, end: lineEnd, inner: { start: fence.innerStart, end: lineStart } })
      fence = undefined
      proseFrom = lineEnd
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  if (fence !== undefined) regions.push({ start: fence.start, end: text.length, inner: { start: fence.innerStart, end: text.length } })
  else inlineCodeRegions(text, proseFrom, text.length, regions)
  return regions
}

function maskRegions(text: string, regions: readonly Region[]): string {
  let out = text
  for (const region of regions) out = out.slice(0, region.start) + ' '.repeat(region.end - region.start) + out.slice(region.end)
  return out
}

function readSpans(text: string, toolOf: (name: string) => MarkupToolFacts | undefined): { shape: ToolCallMarkupShape; spans: Span[] } | null {
  if (text.includes('<tool_call>')) return readToolCallEnvelope(text, toolOf)
  if (text.includes('call:')) {
    const spans = readGemma(text, toolOf)
    if (spans !== null) return { shape: 'gemma', spans }
  }
  if (text.includes('[TOOL_CALLS]')) {
    const spans = readMistral(text, toolOf)
    if (spans !== null) return { shape: 'mistral', spans }
  }
  return null
}

function extract(text: string, toolOf: (name: string) => MarkupToolFacts | undefined, anyName: boolean): ToolCallMarkupExtraction | undefined {
  const regions = codeRegions(text)
  const visible = maskRegions(text, regions)
  const read = readSpans(visible, toolOf)
  if (read === null) {
    if (text.includes('<tool_call>')) return undefined
    const spans = readJson(text, regions, toolOf, anyName)
    if (spans === null || text.slice(spans[spans.length - 1]!.end).trim() !== '') return undefined
    return { shape: 'json', calls: spans.map(span => span.call), text: withoutSpans(text, spans) }
  }
  if (read.spans.length === 0) return undefined
  const spans = [...read.spans].sort((a, b) => a.start - b.start)
  if (text.slice(spans[spans.length - 1]!.end).trim() !== '') return undefined
  const calls: MarkupToolCall[] = []
  for (const span of spans) {
    const original = text.slice(span.start, span.end)
    if (original === visible.slice(span.start, span.end)) {
      calls.push(span.call)
      continue
    }
    const again = readSpans(original, toolOf)
    const whole = again?.spans.length === 1 && again.shape === read.shape && again.spans[0]!.start === 0 && again.spans[0]!.end === original.length ? again.spans[0] : undefined
    if (whole === undefined) return undefined
    calls.push(whole.call)
  }
  return { shape: read.shape, calls, text: withoutSpans(text, spans) }
}

export function extractToolCallMarkup(text: string, tools: readonly MarkupToolFacts[]): ToolCallMarkupExtraction | undefined {
  if (text.trim() === '' || tools.length === 0) return undefined
  const byName = new Map(tools.map(tool => [tool.name, tool] as const))
  return extract(text, name => byName.get(name), false)
}

export function toolCallShapedAnswer(text: string): { shape: ToolCallMarkupShape; names: string[] } | undefined {
  if (text.trim() === '') return undefined
  const read = extract(text, name => ({ name }), true)
  return read === undefined ? undefined : { shape: read.shape, names: [...new Set(read.calls.map(call => call.name))] }
}
