#!/usr/bin/env bun
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

check('§A MercuryFrame renders the applied model chip', frame.includes('renderModelChip('))

check(
  '§B REPRODUCED: MercuryFrame never reads pendingModelSwitch',
  !frame.includes('pendingModelSwitch'),
)

const hits = execFileSync('git', ['grep', '-l', 'pendingModelSwitch', '--', 'src/'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
const displaySurfaces = hits.filter(
  f =>
    (f.startsWith('src/components/') && !f.includes('ModelPicker')) ||
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
