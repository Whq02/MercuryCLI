#!/usr/bin/env bun

import { markEpochs, runArtifactArena, type ArenaRun } from './artifactArena.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const REGIONS = [
  'render:chat-root',
  'render:composer',
  'render:messages',
  'render:rail-lanes',
  'render:rail-vitals',
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
  return run.teeLines.find(t => typeof t.ts === 'number')?.ts ?? 0
}
function endTs(run: ArenaRun): number {
  for (let i = run.teeLines.length - 1; i >= 0; i--) {
    const ts = run.teeLines[i]?.ts
    if (typeof ts === 'number') return ts
  }
  return 0
}


console.log('── FLUX S4 region-invalidation matrix (shipped artifact) ──')

const idle = await runArtifactArena({ turns: [], sends: [], seconds: 11, probe: true })
if (!idle.probe) {
  console.error('✗ no probe dump from the idle scene — MERCURY_FLUX_PROBE_TEE egress broken')
  process.exit(1)
}
const idleWin: [number, number] = [bootTs(idle) + S(4000), endTs(idle) - 800]
const idleSec = (idleWin[1] - idleWin[0]) / 1000
const idleRate: Record<string, number> = {}
for (const r of REGIONS) idleRate[r] = inWindow(idle, r, idleWin) / idleSec

const LANDED = { needle: 'Type a prompt', atMs: 3000 }
const typing = await runArtifactArena({
  turns: [],
  sends: GLYPHS.map((g, i) => `${4500 + i * 500}:${g}`),
  seconds: 11,
  probe: true,
  anchor: LANDED,
})
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
  anchor: LANDED,
})
const spinnerSubmit = spinner.sendLog[spinner.sendLog.length - 1]?.sent ?? 0
const spinnerWin: [number, number] = [spinnerSubmit + 1500, endTs(spinner) - 800]


type Scene = { name: string; run: ArenaRun; win: [number, number]; owners: string[] }
const scenes: Scene[] = [
  { name: 'typing', run: typing, win: typingWin, owners: ['render:composer', 'render:chat-root'] },
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
  check(`${scene.name}: usable window`, winSec > 1, `${winSec.toFixed(1)}s; the scene produced too short a measuring window, so the sends or the paced stream in this file did not land when planned`)
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
      `${counts[r]} in-window renders; this region must not re-render in the ${scene.name} scene faster than its idle rate, so find what invalidates ${r} there`,
    )
  }
}

if (!report) {
  check('typing: composer actually moved', inWindow(typing, 'render:composer', typingWin) >= GLYPHS.length - 1, `${inWindow(typing, 'render:composer', typingWin)} composer renders for ${GLYPHS.length} typed glyphs; the glyphs did not reach the composer, so the owner check above proves nothing`)
  check('stream: tail actually streamed', tailMarks.length >= 10, `${tailMarks.length} tail publishes; the paced turn must produce at least 10 tail:publish marks, so check that the fixture served the stream and the prompt was submitted`)
  check('stream: the tail leaf painted the flow', inWindow(stream, 'render:tail', streamWin) >= 10, `${inWindow(stream, 'render:tail', streamWin)} tail renders in the flow`)
  check('stream: fixture served the paced turn', stream.fixture.pacedEmits.length === 100, `${stream.fixture.pacedEmits.length} of 100 paced deltas emitted; the fixture served the turn only partly, so check the stream scene timing in this file`)
  const spinnerMainRequests = spinner.fixture
    .messageRequests()
    .filter(r => String((r.body as { model?: string }).model ?? '').includes('opus'))
  check('spinner: fixture held the hang turn', spinnerMainRequests.length === 1, `${spinnerMainRequests.length} main-model request(s); the hang turn needs exactly one opus request, so the prompt was not submitted or was sent twice`)
}

console.log(failures === 0 ? '✅ FLUX region-matrix GREEN' : `❌ FLUX region-matrix RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
