
import type { Message } from '../../types/message.js'
import { errorMessage } from '../errors.js'
import type { SetAppState } from '../messageQueueManager.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'
import { evaluateStopAttempt, repromptWithNextAction } from './runStopAdapter.js'
import { supervisorEnabled } from './supervisorGate.js'

export const RUN_STOP_HOOK_ID = 'mercury-run-stop'

const MAX_BLOCKS = 3

export const SUPERVISOR_EVALUATOR_DEADLINE_MS = 10_000

export const RUN_STOP_HOOK_TIMEOUT_MS = 30_000

export const RUN_STOP_REPROMPT =
  'Run-state check — never mention or explain this. The active run is not complete: ' +
  'finish the open work now with tool calls (act on the next concrete action below; retry ' +
  'after errors, gather missing info yourself). Never bypass a permission, approval, ' +
  'capability, or refusal gate. End the turn only when every in-scope deliverable is done ' +
  'and verified, or you are blocked on input only the operator can provide — then state ' +
  'the one blocker plainly. A deliverable that needs a capability, tool, or access you do ' +
  'not have is FINISHED by saying so: name the gap, hand off what remains, and end.'

export async function supervisedStopVerdict(
  messages: readonly Message[],
  signal: AbortSignal | undefined,
  evaluate: typeof evaluateStopAttempt = evaluateStopAttempt,
  deadlineMs: number = SUPERVISOR_EVALUATOR_DEADLINE_MS,
): Promise<true | string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const verdict = await Promise.race([
      evaluate(messages, {
        maxBlocks: MAX_BLOCKS,
        wordingUnfinished: false,
        signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `the run-completion supervisor timed out after ${Math.round(deadlineMs / 1000)}s — this stop proceeded unchecked`,
              ),
            ),
          deadlineMs,
        )
        timer.unref?.()
      }),
    ])
    if (verdict.allowStop) return true
    return repromptWithNextAction(RUN_STOP_REPROMPT, verdict.decision)
  } catch (error) {
    if (error instanceof Error && error.message.includes('run-completion supervisor')) throw error
    throw new Error(
      `the run-completion supervisor failed (${errorMessage(error)}) — this stop proceeded unchecked`,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const engagedSessions = new Set<string>()

export function _resetRunStopHookForTesting(): void {
  engagedSessions.clear()
}

export function registerRunStopHook(setAppState: SetAppState, sessionId: string): string {
  if (engagedSessions.has(sessionId)) return RUN_STOP_HOOK_ID
  engagedSessions.add(sessionId)
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    async (messages, signal) => {
      if (!supervisorEnabled()) {
        try {
          await evaluateStopAttempt(messages, {
            maxBlocks: MAX_BLOCKS,
            wordingUnfinished: false,
            signal,
            recordOnly: true,
          })
        } catch {
        }
        return true
      }
      return supervisedStopVerdict(messages, signal)
    },
    RUN_STOP_REPROMPT,
    { timeout: RUN_STOP_HOOK_TIMEOUT_MS, id: RUN_STOP_HOOK_ID, silent: true },
  )
  return RUN_STOP_HOOK_ID
}
