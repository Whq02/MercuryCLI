import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTwoFilesPatch } from 'diff'

import type { ModelCallReference } from '../../run-core/call-reference.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { djb2Hash } from '../../utils/hash.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  diffPrefixFingerprints,
  fingerprintCacheablePrefix,
  type PrefixFingerprint,
} from './prefixFingerprint.js'

/**
 * Two-phase prompt-cache-break detector. Phase 1 records what the prompt
 * looked like before a request; phase 2 decides, after the response, whether
 * a real cache break happened and why — attributing it to a concrete
 * client-side change or classifying it as TTL expiry / server-side, and
 * minting a bounded, inspectable receipt. Both phases swallow every internal
 * failure: observation must never affect the request.
 *
 * The system-block and tool-schema types are deliberately provider-neutral
 * structural shapes — the detector reads only structure and must not import
 * any provider SDK type, so each lane can feed its own wire truth.
 */

export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000

export type NeutralSystemBlock = {
  text: string
  cache_control?: unknown
}

export type NeutralToolSchema = {
  name: unknown
  description?: unknown
  input_schema?: unknown
  cache_control?: unknown
}

export type CacheLane =
  | 'anthropic'
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  // The auth fold's lanes ride the same compat cache grammar:
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'

export type PromptStateSnapshot = {
  system: NeutralSystemBlock[]
  toolSchemas: NeutralToolSchema[]
  querySource: string
  model: string
  agentId?: string
  globalCacheStrategy?: 'tool_based' | 'system_prompt' | 'none'
  betas?: string[]
  autoModeActive?: boolean
  overageInUse?: boolean
  cachedMicrocompact?: boolean
  effortValue?: string | null
  extraBodyParams?: Record<string, unknown>
  lane?: CacheLane
  callReference?: ModelCallReference
}

type SwitchClasses = {
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

export type PromptCacheBreakReceipt = {
  at: number
  lane: CacheLane | 'anthropic'
  querySource: string
  agentId?: string
  model: string
  previousModel?: string
  callCount: number
  /** The previous and new cache-read counts — spellings are contract data
   *  (the cacheswitch inventory and its pinned baseline read exactly these). */
  cacheReadPrev: number
  cacheReadNow: number
  cacheCreationTokens: number
  reason: string
  classes?: SwitchClasses
  callReferenceDigest?: string
  firstPrefixDivergence?: { index: number; kind: string; aDigest: string; bDigest: string }
  diffPath?: string
}

type PendingChanges = {
  modelChanged: boolean
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  cacheControlChanged: boolean
  strategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMicrocompactChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  systemCharDelta: number
  previousModel: string
  newModel: string
  previousStrategy: string
  newStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  previousEffort: string
  newEffort: string
  previousPromptRendering: (() => string) | null
  firstPrefixDivergence?: { index: number; kind: string; aDigest: string; bDigest: string }
}

type LaneState = {
  systemHash: number
  toolsHash: number
  cacheControlHash: number
  toolNames: string[]
  perToolHashes: Map<string, number>
  systemTextLength: number
  model: string
  globalCacheStrategy: string
  betas: string[]
  autoModeActive: boolean
  overageInUse: boolean
  cachedMicrocompact: boolean
  effort: string
  extraBodyHash: number
  lane: CacheLane
  callReferenceDigest?: string
  fingerprint: PrefixFingerprint | null
  callCount: number
  previousCacheReadTokens: number | null
  expectedDrop: boolean
  pendingChanges: PendingChanges | null
  promptRendering: (() => string) | null
}

const MAX_TRACKED_LANES = 10
const MAX_RECEIPTS = 50
const BREAK_RATIO = 0.95
const BREAK_MIN_DROP_TOKENS = 2000

const TRACKED_SOURCE_PREFIXES = ['repl_main_thread', 'sdk', 'agent:custom', 'agent:default', 'agent:builtin']

const laneStates = new Map<string, LaneState>()
const receipts: PromptCacheBreakReceipt[] = []

//
// Key resolution + hashing
//

function trackingKey(querySource: string, agentId?: string): string | null {
  // `compact` shares the main REPL thread's key — it deliberately sends
  // cache-identical parameters.
  if (querySource === 'compact') return 'repl_main_thread'
  if (!TRACKED_SOURCE_PREFIXES.some(prefix => querySource.startsWith(prefix))) return null
  // The agent id is preferred so concurrent instances of one agent type do
  // not cross-contaminate.
  return agentId ?? querySource
}

function fastHash(value: string): number {
  const bun = (globalThis as { Bun?: { hash?: (input: string) => number | bigint } }).Bun
  if (typeof bun?.hash === 'function') {
    const hashed = bun.hash(value)
    // Coerce a big integer into a 32-bit number.
    return typeof hashed === 'bigint' ? Number(BigInt.asUintN(32, hashed)) : hashed
  }
  // Portable fallback: the harness also runs under a plain Node install.
  return djb2Hash(value)
}

function stripCacheControl<T extends { cache_control?: unknown }>(value: T): Omit<T, 'cache_control'> {
  const { cache_control: _dropped, ...rest } = value
  return rest
}

function hashSystemBlocks(system: NeutralSystemBlock[]): number {
  return fastHash(jsonStringify(system.map(stripCacheControl)) ?? '')
}

function hashToolSchemas(tools: NeutralToolSchema[]): number {
  return fastHash(jsonStringify(tools.map(stripCacheControl)) ?? '')
}

function hashCacheControls(system: NeutralSystemBlock[]): number {
  // The SYSTEM blocks' per-block cache-control values ONLY: catches the
  // scope and TTL flips the stripped hashes cannot see because the text is
  // identical. The tool list is deliberately excluded — adding or removing a
  // tool moves which tool carries the marker, and folding that in made every
  // tool-set change also flip the cache-control class (a false positive; the
  // tool-schema class already covers tools).
  return fastHash(jsonStringify(system.map(block => block.cache_control ?? null)) ?? '')
}

function toolNameOf(tool: NeutralToolSchema): string {
  return typeof tool.name === 'string' ? tool.name : '[non-string-name]'
}

function perToolHashes(tools: NeutralToolSchema[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const tool of tools) {
    map.set(toolNameOf(tool), fastHash(jsonStringify(stripCacheControl(tool)) ?? ''))
  }
  return map
}

function systemTextLength(system: NeutralSystemBlock[]): number {
  let total = 0
  for (const block of system) total += typeof block.text === 'string' ? block.text.length : 0
  return total
}

/**
 * Collapse a tool name beginning with `mcp__` to a generic `mcp` label
 * (MCP names come from server configuration and can carry file paths).
 * NO CALL SITE in this build: every name reaching a receipt, a per-tool
 * hash key or the reason text is raw. Keep the helper AND keep outputs raw —
 * the receipt shape is pinned by an inventory oracle.
 */
export function sanitizeToolNameForReceipt(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

function buildPromptRendering(snapshot: PromptStateSnapshot): () => string {
  // Lazy: serialising costs hundreds of milliseconds.
  let cached: string | null = null
  return () => {
    if (cached !== null) return cached
    const lines: string[] = [`model: ${snapshot.model}`, '']
    lines.push(snapshot.system.map(block => String(block.text ?? '')).join('\n\n'))
    const sorted = [...snapshot.toolSchemas].sort((a, b) =>
      toolNameOf(a).localeCompare(toolNameOf(b)),
    )
    lines.push('', `## tools (${sorted.length})`)
    for (const tool of sorted) {
      lines.push(
        '',
        `### ${toolNameOf(tool)}`,
        String(tool.description ?? ''),
        jsonStringify(tool.input_schema) ?? '',
      )
    }
    cached = lines.join('\n')
    return cached
  }
}

function betasEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

//
// Phase 1
//

export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
    const key = trackingKey(snapshot.querySource, snapshot.agentId)
    if (key === null) return

    const systemHash = hashSystemBlocks(snapshot.system)
    const toolsHash = hashToolSchemas(snapshot.toolSchemas)
    const cacheControlHash = hashCacheControls(snapshot.system)
    const toolNames = snapshot.toolSchemas.map(toolNameOf)
    const textLength = systemTextLength(snapshot.system)
    const betas = [...(snapshot.betas ?? [])].sort()
    const effort = snapshot.effortValue == null ? '' : String(snapshot.effortValue)
    const extraBodyHash =
      snapshot.extraBodyParams === undefined ? 0 : fastHash(jsonStringify(snapshot.extraBodyParams) ?? '')

    let fingerprint: PrefixFingerprint | null = null
    try {
      fingerprint = fingerprintCacheablePrefix({
        systemBlocks: snapshot.system as Array<{ text: string; cache_control?: unknown }>,
        tools: snapshot.toolSchemas,
      })
    } catch {
      fingerprint = null
    }

    const existing = laneStates.get(key)
    if (existing === undefined) {
      // Bound the map: evict in insertion order until there is room. A
      // lane's state can retain a several-hundred-kilobyte rendering, and a
      // session spawning many subagents would otherwise grow it unbounded.
      while (laneStates.size >= MAX_TRACKED_LANES) {
        const oldest = laneStates.keys().next().value
        if (oldest === undefined) break
        laneStates.delete(oldest)
      }
      laneStates.set(key, {
        systemHash,
        toolsHash,
        cacheControlHash,
        toolNames,
        // First snapshot: per-tool hashes computed unconditionally.
        perToolHashes: perToolHashes(snapshot.toolSchemas),
        systemTextLength: textLength,
        model: snapshot.model,
        globalCacheStrategy: snapshot.globalCacheStrategy ?? '',
        betas,
        autoModeActive: snapshot.autoModeActive === true,
        overageInUse: snapshot.overageInUse === true,
        cachedMicrocompact: snapshot.cachedMicrocompact === true,
        effort,
        extraBodyHash,
        lane: snapshot.lane ?? 'anthropic',
        callReferenceDigest: snapshot.callReference?.digest,
        fingerprint,
        callCount: 1,
        previousCacheReadTokens: null,
        expectedDrop: false,
        pendingChanges: null,
        promptRendering: buildPromptRendering(snapshot),
      })
      return
    }

    existing.callCount++
    existing.lane = snapshot.lane ?? 'anthropic'
    existing.callReferenceDigest = snapshot.callReference?.digest

    let firstDivergence: PendingChanges['firstPrefixDivergence']
    if (existing.fingerprint !== null && fingerprint !== null) {
      const diff = diffPrefixFingerprints(existing.fingerprint, fingerprint)
      if (!diff.identical && diff.firstDivergence !== undefined) {
        firstDivergence = diff.firstDivergence
      }
    }

    const modelChanged = existing.model !== snapshot.model
    const systemPromptChanged = existing.systemHash !== systemHash
    const toolSchemasChanged = existing.toolsHash !== toolsHash
    const cacheControlChanged = existing.cacheControlHash !== cacheControlHash
    const strategyChanged = existing.globalCacheStrategy !== (snapshot.globalCacheStrategy ?? '')
    const betasChanged = !betasEqual(existing.betas, betas)
    const autoModeChanged = existing.autoModeActive !== (snapshot.autoModeActive === true)
    const overageChanged = existing.overageInUse !== (snapshot.overageInUse === true)
    const cachedMicrocompactChanged =
      existing.cachedMicrocompact !== (snapshot.cachedMicrocompact === true)
    const effortChanged = existing.effort !== effort
    const extraBodyChanged = existing.extraBodyHash !== extraBodyHash

    // Per-tool hashes: recomputed ONLY when the aggregate changed — avoids N
    // serialisations on the common unchanged path.
    let newPerToolHashes = existing.perToolHashes
    let addedTools: string[] = []
    let removedTools: string[] = []
    let changedToolSchemas: string[] = []
    if (toolSchemasChanged) {
      newPerToolHashes = perToolHashes(snapshot.toolSchemas)
      const previousNames = new Set(existing.toolNames)
      const currentNames = new Set(snapshot.toolSchemas.map(toolNameOf))
      addedTools = [...currentNames].filter(name => !previousNames.has(name))
      removedTools = [...previousNames].filter(name => !currentNames.has(name))
      for (const [name, hash] of newPerToolHashes) {
        if (previousNames.has(name) && currentNames.has(name)) {
          const previousHash = existing.perToolHashes.get(name)
          if (previousHash !== undefined && previousHash !== hash) changedToolSchemas.push(name)
        }
      }
    }

    const anyChanged =
      modelChanged ||
      systemPromptChanged ||
      toolSchemasChanged ||
      cacheControlChanged ||
      strategyChanged ||
      betasChanged ||
      autoModeChanged ||
      overageChanged ||
      cachedMicrocompactChanged ||
      effortChanged ||
      extraBodyChanged

    if (anyChanged) {
      existing.pendingChanges = {
        modelChanged,
        systemPromptChanged,
        toolSchemasChanged,
        cacheControlChanged,
        strategyChanged,
        betasChanged,
        autoModeChanged,
        overageChanged,
        cachedMicrocompactChanged,
        effortChanged,
        extraBodyChanged,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: textLength - existing.systemTextLength,
        previousModel: existing.model,
        newModel: snapshot.model,
        previousStrategy: existing.globalCacheStrategy,
        newStrategy: snapshot.globalCacheStrategy ?? '',
        addedBetas: betas.filter(beta => !existing.betas.includes(beta)),
        removedBetas: existing.betas.filter(beta => !betas.includes(beta)),
        previousEffort: existing.effort,
        newEffort: effort,
        previousPromptRendering: existing.promptRendering,
        ...(firstDivergence !== undefined ? { firstPrefixDivergence: firstDivergence } : {}),
      }
    } else {
      existing.pendingChanges = null
    }

    existing.systemHash = systemHash
    existing.toolsHash = toolsHash
    existing.cacheControlHash = cacheControlHash
    existing.toolNames = snapshot.toolSchemas.map(toolNameOf)
    existing.perToolHashes = newPerToolHashes
    existing.systemTextLength = textLength
    existing.model = snapshot.model
    existing.globalCacheStrategy = snapshot.globalCacheStrategy ?? ''
    existing.betas = betas
    existing.autoModeActive = snapshot.autoModeActive === true
    existing.overageInUse = snapshot.overageInUse === true
    existing.cachedMicrocompact = snapshot.cachedMicrocompact === true
    existing.effort = effort
    existing.extraBodyHash = extraBodyHash
    existing.fingerprint = fingerprint
    existing.promptRendering = buildPromptRendering(snapshot)
  } catch (err) {
    logError(err)
  }
}

//
// Phase 2
//

function ageOfLastAssistantMessage(messages: Message[]): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { type?: string; timestamp?: unknown } | undefined
    if (message?.type !== 'assistant') continue
    const timestamp = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN
    if (!Number.isFinite(timestamp)) return null
    return Date.now() - timestamp
  }
  return null
}

function buildReason(pending: PendingChanges): string {
  const parts: string[] = []
  if (pending.modelChanged) {
    parts.push(`model changed (${pending.previousModel} → ${pending.newModel})`)
  }
  if (pending.systemPromptChanged) {
    const delta = pending.systemCharDelta
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
  if (pending.strategyChanged) {
    parts.push(
      `global cache strategy changed (${pending.previousStrategy || 'none'} → ${pending.newStrategy || 'none'})`,
    )
  }
  // Cache-control change is reported only when neither the strategy nor the
  // system prompt also changed — otherwise it is a consequence, not the root
  // cause.
  if (pending.cacheControlChanged && !pending.strategyChanged && !pending.systemPromptChanged) {
    parts.push('cache_control changed (scope or TTL)')
  }
  if (pending.betasChanged) {
    // Additions `+`-prefixed and COMMA-joined; removals `-`-prefixed and
    // comma-joined; the two groups space-separated.
    const additions = pending.addedBetas.length > 0 ? `+${pending.addedBetas.join(',')}` : ''
    const removals = pending.removedBetas.length > 0 ? `-${pending.removedBetas.join(',')}` : ''
    const detail = [additions, removals].filter(part => part !== '').join(' ')
    parts.push(detail !== '' ? `betas changed (${detail})` : 'betas changed')
  }
  if (pending.autoModeChanged) parts.push('flow toggled')
  if (pending.overageChanged) parts.push('overage state changed (TTL latched, no flip)')
  if (pending.cachedMicrocompactChanged) parts.push('cached microcompact toggled')
  if (pending.effortChanged) {
    parts.push(
      `effort changed (${pending.previousEffort || 'default'} → ${pending.newEffort || 'default'})`,
    )
  }
  if (pending.extraBodyChanged) parts.push('extra body params changed')
  return parts.join(', ')
}

function classifyByElapsedTime(ageMs: number | null): string {
  // When all client-side flags are false and the gap is under TTL, the
  // overwhelming majority of breaks are server-side routing/eviction or a
  // billed-versus-inference disagreement — the copy must not imply a client
  // bug.
  if (ageMs !== null && ageMs > CACHE_TTL_1HOUR_MS) {
    return 'possible 1h TTL expiry (prompt unchanged)'
  }
  if (ageMs !== null && ageMs > CACHE_TTL_5MIN_MS) {
    return 'possible 5min TTL expiry (prompt unchanged)'
  }
  if (ageMs !== null) {
    return 'likely server-side (prompt unchanged, <5min gap)'
  }
  return 'unknown cause'
}

function writeDiff(previous: string, current: string): string | undefined {
  try {
    const suffix = Array.from({ length: 4 }, () =>
      'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36)),
    ).join('')
    const dir = join(tmpdir(), 'mercury')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `cache-break-${suffix}.diff`)
    const patch = createTwoFilesPatch('prompt-state', 'prompt-state', previous, current, 'before', 'after')
    writeFileSync(path, patch)
    return path
  } catch {
    return undefined
  }
}

export async function checkResponseForCacheBreak(
  querySource: string,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: string | null,
  requestId?: string | null,
): Promise<void> {
  try {
    void requestId
    const key = trackingKey(querySource, agentId ?? undefined)
    if (key === null) return
    const state = laneStates.get(key)
    if (state === undefined) return

    // Models whose name contains `haiku` cache differently — excluded.
    if (state.model.includes('haiku')) return

    const previous = state.previousCacheReadTokens
    state.previousCacheReadTokens = cacheReadTokens

    const ageMs = ageOfLastAssistantMessage(messages)

    if (previous === null) return

    if (state.expectedDrop) {
      state.expectedDrop = false
      logForDebugging(
        `cache-break: expected drop after deletion (${previous} → ${cacheReadTokens}); not a break`,
      )
      state.pendingChanges = null
      return
    }

    // A break only when BOTH: below 95% of the previous count AND an
    // absolute drop of at least 2 000 tokens. Small drops are normal.
    const isBreak =
      cacheReadTokens < previous * BREAK_RATIO && previous - cacheReadTokens >= BREAK_MIN_DROP_TOKENS
    if (!isBreak) {
      state.pendingChanges = null
      return
    }

    const pending = state.pendingChanges
    const reason = pending !== null ? buildReason(pending) : classifyByElapsedTime(ageMs)

    let diffPath: string | undefined
    if (pending?.previousPromptRendering != null && state.promptRendering !== null) {
      diffPath = writeDiff(pending.previousPromptRendering(), state.promptRendering())
    }

    logForDebugging(
      `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${previous} → ${cacheReadTokens}, creation: ${cacheCreationTokens}${diffPath ? `, diff: ${diffPath}` : ''}]`,
      { level: 'warn' },
    )

    const receipt: PromptCacheBreakReceipt = {
      at: Date.now(),
      lane: state.lane,
      querySource,
      ...(agentId !== undefined && agentId !== null ? { agentId } : {}),
      model: state.model,
      ...(pending !== null ? { previousModel: pending.previousModel } : {}),
      callCount: state.callCount,
      cacheReadPrev: previous,
      cacheReadNow: cacheReadTokens,
      cacheCreationTokens,
      reason,
      // The class block is a FIXED subset: strategy, auto-mode, overage and
      // cached-microcompact reach the operator only through the reason text.
      ...(pending !== null
        ? {
            classes: {
              modelChanged: pending.modelChanged,
              systemPromptChanged: pending.systemPromptChanged,
              toolSchemasChanged: pending.toolSchemasChanged,
              effortChanged: pending.effortChanged,
              betasChanged: pending.betasChanged,
              cacheControlChanged: pending.cacheControlChanged,
              extraBodyChanged: pending.extraBodyChanged,
              addedTools: pending.addedTools,
              removedTools: pending.removedTools,
            },
          }
        : {}),
      ...(state.callReferenceDigest !== undefined
        ? { callReferenceDigest: state.callReferenceDigest }
        : {}),
      ...(pending?.firstPrefixDivergence !== undefined
        ? { firstPrefixDivergence: pending.firstPrefixDivergence }
        : {}),
      ...(diffPath !== undefined ? { diffPath } : {}),
    }
    receipts.push(receipt)
    while (receipts.length > MAX_RECEIPTS) receipts.shift()

    state.pendingChanges = null
  } catch (err) {
    logError(err)
  }
}

//
// Notifications
//

/**
 * A cache deletion was announced: the next drop for this lane is expected.
 * Exported and importable; NO call site in this slice invokes it —
 * restoring the calls is an operator decision.
 */
export function notifyCacheDeletion(querySource: string, agentId?: string): void {
  const key = trackingKey(querySource, agentId)
  if (key === null) return
  const state = laneStates.get(key)
  if (state === undefined) return
  state.expectedDrop = true
}

/**
 * A compaction happened: clear the previous baseline so the legitimate
 * post-compaction drop is not a break. Exported and importable; NO call
 * site in this slice invokes it.
 */
export function notifyCompaction(querySource: string, agentId?: string): void {
  const key = trackingKey(querySource, agentId)
  if (key === null) return
  const state = laneStates.get(key)
  if (state === undefined) return
  state.previousCacheReadTokens = null
}

export function cleanupAgentTracking(agentId: string): void {
  laneStates.delete(agentId)
}

export function resetPromptCacheBreakDetection(): void {
  laneStates.clear()
  receipts.length = 0
}

export function recentCacheBreakReceipts(): readonly PromptCacheBreakReceipt[] {
  return receipts
}
