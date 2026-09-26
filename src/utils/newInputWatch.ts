import { getDrainableCommands, isOperatorLine, isSlashCommand, subscribeToCommandQueue } from '../input-core/command-queue.js'
import { selectDrainableCommands } from '../run-core/attachment-drain.js'
import type { QueuedCommand } from '../types/textInputTypes.js'

export const NEW_INPUT_REASON = 'new input arrived for this turn (it follows this result)'

export function newInputForTurn(agentId: string | undefined): QueuedCommand | undefined {
  const scope = { sleepRan: false, isMainThread: agentId === undefined, agentId }
  return selectDrainableCommands(getDrainableCommands(false), scope, isSlashCommand).find(
    cmd => cmd.mode === 'prompt' && isOperatorLine(cmd),
  )
}

export function watchForNewInput(agentId: string | undefined, onNewInput: () => void): () => void {
  if (newInputForTurn(agentId) !== undefined) {
    onNewInput()
    return () => undefined
  }
  const stop = subscribeToCommandQueue(() => {
    if (newInputForTurn(agentId) === undefined) return
    stop()
    onNewInput()
  })
  return stop
}
