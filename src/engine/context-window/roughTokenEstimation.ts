import { inflateSync } from 'node:zlib'
import type { Message } from '../message-shapes/message.js'
import { normalizeAttachmentForAPI } from '../messages/attachmentText.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'
import { modelReceivesImageBlocks } from '../../models/facts/capabilities.js'
import { declaredRouteOf } from '../../models/roads/routeLaw.js'
import { passedOver } from '../../platform/errors/passedOver.js'

type LooseBlock = Record<string, unknown>

const DEFAULT_BYTES_PER_TOKEN = 4
const MEDIA_BLOCK_TOKENS = 2000
const PDF_PAGE_TOKENS = 3_500
const PDF_FALLBACK_BYTES_PER_PAGE = 150_000
const PDF_FALLBACK_PAGE_CAP = 20
const PDF_PAGE_COUNT_MEMO_LIMIT = 64
const NON_ASCII_RE = /[^\x00-\x7f]/
const NON_ASCII_ALL_RE = /[^\x00-\x7f]/g

function textTokenWeight(text: string): number {
  const base = text.length / DEFAULT_BYTES_PER_TOKEN
  if (!NON_ASCII_RE.test(text)) return base
  const wide = text.match(NON_ASCII_ALL_RE)?.length ?? 0
  return base + wide * (1 - 1 / DEFAULT_BYTES_PER_TOKEN)
}

const pdfPageCountMemo = new Map<string, number>()

function pdfPageObjects(text: string): number {
  return text.match(/\/Type\s*\/Page\b/g)?.length ?? 0
}

function pdfPageCountOf(bytes: Buffer): number | null {
  const text = bytes.toString('latin1')
  const linearized = /\/Linearized\b[\s\S]{0,300}?\/N\s+(\d+)/.exec(text)
  if (linearized !== null) return Number(linearized[1])
  let pages = pdfPageObjects(text)
  const objectStreams = /\/Type\s*\/ObjStm[\s\S]{0,400}?stream\r?\n/g
  for (let match = objectStreams.exec(text); match !== null; match = objectStreams.exec(text)) {
    const start = match.index + match[0].length
    const end = text.indexOf('endstream', start)
    if (end < 0) break
    try {
      pages += pdfPageObjects(inflateSync(bytes.subarray(start, end)).toString('latin1'))
    } catch (error) {
      passedOver(error)
    }
  }
  return pages > 0 ? pages : null
}

function pdfDocumentTokenWeight(source: unknown): number {
  const record = source as { type?: unknown; data?: unknown } | null
  if (record?.type !== 'base64' || typeof record.data !== 'string') return MEDIA_BLOCK_TOKENS
  const data = record.data
  const key = `${data.length}:${data.slice(0, 96)}:${data.slice(-96)}`
  let pages = pdfPageCountMemo.get(key)
  if (pages === undefined) {
    const bytes = Buffer.from(data, 'base64')
    pages = pdfPageCountOf(bytes) ?? Math.max(1, Math.min(PDF_FALLBACK_PAGE_CAP, Math.round(bytes.length / PDF_FALLBACK_BYTES_PER_PAGE)))
    if (pdfPageCountMemo.size >= PDF_PAGE_COUNT_MEMO_LIMIT) pdfPageCountMemo.delete(pdfPageCountMemo.keys().next().value as string)
    pdfPageCountMemo.set(key, pages)
  }
  return pages * PDF_PAGE_TOKENS
}

export function roughTokenCountEstimation(content: string, bytesPerToken?: number): number {
  return Math.round(content.length / (bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN))
}

export function bytesPerTokenForFileType(ext: string): number {
  return ext === 'json' || ext === 'jsonl' || ext === 'jsonc' ? 2 : DEFAULT_BYTES_PER_TOKEN
}

export function roughTokenCountEstimationForFileType(content: string, ext: string): number {
  return roughTokenCountEstimation(content, bytesPerTokenForFileType(ext))
}

function contentTokenWeight(content: unknown, model?: string): number {
  if (typeof content === 'string') return textTokenWeight(content)
  if (Array.isArray(content)) return content.reduce((sum, part) => sum + contentTokenWeight(part, model), 0)
  if (typeof content !== 'object' || content === null) return 0
  const record = content as LooseBlock
  switch (record.type) {
    case 'text':
    case 'input_text':
    case 'output_text':
      return contentTokenWeight(String(record.text ?? ''), model)
    case 'image':
      return modelReceivesImageBlocks(model ?? getEngineModel()) ? MEDIA_BLOCK_TOKENS : contentTokenWeight('[image]', model)
    case 'image_url':
    case 'input_image':
      return MEDIA_BLOCK_TOKENS
    case 'document':
      return pdfDocumentTokenWeight(record.source)
    case 'tool_result':
      return contentTokenWeight(record.content, model)
    case 'tool_use':
      return contentTokenWeight(`${String(record.name ?? '')}${jsonStringify(record.input ?? {})}`, model)
    case 'thinking':
      return contentTokenWeight(String(record.thinking ?? ''), model)
    case 'redacted_thinking':
      return contentTokenWeight(String(record.data ?? ''), model)
    case 'function_call':
      return contentTokenWeight(`${String(record.name ?? '')}${String(record.arguments ?? '')}`, model)
    case 'function_call_output':
      return contentTokenWeight(record.output, model)
    default:
      if (typeof record.role === 'string') {
        const calls = Array.isArray(record.tool_calls) ? record.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> : []
        return contentTokenWeight(record.content, model) + contentTokenWeight(record.reasoning_content, model) + calls.reduce((sum, call) => sum + contentTokenWeight(`${call.function?.name ?? ''}${call.function?.arguments ?? ''}`, model), 0)
      }
      return contentTokenWeight(jsonStringify(record) ?? '', model)
  }
}

export function estimateContentTokens(content: unknown, model?: string): number {
  return Math.ceil(contentTokenWeight(content, model))
}

function messageTokenWeight(message: Message, model?: string): number {
  if (message.type === 'assistant' || message.type === 'user') return contentTokenWeight(message.message.content, model)
  if (message.type === 'attachment') {
    const normalized = normalizeAttachmentForAPI(message.attachment)
    return normalized.reduce((sum, entry) => sum + messageTokenWeight(entry as Message, model), 0)
  }
  if (message.type === 'system') return contentTokenWeight('content' in message ? message.content : '', model)
  return 0
}

export function roughTokenCountEstimationForMessages(messages: readonly Message[], model?: string): number {
  return Math.ceil(messages.reduce((sum, message) => sum + messageTokenWeight(message, model), 0))
}

export function estimateRequestTokens(body: unknown, model?: string): number {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return estimateContentTokens(body, model)
  const request = body as { model?: unknown; messages?: unknown[]; input?: unknown; system?: unknown; instructions?: unknown; tools?: unknown[] }
  model ??= typeof request.model === 'string' ? request.model : undefined
  const rows = request.messages ?? request.input
  if (!Array.isArray(rows)) return estimateContentTokens(body, model)
  let total = contentTokenWeight(request.system, model) + contentTokenWeight(request.instructions, model)
  for (const row of rows) {
    total += row && typeof row === 'object' && 'type' in row && ['user', 'assistant', 'attachment', 'system'].includes(String(row.type))
      ? messageTokenWeight(row as Message, model)
      : contentTokenWeight(row, model)
  }
  if (request.tools?.length) total += (JSON.stringify(request.tools).length / (model !== undefined && declaredRouteOf(model) === 'local' ? 3.9 : DEFAULT_BYTES_PER_TOKEN))
  return Math.ceil(total)
}
