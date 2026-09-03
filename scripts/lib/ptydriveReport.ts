import type { ChildProcess } from 'node:child_process'

export function driverClosed(child: ChildProcess): Promise<void> {
  return new Promise<void>(resolve => child.once('close', () => resolve()))
}

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

export function lastSendMs(sends: readonly string[]): number {
  let last = 0
  for (const s of sends) {
    const m = /^after:.*?:(\d+):/.exec(s) ?? /^(\d+):/.exec(s)
    if (m !== null) last = Math.max(last, Number(m[1]))
  }
  return last
}

export function driveWallSeconds(sends: readonly string[], opts: { tailMs?: number; bootMs?: number } = {}): number {
  const tailMs = opts.tailMs ?? 3000
  const bootMs = opts.bootMs ?? 4000
  return Math.ceil((lastSendMs(sends) + tailMs + bootMs) / 1000)
}
