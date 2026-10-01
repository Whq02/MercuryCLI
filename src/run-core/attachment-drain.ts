
export type DrainableCommand = {
  uuid?: string
  mode?: string
  agentId?: string
  value?: unknown
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
  const ownsTheQueue = scope.isMainThread && scope.agentId === undefined
  return commands.filter(cmd => {
    if (isSlashCommand(cmd)) return false
    if (ownsTheQueue) return cmd.agentId === undefined
    return cmd.mode === 'task-notification' && cmd.agentId === scope.agentId
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
