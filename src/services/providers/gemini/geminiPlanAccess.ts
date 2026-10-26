import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { antigravityUserAgent } from './antigravityClientContract.js'

const ANTIGRAVITY_CODE_ASSIST_BASES = ['https://daily-cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.sandbox.googleapis.com'] as const
const ANTIGRAVITY_CODE_ASSIST_VERSION = 'v1internal'
const ANTIGRAVITY_CLIENT_METADATA = Object.freeze({ ideType: 'ANTIGRAVITY' })
const GEMINI_PLAN_FREE_TIER_ID = 'free-tier'
const GEMINI_PLAN_CALL_DEADLINE_MS = 15_000
const GEMINI_PLAN_ONBOARD_DEADLINE_MS = 30_000
const GEMINI_PLAN_ONBOARD_POLL_MS = 1_000
const ANSWER_MAX_BYTES = 1024 * 1024
const ERROR_BODY_LIMIT = 600

interface GeminiPlanTier {
  id?: string
  name?: string
  description?: string
}

interface GeminiPlanIneligibleTier {
  tierId?: string
  reasonMessage?: string
  validationUrl?: string
}

interface GeminiPlanAccessAnswer {
  currentTier?: GeminiPlanTier
  paidTier?: GeminiPlanTier
  allowedTiers: GeminiPlanTier[]
  ineligibleTiers: GeminiPlanIneligibleTier[]
  projectId?: string
}

export interface GeminiPlanTierFacts {
  current?: GeminiPlanTier
  paid?: GeminiPlanTier
}

interface GeminiPlanRosterQuota {
  remainingFraction?: number
  resetTime?: string
}

interface GeminiPlanRosterModel {
  id: string
  displayName?: string
  supportsThinking?: boolean
  supportsImages?: boolean
  recommended?: boolean
  maxTokens?: number
  maxOutputTokens?: number
  quota?: GeminiPlanRosterQuota
}

export interface GeminiPlanRoster {
  models: GeminiPlanRosterModel[]
  imageModelIds: string[]
  endpoint: string
  fetchedAtMs: number
}

interface GeminiPlanIo {
  accessToken: string
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  userAgent?: string
}

export class GeminiPlanHttpError extends Error {
  readonly status: number
  readonly body: string
  readonly method: string
  constructor(method: string, status: number, body: string) {
    super(
      status === 401 || status === 403
        ? `Google's Code Assist endpoint refused the sign-in at ${method} (HTTP ${status})${body ? `: ${body}` : ''}`
        : `Google's Code Assist endpoint answered ${method} with HTTP ${status}${body ? `: ${body}` : ''}`,
    )
    this.name = 'GeminiPlanHttpError'
    this.status = status
    this.body = body
    this.method = method
  }
}

class GeminiPlanIneligibleError extends Error {
  readonly reasonMessage: string
  readonly validationUrl: string | undefined
  constructor(reasonMessage: string, validationUrl: string | undefined) {
    super(validationUrl ? `${reasonMessage} — ${validationUrl}` : reasonMessage)
    this.name = 'GeminiPlanIneligibleError'
    this.reasonMessage = reasonMessage
    this.validationUrl = validationUrl
  }
}

export function antigravityCodeAssistBases(env: NodeJS.ProcessEnv = process.env): string[] {
  const pinned = (env === process.env ? flagEnv('MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE') : env['MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE'])?.trim()
  if (pinned && /^https?:\/\//i.test(pinned)) return [pinned.replace(/\/+$/, '')]
  return [...ANTIGRAVITY_CODE_ASSIST_BASES]
}

function codeAssistMethodUrl(base: string, method: string): string {
  return `${base}/${ANTIGRAVITY_CODE_ASSIST_VERSION}:${method}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function tier(value: unknown): GeminiPlanTier | undefined {
  const raw = record(value)
  if (!raw) return undefined
  return {
    ...(str(raw.id) !== undefined ? { id: str(raw.id)! } : {}),
    ...(str(raw.name) !== undefined ? { name: str(raw.name)! } : {}),
    ...(str(raw.description) !== undefined ? { description: str(raw.description)! } : {}),
  }
}

function decodeLoadCodeAssist(value: unknown): GeminiPlanAccessAnswer {
  const raw = record(value) ?? {}
  const current = tier(raw.currentTier)
  const paid = tier(raw.paidTier)
  const allowed = Array.isArray(raw.allowedTiers) ? raw.allowedTiers.map(tier).filter((t): t is GeminiPlanTier => t !== undefined) : []
  const ineligible = Array.isArray(raw.ineligibleTiers)
    ? raw.ineligibleTiers.map(entry => {
        const row = record(entry)
        if (!row) return undefined
        return {
          ...(str(row.tierId) !== undefined ? { tierId: str(row.tierId)! } : {}),
          ...(str(row.reasonMessage) !== undefined ? { reasonMessage: str(row.reasonMessage)! } : {}),
          ...(str(row.validationUrl) !== undefined ? { validationUrl: str(row.validationUrl)! } : {}),
        } as GeminiPlanIneligibleTier
      }).filter((t): t is GeminiPlanIneligibleTier => t !== undefined)
    : []
  return {
    ...(current ? { currentTier: current } : {}),
    ...(paid ? { paidTier: paid } : {}),
    allowedTiers: allowed,
    ineligibleTiers: ineligible,
    ...(str(raw.cloudaicompanionProject) !== undefined ? { projectId: str(raw.cloudaicompanionProject)! } : {}),
  }
}

function quotaOf(value: unknown): GeminiPlanRosterQuota | undefined {
  const first = Array.isArray(value) ? value[0] : value
  const raw = record(first)
  if (!raw) return undefined
  const fraction = num(raw.remainingFraction)
  const reset = str(raw.resetTime)
  if (fraction === undefined && reset === undefined) return undefined
  return {
    ...(fraction !== undefined ? { remainingFraction: Math.min(1, Math.max(0, fraction)) } : {}),
    ...(reset !== undefined ? { resetTime: reset } : {}),
  }
}

function decodeFetchAvailableModels(value: unknown): { models: GeminiPlanRosterModel[]; imageModelIds: string[] } | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const table = record(raw.models)
  if (!table) return undefined
  const models: GeminiPlanRosterModel[] = []
  for (const [id, entry] of Object.entries(table)) {
    const row = record(entry)
    if (!row || id.trim() === '' || row.isInternal === true) continue
    const quota = quotaOf(row.quotaInfo ?? row.quotaInfos)
    models.push({
      id,
      ...(str(row.displayName) !== undefined ? { displayName: str(row.displayName)! } : {}),
      ...(typeof row.supportsThinking === 'boolean' ? { supportsThinking: row.supportsThinking } : {}),
      ...(typeof row.supportsImages === 'boolean' ? { supportsImages: row.supportsImages } : {}),
      ...(typeof row.recommended === 'boolean' ? { recommended: row.recommended } : {}),
      ...(num(row.maxTokens) !== undefined && num(row.maxTokens)! > 0 ? { maxTokens: num(row.maxTokens)! } : {}),
      ...(num(row.maxOutputTokens) !== undefined && num(row.maxOutputTokens)! > 0 ? { maxOutputTokens: num(row.maxOutputTokens)! } : {}),
      ...(quota ? { quota } : {}),
    })
  }
  const imageModelIds = Array.isArray(raw.imageGenerationModelIds) ? raw.imageGenerationModelIds.filter((id): id is string => typeof id === 'string' && id !== '') : []
  return { models, imageModelIds }
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > ANSWER_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`Google's Code Assist answer ran past ${ANSWER_MAX_BYTES / 1024} KiB`)
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function codeAssistCall(io: GeminiPlanIo, base: string, method: string, body: Record<string, unknown> | undefined, httpMethod: 'POST' | 'GET', path?: string): Promise<unknown> {
  const url = path !== undefined ? `${base}/${ANTIGRAVITY_CODE_ASSIST_VERSION}/${path}` : codeAssistMethodUrl(base, method)
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'gemini', GEMINI_PLAN_CALL_DEADLINE_MS, url, {
      method: httpMethod,
      headers: {
        authorization: `Bearer ${io.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': io.userAgent ?? antigravityUserAgent(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(io.fetchImpl ? {} : (getProxyFetchOptions() as Record<string, unknown>)),
    } as RequestInit)
  } catch (error) {
    throw new Error(`Google's Code Assist endpoint did not answer ${method} (${new URL(url).host}): ${errorMessageWithCause(error)}`)
  }
  if (!response.ok) {
    const text = (await boundedText(response).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_LIMIT)
    throw new GeminiPlanHttpError(method, response.status, text)
  }
  const text = await boundedText(response)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`Google's Code Assist endpoint answered ${method} with something other than JSON`)
  }
}

function transient(error: unknown): boolean {
  if (error instanceof GeminiPlanHttpError) return error.status === 429 || error.status >= 500
  return !(error instanceof GeminiPlanIneligibleError)
}

async function overBases<T>(io: GeminiPlanIo, work: (base: string) => Promise<T>): Promise<{ answer: T; base: string }> {
  const bases = antigravityCodeAssistBases(io.env ?? process.env)
  let last: unknown
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i]!
    try {
      return { answer: await work(base), base }
    } catch (error) {
      last = error
      if (i === bases.length - 1 || !transient(error)) throw error
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

async function loadGeminiPlanAccess(io: GeminiPlanIo, projectId?: string): Promise<GeminiPlanAccessAnswer> {
  const body = { ...(projectId !== undefined ? { cloudaicompanionProject: projectId } : {}), metadata: ANTIGRAVITY_CLIENT_METADATA }
  const { answer } = await overBases(io, base => codeAssistCall(io, base, 'loadCodeAssist', body, 'POST'))
  return decodeLoadCodeAssist(answer)
}

async function onboardGeminiPlanFreeTier(io: GeminiPlanIo): Promise<void> {
  const now = io.now ?? Date.now
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const deadline = now() + GEMINI_PLAN_ONBOARD_DEADLINE_MS
  const { answer: first, base } = await overBases(io, b => codeAssistCall(io, b, 'onboardUser', { tierId: GEMINI_PLAN_FREE_TIER_ID, metadata: ANTIGRAVITY_CLIENT_METADATA }, 'POST'))
  let operation = record(first) ?? {}
  for (;;) {
    if (operation.done === true) {
      const failure = record(operation.error)
      if (failure) throw new Error(`Google could not provision the free tier: ${str(failure.message) ?? JSON.stringify(failure)}`)
      if (record(operation.response) === undefined) throw new Error('Google answered the free-tier provisioning without a result')
      return
    }
    const remaining = deadline - now()
    if (remaining <= 0) throw new Error(`Google's free-tier provisioning did not finish within ${GEMINI_PLAN_ONBOARD_DEADLINE_MS / 1000} s — sign in again in a moment`)
    await sleep(Math.min(GEMINI_PLAN_ONBOARD_POLL_MS, remaining))
    const name = str(operation.name)
    if (name === undefined) throw new Error('Google answered the free-tier provisioning without an operation name')
    operation = record(await codeAssistCall(io, base, 'onboardUser operation', undefined, 'GET', name)) ?? {}
  }
}

function geminiPlanIneligibility(answer: GeminiPlanAccessAnswer): GeminiPlanIneligibleError | undefined {
  if (answer.allowedTiers.some(t => t.id === GEMINI_PLAN_FREE_TIER_ID)) return undefined
  const blocked = answer.ineligibleTiers.find(t => t.tierId === GEMINI_PLAN_FREE_TIER_ID && t.reasonMessage !== undefined)
  if (!blocked) return undefined
  return new GeminiPlanIneligibleError(blocked.reasonMessage!, blocked.validationUrl)
}

export async function discoverGeminiPlan(io: GeminiPlanIo): Promise<{ projectId: string; tier: GeminiPlanTierFacts }> {
  let answer = await loadGeminiPlanAccess(io)
  if (answer.paidTier === undefined && answer.projectId !== undefined) answer = await loadGeminiPlanAccess(io, answer.projectId)
  const ineligible = geminiPlanIneligibility(answer)
  if (ineligible) throw ineligible
  if (answer.currentTier === undefined) {
    await onboardGeminiPlanFreeTier(io)
    answer = await loadGeminiPlanAccess(io)
    if (answer.paidTier === undefined && answer.projectId !== undefined) answer = await loadGeminiPlanAccess(io, answer.projectId)
  }
  if (answer.projectId === undefined) throw new Error('Google named no Code Assist project for this account — sign in again, or use an API key')
  return {
    projectId: answer.projectId,
    tier: { ...(answer.currentTier ? { current: answer.currentTier } : {}), ...(answer.paidTier ? { paid: answer.paidTier } : {}) },
  }
}

export async function fetchGeminiPlanRoster(io: GeminiPlanIo): Promise<GeminiPlanRoster> {
  const { answer, base } = await overBases(io, b => codeAssistCall(io, b, 'fetchAvailableModels', {}, 'POST'))
  const decoded = decodeFetchAvailableModels(answer)
  if (!decoded) throw new Error('Google answered the model roster without a models table')
  return { ...decoded, endpoint: base, fetchedAtMs: (io.now ?? Date.now)() }
}

export function geminiPlanTierWords(tier: GeminiPlanTierFacts | undefined): string {
  if (!tier) return 'tier unknown'
  if (tier.paid?.name) return tier.paid.name
  if (tier.paid?.id) return tier.paid.id
  const id = tier.current?.id
  if (id === GEMINI_PLAN_FREE_TIER_ID) return 'free'
  if (id === 'standard-tier') return 'a Code Assist licence'
  if (id === 'legacy-tier') return 'a Code Assist licence (legacy)'
  return tier.current?.name ?? id ?? 'tier unknown'
}
