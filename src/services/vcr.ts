import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { flagEnv } from '../substrate/flagRegistry.js'
import type { ApiStreamEvent as BetaRawMessageStreamEvent } from '../types/wire.js'

import { addToTotalSessionCost } from '../cost-tracker.js'
import type { AssistantMessage, Message, StreamEvent } from '../types/message.js'
import { getCwd } from '../utils/cwd.js'
import { env } from '../utils/env.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { normalizeMessagesForAPI } from './messages.js'
import { calculateUSDCost } from './usage/modelCost.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { passedOver } from '../utils/passedOver.js'
import { hostEnv } from '../utils/hostEnv.js'


type VcrMessage = AssistantMessage | BetaRawMessageStreamEvent | Message | StreamEvent

function isTestEnvironment(): boolean {
  return hostEnv().NODE_ENV === 'test'
}

function fixturesRoot(): string {
  return process.cwd()
}

function fixturePath(name: string): string {
  return join(fixturesRoot(), 'fixtures', `${name}.json`)
}


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

function normalizePlaceholderPaths(text: string): string {
  return text.replace(
    /(\[(?:CWD|CONFIG_HOME)\])((?:[^\s"'<>])*)/g,
    (whole, token: string, run: string) => token + run.replace(/\\\\|\\/g, '/'),
  )
}

function dehydrateString(text: string): string {
  if (text.includes('files modified by user')) return FILES_MODIFIED_TOKEN
  let out = text
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


function isCiEnvironment(): boolean {
  return env.isCI || Boolean(hostEnv().CI)
}

function recordsFixtures(): boolean {
  return flagEnv('MERCURY_VCR_RECORD') === '1'
}

async function withFixture<T>(
  name: string,
  input: unknown,
  produce: () => Promise<T>,
): Promise<T> {
  const hash = createHash('sha1')
    .update(jsonStringify(input) ?? '')
    .digest('hex')
    .slice(0, 12)
  const path = fixturePath(`${name}-${hash}`)
  try {
    const raw = readFileSync(path, 'utf8')
    return jsonParse(raw) as T
  } catch (err) {
    if (!isENOENT(err)) throw err
  }
  if (isCiEnvironment()) {
    throw new Error(
      `Missing VCR fixture ${path}. this build does not record fixtures.`,
    )
  }
  const result = await produce()
  if (recordsFixtures()) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, jsonStringify(result, null, 2))
  }
  return result
}
type LooseBlock = Record<string, unknown>

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
            return null
          }),
        }
      }
      return record
    }
    return null
  })
}

function fixtureNameFor(messages: Message[]): string {
  const visible = messages.filter(message => !(message.type === 'user' && message.isMeta))
  const normalized = normalizeMessagesForAPI(visible)
  return normalized
    .map(message => {
      const mapped = mapInputContent(message.message.content)
      return createHash('sha1')
        .update(jsonStringify(mapped) ?? '')
        .digest('hex')
        .slice(0, 6)
    })
    .join('-')
}

const REQUEST_ID_PLACEHOLDER = '[REQUEST_ID]'

function mapOutputMessage<T extends VcrMessage>(message: T, map: (text: string) => string, uuid: string): T {
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
  } as T
}

function addReplayedCost(message: VcrMessage): void {
  if (message.type !== 'assistant') return
  const inner = message.message
  if (!inner?.usage || !inner.model) return
  try {
    const cost = calculateUSDCost(inner.model, inner.usage)
    if (cost > 0) addToTotalSessionCost(cost, inner.usage, inner.model)
  } catch (error) {
    passedOver(error)
  }
}

export async function withVCR<T extends VcrMessage>(
  messages: Message[],
  produce: () => Promise<T[]>,
): Promise<T[]> {
  if (!isTestEnvironment()) return produce()
  const name = fixtureNameFor(messages)
  const path = fixturePath(name)
  try {
    const raw = readFileSync(path, 'utf8')
    const stored = jsonParse(raw) as { input: unknown; output: T[] }
    const hydrated = stored.output.map(message =>
      mapOutputMessage(message, hydrateString, randomUUID()),
    )
    for (const message of hydrated) {
      addReplayedCost(message)
    }
    return hydrated
  } catch (err) {
    if (!isENOENT(err)) throw err
  }
  if (isCiEnvironment()) {
    throw new Error(
      `Missing VCR fixture ${path}. this build does not record fixtures.`,
    )
  }
  const live = await produce()
  if (!recordsFixtures()) return live
  const dehydrated = live.map((message, index) =>
    mapOutputMessage(message, dehydrateString, `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`),
  )
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ input: fixtureNameFor(messages), output: dehydrated }, null, 2))
  return live
}

export async function* withStreamingVCR<T extends VcrMessage>(
  messages: Message[],
  produce: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  if (!isTestEnvironment()) {
    yield* produce()
    return
  }
  const collected: T[] = []
  const cached = await withVCR(messages, async () => {
    for await (const event of produce()) {
      collected.push(event)
    }
    return collected
  })
  const toYield = cached.length > 0 ? cached : collected
  for (const event of toYield) {
    yield event
  }
}

function normalizeTokenCountInput(text: string): string {
  let out = dehydrateString(text)
  const cwdSlug = getCwd().replace(/[^a-zA-Z0-9]/g, '-')
  if (cwdSlug) {
    out = out.replace(new RegExp(escapeForRegExp(cwdSlug), 'g'), '[CWD_SLUG]')
  }
  out = out.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '[UUID]',
  )
  out = out.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
    '[TIMESTAMP]',
  )
  return out
}

export async function withTokenCountVCR(
  messages: Message[],
  tools: unknown[],
  system: readonly unknown[] | undefined,
  produce: () => Promise<number | null>,
): Promise<number | null> {
  if (!isTestEnvironment()) return produce()
  const payload = system !== undefined ? { messages, tools, system } : { messages, tools }
  const serialized = jsonStringify(payload) ?? ''
  const normalized = normalizeTokenCountInput(serialized)
  const result = await withFixture('token-count', normalized, async () => ({
    count: await produce(),
  }))
  return result.count
}
