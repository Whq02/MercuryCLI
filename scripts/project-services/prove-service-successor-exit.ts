import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const scratch = mkdtempSync(join(tmpdir(), 'service-successor-'))
const { startService, stopService, readRecord, servicesDir, liveServiceChildren } = await import('../../src/services/projectServices/serviceManager.js')
const spec = (marker: string) => ({
  name: 'slot', command: process.execPath, args: ['-e', `process.title = ${JSON.stringify(marker)}; setInterval(() => {}, 1000)`], cwd: scratch,
  readiness: [], readinessMode: 'all' as const, restart: 'never' as const, lifecycle: 'session' as const,
})
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let checks = 0
const check = (label: string, value: unknown, detail = ''): void => { assert(value, `${label}${detail ? ` — ${detail}` : ''}`); checks++; console.log(`PASS ${label}`) }
try {
  const first = await startService({ sessionId: 'successor-proof', spec: spec('first') })
  assert.ok('record' in first, JSON.stringify(first))
  const firstPid = first.record.pid!
  const stoppedEarly = { ...first.record, state: 'stopped' as const, pid: null, startToken: null, explicitStop: true, stoppedAt: Date.now(), updatedAt: Date.now() }
  writeFileSync(join(servicesDir(scratch), 'slot.json'), JSON.stringify(stoppedEarly, null, 2))
  await sleep(20)
  const second = await startService({ sessionId: 'successor-proof', spec: spec('second') })
  assert.ok('record' in second, JSON.stringify(second))
  const secondPid = second.record.pid!
  check('the successor starts under the same name once the earlier record reads stopped (the stop road on Windows clears the record before the child\'s exit is delivered)', secondPid !== firstPid && readRecord(scratch, 'slot')?.pid === secondPid)
  process.kill(firstPid, 'SIGKILL')
  await sleep(600)
  const after = readRecord(scratch, 'slot')
  check("RED on the base — the earlier child's late exit does not touch the successor's record: it stays the successor's pid and state, never `failed` with the old exit (FRC2W-U-34: a switch read `refused · exit 1` against a live server)", after?.pid === secondPid && after.state !== 'failed' && after.lastExitCode === null && after.startedAt === second.record.startedAt, JSON.stringify({ pid: after?.pid, state: after?.state, lastExitCode: after?.lastExitCode }))
  check('the successor is still the live child the manager owns under that name', liveServiceChildren().some(row => row.pid === secondPid))
  const stopped = await stopService(scratch, 'slot')
  check('stopping the name stops the successor, and its record reads stopped with no pid', 'record' in stopped && stopped.record.state === 'stopped' && stopped.record.pid === null && readRecord(scratch, 'slot')?.state === 'stopped')
  const crash = await startService({ sessionId: 'successor-proof', spec: { ...spec('third'), args: ['-e', 'setTimeout(() => process.exit(3), 150)'] } })
  assert.ok('record' in crash)
  await sleep(900)
  const crashed = readRecord(scratch, 'slot')
  check("a child that exits on its own still writes its own record: failed with its exit code (the guard keys on the record's start, not on a cleared pid)", crashed?.state === 'failed' && crashed.lastExitCode === 3 && crashed.pid === null, JSON.stringify({ state: crashed?.state, lastExitCode: crashed?.lastExitCode }))
  console.log(`prove-service-successor-exit: ${checks} checks`)
} finally {
  try { await stopService(scratch, 'slot') } catch {}
  rmSync(scratch, { recursive: true, force: true })
}
