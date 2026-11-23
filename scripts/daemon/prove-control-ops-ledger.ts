#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'control-ops-ledger-'))
const DEBUG_LOG = join(scratch, 'debug.txt')
process.argv.push(`--log-file=${DEBUG_LOG}`)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

const { concourseControlOpsPath, readConcourseControlOps, recordConcourseControlOp } = await import(
  '../../src/daemon/concourse-workers/concourseDispatch.js'
)
const { flushDebugLogs } = await import('../../src/platform/logs/debugLog.js')

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const path = concourseControlOpsPath(scratch)
const row = (id: string, atMs: number | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientOpId: id,
  action: 'interrupt',
  sessionId: 's-1',
  outcome: 'applied',
  atMs,
  ...extra,
})
const applied = (id: string, atMs: number) => ({
  clientOpId: id,
  action: 'interrupt',
  sessionId: 's-1',
  outcome: 'applied' as const,
  atMs,
})

try {
  section('(1) a ledger whose ops is null reads as empty, and the next record survives')
  {
    writeFileSync(path, JSON.stringify({ version: 1, ops: null }))
    let read: unknown
    try {
      read = readConcourseControlOps(scratch)
    } catch (e) {
      read = `threw: ${e}`
    }
    check(
      'the read answers an empty ledger, never null',
      typeof read === 'object' && read !== null && Object.keys(read as object).length === 0,
      String(read) + ' — readConcourseControlOps in src/daemon/concourse-workers/concourseDispatch.ts must return an empty object when the ledger ops field is null',
    )
    let recorded = ''
    try {
      recordConcourseControlOp(applied('op-1', 10), scratch)
      recorded = 'ok'
    } catch (e) {
      recorded = String(e)
    }
    check('recording over the null ledger survives', recorded === 'ok', recorded + ' — recordConcourseControlOp in src/daemon/concourse-workers/concourseDispatch.ts must tolerate a ledger whose ops is null')
    const after = readConcourseControlOps(scratch)
    check('the new row is on the ledger', after['op-1']?.atMs === 10, JSON.stringify(after) + ' — recordConcourseControlOp in src/daemon/concourse-workers/concourseDispatch.ts must write the new row into the ledger file')
  }

  section('(2) rows that fail their shape are dropped and the file is named once')
  {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        ops: {
          'op-good-a': row('op-good-a', 100),
          'op-good-b': row('op-good-b', 200),
          'op-no-at': row('op-no-at', undefined),
          'op-at-string': row('op-at-string', '300' as unknown as number),
          'op-foreign-key': row('op-other-id', 400),
          'op-bad-outcome': row('op-bad-outcome', 500, { outcome: 'exploded' }),
          'op-null': null,
          'op-string': 'nope',
        },
      }),
    )
    const read = readConcourseControlOps(scratch)
    const keys = Object.keys(read).sort()
    check(
      'only the two whole rows survive the read',
      keys.length === 2 && keys[0] === 'op-good-a' && keys[1] === 'op-good-b',
      keys.join(',') + ' — readConcourseControlOps in src/daemon/concourse-workers/concourseDispatch.ts must drop rows with no numeric atMs, a key different from clientOpId, an unknown outcome, or a non-object value',
    )
    const replay = read['op-good-a']
    check(
      'a surviving row carries its identity, action, session, outcome and time',
      replay?.clientOpId === 'op-good-a' &&
        replay.action === 'interrupt' &&
        replay.sessionId === 's-1' &&
        replay.outcome === 'applied' &&
        replay.atMs === 100,
      JSON.stringify(replay) + ' — readConcourseControlOps in src/daemon/concourse-workers/concourseDispatch.ts must return surviving rows with all five fields intact',
    )
    readConcourseControlOps(scratch)
    readConcourseControlOps(scratch)
    await flushDebugLogs()
    const named = readFileSync(DEBUG_LOG, 'utf8')
      .split('\n')
      .filter(l => l.includes(path) && l.includes('not decodable'))
    check('the file is named once across three reads', named.length === 1, `${named.length} line(s) — readConcourseControlOps in src/daemon/concourse-workers/concourseDispatch.ts must log the not decodable line once per path per process (nameControlOpLedger)`)
    const { readStoreRecoveryEvents } = await import('../../src/platform/substrate/storeRecovery.ts')
    const refusedRows = async () => (await readStoreRecoveryEvents()).filter(e => e.kind === 'refused' && e.store === 'concourse-control-ops' && e.path === path)
    let refused = await refusedRows()
    for (let i = 0; i < 40 && refused.length < 1; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      refused = await refusedRows()
    }
    check(
      'the file is named ONCE on the recovery ledger in this process — the first refusal of (1), and no second row for the dropped rows of (2) on the same path (the per-path latch the debug line already has), bytes left in place',
      refused.length === 1 && refused[0]!.reason === 'not decodable as an applied-ops ledger, read as empty' && refused[0]!.quarantinePath === null,
      `${refused.length} row(s): ${JSON.stringify(refused.map(e => e.reason))} — nameControlOpLedger in src/daemon/concourse-workers/concourseDispatch.ts must record one refused event on the recovery ledger per path, with reason as asserted and no quarantine`,
    )
  }

  section('(3) the prune sorts numeric times: the oldest whole row goes, and no row rides a NaN')
  {
    const ops: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) ops[`op-${i}`] = row(`op-${i}`, 1_000 + i)
    ops['op-no-at'] = row('op-no-at', undefined)
    writeFileSync(path, JSON.stringify({ version: 1, ops }))
    recordConcourseControlOp(applied('op-new', 5_000), scratch)
    const after = readConcourseControlOps(scratch)
    const keys = Object.keys(after)
    check(
      'the ledger holds exactly the 200 newest whole rows',
      keys.length === 200 && after['op-new'] !== undefined && after['op-0'] === undefined && after['op-1'] !== undefined,
      `${keys.length} rows; op-0 ${after['op-0'] !== undefined ? 'kept' : 'gone'}; op-new ${after['op-new'] !== undefined ? 'kept' : 'gone'} — the prune in recordConcourseControlOp (src/daemon/concourse-workers/concourseDispatch.ts) must sort by numeric atMs and keep the 200 newest whole rows`,
    )
    check('the row without a time is not on the ledger', after['op-no-at'] === undefined, 'readConcourseControlOps or the prune in recordConcourseControlOp (src/daemon/concourse-workers/concourseDispatch.ts) kept a row with no atMs')
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { ops: Record<string, unknown> }
    check(
      'the republished file carries no undecodable row',
      onDisk.ops['op-no-at'] === undefined && Object.keys(onDisk.ops).length === 200,
      `${Object.keys(onDisk.ops).length} rows on disk — recordConcourseControlOp (src/daemon/concourse-workers/concourseDispatch.ts) must republish only the whole rows it kept`,
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ CONTROL-OPS LEDGER PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
