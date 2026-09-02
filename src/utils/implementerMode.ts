// ============================================================================
//  Implementer mode — the BACK-process persona toggle for Scribe Mode
//  "Amanuensis". Mirrors scribeMode.ts: the compiled
//  Implementer append (buildImplementerAppend) is appended to the system prompt by
//  constants/prompts.ts → getSystemPrompt(), composed AFTER the always-on
//  default wrapper + honesty/safety floor it never weakens.
//
//  Role-scoped: the on/off state initializes from MERCURY_IMPLEMENTER at module
//  load (the daemon spawns the long-lived Implementer process with
//  MERCURY_IMPLEMENTER=1, Phase 4). getImplementerModeSections() is
//  a no-op when the role env is absent — byte-identical OFF.
// ============================================================================
import { routerEnabled } from './router/routerGates.js'
import { getLspPackEvidenceText } from '../services/lsp/mercuryLsp.js'
import { logForDebugging } from './debug.js'
import { isScribeModeOn } from './scribeMode.js'
import { buildImplementerAppend } from './scribe/implementerPack.js'
import { resolveImplementerSeat, seatDoctrineTier } from './model/seatSlots.js'
import { flagEnv } from '../substrate/flagRegistry.js'

let implementerOn = flagEnv('MERCURY_IMPLEMENTER') === '1'

/** Whether Implementer (back) mode is currently engaged (session-scoped toggle). */
export function isImplementerModeOn(): boolean {
  return implementerOn
}

/** Engage/disengage Implementer mode. Takes effect on the next prompt build. */
export function setImplementerMode(on: boolean): void {
  implementerOn = on
}

// Cache is INPUT-KEYED on the two env-derived selectors (the workflows posture
// MERCURY_IMPLEMENTER_WORKFLOWS + the resolved seat model) — both are
// process-stable in a real child (stamped at spawn), so this stays one compile
// per process; the key closes the old "if slots become runtime-retargetable the
// cache must re-key" caveat and keeps proofs (which flip env in-process) honest.
let implementerAppendCache: { key: string; append: string } | null = null
function compileImplementerAppend(): string {
  // Workflows posture: stamped onto the child spec env by the daemon when the
  // scribe engage armed it (the /model "Scribe + workflows" row).
  const workflowsPosture = flagEnv('MERCURY_IMPLEMENTER_WORKFLOWS') === '1'
  const seatModel = resolveImplementerSeat().model
  // IDE-hands doctrine (MERCURY_LSP): part of the cache key because proofs
  // flip env in-process (the input-keyed-cache invariant above).
  const lspEvidence = getLspPackEvidenceText()
  const routed = routerEnabled()
  const cacheKey = `${workflowsPosture ? 'workflows' : 'base'}|${seatModel}|${lspEvidence ? 'lsp' : 'nolsp'}|${routed ? 'route' : 'noroute'}`
  if (implementerAppendCache?.key === cacheKey) return implementerAppendCache.append
  let append = ''
  try {
    // Posture in, append out: the workflows section, the IDE-evidence splice
    // (off ⇒ null ⇒ byte-identical), the routed-node contract, and the
    // seat tier (router-party P3 — a Sonnet-5 slot swaps in the tighter
    // executor doctrine; an orchestrator slot keeps the authored base) all
    // resolve inside the one builder.
    append = buildImplementerAppend({
      workflows: workflowsPosture,
      lspEvidence,
      routed,
      executorSlot: seatDoctrineTier(seatModel) === 'executor',
    }).trim()
  } catch (err) {
    // Fail-closed: any error → no append → byte-identical bare prompt.
    logForDebugging(`[implementer] pack build failed, appending nothing: ${String(err)}`)
    append = ''
  }
  implementerAppendCache = { key: cacheKey, append }
  return append
}

/** The compiled Implementer behavioral append (raw; gating lives in sections). */
export function getImplementerModeAppend(): string {
  return compileImplementerAppend()
}

/**
 * The Implementer system-prompt sections to splice into getSystemPrompt(): the
 * compiled append when fork && Implementer mode is ON and the pack compiled,
 * else []. OFF ⇒ [] ⇒ byte-identical bare prompt (HARD invariant).
 */
export function getImplementerModeSections(): string[] {
  // Defensive double-persona guard: the Scribe and Implementer appends are mutually
  // exclusive at the splice point. assertSingleRole() catches a both-set ENV mis-spawn,
  // but the booleans are independently flippable (setScribeMode / setImplementerMode),
  // so also refuse the Implementer pack whenever Scribe mode is on. OFF (
  // implementer mode off) ⇒ [] ⇒ byte-identical (no legitimate path is affected — a real
  // Implementer carries MERCURY_IMPLEMENTER only, never MERCURY_SCRIBE).
  if (!isImplementerModeOn() || isScribeModeOn()) return []
  const append = compileImplementerAppend()
  return append ? [append] : []
}
