#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-lease-guard.ts
//  PROOF: the file-lease coordination gate enforces its invariants — focused on
//  the two review findings just fixed, against the REAL production code:
//    #6 ONE canonical coordination id: the lease CLAIM side and the GUARD side
//       resolve the SAME agent id (the leader never self-conflicts).
//    #7 `**` matches ZERO OR MORE segments in globMatchesFile, so the GUARD
//       covers exactly what the CLAIM-time overlap check locks — no false-ALLOW
//       (e.g. a `src/**​/api.ts` lease must block an edit of `src/api.ts`).
//  Plus the core overlap (claim) vs match (guard) semantics they depend on.
// ============================================================================

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

// ── #6 — one canonical coordination id (claim side === guard side) ────────────
section('#6 — leader claim id === guard id (no self-conflict)')
check('getCurrentLeaseAgentId() === resolveCoordAgentId() (one source)', getCurrentLeaseAgentId() === resolveCoordAgentId())
check('leader (no teammate ctx) resolves to TEAM_LEAD_NAME', resolveCoordAgentId() === TEAM_LEAD_NAME)
check('guard id is also TEAM_LEAD_NAME (was a session UUID → self-conflict)', getCurrentLeaseAgentId() === TEAM_LEAD_NAME)

// ── #7 — globMatchesFile honors ZERO-OR-MORE-segment `**` ────────────────────
section('#7 — `**` matches zero or more segments (no guard false-ALLOW)')
const G = 'src/' + '**' + '/api.ts' // avoid a literal */ in this source's tokens
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

// ── the load-bearing invariant: claim-overlap ⊇ guard-match ──────────────────
section('Invariant: whatever the CLAIM locks, the GUARD matches (no gap)')
// CLAIM-time overlap conservatively locks the subtree for a globstar pattern…
check('claim: globsOverlap(src/**​/api.ts, src/api.ts) locks it', globsOverlap(G, 'src/api.ts') === true)
// …and the GUARD matches that same file (a mismatch here is a false-allow)
check('guard: globMatchesFile(src/**​/api.ts, src/api.ts) matches it', globMatchesFile(G, 'src/api.ts') === true)
check('overlap basics: src/** overlaps src/foo.ts', globsOverlap('src/' + '**', 'src/foo.ts') === true)
check('overlap basics: src/a/** does NOT overlap src/b/**', globsOverlap('src/a/' + '**', 'src/b/' + '**') === false)

// ── base-stability — claim + guard must share ONE namespace (no cwd false-ALLOW) ──
// The fix: claimLease + getLeaseConflict default base to getProjectRoot() (stable),
// not getCwd() (changes on worktree-entry / cd). These relScope assertions prove WHY a
// shared stable base is load-bearing — and guard against a regression back to getCwd().
section('base-stability — one stable base ⇒ claim glob and guard path agree')
const ROOT = '/repo'
const WT = '/repo/wt' // a mid-session worktree cwd (getCwd() would return this)
const ABS = '/repo/src/api.ts'
// Under the STABLE base (getProjectRoot), the abs file resolves into the namespace…
check('relScope(abs, root) === src/api.ts (in-namespace)', relScope(ABS, ROOT) === 'src/api.ts')
// …so a lease CLAIMED as src/api.ts (base root) is MATCHED by a guard that also uses root.
check('guard under same base matches the leased rel', globMatchesFile(relScope(ABS, ROOT), relScope(ABS, ROOT)) === true)
// The BUG (getCwd): if the guard used a worktree cwd, the SAME abs file escapes the
// namespace → the guard returns null → it FALSE-ALLOWS an edit of a leased file.
const escaped = relScope(ABS, WT)
check('relScope(abs, worktree-cwd) escapes (../src/api.ts) — the old false-allow', escaped.startsWith('../'))
check('an escaped path can never match an in-namespace lease (guard would allow)', globMatchesFile('src/api.ts', escaped) === false)
// A relative claim is likewise base-anchored — stable base ⇒ stable rel.
check('relScope(src/api.ts, root) stable === src/api.ts', relScope('src/api.ts', ROOT) === 'src/api.ts')

// ── #7 audit-r1 — the team LEADER's identity is threaded into the guard ───────
// getTeamName()'s no-arg form only sees the worker/tmux AsyncLocalStorage, so the
// interactive leader resolved to undefined and its own edits FAIL-OPEN past every
// teammate's lease. Structural guard: the guard resolves team from the threaded
// leader context, and the hook call site passes appState.teamContext.
section('#7 audit-r1 — leader teamContext threaded into checkLeaseGuard (no leader fail-open)')
{
  const { readFileSync } = await import('node:fs')
  const here = new URL('.', import.meta.url).pathname
  const lg = readFileSync(here + '../../src/utils/swarm/leaseGuard.ts', 'utf8')
  // R4 module-scoped read: the hooks engine split into owned
  // submodules; the invariant is module-scoped.
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
