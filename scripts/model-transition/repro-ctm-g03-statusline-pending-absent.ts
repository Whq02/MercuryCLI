#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-g03-statusline-pending-absent.ts —
//  expect-red driver (bind defect D3: the statusline never projects
//  a pending model switch).
//
//  Mechanism under test: a queued switch lives in ONE non-persisted slot
// The standing statusline
//  (MercuryFrame) renders the APPLIED model chip only — it has no read of
//  pendingModelSwitch at all, so a parked "current → next" transition is
//  invisible everywhere except inside the /model picker while it is open.
//  This is an ABSENT-CONSUMER defect: the honest red is the structural
//  absence (the component provably cannot project what it never reads);
//  the green proof at fix time is the rendered 80/120 capture (L28).
//
//    §A the applied chip site exists (renderModelChip in MercuryFrame)
//    §B DEFECT: MercuryFrame contains zero pendingModelSwitch reads
//    §C the ONLY React consumers of pendingModelSwitch today are the REPL
//       settlement effect and the /model picker — no standing surface
//
//  Exit 0 = defect REPRODUCED.
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const frame = readFileSync(join(ROOT, 'src/components/MercuryFrame.tsx'), 'utf8')

// §A — the applied chip site exists.
check('§A MercuryFrame renders the applied model chip', frame.includes('renderModelChip('))

// §B — DEFECT: zero pendingModelSwitch reads in the standing statusline.
check(
  '§B REPRODUCED: MercuryFrame never reads pendingModelSwitch',
  !frame.includes('pendingModelSwitch'),
)

// §C — the sweep: React consumers of pendingModelSwitch across src/. Expected
// today: the REPL settlement effect (+ its comment) and the /model picker
// pending row — no standing statusline/banner surface.
const hits = execFileSync('git', ['grep', '-l', 'pendingModelSwitch', '--', 'src/'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
const displaySurfaces = hits.filter(
  f =>
    (f.startsWith('src/components/') && !f.includes('ModelPicker')) ||
    // The ONE displayed-session-model owner (frame/deck/boot-card/monitor all
    // render through it) — a pending read HERE is a standing projection.
    f === 'src/hooks/useDisplayedSessionModel.ts',
)
check(
  '§C REPRODUCED: no standing display surface consumes pendingModelSwitch',
  displaySurfaces.length === 0,
  `consumers today: ${hits.join(', ')}`,
)

console.log(
  failed === 0
    ? '\n REPRODUCED — G03 red recorded (statusline blind to the pending switch)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
