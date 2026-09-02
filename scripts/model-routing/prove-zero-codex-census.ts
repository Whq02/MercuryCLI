#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-zero-codex-census.ts
//  PROOF: the external Codex
//  App Server runtime is ABSENT from the live estate — no runtime directory, no
//  imports, no executable pin, no census domain, no transport member, no
//  built-artifact residue. The law targets the LOCAL runtime: the OpenAI
//  server path `chatgpt.com/backend-api/codex` (a subscription API base) and
//  historical are DELIBERATELY exempt. Self-contained fs
//  walk — no subprocess grep (host rg/ugrep variance is not a proof input).
//
//  reconciliation: the living-crew
//  attaches the OPERATOR-INSTALLED codex CLI as an EXTERNAL SEAT
//  (src/services/crew/ + src/commands/crew/ — the inward seat bridge, the
//  external-seat shape). That is not the embedded runtime
//  this law erased: no provider path, no engine kind, no transport member,
//  no bundled pin. The reconciliation: the first-boot
//  capacity probe (src/services/switchboard/capacityCheck.ts) OBSERVES other
//  running agent CLIs by process name — no spawn, no lookup, no pin. The
//  spawn/lookup row therefore holds at FULL strength outside these two
//  adjudicated estates; every other row is unchanged.
//
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-zero-codex-census.ts
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const SELF = join(import.meta.dir, 'prove-zero-codex-census.ts')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx|mjs|js|sh)$/.test(entry)) yield full
  }
}

/** Files under `roots` whose text matches `pattern` (this prover excluded). */
function hits(roots: string[], pattern: RegExp): string[] {
  const out: string[] = []
  for (const root of roots) {
    for (const file of walk(join(ROOT, root))) {
      if (file === SELF) continue
      if (pattern.test(readFileSync(file, 'utf8'))) out.push(relative(ROOT, file))
    }
  }
  return out
}

console.log('============================================================')
console.log(' zero-Codex census (source + registry + artifact)')
console.log('============================================================')

check(
  'the runtime directory is gone (src/services/providers/codex)',
  !existsSync(join(ROOT, 'src', 'services', 'providers', 'codex')),
)

const importHits = hits(['src', 'scripts'], /providers\/codex/)
check('no import/path reference to providers/codex anywhere in src or scripts', importHits.length === 0, importHits.join(', '))

const pinHits = hits(['src'], /HERMES_CODEX_BIN/)
check('the HERMES_CODEX_BIN pin is gone from src', pinHits.length === 0, pinHits.join(', '))

const flagRegistrySrc = readFileSync(join(ROOT, 'src', 'substrate', 'flagRegistry.ts'), 'utf8')
check('the flag registry carries no HERMES_CODEX_BIN row', !flagRegistrySrc.includes('HERMES_CODEX_BIN'))

const executionSrc = readFileSync(join(ROOT, 'src', 'services', 'primitives', 'execution.ts'), 'utf8')
check("the execution plane has no 'codex-engine' kind", !executionSrc.includes("'codex-engine'"))

const censusSrc = readFileSync(join(ROOT, 'src', 'services', 'primitives', 'executionCensus.ts'), 'utf8')
check('the running-work census has no codex domain', !/codex/i.test(censusSrc))

const typesSrc = readFileSync(join(ROOT, 'src', 'utils', 'router', 'providers', 'types.ts'), 'utf8')
check(
  "RouterTransport has no live 'codex-app-server' MEMBER (comment mentions allowed)",
  !/\|\s*'codex-app-server'/.test(typesSrc),
)

const spawnHitsAll = hits(['src'], /(spawn|execFile)[^\n]*codex|['"]codex['"]/)
// Two adjudicated exceptions, neither an embedded runtime:
// the crew SEAT estate (the operator's own installed CLI
//    attached as an external teammate);
// the switchboard capacity probe: an
//    OBSERVER that counts OTHER running agent CLIs by `ps` process NAME
//    (claude/mercury/codex/gemini) to shave seats — it never spawns,
//    resolves, or pins a codex executable.
const CREW_SEAT_ESTATE = /^src[\/\\](services[\/\\]crew|commands[\/\\]crew)[\/\\]/
const CAPACITY_OBSERVER = /^src[\/\\]services[\/\\]switchboard[\/\\]capacityCheck\.ts$/
// the foreign-harness RECOGNIZER: a signature table that names sibling agent
//    CLIs (codex-cli among them) to attribute log writers — pattern text
//    only. The exemption has TEETH: the file must stay spawn-free (asserted
//    below), so a future exec there goes red, never grandfathered.
const FOREIGN_RECOGNIZER = /^src[\/\\]utils[\/\\]knownAgentClis\.ts$/
const spawnHits = spawnHitsAll.filter(f => !CREW_SEAT_ESTATE.test(f) && !CAPACITY_OBSERVER.test(f) && !FOREIGN_RECOGNIZER.test(f))
check(
  'no codex executable spawn/lookup survives in src outside the adjudicated estates (crew seat + capacity observer + foreign-harness recognizer)',
  spawnHits.length === 0,
  spawnHits.join(', '),
)
const foreignRecognizerSrc = readFileSync(join(ROOT, 'src', 'utils', 'knownAgentClis.ts'), 'utf8')
check(
  'the foreign-harness recognizer earns its exemption: no spawn/exec of ANY kind in the file',
  !/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/.test(foreignRecognizerSrc),
)

// Built-artifact residue: the census gates closure against the REAL product.
const dist = join(ROOT, 'dist', 'mercury.mjs')
if (existsSync(dist)) {
  const bundle = readFileSync(dist, 'utf8')
  check('dist carries no HERMES_CODEX_BIN residue', !bundle.includes('HERMES_CODEX_BIN'))
  check('dist carries no App Server sentinel residue', !bundle.includes('codex-app-server-default'))
} else {
  console.log('  [SKIP] dist/mercury.mjs absent — artifact residue rows run under the gate (prebuilt)')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ZERO-CODEX CENSUS GREEN')
else console.log(`${failures} ZERO-CODEX CENSUS CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
