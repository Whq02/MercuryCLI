import type { Message } from '../../../types/message.js'
import type { CompatChatRequest, CompatMessage } from '../openaicompat/compatChatClient.js'
import { requestTurnOf } from '../../../rows/request.js'

export type GeminiPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  fileData?: { mimeType?: string; fileUri: string }
  functionCall?: { id?: string; name: string; args?: unknown }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}

export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

export type GeminiRequest = {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<{ functionDeclarations: Array<{ name: string; description?: string; parametersJsonSchema: unknown }> }>
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'NONE' | 'ANY' } }
  generationConfig?: { maxOutputTokens?: number; thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number; includeThoughts?: boolean } }
}

export type GeminiTurnItem = {
  model: string
  parts: GeminiPart[]
  calls: Array<{ id: string; name: string; nativeId?: string }>
  projection: string
  refused?: Array<{ id: string; reason: string }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function replayItem(value: unknown, model: string, row: CompatMessage): GeminiTurnItem | undefined {
  const item = record(value)
  if (item?.model !== model || !Array.isArray(item.parts) || !Array.isArray(item.calls) || item.projection !== JSON.stringify(row)) return undefined
  for (const raw of item.calls) {
    const call = record(raw)
    if (typeof call?.id !== 'string' || typeof call.name !== 'string' || (call.nativeId !== undefined && typeof call.nativeId !== 'string')) return undefined
  }
  if (item.refused !== undefined && (!Array.isArray(item.refused) || item.refused.some(value => typeof record(value)?.id !== 'string' || typeof record(value)?.reason !== 'string'))) return undefined
  for (const raw of item.parts) {
    const part = record(raw)
    if (!part) return undefined
    if (part.text !== undefined && typeof part.text !== 'string') return undefined
    if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string') return undefined
    if (part.functionCall !== undefined && typeof record(part.functionCall)?.name !== 'string') return undefined
  }
  return item as unknown as GeminiTurnItem
}

function contentParts(content: CompatMessage['content']): GeminiPart[] {
  const turn = requestTurnOf('user', content)
  if (turn.stringContent !== undefined) return turn.stringContent === '' ? [] : [{ text: turn.stringContent }]
  return turn.items.map(item => {
    if (item.type === 'text') return { text: item.text }
    const url = (item.value as unknown as { image_url: { url: string } }).image_url.url
    const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url)
    return data ? { inlineData: { mimeType: data[1]!, data: data[2]! } } : { fileData: { fileUri: url } }
  })
}

export const GEMINI_SKIP_SIGNATURE_VALIDATION = 'skip_thought_signature_validator'

export function geminiValidatesSignatures(model: string): boolean {
  return /^gemini-/.test(model) && !/^gemini-[12]\./.test(model)
}

const GEMINI_PLAN_CLAUDE_OUTPUT_CAP = 64_000

export function geminiPlanServesClaude(wireModel: string): boolean {
  return /^claude-/.test(wireModel)
}

export function anthropicToolCallId(id: string): string {
  const allowed = id.replace(/[^A-Za-z0-9_-]/g, '_')
  return allowed === '' ? 'call' : allowed
}

type ProtoField = { index: number; varint?: number; bytes?: Uint8Array }

function base64Bytes(text: string): Uint8Array | null {
  if (text === '' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null
  const bytes = Buffer.from(text, 'base64')
  return bytes.length === 0 ? null : new Uint8Array(bytes)
}

function protoFields(bytes: Uint8Array): ProtoField[] | null {
  const out: ProtoField[] = []
  let at = 0
  const varint = (): number | null => {
    let value = 0
    let shift = 0
    for (;;) {
      if (at >= bytes.length || shift > 49) return null
      const byte = bytes[at++]!
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
      shift += 7
    }
  }
  while (at < bytes.length) {
    const key = varint()
    if (key === null) return null
    const index = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) {
      const value = varint()
      if (value === null) return null
      out.push({ index, varint: value })
    } else if (wire === 2) {
      const length = varint()
      if (length === null || at + length > bytes.length) return null
      out.push({ index, bytes: bytes.subarray(at, at + length) })
      at += length
    } else if (wire === 1) {
      at += 8
    } else if (wire === 5) {
      at += 4
    } else return null
    if (at > bytes.length) return null
  }
  return out
}

const THOUGHT_KIND_PATTERN = /^[a-z][a-z_]{0,31}$/

export function geminiThoughtKindOf(signature: string): string | null {
  let bytes = base64Bytes(signature)
  for (let layer = 0; bytes !== null && layer < 2; layer++) {
    const envelope = protoFields(bytes)
    const inner = envelope?.find(field => field.index === 2 && field.bytes !== undefined)?.bytes
    const meta = inner === undefined ? undefined : protoFields(inner)?.find(field => field.index === 1 && field.bytes !== undefined)?.bytes
    const kind = meta === undefined ? undefined : protoFields(meta)?.find(field => field.index === 8 && field.bytes !== undefined)?.bytes
    if (kind !== undefined) {
      const words = Buffer.from(kind).toString('utf8')
      return THOUGHT_KIND_PATTERN.test(words) ? words : null
    }
    const text = Buffer.from(bytes).toString('latin1')
    bytes = base64Bytes(text)
  }
  return null
}

function claudeReplayParts(saved: GeminiTurnItem): GeminiPart[] {
  const parts: GeminiPart[] = []
  let callIndex = 0
  for (const part of saved.parts) {
    if (part.functionCall !== undefined) {
      const call = saved.calls[callIndex++]
      const id = part.functionCall.id ?? (call === undefined ? undefined : call.nativeId ?? anthropicToolCallId(call.id))
      parts.push(id === undefined || id === part.functionCall.id ? part : { ...part, functionCall: { ...part.functionCall, id } })
      continue
    }
    if (part.thought === true) {
      if (part.thoughtSignature === undefined || part.thoughtSignature === '') continue
      const kind = geminiThoughtKindOf(part.thoughtSignature)
      if (kind !== null && kind !== 'thinking') continue
    }
    parts.push(part)
  }
  return parts
}

function geminiThinkingConfig(model: string, effort: string | undefined): { thinkingBudget: number; includeThoughts?: boolean } | { thinkingLevel: string } | undefined {
  const budget = typeof effort === 'string' ? ({ low: 1024, medium: 8192, high: 24576 } as Record<string, number>)[effort] : undefined
  if (budget === undefined) return undefined
  if (geminiPlanServesClaude(model)) return { includeThoughts: true, thinkingBudget: budget }
  return model.startsWith('gemini-2.5') ? { thinkingBudget: budget } : { thinkingLevel: String(effort).toUpperCase() }
}

export function buildGeminiRequest(request: CompatChatRequest, messages: readonly Message[]): GeminiRequest {
  const contents: GeminiContent[] = []
  const systems: Array<{ text: string }> = []
  const assistants = messages.filter(message => message.type === 'assistant')
  const claudeRow = geminiPlanServesClaude(request.model)
  const calls = new Map<string, { name: string; nativeId?: string; ordinal: number }>()
  const responseOrdinals = new Map<GeminiPart, number>()
  let ordinal = 0
  let assistantIndex = 0
  const responsePart = (call: { name: string; nativeId?: string; ordinal: number }, response: Record<string, unknown>): GeminiPart => {
    const part: GeminiPart = { functionResponse: { name: call.name, ...(call.nativeId ? { id: call.nativeId } : {}), response } }
    responseOrdinals.set(part, call.ordinal)
    return part
  }
  for (const row of request.messages) {
    if (!('content' in row)) continue
    if (row.role === 'system') {
      for (const part of contentParts(row.content)) if (part.text !== undefined) systems.push({ text: part.text })
      continue
    }
    const role = row.role === 'assistant' ? 'model' : 'user'
    let parts: GeminiPart[]
    const refusedResults: GeminiPart[] = []
    if (row.role === 'assistant') {
      const assistant = assistants[assistantIndex++]
      const saved = replayItem(assistant?.geminiProviderTurn, request.model, row)
      if (saved) {
        parts = claudeRow ? claudeReplayParts(saved) : saved.parts
        for (const call of saved.calls) {
          const nativeId = call.nativeId ?? (claudeRow ? anthropicToolCallId(call.id) : undefined)
          calls.set(call.id, { name: call.name, ...(nativeId ? { nativeId } : {}), ordinal: ordinal++ })
        }
        for (const refusal of saved.refused ?? []) {
          const call = calls.get(refusal.id)
          if (call) refusedResults.push(responsePart(call, { error: refusal.reason }))
        }
      } else {
        parts = contentParts(row.content)
        const imported = geminiValidatesSignatures(request.model) ? GEMINI_SKIP_SIGNATURE_VALIDATION : undefined
        for (const [index, call] of (row.tool_calls ?? []).entries()) {
          const nativeId = claudeRow ? anthropicToolCallId(call.id) : undefined
          calls.set(call.id, { name: call.function.name, ...(nativeId ? { nativeId } : {}), ordinal: ordinal++ })
          parts.push({ functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments), ...(nativeId ? { id: nativeId } : {}) }, ...(imported && index === 0 ? { thoughtSignature: imported } : {}) })
        }
      }
    } else if (row.role === 'tool') {
      const call = calls.get(row.tool_call_id ?? '')
      if (!call) throw new Error('a Gemini tool result has no matching function call')
      const result = typeof row.content === 'string' ? row.content : JSON.stringify(row.content)
      parts = [responsePart(call, { output: result })]
    } else {
      parts = contentParts(row.content)
    }
    if (parts.length === 0) continue
    const previous = contents.at(-1)
    if (previous?.role === role) previous.parts.push(...parts)
    else contents.push({ role, parts: [...parts] })
    if (refusedResults.length) contents.push({ role: 'user', parts: refusedResults })
  }
  for (const content of contents) {
    if (content.role !== 'user' || !content.parts.some(part => responseOrdinals.has(part))) continue
    const responses = content.parts.filter(part => responseOrdinals.has(part)).sort((a, b) => responseOrdinals.get(a)! - responseOrdinals.get(b)!)
    content.parts = [...responses, ...content.parts.filter(part => !responseOrdinals.has(part))]
  }
  const effort = request.extra?.reasoning_effort
  const requestedOutput = request.extra?.max_tokens
  const maxOutput = geminiPlanServesClaude(request.model)
    ? Math.min(typeof requestedOutput === 'number' ? requestedOutput : GEMINI_PLAN_CLAUDE_OUTPUT_CAP, GEMINI_PLAN_CLAUDE_OUTPUT_CAP)
    : requestedOutput
  const thinkingConfig = geminiThinkingConfig(request.model, typeof effort === 'string' ? effort : undefined)
  const generationConfig = {
    ...(typeof maxOutput === 'number' ? { maxOutputTokens: maxOutput } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  }
  return {
    contents,
    ...(systems.length ? { systemInstruction: { parts: systems } } : {}),
    ...(request.tools?.length ? {
      tools: [{ functionDeclarations: request.tools.map(tool => ({
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        parametersJsonSchema: tool.function.parameters,
      })) }],
      toolConfig: { functionCallingConfig: { mode: request.tool_choice === 'none' ? 'NONE' : request.tool_choice === 'required' ? 'ANY' : 'AUTO' } },
    } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  }
}

export const GEMINI_SCHEMA_GRAMMAR: ReadonlySet<string> = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'items', 'maxItems', 'minItems', 'properties', 'required',
  'minProperties', 'maxProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'example', 'anyOf', 'propertyOrdering', 'default',
  'additionalProperties', 'oneOf',
])

export const CODE_ASSIST_SUBSET_GRAMMAR: ReadonlySet<string> = new Set([
  'type', 'title', 'description', 'enum', 'items', 'properties', 'required', 'oneOf', 'default',
])

export function codeAssistGrammarFor(wireModel: string): ReadonlySet<string> {
  return /^gemini-/.test(wireModel) ? GEMINI_SCHEMA_GRAMMAR : CODE_ASSIST_SUBSET_GRAMMAR
}

const GEMINI_SCHEMA_SUBSCHEMA_KEYS = new Set(['items', 'additionalProperties'])
const GEMINI_SCHEMA_SUBSCHEMA_LIST_KEYS = new Set(['anyOf', 'oneOf'])

function boundWords(key: string, value: unknown): string | undefined {
  const count = (noun: string): string | undefined => (typeof value === 'number' ? `${value} ${noun}${value === 1 ? '' : 's'}` : undefined)
  switch (key) {
    case 'exclusiveMinimum':
      return typeof value === 'number' ? `greater than ${value}` : undefined
    case 'exclusiveMaximum':
      return typeof value === 'number' ? `less than ${value}` : undefined
    case 'minimum':
      return typeof value === 'number' ? `at least ${value}` : undefined
    case 'maximum':
      return typeof value === 'number' ? `at most ${value}` : undefined
    case 'multipleOf':
      return typeof value === 'number' ? `a multiple of ${value}` : undefined
    case 'uniqueItems':
      return value === true ? 'items are unique' : undefined
    case 'minItems':
      return count('item') === undefined ? undefined : `at least ${count('item')}`
    case 'maxItems':
      return count('item') === undefined ? undefined : `at most ${count('item')}`
    case 'minLength':
      return count('character') === undefined ? undefined : `at least ${count('character')}`
    case 'maxLength':
      return count('character') === undefined ? undefined : `at most ${count('character')}`
    case 'minProperties':
      return count('key') === undefined ? undefined : `at least ${count('key')}`
    case 'maxProperties':
      return count('key') === undefined ? undefined : `at most ${count('key')}`
    case 'pattern':
      return typeof value === 'string' ? `matches the pattern ${value}` : undefined
    case 'format':
      return typeof value === 'string' ? `format ${value}` : undefined
    case 'nullable':
      return value === true ? 'may be null' : undefined
    default:
      return undefined
  }
}

function withWords(description: unknown, words: string[]): string | undefined {
  const base = typeof description === 'string' ? description.trim() : ''
  if (words.length === 0) return base === '' ? undefined : base
  const tail = `(${words.join('; ')})`
  return base === '' ? tail : `${base}${/[.!?]$/.test(base) ? '' : '.'} ${tail}`
}

function mergeAllOf(variants: unknown[]): Record<string, unknown> | undefined {
  const objects = variants.map(record)
  if (objects.length === 0 || objects.some(v => v === undefined || (v.type !== undefined && v.type !== 'object') || (v.type === undefined && v.properties === undefined))) return undefined
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  for (const variant of objects) {
    const table = record(variant!.properties)
    if (table) Object.assign(properties, table)
    for (const name of Array.isArray(variant!.required) ? variant!.required : []) if (typeof name === 'string') required.add(name)
  }
  return { type: 'object', properties, ...(required.size ? { required: [...required] } : {}) }
}

export function codeAssistSchema(value: unknown, grammar: ReadonlySet<string> = GEMINI_SCHEMA_GRAMMAR): unknown {
  const raw = record(value)
  if (!raw) return typeof value === 'boolean' ? {} : value
  const reduce = (sub: unknown): unknown => codeAssistSchema(sub, grammar)
  const out: Record<string, unknown> = {}
  const words: string[] = []
  let constValue: unknown
  let allOfMerged: Record<string, unknown> | undefined
  for (const [key, entry] of Object.entries(raw)) {
    if (key === 'const') {
      constValue = entry
      continue
    }
    if (key === 'examples') {
      if (grammar.has('example') && Array.isArray(entry) && entry.length > 0 && out.example === undefined) out.example = entry[0]
      continue
    }
    if (key === 'allOf') {
      allOfMerged = Array.isArray(entry) ? mergeAllOf(entry) : undefined
      continue
    }
    if (key === 'anyOf' && !grammar.has('anyOf') && grammar.has('oneOf') && Array.isArray(entry)) {
      out.oneOf = [...(Array.isArray(out.oneOf) ? (out.oneOf as unknown[]) : []), ...entry.map(reduce)]
      continue
    }
    if (!grammar.has(key)) {
      const said = boundWords(key, entry)
      if (said !== undefined) words.push(said)
      continue
    }
    if (key === 'properties') {
      const table = record(entry)
      out.properties = table ? Object.fromEntries(Object.entries(table).map(([name, schema]) => [name, reduce(schema)])) : {}
      continue
    }
    if (GEMINI_SCHEMA_SUBSCHEMA_KEYS.has(key)) {
      out[key] = typeof entry === 'boolean' ? entry : reduce(entry)
      continue
    }
    if (GEMINI_SCHEMA_SUBSCHEMA_LIST_KEYS.has(key)) {
      const variants = Array.isArray(entry) ? entry.map(reduce) : entry
      if (key === 'oneOf' && Array.isArray(out.oneOf) && Array.isArray(variants)) out.oneOf = [...(out.oneOf as unknown[]), ...variants]
      else out[key] = variants
      continue
    }
    if (key === 'enum') {
      out.enum = Array.isArray(entry) ? entry.map(member => (typeof member === 'string' ? member : JSON.stringify(member))) : entry
      continue
    }
    if (key === 'type' && Array.isArray(entry)) {
      const names = entry.filter((name): name is string => typeof name === 'string')
      const first = names.find(name => name !== 'null')
      if (first !== undefined) out.type = first
      if (names.includes('null')) {
        if (grammar.has('nullable')) out.nullable = true
        else words.push('may be null')
      }
      continue
    }
    out[key] = entry
  }
  if (constValue !== undefined) {
    const spelled = typeof constValue === 'string' ? constValue : JSON.stringify(constValue)
    const existing = Array.isArray(out.enum) ? (out.enum as unknown[]) : []
    out.enum = existing.includes(spelled) ? existing : [...existing, spelled]
    if (out.type === undefined && typeof constValue === 'string') out.type = 'string'
  }
  if (allOfMerged) {
    const own = record(out.properties) ?? {}
    out.type = 'object'
    out.properties = { ...Object.fromEntries(Object.entries(record(allOfMerged.properties) ?? {}).map(([name, schema]) => [name, reduce(schema)])), ...own }
    const required = new Set<string>([...(Array.isArray(allOfMerged.required) ? (allOfMerged.required as string[]) : []), ...(Array.isArray(out.required) ? (out.required as string[]) : [])])
    if (required.size) out.required = [...required]
  }
  const description = withWords(out.description, words)
  if (description !== undefined) out.description = description
  else delete out.description
  return out
}

export interface GeminiPlanEnvelope {
  projectId: string
  requestId: string
  sessionId: string
  labels: Record<string, string>
  toolMode?: 'VALIDATED' | 'AUTO'
}

export function buildGeminiPlanRequest(request: GeminiRequest, model: string, envelope: GeminiPlanEnvelope): Record<string, unknown> {
  const inner: Record<string, unknown> = {
    contents: request.contents,
    ...(request.systemInstruction ? { systemInstruction: { role: 'user', parts: request.systemInstruction.parts } } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map(tool => ({
            functionDeclarations: tool.functionDeclarations.map(declaration => ({
              name: declaration.name,
              ...(declaration.description ? { description: declaration.description } : {}),
              parameters: codeAssistSchema(declaration.parametersJsonSchema, codeAssistGrammarFor(model)),
            })),
          })),
          toolConfig: { functionCallingConfig: { mode: request.toolConfig && request.toolConfig.functionCallingConfig.mode !== 'AUTO' ? request.toolConfig.functionCallingConfig.mode : envelope.toolMode ?? 'VALIDATED' } },
        }
      : geminiPlanServesClaude(model)
        ? { toolConfig: { functionCallingConfig: { mode: envelope.toolMode ?? 'VALIDATED' } } }
        : {}),
    ...(request.generationConfig ? { generationConfig: request.generationConfig } : {}),
    sessionId: envelope.sessionId,
    labels: envelope.labels,
  }
  return {
    model,
    project: envelope.projectId,
    requestId: envelope.requestId,
    request: inner,
    userAgent: 'antigravity',
    requestType: 'agent',
  }
}
