#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { encodeTranscriptLine } from '../../src/utils/sessionStorage/vnext.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const BIN = process.env['MERCURY_GHOST_WIPE_BIN'] ?? join(REPO, 'dist', 'mercury.mjs')
const POISON = process.argv.includes('--poison')
const COLS = 120
const ROWS = 40
const CLICK_TICK = 36
const SCRATCH = mkdtempSync(join(tmpdir(), 'ghost-wipe-live-'))
const CONFIG_HOME = resolveProofHome([REPO])
const SID = '00000000-aaaa-bbbb-cccc-0000000ab1e5'

{
  const projects = join(CONFIG_HOME, 'projects', sanitizePath(REPO))
  if (!existsSync(projects)) mkdirSync(projects, { recursive: true })
  const path = join(projects, `${SID}.jsonl`)
  const line = {
    isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: REPO, sessionId: SID, version: '1.0.0-beta.1',
    gitBranch: 'main', parentUuid: null, type: 'user', message: { role: 'user', content: 'boot into the repl' },
    uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-06-19T10:00:01.000Z',
  }
  writeFileSync(path, encodeTranscriptLine(path, line).line)
}

const out = join(SCRATCH, 'drive.json')
const tee = join(SCRATCH, 'drive.tee')
const cfg = {
  argv: ['node', BIN, '--resume', SID],
  sends: [
    { atTick: CLICK_TICK - 2, data: '', mark: 'preclick' },
    { atTick: CLICK_TICK, data: '\x1b[<0;30;8M' },
    { atTick: CLICK_TICK + 1, data: '\x1b[<0;30;8m' },
  ],
  total: 52,
  cols: COLS,
  rows: ROWS,
  out,
  cwd: REPO,
  title: 'ghost-wipe-live',
}
const cfgPath = join(SCRATCH, 'drive.vshot.json')
writeFileSync(cfgPath, JSON.stringify(cfg))
const res = spawnSync('/usr/bin/python3', [join(REPO, 'scripts/ui/vshot.py'), cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(120_000),
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_CRITTER: 'jellyfish',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    VSHOT_TEE: tee,
  },
})
t.check('the drive booted and captured (vshot exit 0)', res.status === 0, (res.stderr ?? '').slice(0, 300))

type Cell = { c: string }
type Grid = { cols: number; rows: number; grid: Cell[][] }
const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: Array<{ label: string; grid: Cell[][] }> }
const ART_X0 = 24
const ART_X1 = 50
const artRows = (g: Cell[][]): number[] => {
  const rows: number[] = []
  for (let y = 0; y < 18; y++) {
    const row = g[y] ?? []
    for (let x = ART_X0; x < ART_X1; x++) {
      const ch = row[x]?.c ?? ' '
      if (ch === '▀' || ch === '▄' || ch === '█') { rows.push(y); break }
    }
  }
  return rows
}
const preclick = payload.marks?.find(m => m.label === 'preclick')
t.check('the pre-click mark captured the jellyfish berth', preclick !== undefined && artRows(preclick.grid).length > 0)
const oldRows = preclick ? artRows(preclick.grid) : []
const OLD_TOP = oldRows[0] ?? -1
const ROW_ABOVE = OLD_TOP - 1
const finalRows = artRows(payload.grid)
const newTop = finalRows[0] ?? -1
t.check(`the click cycled the critter: the top run dropped (jellyfish top row ${OLD_TOP} → clam top row ${newTop})`, OLD_TOP >= 0 && newTop > OLD_TOP, `old ${oldRows.join(',')} → new ${finalRows.join(',')}`)

const replay = spawnSync('/usr/bin/python3', [join(REPO, 'scripts/ui/critter-touched-rows.py'), tee, String(COLS), String(ROWS), '--cells'], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(60_000),
  env: { ...process.env, BAND_X0: String(ART_X0), BAND_X1: String(ART_X1) },
})
t.check('the tee replays (python3 + pyte)', replay.status === 0, (replay.stderr ?? '').slice(0, 300))
const byTick = new Map<number, Map<number, number>>()
for (const line of (replay.stdout ?? '').split('\n')) {
  const m = /^f\d+ tick=(\d+) bytes=\d+ rows\[(.*)\]$/.exec(line)
  if (!m) continue
  const tick = Number(m[1])
  const rows = byTick.get(tick) ?? new Map<number, number>()
  for (const part of m[2]!.split(' ').filter(Boolean)) {
    const [y, n] = part.split(':').map(Number) as [number, number]
    rows.set(y, (rows.get(y) ?? 0) + n)
  }
  byTick.set(tick, rows)
}
t.check(`the replay yielded ticks (${byTick.size})`, byTick.size > 5)
const rowsAt = (tick: number, y: number): number => byTick.get(tick)?.get(y) ?? 0
const sumAt = (tick: number): number => [...(byTick.get(tick)?.values() ?? [])].reduce((a, b) => a + b, 0)

const cycleTick = [...byTick.keys()].filter(tk => tk >= CLICK_TICK).sort((a, b) => a - b).find(tk => rowsAt(tk, OLD_TOP) > 0 || rowsAt(tk, OLD_TOP + 1) > 0)
t.check('a tick after the click rewrites the vacated rows (the cycle landed in the tee)', cycleTick !== undefined, `ticks ${[...byTick.keys()].join(',')}`)
const aboveCells = cycleTick !== undefined ? rowsAt(cycleTick, ROW_ABOVE) : 0
if (POISON) {
  t.check(`POISON: the cycle tick never touches the row above the old top run (row ${ROW_ABOVE}: ${aboveCells} cells)`, aboveCells === 0)
} else {
  t.check(`the cycle tick re-emits the row above the old top run (row ${ROW_ABOVE}: ${aboveCells} cells in the art's columns — the crown's slivers)`, aboveCells >= 5, String(aboveCells))
}
const preTicks = [...byTick.keys()].filter(tk => tk < CLICK_TICK && tk > 8)
const preAbove = preTicks.filter(tk => rowsAt(tk, ROW_ABOVE) > 0)
t.check(`no tick before the click touches that row (${preTicks.length} ticks — blink and sway edges)`, preAbove.length === 0, preAbove.join(','))
const edgeTick = preTicks.reduce((best, tk) => (sumAt(tk) > sumAt(best) ? tk : best), preTicks[0] ?? 0)
console.log(`  · cycle tick ${cycleTick}: ${cycleTick !== undefined ? sumAt(cycleTick) : 0} cells in the art's columns (row ${ROW_ABOVE}: ${aboveCells}); largest pre-click edge tick ${edgeTick}: ${sumAt(edgeTick)} cells, rows ${[...(byTick.get(edgeTick)?.keys() ?? [])].sort((a, b) => a - b).join(',')}`)

t.finish(POISON ? 'GHOST-WIPE-LIVE (poison)' : 'GHOST-WIPE-LIVE')
