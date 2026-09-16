import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, option, ROOT } from './viewportFixture.ts'

if (!process.argv.includes('--out')) {
  const scratch = process.argv.includes('--scratch') ? option('--scratch') : realpathSync(tmpdir())
  if (!scratch) throw new Error('Pass --scratch <absolute scratch directory>')
  const world = fixture(scratch)
  let status = 1
  try {
    const out = join(world.root, 'frames')
    const capture = spawnSync(process.execPath, [join(ROOT, 'scripts/ui/capture-viewport.ts'), '--scratch', world.root,
      '--dist', join(ROOT, 'dist/mercury.mjs'), '--out', out, '--label', 'captured'], {
      cwd: ROOT, env: world.env, stdio: 'inherit',
    })
    if (capture.status === 0) {
      const proof = spawnSync(process.execPath, [join(ROOT, 'scripts/ui/prove-boot-lockup-roundtrip.ts'), '--out', out, '--label', 'captured'], {
        cwd: ROOT, env: world.env, stdio: 'inherit',
      })
      status = proof.status ?? 1
    }
  } finally { world.dispose() }
  process.exit(status)
}

type Cell = { c: string; fg?: string; bg?: string; bold?: boolean; rev?: boolean }
type Mark = { label: string; cols: number; rows: number; grid: Cell[][] }
type Capture = { cols: number; rows: number; endReason: string; marks: Mark[] }
const out = option('--out')
const label = option('--label')
const compactLabel = process.argv.includes('--compact-label') ? option('--compact-label') : label
let failed = 0
const check = (name: string, condition: boolean) => {
  console.log(`${condition ? 'ok' : 'FAIL'} ${name}`)
  if (!condition) failed++
}
for (const [cols, rows, prefix] of [[120, 40, label], [80, 24, compactLabel]] as const) {
  const file = join(out, `${prefix}-boot-${cols}x${rows}.json`)
  const payload = JSON.parse(readFileSync(file, 'utf8')) as Capture
  const before = payload.marks?.find(mark => mark.label === 'before')
  const concourse = payload.marks?.find(mark => mark.label === 'concourse')
  const after = payload.marks?.find(mark => mark.label === 'after')
  check(`${cols}x${rows}: every journey mark exists`, !!before && !!concourse && !!after)
  if (!before || !concourse || !after) continue
  const lines = (mark: Mark) => mark.grid.map(row => row.map(cell => cell.c).join(''))
  const beforeLines = lines(before)
  const afterLines = lines(after)
  check(`${cols}x${rows}: both Boot frames are ready`, [beforeLines, afterLines].every(frame => frame.some(line => line.includes('↑↓ choose'))))
  check(`${cols}x${rows}: Concourse is distinct from Boot`, !lines(concourse).some(line => line.includes('↑↓ choose')) && lines(concourse).some(line => line.includes('no sessions running')))
  const start = beforeLines.findIndex(line => line.includes('New Session'))
  check(`${cols}x${rows}: the lockup is above the menu`, start > 0)
  const beforeLockup = before.grid.slice(0, start)
  const afterLockup = after.grid.slice(0, start)
  check(`${cols}x${rows}: lockup cells and colors survive the round trip`, JSON.stringify(beforeLockup) === JSON.stringify(afterLockup))
  check(`${cols}x${rows}: the complete text frame returns unchanged`, beforeLines.join('\n') === afterLines.join('\n'))
  check(`${cols}x${rows}: the rule and wordmark are both present`, beforeLines.some(line => line.includes('(>_)')) && beforeLines.some(line => line.includes('██▄██')))
  check(`${cols}x${rows}: all physical cells are present`, [before, concourse, after].every(mark => mark.grid.length === rows && mark.grid.every(row => row.length === cols)))
}
console.log(`Boot round trip: ${failed} failed`)
process.exitCode = failed ? 1 : 0
