import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser'

import { stripBOM } from './jsonRead.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { passedOver } from './passedOver.js'

export { stripBOM }


const PARSE_CACHE_ENTRIES = 50
const PARSE_CACHE_MAX_INPUT = 8 * 1024

type ParseOutcome = { ok: true; value: unknown } | { ok: false; error: unknown }

function parseOnce(json: string): ParseOutcome {
  try {
    return { ok: true, value: jsonParse(stripBOM(json)) }
  } catch (error) {
    return { ok: false, error }
  }
}

const cachedParse = memoizeWithLRU(
  (json: string): ParseOutcome & { logged: { done: boolean } } => ({ ...parseOnce(json), logged: { done: false } }),
  json => json,
  PARSE_CACHE_ENTRIES,
)

export function safeParseJSON(json: string | null | undefined, shouldLogError: boolean = true): unknown {
  if (json === null || json === undefined || json === '') return null
  if (json.length > PARSE_CACHE_MAX_INPUT) {
    const outcome = parseOnce(json)
    if (outcome.ok) return outcome.value
    if (shouldLogError) logError(outcome.error)
    return null
  }
  const outcome = cachedParse(json)
  if (outcome.ok) return outcome.value
  if (shouldLogError && !outcome.logged.done) {
    outcome.logged.done = true
    logError(outcome.error)
  }
  return null
}
safeParseJSON.cache = cachedParse.cache

export function safeParseJSONC(json: string | null | undefined): unknown {
  if (json === null || json === undefined || json === '') return null
  try {
    const errors: { error: number; offset: number; length: number }[] = []
    const value = parseJsonc(stripBOM(json), errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      throw new Error(`JSONC parse error at offset ${errors[0]!.offset}`)
    }
    return value
  } catch (error) {
    logError(error)
    return null
  }
}

export function addItemToJSONCArray(content: string, newItem: unknown): string {
  const single = jsonStringify([newItem], null, 4)
  if (content.trim() === '') return single
  const clean = stripBOM(content)
  const parsed: unknown = parseJsonc(clean, [], { allowTrailingComma: true })
  if (!Array.isArray(parsed)) return single
  const edits = modify(clean, [parsed.length], newItem, {
    formattingOptions: { tabSize: 4, insertSpaces: true },
    isArrayInsertion: true,
  })
  if (edits.length === 0) return jsonStringify([...parsed, newItem], null, 4)
  return applyEdits(clean, edits)
}


type NativeJsonl = {
  parseChunk: (input: string | Uint8Array) => { values: unknown[]; read: number; done: boolean; error?: unknown }
}

const nativeJsonl: NativeJsonl | null = (() => {
  const bun = (globalThis as { Bun?: { JSONL?: Partial<NativeJsonl> } }).Bun
  const parser = bun?.JSONL
  return parser && typeof parser.parseChunk === 'function' ? (parser as NativeJsonl) : null
})()

const BOM_BYTES = [0xef, 0xbb, 0xbf] as const

function stripBufferBom(buffer: Buffer): Buffer {
  return buffer.length >= 3 && buffer[0] === BOM_BYTES[0] && buffer[1] === BOM_BYTES[1] && buffer[2] === BOM_BYTES[2]
    ? buffer.subarray(3)
    : buffer
}

function indexOfNewline(input: string | Uint8Array): number {
  return typeof input === 'string' ? input.indexOf('\n') : input.indexOf(0x0a)
}

function sliceAfter(input: string | Uint8Array, offset: number): string | Uint8Array {
  return typeof input === 'string' ? input.slice(offset) : input.subarray(offset)
}

function hasNonWhitespace(input: string | Uint8Array, end: number): boolean {
  if (typeof input === 'string') {
    for (let i = 0; i < end; i++) {
      if (input.charCodeAt(i) > 0x20) return true
    }
    return false
  }
  for (let i = 0; i < end; i++) {
    if (input[i]! > 0x20) return true
  }
  return false
}

function parseJsonlNative<T>(data: string | Buffer, parser: NativeJsonl, onSkipped?: (count: number) => void): T[] {
  const results: T[] = []
  let skipped = 0
  let rest: string | Uint8Array = typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  for (;;) {
    let outcome: { values: unknown[]; read: number; done: boolean }
    try {
      outcome = parser.parseChunk(rest)
    } catch (error) {
      passedOver(error)
      outcome = { values: [], read: 0, done: false }
    }
    for (const value of outcome.values) results.push(value as T)
    if (outcome.done) break
    const after = sliceAfter(rest, Math.max(0, outcome.read))
    const newline = indexOfNewline(after)
    if (newline === -1) break
    if (hasNonWhitespace(after, newline)) skipped++
    rest = sliceAfter(after, newline + 1)
    if (rest.length === 0) break
  }
  if (skipped > 0) onSkipped?.(skipped)
  return results
}

export function parseJSONL<T>(data: string | Buffer, options?: { onSkipped?: (count: number) => void }): T[] {
  if (nativeJsonl) {
    return parseJsonlNative<T>(typeof data === 'string' ? stripBOM(data) : stripBufferBom(data), nativeJsonl, options?.onSkipped)
  }
  const text = typeof data === 'string' ? stripBOM(data) : stripBufferBom(data).toString('utf8')
  const lines = text.split('\n')
  const endsWithNewline = text.endsWith('\n')
  const results: T[] = []
  let skipped = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '') continue
    try {
      results.push(jsonParse(line) as T)
    } catch (error) {
      passedOver(error)
      const isTornLastLine = !endsWithNewline && i === lines.length - 1
      if (!isTornLastLine) skipped++
    }
  }
  if (skipped > 0) options?.onSkipped?.(skipped)
  return results
}
