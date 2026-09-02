#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-discovery-scan-pool.ts — session discovery
//  rides a SMALL ORDER-PRESERVING worker pool (the large-history law):
//
//    §1 the pool policy (mapWithConcurrency): results land at their item's
//       index whatever the completion order; in-flight never exceeds the
//       width; every index runs exactly once; empty input; a nonsense width
//       clamps to one; a rejection rejects the whole map.
//    §2 the enumerator on a real scratch dir: getSessionFilesWithMtime
//       returns exactly the UUID transcripts with their stat facts, and the
//       lite listing still sorts newest-first — the pool changed latency,
//       never shape.
//    §3 the wiring, call-shaped: every discovery fan-out in logs.ts rides
//       the pool (the progressive all-projects scan, the full scan, the
//       census, the per-file stat fan-out, the worktree stat-only road) and
//       the bare unbounded Promise.all over stat candidates is gone.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'discovery-pool-home-'))

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(s: string): void {
  console.log(`\n${s}`)
}

const { mapWithConcurrency } = await import('../../src/utils/concurrency.ts')

section('§1 the pool policy')
{
  const N = 24
  const WIDTH = 4
  let inFlight = 0
  let maxInFlight = 0
  const started: number[] = []
  const items = Array.from({ length: N }, (_, i) => i)
  const out = await mapWithConcurrency(items, WIDTH, async (item, index) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    started.push(index)
    // Adversarial completion order: later items finish FIRST.
    await new Promise(r => setTimeout(r, Math.max(0, (N - item) % 7)))
    inFlight--
    return item * 10
  })
  check('results land at their own index (order preserved under reversed completions)', out.every((v, i) => v === i * 10))
  check(`in-flight never exceeds the width (${WIDTH})`, maxInFlight <= WIDTH, `max=${maxInFlight}`)
  check('every index ran exactly once', started.length === N && new Set(started).size === N)
  check('an empty list answers an empty list', (await mapWithConcurrency([], 4, async () => 1)).length === 0)
  const clamped = await mapWithConcurrency([1, 2, 3], 0, async v => v)
  check('a nonsense width clamps to one and still completes', clamped.length === 3 && clamped[2] === 3)
  let rejected = false
  try {
    await mapWithConcurrency([1, 2, 3], 2, async v => {
      if (v === 2) throw new Error('boom')
      return v
    })
  } catch {
    rejected = true
  }
  check('a rejection rejects the whole map', rejected)
}

section('§2 the enumerator over a scratch history')
{
  const { getSessionFilesWithMtime, getSessionFilesLite } = await import('../../src/utils/sessionStorage/logs.ts')
  const projectDir = mkdtempSync(join(tmpdir(), 'discovery-pool-proj-'))
  mkdirSync(projectDir, { recursive: true })
  const ids: string[] = []
  for (let i = 0; i < 40; i++) {
    const id = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-123456789abc`
    ids.push(id)
    writeFileSync(join(projectDir, `${id}.jsonl`), `line-${i}\n`.repeat(i + 1))
  }
  writeFileSync(join(projectDir, 'not-a-session.txt'), 'junk')
  writeFileSync(join(projectDir, 'not-a-uuid.jsonl'), 'junk')
  const map = await getSessionFilesWithMtime(projectDir)
  check('exactly the UUID transcripts enumerate', map.size === 40, `size=${map.size}`)
  check('stat facts ride each row (size truthful)', ids.every(id => (map.get(id)?.size ?? -1) === Buffer.byteLength(`line-${ids.indexOf(id)}\n`.repeat(ids.indexOf(id) + 1))))
  const lite = await getSessionFilesLite(projectDir)
  check('the lite listing still answers every row', lite.length === 40)
  const sortedByDate = [...lite].every((row, i, all) => i === 0 || all[i - 1]!.modified.getTime() >= row.modified.getTime())
  check('the lite listing still sorts newest-first (the pool changed latency, never shape)', sortedByDate)
}

section('§3 the wiring, call-shaped')
{
  const logsSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage', 'logs.ts'), 'utf8')
  const poolCalls = logsSrc.split('mapWithConcurrency(').length - 1
  check('every discovery fan-out rides the pool (five call sites)', poolCalls >= 5, `calls=${poolCalls}`)
  check('the unbounded stat fan-out is gone (no bare Promise.all over candidates)', !/await Promise\.all\(\s*candidates\.map/.test(logsSrc))
  check('the width reads the quota-aware core count (law 6)', /Math\.min\(4, availableCores\(\)\)/.test(logsSrc))
}

console.log(`\n${failures === 0 ? `✅ DISCOVERY SCAN POOL: green (${checks} checks)` : `❌ ${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
