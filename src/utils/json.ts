import { open, readFile, stat } from 'node:fs/promises'

import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser'

import { stripBOM } from './jsonRead.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

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
  try {
    const stripped = stripBOM(content)
    const parsed = parseJsonc(stripped, [], { allowTrailingComma: true }) as unknown
    if (!Array.isArray(parsed)) return single
    const index = parsed.length === 0 ? 0 : parsed.length
    const edits = modify(stripped, [index], newItem, {
      isArrayInsertion: true,
      formattingOptions: { insertSpaces: true, tabSize: 4 },
    })
    if (edits.length === 0) return jsonStringify([...parsed, newItem], null, 4)
    return applyEdits(stripped, edits)
  } catch (error) {
    logError(error)
    return single
  }
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

function parseJsonlNative<T>(data: string | Buffer, parser: NativeJsonl): T[] {
  const results: T[] = []
  let rest: string | Uint8Array = typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  for (;;) {
    let outcome: { values: unknown[]; read: number; done: boolean }
    try {
      outcome = parser.parseChunk(rest)
    } catch {
      outcome = { values: [], read: 0, done: false }
    }
    for (const value of outcome.values) results.push(value as T)
    if (outcome.done) break
    const after = sliceAfter(rest, Math.max(0, outcome.read))
    const newline = indexOfNewline(after)
    if (newline === -1) break
    rest = sliceAfter(after, newline + 1)
    if (rest.length === 0) break
  }
  return results
}

export function parseJSONL<T>(data: string | Buffer): T[] {
  if (nativeJsonl) {
    return parseJsonlNative<T>(typeof data === 'string' ? stripBOM(data) : stripBufferBom(data), nativeJsonl)
  }
  const text = typeof data === 'string' ? stripBOM(data) : stripBufferBom(data).toString('utf8')
  const results: T[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    try {
      results.push(jsonParse(line) as T)
    } catch {
    }
  }
  return results
}

const JSONL_TAIL_WINDOW = 100 * 1024 * 1024

export async function readJSONLFile<T>(filePath: string): Promise<T[]> {
  const stats = await stat(filePath)
  if (stats.size <= JSONL_TAIL_WINDOW) return parseJSONL<T>(await readFile(filePath))
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(JSONL_TAIL_WINDOW)
    const start = stats.size - JSONL_TAIL_WINDOW
    let filled = 0
    while (filled < JSONL_TAIL_WINDOW) {
      const { bytesRead } = await handle.read(buffer, filled, JSONL_TAIL_WINDOW - filled, start + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const window = buffer.subarray(0, filled)
    const newline = window.indexOf(0x0a)
    if (newline === -1 || newline === window.length - 1) return parseJSONL<T>(window)
    return parseJSONL<T>(window.subarray(newline + 1))
  } finally {
    await handle.close()
  }
}
