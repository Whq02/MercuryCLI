
export type DrainableCommand = {
  uuid?: string
  mode?: string
  agentId?: string
  value?: unknown
  preExpansionValue?: string
}

export type DrainScope = {
  sleepRan: boolean
  isMainThread: boolean
  agentId: string | undefined
}

export function selectDrainableCommands<C extends DrainableCommand>(
  commands: C[],
  scope: DrainScope,
  isSlashCommand: (cmd: C) => boolean,
): C[] {
  return commands.filter(cmd => {
    if (isSlashCommand(cmd)) return false
    if (scope.isMainThread) return cmd.agentId === undefined
    return cmd.mode === 'task-notification' && cmd.agentId === scope.agentId
  })
}

export function queuedDeepthinkRequested<C extends DrainableCommand>(
  commands: C[],
  hasKeyword: (text: string) => boolean,
): boolean {
  return commands.some(cmd => {
    if (cmd.mode !== 'prompt') return false
    const text = cmd.preExpansionValue ?? (typeof cmd.value === 'string' ? cmd.value : '')
    return hasKeyword(text)
  })
}

export function consumeDrainedCommands<C extends DrainableCommand>(
  snapshot: C[],
  effects: {
    notifyStarted: (uuid: string) => void
    removeFromQueue: (commands: C[]) => void
  },
): string[] {
  const consumed = snapshot.filter(
    cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
  )
  const uuids: string[] = []
  if (consumed.length > 0) {
    for (const cmd of consumed) {
      if (cmd.uuid) {
        uuids.push(cmd.uuid)
        effects.notifyStarted(cmd.uuid)
      }
    }
    effects.removeFromQueue(consumed)
  }
  return uuids
}
