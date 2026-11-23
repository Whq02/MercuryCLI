#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { EXECUTION_DOMAIN_CENSUS } from '../../src/engine/runtime-kernel/executionCensus.ts'

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
  'the runtime directory is gone (src/models/roads/codex)',
  !existsSync(join(ROOT, 'src', 'models', 'roads', 'codex')),
  'delete the directory src/models/roads/codex and everything that imports it',
)

const importHits = hits(['src', 'scripts'], /roads\/codex/)
check('no import/path reference to roads/codex anywhere in src or scripts', importHits.length === 0, importHits.join(', ') + ' | remove the roads/codex import or path in each file listed')

check(
  'the running-work census has no codex domain',
  EXECUTION_DOMAIN_CENSUS.every(entry => !/codex/i.test(entry.domain) && !/codex/i.test(entry.kind ?? '')),
  'remove the codex entry from EXECUTION_DOMAIN_CENSUS in src/engine/runtime-kernel/executionCensus.ts',
)

const spawnHitsAll = hits(['src'], /(spawn|execFile)[^\n]*codex|['"]codex['"]/)
const CREW_SEAT_ESTATE = /^src[\/\\](crew[\/\\]crewmates|commands[\/\\]crew)[\/\\]/
const CAPACITY_OBSERVER = /^src[\/\\]daemon[\/\\]switchboard-capacity[\/\\]capacityCheck\.ts$/
const FOREIGN_RECOGNIZER = /^src[\/\\]platform[\/\\]environment[\/\\]knownAgentClis\.ts$/
const spawnHits = spawnHitsAll.filter(f => !CREW_SEAT_ESTATE.test(f) && !CAPACITY_OBSERVER.test(f) && !FOREIGN_RECOGNIZER.test(f))
check(
  'no codex executable spawn/lookup survives in src outside the adjudicated estates (crew seat + capacity observer + foreign-harness recognizer)',
  spawnHits.length === 0,
  spawnHits.join(', ') + ' | remove the codex spawn/lookup from each file listed, or move it into one of the three named estates in this proof',
)

const dist = join(ROOT, 'dist', 'mercury.mjs')
if (existsSync(dist)) {
  const bundle = readFileSync(dist, 'utf8')
  check('dist carries no App Server sentinel residue', !bundle.includes('codex-app-server-default'), 'dist/mercury.mjs is stale or still built from a source that carries codex-app-server-default: remove that string from src and rebuild')
} else {
  console.log('  [SKIP] dist/mercury.mjs absent — artifact residue rows run under the gate (prebuilt)')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ZERO-CODEX CENSUS GREEN')
else console.log(`${failures} ZERO-CODEX CENSUS CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
