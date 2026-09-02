import type { TaskKillReceipt } from '../../Task.js'

// ============================================================================
//  TaskStopTool/stopSettlement — the settled sentence of a stop receipt, in
//  ONE vocabulary on every platform (the F-1.1 ruling: the PROVENANCE is
//  what matters, not the number). A settled stop that Mercury's own kill
//  ended says it was interrupted; the exit code rides as the platform's own
//  detail — POSIX reports the kill signal as 137, win32 reports the code
//  cmd.exe settles on under taskkill /F, 1 — and never decides the words.
//  A process that settled on its own before the stop landed keeps the plain
//  settled sentence: a real exit the model is entitled to read as one.
// ============================================================================

export function settledStopSentence(
  settlement: Pick<TaskKillReceipt, 'exitCode' | 'interrupted'>,
): string {
  if (settlement.exitCode === undefined) return ' It settled.'
  if (settlement.interrupted === true) {
    return ` It was interrupted by the stop (exit code ${settlement.exitCode}).`
  }
  return ` It settled with exit code ${settlement.exitCode}.`
}
