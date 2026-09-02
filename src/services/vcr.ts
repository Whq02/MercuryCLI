import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages'

import { addToTotalSessionCost } from '../cost-tracker.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { getCwd } from '../utils/cwd.js'
import { env } from '../utils/env.js'
import { getMercuryHome, isEnvTruthy } from '../utils/envUtils.js'
import { normalizeMessagesForAPI } from '../utils/messages.js'
import { calculateUSDCost } from '../utils/modelCost.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

/**
 * Record/replay of provider responses and token counts as on-disk
 * fixtures. Active ONLY under NODE_ENV=test; in every other case the
 * wrapped function is simply invoked. One of the three fence-listed
 * provider-SDK importers of the slice (the stream-event type above).
 */

type VcrMessage = AssistantMessage | BetaRawMessageStreamEvent | Message

function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test'
}

function fixturesRoot(): string {
  // Fixed to cwd — no fixtures-root env seam.
  return process.cwd()
}

function fixturePath(name: string): string {
  return join(fixturesRoot(), 'fixtures', `${name}.json`)
}

function isRecordingEnabled(): boolean {
  return isEnvTruthy(process.env.VCR_RECORD)
}

// --------------------------------------------------------------------------
// Dehydration / hydration (fixture portability)
// --------------------------------------------------------------------------

const CONFIG_HOME_TOKEN = '[CONFIG_HOME]'
const CWD_TOKEN = '[CWD]'
const NUM_TOKEN = '[NUM]'
const DURATION_TOKEN = '[DURATION]'
const COST_TOKEN = '[COST]'
const COMMANDS_TOKEN = '[COMMANDS]'
const FILES_MODIFIED_TOKEN = '[FILES_MODIFIED_BY_USER]'

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Normalise separators inside a placeholder-rooted path run. */
function normalizePlaceholderPaths(text: string): string {
  return text.replace(
    /(\[(?:CWD|CONFIG_HOME)\])((?:[^\s"'<>])*)/g,
    (whole, token: string, run: string) => token + run.replace(/\\\\|\\/g, '/'),
  )
}

function dehydrateString(text: string): string {
  if (text.includes('files modified by user')) return FILES_MODIFIED_TOKEN
  let out = text
  // Numeric attributes in the product's XML-ish wrappers.
  out = out.replace(/(<[^>]*\bfiles\b[^>]*=")\d+(")/g, `$1${NUM_TOKEN}$2`)
  out = out.replace(/\b\d+ms\b/g, DURATION_TOKEN)
  out = out.replace(/\$\d+(?:\.\d+)?/g, COST_TOKEN)
  out = out.replace(/Available commands:.*$/m, COMMANDS_TOKEN)
  const home = getMercuryHome()
  const cwd = getCwd()
  const substitutions: Array<[string, string]> = [
    [home, CONFIG_HOME_TOKEN],
    [cwd, CWD_TOKEN],
  ]
  if (process.platform === 'win32') {
    substitutions.push(
      [home.replace(/\\/g, '\\\\'), CONFIG_HOME_TOKEN],
      [cwd.replace(/\\/g, '\\\\'), CWD_TOKEN],
      [home.replace(/\\/g, '/'), CONFIG_HOME_TOKEN],
      [cwd.replace(/\\/g, '/'), CWD_TOKEN],
    )
  }
  for (const [needle, token] of substitutions) {
    if (needle) out = out.replace(new RegExp(escapeForRegExp(needle), 'g'), token)
  }
  return normalizePlaceholderPaths(out)
}

function hydrateString(text: string): string {
  return text
    .replace(/\[NUM\]/g, '1')
    .replace(/\[DURATION\]/g, '100')
    .replace(/\[CONFIG_HOME\]/g, getMercuryHome())
    .replace(/\[CWD\]/g, getCwd())
}

function mapStringsDeep(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map(entry => mapStringsDeep(entry, map))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = mapStringsDeep(inner, map)
    }
    return out
  }
  return value
}

// --------------------------------------------------------------------------
// Generic fixture helper (G3)
// --------------------------------------------------------------------------

function isCiEnvironment(): boolean {
  return env.isCI || Boolean(process.env.CI)
}

async function withFixture<T>(fixtureName: string, input: unknown, produce: () => Promise<T>): Promise<T> {
  const hash = createHash('sha1').update(jsonStringify(input) ?? '').digest('hex').slice(0, 12)
  const path = fixturePath(`${fixtureName}-${hash}`)
  try {
    const raw = readFileSync(path, 'utf8')
    return jsonParse(raw) as T
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
  if (isCiEnvironment() && !isRecordingEnabled()) {
    throw new Error(
      `Missing VCR fixture ${path}. Re-run with VCR_RECORD=1 to record it, then commit the result.`,
    )
  }
  const result = await produce()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(result, null, 2))
  return result
}

// --------------------------------------------------------------------------
// Provider-response fixtures (G4–G8)
// --------------------------------------------------------------------------

type LooseBlock = Record<string, unknown>

/** The INPUT mapper — decides the fixture hash; distinct from the output mapper. */
function mapInputContent(content: unknown): unknown {
  if (typeof content === 'string') return dehydrateString(content)
  if (!Array.isArray(content)) return content
  return content.map(block => {
    const record = block as LooseBlock
    if (record.type === 'text') {
      return { ...record, text: dehydrateString(String(record.text ?? '')) }
    }
    if (record.type === 'tool_use') {
      return { ...record, input: mapStringsDeep(record.input, dehydrateString) }
    }
    if (record.type === 'image') return record
    if (record.type === 'tool_result') {
      const inner = record.content
      if (typeof inner === 'string') return { ...record, content: dehydrateString(inner) }
      if (Array.isArray(inner)) {
        return {
          ...record,
          content: inner.map(element => {
            const entry = element as LooseBlock
            if (entry.type === 'image') return entry
            if (entry.type === 'text') {
              return { ...entry, text: dehydrateString(String(entry.text ?? '')) }
            }
            // Every other element type drops to an empty slot — the nulls
            // survive into the hashed serialisation deliberately.
            return null
          }),
        }
      }
      return record
    }
    // Every other block type is an empty slot; a message carrying one
    // hashes differently from one without it.
    return null
  })
}

function fixtureNameFor(messages: Message[]): string {
  const normalized = normalizeMessagesForAPI(
    messages.filter(message => !(message.type === 'user' && (message as { isMeta?: boolean }).isMeta)),
  )
  const hashes = normalized.map(message =>
    createHash('sha1')
      .update(jsonStringify(mapInputContent(message.message.content)) ?? '')
      .digest('hex')
      .slice(0, 6),
  )
  return hashes.join('-')
}

const REQUEST_ID_PLACEHOLDER = '[REQUEST_ID]'

/** The OUTPUT mapper: assistant messages only; everything else untouched. */
function mapOutputMessage(message: VcrMessage, map: (text: string) => string, uuid: string): VcrMessage {
  const record = message as LooseBlock
  if (record.type !== 'assistant') return message
  const inner = record.message as LooseBlock | undefined
  const content = inner?.content
  const mappedContent = Array.isArray(content)
    ? content.map(block => {
        const blockRecord = block as LooseBlock
        if (blockRecord.type === 'text') {
          return {
            ...blockRecord,
            text: map(String(blockRecord.text ?? '')),
            citations: Array.isArray(blockRecord.citations) ? blockRecord.citations : [],
          }
        }
        if (blockRecord.type === 'tool_use') {
          return { ...blockRecord, input: mapStringsDeep(blockRecord.input, map) }
        }
        return blockRecord
      })
    : content
  return {
    ...record,
    requestId: REQUEST_ID_PLACEHOLDER,
    uuid,
    message: inner ? { ...inner, content: mappedContent } : inner,
  } as VcrMessage
}

function addReplayedCost(message: VcrMessage): void {
  const record = message as LooseBlock
  if (record.type !== 'assistant') return
  const inner = record.message as { model?: string; usage?: Record<string, number> } | undefined
  if (!inner?.usage || !inner.model) return
  try {
    const cost = calculateUSDCost(inner.model, inner.usage as never)
    if (cost > 0) addToTotalSessionCost(cost, inner.usage as never, inner.model)
  } catch {
    // Cost accounting must never break a replay.
  }
}

export async function withVCR<T>(
  messages: Message[],
  produce: () => Promise<T[]>,
): Promise<T[]> {
  if (!isTestEnvironment()) return produce()
  const name = fixtureNameFor(messages)
  const path = fixturePath(name)
  try {
    const raw = readFileSync(path, 'utf8')
    const stored = jsonParse(raw) as { input: unknown; output: VcrMessage[] }
    const hydrated = stored.output.map(message =>
      mapOutputMessage(message, hydrateString, randomUUID()),
    )
    for (const message of hydrated) {
      addReplayedCost(message)
    }
    return hydrated as unknown as T[]
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
  if (isCiEnvironment() && !isRecordingEnabled()) {
    throw new Error(
      `Missing VCR fixture ${path}. Re-run with VCR_RECORD=1 to record it, then commit the result.`,
    )
  }
  const live = await produce()
  if (isCiEnvironment() && !isRecordingEnabled()) {
    // Defence in depth: the guard above already threw on this combination.
    return live
  }
  const dehydrated = (live as unknown as VcrMessage[]).map((message, index) =>
    mapOutputMessage(message, dehydrateString, `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`),
  )
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ input: fixtureNameFor(messages), output: dehydrated }, null, 2))
  return live
}

/**
 * G8: buffer everything, route the buffer through the non-streaming path,
 * then yield the cached buffer if non-empty, else the live one. Streaming
 * under fixtures is deliberately not incremental.
 */
export async function* withStreamingVCR<T>(
  messages: Message[],
  produce: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  if (!isTestEnvironment()) {
    yield* produce()
    return
  }
  const buffer: T[] = []
  const cached = await withVCR<T>(messages, async () => {
    for await (const item of produce()) {
      buffer.push(item)
    }
    return buffer
  })
  yield* cached.length > 0 ? cached : buffer
}

// --------------------------------------------------------------------------
// Token-count fixtures (G9)
// --------------------------------------------------------------------------

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

function normalizeTokenCountInput(serialized: string): string {
  const cwdSlug = getCwd().replace(/[^a-zA-Z0-9]/g, '-')
  return dehydrateString(serialized)
    .replace(new RegExp(escapeForRegExp(cwdSlug), 'g'), '[CWD_SLUG]')
    .replace(UUID_PATTERN, '[UUID]')
    .replace(ISO_TIMESTAMP_PATTERN, '[TIMESTAMP]')
}

export async function withTokenCountVCR(
  messages: Message[],
  tools: unknown[],
  produce: () => Promise<number | null>,
): Promise<number | null> {
  if (!isTestEnvironment()) return produce()
  const input = normalizeTokenCountInput(jsonStringify({ messages, tools }) ?? '')
  const wrapped = await withFixture<{ count: number | null }>('token-count', input, async () => ({
    count: await produce(),
  }))
  return wrapped.count
}
