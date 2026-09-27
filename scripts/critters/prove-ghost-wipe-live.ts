#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { getProjectDir } from '../../src/utils/sessionStoragePortable.ts'
import { encodeTranscriptLine } from '../../src/utils/sessionStorage/vnext.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetScale } from '../lib/captureDriver.ts'
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
  const projects = getProjectDir(REPO)
  if (!existsSync(projects)) mkdirSync(projects, { recursive: true })
  const path = join(projects, `${SID}.jsonl`)
  const line = {
    isSidechain: false, entrypoint: 'cli', cwd: REPO, sessionId: SID, version: '1.0.0-beta.1',
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
    { atTick: CLICK_TICK, data: '\x1b[<0;30;4M' },
    { atTick: CLICK_TICK + 1, data: '\x1b[<0;30;4m' },
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
    MERCURY_CRITTER: 'clam',
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
const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: Array<{ label: string; grid: Cell[][] }>; sendReceipts?: Array<{ atTick: number }> }
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
t.check('the pre-click mark captured the clam berth', preclick !== undefined && artRows(preclick.grid).length > 0)
const oldRows = preclick ? artRows(preclick.grid) : []
const OLD_TOP = oldRows[0] ?? -1
const ROW_ABOVE = OLD_TOP - 1
const finalRows = artRows(payload.grid)
const newTop = finalRows[0] ?? -1
const departedTop = Array.from({ length: ART_X1 - ART_X0 }, (_, i) => i + ART_X0).filter(x => {
  const before = preclick?.grid[OLD_TOP]?.[x]?.c
  return (before === '▀' || before === '█') && before !== payload.grid[OLD_TOP]?.[x]?.c
})
t.check('the click cycles the square berth and vacates upper-half cells on its crown', OLD_TOP >= 0 && newTop >= 0 && departedTop.length > 0, `old ${oldRows.join(',')} → new ${finalRows.join(',')}; departed ${departedTop.join(',')}`)

type Paint = {
  startTick: number
  endTick: number
  rows: Record<string, number>
  written: Array<[number, number]>
  changes: Array<[number, number, string, string]>
}
type Replay = { ticks: Record<string, Record<string, number>>; frames: Paint[] }
const replayTee = (path: string): { status: number | null; stderr: string; data: Replay } => {
  const replay = spawnSync('/usr/bin/python3', [join(REPO, 'scripts/ui/critter-touched-rows.py'), path, String(COLS), String(ROWS), '--cells', '--frames-json'], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(60_000),
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, BAND_X0: String(ART_X0), BAND_X1: String(ART_X1) },
  })
  return { status: replay.status, stderr: replay.stderr ?? '', data: replay.status === 0 ? JSON.parse(replay.stdout) as Replay : { ticks: {}, frames: [] } }
}
const cyclePaint = (frames: Paint[], releaseTick: number, departed: Paint['changes']): Paint | undefined =>
  departed.length === 0 ? undefined : frames.find(frame => frame.startTick >= releaseTick && departed.every(([x, y, before, after]) =>
    frame.changes.some(([cx, cy, cb, ca]) => cx === x && cy === y && cb === before && ca === after)))
const wipeCovers = (paint: Paint | undefined, departed: Paint['changes']): boolean =>
  paint !== undefined && departed.length > 0 && departed.every(([x, y]) => paint.written.some(([wx, wy]) => wx === x && wy === y - 1))
const teeChunk = (tick: number, text: string): Buffer => {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header.writeUInt32BE(tick, 0)
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}
const witnessDepartures: Paint['changes'] = Array.from({ length: 5 }, (_, i) => [30 + i, 3, '▀', '▄'])
for (const wipe of [true, false]) {
  const path = join(SCRATCH, wipe ? 'witness.tee' : 'missing-wipe.tee')
  writeFileSync(path, Buffer.concat([
    teeChunk(1, '\x1b[H\x1b[4;31H▀▀▀▀▀\x1b[40;1H'),
    teeChunk(36, '\x1b[H\x1b[5;30H▀▀▀▀▀▀\x1b[40;1H'),
    teeChunk(37, '\x1b[H\x1b[31m\x1b[4;31H▀▀▀▀▀\x1b[40;1H'),
    teeChunk(37, '\x1b[H\x1b[4;31H▄▄▄▄▄'),
    teeChunk(38, `${wipe ? '\x1b[3;31H     ' : ''}\x1b[40;1H`),
    teeChunk(39, '\x1b[H\x1b[3;31H     \x1b[40;1H'),
  ]))
  const control = replayTee(path)
  const paint = cyclePaint(control.data.frames, 37, witnessDepartures)
  t.check(`${wipe ? 'witness' : 'poison'}: only the glyph-changing paint owns the cycle, even across read ticks`, control.status === 0 && paint?.startTick === 37 && paint.endTick === 38 && paint.changes.length === 5)
  t.check(wipe ? 'the complete paint retains every departing cell and its neighbour write' : 'a missing wipe stays red even when a later paint touches the same neighbours', wipeCovers(paint, witnessDepartures) === wipe)
}
const departures: Paint['changes'] = departedTop.map(x => [x, OLD_TOP, preclick!.grid[OLD_TOP]![x]!.c, payload.grid[OLD_TOP]![x]!.c])
const replay = replayTee(tee)
t.check('the tee replays (python3 + pyte)', replay.status === 0, replay.stderr.slice(0, 300))
const byTick = new Map(Object.entries(replay.data.ticks).map(([tick, rows]) => [Number(tick), new Map(Object.entries(rows).map(([row, count]) => [Number(row), count]))]))
t.check(`the replay yielded ticks (${byTick.size})`, byTick.size > 5)
const rowsAt = (tick: number, y: number): number => byTick.get(tick)?.get(y) ?? 0
const sumAt = (tick: number): number => [...(byTick.get(tick)?.values() ?? [])].reduce((a, b) => a + b, 0)

const CLICK_AT = payload.sendReceipts?.[1]?.atTick ?? Number.POSITIVE_INFINITY
const releaseTick = payload.sendReceipts?.[2]?.atTick ?? Number.POSITIVE_INFINITY
const cycle = cyclePaint(replay.data.frames, releaseTick, departures)
const cycleTick = cycle?.endTick
t.check('a tick after the click rewrites the vacated rows (the cycle landed in the tee)', cycle !== undefined, `release ${releaseTick}; paint ${cycle?.startTick}..${cycleTick}; ticks ${[...byTick.keys()].join(',')}`)
const aboveCells = cycle?.rows[ROW_ABOVE] ?? 0
if (POISON) {
  t.check(`POISON: the cycle tick never touches the row above the old top run (row ${ROW_ABOVE}: ${aboveCells} cells)`, aboveCells === 0)
} else {
  t.check(`the cycle tick re-emits the row above the old top run (row ${ROW_ABOVE}: ${aboveCells} cells in the art's columns — the crown's slivers)`, wipeCovers(cycle, departures) && aboveCells >= departedTop.length, `${aboveCells} for ${departedTop.length} departed cells`)
}
const BOOT_TICKS = Math.round(8 * vshotBudgetScale())
const wholeFrame = (tk: number): boolean => (byTick.get(tk)?.size ?? 0) >= ROWS
const preTicks = [...byTick.keys()].filter(tk => tk < CLICK_AT && tk > BOOT_TICKS && !wholeFrame(tk))
const preAbove = preTicks.filter(tk => rowsAt(tk, ROW_ABOVE) > 0)
t.check(`no tick before the click touches that row (${preTicks.length} ticks — blink and sway edges)`, preAbove.length === 0, preAbove.join(','))
const edgeTick = preTicks.reduce((best, tk) => (sumAt(tk) > sumAt(best) ? tk : best), preTicks[0] ?? 0)
console.log(`  · cycle tick ${cycleTick}: ${cycleTick !== undefined ? sumAt(cycleTick) : 0} cells in the art's columns (row ${ROW_ABOVE}: ${aboveCells}); largest pre-click edge tick ${edgeTick}: ${sumAt(edgeTick)} cells, rows ${[...(byTick.get(edgeTick)?.keys() ?? [])].sort((a, b) => a - b).join(',')}`)

t.finish(POISON ? 'GHOST-WIPE-LIVE (poison)' : 'GHOST-WIPE-LIVE')
