#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runArtifactArena } from './artifactArena.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── FLUX S8 scheduler + write discipline (shipped artifact) ──')

const deltas: string[] = []
for (let i = 0; i < 120; i++) deltas.push(i % 3 === 2 ? `word${i}.\n` : `word${i} `)
const run = await runArtifactArena({
  turns: [{ kind: 'paced', deltas, gapMs: 40, whenModel: 'opus' }],
  sends: [
    '4500:hello',
    '5300:\\r',
    '7000:Ξ', '7400:Ψ', '7800:Φ', '8200:Ω',
    '9200:\\x1b',
  ],
  seconds: 13,
  probe: true,
})

check('scene ran (frames painted)', (run.probe?.frames.total ?? 0) > 50, `${run.probe?.frames.total} frames`)
check('scene streamed + painted patches', (run.probe?.counters['patches'] ?? 0) > 0)
const risk = run.probe?.counters['stale-frame-risk'] ?? 0
check('GENERATION LAW: zero stale-frame-risk across stream/type/cancel/settle', risk === 0, `${risk} violations`)

try {
  const s4 = JSON.parse(
    readFileSync(join(ROOT, 'scripts', 'streaming', 'fixtures', 'artifact-stream-s4.json'), 'utf8'),
  ) as { echoDuringStream: { p95: number } }
  check(
    'URGENT-FLUSH VERDICT: recorded echo p95 under the 50ms budget (no flush shipped)',
    s4.echoDuringStream.p95 > 0 && s4.echoDuringStream.p95 < 50,
    `recorded p95=${s4.echoDuringStream.p95}ms`,
  )
} catch (e) {
  check('URGENT-FLUSH VERDICT evidence readable', false, String(e))
}

console.log(failures === 0 ? '✅ FLUX scheduler-integrity GREEN' : `❌ FLUX scheduler-integrity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
