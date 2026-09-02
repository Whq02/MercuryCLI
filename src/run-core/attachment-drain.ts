// ============================================================================
//  run-core/attachment-drain.ts — T8: mid-turn steering.
//
//  Between tool execution and the next model call, the loop drains queued
//  operator input into the turn as attachments. The rules (prove-runloop-
//  contract STEERING + prove-inputsched-contract QUEUE-LAWS pin them):
//
//  • SCOPING — one shared queue serves the coordinator and every
//    in-process subagent: the main thread (repl_main_thread*/sdk) drains
//    only agentId===undefined commands; a subagent drains ONLY
//    task-notifications addressed to its own agentId — never user
//    prompts, even if someone stamps an agentId on one.
//  • SLASH EXCLUSION — slash commands NEVER drain mid-turn (they need
//    processSlashCommand after the turn settles).
//  • SLEEP PRIORITY FLIP — a turn whose tools included Sleep drains the
//    'later' band instead of 'next' (the wake-up reads its backlog).
//  • QUEUED DEEPTHINK — a queued prompt carrying the keyword raises THIS
//    turn's effort floor (the submission-path scan never sees queued
//    text); the pre-expansion text is scanned so a paste containing the
//    word doesn't trigger.
//  • CONSUME EXACTLY-ONCE — only prompt/task-notification commands
//    convert to attachments; each consumed uuid gets lifecycle 'started'
//    and leaves the queue; the caller records uuids for the at-most-once
//    'completed' settlement after the run returns.
// ============================================================================

export type DrainableCommand = {
  uuid?: string
  mode?: string
  agentId?: string
  value?: unknown
  preExpansionValue?: string
}

export type DrainScope = {
  /** The turn ran the Sleep tool — drain the 'later' band. */
  sleepRan: boolean
  isMainThread: boolean
  agentId: string | undefined
}

/** The scoping + slash-exclusion filter over the queue snapshot. */
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

/** A queued prompt carries the deepthink keyword (pre-expansion text —
 *  the paste guard). */
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

/** Consume the drained commands: lifecycle 'started' + queue removal;
 *  returns the consumed uuids for the caller's settlement ledger. */
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
