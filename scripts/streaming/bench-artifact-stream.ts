#!/usr/bin/env bun

import { writeFileSync } from 'node:fs'
import { firstPtyVisibility, observedEmissionWindow, pct, runArtifactArena, visibleText } from './artifactArena.ts'

const WORDS = 'stream frame cadence settle anchor lattice glyph honest state viewport'.split(' ')
const deltas: string[] = []
let sIdx = 0
for (let i = 0; i < 200; i++) {
  if (i > 0 && i % 15 === 0) {
    deltas.push(`⟦S${sIdx++}⟧`)
    continue
  }
  const w = WORDS[(i * 7 + 3) % WORDS.length]!
  deltas.push(i % 40 === 39 ? `${w}.\n` : `${w} `)
}
const SENTINELS = sIdx

const GLYPHS = ['Ξ', 'Ψ', 'Φ', 'Ω', 'Λ', 'Θ', 'Π', 'Σ']

const sends: string[] = ['4500:hello', '5300:\\r']
GLYPHS.forEach((g, i) => sends.push(`${7000 + i * 500}:${g}`))

const run = await runArtifactArena({
  turns: [{ kind: 'paced', deltas, gapMs: 40, whenModel: 'opus' }],
  sends,
  seconds: Number(process.env.FLUX_BENCH_SECONDS ?? 18),
})

if (run.teeLines.length === 0) {
  console.error(`✗ no tee — artifact never painted (ptydrive: ${run.driverOut})`)
  process.exit(1)
}
const vis = run.teeLines.map(t => ({ ts: t.ts, v: t.content ? visibleText(t.content) : '' }))

const lat: number[] = []
let misses = 0
for (const e of run.fixture.pacedEmits) {
  if (!e.text.startsWith('⟦S')) continue
  const hit = vis.find(t => t.ts >= e.at && t.v.includes(e.text))
  if (hit) lat.push(hit.ts - e.at)
  else misses++
}

const echo: number[] = []
let echoMisses = 0
const emission = observedEmissionWindow(run.fixture.pacedEmits)
let echoOutsideStream = 0
const echoPty: number[] = []
let echoPtyMisses = 0
for (const s of run.sendLog) {
  const g = Buffer.from(s.b64, 'base64').toString('utf8')
  if (!GLYPHS.includes(g)) continue
  if (emission === null || s.sent < emission.start || s.sent > emission.end) {
    echoOutsideStream++
    continue
  }
  const hit = vis.find(t => t.ts >= s.sent && t.v.includes(g))
  if (hit) echo.push(hit.ts - s.sent)
  else echoMisses++
  const read = firstPtyVisibility(run.ptyReads, g, s.sent)
  if (read) echoPty.push(read.ts - s.sent)
  else echoPtyMisses++
}

const firstEmit = run.fixture.pacedEmits[0]
const firstOut = firstEmit
  ? (() => {
      const needle = visibleText(firstEmit.text)
      const hit = vis.find(t => t.ts >= firstEmit.at && needle.length > 0 && t.v.includes(needle))
      return hit ? hit.ts - firstEmit.at : -1
    })()
  : -1

const result = {
  requests: run.fixture.requests.map(r => `${r.method} ${r.path}`),
  deltasEmitted: run.fixture.pacedEmits.length,
  sentinels: { n: lat.length, of: SENTINELS, misses, p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length ? Math.max(...lat) : -1 },
  echoDuringStream: { n: echo.length, misses: echoMisses, outsideStream: echoOutsideStream, p50: pct(echo, 50), p95: pct(echo, 95), max: echo.length ? Math.max(...echo) : -1, unit: 'send → tee enqueue (ms)' },
  echoPtyReadDuringStream: { n: echoPty.length, misses: echoPtyMisses, p50: pct(echoPty, 50), p95: pct(echoPty, 95), max: echoPty.length ? Math.max(...echoPty) : -1, unit: 'send → driver pty read (ms)' },
  emissionWindow: emission === null ? null : { start: emission.start, end: emission.end, ms: emission.end - emission.start },
  firstOutputMs: firstOut,
  firstOutputUnit: 'first fixture delta emit → first tee enqueue whose visible text carries that delta (ms)',
  capture: run.outcome,
  writes: run.teeLines.length,
}
if (!run.outcome.complete) console.error(`✗ capture incomplete — ${run.outcome.reason}`)
console.log(
  `artifact-stream  sentinel p50/p95/max ${result.sentinels.p50}/${result.sentinels.p95}/${result.sentinels.max}ms (n=${result.sentinels.n}/${result.sentinels.of}${misses ? ` MISS=${misses}` : ''}) · echo-during-stream p50/p95/max ${result.echoDuringStream.p50}/${result.echoDuringStream.p95}/${result.echoDuringStream.max}ms (n=${result.echoDuringStream.n}${echoMisses ? ` MISS=${echoMisses}` : ''}${echoOutsideStream ? ` outside-stream=${echoOutsideStream}` : ''}; pty-read p50/p95 ${result.echoPtyReadDuringStream.p50}/${result.echoPtyReadDuringStream.p95}ms n=${result.echoPtyReadDuringStream.n}) · firstOut ${result.firstOutputMs}ms · deltas ${result.deltasEmitted} · writes ${result.writes} · requests ${result.requests.length}`,
)

const jsonAt = process.argv.indexOf('--json')
if (jsonAt >= 0 && process.argv[jsonAt + 1]) writeFileSync(process.argv[jsonAt + 1]!, JSON.stringify(result, null, 2))
