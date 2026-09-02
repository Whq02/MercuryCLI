#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/probe-resize-matrix.ts — the RESIZE MATRIX probe (the sibling
//  of probe-overflow-matrix).
//
//  Drives the render harness's scenes on the real binary, settles each one,
//  then moves the PTY window — shrink, grow, a burst of six WINCHes 80 ms
//  apart, under the minimum and back, height only, width only — and reads
//  every frame the capture kept (the frame before each move, the marks after
//  it, the final grid) plus the raw byte tee for the resize laws:
//    (a) ONE SETTLED FRAME — exactly one full repaint after the last
//        resize, and the frame holds still afterwards (no late paint);
//    (b) NO GHOST ROWS — the journey never leaves the alternate screen and
//        no line feed rides the settled bytes (a bottom-row LF scrolls the
//        buffer: a ghost row above the frame);
//    (c) NOTHING PAINTED TWICE — a scene's singleton needles paint on at
//        most one row, and no row appears twice that was single before the
//        move (the pre-resize copy under the new one);
//    (d) THE CURSOR AND THE ANCHOR — in a chat the emulated cursor sits at
//        the composer's caret after every settle, and the rows the scene
//        anchors on (its tail, its head, its card) stay on screen;
//    (e) BORDERS CLOSED — the overflow checker (frameChecks.inspect) reads
//        every settled frame at the new size;
//    (f) UNDER THE MINIMUM — one painted row, the product's own line, and
//        the way back repaints the frame the move started from, byte for
//        byte, with the next key live;
//    (g) A BURST IS ONE STORM — one full repaint for six events and at most
//        one holding paint (the byte tee counts them).
//  Every frame's text is dumped under --out beside report.json for the
//  eyeball pass the mechanical checks cannot make.
//
//  A probe, not a gate leg: minutes of PTY boots. Shard it with --scenes and
//  --moves. Captures run one at a time (the scenarios pin process.env for
//  their child and stage sessions under one per-process id).
//
//  Usage: bun scripts/ui/probe-resize-matrix.ts [--scenes a,b] [--moves x,y] [--out dir]
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, RUNTIME_CWD, cleanupScenario, scenario } from './renderScenarios.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { composerCaret, inspect, needleRows, paintedRows, rowsOf, type Grid } from './frameChecks.ts'
import { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS, viewportFloorLine } from '../../src/ink/viewportFloor.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1]! : def
}

// ── the scenes ──────────────────────────────────────────────────────────────

const SHIFT_UP = '\x1b[1;2A'
const DOWN = '\x1b[B'
const PAGE_UP = '\x1b[5~'
const ESC = '\x1b'
/** The composer at rest — the cockpit footer's own words. */
const COMPOSER_AT_REST = '? for shortcuts'
/** A resumed chat's replay notices expire on their own clock a few seconds
 *  after boot and re-lay the bottom block when they go: every chat scene's
 *  first move waits past them (ticks of 200 ms). */
const CHAT_QUIET_TICK = 40
const STREAM_LINE = /rz-stream-line-\d{3}/g
const STREAM_LINES = 100
const streamDeltas = Array.from({ length: STREAM_LINES }, (_, i) => `rz-stream-line-${String(i).padStart(3, '0')}\n`)

type Ready = { text: string; stable?: number; minTick?: number } | { atTick: number }
type KeyExpect = 'composer-echo' | 'selection-moves' | 'closes' | 'changes'
type Scene = {
  name: string
  /** The render harness scenario this scene starts from. */
  base: string
  /** chat: the composer's caret law applies; card: a chat with a modal up. */
  world: 'chat' | 'card' | 'face' | 'board' | 'surface'
  /** Sends after the base's own, before the ready mark. */
  sends?: Record<string, unknown>[]
  /** Drop the base scenario's own sends (its drive speaks another grammar). */
  replaceSends?: boolean
  /** The settled-scene gate the ready mark waits on. */
  ready: Ready
  /** Needles that paint on at most ONE row of a clean frame. */
  once: string[]
  /** Distinct matches of this pattern paint on at most one row each. */
  oncePattern?: RegExp
  /** Needles that must stay on screen through every settled frame. */
  keep: string[]
  /** Needles the FINAL frame must carry (a stream's tail, the composer at rest). */
  keepFinal?: string[]
  /** At least one row of each settled frame matches (a streaming tail attached). */
  keepPattern?: RegExp
  /** The scroll anchor of a scrolled transcript, two tiers. Same-width
   *  moves: the pane's TOP content row at ready (the first row matching
   *  `contentPattern`) is on screen after the settle, exactly — the pin's
   *  coordinate never moved. Width changes rewrap: the prompt rows on screen
   *  at ready (`anchorPattern`, "turn N") are joined by one within three
   *  turns of them — the pooled reflow bound the transcript's own prover
   *  holds. Never a jump to the tail or the head. */
  anchorPattern?: RegExp
  contentPattern?: RegExp
  /** The board's armed row (the '▸ ' row) keeps its identity through every move. */
  armed?: boolean
  /** The scene's content moves on its own (a stream): the frame-identity
   *  laws (no late paint, the round trip) do not apply. */
  live?: boolean
  /** The scene's own text repeats itself (a fixture of one sentence, many
   *  times): the doubled-row census reads its wraps as copies and is off;
   *  the singleton needles remain the law. */
  repetitive?: boolean
  /** The key sent after the last move, and what it must do. */
  key: { data: string; expect: KeyExpect }
  /** Scripted model turns — a fixture server answers this scene's wire. */
  fixture?: ScriptedTurn[]
  /** A root screen's key-map row (accepted instead of an exit hint). */
  root?: RegExp
}

const SCENES: Scene[] = [
  {
    // The bare boot lands ON the face: nothing to drive (the base's own
    // sends type a slash command whose ↵ now births a session at once).
    name: 'boot-face', base: 'boot-face', world: 'face',
    replaceSends: true,
    ready: { text: 'Doctor / Health Check', stable: 3 },
    once: ['Doctor / Health Check', 'New Session'], keep: ['Doctor / Health Check'],
    key: { data: DOWN, expect: 'changes' },
    root: /↵ start\s+·\s+m menu/,
  },
  {
    // The boot menu (the settings layer) opens from the face's own key (m);
    // its header names it at every size (the panels beside the list are a
    // wide-window shape, and the detail panel repeats the selected row's
    // name — so the first row is kept, never counted once).
    name: 'boot-settings', base: 'boot-settings', world: 'face',
    replaceSends: true,
    sends: [{ requireAwait: true, awaitText: 'Doctor / Health Check', awaitStableTicks: 2, data: 'm' }],
    ready: { text: 'boot menu', stable: 3 },
    once: ['boot menu'], keep: ['boot menu', 'Content-rule wards'],
    key: { data: ESC, expect: 'closes' },
    root: /↵ start\s+·\s+m menu|esc back/,
  },
  {
    name: 'chat-idle', base: 'cockpit-wide', world: 'chat',
    ready: { text: COMPOSER_AT_REST, stable: 3, minTick: CHAT_QUIET_TICK },
    // The tail is the resumed-session card (it follows the prose): a
    // shorter viewport keeps the tail, not the prose above it.
    once: [COMPOSER_AT_REST], keep: ['health none — /health'],
    key: { data: 'x', expect: 'composer-echo' },
    root: /\? for shortcuts|shift\+tab to cycle|to cycle\)/,
  },
  {
    name: 'chat-stream', base: 'cockpit-wide', world: 'chat',
    sends: [
      { requireAwait: true, awaitText: COMPOSER_AT_REST, minTick: CHAT_QUIET_TICK, awaitStableTicks: 2, data: 'stream the resize journey' },
      { afterPrevTicks: 2, data: '\r' },
    ],
    // Ten lines in: the stream has four seconds left — every move lands
    // inside it.
    ready: { text: 'rz-stream-line-010' },
    once: [], oncePattern: STREAM_LINE,
    keep: [], keepPattern: STREAM_LINE,
    keepFinal: [`rz-stream-line-${String(STREAM_LINES - 1).padStart(3, '0')}`],
    live: true,
    key: { data: 'x', expect: 'composer-echo' },
    fixture: [{ kind: 'paced', deltas: streamDeltas, gapMs: 50, settleDelayMs: 300 }],
    root: /\? for shortcuts|shift\+tab to cycle|to cycle\)|esc/,
  },
  {
    // Message-cursor mode: the composer is not the focus owner, so the
    // physical cursor parks (the card world's law).
    name: 'chat-cursor', base: 'cockpit-wide', world: 'card',
    sends: [{ requireAwait: true, awaitText: COMPOSER_AT_REST, minTick: CHAT_QUIET_TICK, awaitStableTicks: 2, data: SHIFT_UP }],
    ready: { text: 'navigate', stable: 2 },
    once: ['navigate'], keep: ['navigate'],
    key: { data: ESC, expect: 'closes' },
  },
  {
    name: 'chat-scrolled', base: 'cockpit-scrolled', world: 'chat',
    // The scenario pages up into the middle of a tall session: the prompt
    // rows on screen at ready (their nameplates — the rail's prompt list
    // and the sticky header repeat the words without one) are the anchor
    // every move must keep on screen.
    ready: { text: '] ❯ turn', stable: 3, minTick: CHAT_QUIET_TICK },
    once: [], keep: [],
    anchorPattern: /\] ❯ turn (\d+):/, contentPattern: /\] ❯ turn \d+:|Reply \d+:|fox jumps/,
    repetitive: true,
    // A taller window may already show the tail: the key that always moves
    // a scrolled-away view is a page UP.
    key: { data: PAGE_UP, expect: 'changes' },
    root: /\? for shortcuts|shift\+tab to cycle|to cycle\)|esc/,
  },
  {
    name: 'permission-card', base: 'cockpit-wide', world: 'card',
    sends: [
      { requireAwait: true, awaitText: COMPOSER_AT_REST, minTick: CHAT_QUIET_TICK, awaitStableTicks: 2, data: 'run the resize echo' },
      { afterPrevTicks: 2, data: '\r' },
    ],
    ready: { text: 'Do you want to proceed?', stable: 2 },
    once: ['Do you want to proceed?'], keep: ['Do you want to proceed?'],
    key: { data: ESC, expect: 'closes' },
    // A neutral command (echo) never asks; a removal outside the project
    // parks a real permission ask (the path never exists — harmless either way).
    fixture: [{ kind: 'tool_use', name: 'Bash', input: { command: 'rm -f /tmp/mercury-resize-nothing-here', description: 'tidy' }, preText: 'about to tidy up.' }],
  },
  {
    name: 'concourse', base: 'concourse', world: 'board',
    // The board is named by its furniture (the list column truncates every
    // title; the mirror pane sheds at narrow profiles).
    ready: { text: 'STATUS & TITLE', stable: 3 },
    once: ['STATUS & TITLE'], keep: ['SESSIONS', 'STATUS & TITLE'], armed: true,
    key: { data: DOWN, expect: 'changes' },
  },
  {
    // The base's ↓ presses (two or three land) leave the focused pane's
    // cursor somewhere in its list before the moves — the board's own armed
    // row is read by its title head — so the key that must still answer
    // afterwards is the pane switch (tab), never an arrow at a list's end.
    name: 'concourse-armed', base: 'concourse-r0-select-move', world: 'board',
    ready: { text: 'STATUS & TITLE', stable: 3 },
    once: ['STATUS & TITLE'], keep: ['SESSIONS', 'STATUS & TITLE'], armed: true,
    key: { data: '\t', expect: 'changes' },
  },
  {
    name: 'sessions-manager', base: 'sessions-manager', world: 'surface',
    ready: { text: 'Switch to', stable: 3 },
    once: ['Switch to'], keep: ['Switch to'],
    key: { data: ESC, expect: 'closes' },
  },
  {
    name: 'model-picker', base: 'model-picker-home', world: 'surface',
    ready: { atTick: 56 }, once: [], keep: [],
    key: { data: ESC, expect: 'changes' },
  },
  {
    name: 'help', base: 'help', world: 'surface',
    ready: { atTick: 44 }, once: [], keep: [],
    key: { data: ESC, expect: 'changes' },
  },
  {
    name: 'logins', base: 'login-card', world: 'surface',
    ready: { atTick: 54 }, once: [], keep: [],
    key: { data: ESC, expect: 'changes' },
  },
  {
    name: 'accounts', base: 'accounts', world: 'surface',
    ready: { atTick: 52 }, once: [], keep: [],
    key: { data: ESC, expect: 'changes' },
  },
  {
    name: 'tasks', base: 'tasks-mission', world: 'surface',
    ready: { atTick: 58 }, once: [], keep: [],
    key: { data: ESC, expect: 'changes' },
  },
  {
    name: 'agents-studio', base: 'agents-studio-rich', world: 'surface',
    ready: { text: 'studio-fix-writer', stable: 3 },
    once: ['studio-fix-writer'], keep: ['studio-fix-writer'],
    key: { data: ESC, expect: 'closes' },
  },
]

// ── the moves ───────────────────────────────────────────────────────────────

type Step = { cols: number; rows: number; afterMs: number }
type Move = { name: string; start: [number, number]; steps: Step[] }
const MOVES: Move[] = [
  { name: 'shrink', start: [120, 40], steps: [{ cols: 100, rows: 30, afterMs: 400 }] },
  { name: 'grow', start: [100, 30], steps: [{ cols: 140, rows: 50, afterMs: 400 }] },
  {
    name: 'burst', start: [120, 40],
    steps: [
      { cols: 110, rows: 38, afterMs: 400 },
      { cols: 100, rows: 36, afterMs: 80 },
      { cols: 90, rows: 32, afterMs: 80 },
      { cols: 100, rows: 36, afterMs: 80 },
      { cols: 110, rows: 38, afterMs: 80 },
      { cols: 120, rows: 40, afterMs: 80 },
    ],
  },
  // Under the floor on BOTH axes (72 < 80 columns, 20 < 22 rows), and back.
  { name: 'below', start: [120, 40], steps: [{ cols: 72, rows: 20, afterMs: 400 }, { cols: 120, rows: 40, afterMs: 1500 }] },
  { name: 'height', start: [120, 40], steps: [{ cols: 120, rows: 30, afterMs: 400 }] },
  { name: 'width', start: [120, 40], steps: [{ cols: 100, rows: 40, afterMs: 400 }] },
]
/** A move whose last step returns to its start size: the settled frame must
 *  equal the frame the move began from. */
const roundTrip = (m: Move): boolean => {
  const last = m.steps[m.steps.length - 1]!
  return last.cols === m.start[0] && last.rows === m.start[1]
}
/** A step that lands under the floor (the too-small window). */
const underFloor = (s: Step): boolean => s.cols < VIEWPORT_FLOOR_COLS || s.rows < VIEWPORT_FLOOR_ROWS

// ── the capture ─────────────────────────────────────────────────────────────

const sceneFilter = arg('--scenes', '').split(',').map(s => s.trim()).filter(Boolean)
const moveFilter = arg('--moves', '').split(',').map(s => s.trim()).filter(Boolean)
const outDir = arg('--out', join(tmpdir(), `mercury-resize-${process.pid}`))
mkdirSync(outDir, { recursive: true })
const scenes = sceneFilter.length > 0 ? SCENES.filter(s => sceneFilter.includes(s.name)) : SCENES
const moves = moveFilter.length > 0 ? MOVES.filter(m => moveFilter.includes(m.name)) : MOVES
for (const name of sceneFilter) if (!SCENES.some(s => s.name === name)) console.error(`unknown scene ${name} — ${SCENES.map(s => s.name).join(' · ')}`)
for (const name of moveFilter) if (!MOVES.some(m => m.name === name)) console.error(`unknown move ${name} — ${MOVES.map(m => m.name).join(' · ')}`)

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(2)
}
if (!existsSync(BIN)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(2)
}
const PYTE_PATH = (() => {
  try {
    return spawnSync(driver.python, ['-c', 'import pyte, os; print(os.path.dirname(os.path.dirname(pyte.__file__)))'], { encoding: 'utf8' }).stdout?.trim() || ''
  } catch {
    return ''
  }
})()

type Cursor = { x: number; y: number; hidden: boolean }
type Mark = { label: string; atTick: number; atMs?: number; cols: number; rows: number; cursor?: Cursor; grid: Grid }
type Stage = { cols: number; rows: number; untilTick: number; untilMs?: number; cursor?: Cursor; grid: Grid }
type Payload = { cols: number; rows: number; grid?: Grid; cursor?: Cursor; marks?: Mark[]; stages?: Stage[]; endReason?: string; endedAtTick?: number }
type Frame = { label: string; cols: number; rows: number; tick: number; cursor: Cursor | null; rows_: string[] }

type Kind =
  | 'capture' | 'timeline'
  | 'extra-repaint' | 'no-repaint' | 'late-paint'
  | 'alt-exit' | 'line-feed'
  | 'doubled' | 'doubled-row'
  | 'cursor' | 'anchor-lost' | 'armed-lost'
  | 'broken-border' | 'bleed' | 'clip' | 'no-exit' | 'footer-wrapped'
  | 'floor-line' | 'return-drift'
  | 'hold-per-event' | 'key-dead'
type Finding = { kind: Kind; detail: string }
type Census = { window: string; fromTick: number; toTick: number | null; writes: number; bytes: number; erases: number; holds: number; altExits: number; lineFeeds: number }
type Result = { scene: string; move: string; ok: boolean; findings: Finding[]; census: Census[]; note: string; frames: string[] }

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** The mark schedule after the ready mark, in ticks: the settle windows of
 *  every step that leaves ≥ 600 ms before the next, then the settled trio
 *  after the last step, the key, and the frame after it. */
function markPlan(move: Move): Array<{ label: string; tick: number; data?: string }> {
  const tickAfter = (ms: number): number => Math.ceil(ms / 200) + 1
  const plan: Array<{ label: string; tick: number; data?: string }> = []
  let at = 0
  move.steps.forEach((s, i) => {
    at += s.afterMs
    const next = move.steps[i + 1]
    if (next !== undefined && next.afterMs >= 600) {
      plan.push({ label: `step${i}-a`, tick: tickAfter(at + 300) })
      if (next.afterMs >= 1200) plan.push({ label: `step${i}-b`, tick: tickAfter(at + 900) })
    }
  })
  plan.push({ label: 'settled-1', tick: tickAfter(at + 300) })
  plan.push({ label: 'settled-2', tick: tickAfter(at + 600) })
  plan.push({ label: 'settled-3', tick: tickAfter(at + 1200) })
  return plan
}

async function capture(scene: Scene, move: Move): Promise<Result> {
  const tag = `${scene.name}-${move.name}`
  const gridPath = join(outDir, `${tag}.json`)
  const cfgPath = join(outDir, `${tag}.cfg.json`)
  const teePath = join(outDir, `${tag}.tee.bin`)
  rmSync(teePath, { force: true })
  const [cols, rows] = move.start
  const saved: Record<string, string | undefined> = { ...process.env }
  let base: Record<string, unknown>
  try {
    base = scenario(scene.base, cols, rows)
  } catch (e) {
    restoreEnv(saved)
    return { scene: scene.name, move: move.name, ok: false, findings: [{ kind: 'capture', detail: `scenario refused: ${String(e).slice(0, 200)}` }], census: [], note: '', frames: [] }
  }
  const baseSends = scene.replaceSends ? [] : ((base.sends as Record<string, unknown>[] | undefined) ?? [])
  const baseTotal = Number(base.total ?? 60)
  const ready: Record<string, unknown> =
    'text' in scene.ready
      ? { requireAwait: true, awaitText: scene.ready.text, minTick: scene.ready.minTick ?? 0, awaitStableTicks: scene.ready.stable ?? 0, awaitSettleTicks: 1, mark: 'ready', data: '' }
      : { atTick: scene.ready.atTick, mark: 'ready', data: '' }
  const plan = markPlan(move)
  const chain: Record<string, unknown>[] = []
  let prev = 0
  for (const m of plan) {
    chain.push({ afterPrevTicks: Math.max(1, m.tick - prev), mark: m.label, data: '' })
    prev = m.tick
  }
  const keyTick = prev + 2
  chain.push({ afterPrevTicks: 2, mark: 'key', data: scene.key.data })
  // A lone escape byte is held by the input parser until its sequence
  // timeout passes: the frame after the key is read a full second later.
  chain.push({ afterPrevTicks: 5, mark: 'after-key', data: '' })
  prev = keyTick + 5
  const resizes = move.steps.map((s, i) =>
    i === 0 ? { afterMark: 'ready', afterMs: s.afterMs, cols: s.cols, rows: s.rows } : { afterPrevMs: s.afterMs, cols: s.cols, rows: s.rows },
  )
  const cfg: Record<string, unknown> = {
    ...base,
    sends: [...baseSends, ...(scene.sends ?? []), ready, ...chain],
    resizes,
    stableTicks: 3,
    total: baseTotal + prev + 40,
    cols,
    rows,
    out: gridPath,
  }
  delete cfg.readyText
  delete cfg.readySettleTicks
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const fixture = scene.fixture ? await startFixtureApi(scene.fixture) : null
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(PYTE_PATH ? { PYTHONPATH: [PYTE_PATH, process.env.PYTHONPATH].filter(Boolean).join(':') } : {}),
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR || CONFIG_HOME,
    VSHOT_TEE: teePath,
    ...(fixture
      ? {
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: FIXTURE_API_KEY,
          // The session-title side call would race the scripted turn.
          MERCURY_TERMINAL_TITLE: '0',
        }
      : {}),
  }
  delete env.VSHOT_ACTIVE
  restoreEnv(saved)
  const status = await new Promise<number | null>(resolve => {
    const child = spawn(driver.python, [join(import.meta.dir, 'vshot.py'), cfgPath], { cwd: RUNTIME_CWD, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(Number(cfg.total) * 200 + 30_000))
    child.on('exit', code => {
      clearTimeout(killer)
      if (code !== 0) writeFileSync(join(outDir, `${tag}.stderr.txt`), stderr)
      resolve(code)
    })
  })
  if (fixture) await fixture.close()
  cleanupScenario(scene.base)
  if (status !== 0 || !existsSync(gridPath)) {
    return { scene: scene.name, move: move.name, ok: false, findings: [{ kind: 'capture', detail: `vshot exit ${status} (stderr beside the grid)` }], census: [], note: '', frames: [] }
  }
  const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
  return judge(scene, move, payload, teePath, tag)
}

// ── the tee ─────────────────────────────────────────────────────────────────

type TeeFrame = { tick: number; bytes: Buffer }
function readTee(path: string): TeeFrame[] {
  if (!existsSync(path)) return []
  const tee = readFileSync(path)
  const frames: TeeFrame[] = []
  let off = 0
  while (off + 8 <= tee.length) {
    const tick = tee.readUInt32BE(off)
    const len = tee.readUInt32BE(off + 4)
    off += 8
    frames.push({ tick, bytes: tee.subarray(off, off + len) })
    off += len
  }
  return frames
}
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1
function census(frames: TeeFrame[], window: string, fromTick: number, toTick: number | null): Census {
  const inWindow = frames.filter(f => f.tick >= fromTick && (toTick === null || f.tick < toTick))
  const all = Buffer.concat(inWindow.map(f => f.bytes)).toString('latin1')
  return {
    window,
    fromTick,
    toTick,
    writes: inWindow.length,
    bytes: all.length,
    erases: countOf(all, '\x1b[2J'),
    holds: countOf(all, '\x1b[?25l'),
    altExits: countOf(all, '\x1b[?1049l'),
    lineFeeds: countOf(all, '\n'),
  }
}

// ── the laws ────────────────────────────────────────────────────────────────

/** The frame's text with the ONE live cell the display pins do not cover
 *  blanked: a focused composer's caret block (the glyph right after its
 *  pointer) blinks on its own clock. Named by its cell, never a whole row. */
const CARET_BLOCK = /❯ ▌/g
const text = (rows: string[]): string => rows.join('\n').replace(CARET_BLOCK, '❯  ')
const BOX_ONLY = /^[\s─│╭╮╰╯├┤┬┴┼━▔▁═┌┐└┘]*$/
/** Rows that appear twice in a frame (real text, not rules or borders). */
function doubledRows(rows: string[]): Map<string, number[]> {
  const seen = new Map<string, number[]>()
  rows.forEach((r, i) => {
    const t = r.trim()
    if (t.replace(/\s/g, '').length < 16 || BOX_ONLY.test(t)) return
    const list = seen.get(t) ?? []
    list.push(i)
    seen.set(t, list)
  })
  for (const [k, v] of seen) if (v.length < 2) seen.delete(k)
  return seen
}
/** The board's armed row, by the head of its TITLE: the '▸ ' caret, a state
 *  glyph, the state word, then the title — read as its first ten characters
 *  so a column that truncates ("Audit billing…") and one that does not read
 *  the same. The coordinator pane's suggestion rows carry the caret without
 *  a glyph, and a screen row can hold both panes side by side, so the whole
 *  row is never the identity. */
const BOARD_ARMED = /▸ [●◐○□◆✓✕]\s+\S+\s+(.+?)(?:…|\s{2,}|│|$)/
function armedTitle(rows: string[]): string | null {
  for (const r of rows) {
    const m = BOARD_ARMED.exec(r)
    if (m) return m[1]!.trim().slice(0, 10)
  }
  return null
}

function judge(scene: Scene, move: Move, payload: Payload, teePath: string, tag: string): Result {
  const findings: Finding[] = []
  const marks = new Map<string, Mark>()
  for (const m of payload.marks ?? []) marks.set(m.label, m)
  const stages = payload.stages ?? []
  const frames: Frame[] = []
  const frameOf = (label: string, cols: number, rows: number, tick: number, cursor: Cursor | undefined, grid: Grid | undefined): Frame => ({ label, cols, rows, tick, cursor: cursor ?? null, rows_: rowsOf(grid) })
  const readyMark = marks.get('ready')
  if (readyMark) frames.push(frameOf('ready', readyMark.cols, readyMark.rows, readyMark.atTick, readyMark.cursor, readyMark.grid))
  stages.forEach((s, i) => frames.push(frameOf(`before-step${i}`, s.cols, s.rows, s.untilTick, s.cursor, s.grid)))
  for (const m of payload.marks ?? []) if (m.label !== 'ready') frames.push(frameOf(`mark:${m.label}`, m.cols, m.rows, m.atTick, m.cursor, m.grid))
  frames.push(frameOf('final', payload.cols, payload.rows, payload.endedAtTick ?? -1, payload.cursor, payload.grid))
  frames.sort((a, b) => a.tick - b.tick)

  // The dump: every frame, in time order, with its cursor.
  const dump: string[] = []
  for (const f of frames) {
    dump.push(`──── ${tag} · ${f.label} · ${f.cols}x${f.rows} · tick ${f.tick} · cursor ${f.cursor ? `${f.cursor.x},${f.cursor.y}${f.cursor.hidden ? ' hidden' : ''}` : '?'} ────`, ...f.rows_, '')
  }
  writeFileSync(join(outDir, `${tag}.txt`), dump.join('\n'))

  const note = `${payload.endReason ?? ''} · steps applied ${stages.length}/${move.steps.length} · marks ${[...marks.keys()].join(',')}`
  if (!readyMark) findings.push({ kind: 'capture', detail: 'the ready mark never fired (the scene never settled as written)' })
  if (stages.length !== move.steps.length) findings.push({ kind: 'capture', detail: `only ${stages.length} of ${move.steps.length} resizes applied` })
  const need = ['settled-1', 'settled-2', 'settled-3', 'key', 'after-key']
  const missing = need.filter(l => !marks.has(l))
  if (missing.length > 0) findings.push({ kind: 'capture', detail: `marks never fired: ${missing.join(', ')}` })
  if (!readyMark || stages.length !== move.steps.length || missing.length > 0) {
    return { scene: scene.name, move: move.name, ok: false, findings, census: [], note, frames: frames.map(f => f.label) }
  }

  // The timeline: each step's fire moment relative to the ready mark.
  const readyMs = readyMark.atMs ?? readyMark.atTick * 200
  findings.push({ kind: 'timeline', detail: `ready @${readyMs}ms · steps @${stages.map(s => `${(s.untilMs ?? s.untilTick * 200) - readyMs}ms`).join(' ')} · settled marks @${['settled-1', 'settled-2', 'settled-3'].map(l => `${(marks.get(l)!.atMs ?? marks.get(l)!.atTick * 200) - readyMs}ms`).join(' ')}` })

  // ── the tee: (a) one repaint, (b) never leaves alt, no LF, (g) one hold ──
  const tee = readTee(teePath)
  const censuses: Census[] = []
  const stepStart = (i: number): number => stages[i]!.untilTick
  // Windows: a step followed by ≥ 600 ms of quiet gets its own; steps
  // closer than that fold into one window (a burst is ONE storm).
  type Window = { label: string; from: number; to: number | null; steps: number[] }
  const windows: Window[] = []
  let open: Window | null = null
  for (let i = 0; i < move.steps.length; i++) {
    const next = move.steps[i + 1]
    if (open === null) open = { label: `step${i}`, from: stepStart(i), to: null, steps: [i] }
    else open.steps.push(i)
    if (next === undefined || next.afterMs >= 600) {
      open.to = next === undefined ? null : stepStart(i + 1)
      if (open.steps.length > 1) open.label = `steps${open.steps[0]}-${open.steps[open.steps.length - 1]}`
      windows.push(open)
      open = null
    }
  }
  const keyTick = marks.get('key')!.atTick
  for (const w of windows) {
    // The last window closes at the key press: the key's own paint is not a settle.
    const c = census(tee, w.label, w.from, w.to ?? keyTick)
    censuses.push(c)
    const expected = 1
    if (c.erases > expected) findings.push({ kind: 'extra-repaint', detail: `${w.label}: ${c.erases} full repaints (2J) for ${w.steps.length} resize event(s) — one settle expected` })
    if (c.erases < expected) findings.push({ kind: 'no-repaint', detail: `${w.label}: no full repaint after the resize (${c.writes} writes, ${c.bytes} bytes)` })
    if (c.altExits > 0) findings.push({ kind: 'alt-exit', detail: `${w.label}: the journey left the alternate screen ${c.altExits}× (?1049l)` })
    if (c.lineFeeds > 0) findings.push({ kind: 'line-feed', detail: `${w.label}: ${c.lineFeeds} line feed(s) in the resize bytes — a bottom-row LF scrolls the buffer (ghost row)` })
    if (w.steps.length > 1 && c.holds > 1) findings.push({ kind: 'hold-per-event', detail: `${w.label}: ${c.holds} holding paints for ${w.steps.length} events — at most one per storm` })
  }

  // ── the settled frames ─────────────────────────────────────────────────
  const settled = ['settled-1', 'settled-2', 'settled-3'].map(l => marks.get(l)!)
  const last = move.steps[move.steps.length - 1]!
  const settledFrames: Array<{ label: string; rows: string[]; cols: number; cursor?: Cursor }> = [
    ...settled.map(m => ({ label: m.label, rows: rowsOf(m.grid), cols: m.cols, cursor: m.cursor })),
  ]
  const beforeKey = settledFrames[2]!
  const afterKeyMark = marks.get('after-key')!
  const afterKey = { label: 'after-key', rows: rowsOf(afterKeyMark.grid), cols: afterKeyMark.cols, cursor: afterKeyMark.cursor }
  const readyRows = rowsOf(readyMark.grid)
  const readyDoubled = new Set(doubledRows(readyRows).keys())
  const lastIsUnder = underFloor(last)

  // (a) the frame holds still after the settle (no late paint).
  if (!scene.live) {
    if (text(settledFrames[1]!.rows) !== text(settledFrames[2]!.rows)) {
      const diff = settledFrames[1]!.rows.map((r, i) => (r !== settledFrames[2]!.rows[i] ? i : -1)).filter(i => i >= 0)
      findings.push({ kind: 'late-paint', detail: `settled-2 → settled-3 changed on rows ${diff.slice(0, 8).join(',')}${diff.length > 8 ? '…' : ''} (a paint landed ${((marks.get('settled-3')!.atMs ?? 0) - readyMs)}ms after ready)` })
    }
    if (text(settledFrames[0]!.rows) !== text(settledFrames[1]!.rows)) {
      const diff = settledFrames[0]!.rows.map((r, i) => (r !== settledFrames[1]!.rows[i] ? i : -1)).filter(i => i >= 0)
      findings.push({ kind: 'late-paint', detail: `settled-1 → settled-2 changed on rows ${diff.slice(0, 8).join(',')}${diff.length > 8 ? '…' : ''}` })
    }
  }

  for (const f of lastIsUnder ? [] : settledFrames) {
    // (c) nothing painted twice.
    for (const needle of scene.once) {
      const hits = needleRows(f.rows, needle)
      if (hits.length > 1) findings.push({ kind: 'doubled', detail: `${f.label}: "${needle}" on rows ${hits.join(',')}` })
    }
    if (scene.oncePattern) {
      const seen = new Map<string, number[]>()
      f.rows.forEach((r, i) => {
        for (const m of r.match(scene.oncePattern!) ?? []) seen.set(m, [...(seen.get(m) ?? []), i])
      })
      for (const [m, hits] of seen) if (hits.length > 1) findings.push({ kind: 'doubled', detail: `${f.label}: "${m}" on rows ${hits.join(',')}` })
    }
    for (const [row, at] of scene.repetitive ? [] : doubledRows(f.rows)) {
      if (readyDoubled.has(row)) continue
      findings.push({ kind: 'doubled-row', detail: `${f.label}: rows ${at.join(',')} both read "${row.slice(0, 60)}"` })
    }
    // (d) the cursor and the anchor.
    if (scene.world === 'chat') {
      const caret = composerCaret(f.rows)
      if (caret === null) findings.push({ kind: 'cursor', detail: `${f.label}: no composer row on screen` })
      else if (!f.cursor) findings.push({ kind: 'cursor', detail: `${f.label}: the capture carries no cursor` })
      else if (f.cursor.y !== caret.y || f.cursor.x < caret.x - 1) findings.push({ kind: 'cursor', detail: `${f.label}: cursor at ${f.cursor.x},${f.cursor.y} — the composer's caret is at ${caret.x},${caret.y}` })
    }
    for (const needle of scene.keep) {
      if (needleRows(f.rows, needle).length === 0) findings.push({ kind: 'anchor-lost', detail: `${f.label}: "${needle}" left the screen` })
    }
    if (scene.keepPattern && !f.rows.some(r => scene.keepPattern!.test(r))) findings.push({ kind: 'anchor-lost', detail: `${f.label}: no row matches ${scene.keepPattern}` })
    if (scene.anchorPattern && scene.contentPattern) {
      const sameWidth = f.cols === readyMark.cols
      if (sameWidth) {
        // The pane's top content row at ready, exactly (the inner text —
        // the rail beside it differs per frame).
        const inner = (r: string): string => r.replace(/^[^│]*│/, '').replace(/│\s*$/, '').trim()
        const top = readyRows.find(r => scene.contentPattern!.test(r))
        if (top !== undefined && !f.rows.some(r => inner(r) === inner(top))) {
          findings.push({ kind: 'anchor-lost', detail: `${f.label}: the pane's top row at ready ("${inner(top).slice(0, 50)}") is not on screen — the position moved` })
        }
      } else {
        const turnsOf = (rows: string[]): number[] =>
          rows.flatMap(r => {
            const m = scene.anchorPattern!.exec(r)
            return m && m[1] !== undefined ? [Number(m[1])] : []
          })
        const before = turnsOf(readyRows)
        const after = turnsOf(f.rows)
        if (before.length > 0 && !after.some(n => before.some(b => Math.abs(n - b) <= 3))) {
          findings.push({ kind: 'anchor-lost', detail: `${f.label}: prompt rows at ready were turn ${before.join('/')}, now ${after.length ? after.join('/') : 'none'} — past the three-turn reflow bound` })
        }
      }
    }
    if (scene.armed) {
      const before = armedTitle(readyRows)
      const after = armedTitle(f.rows)
      if (before !== null && after !== before) findings.push({ kind: 'armed-lost', detail: `${f.label}: the armed row was "${before}…", now ${after === null ? 'none' : `"${after}…"`}` })
    }
    // (e) every border closed at the new size.
    for (const x of inspect(f.rows, f.cols, scene.root)) findings.push({ kind: x.kind, detail: `${f.label}: ${x.detail}` })
  }
  if (scene.keepFinal) {
    const rows = rowsOf(payload.grid)
    for (const needle of scene.keepFinal) if (needleRows(rows, needle).length === 0) findings.push({ kind: 'anchor-lost', detail: `final: "${needle}" never arrived` })
  }

  // (f) under the minimum: one row, the product's line; the way back is the
  // frame the move started from.
  move.steps.forEach((s, i) => {
    if (!underFloor(s)) return
    const small = ['a', 'b'].map(k => marks.get(`step${i}-${k}`)).filter((m): m is Mark => m !== undefined)
    const isLast = i === move.steps.length - 1
    const frames = isLast ? settled : small
    for (const m of frames) {
      const rows = rowsOf(m.grid)
      const painted = paintedRows(rows)
      const line = viewportFloorLine(s.cols, s.rows)
      if (painted.length !== 1) findings.push({ kind: 'floor-line', detail: `${m.label} @${s.cols}x${s.rows}: ${painted.length} painted rows (rows ${painted.slice(0, 6).join(',')}) — one line expected` })
      else if (rows[painted[0]!]!.trim() !== line) findings.push({ kind: 'floor-line', detail: `${m.label} @${s.cols}x${s.rows}: reads "${rows[painted[0]!]!.trim()}" — expected "${line}"` })
    }
  })
  if (roundTrip(move) && !scene.live) {
    const before = rowsOf(stages[0]!.grid)
    const after = beforeKey.rows
    if (text(before) !== text(after)) {
      const diff = before.map((r, i) => (r !== after[i] ? i : -1)).filter(i => i >= 0)
      findings.push({ kind: 'return-drift', detail: `the settled frame differs from the one the move started from on rows ${diff.slice(0, 10).join(',')}${diff.length > 10 ? '…' : ''}` })
    }
  }

  // The next key is live.
  const beforeText = text(beforeKey.rows)
  const afterText = text(afterKey.rows)
  switch (scene.key.expect) {
    case 'composer-echo': {
      const caret = composerCaret(afterKey.rows)
      const row = caret ? afterKey.rows[caret.y] ?? '' : ''
      if (!row.includes(scene.key.data)) findings.push({ kind: 'key-dead', detail: `typed "${scene.key.data}" — the composer row reads "${row.trim().slice(0, 60)}"` })
      break
    }
    case 'selection-moves': {
      if (armedTitle(afterKey.rows) === armedTitle(beforeKey.rows)) findings.push({ kind: 'key-dead', detail: 'the selection did not move on ↓' })
      break
    }
    case 'closes': {
      const still = scene.once.filter(n => needleRows(afterKey.rows, n).length > 0)
      if (still.length > 0 || afterText === beforeText) findings.push({ kind: 'key-dead', detail: `esc left ${still.length > 0 ? `"${still[0]}"` : 'the frame'} on screen` })
      break
    }
    case 'changes': {
      if (afterText === beforeText) findings.push({ kind: 'key-dead', detail: 'the frame did not change after the key' })
      break
    }
  }

  const verdicts = findings.filter(f => f.kind !== 'timeline')
  return { scene: scene.name, move: move.name, ok: verdicts.length === 0, findings, census: censuses, note, frames: frames.map(f => f.label) }
}

// ── the run ─────────────────────────────────────────────────────────────────

const jobs: Array<[Scene, Move]> = []
for (const s of scenes) for (const m of moves) jobs.push([s, m])
console.log(`resize matrix — ${jobs.length} captures (${scenes.length} scenes × ${moves.length} moves) → ${outDir}`)
const results: Result[] = []
for (const [s, m] of jobs) {
  const r = await capture(s, m)
  results.push(r)
  console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${s.name}@${m.name}${r.note ? ` (${r.note})` : ''}`)
  for (const c of r.census) console.log(`         tee ${c.window}: ${c.writes} writes · ${c.bytes} bytes · ${c.erases} erase(s) · ${c.holds} hold(s) · ${c.altExits} alt exit(s) · ${c.lineFeeds} LF`)
  for (const f of r.findings) console.log(`         ${f.kind}: ${f.detail}`)
}
const failed = results.filter(r => !r.ok)
writeFileSync(join(outDir, 'report.json'), JSON.stringify(results, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} clean · frames + report under ${outDir}`)
process.exit(failed.length === 0 ? 0 : 1)
