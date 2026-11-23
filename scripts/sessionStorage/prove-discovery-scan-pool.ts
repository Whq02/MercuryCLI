#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

const { mapWithConcurrency } = await import('../../src/platform/async/concurrency.ts')

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
    await new Promise(r => setTimeout(r, Math.max(0, (N - item) % 7)))
    inFlight--
    return item * 10
  })
  check(`the result has exactly N entries (${N})`, out.length === N, `length=${out.length}; fix mapWithConcurrency in src/platform/async/concurrency.ts so it returns one result per input item`)
  check('results land at their own index (order preserved under reversed completions)', out.length === N && out.every((v, i) => v === i * 10), 'fix mapWithConcurrency in src/platform/async/concurrency.ts to write each result at its own input index, not in completion order')
  check(`in-flight never exceeds the width (${WIDTH})`, maxInFlight <= WIDTH, `max=${maxInFlight}; fix mapWithConcurrency in src/platform/async/concurrency.ts so no more than the width run at once`)
  check(`in-flight actually REACHES the requested width (${WIDTH}) — the pool overlaps, it does not serialise`, maxInFlight === WIDTH, `max=${maxInFlight}; fix mapWithConcurrency in src/platform/async/concurrency.ts so it starts up to the full width of workers`)
  check('every index ran exactly once', started.length === N && new Set(started).size === N, 'fix mapWithConcurrency in src/platform/async/concurrency.ts so each index is handed to the callback exactly once')
  check('an empty list answers an empty list', (await mapWithConcurrency([], 4, async () => 1)).length === 0, 'fix mapWithConcurrency in src/platform/async/concurrency.ts to return an empty array for an empty list')
  let clampInFlight = 0
  let clampMax = 0
  const clamped = await mapWithConcurrency([1, 2, 3], 0, async v => {
    clampInFlight++
    clampMax = Math.max(clampMax, clampInFlight)
    await new Promise(r => setTimeout(r, 2))
    clampInFlight--
    return v
  })
  check('a nonsense width clamps to one and still completes', clamped.length === 3 && clamped[2] === 3, 'fix mapWithConcurrency in src/platform/async/concurrency.ts to clamp a width below one to one and still finish every item')
  check('…and the clamp is observed: max in-flight at limit 0 is exactly one', clampMax === 1, `max=${clampMax}; fix mapWithConcurrency in src/platform/async/concurrency.ts so a width of 0 runs one item at a time`)
  let rejected = false
  try {
    await mapWithConcurrency([1, 2, 3], 2, async v => {
      if (v === 2) throw new Error('boom')
      return v
    })
  } catch {
    rejected = true
  }
  check('a rejection rejects the whole map', rejected, 'fix mapWithConcurrency in src/platform/async/concurrency.ts so a throwing callback rejects the returned promise')
}

section('§2 the enumerator over a scratch history')
{
  const { sessionFilesWithMtime, sessionFilesLite } = await import('../../src/sessions/transcripts/sessionListings.ts')
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
  const map = await sessionFilesWithMtime(projectDir)
  check('exactly the UUID transcripts enumerate', map.size === 40, `size=${map.size}; fix sessionFilesWithMtime in src/sessions/transcripts/sessionListings.ts to list only files named with a UUID and .jsonl`)
  check('stat facts ride each row (size truthful)', ids.every(id => (map.get(id)?.size ?? -1) === Buffer.byteLength(`line-${ids.indexOf(id)}\n`.repeat(ids.indexOf(id) + 1))), 'fix sessionFilesWithMtime in src/sessions/transcripts/sessionListings.ts so each row carries the real byte size of its file')
  const lite = await sessionFilesLite(projectDir)
  check('the lite listing still answers every row', lite.length === 40, `rows=${lite.length}; fix sessionFilesLite in src/sessions/transcripts/sessionListings.ts so it returns one row per transcript`)
  const sortedByDate = [...lite].every((row, i, all) => i === 0 || all[i - 1]!.modified.getTime() >= row.modified.getTime())
  check('the lite listing still sorts newest-first (the pool changed latency, never shape)', sortedByDate, 'fix sessionFilesLite in src/sessions/transcripts/sessionListings.ts to sort rows by modified time, newest first')
}


console.log(`\n${failures === 0 ? `✅ DISCOVERY SCAN POOL: green (${checks} checks)` : `❌ ${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)

