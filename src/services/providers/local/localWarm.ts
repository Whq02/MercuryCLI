import { subscribeMainLoopModelOverride } from '../../../bootstrap/state.js'
import { renderGenericInstructions, resolveBehaviourContract } from '../../../prompt/behaviourContract.js'
import type { Tools } from '../../../Tool.js'
import type { Message } from '../../../types/message.js'
import { appendSystemContext, prependUserContext, toolToAPISchema } from '../../../utils/api.js'
import { latestUserContextBody } from '../../../utils/attachments/userContext.js'
import { applyTurnTierEffort } from '../../../utils/autopilot/tierState.js'
import { logForDebugging } from '../../../utils/debug.js'
import { resolveWireRequestedEffort } from '../../../utils/effort.js'
import type { CacheSafeParams } from '../../../utils/forkedAgent.js'
import { getUserAgent } from '../../../utils/http.js'
import { getMainLoopModel, getPublicModelDisplayName } from '../../../utils/model/model.js'
import { getApiFetch } from '../../../utils/proxy.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import { rosterOwnerFromToolUseContext } from '../../run/resolveOwner.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { localStreamLawFor } from '../localLiveness.js'
import { compatDispatchModelId, imagesSupportedForCompatModel } from '../openaicompat/compatChatCallModel.js'
import type { CompatChatRequest, CompatFault, CompatStreamOptions, CompatUsage } from '../openaicompat/compatChatClient.js'
import { localThinkingOff } from '../openaicompat/compatWire.js'
import { coldPrefixOf, estimateRequestTokens, streamIdleTimeoutMsForRoute } from '../streamIdleBudget.js'
import { planToolPayload, toolRosterLatchFor } from '../toolEconomy.js'
import { mapMessagesToZai, mapToolsToZai, type ApiShapedTool } from '../zai/zaiCodec.js'
import { resolveLocalApiKey } from './localAccounts.js'
import { localGuardWindow, localLaneProfileFor, localModelAcceptsEffort, localPreComposeEstimate } from './localCallModel.js'
import { isLocalModelId, localRecordFor } from './localCatalogue.js'
import { LOCAL_PROBE_TIMEOUT_MS, refreshLocalDiscovery, type LocalModelRecord } from './localDiscovery.js'
import { chooseLocalBatch, chooseLocalWindow, ensureLocalWindowTruth, heldLocalWindow, localBatchSettingOf, localWindowApplication, localWindowSettingOf } from './localWindow.js'
import { ollamaChatUrl, streamOllamaChat, type OllamaChatKnobs } from './ollamaChatTransport.js'

export const LOCAL_WARM_SETTLE_MS = 750
export const LOCAL_WARM_LIVE_WAITS = 8
export const LOCAL_WARM_CEILING_MS = 20 * 60_000
export const LOCAL_WARM_NUM_PREDICT = 1
export const LOCAL_WARM_REPEAT_QUIET_MS = 60_000
export const LOCAL_KEEP_ALIVE_TICK_MS = 5 * 60_000
export const LOCAL_KEEP_ALIVE_HOLD = '30m'
export const LOCAL_KEEP_ALIVE_HOLD_MS = 30 * 60_000
export const LOCAL_KEEP_ALIVE_TOUCH_TIMEOUT_MS = 10_000
const LOCAL_WARM_OUTPUT_FLOOR = 1024

export interface LocalWarmIo {
  fetchImpl?: typeof fetch
  now?: () => number
  settleMs?: number
  tickMs?: number
  probeTimeoutMs?: number
  ceilingMs?: number
}

export interface LocalWarmKnobs {
  numCtx?: number
  numBatch: number
}

export interface LocalWarmTouch {
  model: string
  keepAlive: string
  numCtx?: number
  numBatch: number
  atMs: number
}

export interface LocalWarmFacts {
  armed: boolean
  clock: string | null
  inFlight: string | null
  warmed: string[]
  cancelled: number
  failed: number
  skipped: number
  touches: number
  lastTouch: LocalWarmTouch | null
  lastWarm: { model: string; promptTokens: number; usage: CompatUsage | null; elapsedMs: number } | null
}

export type LocalWarmContextProvider = () => Promise<CacheSafeParams> | CacheSafeParams

interface InFlightWarm {
  key: string
  wireModel: string
  controller: AbortController
}

interface WarmState {
  context: LocalWarmContextProvider | null
  live: () => boolean
  io: LocalWarmIo
  unsubscribe: (() => void) | null
  settleTimer: ReturnType<typeof setTimeout> | null
  liveWaits: number
  inFlight: InFlightWarm | null
  sent: Map<string, LocalWarmKnobs>
  warmed: Set<string>
  recent: { key: string; at: number } | null
  cancelled: number
  failed: number
  skipped: number
  clock: { key: string; timer: ReturnType<typeof setInterval> } | null
  ticking: boolean
  touches: number
  lastTouch: LocalWarmTouch | null
  lastWarm: LocalWarmFacts['lastWarm']
}

const state: WarmState = {
  context: null,
  live: () => true,
  io: {},
  unsubscribe: null,
  settleTimer: null,
  liveWaits: 0,
  inFlight: null,
  sent: new Map(),
  warmed: new Set(),
  recent: null,
  cancelled: 0,
  failed: 0,
  skipped: 0,
  clock: null,
  ticking: false,
  touches: 0,
  lastTouch: null,
  lastWarm: null,
}

function nowMs(): number {
  return state.io.now?.() ?? Date.now()
}

function keyOf(record: Pick<LocalModelRecord, 'id' | 'server'>): string {
  return `${record.server}/${record.id}`
}

function serverRootOf(record: LocalModelRecord): string {
  return record.baseUrl.replace(/\/v1\/?$/, '')
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

export async function localWarmKnobsFor(record: LocalModelRecord, estTokens: number): Promise<LocalWarmKnobs> {
  const application = localWindowApplication(record)
  const setting = localWindowSettingOf(record)
  const decides = application === 'request' || application === 'load'
  const truth = decides ? await ensureLocalWindowTruth(record, setting) : null
  const hold = heldLocalWindow(record)
  const window = hold !== undefined && hold.setting === setting ? hold.window : decides ? chooseLocalWindow(record, estTokens, setting, truth).window : undefined
  return { ...(window !== undefined ? { numCtx: window } : {}), numBatch: chooseLocalBatch(localBatchSettingOf(record), window) }
}

function heldKnobsFor(record: LocalModelRecord): LocalWarmKnobs | undefined {
  const hold = heldLocalWindow(record)
  if (hold !== undefined) {
    return { ...(hold.window !== undefined ? { numCtx: hold.window } : {}), numBatch: chooseLocalBatch(localBatchSettingOf(record), hold.window) }
  }
  return state.sent.get(keyOf(record))
}

export interface LocalWarmBody {
  request: CompatChatRequest
  knobs: OllamaChatKnobs
  estTokens: number
  toolCount: number
  cold: boolean
}

export function conversationHasRows(messages: readonly Message[]): boolean {
  return messages.some(message => message.type === 'assistant' || (message.type === 'user' && message.isMeta !== true))
}

export async function composeLocalWarm(record: LocalModelRecord, model: string, context: CacheSafeParams): Promise<LocalWarmBody | { skipped: string }> {
  const modelId = compatDispatchModelId(model)
  const toolUseContext = context.toolUseContext
  const tools: Tools = toolUseContext.options.tools
  const history: Message[] = context.forkContextMessages
  if (conversationHasRows(history)) return { skipped: 'the conversation already carries rows; a prefix-only warm would truncate a cache the server may hold for it, so only a fresh session is warmed' }
  const appState = toolUseContext.getAppState()
  const getToolPermissionContext = async () => toolUseContext.getAppState().toolPermissionContext
  const agents = toolUseContext.options.agentDefinitions.activeAgents
  const allowedAgentTypes = toolUseContext.options.agentDefinitions.allowedAgentTypes
  const ownerKey = String(rosterOwnerFromToolUseContext(toolUseContext))
  const latched = toolRosterLatchFor(ownerKey, history, modelId) !== undefined
  const plan = await planToolPayload({
    model: modelId,
    tools,
    messages: history,
    getToolPermissionContext,
    agents,
    ...(latched ? { latchKey: ownerKey } : {}),
    hasPendingMcpServers: appState.mcp.clients.some(client => client.type === 'pending'),
    source: 'warm',
  })
  const schemas = await Promise.all(
    plan.roster.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools: plan.roster,
        agents,
        allowedAgentTypes,
        model: modelId,
        conversationKey: plan.conversationKey,
      }),
    ),
  )
  const apiTools: ApiShapedTool[] = []
  for (const schema of schemas) {
    const shaped = schema as { name?: string; description?: string; input_schema?: unknown }
    if (typeof shaped.name === 'string' && shaped.input_schema !== undefined) {
      apiTools.push({ name: shaped.name, ...(shaped.description ? { description: shaped.description } : {}), input_schema: shaped.input_schema })
    }
  }
  const fullSystemPrompt = asSystemPrompt(appendSystemContext(context.systemPrompt, context.systemContext))
  const systemText = renderGenericInstructions(resolveBehaviourContract([...fullSystemPrompt]))
  const profile = localLaneProfileFor(record)
  const wireModel = profile.wireModelId(modelId)
  if (apiTools.length > 0 && profile.toolCapabilityRefusal?.(wireModel) !== undefined) return { skipped: 'the model declares no tool support; the first turn refuses before sending' }
  const thinkingConfig = toolUseContext.options.thinkingConfig as { type?: string } | undefined
  const thinkingEnabled = thinkingConfig?.type !== 'disabled'
  const effortValue = resolveWireRequestedEffort(modelId, applyTurnTierEffort(undefined, appState.effortValue), {})
  const extra = profile.buildExtras({ wireModel, effortValue, thinkingEnabled, maxOutputTokensOverride: undefined })
  const request: CompatChatRequest = {
    model: wireModel,
    messages: mapMessagesToZai(systemText, [], {
      keepReasoningHistory: profile.keepsReasoningHistory?.(wireModel) ?? false,
      imagesSupported: imagesSupportedForCompatModel(modelId),
    }),
    ...(apiTools.length > 0 ? { tools: mapToolsToZai(apiTools) } : {}),
    extra: { ...extra, max_tokens: LOCAL_WARM_NUM_PREDICT },
  }
  const estimateMessages = latestUserContextBody(history) === null ? prependUserContext(history, context.userContext) : history
  const estTokens = localPreComposeEstimate({ messages: estimateMessages, systemPrompt: fullSystemPrompt, tools })
  const window = await localWarmKnobsFor(record, estTokens)
  const requestTokens = Math.ceil(JSON.stringify(request).length / 4)
  const guard = window.numCtx ?? localGuardWindow(record)?.tokens
  if (guard !== undefined && requestTokens + LOCAL_WARM_OUTPUT_FLOOR > guard) return { skipped: `the prefix (~${requestTokens} tokens) does not fit the window (${guard}); the first turn refuses before sending` }
  const knobs: OllamaChatKnobs = {
    ...(window.numCtx !== undefined ? { numCtx: window.numCtx } : {}),
    numBatch: window.numBatch,
    ...(record.thinkingDeclared === true ? { think: !localThinkingOff({ server: record.server, acceptsEffort: localModelAcceptsEffort(record), thinkingEnabled }) } : {}),
  }
  return { request, knobs, estTokens, toolCount: apiTools.length, cold: coldPrefixOf(history, modelId) }
}

function cancelInFlight(reason: string): void {
  const flight = state.inFlight
  if (flight === null) return
  state.inFlight = null
  state.cancelled += 1
  logForDebugging(`[local-warm] warm of ${flight.wireModel} cancelled: ${reason}`)
  flight.controller.abort()
}

export function cancelLocalWarm(reason = 'cancelled'): void {
  cancelInFlight(reason)
}

export function noteLocalTurn(record: LocalModelRecord | undefined): void {
  cancelInFlight('a real turn takes the server')
  if (record === undefined || record.server !== 'ollama') return
  const key = keyOf(record)
  if (state.recent !== null && state.recent.key !== key) state.recent = null
  const knobs = heldKnobsFor(record)
  if (knobs !== undefined) state.sent.set(key, knobs)
}

async function resolveRecord(model: string): Promise<LocalModelRecord | undefined> {
  if (!isLocalModelId(model)) return undefined
  const cached = localRecordFor(model)
  if (cached !== undefined) return cached
  await refreshLocalDiscovery().catch(() => undefined)
  return localRecordFor(model)
}

async function warm(record: LocalModelRecord, model: string): Promise<void> {
  const key = keyOf(record)
  const provider = state.context
  if (provider === null) return
  cancelInFlight('a later switch replaces it')
  if (state.recent !== null && state.recent.key !== key) state.recent = null
  const controller = new AbortController()
  const flight: InFlightWarm = { key, wireModel: record.id, controller }
  state.inFlight = flight
  const startedAt = nowMs()
  const ceiling = setTimeout(() => controller.abort(), state.io.ceilingMs ?? LOCAL_WARM_CEILING_MS)
  ceiling.unref?.()
  try {
    const context = await provider()
    if (controller.signal.aborted) return
    const body = await composeLocalWarm(record, model, context)
    if (controller.signal.aborted) return
    if ('skipped' in body) {
      state.skipped += 1
      logForDebugging(`[local-warm] warm of ${record.id} skipped: ${body.skipped}`)
      return
    }
    const promptTokens = estimateRequestTokens(body.request)
    logForDebugging(`[local-warm] warming ${record.id}: ${body.toolCount} tools, ~${promptTokens} prompt tokens, num_ctx=${String(body.knobs.numCtx)}, num_batch=${body.knobs.numBatch}, think=${String(body.knobs.think)}, num_predict=${LOCAL_WARM_NUM_PREDICT}`)
    const credential = resolveLocalApiKey()
    const streamOptions: CompatStreamOptions = {
      ...(credential ? { apiKey: credential.key } : {}),
      ...(state.io.fetchImpl ? { fetchImpl: state.io.fetchImpl } : {}),
      url: ollamaChatUrl(record.baseUrl),
      request: body.request,
      signal: controller.signal,
      idleTimeoutMs: streamIdleTimeoutMsForRoute('local'),
      firstByte: { cold: body.cold, promptTokens, model: getPublicModelDisplayName(model) ?? model },
    }
    const law = localStreamLawFor({ wireModel: record.id, cold: body.cold, promptTokens, record })
    if (law !== undefined) streamOptions.local = law
    let fault: CompatFault | undefined
    let usage: CompatUsage | null = null
    let finished = false
    for await (const event of streamOllamaChat(streamOptions, body.knobs)) {
      if (event.type === 'stream-fault') fault = fault ?? event.fault
      else if (event.type === 'usage') usage = event.usage
      else if (event.type === 'finish') finished = true
    }
    const elapsedMs = nowMs() - startedAt
    if (controller.signal.aborted || fault?.kind === 'cancelled') return
    if (fault !== undefined && !finished) {
      state.failed += 1
      logForDebugging(`[local-warm] warm of ${record.id} failed after ${Math.round(elapsedMs / 1000)}s: ${fault.code}: ${fault.message}`)
      return
    }
    state.sent.set(key, { ...(body.knobs.numCtx !== undefined ? { numCtx: body.knobs.numCtx } : {}), numBatch: body.knobs.numBatch ?? chooseLocalBatch(localBatchSettingOf(record), undefined) })
    state.warmed.add(key)
    state.recent = { key, at: nowMs() }
    state.lastWarm = { model: record.id, promptTokens, usage, elapsedMs }
    logForDebugging(`[local-warm] warm of ${record.id} settled in ${Math.round(elapsedMs / 1000)}s: prompt_eval_count=${String(usage?.inputTokens)} cached=${String(usage?.cachedInputTokens)}`)
  } catch (error) {
    if (controller.signal.aborted) return
    state.failed += 1
    logForDebugging(`[local-warm] warm of ${record.id} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(ceiling)
    if (state.inFlight === flight) state.inFlight = null
  }
}

function stopClock(reason: string): void {
  const clock = state.clock
  if (clock === null) return
  state.clock = null
  clearInterval(clock.timer)
  logForDebugging(`[local-warm] keep-alive clock for ${clock.key} stopped: ${reason}`)
}

function startClock(record: LocalModelRecord): void {
  const key = keyOf(record)
  if (state.clock !== null && state.clock.key === key) return
  stopClock('the model changed')
  const timer = setInterval(() => {
    void tick()
  }, state.io.tickMs ?? LOCAL_KEEP_ALIVE_TICK_MS)
  timer.unref?.()
  state.clock = { key, timer }
  logForDebugging(`[local-warm] keep-alive clock for ${key} started: a touch every ${Math.round((state.io.tickMs ?? LOCAL_KEEP_ALIVE_TICK_MS) / 1000)}s holds the model for ${LOCAL_KEEP_ALIVE_HOLD}`)
}

async function probe(record: LocalModelRecord, path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }): Promise<unknown> {
  const fetchImpl = state.io.fetchImpl ?? getApiFetch()
  const key = resolveLocalApiKey()
  const response = await fetchWithProviderDeadline(fetchImpl, 'local', init?.timeoutMs ?? state.io.probeTimeoutMs ?? LOCAL_PROBE_TIMEOUT_MS, `${serverRootOf(record)}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': getUserAgent(),
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { authorization: `Bearer ${key.key}` } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  } as RequestInit)
  if (!response.ok) return undefined
  return (await response.json()) as unknown
}

export function keepAliveTouchDue(entry: Record<string, unknown> | undefined, knobs: LocalWarmKnobs, now: number): { due: false; why: string } | { due: true; remainingMs: number } {
  if (entry === undefined) return { due: false, why: 'the model is not loaded' }
  const expires = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : Number.NaN
  const remainingMs = expires - now
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { due: false, why: 'the runner never expires' }
  if (remainingMs > LOCAL_KEEP_ALIVE_HOLD_MS) return { due: false, why: `the server holds it longer (${Math.round(remainingMs / 60_000)}m)` }
  if (knobs.numCtx !== undefined && typeof entry.context_length === 'number' && entry.context_length !== knobs.numCtx) {
    return { due: false, why: `the loaded runner's window (${entry.context_length}) is not this session's (${knobs.numCtx})` }
  }
  return { due: true, remainingMs }
}

export async function tick(): Promise<void> {
  if (state.ticking || state.clock === null) return
  state.ticking = true
  try {
    const clock = state.clock
    const record = localRecordFor(getMainLoopModel())
    if (record === undefined || record.server !== 'ollama' || keyOf(record) !== clock.key) {
      stopClock('the model changed')
      return
    }
    if (!state.live()) return
    const knobs = heldKnobsFor(record)
    if (knobs === undefined) return
    const ps = rec(await probe(record, '/api/ps').catch(() => undefined))
    const models = Array.isArray(ps?.models) ? (ps!.models as unknown[]).map(rec) : []
    const entry = models.find(m => m !== undefined && (m.model === record.id || m.name === record.id))
    const verdict = keepAliveTouchDue(entry, knobs, nowMs())
    if (!verdict.due) return
    const body = { model: record.id, keep_alive: LOCAL_KEEP_ALIVE_HOLD, options: { ...(knobs.numCtx !== undefined ? { num_ctx: knobs.numCtx } : {}), num_batch: knobs.numBatch } }
    const answer = await probe(record, '/api/generate', { method: 'POST', body, timeoutMs: state.io.probeTimeoutMs ?? LOCAL_KEEP_ALIVE_TOUCH_TIMEOUT_MS }).catch(() => undefined)
    if (answer === undefined) {
      logForDebugging(`[local-warm] keep-alive touch of ${record.id} got no answer`)
      return
    }
    state.touches += 1
    state.lastTouch = { model: record.id, keepAlive: LOCAL_KEEP_ALIVE_HOLD, ...(knobs.numCtx !== undefined ? { numCtx: knobs.numCtx } : {}), numBatch: knobs.numBatch, atMs: nowMs() }
    logForDebugging(`[local-warm] keep-alive touch: ${record.id} keep_alive=${LOCAL_KEEP_ALIVE_HOLD} num_ctx=${String(knobs.numCtx)} num_batch=${knobs.numBatch} (was expiring in ${Math.round(verdict.remainingMs / 1000)}s)`)
  } catch (error) {
    logForDebugging(`[local-warm] keep-alive tick failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    state.ticking = false
  }
}

async function settle(): Promise<void> {
  state.settleTimer = null
  if (state.context === null) return
  const model = getMainLoopModel()
  const record = await resolveRecord(model)
  if (state.settleTimer !== null || state.context === null) return
  if (record === undefined || record.server !== 'ollama') {
    cancelInFlight('the model is no longer a local Ollama model')
    stopClock('the model is no longer a local Ollama model')
    return
  }
  if (!state.live()) {
    if (state.liveWaits < LOCAL_WARM_LIVE_WAITS) {
      state.liveWaits += 1
      scheduleSettle()
    } else {
      logForDebugging(`[local-warm] warm of ${record.id} not started: the session is busy or unclaimed`)
    }
    return
  }
  startClock(record)
  const key = keyOf(record)
  if (state.inFlight?.key === key) return
  cancelInFlight('a later switch replaces it')
  if (state.recent !== null && state.recent.key === key && nowMs() - state.recent.at < LOCAL_WARM_REPEAT_QUIET_MS) return
  await warm(record, model)
}

function scheduleSettle(): void {
  if (state.settleTimer !== null) clearTimeout(state.settleTimer)
  const timer = setTimeout(() => {
    settle().catch(error => logForDebugging(`[local-warm] warm not started: ${error instanceof Error ? error.message : String(error)}`))
  }, state.io.settleMs ?? LOCAL_WARM_SETTLE_MS)
  timer.unref?.()
  state.settleTimer = timer
}

export function armLocalWarm(context: LocalWarmContextProvider, opts?: { live?: () => boolean; io?: LocalWarmIo }): () => void {
  disarmLocalWarm()
  state.context = context
  state.live = opts?.live ?? (() => true)
  state.io = opts?.io ?? {}
  state.unsubscribe = subscribeMainLoopModelOverride(() => {
    state.liveWaits = 0
    scheduleSettle()
  })
  state.liveWaits = 0
  scheduleSettle()
  return disarmLocalWarm
}

export function disarmLocalWarm(): void {
  state.unsubscribe?.()
  state.unsubscribe = null
  state.context = null
  if (state.settleTimer !== null) clearTimeout(state.settleTimer)
  state.settleTimer = null
  cancelInFlight('disarmed')
  stopClock('disarmed')
}

export function localWarmFacts(): LocalWarmFacts {
  return {
    armed: state.context !== null,
    clock: state.clock?.key ?? null,
    inFlight: state.inFlight?.wireModel ?? null,
    warmed: [...state.warmed],
    cancelled: state.cancelled,
    failed: state.failed,
    skipped: state.skipped,
    touches: state.touches,
    lastTouch: state.lastTouch,
    lastWarm: state.lastWarm,
  }
}

export function __resetLocalWarmForTest(): void {
  disarmLocalWarm()
  state.live = () => true
  state.io = {}
  state.sent.clear()
  state.warmed.clear()
  state.recent = null
  state.cancelled = 0
  state.failed = 0
  state.skipped = 0
  state.touches = 0
  state.lastTouch = null
  state.lastWarm = null
  state.liveWaits = 0
}
