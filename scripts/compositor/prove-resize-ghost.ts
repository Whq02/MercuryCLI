#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { resetViewportFloorForTests, viewportFloorLine, viewportFloorLive } from '../../src/ink/viewportFloor.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')

if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — build first (bun run build.ts)')
  process.exit(1)
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const NEEDLE = 'Oasis dark'

type Cell = { c: string }
type Grid = { grid: Cell[][] }
type Stage = { cols: number; rows: number; untilTick: number; grid: Cell[][] }

function rowText(row: Cell[]): string {
  return row.map(c => c.c).join('')
}
function needleCount(grid: Cell[][]): number {
  return grid.filter(row => rowText(row).includes(NEEDLE)).length
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'resize-ghost-'))
const CONFIG_HOME = join(SCRATCH, 'home')
const gridPath = join(SCRATCH, 'walk.grid.json')
const teePath = join(SCRATCH, 'walk.tee.bin')

console.log('resize-ghost — the clear/damage law on the first-run walk (real binary)')
try {
  const cfg = {
    cols: 150,
    rows: 44,
    argv: ['node', BIN],
    sends: [],
    total: 130,
    resizes: [
      { atTick: 45, cols: 80, rows: 30 },
      { atTick: 70, cols: 100, rows: 38 },
      { atTick: 90, cols: 120, rows: 44 },
      { atMs: 21_000, cols: 110, rows: 40 },
      { afterPrevMs: 80, cols: 100, rows: 36 },
      { afterPrevMs: 80, cols: 90, rows: 32 },
      { afterPrevMs: 80, cols: 100, rows: 36 },
      { afterPrevMs: 80, cols: 110, rows: 40 },
      { afterPrevMs: 80, cols: 120, rows: 44 },
    ],
    out: gridPath,
    cwd: SCRATCH,
    readyText: [NEEDLE],
    stableTicks: 8,
  }
  const SETTLED_CHANGES = 3
  const cfgPath = join(SCRATCH, 'walk.cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    VSHOT_TEE: teePath,
  }
  delete env.VSHOT_ACTIVE
  delete env.MERCURY_FULLSCREEN
  delete env.MERCURY_ALT_HELD
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { env, timeout: vshotBudgetMs(180_000), stdio: 'pipe' })
  check('the walk journey captured (vshot exit 0)', res.status === 0, res.stderr?.toString().slice(-300) ?? '')
  if (res.status !== 0) throw new Error('capture failed')

  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid & { stages?: Stage[] }
  const stages = payload.stages ?? []

  const tee = readFileSync(teePath)
  const frames: Array<{ tick: number; bytes: Buffer }> = []
  let off = 0
  while (off + 8 <= tee.length) {
    const tick = tee.readUInt32BE(off)
    const len = tee.readUInt32BE(off + 4)
    off += 8
    frames.push({ tick, bytes: tee.subarray(off, off + len) })
    off += len
  }
  const all = Buffer.concat(frames.map(f => f.bytes)).toString('latin1')
  const altEnterAt = all.indexOf('\x1b[?1049h')
  check('G1 the walk enters the alternate screen (the station host)', altEnterAt >= 0)
  check(
    'G1 not one walk byte on the main screen before the alt entry (scrollback purity)',
    altEnterAt >= 0 && !all.slice(0, altEnterAt).includes(NEEDLE),
  )
  const exits = (all.match(/\x1b\[\?1049l/g) ?? []).length
  check('G3 the journey never leaves the alt screen (zero ?1049l)', exits === 0, `${exits} exits`)

  const changeTicks = stages.map(s => s.untilTick)
  const bytesIn = (from: number, to: number | null): string =>
    Buffer.concat(frames.filter(f => f.tick >= from && (to === null || f.tick < to)).map(f => f.bytes)).toString('latin1')
  const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1
  const erasesAfterFirstResize = countOf(bytesIn(changeTicks[0] ?? 45, null), '\x1b[2J')
  check(
    'G3 every geometry change repaints THROUGH the clear law (erases ≥ settled changes)',
    erasesAfterFirstResize >= SETTLED_CHANGES + 1,
    `${erasesAfterFirstResize} erases for ${SETTLED_CHANGES} settled changes + one burst`,
  )

  check('G2 stage snapshots recorded for every geometry', stages.length === cfg.resizes.length, `${stages.length}`)
  resetViewportFloorForTests()
  stages.forEach((stage, i) => {
    const n = needleCount(stage.grid)
    if (i < SETTLED_CHANGES) {
      const floor = viewportFloorLive(stage.cols, stage.rows)
      if (floor.fits) {
        check(
          `G2 geometry ${stage.cols}x${stage.rows} settled with EXACTLY ONE station frame (no ghost stack)`,
          n === 1,
          `${n} copies of ${JSON.stringify(NEEDLE)} before resize #${i + 1}`,
        )
      } else {
        const painted = stage.grid.map(rowText).filter(r => r.trim() !== '')
        check(
          `G2 geometry ${stage.cols}x${stage.rows} is under the floor: the one line, ZERO station copies`,
          n === 0 && painted.length === 1 && painted[0]!.trim() === viewportFloorLine(stage.cols, stage.rows),
          `${n} copies of ${JSON.stringify(NEEDLE)} · ${painted.length} painted row(s): ${JSON.stringify(painted[0]?.trim() ?? '')}`,
        )
      }
    } else {
      check(`G5 burst event ${i - SETTLED_CHANGES + 1} (${stage.cols}x${stage.rows}) never stacks the station`, n <= 1, `${n} copies`)
    }
  })

  const burstStart = changeTicks[SETTLED_CHANGES]
  const windows: Array<[string, number, number | null]> = []
  for (let i = 0; i < SETTLED_CHANGES; i++) {
    const to = i + 1 < SETTLED_CHANGES ? changeTicks[i + 1]! : burstStart ?? null
    windows.push([`change ${i + 1} (${cfg.resizes[i]!.cols}x${cfg.resizes[i]!.rows})`, changeTicks[i]!, to])
  }
  if (burstStart !== undefined) windows.push(['the burst', burstStart, null])
  for (const [label, from, to] of windows) {
    const bytes = bytesIn(from, to)
    check(`G5 ${label}: exactly ONE contained erase in its window`, countOf(bytes, '\x1b[2J') === 1, `${countOf(bytes, '\x1b[2J')} erases`)
  }
  if (burstStart !== undefined) {
    const burst = bytesIn(burstStart, null)
    check('G5 the burst holds at most ONCE (one holding paint, not one per event)', countOf(burst, '\x1b[?25l') <= 1, `${countOf(burst, '\x1b[?25l')} holds`)
  }
  const afterFirst = bytesIn(changeTicks[0] ?? 45, null)
  check('G6 not one line feed after the first change (a bottom-row LF would scroll the buffer)', countOf(afterFirst, '\n') === 0, `${countOf(afterFirst, '\n')} line feeds`)
  const finalCount = needleCount(payload.grid)
  check('G4 the final grid is single (one station frame at the final geometry)', finalCount === 1, `${finalCount} copies`)
  check(
    'G4 the final geometry is the commanded one',
    payload.grid.length === 44 && payload.grid[0]!.length === 120,
    `${payload.grid[0]?.length}x${payload.grid.length}`,
  )
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n❌ ${failures} RESIZE-GHOST PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL RESIZE-GHOST PROOFS PASS')
