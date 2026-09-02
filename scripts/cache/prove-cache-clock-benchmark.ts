#!/usr/bin/env bun
// ============================================================================
//  scripts/cache/prove-cache-clock-benchmark.ts
//  PROOF: the Cache Clock's default-ON evidence is REAL and REPRODUCIBLE.
//
//  The graduation ladder requires a behavioral default-on flag to name a
//  committed evidence artifact. Unlike a billed benchmark (party precedent:
//  the verdict can only be digest-pinned), this one is a deterministic,
//  API-free simulation — so the gate RE-RUNS it: the committed verdict must
//  be exactly reproducible from the committed corpus through the PRODUCTION
//  decision core, green, and strictly better than the flat baseline. Any
//  policy edit that degrades the corpus result turns the gate red until the
//  verdict is legitimately regenerated (bench-sim.ts --write) and reviewed.
//
//  Also enforced: the corpus EXTRACTOR (which reads the operator's local
//  transcript store) never joins the gate via any run-all.sh.
//
//  Run:  ~/.bun/bin/bun run scripts/cache/prove-cache-clock-benchmark.ts
// ============================================================================
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { corpusSha256, runBenchmark, type Corpus } from './bench-sim.ts'

const root = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Cache Clock benchmark — reproducibility + ratchet proof')
console.log('============================================================')

section('(1) committed artifacts exist and bind to each other')
const corpusPath = join(root, 'scripts', 'cache', 'fixtures', 'corpus.json')
const verdictPath = join(root, 'scripts', 'cache', 'fixtures', 'verdict.json')
check('corpus.json committed', existsSync(corpusPath))
check('verdict.json committed', existsSync(verdictPath))
if (!existsSync(corpusPath) || !existsSync(verdictPath)) {
  console.log('\n❌ missing artifacts — cannot continue')
  process.exit(1)
}
const corpusBytes = readFileSync(corpusPath, 'utf8')
const verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as {
  corpusSha256: string
  green: boolean
  result: ReturnType<typeof runBenchmark>
  variants?: { escalateOnly?: Record<string, number> }
  evidenceRefs?: string[]
}
check(
  'verdict.corpusSha256 matches the committed corpus bytes',
  verdict.corpusSha256 === corpusSha256(corpusBytes),
  `verdict ${verdict.corpusSha256?.slice(0, 12)} vs corpus ${corpusSha256(corpusBytes).slice(0, 12)}`,
)
check('verdict carries evidenceRefs', Array.isArray(verdict.evidenceRefs) && verdict.evidenceRefs.length > 0)

section('(2) the verdict is reproducible from the corpus via the PRODUCTION core')
const corpus = JSON.parse(corpusBytes) as Corpus
const recomputed = runBenchmark(corpus)
check(
  'recomputed result matches the committed verdict exactly',
  JSON.stringify(recomputed) === JSON.stringify(verdict.result),
  'policy or sim drifted from the committed evidence — regenerate + review (bench-sim.ts --write)',
)
const escalateOnly = runBenchmark(corpus, () => ({ ttl: '5m', escalation: true }))
check(
  'escalate-only variant column reproduces',
  verdict.variants?.escalateOnly?.costUnits === escalateOnly.costUnits.clock &&
    verdict.variants?.escalateOnly?.regressedSessions === escalateOnly.regressedSessions,
)

section('(3) the ratchet: green, strictly better, honestly reported')
check('verdict is green', verdict.green === true)
check(
  'clock strictly beats the flat all-5m baseline on the corpus',
  recomputed.costUnits.clock < recomputed.costUnits.baseline5m,
)
check(
  'cold full-context rewrites reduced vs baseline',
  recomputed.coldRewrites.clock < recomputed.coldRewrites.baseline5m,
)
check(
  'honesty columns present (regressions are reported, not hidden)',
  typeof recomputed.worstSessionRegressionPct === 'number' &&
    typeof recomputed.regressedSessions === 'number',
)

section('(4) registry binding + the extractor stays out of the gate')
const registry = readFileSync(join(root, 'src', 'substrate', 'flagRegistry.ts'), 'utf8')
const row = registry.match(/\{ env: 'MERCURY_CACHE_CLOCK',(?:\s*legacy:\s*'[A-Z0-9_]+',)?\s*kind:\s*'([a-z-]+)',\s*tier:\s*'([a-z]+)',\s*evidence:\s*'([^']+)'/)
check('MERCURY_CACHE_CLOCK registry row exists with tier + evidence', !!row)
if (row) {
  check("row tier is 'behavioral' (the ladder's evidence-bearing tier)", row[2] === 'behavioral')
  check(
    'row evidence names this verdict',
    row[3] === 'scripts/cache/fixtures/verdict.json',
    row[3],
  )
}
const scriptsDir = join(root, 'scripts')
const offenders: string[] = []
for (const d of readdirSync(scriptsDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  const runAll = join(scriptsDir, d.name, 'run-all.sh')
  if (existsSync(runAll) && readFileSync(runAll, 'utf8').match(/^[^#\n]*extract-corpus/m)) {
    offenders.push(d.name)
  }
}
check(
  'no run-all.sh executes the transcript-reading extractor',
  offenders.length === 0,
  offenders.join(', '),
)

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ cache clock benchmark proof: all checks pass')
