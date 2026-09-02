#!/usr/bin/env bun
import { RecordFold } from '../../src/render-engine/cockpit/recordFold.ts'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('record-fold laws')

{
  const fold = new RecordFold()
  fold.beginRun()
  const a = fold.ingestSettlement('t1.c1', 'uuid-a')
  const b = fold.ingestSettlement('t1.c1', 'uuid-b')
  const c = fold.ingestSettlement('t2.c1', 'uuid-c')
  check('F2 distinct positions and rounds record cleanly', a.outcome === 'recorded' && b.outcome === 'recorded' && c.outcome === 'recorded')
  check('F2 their fold keys are distinct', new Set([a.foldKey, b.foldKey, c.foldKey]).size === 3, `${a.foldKey} ${b.foldKey} ${c.foldKey}`)
  check('F2 no refold fired', fold.refolds() === 0)
}

{
  const reported: string[] = []
  const fold = new RecordFold({ onRefold: (k, first, fresh) => reported.push(`${k} ${first}<-${fresh}`) })
  fold.beginRun()
  fold.ingestSettlement('t1.c1', 'uuid-attempt1-b0')
  fold.ingestSettlement('t1.c1', 'uuid-attempt1-b1')
  const r0 = fold.ingestSettlement('t1.c2', 'uuid-attempt2-b0')
  const r1 = fold.ingestSettlement('t1.c2', 'uuid-attempt2-b1')
  check('F1 the re-mint refolds onto attempt 1, position for position', r0.outcome === 'refolded' && r0.uuid === 'uuid-attempt1-b0' && r1.outcome === 'refolded' && r1.uuid === 'uuid-attempt1-b1')
  check('F6 the tripwire reported both, with coordinates', reported.length === 2 && reported[0]!.includes(':t1:b0:') && reported[1]!.includes(':t1:b1:'), JSON.stringify(reported))
  check('F6 refolds() counts 2', fold.refolds() === 2)

  const r0again = fold.ingestSettlement('t1.c3', 'uuid-attempt3-b0')
  check('F3 a third re-mint still refolds onto the FIRST uuid', r0again.outcome === 'refolded' && r0again.uuid === 'uuid-attempt1-b0')
}

{
  const fold = new RecordFold()
  fold.beginRun()
  fold.ingestSettlement('t1.c1', 'uuid-retracted')
  fold.retractByUuid('uuid-retracted')
  const retry = fold.ingestSettlement('t1.c2', 'uuid-clean-retry')
  check('F4 a retracted settlement’s retry records clean', retry.outcome === 'recorded' && retry.uuid === 'uuid-clean-retry' && fold.refolds() === 0)
}

{
  const fold = new RecordFold()
  fold.beginRun()
  fold.ingestSettlement('t1.c1', 'uuid-run1')
  fold.beginRun()
  const nextRun = fold.ingestSettlement('t1.c1', 'uuid-run2')
  check('F5 the next run’s t1 records (no cross-run fold)', nextRun.outcome === 'recorded' && nextRun.uuid === 'uuid-run2' && fold.refolds() === 0)
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
