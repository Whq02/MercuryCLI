type ToolCallMarkupShape = 'qwen-xml' | 'json-in-xml' | 'glm-xml' | 'gemma' | 'mistral'

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

function propertyType(tool: MarkupToolFacts | undefined, key: string): string | undefined {
  const schema = rec(tool?.input_schema)
  const property = rec(rec(schema?.properties)?.[key])
  if (property === undefined) return undefined
  if (typeof property.type === 'string') return property.type
  if (Array.isArray(property.type)) return property.type.find((t): t is string => typeof t === 'string' && t !== 'null')
  if (Array.isArray(property.anyOf)) {
    const first = property.anyOf.map(rec).find(option => option !== undefined && option.type !== 'null')
    return typeof first?.type === 'string' ? first.type : undefined
  }
  return undefined
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function coerceValue(text: string, type: string | undefined): unknown {
  const trimmed = text.trim()
  switch (type) {
    case 'string':
      return text
    case 'number':
    case 'integer': {
      const n = Number(trimmed)
      return trimmed !== '' && Number.isFinite(n) ? n : text
    }
    case 'boolean':
      return trimmed === 'true' ? true : trimmed === 'false' ? false : text
    case 'object':
    case 'array': {
      const parsed = parseJson(trimmed)
      return parsed !== undefined && typeof parsed === 'object' ? parsed : text
    }
    default: {
      if (/^(?:\{|\[|-?\d|true$|false$|null$)/.test(trimmed)) {
        const parsed = parseJson(trimmed)
        if (parsed !== undefined) return parsed
      }
      return text
    }
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
    args[param[1]!] = coerceValue(stripOneNewline(param[2]!), propertyType(tool, param[1]!))
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
    args[key] = coerceValue(pair[2]!, propertyType(tool, key))
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
  let fence: { char: string; length: number; start: number } | undefined
  let proseFrom = 0
  let lineStart = 0
  for (;;) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text.slice(lineStart, lineEnd))
    if (fence === undefined) {
      if (run !== null) {
        inlineCodeRegions(text, proseFrom, lineStart, regions)
        fence = { char: run[1]![0]!, length: run[1]!.length, start: lineStart }
      }
    } else if (run !== null && run[1]![0] === fence.char && run[1]!.length >= fence.length && run[2]!.trim() === '') {
      regions.push({ start: fence.start, end: lineEnd })
      fence = undefined
      proseFrom = lineEnd
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  if (fence !== undefined) regions.push({ start: fence.start, end: text.length })
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

export function extractToolCallMarkup(text: string, tools: readonly MarkupToolFacts[]): ToolCallMarkupExtraction | undefined {
  if (text.trim() === '' || tools.length === 0) return undefined
  const byName = new Map(tools.map(tool => [tool.name, tool] as const))
  const toolOf = (name: string): MarkupToolFacts | undefined => byName.get(name)
  const visible = maskRegions(text, codeRegions(text))
  const read = readSpans(visible, toolOf)
  if (read === null || read.spans.length === 0) return undefined
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
