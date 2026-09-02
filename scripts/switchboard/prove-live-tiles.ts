#!/usr/bin/env bun
// ============================================================================
//  prove-live-tiles — the board's live-tile store (LIVE TILES sheet,
//  session-manager step 1).
//
//  The mechanism pinned, line by line:
//   · line 1/2 (live): a session-tail publish becomes the tile's streaming
//     last line; a null tail with a transcript tool_use tail becomes the
//     running-tool line; no signal ⇒ 'still' (the snapshot summary stands);
//   · line 3 (calm): emissions are CONTENT-KEYED — republishing the same
//     block emits nothing (poison: a changed block MUST emit);
//   · line 9 (frontier): two sessions streaming distinct markers — each
//     tile carries only its own;
//   · line 7 (honest under load): the per-second read/derive budget
//     degrades the store after two over-budget windows and recovers after
//     two cheap probes — BOTH directions pinned with an injected clock
//     (poison: cheap windows never degrade); the forced posture
//     (MERCURY_TILES_FORCE_DEGRADE — the capture seam) latches.
//
//  Everything runs against mkdtemp scratch dirs — daemon files only, no
//  sockets, no wires, no network.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'live-tiles-')))
process.env['MERCURY_CONFIG_DIR'] = join(SCRATCH, 'home')

const { LiveTileStore, lastLineOf, TILE_BUDGET_MS_PER_S } = await import('../../src/components/concourse/liveTiles.js')
const { publishSessionTail, readSessionTail, sessionTailDir, sessionTailPath } = await import(
  '../../src/services/engine-connector/seatProjections.js'
)

let checks = 0
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) {
    failures++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}

const tailDir = join(SCRATCH, 'daemon')

// The injected clock: real fs, simulated time.
let clock = 1_000_000
// A mutable simulated read cost (ms) — the load lever for line 7.
let readCostMs = 0
// A scripted transcript-activity answer per session (the tool leg).
const activityBySession = new Map<string, { label: string; kind: 'tool' | 'text' } | null>()

function makeStore(force = false): InstanceType<typeof LiveTileStore> {
  return new LiveTileStore({
    tailDir: () => sessionTailDir(tailDir),
    tailPath: (id: string) => sessionTailPath(id, tailDir),
    readTail: (id: string) => {
      clock += readCostMs
      return readSessionTail(id, tailDir)
    },
    activity: rec => activityBySession.get(rec.sessionId) ?? null,
    // No transcript files exist in this rig — the stat lands fail-soft
    // ('none') and the scripted activity above is the tool-leg truth.
    transcriptPath: rec => join(SCRATCH, 'transcripts', `${rec.sessionId}.jsonl`),
    nowMs: () => clock,
    forceDegrade: force,
    armMachinery: false,
  })
}

// ── lastLineOf ──────────────────────────────────────────────────────────────
console.log('L0 lastLineOf')
check('last non-empty line wins', lastLineOf('first\nsecond\nthird line') === 'third line')
check('trailing whitespace-only line skipped', lastLineOf('the reply\n   \n') === 'the reply')
check('inner whitespace collapses', lastLineOf('a\tb   c') === 'a b c')
check('clip holds the 56 bound', lastLineOf('x'.repeat(200)).length <= 56)
check('the clip keeps the TAIL (the scroll)', lastLineOf(`${'x'.repeat(60)}TAIL-MARK`).endsWith('TAIL-MARK'))

// ── L1 the three legs ───────────────────────────────────────────────────────
console.log('L1 streaming / tool / still')
{
  const store = makeStore()
  let emits = 0
  const unsub = store.register('s-one', '/tmp/ws-one', () => {
    emits++
  })
  publishSessionTail({ schema: 1, sessionId: 's-one', atMs: clock, text: 'Hello board\nSecond line ' }, tailDir)
  store._drainForTesting()
  const streaming = store.readTile('s-one')
  check('streaming: last line of the block', streaming.kind === 'streaming' && streaming.line === 'Second line', JSON.stringify(streaming))
  check('streaming change emitted', emits === 1, `emits=${emits}`)

  // The block ends: null tail + a scripted tool activity ⇒ the tool line.
  publishSessionTail({ schema: 1, sessionId: 's-one', atMs: clock, text: null }, tailDir)
  activityBySession.set('s-one', { label: 'Bash · bun run build', kind: 'tool' })
  store._drainForTesting()
  const tool = store.readTile('s-one')
  check('tool: the transcript tail names the running tool', tool.kind === 'tool' && tool.line === 'Bash · bun run build', JSON.stringify(tool))

  // Settled text activity between turns. A new activity implies a
  // transcript append in production (the stamp moves); this rig's scripted
  // activity has no file, so the republished tail's atMs is the stamp that
  // moves.
  activityBySession.set('s-one', { label: 'done — 3 files changed', kind: 'text' })
  clock += 50
  publishSessionTail({ schema: 1, sessionId: 's-one', atMs: clock, text: null }, tailDir)
  store._drainForTesting()
  const settled = store.readTile('s-one')
  check('settled: last text head', settled.kind === 'settled' && settled.line === 'done — 3 files changed', JSON.stringify(settled))

  // No signal at all ⇒ still.
  activityBySession.set('s-one', null)
  rmSync(sessionTailPath('s-one', tailDir), { force: true })
  store._drainForTesting()
  check('still when nothing live', store.readTile('s-one').kind === 'still')

  // A stale streaming tail (no republish in 10 s) is not "streaming".
  publishSessionTail({ schema: 1, sessionId: 's-one', atMs: clock, text: 'frozen words' }, tailDir)
  clock += 60_000
  activityBySession.set('s-one', { label: 'Bash · sleep', kind: 'tool' })
  store._drainForTesting()
  const stale = store.readTile('s-one')
  check('stale tail falls to the transcript activity', stale.kind === 'tool', JSON.stringify(stale))

  // THE WEDGE (FN-017 rank 5): a fresh block streams, then NOTHING changes —
  // no republish, no transcript write — while the clock runs past the
  // freshness window. The tail file is byte-identical, so the drain's stamp
  // gate used to skip the derive on every heartbeat and the tile kept
  // painting the last streamed words as live for as long as the wedge
  // lasted. The gate at the READ changes the read once; the tile falls
  // through to the transcript activity.
  publishSessionTail({ schema: 1, sessionId: 's-one', atMs: clock, text: 'last words before the wedge' }, tailDir)
  activityBySession.set('s-one', { label: 'Bash · sleep', kind: 'tool' })
  store._drainForTesting()
  const live = store.readTile('s-one')
  check('a fresh block streams', live.kind === 'streaming' && live.line === 'last words before the wedge', JSON.stringify(live))
  clock += 60_000
  store._drainForTesting()
  const wedged = store.readTile('s-one')
  check('A WEDGED SEAT\'S TILE FALLS THROUGH ON THE HEARTBEAT with nothing republished (the base froze on its last words)', wedged.kind === 'tool', JSON.stringify(wedged))
  unsub()
}

// ── L2 content-keyed calm ───────────────────────────────────────────────────
console.log('L2 content-keyed emissions (calm)')
{
  const store = makeStore()
  let emits = 0
  const unsub = store.register('s-calm', '/tmp/ws-calm', () => {
    emits++
  })
  publishSessionTail({ schema: 1, sessionId: 's-calm', atMs: clock, text: 'steady line' }, tailDir)
  store._drainForTesting()
  const base = emits
  check('first publish emits', base === 1, `emits=${base}`)
  // Republish the SAME text (new atMs — the 40 ms cadence does exactly
  // this): derives may run, the tile must not emit.
  for (let i = 0; i < 5; i++) {
    clock += 40
    publishSessionTail({ schema: 1, sessionId: 's-calm', atMs: clock, text: 'steady line' }, tailDir)
    store._drainForTesting()
  }
  check('same content never re-emits', emits === base, `emits=${emits}`)
  // POISON: a changed block MUST emit — the calm assert is not vacuous.
  clock += 40
  publishSessionTail({ schema: 1, sessionId: 's-calm', atMs: clock, text: 'steady line grew' }, tailDir)
  store._drainForTesting()
  check('poison: changed content emits', emits === base + 1, `emits=${emits}`)
  unsub()
}

// ── L3 wrong-session isolation (frontier bar) ───────────────────────────────
console.log('L3 two sessions, distinct markers')
{
  const store = makeStore()
  const unsubA = store.register('s-alpha', '/tmp/ws-a', () => {})
  const unsubB = store.register('s-beta', '/tmp/ws-b', () => {})
  publishSessionTail({ schema: 1, sessionId: 's-alpha', atMs: clock, text: 'MARKER-ALPHA-7317' }, tailDir)
  publishSessionTail({ schema: 1, sessionId: 's-beta', atMs: clock, text: 'MARKER-BETA-9241' }, tailDir)
  store._drainForTesting()
  const a = store.readTile('s-alpha')
  const b = store.readTile('s-beta')
  check('alpha carries only its own marker', a.kind === 'streaming' && a.line === 'MARKER-ALPHA-7317', JSON.stringify(a))
  check('beta carries only its own marker', b.kind === 'streaming' && b.line === 'MARKER-BETA-9241', JSON.stringify(b))
  check('poison: the markers differ', a.kind === 'streaming' && b.kind === 'streaming' && a.line !== b.line)
  unsubA()
  unsubB()
}

// ── L4 honest under load: degrade AND recover (line 7) ─────────────────────
console.log('L4 the budget: degrade and recover')
{
  const store = makeStore()
  let degradeFlips = 0
  store.onDegradeChange(() => {
    degradeFlips++
  })
  const unsub = store.register('s-load', '/tmp/ws-load', () => {})
  publishSessionTail({ schema: 1, sessionId: 's-load', atMs: clock, text: 'heavy words' }, tailDir)

  // POISON CONTROL first: cheap reads across many windows never degrade.
  readCostMs = 0
  for (let w = 0; w < 10; w++) {
    clock += 1000
    store._drainForTesting()
  }
  check('poison: cheap windows never degrade', !store.isDegraded())

  // The load lever: every read costs 60 simulated ms (> the whole
  // per-second budget). Two over-budget windows must flip the posture.
  readCostMs = TILE_BUDGET_MS_PER_S + 20
  clock += 1000
  store._drainForTesting() // window rolls: over budget ×1
  clock += 1000
  store._drainForTesting() // over budget ×2 ⇒ degraded
  check('two over-budget windows degrade', store.isDegraded())
  check('degrade emitted once', degradeFlips === 1, `flips=${degradeFlips}`)
  check('degraded tiles answer still (the summary stands)', store.readTile('s-load').kind === 'still')

  // While degraded, drains between probes cost nothing.
  const clockBefore = clock
  store._drainForTesting()
  check('degraded drain reads nothing', clock === clockBefore)

  // Recovery: the load lifts; two cheap probes (5 s apart) recover.
  readCostMs = 0
  clock += 5000
  store._drainForTesting() // probe 1 (cheap)
  check('one cheap probe is not enough (hysteresis)', store.isDegraded())
  clock += 5000
  // The block republishes FRESH before the recovering probe: the freshness
  // gate now applies at the read (FN-017 rank 5), so a block last published
  // twenty simulated seconds ago is honestly not live any more — recovery is
  // what this arm pins, not staleness.
  publishSessionTail({ schema: 1, sessionId: 's-load', atMs: clock, text: 'heavy words' }, tailDir)
  store._drainForTesting() // probe 2 ⇒ recovered
  check('two cheap probes recover', !store.isDegraded())
  check('recovery emitted', degradeFlips === 2, `flips=${degradeFlips}`)
  const back = store.readTile('s-load')
  check('the live line returns after recovery', back.kind === 'streaming' && back.line === 'heavy words', JSON.stringify(back))
  unsub()
}

// ── L5 the forced posture (the capture seam) ────────────────────────────────
console.log('L5 MERCURY_TILES_FORCE_DEGRADE latch')
{
  const store = makeStore(true)
  const unsub = store.register('s-forced', '/tmp/ws-f', () => {})
  publishSessionTail({ schema: 1, sessionId: 's-forced', atMs: clock, text: 'never shown' }, tailDir)
  check('forced: degraded from construction', store.isDegraded())
  for (let i = 0; i < 4; i++) {
    clock += 5000
    store._drainForTesting()
  }
  check('forced: probes never lift it', store.isDegraded())
  check('forced: tiles stay on the summary', store.readTile('s-forced').kind === 'still')
  unsub()
}

// ── L6 the peek's geometry grant (line 5 — expand in place) ────────────────
console.log('L6 peek geometry')
{
  const { switchboardGeometry, ROW_PEEK_DESIRED_ROWS } = await import(
    '../../src/components/concourse/ConcourseLayout.js'
  )
  const closed = switchboardGeometry(120, 40, 0, 4, 2, 1, 'mirror')
  const open = switchboardGeometry(120, 40, 0, 4, 2, 1, 'mirror', ROW_PEEK_DESIRED_ROWS)
  check('collapsed default grants zero', closed.peekRows === 0)
  check('wide 120x40 grants the full ~8', open.peekRows === ROW_PEEK_DESIRED_ROWS, `granted=${open.peekRows}`)
  check(
    'the grant grows the list band exactly',
    open.listBand[1] - open.listBand[0] === closed.listBand[1] - closed.listBand[0] + open.peekRows,
  )
  check('the row window budget is untouched', open.listContentRows === closed.listContentRows)
  const mirrorRows = open.mirrorBand[1] - open.mirrorBand[0] + 1
  check('the mirror keeps its ≥5 floor', mirrorRows >= 5, `mirror=${mirrorRows}`)
  check(
    'wide bands still tile the main band (the live composer ends the column — the two-composers law)',
    open.listBand[0] === open.mainBand[0] &&
      open.mirrorBand[0] === open.listBand[1] + 1 &&
      open.liveComposerBand[0] === open.mirrorBand[1] + 1 &&
      open.liveComposerBand[1] === open.mainBand[1],
  )
  const sClosed = switchboardGeometry(100, 30, 0, 4, 2, 1, 'mirror')
  const sOpen = switchboardGeometry(100, 30, 0, 4, 2, 1, 'mirror', ROW_PEEK_DESIRED_ROWS)
  check('stacked grants what the tall band can give', sOpen.peekRows > 0 && sOpen.peekRows <= ROW_PEEK_DESIRED_ROWS, `granted=${sOpen.peekRows}`)
  // With the needs-you rail up (the drive's own shape) the tall slack is
  // thin — the collapsed tail band yields too and the grant stays usable.
  const sRail = switchboardGeometry(100, 30, 1, 2, 2, 1, 'mirror', ROW_PEEK_DESIRED_ROWS)
  check('stacked + rail still grants ≥4 (tail band yields)', sRail.peekRows >= 4, `granted=${sRail.peekRows}`)
  const sRailBands = (sRail.listBand[1] - sRail.listBand[0] + 1) + (sRail.mirrorBand[1] - sRail.mirrorBand[0] + 1) + Math.max(0, sRail.coordBand[1] - sRail.coordBand[0] + 1) + sRail.liveComposerRows
  check('stacked + rail bands still tile the main band (the live composer included)', sRailBands === sRail.mainRows, `${sRailBands} vs main ${sRail.mainRows}`)
  const sTall = sOpen.mirrorBand[1] - sOpen.mirrorBand[0] + 1
  check('stacked tall band keeps its ≥4 floor', sTall >= 4, `tall=${sTall}`)
  check(
    'stacked bands still tile the main band',
    sOpen.listBand[0] === sOpen.mainBand[0] && sOpen.coordBand[1] === sOpen.mainBand[1],
  )
  check('stacked row window budget untouched', sOpen.listContentRows === sClosed.listContentRows)
  // POISON: a squeezed terminal grants fewer than asked, never negative.
  const tiny = switchboardGeometry(100, 24, 3, 8, 3, 5, 'mirror', ROW_PEEK_DESIRED_ROWS)
  check('poison: a squeezed grant clamps at 0..8', tiny.peekRows >= 0 && tiny.peekRows <= ROW_PEEK_DESIRED_ROWS, `granted=${tiny.peekRows}`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? `LIVE-TILES LAWS HOLD (${checks} checks)` : `LIVE-TILES ${failures}/${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
