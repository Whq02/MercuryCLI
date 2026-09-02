import type { TaskKillReceipt } from '../../Task.js'


export function settledStopSentence(
  settlement: Pick<TaskKillReceipt, 'exitCode' | 'interrupted'>,
): string {
  if (settlement.exitCode === undefined) return ' It settled.'
  if (settlement.interrupted === true) {
    return ` It was interrupted by the stop (exit code ${settlement.exitCode}).`
  }
  return ` It settled with exit code ${settlement.exitCode}.`
}
