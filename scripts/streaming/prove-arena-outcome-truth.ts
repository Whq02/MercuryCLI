#!/usr/bin/env bun
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, driverOutcome, runArtifactArena } from './artifactArena.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the outcome reader over synthetic driver endings')
{
  const report = (ended: string, extra = ''): string => `noise\n{"raw_bytes":42,"raw_reads":3,"sends":2,"unfired":[],"ended":"${ended}","elapsed_ms":900${extra}}\n`
  const good = driverOutcome({ exitCode: 0, signal: null, killedByWall: false, elapsedMs: 1000, driverOut: report('deadline') })
  check('exit 0 + a deadline-ended report is COMPLETE', good.complete && good.reason === null && good.report?.ended === 'deadline', JSON.stringify(good))
  const eof = driverOutcome({ exitCode: 0, signal: null, killedByWall: false, elapsedMs: 1000, driverOut: report('eof') })
  check('exit 0 + an eof-ended report is INCOMPLETE and names the early leave', !eof.complete && /ended by eof/.test(eof.reason ?? ''), JSON.stringify(eof))
  const readError = driverOutcome({ exitCode: 0, signal: null, killedByWall: false, elapsedMs: 1000, driverOut: report('read-error') })
  check('a read-error ending is INCOMPLETE too', !readError.complete && /read-error/.test(readError.reason ?? ''))
  const noReport = driverOutcome({ exitCode: 0, signal: null, killedByWall: false, elapsedMs: 1000, driverOut: 'ptydrive[1.00s] SIGTERM\n' })
  check('exit 0 with NO closing report is INCOMPLETE (the driver was stopped before it could write)', !noReport.complete && /no closing report/.test(noReport.reason ?? ''), JSON.stringify(noReport))
  const crashed = driverOutcome({ exitCode: 1, signal: null, killedByWall: false, elapsedMs: 200, driverOut: 'Traceback (most recent call last):\n  boom\n' })
  check('a non-zero driver exit is INCOMPLETE and quotes the tail', !crashed.complete && /exited 1/.test(crashed.reason ?? '') && /boom/.test(crashed.reason ?? ''), JSON.stringify(crashed))
  const walled = driverOutcome({ exitCode: null, signal: 'SIGKILL', killedByWall: true, elapsedMs: 30000, driverOut: report('deadline') })
  check("the arena's own SIGKILL wall is INCOMPLETE even when a report-shaped line is present", !walled.complete && /wall killed/.test(walled.reason ?? ''), JSON.stringify(walled))
  const signalled = driverOutcome({ exitCode: null, signal: 'SIGTERM', killedByWall: false, elapsedMs: 500, driverOut: '' })
  check('an outside signal is INCOMPLETE and named', !signalled.complete && /died by SIGTERM/.test(signalled.reason ?? ''))
  const legacy = driverOutcome({ exitCode: 0, signal: null, killedByWall: false, elapsedMs: 1000, driverOut: '{"raw_bytes":1,"raw_reads":1,"sends":0,"unfired":[]}\n' })
  check('a report without an ending field (an older driver) folds to deadline and stays complete', legacy.complete && legacy.report?.ended === 'deadline')
}

console.log('§2 the driver on a synthetic child: early exit versus a full deadline')
{
  const scratch = mkdtempSync(join(tmpdir(), 'arena-outcome-'))
  const early = join(scratch, 'early.mjs')
  writeFileSync(early, "process.stdout.write('hello from the child\\n'); setTimeout(() => process.exit(3), 300)\n")
  const lingering = join(scratch, 'lingering.mjs')
  writeFileSync(lingering, "process.stdout.write('Type a prompt\\n'); setInterval(() => {}, 1000)\n")
  const crashing = join(scratch, 'crashing.sh')
  writeFileSync(crashing, '#!/bin/sh\nexit 7\n')
  chmodSync(crashing, 0o755)
  const run = async (dist: string, seconds: number, anchor: { needle: string; atMs: number } | null) =>
    runArtifactArena({ turns: [], sends: ['200:x'], seconds, distPath: dist, anchor })
  const earlyRun = await run(early, 4, null)
  check('a child that exits after 300 ms: the driver reports ended=eof', earlyRun.outcome.report?.ended === 'eof', JSON.stringify(earlyRun.outcome))
  check('…and the arena marks the capture INCOMPLETE with the early-leave reason', !earlyRun.outcome.complete && /before the authored deadline/.test(earlyRun.outcome.reason ?? ''), earlyRun.outcome.reason ?? '')
  check('…well before the 4 s wall (this is the child leaving, not the wall)', earlyRun.outcome.elapsedMs < 3000 && !earlyRun.outcome.killedByWall, String(earlyRun.outcome.elapsedMs))
  check('…while the partial data still parsed as before (nothing is thrown away)', earlyRun.teeLines.length === 0 && earlyRun.driverOut.includes('raw_bytes'))
  const fullRun = await run(lingering, 2, null)
  check('a child that lingers to the deadline: ended=deadline, exit 0, COMPLETE', fullRun.outcome.complete && fullRun.outcome.exitCode === 0 && fullRun.outcome.report?.ended === 'deadline', JSON.stringify(fullRun.outcome))
  check('…and the driver fired its send', fullRun.outcome.report?.sends === 1 && fullRun.sendLog.length === 1)
  const crashRun = await run(crashing, 3, null)
  check('a child that exits 7 at once: INCOMPLETE by eof (the driver survives the child and reports it)', !crashRun.outcome.complete && crashRun.outcome.report?.ended === 'eof', JSON.stringify(crashRun.outcome))
  rmSync(scratch, { recursive: true, force: true })
}

console.log('§3 the real artifact: a deadline-bounded boot reads COMPLETE')
{
  if (!existsSync(DIST)) {
    console.log('  SKIP — dist/mercury.mjs missing (run `bun run build.ts`)')
  } else {
    const real = await runArtifactArena({ turns: [], sends: [], seconds: 8 })
    check('the real arena boot ends on its deadline with exit 0 and a closing report', real.outcome.complete && real.outcome.exitCode === 0 && real.outcome.report?.ended === 'deadline', JSON.stringify(real.outcome))
    check('…and the outcome carries the elapsed drive time', real.outcome.elapsedMs > 0 && (real.outcome.report?.elapsed_ms ?? 0) > 0)
  }
}

console.log(failures === 0 ? '\n✅ arena outcome truth: green' : `\n❌ arena outcome truth: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
