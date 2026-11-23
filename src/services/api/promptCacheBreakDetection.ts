import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ModelCallReference } from '../../run-core/call-reference.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { passedOver } from '../../utils/passedOver.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  diffPrefixFingerprints,
  fingerprintCacheablePrefix,
  type PrefixFingerprint,
} from './prefixFingerprint.js'

export type CacheLane =
  | 'anthropic'
  | 'openai'
  | 'local'
  | 'openai-compat'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'xai'
  | 'meta'
  | 'gemini'
  | 'mistral'
  | 'minimax'
  | 'cohere'
  | 'qwen'
  | 'openrouter'
  | 'huggingface'
  | 'nous'
  | 'zen'
  | 'together'
  | 'groq'
  | 'melious'
  | 'orcarouter'
  | 'cerebras'
  | 'fireworks'

type PromptStateSnapshot = {
  system: ReadonlyArray<{ text: string; cache_control?: unknown }>
  toolSchemas: ReadonlyArray<{
    name: string
    description?: string
    input_schema?: unknown
    cache_control?: unknown
  }>
  querySource: string
  model: string
  agentId?: string | null
  globalCacheStrategy?: 'tool_based' | 'system_prompt' | 'none'
  betas?: readonly string[]
  flowActive?: boolean
  overageInUse?: boolean
  cachedMicrocompact?: boolean
  effortValue?: string | null
  extraBodyParams?: Record<string, unknown>
  lane?: CacheLane
  callReference?: ModelCallReference
}

type PromptCacheBreakReceipt = {
  at: number
  lane: CacheLane
  querySource: string
  agentId?: string
  model: string
  previousModel?: string
  callCount: number
  cacheReadPrev: number
  cacheReadNow: number
  cacheCreationTokens: number
  reason: string
  classes?: {
    modelChanged: boolean
    systemPromptChanged: boolean
    toolSchemasChanged: boolean
    effortChanged: boolean
    betasChanged: boolean
    cacheControlChanged: boolean
    extraBodyChanged: boolean
    addedTools: string[]
    removedTools: string[]
  }
  callReferenceDigest?: string
  firstPrefixDivergence?: {
    index: number
    kind: string
    aDigest: string
    bDigest: string
  }
  diffPath?: string
}
type PrefixDivergence = {
  index: number
  kind: string
  aDigest: string
  bDigest: string
}

type PendingChanges = {
  modelChanged: boolean
  previousModel: string
  newModel: string
  systemPromptChanged: boolean
  systemTextLengthDelta: number
  toolSchemasChanged: boolean
  addedTools: string[]
  removedTools: string[]
  modifiedTools: string[]
  systemCacheControlChanged: boolean
  cacheStrategyChanged: boolean
  previousStrategy: string
  newStrategy: string
  betasChanged: boolean
  addedBetas: string[]
  removedBetas: string[]
  flowChanged: boolean
  overageChanged: boolean
  cachedMicrocompactChanged: boolean
  effortChanged: boolean
  previousEffort: string
  newEffort: string
  extraBodyChanged: boolean
  previousRenderPrompt: () => string
  firstPrefixDivergence?: PrefixDivergence
}

type LaneState = {
  callCount: number
  lane: CacheLane
  model: string
  systemHash: number
  systemTextLength: number
  systemCacheControlHash: number
  toolSchemasHash: number
  toolNames: string[]
  toolHashes: Map<string, number>
  cacheStrategy: string
  sortedBetas: string[]
  isFlow: boolean
  isUsingOverage: boolean
  hasCachedMicrocompact: boolean
  effortValue: string
  extraBodyHash: number
  callReferenceDigest?: string
  prefixFingerprint: PrefixFingerprint | null
  renderPrompt: () => string
  prevCacheReadTokens: number | null
  expectedCacheDrop: boolean
  pendingChanges: PendingChanges | null
}

const TRACKED_SOURCE_PREFIXES = [
  'main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
] as const

const MAX_LANE_STATES = 10
const MAX_RECEIPTS = 50
const CACHE_DROP_RATIO = 0.95
const MIN_CACHE_DROP_TOKENS = 2000
const FIVE_MINUTES_MS = 5 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const DIFF_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

const laneStates = new Map<string, LaneState>()
const receipts: PromptCacheBreakReceipt[] = []

function resolveStateKey(querySource: string, agentId?: string | null): string | null {
  if (querySource === 'compact') return 'main_thread'
  if (!TRACKED_SOURCE_PREFIXES.some(prefix => querySource.startsWith(prefix))) return null
  return agentId !== undefined && agentId !== null ? agentId : querySource
}

function safeStringify(value: unknown): string {
  const result = jsonStringify(value)
  return result === undefined ? '' : result
}

function fastHash(input: string): number {
  const bunGlobal = (globalThis as { Bun?: { hash?: (data: string) => number | bigint } }).Bun
  if (typeof bunGlobal?.hash === 'function') {
    const hashed = bunGlobal.hash(input)
    return typeof hashed === 'bigint' ? Number(hashed & 0xffffffffn) : hashed >>> 0
  }
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return hash >>> 0
}

function stripCacheControl<T extends { cache_control?: unknown }>(record: T): Omit<T, 'cache_control'> {
  const { cache_control: _dropped, ...rest } = record
  return rest
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function makeLazyRenderer(
  model: string,
  system: ReadonlyArray<{ text: string }>,
  toolSchemas: ReadonlyArray<{ name: string; description?: string; input_schema?: unknown }>,
): () => string {
  const capturedSystem = system.map(block => (typeof block.text === 'string' ? block.text : ''))
  const capturedTools = toolSchemas.map(tool => ({
    name: typeof tool.name === 'string' ? tool.name : '[non-string-name]',
    description: typeof tool.description === 'string' ? tool.description : '',
    schema: tool.input_schema !== undefined ? safeStringify(tool.input_schema) : '',
  }))
  let cached: string | null = null
  return () => {
    if (cached !== null) return cached
    const sortedTools = [...capturedTools].sort((a, b) => a.name.localeCompare(b.name))
    const lines: string[] = [
      `model: ${model}`,
      '',
      capturedSystem.join('\n\n'),
      '',
      `## tools (${sortedTools.length})`,
    ]
    for (const tool of sortedTools) {
      lines.push('', `### ${tool.name}`, tool.description, tool.schema)
    }
    cached = lines.join('\n')
    return cached
  }
}

function randomDiffId(): string {
  const bytes = randomBytes(4)
  let out = ''
  for (let i = 0; i < 4; i++) {
    out += DIFF_ID_ALPHABET[bytes[i]! % DIFF_ID_ALPHABET.length]
  }
  return out
}

function latestAssistantAgeMs(messages: readonly Message[], now: number): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type === 'assistant') {
      const ts = msg.timestamp
      if (typeof ts !== 'string' || ts === '') return null
      const parsed = Date.parse(ts)
      return Number.isFinite(parsed) ? now - parsed : null
    }
  }
  return null
}

function formatPendingReason(pending: PendingChanges): string {
  const parts: string[] = []
  if (pending.modelChanged) {
    parts.push(`model changed (${pending.previousModel} → ${pending.newModel})`)
  }
  if (pending.systemPromptChanged) {
    const delta = pending.systemTextLengthDelta
    parts.push(
      delta !== 0
        ? `system prompt changed (${delta > 0 ? '+' : ''}${delta} chars)`
        : 'system prompt changed',
    )
  }
  if (pending.toolSchemasChanged) {
    if (pending.addedTools.length > 0 || pending.removedTools.length > 0) {
      parts.push(`tools changed (+${pending.addedTools.length}/-${pending.removedTools.length} tools)`)
    } else {
      parts.push('tools changed (tool prompt/schema changed, same tool set)')
    }
  }
  if (pending.cacheStrategyChanged) {
    parts.push(`global cache strategy changed (${pending.previousStrategy || 'none'} → ${pending.newStrategy || 'none'})`)
  }
  if (pending.systemCacheControlChanged && !pending.cacheStrategyChanged && !pending.systemPromptChanged) {
    parts.push('cache_control changed (scope or TTL)')
  }
  if (pending.betasChanged) {
    const groups: string[] = []
    if (pending.addedBetas.length > 0) groups.push(pending.addedBetas.map(b => `+${b}`).join(','))
    if (pending.removedBetas.length > 0) groups.push(pending.removedBetas.map(b => `-${b}`).join(','))
    parts.push(groups.length > 0 ? `betas changed (${groups.join(' ')})` : 'betas changed')
  }
  if (pending.flowChanged) {
    parts.push('flow toggled')
  }
  if (pending.overageChanged) {
    parts.push('overage state changed (TTL latched, no flip)')
  }
  if (pending.cachedMicrocompactChanged) {
    parts.push('cached microcompact toggled')
  }
  if (pending.effortChanged) {
    parts.push(`effort changed (${pending.previousEffort || 'default'} → ${pending.newEffort || 'default'})`)
  }
  if (pending.extraBodyChanged) {
    parts.push('extra body params changed')
  }
  return parts.join(', ')
}

function formatUnchangedReason(ageMs: number | null): string {
  if (ageMs === null) return 'unknown cause'
  if (ageMs > ONE_HOUR_MS) return 'possible 1h TTL expiry (prompt unchanged)'
  if (ageMs > FIVE_MINUTES_MS) return 'possible 5min TTL expiry (prompt unchanged)'
  return 'likely server-side (prompt unchanged, <5min gap)'
}

async function writeDiffPatch(
  renderBefore: () => string,
  renderAfter: () => string,
): Promise<string | undefined> {
  try {
    const patch = createTwoFilesPatch('prompt-state', 'prompt-state', renderBefore(), renderAfter(), 'before', 'after')
    const dir = join(tmpdir(), 'mercury')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `cache-break-${randomDiffId()}.diff`)
    await writeFile(filePath, patch, 'utf8')
    return filePath
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
    const key = resolveStateKey(snapshot.querySource, snapshot.agentId)
    if (key === null) return

    const lane: CacheLane = snapshot.lane ?? 'anthropic'
    const strippedSystem = snapshot.system.map(stripCacheControl)
    const systemHash = fastHash(safeStringify(strippedSystem))
    const systemCacheControls = snapshot.system.map(block => block.cache_control ?? null)
    const systemCacheControlHash = fastHash(safeStringify(systemCacheControls))
    let systemTextLength = 0
    for (const block of snapshot.system) {
      if (typeof block.text === 'string') systemTextLength += block.text.length
    }

    const strippedTools = snapshot.toolSchemas.map(stripCacheControl)
    const toolSchemasHash = fastHash(safeStringify(strippedTools))
    const toolNames: string[] = []
    const toolHashes = new Map<string, number>()
    for (let i = 0; i < snapshot.toolSchemas.length; i++) {
      const rawTool = snapshot.toolSchemas[i]!
      const name = typeof rawTool.name === 'string' ? rawTool.name : '[non-string-name]'
      toolNames.push(name)
      toolHashes.set(name, fastHash(safeStringify(strippedTools[i])))
    }

    const cacheStrategy = snapshot.globalCacheStrategy ?? ''
    const sortedBetas = snapshot.betas ? [...snapshot.betas].sort() : []
    const isFlow = snapshot.flowActive === true
    const isUsingOverage = snapshot.overageInUse === true
    const hasCachedMicrocompact = snapshot.cachedMicrocompact === true
    const effortValue = snapshot.effortValue ?? ''
    const extraBodyHash =
      snapshot.extraBodyParams !== undefined ? fastHash(safeStringify(snapshot.extraBodyParams)) : 0
    const callReferenceDigest = snapshot.callReference?.digest

    let prefixFingerprint: PrefixFingerprint | null = null
    try {
      prefixFingerprint = fingerprintCacheablePrefix({
        systemBlocks: snapshot.system,
        tools: snapshot.toolSchemas,
      })
    } catch (error) {
      passedOver(error)
      prefixFingerprint = null
    }

    const renderPrompt = makeLazyRenderer(snapshot.model, snapshot.system, snapshot.toolSchemas)
    const prev = laneStates.get(key)

    if (prev === undefined) {
      if (laneStates.size >= MAX_LANE_STATES) {
        const firstKey = laneStates.keys().next().value
        if (firstKey !== undefined) laneStates.delete(firstKey)
      }
      laneStates.set(key, {
        callCount: 1,
        lane,
        model: snapshot.model,
        systemHash,
        systemTextLength,
        systemCacheControlHash,
        toolSchemasHash,
        toolNames,
        toolHashes,
        cacheStrategy,
        sortedBetas,
        isFlow,
        isUsingOverage,
        hasCachedMicrocompact,
        effortValue,
        extraBodyHash,
        ...(callReferenceDigest !== undefined ? { callReferenceDigest } : {}),
        prefixFingerprint,
        renderPrompt,
        prevCacheReadTokens: null,
        expectedCacheDrop: false,
        pendingChanges: null,
      })
      return
    }

    const modelChanged = prev.model !== snapshot.model
    const systemPromptChanged = prev.systemHash !== systemHash
    const toolSchemasChanged = prev.toolSchemasHash !== toolSchemasHash
    const systemCacheControlChanged = prev.systemCacheControlHash !== systemCacheControlHash
    const cacheStrategyChanged = prev.cacheStrategy !== cacheStrategy
    const betasChanged = !arraysEqual(prev.sortedBetas, sortedBetas)
    const flowChanged = prev.isFlow !== isFlow
    const overageChanged = prev.isUsingOverage !== isUsingOverage
    const cachedMicrocompactChanged = prev.hasCachedMicrocompact !== hasCachedMicrocompact
    const effortChanged = prev.effortValue !== effortValue
    const extraBodyChanged = prev.extraBodyHash !== extraBodyHash

    let addedTools: string[] = []
    let removedTools: string[] = []
    let modifiedTools: string[] = []
    if (toolSchemasChanged) {
      const prevToolSet = new Set(prev.toolNames)
      const nextToolSet = new Set(toolNames)
      addedTools = toolNames.filter(name => !prevToolSet.has(name))
      removedTools = prev.toolNames.filter(name => !nextToolSet.has(name))
      modifiedTools = toolNames.filter(
        name => prevToolSet.has(name) && prev.toolHashes.get(name) !== toolHashes.get(name),
      )
    }

    let addedBetas: string[] = []
    let removedBetas: string[] = []
    if (betasChanged) {
      const prevBetaSet = new Set(prev.sortedBetas)
      const nextBetaSet = new Set(sortedBetas)
      addedBetas = sortedBetas.filter(b => !prevBetaSet.has(b))
      removedBetas = prev.sortedBetas.filter(b => !nextBetaSet.has(b))
    }

    const anyChanged =
      modelChanged ||
      systemPromptChanged ||
      toolSchemasChanged ||
      systemCacheControlChanged ||
      cacheStrategyChanged ||
      betasChanged ||
      flowChanged ||
      overageChanged ||
      cachedMicrocompactChanged ||
      effortChanged ||
      extraBodyChanged

    let pendingChanges: PendingChanges | null = null
    if (anyChanged) {
      let firstPrefixDivergence: PrefixDivergence | undefined
      if (prev.prefixFingerprint !== null && prefixFingerprint !== null) {
        const fpDiff = diffPrefixFingerprints(prev.prefixFingerprint, prefixFingerprint)
        if (!fpDiff.identical && fpDiff.firstDivergence !== undefined) {
          firstPrefixDivergence = fpDiff.firstDivergence
        }
      }
      pendingChanges = {
        modelChanged,
        previousModel: prev.model,
        newModel: snapshot.model,
        systemPromptChanged,
        systemTextLengthDelta: systemTextLength - prev.systemTextLength,
        toolSchemasChanged,
        addedTools,
        removedTools,
        modifiedTools,
        systemCacheControlChanged,
        cacheStrategyChanged,
        previousStrategy: prev.cacheStrategy,
        newStrategy: cacheStrategy,
        betasChanged,
        addedBetas,
        removedBetas,
        flowChanged,
        overageChanged,
        cachedMicrocompactChanged,
        effortChanged,
        previousEffort: prev.effortValue,
        newEffort: effortValue,
        extraBodyChanged,
        previousRenderPrompt: prev.renderPrompt,
        ...(firstPrefixDivergence !== undefined ? { firstPrefixDivergence } : {}),
      }
    }

    prev.callCount += 1
    prev.lane = lane
    prev.model = snapshot.model
    prev.systemHash = systemHash
    prev.systemTextLength = systemTextLength
    prev.systemCacheControlHash = systemCacheControlHash
    prev.toolSchemasHash = toolSchemasHash
    prev.toolNames = toolNames
    prev.toolHashes = toolHashes
    prev.cacheStrategy = cacheStrategy
    prev.sortedBetas = sortedBetas
    prev.isFlow = isFlow
    prev.isUsingOverage = isUsingOverage
    prev.hasCachedMicrocompact = hasCachedMicrocompact
    prev.effortValue = effortValue
    prev.extraBodyHash = extraBodyHash
    prev.callReferenceDigest = callReferenceDigest
    prev.prefixFingerprint = prefixFingerprint
    prev.renderPrompt = renderPrompt
    prev.pendingChanges = pendingChanges
  } catch (error) {
    logError(error)
  }
}

export async function checkResponseForCacheBreak(
  querySource: string,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: string | null,
  _requestId?: string | null,
): Promise<void> {
  try {
    const key = resolveStateKey(querySource, agentId)
    if (key === null) return
    const state = laneStates.get(key)
    if (state === undefined) return
    if (state.model.includes('haiku')) return

    const prevCacheRead = state.prevCacheReadTokens
    state.prevCacheReadTokens = cacheReadTokens
    if (prevCacheRead === null) return

    if (state.expectedCacheDrop) {
      state.expectedCacheDrop = false
      state.pendingChanges = null
      logForDebugging(
        `cache-break: expected drop after deletion (${prevCacheRead} → ${cacheReadTokens}); not a break`,
      )
      return
    }

    const drop = prevCacheRead - cacheReadTokens
    if (!(cacheReadTokens < prevCacheRead * CACHE_DROP_RATIO && drop >= MIN_CACHE_DROP_TOKENS)) {
      state.pendingChanges = null
      return
    }

    const now = Date.now()
    const pending = state.pendingChanges
    const reason =
      pending !== null
        ? formatPendingReason(pending)
        : formatUnchangedReason(latestAssistantAgeMs(messages, now))

    let diffPath: string | undefined
    if (pending !== null) {
      diffPath = await writeDiffPatch(pending.previousRenderPrompt, state.renderPrompt)
    }
    const diffClause = diffPath !== undefined ? `, diff: ${diffPath}` : ''
    logForDebugging(
      `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${prevCacheRead} → ${cacheReadTokens}, creation: ${cacheCreationTokens}${diffClause}]`,
      { level: 'warn' },
    )

    const receipt: PromptCacheBreakReceipt = {
      at: now,
      lane: state.lane,
      querySource,
      ...(agentId !== undefined && agentId !== null ? { agentId } : {}),
      model: state.model,
      ...(pending !== null ? { previousModel: pending.previousModel } : {}),
      callCount: state.callCount,
      cacheReadPrev: prevCacheRead,
      cacheReadNow: cacheReadTokens,
      cacheCreationTokens,
      reason,
      ...(pending !== null
        ? {
            classes: {
              modelChanged: pending.modelChanged,
              systemPromptChanged: pending.systemPromptChanged,
              toolSchemasChanged: pending.toolSchemasChanged,
              effortChanged: pending.effortChanged,
              betasChanged: pending.betasChanged,
              cacheControlChanged: pending.systemCacheControlChanged || pending.cacheStrategyChanged,
              extraBodyChanged: pending.extraBodyChanged,
              addedTools: pending.addedTools,
              removedTools: pending.removedTools,
            },
          }
        : {}),
      ...(state.callReferenceDigest !== undefined ? { callReferenceDigest: state.callReferenceDigest } : {}),
      ...(pending?.firstPrefixDivergence !== undefined
        ? { firstPrefixDivergence: pending.firstPrefixDivergence }
        : {}),
      ...(diffPath !== undefined ? { diffPath } : {}),
    }

    receipts.push(receipt)
    if (receipts.length > MAX_RECEIPTS) {
      receipts.splice(0, receipts.length - MAX_RECEIPTS)
    }
    state.pendingChanges = null
  } catch (error) {
    logError(error)
  }
}

export function notifyCacheDeletion(querySource: string, agentId?: string): void {
  const key = resolveStateKey(querySource, agentId)
  if (key === null) return
  const state = laneStates.get(key)
  if (state !== undefined) {
    state.expectedCacheDrop = true
  }
}

export function notifyCompaction(querySource: string, agentId?: string): void {
  const key = resolveStateKey(querySource, agentId)
  if (key === null) return
  const state = laneStates.get(key)
  if (state !== undefined) {
    state.prevCacheReadTokens = null
  }
}

export function resetPromptCacheBreakDetection(): void {
  laneStates.clear()
  receipts.length = 0
}

export function recentCacheBreakReceipts(): readonly PromptCacheBreakReceipt[] {
  return receipts
}
