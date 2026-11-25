#!/usr/bin/env bun

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond ? ' — change capacityDecisionReceipt in src/daemon/switchboard-capacity/capacityCheck.ts so its line ends with the seat count, which wrap-text truncate-middle in src/screen/renderer/wrap-text.ts then keeps' : ''}`)
  if (!cond) failures++
}

const mod = (await import('../../src/daemon/switchboard-capacity/capacityCheck.ts')) as unknown as {
  capacityDecisionReceipt?: (allowed: boolean, seats: number) => string
}
const wrapText = (await import('../../src/screen/renderer/wrap-text.ts')).default

console.log('§1 both arms keep their number through the middle cut')
{
  check('the composer is exported (capacityDecisionReceipt)', typeof mod.capacityDecisionReceipt === 'function')
  const receipt = mod.capacityDecisionReceipt ?? ((): string => '')
  for (const [allowed, name] of [
    [true, 'consent'],
    [false, 'decline'],
  ] as const) {
    const line = receipt(allowed, 6)
    check(`the ${name} receipt carries its number`, line.includes('6 seats'), line)
    for (const w of [38, 30, 24]) {
      const cut = wrapText(line, w, 'truncate-middle')
      check(`${name} @ ${w} columns still delivers the number`, cut.includes('6 seats'), cut)
    }
  }
}

console.log('\n§2 useConcourseAsks failed capacity save paints plain notice and logs detail')
{
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { mock } = await import('bun:test')
  const React = await import('react')
  const scratch = mkdtempSync(join(tmpdir(), 'capacity-save-note-'))
  process.env.MERCURY_CONFIG_DIR = scratch
  delete process.env.NODE_ENV
  try {
    const dbg = await import('../../src/platform/logs/debugLog.ts')
    dbg.enableDebugLogging()
    const dbgPath = dbg.getDebugLogPath()
    const capPath = join(import.meta.dir, '../../src/daemon/switchboard-capacity/capacityCheck.js')
    mock.module(capPath, () => ({
      ...mod,
      needsCapacityAsk: () => true,
      recordCapacityDecision: async () => { throw new Error('EACCES: capacity config locked') },
    }))
    const { useConcourseAsks } = await import('../../src/screen/concourse/screen/useConcourseAsks.ts')
    const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')
    let captured: { tone: string; text: string } | null = null
    let answerFn: ((allowed: boolean) => void) | null = null
    function Probe(): React.ReactNode {
      const asks = useConcourseAsks({
        callbacks: {} as never,
        setGroundPickerOpen: () => {},
        setNote: note => { if (note !== null) captured = note },
      })
      answerFn = asks.answerCapacityAsk
      return null
    }
    const m = await mountOffscreen(React.createElement(Probe), 80, 10)
    try {
      await waitFor(() => answerFn !== null, 3000)
      answerFn!(true)
      await waitFor(() => captured !== null, 3000)
      await dbg.flushDebugLogs()
      const dbgText = (() => { try { return readFileSync(dbgPath, 'utf8') } catch { return '' } })()
      const note = captured as { tone: string; text: string } | null
      check(
        'failed capacity save sets plain warning notice and logs raw error to debug log',
        note !== null &&
          note.tone === 'warning' &&
          note.text === 'capacity answer not saved — the board will ask again next time' &&
          dbgText.includes('EACCES: capacity config locked'),
        `note=${JSON.stringify(note)} | dbg=${JSON.stringify(dbgText.slice(-250))}`,
      )
    } finally {
      m.unmount()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nprove-capacity-receipt-tail: all green' : `\nprove-capacity-receipt-tail: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
