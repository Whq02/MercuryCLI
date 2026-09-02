#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-work-chip.ts — THE BOARD ROW'S WORK CHIP:
//  selecting a session's row shows one small
//  amber line naming its running work, from the SAME facts the work views
//  read, calm under the tiles' laws.
//
//   K1  the derive: the chip text speaks the board vocabulary from the
//       session's published facts ("1 workflow · 2 agents running"); a
//       session running nothing has NO chip (null — no noise); parked asks
//       ride it;
//   K2  the feed IS the tiles substrate: the same store class over the
//       facts projection — a publish with work paints the chip; a
//       byte-identical republish emits NOTHING (content-keyed); a settled
//       roster clears it; a retired facts file clears it;
//   K3  the quiet-runner law: facts older than the freshness window (a
//       runner that stopped answering) fade the chip — a dead engine's
//       rows never claim motion (the runner republishes at 1 Hz while its
//       work runs, so a live chip is always fresh);
//   K4  the geometry: with the peek collapsed, the chip earns exactly ONE
//       row under the selected row at both sizes (120x40 wide, 100x30
//       stacked) through the one geometry owner, and the open peek's grant
//       is unchanged; a zero desire grants nothing;
//   K5  a `dispatch:` (nascent) row and an unselected row register nothing.
//  Hermetic: a scratch daemon dir; the store drives its drains by hand with
//  an injected clock (the tiles provers' own discipline). No daemon, no UI.
//
// ============================================================================
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'work-chip-')))
const daemonDir = join(SCRATCH, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_TILES_FORCE_DEGRADE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const proj = await import('../../src/services/engine-connector/seatProjections.ts')
const tiles = await import('../../src/components/concourse/liveTiles.ts')
const layout = await import('../../src/components/concourse/ConcourseLayout.tsx')

const SID = '00000000-0000-4000-8000-0000000000c1'
const baseAnswer = {
  model: { effective: 'claude-opus-5', setting: null },
  usage: {
    totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0,
    hasUnknownModelCost: false,
  },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'flow' as const,
  workspace: { cwd: SCRATCH, originalCwd: SCRATCH, projectRoot: SCRATCH, instructionRoots: [] },
  queue: [],
}
const t0 = Date.now()
const running = [
  { id: 'wf', kind: 'workflow' as const, name: 'probe', status: 'running', startTime: t0, workflowRunId: 'r', agentCount: 1, pendingAsks: 1 },
  { id: 'a1', kind: 'agent' as const, name: 'helper', status: 'running', startTime: t0 },
  { id: 'a2', kind: 'agent' as const, name: 'nested', status: 'running', startTime: t0 },
  { id: 'old', kind: 'agent' as const, name: 'done', status: 'completed', startTime: t0 },
]
const publish = (work: typeof running | [], atMs = Date.now()): void =>
  proj.publishSessionFacts({ schema: 1, sessionId: SID, atMs, pendingModel: null, busy: false, ...baseAnswer, work: work as never })

// ── K1: the derive ──────────────────────────────────────────────────────────
console.log('— K1 the derive —')
{
  check('K1 the chip text speaks the board vocabulary', tiles.workChipTextOf({ work: running as never }) === '1 workflow · 2 agents · 1 ask running', tiles.workChipTextOf({ work: running as never }) ?? 'null')
  check('K1 a session running nothing has NO chip', tiles.workChipTextOf({ work: [] }) === null && tiles.workChipTextOf(null) === null)
  check('K1 a settled-only roster has NO chip', tiles.workChipTextOf({ work: [running[3]!] as never }) === null)
}

// ── K2/K3: the feed over the facts projection ───────────────────────────────
console.log('— K2/K3 the feed —')
{
  let now = Date.now()
  const store = new tiles.LiveTileStore({ ...tiles.workChipStoreDeps(() => now), armMachinery: false })
  let pings = 0
  const unsub = store.register(SID, '', () => pings++)
  check('K2 before any publish the chip is still', store.readTile(SID).kind === 'still')

  publish(running, now)
  await wait(400)
  store._drainForTesting()
  const first = store.readTile(SID)
  check('K2 a publish with work paints the chip', first.kind !== 'still' && (first as { line: string }).line === '1 workflow · 2 agents · 1 ask running', JSON.stringify(first))
  check('K2 …and the listener heard it once', pings === 1, `pings=${pings}`)

  // Content-keyed: a byte-identical roster republished (a fresh atMs) emits
  // nothing — the chip's line did not change.
  publish(running, now + 500)
  await wait(400)
  store._drainForTesting()
  check('K2 a byte-identical republish emits NOTHING', pings === 1, `pings=${pings}`)

  // The roster settles: the chip clears.
  publish([], now + 1000)
  await wait(400)
  store._drainForTesting()
  check('K2 a settled roster clears the chip', store.readTile(SID).kind === 'still' && pings === 2, `pings=${pings}`)

  // K3 the quiet-runner law: live work whose facts stopped republishing
  // fades once the freshness window passes.
  publish(running, now + 2000)
  await wait(400)
  store._drainForTesting()
  check('K3 fresh live work paints', store.readTile(SID).kind !== 'still')
  now += 30_000
  store._drainForTesting()
  check('K3 …and fades when the runner goes quiet (facts stale)', store.readTile(SID).kind === 'still')

  // Retirement: the file goes — the chip is gone.
  now += 100
  publish(running, now)
  await wait(400)
  store._drainForTesting()
  check('K2 a re-published live roster paints again', store.readTile(SID).kind !== 'still')
  proj.retireSeatProjections(SID)
  store._drainForTesting()
  check('K2 a retired facts file clears the chip', store.readTile(SID).kind === 'still')
  unsub()
}

// ── K4: the geometry ────────────────────────────────────────────────────────
console.log('— K4 the geometry —')
{
  const wide = layout.switchboardGeometry(120, 40, 0, 3, 1, 1, 'mirror', 1)
  const stacked = layout.switchboardGeometry(100, 30, 0, 3, 1, 1, 'mirror', 1)
  check('K4 wide 120x40 grants the chip its one row', wide.profile === 'wide' && wide.peekRows === 1, `profile=${wide.profile} peekRows=${wide.peekRows}`)
  check('K4 stacked 100x30 grants the chip its one row', stacked.peekRows === 1, `profile=${stacked.profile} peekRows=${stacked.peekRows}`)
  const none = layout.switchboardGeometry(120, 40, 0, 3, 1, 1, 'mirror', 0)
  check('K4 a zero desire grants nothing (no chip, no row)', none.peekRows === 0)
  const open = layout.switchboardGeometry(120, 40, 0, 3, 1, 1, 'mirror', layout.ROW_PEEK_DESIRED_ROWS)
  check('K4 the open peek keeps its own grant', open.peekRows >= 1 && open.peekRows <= layout.ROW_PEEK_DESIRED_ROWS && open.peekRows >= wide.peekRows)
  // The row window never shifts for the grant (no re-sort, no lost rows).
  check('K4 the list content rows exclude the grant (the window keeps its budget)', wide.listContentRows === none.listContentRows && stacked.listContentRows === layout.switchboardGeometry(100, 30, 0, 3, 1, 1, 'mirror', 0).listContentRows)
}

// ── K5: registration gates ──────────────────────────────────────────────────
console.log('— K5 registration gates —')
{
  // The hook gates on `active` and refuses dispatch: rows; the store-level
  // twin: an unregistered session reads still and costs nothing.
  const store = new tiles.LiveTileStore({ ...tiles.workChipStoreDeps(), armMachinery: false })
  check('K5 an unregistered session reads still', store.readTile('dispatch:nope').kind === 'still' && store.readTile(SID).kind === 'still')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-work-chip: ALL LAWS HOLD' : `\nprove-work-chip: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
