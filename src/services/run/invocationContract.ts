
type InvocationSurface =
  | 'interactive'
  | 'print'
  | 'sdk'
  | 'worker'
  | 'workflow'
  | 'external'

type TerminalPolicy = 'operator-led' | 'one-shot' | 'client-led' | 'mission-led'

interface InvocationContract {
  surface: InvocationSurface
  terminalPolicy: TerminalPolicy
}

export function resolveInvocationContract(facts: {
  interactive: boolean
  missionArmed: boolean
  querySource?: string
}): InvocationContract {
  const source = facts.querySource ?? ''
  if (facts.interactive) {
    return { surface: 'interactive', terminalPolicy: facts.missionArmed ? 'mission-led' : 'operator-led' }
  }
  if (source === 'sdk') {
    return { surface: 'sdk', terminalPolicy: facts.missionArmed ? 'mission-led' : 'client-led' }
  }
  if (source.startsWith('agent:')) {
    return { surface: 'worker', terminalPolicy: 'one-shot' }
  }
  return { surface: 'print', terminalPolicy: facts.missionArmed ? 'mission-led' : 'one-shot' }
}
