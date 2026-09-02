#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-idiom-hygiene.ts — slice-2 census-zero ratchet.
//
//  Pins the ratified deletions of the's early slice so they
//  stay deleted (the H58/H59 classes):
// the dead telemetry probes (isRunningOnHomespace /
//          isInProtectedNamespace) are absent from src.
// the walkChainBeforeParse doc lives WITH its implementation
//          (loading.ts), not orphaned in logs.ts.
// the dead statsig helpers (getAPIProviderForStatsig /
//          tokenStatsToStatsigMetrics) are absent from src.
// the coordination-server prover exercises the MERCURY_* primary spelling
//          (no earlier MERCURY_COORDINATION_MCP pin, no '-hermes' MACRO probe).
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* tsFiles(p)
    else if (/\.tsx?$/.test(e)) yield p
  }
}

console.log('============================================================')
console.log(' hygiene — slice-2 census-zero ratchet (C14/C18/C19/C21)')
console.log('============================================================')

const offenders: string[] = []
for (const f of tsFiles(join(ROOT, 'src'))) {
  const text = readFileSync(f, 'utf8')
  for (const sym of [
    'isRunningOnHomespace',
    'isInProtectedNamespace',
    'getAPIProviderForStatsig',
    'tokenStatsToStatsigMetrics',
  ]) {
    if (text.includes(sym)) offenders.push(`${f}: ${sym}`)
  }
}
check('C18/C14: zero references to the deleted probes/helpers in src', offenders.length === 0, offenders.slice(0, 4).join(' · '))

const logs = readFileSync(join(ROOT, 'src/utils/sessionStorage/logs.ts'), 'utf8')
const loading = readFileSync(join(ROOT, 'src/utils/sessionStorage/loading.ts'), 'utf8')
check('C21: logs.ts carries no orphaned pre-filter doc', !logs.includes('Byte-level pre-filter'))
// C21 evolved with the pruning rebuild (operator-ruled): the byte-level
// pre-filter EXISTS again, canonical-native — the pin now demands the
// record-format shape (parsed link truth) and the absence of every
// legacy-layout residue class.
check(
  'C21: no legacy-layout pre-filter residue in loading.ts',
  !loading.includes('walkChainBeforeParse') &&
    !loading.includes('pickDepthOneUuidCandidate') &&
    !loading.includes('{"parentUuid":'),
)
check(
  'C21: the canonical pruner keys on the record envelope and parses its links',
  loading.includes('pruneRecordBranchesBeforeParse') &&
    loading.includes('{"schemaVersion":1,"recordId":"') &&
    loading.includes('LINK TRUTH COMES FROM THE PARSED LINE'),
)

const coordProver = readFileSync(join(ROOT, 'scripts/substrate/prove-coordination-server.ts'), 'utf8')
check('C19: coordination-server prover pins the MERCURY_* primary spelling', coordProver.includes("process.env.MERCURY_COORDINATION_MCP = '1'"))
// The retired spellings are composed so this prover never spells them itself.
const RETIRED_MCP_ENV = ['MERCURY_TEMP', 'EST_MCP'].join('')
check('C19: earlier probes retired from the prover', !coordProver.includes(RETIRED_MCP_ENV) && !coordProver.includes('-hermes-proof'))

console.log(failures === 0 ? '\n ✅ HYGIENE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
