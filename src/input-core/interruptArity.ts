// ============================================================================
//  input-core/interruptArity — THE SURFACE-SCOPED INTERRUPT ARM (operator
//  ruling, voice): in the MAIN chat ONE esc interrupts the
//  running agent; a surface may DECLARE a different esc arity for its own
//  interrupt — Minerva's room is ruled esc-esc (with a hint line) so a
//  stray esc never kills a billed exchange — WITHOUT forking the ladder
//  owner. This module is that declaration seam: a registry of per-scope
//  declarations (default arity 1) and one pure two-press latch every
//  consumer shares. The chat's cancel ladder (useCancelRequest) consumes it
//  for scope 'chat'; a surface declares its own scope and routes its esc
//  press through the same door.
//
//  Contract:
//   • arity 1 (the default) — pressInterrupt fires on EVERY press, no
//     state, no window: the main chat's one-esc law byte-unchanged.
//   • arity 2 — the first press ARMS (fire:false + the hint the caller
//     paints); a second press inside the window FIRES and disarms; a press
//     past the window re-arms (never a stale half-gesture). The window
//     default is the ruled 3-second family (the esc-esc composer clear).
//   • declarations are scoped strings; redeclaring overwrites; the returned
//     undeclare removes only ITS OWN declaration (a stale closure from a
//     replaced declaration is a no-op). Undeclared scopes read arity 1.
// ============================================================================

export interface InterruptArityDeclarationV1 {
  arity: 1 | 2
  /** The line the first press paints while armed (arity 2 only). */
  hint?: string
  /** The arm window in ms (arity 2 only). */
  windowMs?: number
}

export interface InterruptArityResolvedV1 {
  arity: 1 | 2
  hint: string
  windowMs: number
}

export type InterruptPressV1 =
  | { fire: true }
  | { fire: false; hint: string; windowMs: number }

const DEFAULT_WINDOW_MS = 3000
const DEFAULT_HINT = 'esc again interrupts'

const declarations = new Map<string, InterruptArityDeclarationV1>()
const armedAt = new Map<string, number>()

/** Declare a scope's interrupt arity. Returns the undeclare; a closure from
 *  a replaced declaration removes nothing (identity-checked). */
export function declareInterruptArity(
  scope: string,
  declaration: InterruptArityDeclarationV1,
): () => void {
  declarations.set(scope, declaration)
  armedAt.delete(scope)
  return () => {
    if (declarations.get(scope) === declaration) {
      declarations.delete(scope)
      armedAt.delete(scope)
    }
  }
}

/** The resolved declaration — defaults filled, total over any scope. */
export function interruptArityOf(scope: string): InterruptArityResolvedV1 {
  const d = declarations.get(scope)
  return {
    arity: d?.arity === 2 ? 2 : 1,
    hint: d?.hint !== undefined && d.hint !== '' ? d.hint : DEFAULT_HINT,
    windowMs: d?.windowMs !== undefined && d.windowMs > 0 ? d.windowMs : DEFAULT_WINDOW_MS,
  }
}

/**
 * One esc press against a scope's declared arity. Arity 1 fires always;
 * arity 2 arms first (the caller paints the returned hint), fires on the
 * second press inside the window, and re-arms on a press past it.
 */
export function pressInterrupt(scope: string, nowMs: number = Date.now()): InterruptPressV1 {
  const resolved = interruptArityOf(scope)
  if (resolved.arity === 1) return { fire: true }
  const arm = armedAt.get(scope)
  if (arm !== undefined && nowMs - arm <= resolved.windowMs) {
    armedAt.delete(scope)
    return { fire: true }
  }
  armedAt.set(scope, nowMs)
  return { fire: false, hint: resolved.hint, windowMs: resolved.windowMs }
}

/** Drop a half-armed gesture (a surface losing focus mid-arm). */
export function disarmInterruptGesture(scope: string): void {
  armedAt.delete(scope)
}
