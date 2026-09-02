#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-region-matrix.ts — the region-invalidation
//  matrix, proven on the SHIPPED artifact.
//
//  Method: four hermetic app-scale runs (artifactArena: dist boots in a real
//  PTY against the in-process fixture) with MERCURY_FLUX_PROBE + the probe
//  tee. Each scene drives exactly ONE region owner; the in-process
//  fluxMark('render:<region>') probes (REPL root, composer, messages,
//  rails, frame, streaming tail) are windowed by wall-clock and every
//  NON-OWNER region must hold its measured IDLE rhythm — i.e. driving one
//  region must not re-render its siblings.
//
//    scene      driver                    window
//    idle       nothing                   boot+4s → boot+10s (rhythm source)
//    typing     8 composer glyphs         first glyph → last glyph +300ms
//    stream     paced 100-delta turn      first tail mark +500ms → last −300ms
//    spinner    hang turn (zero deltas)   submit +1500ms → session end −800ms
//
//  Allowance: non-owner in-window marks ≤ ceil(idleRate·window) + 2 (clock
//  jitter); owners must actually move (probe liveness). FLUX_MATRIX_REPORT=1
//  prints the matrix without asserting.
// ============================================================================

import { markEpochs, runArtifactArena, type ArenaRun } from './artifactArena.ts'

const REGIONS = [
  'render:repl-root',
  'render:composer',
  'render:messages',
  'render:rail-lanes',
  'render:rail-telemetry',
  'render:frame',
  'render:tail',
] as const

const GLYPHS = ['Ξ', 'Ψ', 'Φ', 'Ω', 'Λ', 'Θ', 'Π', 'Σ']

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

function inWindow(run: ArenaRun, kind: string, w: [number, number]): number {
  if (!run.probe) return -1
  return markEpochs(run.probe, kind).filter(t => t >= w[0] && t <= w[1]).length
}

function bootTs(run: ArenaRun): number {
  return run.teeLines[0]?.ts ?? 0
}
function endTs(run: ArenaRun): number {
  return run.teeLines[run.teeLines.length - 1]?.ts ?? 0
}

// ── scenes ──────────────────────────────────────────────────────────────────

console.log('── FLUX S4 region-invalidation matrix (shipped artifact) ──')

const idle = await runArtifactArena({ turns: [], sends: [], seconds: 11, probe: true })
if (!idle.probe) {
  console.error('✗ no probe dump from the idle scene — MERCURY_FLUX_PROBE_TEE egress broken')
  process.exit(1)
}
const idleWin: [number, number] = [bootTs(idle) + 4000, bootTs(idle) + 10000]
const idleSec = (idleWin[1] - idleWin[0]) / 1000
const idleRate: Record<string, number> = {}
for (const r of REGIONS) idleRate[r] = inWindow(idle, r, idleWin) / idleSec

const typing = await runArtifactArena({
  turns: [],
  sends: GLYPHS.map((g, i) => `${4500 + i * 500}:${g}`),
  seconds: 11,
  probe: true,
})
// The typing window spans the GLYPH sends alone. The arena's own face-↵
// (the landing rule: New Session is born on Enter, an observed-ready send
// the drive records first) is not typing: a window that began at it took
// the chat's birth — the root, rail, transcript and composer mounts and
// their first feeds — as typing renders, and the rail read nine of them
// where its true in-window count is zero.
const glyphSends = typing.sendLog
  .filter(s => GLYPHS.includes(Buffer.from(s.b64, 'base64').toString('utf8')))
  .map(s => s.sent)
const typingWin: [number, number] =
  glyphSends.length > 0 ? [Math.min(...glyphSends), Math.max(...glyphSends) + 300] : [0, 0]

const stream = await runArtifactArena({
  turns: [
    {
      kind: 'paced',
      whenModel: 'opus',
      deltas: Array.from({ length: 100 }, (_, i) =>
        i % 25 === 24 ? 'lattice.\n' : `word${i} `,
      ),
      gapMs: 40,
    },
  ],
  sends: ['4500:hello', '5300:\\r'],
  seconds: 13,
  probe: true,
})
// The stream window spans the TEXT FLOW: the tail store's publishes
// ('tail:publish', one per coalesced delta) — not the tail leaf's renders.
// Since the live tail mounts on every surface (FN-016 R12) the leaf renders
// at boot and on its quiet line, so a window keyed on 'render:tail' began
// at boot and took the typing, the submit and the turn's start (the send,
// the echo, the busy edge, the first frames) as streaming renders — the
// root read ten there where its count inside the flow is zero.
const tailMarks = stream.probe ? markEpochs(stream.probe, 'tail:publish') : []
const streamWin: [number, number] =
  tailMarks.length >= 10
    ? [Math.min(...tailMarks) + 500, Math.max(...tailMarks) - 300]
    : [0, 0]

const spinner = await runArtifactArena({
  turns: [{ kind: 'hang', deltas: [], whenModel: 'opus' }],
  sends: ['4500:hello', '5300:\\r'],
  seconds: 11,
  probe: true,
})
const spinnerSubmit = spinner.sendLog[spinner.sendLog.length - 1]?.sent ?? 0
const spinnerWin: [number, number] = [spinnerSubmit + 1500, endTs(spinner) - 800]

// ── the matrix ──────────────────────────────────────────────────────────────

type Scene = { name: string; run: ArenaRun; win: [number, number]; owners: string[] }
const scenes: Scene[] = [
  { name: 'typing', run: typing, win: typingWin, owners: ['render:composer', 'render:repl-root'] },
  { name: 'stream', run: stream, win: streamWin, owners: ['render:tail'] },
  { name: 'spinner', run: spinner, win: spinnerWin, owners: [] },
]

const report = process.env.FLUX_MATRIX_REPORT === '1'
console.log(`  idle rhythm (renders/s over ${idleSec}s):`)
console.log(
  '    ' +
    REGIONS.map(r => `${r.slice(7)}=${idleRate[r]!.toFixed(2)}`).join(' · '),
)

for (const scene of scenes) {
  const winSec = (scene.win[1] - scene.win[0]) / 1000
  console.log(`  scene ${scene.name} (window ${winSec.toFixed(1)}s):`)
  if (!scene.run.probe) {
    check(`${scene.name}: probe dump present`, false, 'no probe tee')
    continue
  }
  check(`${scene.name}: usable window`, winSec > 1, `${winSec.toFixed(1)}s`)
  const counts = Object.fromEntries(REGIONS.map(r => [r, inWindow(scene.run, r, scene.win)]))
  console.log(
    '    ' + REGIONS.map(r => `${r.slice(7)}=${counts[r]}`).join(' · '),
  )
  if (report) continue
  for (const r of REGIONS) {
    if (scene.owners.includes(r)) continue
    const allowance = Math.ceil(idleRate[r]! * winSec) + 2
    check(
      `${scene.name}: ${r.slice(7)} holds idle rhythm (≤${allowance})`,
      counts[r]! <= allowance,
      `${counts[r]} in-window renders`,
    )
  }
}

if (!report) {
  // owner + fixture liveness — a matrix of zeros must not pass because the
  // probes/scenes silently died
  check('typing: composer actually moved', inWindow(typing, 'render:composer', typingWin) >= GLYPHS.length - 1)
  check('stream: tail actually streamed', tailMarks.length >= 10, `${tailMarks.length} tail publishes`)
  check('stream: the tail leaf painted the flow', inWindow(stream, 'render:tail', streamWin) >= 10, `${inWindow(stream, 'render:tail', streamWin)} tail renders in the flow`)
  check('stream: fixture served the paced turn', stream.fixture.pacedEmits.length === 100, `${stream.fixture.pacedEmits.length}`)
  // The submit also fires the session-title side call on the small model;
  // the hang turn is held when the MAIN model's one request never settled.
  const spinnerMainRequests = spinner.fixture
    .messageRequests()
    .filter(r => String((r.body as { model?: string }).model ?? '').includes('opus'))
  check('spinner: fixture held the hang turn', spinnerMainRequests.length === 1, `${spinnerMainRequests.length} main-model request(s)`)
}

console.log(failures === 0 ? '✅ FLUX region-matrix GREEN' : `❌ FLUX region-matrix RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
