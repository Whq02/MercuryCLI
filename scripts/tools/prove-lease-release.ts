#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-lease-release.ts
//  PROOF for: releaseAllForAgent + sweepExpiredLeases had ZERO callers,
//  and the in-process teammate cleanup only abort()'d — never released its lease.
//  A dead owner's lease false-blocked others until the 30m TTL and its record
//  lingered (leases.json grew). The fix wires releaseAllForAgent into the
//  spawnInProcess cleanup and sweepExpiredLeases into the lease_list MCP tool.
//
//  leaseGlob.ts IS loadable (color-diff-napi stubbed), so this drives the REAL
//  lease lifecycle + locks the two new call sites by source-text.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-lease-release.ts
// ============================================================================
import { plugin } from 'bun'
plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hermes-lease-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const L = await import('../../src/utils/swarm/leaseGlob.js')

console.log('============================================================')
console.log(' lease release + sweep — wired (HB-0081)')
console.log('============================================================')

section('LIVE: releaseAllForAgent frees a dead agent’s leases (cleanup path)')
const team = 'proveteam'
await L.claimLease(team, 'agentA@t', ['src/**'])
await L.claimLease(team, 'agentB@t', ['docs/**'])
check('two agents hold leases', (await L.listLeases(team)).length === 2)
const dropped = await L.releaseAllForAgent(team, 'agentA@t')
check('releaseAllForAgent(agentA) returns true (a lease was dropped)', dropped === true)
const after = await L.listLeases(team)
check('agentA’s lease is gone, agentB’s survives', after.length === 1 && after[0]!.agentId === 'agentB@t')
check('releaseAllForAgent is idempotent (second call drops nothing)', (await L.releaseAllForAgent(team, 'agentA@t')) === false)

section('LIVE: sweepExpiredLeases prunes stale records (list path)')
const t2 = 'proveteam2'
await L.claimLease(t2, 'ghost@t', ['lib/**'])
check('the lease exists now', (await L.listLeases(t2)).length === 1)
// 31 minutes in the future ⇒ past the TTL ⇒ expired.
const future = Date.now() + 31 * 60 * 1000
const removed = await L.sweepExpiredLeases(t2, { nowMs: future })
check('sweepExpiredLeases removes the expired record from disk', removed === 1)
check('the store no longer carries the stale lease', (await L.listLeases(t2, { nowMs: future })).length === 0)

section('source: the two call sites are wired (no longer 0-caller dead code)')
const spawn = readFileSync(join(ROOT, 'src', 'utils', 'swarm', 'spawnInProcess.ts'), 'utf-8')
check('spawnInProcess cleanup calls releaseAllForAgent(teamName, agentId)', /await releaseAllForAgent\(config\.teamName, agentId\)/.test(spawn))
// The lease verbs live in the coordination service; the MCP server is a
// projection over it, so the opportunistic sweep is pinned where it runs.
const service = readFileSync(join(ROOT, 'src', 'services', 'coordination', 'coordinationService.ts'), 'utf-8')
check('lease_list opportunistically calls sweepExpiredLeases(ctx.team)', /await sweepExpiredLeases\(ctx\.team\)\.catch/.test(service))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL LEASE-RELEASE PROOFS PASS')
else console.log(`❌ ${failures} LEASE-RELEASE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
