#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'

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
    sends: [{ requireAwait: true, awaitText: NEEDLE, minTick: 25, awaitSettleTicks: 10, data: '', mark: 'station' }],
    total: 300,
    resizes: [
      { afterMark: 'station', afterMs: 1000, cols: 80, rows: 30 },
      { afterPrevMs: 5000, cols: 100, rows: 38 },
      { afterPrevMs: 4000, cols: 120, rows: 44 },
      { afterPrevMs: 3000, cols: 110, rows: 40 },
      { afterPrevMs: 80 / vshotBudgetScale(), cols: 100, rows: 36 },
      { afterPrevMs: 80 / vshotBudgetScale(), cols: 90, rows: 32 },
      { afterPrevMs: 80 / vshotBudgetScale(), cols: 100, rows: 36 },
      { afterPrevMs: 80 / vshotBudgetScale(), cols: 110, rows: 40 },
      { afterPrevMs: 80 / vshotBudgetScale(), cols: 120, rows: 44 },
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
    MERCURY_SPLASH: 'off',
  }
  delete env.VSHOT_ACTIVE
  delete env.MERCURY_FULLSCREEN
  delete env.MERCURY_ALT_HELD
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { env, timeout: vshotBudgetMs(180_000), stdio: 'pipe' })
  check('the walk journey captured (vshot exit 0)', res.status === 0, `rebuild dist/mercury.mjs (bun run build.ts) and read scripts/ui/vshot.py, which ran the walk and exited non-zero; its stderr tail: ${res.stderr?.toString().slice(-300) ?? ''}`)
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
  check('G1 the walk enters the alternate screen (the station host)', altEnterAt >= 0, 'no ESC[?1049h was written during the walk; make the first-run station host enter the alternate screen (src/screen/renderer/elements/AlternateScreen.tsx writes the entry)')
  check(
    'G1 not one walk byte on the main screen before the alt entry (scrollback purity)',
    altEnterAt >= 0 && !all.slice(0, altEnterAt).includes(NEEDLE),
    'walk text was written before the alternate-screen entry (or there was no entry); nothing of the station may reach the main screen first',
  )
  const exits = (all.match(/\x1b\[\?1049l/g) ?? []).length
  check('G3 the journey never leaves the alt screen (zero ?1049l)', exits === 0, `${exits} exits; something leaves the alternate screen (ESC[?1049l) during a resize, and the walk must stay in it`)

  const changeTicks = stages.map(s => s.untilTick)
  const bytesIn = (from: number, to: number | null): string =>
    Buffer.concat(frames.filter(f => f.tick >= from && (to === null || f.tick < to)).map(f => f.bytes)).toString('latin1')
  const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1
  const WHOLE_FRAME_HEAD = '\x1b[H\x1b[0m'
  const shrinkErases = env.TERM_PROGRAM === 'Apple_Terminal' ? 1 : 0
  const erasesAfterFirstResize = countOf(bytesIn(changeTicks[0] ?? 45, null), '\x1b[2J')
  const wholeFramesAfterFirstResize = countOf(bytesIn(changeTicks[0] ?? 45, null), WHOLE_FRAME_HEAD)
  check(
    'G3 every geometry change repaints THROUGH the overwrite law (whole frames ≥ settled changes, only Apple Terminal erases on shrink)',
    wholeFramesAfterFirstResize >= SETTLED_CHANGES + 1 && erasesAfterFirstResize === shrinkErases,
    `${wholeFramesAfterFirstResize} whole frames and ${erasesAfterFirstResize} erases for ${SETTLED_CHANGES} settled changes + one burst; a resize must repaint with a whole-frame overwrite (ESC[H ESC[0m) with ${shrinkErases} display erases (ESC[2J) across this journey`,
  )

  check('G2 stage snapshots recorded for every geometry', stages.length === cfg.resizes.length, `${stages.length} stages for ${cfg.resizes.length} resizes; the vshot run (scripts/ui/vshot.py) did not settle at every commanded geometry, so check whether the walk reached the station before the resizes`)
  stages.forEach((stage, i) => {
    const n = needleCount(stage.grid)
    if (i < SETTLED_CHANGES) {
      check(
        `G2 geometry ${stage.cols}x${stage.rows} settled with EXACTLY ONE station frame (no ghost stack)`,
        n === 1,
        `${n} copies of ${JSON.stringify(NEEDLE)} before resize #${i + 1}; the station frame is stacking instead of being overwritten on resize`,
      )
    } else {
      check(`G5 burst event ${i - SETTLED_CHANGES + 1} (${stage.cols}x${stage.rows}) never stacks the station`, n <= 1, `${n} copies; a burst of resizes must not stack station frames`)
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
    const erases = from === changeTicks[0] ? shrinkErases : 0
    check(`G5 ${label}: exactly ONE whole-frame overwrite and ${erases} display erases`, countOf(bytes, WHOLE_FRAME_HEAD) === 1 && countOf(bytes, '\x1b[2J') === erases, `${countOf(bytes, WHOLE_FRAME_HEAD)} whole frames, ${countOf(bytes, '\x1b[2J')} erases; emit one overwrite per settle and an erase on the Apple Terminal shrink only`)
  }
  if (burstStart !== undefined) {
    const burst = bytesIn(burstStart, null)
    check('G5 the burst holds at most ONCE (one holding paint, not one per event)', countOf(burst, '\x1b[?25l') <= 1, `${countOf(burst, '\x1b[?25l')} holds; a resize burst should paint one holding frame, not one per event`)
  }
  const afterFirst = bytesIn(changeTicks[0] ?? 45, null)
  check('G6 not one line feed after the first change (a bottom-row LF would scroll the buffer)', countOf(afterFirst, '\n') === 0, `${countOf(afterFirst, '\n')} line feeds; repaints after a resize must position with cursor moves, not newlines`)
  const finalCount = needleCount(payload.grid)
  check('G4 the final grid is single (one station frame at the final geometry)', finalCount === 1, `${finalCount} copies of the station frame in the final grid; a ghost frame survived the resizes`)
  check(
    'G4 the final geometry is the commanded one',
    payload.grid.length === 44 && payload.grid[0]!.length === 120,
    `${payload.grid[0]?.length}x${payload.grid.length}, expected 120x44; the last entry of cfg.resizes was not applied or the app did not follow it`,
  )
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n❌ ${failures} RESIZE-GHOST PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL RESIZE-GHOST PROOFS PASS')
