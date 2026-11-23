import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { isENOENT } from '../../platform/errors/errors.js'
import type { AnthropicMessageParams } from './anthropic/anthropicWire.js'
import type { OpenaiResponsesRequest } from './openai/openaiWire.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

type GatewayProbeVerdict =
  | 'block'
  | 'text'
  | 'openai-native'

interface GatewayProbeRecord {
  verdict: GatewayProbeVerdict
  evidence: string
  status: number | null
  probedAt: string
}

interface ProbeStoreFile {
  version: 1
  hosts: Record<string, GatewayProbeRecord>
}

const STORE_FILE = 'tool-deferral-probe.json'
const REPROBE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
export const PROBE_BETA_HEADER = 'advanced-tool-use-2025-11-20'


let cache: { path: string; file: ProbeStoreFile } | null = null

function storePath(): string {
  return join(getMercuryHome(), STORE_FILE)
}

function readStore(): ProbeStoreFile {
  const path = storePath()
  if (cache && cache.path === path) return cache.file
  let file: ProbeStoreFile = { version: 1, hosts: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProbeStoreFile>
    if (parsed && parsed.version === 1 && parsed.hosts && typeof parsed.hosts === 'object') {
      file = { version: 1, hosts: { ...parsed.hosts } }
    }
    cache = { path, file }
  } catch (error) {
    if (isENOENT(error)) cache = { path, file }
    else passedOver(error)
  }
  return file
}

function readStoreForWrite(): ProbeStoreFile | null {
  const path = storePath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return { version: 1, hosts: {} }
    passedOver(error)
    logForDebugging(`deferralProbe: existing store at ${path} could not be read (${String(error)}); skipping write`)
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProbeStoreFile>
    if (parsed && parsed.version === 1 && parsed.hosts && typeof parsed.hosts === 'object') {
      return { version: 1, hosts: { ...parsed.hosts } }
    }
    return { version: 1, hosts: {} }
  } catch (error) {
    passedOver(error)
    return { version: 1, hosts: {} }
  }
}

function writeStore(file: ProbeStoreFile): void {
  const path = storePath()
  const tmp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(getMercuryHome(), { recursive: true })
    writeFileSync(tmp, JSON.stringify(file, null, 2))
    renameSync(tmp, path)
  } catch (error) {
    passedOver(error)
    try {
      unlinkSync(tmp)
    } catch (cleanupError) {
      passedOver(cleanupError)
    }
  }
  cache = { path, file }
}

export function readGatewayProbeVerdict(host: string, now: () => number = Date.now): GatewayProbeVerdict | undefined {
  const record = readStore().hosts[host]
  if (!record) return undefined
  const at = Date.parse(record.probedAt)
  if (Number.isFinite(at) && now() - at > REPROBE_AFTER_MS) return undefined
  return record.verdict
}

export function readGatewayProbeRecord(host: string): GatewayProbeRecord | undefined {
  return readStore().hosts[host]
}

export function recordGatewayProbe(host: string, record: GatewayProbeRecord): void {
  const file = readStoreForWrite()
  if (file === null) return
  writeStore({ version: 1, hosts: { ...file.hosts, [host]: record } })
}
export function _resetGatewayProbeStoreForTesting(): void {
  cache = null
}


export function gatewayProbeBody(model: string): AnthropicMessageParams {
  return {
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'probe' }],
    tools: [
      {
        name: 'deferral_probe',
        description: 'A probe of the deferral wire form; never called.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        defer_loading: true,
      },
    ],
  }
}

export interface GatewayProbeAnswer {
  status: number | null
  bodyText: string
}

type GatewayProbeClassification =
  | { kind: 'verdict'; verdict: GatewayProbeVerdict; evidence: string }
  | { kind: 'indeterminate'; reason: 'auth-refused' | 'unreachable' | 'other-status'; evidence: string }

const SHAPE_REFUSAL = /defer_loading|tool_reference|advanced-tool-use|anthropic-beta|beta/i

function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim() !== '') ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

export function classifyGatewayProbe(answer: GatewayProbeAnswer): GatewayProbeClassification {
  const { status, bodyText } = answer
  const evidence = status === null ? `no reply: ${firstLine(bodyText)}` : `http ${status}: ${firstLine(bodyText)}`
  if (status === null) return { kind: 'indeterminate', reason: 'unreachable', evidence }
  if (status >= 200 && status < 300) return { kind: 'verdict', verdict: 'block', evidence }
  if (status === 400 && SHAPE_REFUSAL.test(bodyText)) return { kind: 'verdict', verdict: 'text', evidence }
  if (status === 401 || status === 403) return { kind: 'indeterminate', reason: 'auth-refused', evidence }
  return { kind: 'indeterminate', reason: 'other-status', evidence }
}


export function gatewayProbePolicyAllows(env: Record<string, string | undefined> = hostEnv()): boolean {
  if (flagEnv('MERCURY_TOOL_DEFER_PROBE') !== '1') return false
  const traffic = flagEnv('MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', env)
  if (traffic !== undefined && traffic !== '' && traffic !== '0' && traffic.toLowerCase() !== 'false') return false
  return true
}

const inFlight = new Map<string, Promise<GatewayProbeClassification>>()
const attempted = new Set<string>()

export async function ensureGatewayProbe(
  host: string,
  send: (body: AnthropicMessageParams, betaHeader: string) => Promise<GatewayProbeAnswer>,
  model: string,
): Promise<GatewayProbeClassification | null> {
  if (attempted.has(host)) {
    const running = inFlight.get(host)
    return running ? running : null
  }
  attempted.add(host)
  const work = (async (): Promise<GatewayProbeClassification> => {
    let answer: GatewayProbeAnswer
    try {
      answer = await send(gatewayProbeBody(model), PROBE_BETA_HEADER)
    } catch (error) {
      answer = { status: null, bodyText: error instanceof Error ? error.message : String(error) }
    }
    const classification = classifyGatewayProbe(answer)
    if (classification.kind === 'verdict') {
      recordGatewayProbe(host, {
        verdict: classification.verdict,
        evidence: classification.evidence,
        status: answer.status,
        probedAt: new Date().toISOString(),
      })
    }
    return classification
  })()
  inFlight.set(host, work)
  try {
    return await work
  } finally {
    inFlight.delete(host)
  }
}

export function _resetGatewayProbeFlightsForTesting(): void {
  inFlight.clear()
  attempted.clear()
}

const OPENAI_GATEWAY_PROBE_KEY_PREFIX = 'openai:'

export const OPENAI_FIRST_PARTY_PROBE_KEY = `${OPENAI_GATEWAY_PROBE_KEY_PREFIX}first-party`

export function openaiGatewayProbeKey(host: string): string {
  return `${OPENAI_GATEWAY_PROBE_KEY_PREFIX}${host}`
}

export const OPENAI_NATIVE_DEFERRAL_REFUSAL = /defer_loading|tool_search/i

export function openaiGatewayProbeBody(model: string): OpenaiResponsesRequest {
  return {
    model,
    instructions: 'Reply with the single word ok.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'probe' }] }],
    tools: [
      {
        type: 'function',
        name: 'deferral_probe',
        description: 'A probe of the deferral wire form; never called.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        defer_loading: true,
      },
      { type: 'tool_search' },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: false,
    stream: true,
  }
}

export function classifyOpenaiGatewayProbe(answer: GatewayProbeAnswer): GatewayProbeClassification {
  const { status, bodyText } = answer
  const evidence = status === null ? `no reply: ${firstLine(bodyText)}` : `http ${status}: ${firstLine(bodyText)}`
  if (status === null) return { kind: 'indeterminate', reason: 'unreachable', evidence }
  if (status >= 200 && status < 300) return { kind: 'verdict', verdict: 'openai-native', evidence }
  if (status === 400 && OPENAI_NATIVE_DEFERRAL_REFUSAL.test(bodyText)) return { kind: 'verdict', verdict: 'text', evidence }
  if (status === 401 || status === 403) return { kind: 'indeterminate', reason: 'auth-refused', evidence }
  return { kind: 'indeterminate', reason: 'other-status', evidence }
}

export async function ensureOpenaiGatewayProbe(
  host: string,
  send: (body: OpenaiResponsesRequest) => Promise<GatewayProbeAnswer>,
  model: string,
): Promise<GatewayProbeClassification | null> {
  const key = openaiGatewayProbeKey(host)
  if (attempted.has(key)) {
    const running = inFlight.get(key)
    return running ? running : null
  }
  attempted.add(key)
  const work = (async (): Promise<GatewayProbeClassification> => {
    let answer: GatewayProbeAnswer
    try {
      answer = await send(openaiGatewayProbeBody(model))
    } catch (error) {
      answer = { status: null, bodyText: error instanceof Error ? error.message : String(error) }
    }
    const classification = classifyOpenaiGatewayProbe(answer)
    if (classification.kind === 'verdict') {
      recordGatewayProbe(key, {
        verdict: classification.verdict,
        evidence: classification.evidence,
        status: answer.status,
        probedAt: new Date().toISOString(),
      })
    }
    return classification
  })()
  inFlight.set(key, work)
  try {
    return await work
  } finally {
    inFlight.delete(key)
  }
}
