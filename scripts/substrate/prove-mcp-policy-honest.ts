#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-mcp-policy-honest.ts
//  PROOF (audit-cycle-1): the MCP risk-policy gate reports its state HONESTLY on
//  every status surface, including per-server overrides.
//
//  Bug (was): every surface derived "gate on/off" from `getMaxExposedRisk() !== 'high'`,
//  which returns ONLY the bare fallback. A per-server clamp with no bare default
//  (MERCURY_MCP_MAX_RISK=untrusted-srv:low) leaves fallback='high' yet ENFORCES (those
//  tools are denied at discovery + invocation) — so /policy, /mcp, /status, /deck,
//  /substrate, /doctor all reported the live gate as OFF / 'permissive' / 'wide open'.
//
//  Fix: a single source of truth — isMcpPolicyActive() = fallback!=='high' OR
//  perServer.size>0 — threaded as a SEPARATE boolean (mcpPolicyActive) + a hint
//  (mcpPolicyHint = describeMcpPolicy()) snapshot→panels, WITHOUT overloading the
//  displayed maxRisk string (downstream === 'high' string checks stay intact). OFF /
//  no-override is byte-identical (active=false, exactly the old !== 'high').
//
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-mcp-policy-honest.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMcpPolicyActive, describeMcpPolicy, getMaxExposedRisk } from '../../src/services/mcp/toolPolicy.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
function withEnv<T>(v: string | undefined, fn: () => T): T {
  const prev = process.env.MERCURY_MCP_MAX_RISK
  if (v === undefined) delete process.env.MERCURY_MCP_MAX_RISK
  else process.env.MERCURY_MCP_MAX_RISK = v
  try { return fn() } finally {
    if (prev === undefined) delete process.env.MERCURY_MCP_MAX_RISK
    else process.env.MERCURY_MCP_MAX_RISK = prev
  }
}

console.log('============================================================')
console.log(' MCP risk-policy gate — honest across surfaces (per-server)')
console.log('============================================================')

section('isMcpPolicyActive + describeMcpPolicy — every env regime')
check('unset ⇒ INACTIVE + "high · permissive" (byte-identical to the old !== high)', withEnv(undefined, () => isMcpPolicyActive() === false && describeMcpPolicy() === 'high · permissive'))
check('per-server-only clamp ⇒ ACTIVE (THE FIX: fallback stays high but it enforces)', withEnv('untrusted-srv:low', () => isMcpPolicyActive() === true && describeMcpPolicy() === 'default high · untrusted-srv:low'))
check('global low ⇒ ACTIVE + "default low"', withEnv('low', () => isMcpPolicyActive() === true && describeMcpPolicy() === 'default low'))
check('mixed default+override ⇒ "default low · scratch:medium"', withEnv('low,scratch:medium', () => describeMcpPolicy() === 'default low · scratch:medium'))
check('junk ⇒ INACTIVE + permissive (fail-open, never throws)', withEnv('@@junk@@', () => isMcpPolicyActive() === false))
check('getMaxExposedRisk() still returns the BARE fallback unchanged (string field intact)', withEnv('untrusted-srv:low', () => getMaxExposedRisk() === 'high'))

section('threaded as a SEPARATE boolean snapshot→panels (structural)')
const tp = src('services', 'mcp', 'toolPolicy.ts')
check('toolPolicy exports isMcpPolicyActive + describeMcpPolicy', /export function isMcpPolicyActive/.test(tp) && /export function describeMcpPolicy/.test(tp))
const mcps = src('utils', 'cockpit', 'mcpGauge.ts')
check('McpData carries mcpPolicyActive + mcpPolicyHint', /mcpPolicyActive: boolean/.test(mcps) && /mcpPolicyHint: string/.test(mcps))
check('mcpGauge threads the boolean through EVERY data arm (no missing-field undefined)', (mcps.match(/mcpPolicyActive/g) || []).length >= 4)
const perms = src('utils', 'cockpit', 'permissionsSnapshot.ts')
check('PermissionsData carries mcpPolicyActive (+ all arms)', /mcpPolicyActive: boolean/.test(perms) && (perms.match(/mcpPolicyActive/g) || []).length >= 3)
const sub = src('utils', 'cockpit', 'substrateSnapshot.ts')
check('substrateSnapshot uses isMcpPolicyActive() — the canonical bug line is fixed', /isMcpPolicyActive\(\)/.test(sub) && !/=== 'high'\s*[?)]/.test(sub.split('\n').filter(l => /mcpPolic/i.test(l)).join('\n')))

section('panels color/warn off the boolean, NOT the displayed === \'high\' string')
for (const [name, p] of [
  ['PolicyPanel', ['components', 'PolicyPanel.tsx']],
  ['MercuryMcpList', ['components', 'MercuryMcpList.tsx']],
  ['mercuryStatus', ['commands', 'status', 'mercuryStatus.tsx']],
  ['Deck', ['components', 'Deck.tsx']],
  // DeckPane: removed — the strip no longer renders the mcp posture
  // chip (declutter; the full /deck snapshot is its single owner, asserted via
  // Deck.tsx above).
  ['healthReport', ['utils', 'healthReport.ts']],
] as const) {
  check(`${name} keys off mcpPolicyActive`, /mcpPolicyActive/.test(src(...p)))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MCP-POLICY-HONEST PROOFS PASS')
else console.log(`❌ ${failures} MCP-POLICY-HONEST PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
