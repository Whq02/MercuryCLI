import type { Message } from '../../../types/message.js'
import type { CompatChatRequest, CompatMessage } from '../openaicompat/compatChatClient.js'

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
  generationConfig?: { maxOutputTokens?: number; thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number } }
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
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }]
  if (!Array.isArray(content)) return []
  return content.map(part => {
    if (part.type === 'text') return { text: part.text }
    const url = part.image_url.url
    const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url)
    return data
      ? { inlineData: { mimeType: data[1]!, data: data[2]! } }
      : { fileData: { fileUri: url } }
  })
}

export const GEMINI_SKIP_SIGNATURE_VALIDATION = 'skip_thought_signature_validator'

export function geminiValidatesSignatures(model: string): boolean {
  return !/^gemini-[12]\./.test(model)
}

export function buildGeminiRequest(request: CompatChatRequest, messages: readonly Message[]): GeminiRequest {
  const contents: GeminiContent[] = []
  const systems: Array<{ text: string }> = []
  const assistants = messages.filter(message => message.type === 'assistant')
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
        parts = saved.parts
        for (const call of saved.calls) calls.set(call.id, { name: call.name, ...(call.nativeId ? { nativeId: call.nativeId } : {}), ordinal: ordinal++ })
        for (const refusal of saved.refused ?? []) {
          const call = calls.get(refusal.id)
          if (call) refusedResults.push(responsePart(call, { error: refusal.reason }))
        }
      } else {
        parts = contentParts(row.content)
        const imported = geminiValidatesSignatures(request.model) ? GEMINI_SKIP_SIGNATURE_VALIDATION : undefined
        for (const [index, call] of (row.tool_calls ?? []).entries()) {
          calls.set(call.id, { name: call.function.name, ordinal: ordinal++ })
          parts.push({ functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments) }, ...(imported && index === 0 ? { thoughtSignature: imported } : {}) })
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
  const maxOutput = request.extra?.max_tokens
  const budget = typeof effort === 'string' ? ({ low: 1024, medium: 8192, high: 24576 } as Record<string, number>)[effort] : undefined
  const thinkingConfig = budget === undefined ? undefined : request.model.startsWith('gemini-2.5')
    ? { thinkingBudget: budget }
    : { thinkingLevel: String(effort).toUpperCase() }
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
