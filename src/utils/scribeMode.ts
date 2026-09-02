import { logForDebugging } from './debug.js'
import { buildScribeAppend } from './scribe/scribePack.js'
import { routerEnabled } from './router/routerGates.js'
import { resolveScribeSeatModel, seatDoctrineTier } from './model/seatSlots.js'
import { scribeChatroomEnabled, isImplementerRole } from './scribe/scribeGates.js'
import { flagEnv } from '../substrate/flagRegistry.js'

export const SCRIBE_ROUTER_OPTION_VALUE = '__hermes_scribe_router__'

export const SCRIBE_ROUTER_WORKFLOWS_OPTION_VALUE = '__hermes_scribe_router_workflows__'

export function isScribeRouterSentinel(model: string | null | undefined): boolean {
  if (!model) return false
  return (
    model === SCRIBE_ROUTER_OPTION_VALUE ||
    model === `${SCRIBE_ROUTER_OPTION_VALUE}[1m]` ||
    model === SCRIBE_ROUTER_WORKFLOWS_OPTION_VALUE
  )
}

let scribeOn = flagEnv('MERCURY_SCRIBE') === '1'

let scribeModeVersion = 0
const scribeModeListeners = new Set<() => void>()
function notifyScribeMode(): void {
  scribeModeVersion++
  for (const l of scribeModeListeners) l()
}
export function subscribeScribeMode(listener: () => void): () => void {
  scribeModeListeners.add(listener)
  return () => scribeModeListeners.delete(listener)
}
export function getScribeModeVersion(): number {
  return scribeModeVersion
}

export function isScribeModeOn(): boolean {
  return scribeOn
}

let scribeEngagedAtMs: number | null = null

export function getScribeEngagedAtMs(): number | null {
  return scribeEngagedAtMs
}

export function setScribeMode(on: boolean): void {
  if (scribeOn === on) return
  scribeOn = on
  scribeEngagedAtMs = on ? Date.now() : null
  notifyScribeMode()
}

const scribeAppendCache = new Map<string, string>()
function compileScribeAppend(chatroom: boolean): string {
  const slotModel = resolveScribeSeatModel().model
  const cacheKey = `${chatroom ? 'chatroom' : 'base'}|${slotModel}`
  const cached = scribeAppendCache.get(cacheKey)
  if (cached !== undefined) return cached
  let append = ''
  try {
    append = buildScribeAppend({
      chatroom,
      routed: routerEnabled(),
      executorSlot: seatDoctrineTier(slotModel) === 'executor',
    }).trim()
  } catch (err) {
    logForDebugging(`[scribe] pack build failed (chatroom=${chatroom}), appending nothing: ${String(err)}`)
    append = ''
  }
  scribeAppendCache.set(cacheKey, append)
  return append
}

export function getScribeModeAppend(): string {
  return compileScribeAppend(scribeChatroomEnabled())
}

export function getScribeModeSections(): string[] {
  if (!isScribeModeOn() || isImplementerRole()) return []
  const append = compileScribeAppend(scribeChatroomEnabled())
  return append ? [append] : []
}
