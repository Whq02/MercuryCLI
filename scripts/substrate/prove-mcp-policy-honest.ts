#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { isMcpPolicyActive, describeMcpPolicy, getMaxExposedRisk } from '../../src/services/mcp/toolPolicy.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
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


section('panels color/warn off the boolean, NOT the displayed === \'high\' string')
{
  ;(await import('../../src/utils/config.ts')).enableConfigs()
  const { runtimeChecks } = await import('../../src/utils/health/sections/runtime.ts')
  const { publishMcpConnections } = await import('../../src/utils/cockpit/mcpGauge.ts')
  const mcpRow = runtimeChecks().find(row => row.id === 'mcp')
  publishMcpConnections([{ name: 'fixture-srv', type: 'pending' } as never])
  const permissive = withEnv(undefined, () => mcpRow?.run()) as { status: string; evidence: string; fix?: string } | undefined
  const clamped = withEnv('untrusted-srv:low', () => mcpRow?.run()) as { status: string; evidence: string; fix?: string } | undefined
  publishMcpConnections([])
  const { describeMcpProtocolCurrency } = await import('../../src/services/mcp/protocolRevision.ts')
  const behind = describeMcpProtocolCurrency().behind
  check(
    'the health mcp row keys off mcpPolicyActive',
    permissive?.status === (behind ? 'warn' : 'info') && permissive.evidence.includes(' · policy high · permissive · ') && (behind || permissive.fix?.startsWith('Tighten if desired') === true) && clamped?.status === (behind ? 'warn' : 'ok') && clamped.evidence.includes(' · policy default high · untrusted-srv:low · '),
    `${permissive?.status}: ${permissive?.evidence} | ${clamped?.status}: ${clamped?.evidence}`,
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MCP-POLICY-HONEST PROOFS PASS')
else console.log(`❌ ${failures} MCP-POLICY-HONEST PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
