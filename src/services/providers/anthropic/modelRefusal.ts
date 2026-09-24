import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeAnthropicClientContract } from '../../../constants/oauth.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { logForDebugging } from '../../../utils/debug.js'
import { clientContractGateText } from '../../api/clientContractGate.js'
import { clientContractHealOf, clientContractStory, type ClientContractSource } from '../../api/clientContractLearned.js'
import { classifyAnthropicRefusal } from '../anthropicRefusal.js'
import { classifyCredentialWall } from '../credentialWall.js'

export type ModelRefusalKind = 'contract-floor' | 'tier' | 'not-served'

export interface ModelRefusal {
  id: string
  door: string
  kind: ModelRefusalKind
  words: string
  seenAtMs: number
}

export interface ModelRefusalFacts {
  status?: number | undefined
  errorType?: string | undefined
  wireText: string
  model: string
  door: string
  subscriber: boolean
  presented: string
  presentedSource?: ClientContractSource | undefined
  contractStory?: string | undefined
  seenAtMs: number
}

export interface ClassifiedModelRefusal extends ModelRefusal {
  status: number
  floor?: string
  read?: string
  presented?: string
  presentedSource?: ClientContractSource
  contractStory?: string
}

export function modelRefusalId(id: string): string {
  const { normalizeModelStringForAPI } =
    require('../../../utils/model/model.js') as typeof import('../../../utils/model/model.js')
  return normalizeModelStringForAPI(id).trim().toLowerCase()
}

export { clientContractGateText }

export function modelRefusalErrorType(error: unknown): string | undefined {
  const body = (error as { error?: { type?: unknown; error?: { type?: unknown } } } | null)?.error
  const type = body?.error?.type ?? body?.type
  return typeof type === 'string' ? type : undefined
}

export function activeModelRefusalDoor(): string | undefined {
  try {
    const { anthropicCredentialPresence } =
      require('../providerUsage.js') as typeof import('../providerUsage.js')
    return anthropicCredentialPresence().credentialLabel
  } catch {
    return undefined
  }
}

export function modelRefusalFix(refusal: Pick<ClassifiedModelRefusal, 'kind' | 'floor'>): string {
  if (refusal.kind === 'contract-floor') {
    return `set MERCURY_ANTHROPIC_CLIENT_CONTRACT=${refusal.floor ?? '<version>'} and restart Mercury, or pick another model with /model`
  }
  if (refusal.kind === 'tier') return 'pick another model with /model, or run /logout then /logins after a plan change'
  return 'pick a listed model with /model'
}

export function modelRefusalSentence(refusal: ClassifiedModelRefusal): string {
  const { renderModelName } =
    require('../../../utils/model/model.js') as typeof import('../../../utils/model/model.js')
  const name = renderModelName(refusal.id)
  if (refusal.kind === 'contract-floor') {
    const presents = refusal.contractStory ?? `Mercury presents ${refusal.presented}${refusal.presentedSource !== undefined ? ` (${refusal.presentedSource})` : ''}`
    return `${name} is refused on ${refusal.door}: it needs ${refusal.floor ? `client version ${refusal.floor}` : 'a newer client version'} and ${presents} — ${modelRefusalFix(refusal)}.`
  }
  if (refusal.kind === 'tier') {
    return `${name} is not available on the tier for ${refusal.door} — ${modelRefusalFix(refusal)}.`
  }
  return `${name} is not served on ${refusal.door} (the endpoint answered ${refusal.status}) — ${modelRefusalFix(refusal)}.`
}

function withWords(refusal: ClassifiedModelRefusal): ClassifiedModelRefusal {
  return { ...refusal, words: modelRefusalSentence(refusal) }
}

export interface ModelRefusalRequest {
  id: string
  door: string
  home: string
  subscriber: boolean
  presented: string
  source?: ClientContractSource
}

export function captureModelRefusalRequest(model: string): ModelRefusalRequest {
  const { isClaudeAISubscriber } = require('../../../utils/auth.js') as typeof import('../../../utils/auth.js')
  const contract = describeAnthropicClientContract()
  return {
    id: modelRefusalId(model),
    door: activeModelRefusalDoor() ?? 'an unknown door',
    home: getAuthConfigHomeDir(),
    subscriber: isClaudeAISubscriber(),
    presented: contract.presented,
    source: contract.source,
  }
}

export function modelRefusalFromError(error: unknown, model: string, request = captureModelRefusalRequest(model)): ClassifiedModelRefusal | null {
  const record = error as { status?: number; message?: string } | null
  const heal = clientContractHealOf(error)
  return classifyModelRefusal({
    status: record?.status,
    errorType: modelRefusalErrorType(error),
    wireText: record?.message ?? '',
    model: request.id,
    door: request.door,
    subscriber: request.subscriber,
    presented: request.presented,
    presentedSource: request.source,
    contractStory: heal === undefined ? undefined : clientContractStory(heal),
    seenAtMs: Date.now(),
  })
}

export function classifyModelRefusal(facts: ModelRefusalFacts): ClassifiedModelRefusal | null {
  const { status, wireText, errorType } = facts
  if (status !== 400 && status !== 403 && status !== 404) return null
  if (classifyAnthropicRefusal({ status, wireText }) !== 'other') return null
  if (classifyCredentialWall(status, wireText) !== undefined) return null
  const credentialFailure = /\b(?:token|credentials?|key)\b[^.{}"]{0,40}?\b(?:expired|invalid|missing|disabled)\b|\b(?:expired|invalid|missing|disabled)\b[^.{}"]{0,40}?\b(?:token|credentials?|key)\b/i.test(wireText)
  if (status === 403 && (errorType === 'authentication_error' || credentialFailure)) return null
  const id = modelRefusalId(facts.model)
  const base = { id, door: facts.door, words: '', seenAtMs: facts.seenAtMs, status, presented: facts.presented }
  if (id === '' || facts.door.trim() === '') return null
  if (status === 400 && clientContractGateText(wireText)) {
    const floor = /version (\d+(?:\.\d+)+) or newer is required/.exec(wireText)?.[1]
    const read = /(\d+(?:\.\d+)+) does not support this model/.exec(wireText)?.[1]
    return withWords({
      ...base,
      kind: 'contract-floor',
      ...(floor !== undefined ? { floor } : {}),
      ...(read !== undefined ? { read } : {}),
      ...(facts.presentedSource !== undefined ? { presentedSource: facts.presentedSource } : {}),
      ...(facts.contractStory !== undefined ? { contractStory: facts.contractStory } : {}),
    })
  }
  if (status === 400 && facts.subscriber && wireText.toLowerCase().includes('invalid model name') && /^(?:claude-opus(?:-|$)|opus$)/.test(id)) {
    return withWords({ ...base, kind: 'tier' })
  }
  const spelledIds: string[] = wireText.toLowerCase().match(/[a-z0-9_/-]+(?:\.[a-z0-9_/-]+)*/g) ?? []
  const named = spelledIds.includes(id)
  if (named && (status === 403 || (status === 404 && errorType === 'not_found_error'))) {
    return withWords({ ...base, kind: 'not-served' })
  }
  return null
}

type StoredModelRefusal = ModelRefusal & { presented: string; floor?: string; read?: string; status?: number }

type ModelRefusalFile = { path: string; row: StoredModelRefusal }

const MAX_MODEL_REFUSALS = 12
const MAX_MODEL_REFUSAL_BYTES = 16_384
let modelRefusalCache: { path: string; stamp: string; files: ModelRefusalFile[] } | null = null

function modelRefusalsDirectory(home = getAuthConfigHomeDir()): string {
  return join(home, 'model-refusals')
}

function modelRefusalKey(refusal: Pick<StoredModelRefusal, 'id' | 'door' | 'presented'>): string {
  return createHash('sha256').update(JSON.stringify([modelRefusalId(refusal.id), refusal.door, refusal.presented])).digest('hex')
}

function storedModelRefusal(value: unknown): value is StoredModelRefusal {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<StoredModelRefusal>
  return typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 256 &&
    typeof row.door === 'string' && row.door.length > 0 && row.door.length <= 256 &&
    (row.kind === 'contract-floor' || row.kind === 'tier' || row.kind === 'not-served') &&
    typeof row.words === 'string' && row.words.length > 0 && row.words.length <= 4096 &&
    typeof row.seenAtMs === 'number' && Number.isFinite(row.seenAtMs) &&
    typeof row.presented === 'string' && /^\d+\.\d+\.\d+$/.test(row.presented) &&
    (row.floor === undefined || (typeof row.floor === 'string' && /^\d+(?:\.\d+)+$/.test(row.floor)))
}

function readModelRefusals(home = getAuthConfigHomeDir()): ModelRefusalFile[] {
  const path = modelRefusalsDirectory(home)
  try {
    const stat = statSync(path)
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`
    if (modelRefusalCache?.path === path && modelRefusalCache.stamp === stamp) return modelRefusalCache.files
    const files: ModelRefusalFile[] = []
    for (const name of readdirSync(path)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const filePath = join(path, name)
      try {
        if (statSync(filePath).size > MAX_MODEL_REFUSAL_BYTES) continue
        const file = JSON.parse(readFileSync(filePath, 'utf8')) as { version?: unknown; refusal?: unknown }
        if (file?.version === 1 && storedModelRefusal(file.refusal) && `${modelRefusalKey(file.refusal)}.json` === name) {
          files.push({ path: filePath, row: file.refusal })
        }
      } catch {
        continue
      }
    }
    files.sort((a, b) => b.row.seenAtMs - a.row.seenAtMs || a.path.localeCompare(b.path))
    modelRefusalCache = { path, stamp, files }
    return files
  } catch {
    return []
  }
}

function removeModelRefusalFile(path: string): void {
  try {
    unlinkSync(path)
    modelRefusalCache = null
  } catch {
    return
  }
}

export function noteModelRefusal(refusal: ModelRefusal, home = getAuthConfigHomeDir()): void {
  const source = refusal as ModelRefusal & Partial<ClassifiedModelRefusal>
  const row: StoredModelRefusal = {
    ...source,
    id: modelRefusalId(refusal.id),
    presented: source.presented ?? describeAnthropicClientContract().presented,
  }
  if (!storedModelRefusal(row)) return
  const key = modelRefusalKey(row)
  const directory = modelRefusalsDirectory(home)
  const path = join(directory, `${key}.json`)
  if (readModelRefusals(home).some(file => file.path === path && file.row.seenAtMs > row.seenAtMs)) return
  const temporary = join(directory, `${key}.${randomUUID()}.tmp`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(temporary, JSON.stringify({ version: 1, refusal: row }) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
    modelRefusalCache = null
    for (const older of readModelRefusals(home).slice(MAX_MODEL_REFUSALS)) removeModelRefusalFile(older.path)
  } catch (error) {
    logForDebugging(`[model-refusals] observation could not be saved: ${String(error)}`)
  } finally {
    removeModelRefusalFile(temporary)
  }
}

export function clearModelRefusal(id: string, door: string, home = getAuthConfigHomeDir(), presented = describeAnthropicClientContract().presented): void {
  const key = modelRefusalKey({ id, door, presented })
  removeModelRefusalFile(join(modelRefusalsDirectory(home), `${key}.json`))
}

export function standingModelRefusals(): readonly ModelRefusal[] {
  const presented = describeAnthropicClientContract().presented
  return readModelRefusals()
    .filter(file => file.row.presented === presented)
    .slice(0, MAX_MODEL_REFUSALS)
    .map(file => ({ ...file.row }))
}

export function modelRefusalWords(id: string): string | undefined {
  const door = activeModelRefusalDoor()
  if (door === undefined) return undefined
  const normalized = modelRefusalId(id)
  return standingModelRefusals()
    .filter(row => row.id === normalized && row.door === door)
    .sort((a, b) => b.seenAtMs - a.seenAtMs)[0]?.words
}
