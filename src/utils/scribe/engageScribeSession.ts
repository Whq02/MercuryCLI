// ============================================================================
//  engageScribeSession — the SINGLE imperative write path that pins the
//  foreground session to the Scribe model+effort (claude-fable-5[1m]@xhigh).
// ----------------------------------------------------------------------------
//  WHY THIS EXISTS: scribe mode can turn on via THREE independent paths and only
//  the carousel (shift+tab) would otherwise pin the model — so a `MERCURY_SCRIBE=1`
//  *launched* Scribe silently ran on the default model+effort instead of the
//  Scribe's @xhigh pin — the "the scribe isn't on its pin" friction the
//  operator hit. (Two-tier since D-02a: the Scribe pin owns fable-5[1m]@xhigh,
//  the Implementer opus-5@max.)
//  This helper centralizes the pin so EVERY engage route (carousel + the REPL
//  mount effect for a launched session) shares identical, idempotent, never-
//  clobber pin/restore semantics.
//
//  The pure decision lives in scribeModelPin.ts (unit-testable); this file owns
//  the imperative AppState write + a MODULE-LEVEL restore stash. The stash is
//  module-scoped on purpose: the foreground Scribe is a single process, and the
//  launch (mount-effect) path cannot reach a per-component useRef. Flag-gated:
//  OFF ⇒ both functions are no-ops ⇒ byte-identical behavior.
// ============================================================================
import {
  type ScribePinSnapshot,
  decideScribeRestore,
  decideScribeSessionModel,
} from './scribeModelPin.js'

/**
 * Minimal structural view of the AppState store (src/state/store.ts Store<T>):
 * just the slices the pin reads/writes. Kept structural so this module stays
 * loadable + unit-testable under `bun run` with a fake store.
 */
export type ScribeSessionStore = {
  getState: () => {
    mainLoopModel?: string | null
    mainLoopModelForSession?: string | null
    // AppState.effortValue is EffortValue (= EffortLevel | number); accept the
    // numeric arm so the real AppStateStore satisfies this structural view.
    effortValue?: string | number | undefined
  }
  // The updater is store-agnostic, but a concrete `(prev: AppState) => AppState`
  // updater only unifies with this view when the param/return type is exactly
  // AppState or `any` (function-param contravariance). `any` keeps the view
  // decoupled from AppState while letting the real AppStateStore satisfy it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: (updater: (prev: any) => any) => void
}

// Module-level restore stash. Non-null ⇔ this session currently holds the
// scribe pin (engaged, not yet disengaged). Single-process foreground ⇒ a module
// ref is the right scope (the launch path can't reach a component ref).
let sessionStash: ScribePinSnapshot | null = null

/** Test-only: clear the module stash so independent scenarios don't bleed. */
export function __resetScribeSessionStash(): void {
  sessionStash = null
}

/**
 * Pin the foreground session to the Scribe model+effort. Idempotent + safe to
 * call from any engage route. No-op when: not a Mercury build, the pin isn't
 * applicable, this session is already pinned (stash held), or the live model is
 * already the pin. Captures the pre-pin {model, effort} once for restore.
 */
export function engageScribeSession(store: ScribeSessionStore): void {
  
  // Already engaged this session — a re-mount / double-invoke must not re-stash
  // (module ref updates synchronously, before React state settles).
  if (sessionStash !== null) return
  const st = store.getState()
  const current: ScribePinSnapshot = {
    model: st.mainLoopModelForSession ?? st.mainLoopModel ?? null,
    effort: st.effortValue as ScribePinSnapshot['effort'],
  }
  const decision = decideScribeSessionModel(current)
  if (!decision) return // not applicable, or already on the pin
  sessionStash = decision.snapshot
  store.setState(prev => ({
    ...prev,
    mainLoopModelForSession: decision.next.model,
    effortValue: decision.next.effort,
  }))
}

/**
 * Restore the pre-pin model+effort captured at engage — but ONLY if the session
 * is still on the Scribe pin (don't clobber a manual /model switch the operator
 * made while in scribe mode). Always clears the stash. No-op when nothing
 * was pinned.
 */
export function disengageScribeSession(store: ScribeSessionStore): void {
  
  const st = store.getState()
  const currentModel = st.mainLoopModelForSession ?? st.mainLoopModel ?? null
  const currentEffort = st.effortValue as ScribePinSnapshot['effort']
  const restore = decideScribeRestore(sessionStash, currentModel, currentEffort)
  sessionStash = null
  if (!restore) return
  store.setState(prev => ({
    ...prev,
    mainLoopModelForSession: restore.model,
    effortValue: restore.effort,
  }))
}

/** Is the foreground session currently holding the scribe pin? (stash held) */
export function isScribeSessionPinned(): boolean {
  return sessionStash !== null
}
