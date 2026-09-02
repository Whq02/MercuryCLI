#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

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
    total: 120,
    argv: ['node', BIN],
    sends: [],
    resizes: [
      { atTick: 45, cols: 80, rows: 30 },
      { atTick: 70, cols: 100, rows: 38 },
      { atTick: 90, cols: 120, rows: 44 },
    ],
    out: gridPath,
    cwd: SCRATCH,
    readyText: [NEEDLE],
    stableTicks: 8,
  }
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

  const resizeTicks = cfg.resizes.map(r => r.atTick)
  const erasesAfterFirstResize = frames
    .filter(f => f.tick >= resizeTicks[0]!)
    .reduce((n, f) => n + (f.bytes.toString('latin1').match(/\x1b\[2J/g) ?? []).length, 0)
  check(
    'G3 every geometry change repaints THROUGH the clear law (erases ≥ resizes)',
    erasesAfterFirstResize >= cfg.resizes.length,
    `${erasesAfterFirstResize} erases for ${cfg.resizes.length} resizes`,
  )

  check('G2 stage snapshots recorded for every geometry', stages.length === cfg.resizes.length, `${stages.length}`)
  stages.forEach((stage, i) => {
    const n = needleCount(stage.grid)
    check(
      `G2 geometry ${stage.cols}x${stage.rows} settled with EXACTLY ONE station frame (no ghost stack)`,
      n === 1,
      `${n} copies of ${JSON.stringify(NEEDLE)} before resize #${i + 1}`,
    )
  })
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
