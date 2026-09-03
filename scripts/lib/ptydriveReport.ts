// scripts/lib/ptydriveReport.ts — the streaming driver's closing report, read
// whole, and the drive wall that follows the schedule.
//
// scripts/streaming/ptydrive.py ends with two writes: when a send never fired,
// "[ptydrive] UNFIRED-SENDS: k of n sends never became due — …" on stderr;
// then one JSON line on stdout ({"raw_bytes","raw_reads","sends","unfired"}).
// Two things kept that report out of an "N/M" detail line:
//   1. A caller that resumed on the child's 'exit' event read its accumulator
//      before the last bytes drained — 'exit' fires on the process, 'close'
//      after every stdio stream has ended. driverClosed() resumes on 'close'.
//   2. A caller's own SIGKILL timer authored in plain milliseconds fires
//      INSIDE the wall once the capture profile stretches the drive (the
//      driver scales --seconds by MERCURY_VSHOT_BUDGET_SCALE; a timer that
//      does not ride vshotBudgetMs kills the driver mid-schedule, and a
//      driver killed from outside writes nothing). The wall and the timer
//      must scale together: vshotBudgetMs(wallSeconds * 1000) + the tail.
// And the wall itself: observed-ready sends (`after:<needle>:<ms>:<text>`) fire
// relative to the moment the needle paints, while --seconds counts from the
// spawn — a boot that paints the needle late pushes the schedule's tail past
// a wall authored as if the needle were on screen at once. driveWallSeconds()
// derives the wall from the schedule: the latest send, plus the longest grab
// the caller takes after it, plus a boot allowance for the needle's arrival.
import type { ChildProcess } from 'node:child_process'

/** Resolve when the driver has exited AND its stdio has drained. */
export function driverClosed(child: ChildProcess): Promise<void> {
  return new Promise<void>(resolve => child.once('close', () => resolve()))
}

/**
 * The detail for an "N/M sends fired" check: the first stuck send by name.
 * Reads the driver's JSON line first (the exact list), then its stderr line,
 * then whatever the driver managed to say before it stopped.
 */
export function unfiredDetail(driverOut: string, tailChars = 300): string {
  const lines = driverOut.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const rec = JSON.parse(line) as { unfired?: unknown }
      if (Array.isArray(rec.unfired)) {
        const unfired = rec.unfired as string[]
        if (unfired.length === 0) return 'the driver reports every send fired'
        const more = unfired.length > 1 ? ` (then ${unfired.length - 1} more)` : ''
        return `${unfired.length} never became due — first stuck: ${unfired[0]}${more}`
      }
    } catch {}
  }
  const stderrLine = lines.find(l => l.includes('UNFIRED-SENDS'))
  if (stderrLine !== undefined) return stderrLine.trim()
  const tail = driverOut.trim().slice(-tailChars)
  return tail.length > 0
    ? `no closing report — the driver's last words: ${tail}`
    : 'no closing report — the driver was stopped before it could write one (an outside kill timer inside the wall?)'
}

/** The authored moment (ms after its needle, or after the spawn) of the latest send. */
export function lastSendMs(sends: readonly string[]): number {
  let last = 0
  for (const s of sends) {
    const m = /^after:.*?:(\d+):/.exec(s) ?? /^(\d+):/.exec(s)
    if (m !== null) last = Math.max(last, Number(m[1]))
  }
  return last
}

/**
 * The drive wall in whole seconds: the latest send + the longest grab the
 * caller takes after it (tailMs) + the allowance for the needle to paint
 * after the spawn (bootMs — a bare boot with the launch splash off paints
 * the Boot face inside it on a cold machine; the capture profile stretches
 * it with the rest of the wall).
 */
export function driveWallSeconds(sends: readonly string[], opts: { tailMs?: number; bootMs?: number } = {}): number {
  const tailMs = opts.tailMs ?? 3000
  const bootMs = opts.bootMs ?? 4000
  return Math.ceil((lastSendMs(sends) + tailMs + bootMs) / 1000)
}
