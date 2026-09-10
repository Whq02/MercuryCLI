#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeOnlyText } from '../lib/codeText.ts'

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
    await new Promise(r => setTimeout(r, Math.max(0, (N - item) % 7)))
    inFlight--
    return item * 10
  })
  check(`the result has exactly N entries (${N})`, out.length === N, `length=${out.length}`)
  check('results land at their own index (order preserved under reversed completions)', out.length === N && out.every((v, i) => v === i * 10))
  check(`in-flight never exceeds the width (${WIDTH})`, maxInFlight <= WIDTH, `max=${maxInFlight}`)
  check(`in-flight actually REACHES the requested width (${WIDTH}) — the pool overlaps, it does not serialise`, maxInFlight === WIDTH, `max=${maxInFlight}`)
  check('every index ran exactly once', started.length === N && new Set(started).size === N)
  check('an empty list answers an empty list', (await mapWithConcurrency([], 4, async () => 1)).length === 0)
  let clampInFlight = 0
  let clampMax = 0
  const clamped = await mapWithConcurrency([1, 2, 3], 0, async v => {
    clampInFlight++
    clampMax = Math.max(clampMax, clampInFlight)
    await new Promise(r => setTimeout(r, 2))
    clampInFlight--
    return v
  })
  check('a nonsense width clamps to one and still completes', clamped.length === 3 && clamped[2] === 3)
  check('…and the clamp is observed: max in-flight at limit 0 is exactly one', clampMax === 1, `max=${clampMax}`)
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
  const logsPath = join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage', 'logs.ts')
  const logsSrc = codeOnlyText(logsPath, readFileSync(logsPath, 'utf8'))
  const EXPECTED_POOL_SITES = [
    'loadAllProjectsMessageLogsFull:projectDirs',
    'listingTruth:projectDirs',
    'sweepAllProjectsProgressive:projectDirs',
    'getStatOnlyLogsForWorktrees:matched',
    'getSessionFilesWithMtime:candidates',
    'transcriptCensus:projectDirs',
  ]
  const poolSites = inventoryPoolSites(logsSrc)
  check(
    `the code-only pool inventory is exactly the ${EXPECTED_POOL_SITES.length} named fan-outs (function:items)`,
    poolSites.join('|') === EXPECTED_POOL_SITES.join('|'),
    `got ${poolSites.join(', ') || '(none)'}`,
  )
  check('every pool site sizes from discoveryPoolWidth()', (logsSrc.match(/mapWithConcurrency\([^,]+,\s*discoveryPoolWidth\(\)/g) ?? []).length === EXPECTED_POOL_SITES.length)
  check('the unbounded stat fan-out is gone (no bare Promise.all over candidates)', !/await Promise\.all\(\s*candidates\.map/.test(logsSrc))
  check('no fan-out over the pool item lists bypasses the pool (no Promise.all(<items>.map) on those lists)', !/Promise\.all\(\s*(?:projectDirs|matched|candidates)\.map/.test(logsSrc))
  const commentLookalike = `// const x = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), d => d)\n/* mapWithConcurrency(candidates, discoveryPoolWidth(), c => c) */\nasync function ghost(projectDirs: string[]) { return projectDirs }\n`
  check('a comment-only pool call is NOT inventoried (code-only read)', inventoryPoolSites(codeOnlyText('lookalike.ts', commentLookalike)).length === 0)
  check('…while the raw text WOULD have inventoried both lookalikes', inventoryPoolSites(commentLookalike).length === 2)
  const poolSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'concurrency.ts'), 'utf8')
  check('the width reads the quota-aware core count (law 6) in its one owner', /export function discoveryPoolWidth\(\): number \{\s*\n\s*return Math\.max\(1, Math\.min\(4, availableCores\(\)\)\)/.test(poolSrc))
  check('…and the discovery scans import it from there', /import \{[^}]*\bdiscoveryPoolWidth\b[^}]*\} from '\.\.\/concurrency\.js'/.test(logsSrc) && !/function discoveryPoolWidth\(/.test(logsSrc))
}

console.log(`\n${failures === 0 ? `✅ DISCOVERY SCAN POOL: green (${checks} checks)` : `❌ ${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)

function inventoryPoolSites(code: string): string[] {
  const decl = /^(?:export )?(?:async )?function (\w+)\b/
  const lines = code.split('\n')
  const sites: string[] = []
  let current = '(module)'
  for (const line of lines) {
    const d = decl.exec(line)
    if (d) current = d[1]!
    const call = /mapWithConcurrency\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(line)
    if (call) sites.push(`${current}:${call[1]}`)
  }
  return sites
}
