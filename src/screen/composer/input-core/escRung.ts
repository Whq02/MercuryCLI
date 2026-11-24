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
      return 'esc again re-sends the interrupt'
    default:
      return ''
  }
}
