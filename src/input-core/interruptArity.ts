
export interface InterruptArityDeclarationV1 {
  arity: 1 | 2
  hint?: string
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

export function interruptArityOf(scope: string): InterruptArityResolvedV1 {
  const d = declarations.get(scope)
  return {
    arity: d?.arity === 2 ? 2 : 1,
    hint: d?.hint !== undefined && d.hint !== '' ? d.hint : DEFAULT_HINT,
    windowMs: d?.windowMs !== undefined && d.windowMs > 0 ? d.windowMs : DEFAULT_WINDOW_MS,
  }
}

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

export function disarmInterruptGesture(scope: string): void {
  armedAt.delete(scope)
}


export type EscRungV1 = 'idle' | 'in-flight' | 'interrupting' | 'hard-stopping'

export function escRungOf(facts: { inFlight: boolean; interrupting: boolean; hardStopping: boolean }): EscRungV1 {
  if (!facts.inFlight) return 'idle'
  if (facts.hardStopping) return 'hard-stopping'
  if (facts.interrupting) return 'interrupting'
  return 'in-flight'
}

export function escRungHint(rung: EscRungV1): string {
  switch (rung) {
    case 'in-flight':
      return 'esc interrupts'
    case 'interrupting':
      return 'esc again forces a stop'
    default:
      return ''
  }
}
