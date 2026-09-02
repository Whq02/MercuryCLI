#!/usr/bin/env bun

import {
  globMatchesFile,
  globsOverlap,
  relScope,
} from '../../src/utils/swarm/leaseGlob.js'
import { getCurrentLeaseAgentId } from '../../src/utils/swarm/leaseGuard.js'
import { resolveCoordAgentId } from '../../src/utils/teammate.js'
import { TEAM_LEAD_NAME } from '../../src/utils/swarm/constants.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' File-lease guard — review-fix proof (#6 id · #7 globstar)')
console.log('============================================================')

section('#6 — leader claim id === guard id (no self-conflict)')
check('getCurrentLeaseAgentId() === resolveCoordAgentId() (one source)', getCurrentLeaseAgentId() === resolveCoordAgentId())
check('leader (no teammate ctx) resolves to TEAM_LEAD_NAME', resolveCoordAgentId() === TEAM_LEAD_NAME)
check('guard id is also TEAM_LEAD_NAME (was a session UUID → self-conflict)', getCurrentLeaseAgentId() === TEAM_LEAD_NAME)

section('#7 — `**` matches zero or more segments (no guard false-ALLOW)')
const G = 'src/' + '**' + '/api.ts'
check('zero intermediate segments: matches src/api.ts (the FIX — was a false-allow)', globMatchesFile(G, 'src/api.ts') === true)
check('one segment: matches src/x/api.ts', globMatchesFile(G, 'src/x/api.ts') === true)
check('two segments: matches src/x/y/api.ts', globMatchesFile(G, 'src/x/y/api.ts') === true)
check('wrong prefix does NOT match (lib/api.ts)', globMatchesFile(G, 'lib/api.ts') === false)
check('wrong suffix does NOT match (src/api.tsx)', globMatchesFile(G, 'src/api.tsx') === false)

const LEAD = '**' + '/api.ts'
check('leading globstar matches top-level api.ts (zero dirs)', globMatchesFile(LEAD, 'api.ts') === true)
check('leading globstar matches x/api.ts', globMatchesFile(LEAD, 'x/api.ts') === true)

section('#7 — single `*` stays single-segment; trailing/literal unchanged')
check('src/*.ts matches src/a.ts', globMatchesFile('src/*.ts', 'src/a.ts') === true)
check('src/*.ts does NOT match nested src/a/b.ts', globMatchesFile('src/*.ts', 'src/a/b.ts') === false)
check('trailing src/** matches the whole subtree', globMatchesFile('src/' + '**', 'src/a/b.ts') === true)
check('literal dir src/api matches a file under it', globMatchesFile('src/api', 'src/api/x.ts') === true)
check('`..`-escaping pattern never matches (defense-in-depth)', globMatchesFile('../etc/passwd', '../etc/passwd') === false)

section('Invariant: whatever the CLAIM locks, the GUARD matches (no gap)')
check('claim: globsOverlap(src/**​/api.ts, src/api.ts) locks it', globsOverlap(G, 'src/api.ts') === true)
check('guard: globMatchesFile(src/**​/api.ts, src/api.ts) matches it', globMatchesFile(G, 'src/api.ts') === true)
check('overlap basics: src/** overlaps src/foo.ts', globsOverlap('src/' + '**', 'src/foo.ts') === true)
check('overlap basics: src/a/** does NOT overlap src/b/**', globsOverlap('src/a/' + '**', 'src/b/' + '**') === false)

section('base-stability — one stable base ⇒ claim glob and guard path agree')
const ROOT = '/repo'
const WT = '/repo/wt'
const ABS = '/repo/src/api.ts'
check('relScope(abs, root) === src/api.ts (in-namespace)', relScope(ABS, ROOT) === 'src/api.ts')
check('guard under same base matches the leased rel', globMatchesFile(relScope(ABS, ROOT), relScope(ABS, ROOT)) === true)
const escaped = relScope(ABS, WT)
check('relScope(abs, worktree-cwd) escapes (../src/api.ts) — the old false-allow', escaped.startsWith('../'))
check('an escaped path can never match an in-namespace lease (guard would allow)', globMatchesFile('src/api.ts', escaped) === false)
check('relScope(src/api.ts, root) stable === src/api.ts', relScope('src/api.ts', ROOT) === 'src/api.ts')

section('#7 audit-r1 — leader teamContext threaded into checkLeaseGuard (no leader fail-open)')
{
  const { readFileSync } = await import('node:fs')
  const here = new URL('.', import.meta.url).pathname
  const lg = readFileSync(here + '../../src/utils/swarm/leaseGuard.ts', 'utf8')
  const { readdirSync } = await import('node:fs')
  const hk = readFileSync(here + '../../src/utils/hooks.ts', 'utf8') + readdirSync(here + '../../src/utils/hooks').filter(f => f.endsWith('.ts')).map(f => readFileSync(here + '../../src/utils/hooks/' + f, 'utf8')).join('\n')
  check('checkLeaseGuard takes a leaderTeamContext + resolves getTeamName(it)', /leaderTeamContext/.test(lg) && /getTeamName\(\s*\n?\s*leaderTeamContext/.test(lg))
  check('the PreToolUse hook passes appState.teamContext to checkLeaseGuard', /checkLeaseGuard\([\s\S]{0,120}appState\.teamContext/.test(hk))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL LEASE-GUARD PROOFS PASS')
else console.log(`❌ ${failures} LEASE-GUARD PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
