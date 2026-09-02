// ============================================================================
//  Scribe mode — the FRONT-process persona toggle for Scribe Mode "Amanuensis".
//  A runtime-toggled behavioral layer whose compiled
//  mode append (buildScribeAppend) is appended to the system prompt by
//  constants/prompts.ts → getSystemPrompt(), composed AFTER the always-on
//  default wrapper + honesty/safety floor it never weakens.
//
//  Role-scoped: the on/off state initializes from MERCURY_SCRIBE at module load
//  (the daemon/foreground launches the Scribe process with MERCURY_SCRIBE=1; the
//  Phase-5 carousel engages it via setScribeMode). getScribeModeSections() is
//  a no-op when the role env is absent — byte-identical OFF.
// ============================================================================
import { logForDebugging } from './debug.js'
import { buildScribeAppend } from './scribe/scribePack.js'
import { routerEnabled } from './router/routerGates.js'
import { resolveScribeSeatModel, seatDoctrineTier } from './model/seatSlots.js'
import { scribeChatroomEnabled, isImplementerRole } from './scribe/scribeGates.js'
import { flagEnv } from '../substrate/flagRegistry.js'

/**
 * Sentinel option value for the /model picker's "Scribe — two-stream router"
 * entry (W2). NOT a real model id: selecting it runs the Scribe engage sequence
 * (handleModelSelect intercepts it) instead of writing a mainLoopModel; selecting
 * a real model while engaged is the exit. Kept here so modelOptions.ts,
 * ModelPicker.tsx, and PromptInput.tsx share one literal.
 */
export const SCRIBE_ROUTER_OPTION_VALUE = '__hermes_scribe_router__'

/**
 * Sentinel for the gated, default-OFF "Scribe + workflows" sibling — the
 * workflow-capable Implementer variant (scaffolded for a follow-up). Rendered as
 * an honest "planned/gated" entry; never engages anything yet.
 */
export const SCRIBE_ROUTER_WORKFLOWS_OPTION_VALUE = '__hermes_scribe_router_workflows__'

/**
 * Is this model value a Scribe-router sentinel (the router, its [1m] variant, or the
 * gated workflows sibling)? These are picker ACTIONS, not real models — defense in
 * depth so a sentinel can never resolve as the API model (a bug once wrote one to
 * mainLoopModel; ignoring it here self-heals a stuck session ⇒ default model).
 */
export function isScribeRouterSentinel(model: string | null | undefined): boolean {
  if (!model) return false
  return (
    model === SCRIBE_ROUTER_OPTION_VALUE ||
    model === `${SCRIBE_ROUTER_OPTION_VALUE}[1m]` ||
    model === SCRIBE_ROUTER_WORKFLOWS_OPTION_VALUE
  )
}

let scribeOn = flagEnv('MERCURY_SCRIBE') === '1'

// Module-state toggles are invisible to React (the keybinding-gotchas class) —
// a version counter + listener set lets UI (the lanes rail's CHAT feed) follow
// a mid-session engage via useSyncExternalStore. Bumped by every setter below.
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

/** Whether Scribe (front) mode is currently engaged (session-scoped toggle). */
export function isScribeModeOn(): boolean {
  return scribeOn
}

// Engage EPOCH: the cockpit CHAT glance tails the
// scribe team's inbox FILES, which persist across sessions — without a boundary
// it rendered 18-day-old envelopes as the live conversation. Each engage stamps
// the epoch; glance surfaces show only bus traffic from AFTER it.
let scribeEngagedAtMs: number | null = null

/** When the CURRENT scribe engagement began (ms epoch), or null when off. */
export function getScribeEngagedAtMs(): number | null {
  return scribeEngagedAtMs
}

/** Engage/disengage Scribe mode. Takes effect on the next system-prompt build. */
export function setScribeMode(on: boolean): void {
  if (scribeOn === on) return
  scribeOn = on
  scribeEngagedAtMs = on ? Date.now() : null
  notifyScribeMode()
}

// Per-mode, SLOT-KEYED compile cache — slot-correct by construction: chatroom
// (#47) selects a different pack variant, and since the
// scribe seat's RESOLVED model can change MID-SESSION (a persisted-slot
// reslot), so the tier-overlay input joins the cache key — a reslot recompiles
// against the new tier, an unchanged slot stays cached. The default (chatroom
// OFF, orchestrator pin) slot compiles the unchanged base append ⇒
// byte-identical to before.
const scribeAppendCache = new Map<string, string>()
function compileScribeAppend(chatroom: boolean): string {
  // Seat tier (router-party P3): the Opus-authored doctrine adapts to the
  // RESOLVED scribe slot (env pin > persisted slot > opus pin, validated) —
  // an executor-tier (Sonnet-5) slot gets the tighter scribe-scope doctrine;
  // orchestrator-tier (the default pin) keeps the authored base.
  const slotModel = resolveScribeSeatModel().model
  const cacheKey = `${chatroom ? 'chatroom' : 'base'}|${slotModel}`
  const cached = scribeAppendCache.get(cacheKey)
  if (cached !== undefined) return cached
  let append = ''
  try {
    // Routing (MERCURY_ROUTER, env-derived + process-stable like chatroom, so
    // the per-mode cache stays slot-correct): the Scribe plans through
    // RouteWork.
    append = buildScribeAppend({
      chatroom,
      routed: routerEnabled(),
      executorSlot: seatDoctrineTier(slotModel) === 'executor',
    }).trim()
  } catch (err) {
    // Fail-closed: any error → no append → byte-identical bare prompt.
    logForDebugging(`[scribe] pack build failed (chatroom=${chatroom}), appending nothing: ${String(err)}`)
    append = ''
  }
  scribeAppendCache.set(cacheKey, append)
  return append
}

/** The compiled Scribe behavioral append (raw content; gating lives in sections). */
export function getScribeModeAppend(): string {
  return compileScribeAppend(scribeChatroomEnabled())
}

/**
 * The Scribe system-prompt sections to splice into getSystemPrompt(): the
 * compiled append when fork && Scribe mode is ON and the pack compiled, else [].
 * OFF (mode off) ⇒ [] ⇒ byte-identical bare prompt (HARD invariant).
 * In chatroom mode (scribeChatroomEnabled()) the append is the v3 peer-chat pack.
 */
export function getScribeModeSections(): string[] {
  // Defensive double-persona guard (mirrors getImplementerModeSections' !isScribeModeOn()):
  // a process tagged the Implementer at the env level (MERCURY_IMPLEMENTER=1) must never emit
  // the Scribe pack even if scribeOn got flipped — the two persona appends stay mutually
  // exclusive at the splice point regardless of how the booleans were set. assertSingleRole()
  // catches a both-set ENV mis-spawn; this also covers a stray setScribeMode(true) inside an
  // Implementer process. OFF (mode off) ⇒ [] ⇒ byte-identical.
  if (!isScribeModeOn() || isImplementerRole()) return []
  const append = compileScribeAppend(scribeChatroomEnabled())
  return append ? [append] : []
}
