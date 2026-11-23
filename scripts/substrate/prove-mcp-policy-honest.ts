#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { isMcpPolicyActive, describeMcpPolicy, getMaxExposedRisk } from '../../src/integrations/mcp-shapes/toolPolicy.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : [detail, hint].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
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
check('unset ⇒ INACTIVE + "high · permissive" (byte-identical to the old !== high)', withEnv(undefined, () => isMcpPolicyActive() === false && describeMcpPolicy() === 'high · permissive'), '', 'with MERCURY_MCP_MAX_RISK unset, isMcpPolicyActive must be false and describeMcpPolicy must read high · permissive: see src/integrations/mcp-shapes/toolPolicy.ts')
check('per-server-only clamp ⇒ ACTIVE (THE FIX: fallback stays high but it enforces)', withEnv('untrusted-srv:low', () => isMcpPolicyActive() === true && describeMcpPolicy() === 'default high · untrusted-srv:low'), '', 'isMcpPolicyActive in src/integrations/mcp-shapes/toolPolicy.ts must count a per-server clamp as active even when the fallback stays high')
check('global low ⇒ ACTIVE + "default low"', withEnv('low', () => isMcpPolicyActive() === true && describeMcpPolicy() === 'default low'), '', 'isMcpPolicyActive and describeMcpPolicy in src/integrations/mcp-shapes/toolPolicy.ts must treat a global low as active and describe it as default low')
check('mixed default+override ⇒ "default low · scratch:medium"', withEnv('low,scratch:medium', () => describeMcpPolicy() === 'default low · scratch:medium'), '', 'describeMcpPolicy in src/integrations/mcp-shapes/toolPolicy.ts must list the default first and then each per-server override')
check('junk ⇒ INACTIVE + permissive (fail-open, never throws)', withEnv('@@junk@@', () => isMcpPolicyActive() === false), '', 'isMcpPolicyActive in src/integrations/mcp-shapes/toolPolicy.ts must return false for an unparsable value instead of throwing')
check('getMaxExposedRisk() still returns the BARE fallback unchanged (string field intact)', withEnv('untrusted-srv:low', () => getMaxExposedRisk() === 'high'), '', 'getMaxExposedRisk in src/integrations/mcp-shapes/toolPolicy.ts must keep returning the bare fallback (high) when only a per-server clamp is set')


section('panels color/warn off the boolean, NOT the displayed === \'high\' string')
{
  ;(await import('../../src/platform/settings/config.ts')).enableConfigs()
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const { publishMcpConnections } = await import('../../src/screen/cockpit-gauges/mcpGauge.ts')
  const mcpRow = runtimeChecks().find(row => row.id === 'mcp')
  publishMcpConnections([{ name: 'fixture-srv', type: 'pending' } as never])
  const permissive = withEnv(undefined, () => mcpRow?.run()) as { status: string; evidence: string; fix?: string } | undefined
  const clamped = withEnv('untrusted-srv:low', () => mcpRow?.run()) as { status: string; evidence: string; fix?: string } | undefined
  publishMcpConnections([])
  const { describeMcpProtocolCurrency } = await import('../../src/integrations/mcp/protocolRevision.ts')
  const behind = describeMcpProtocolCurrency().behind
  check(
    'the health mcp row keys off mcpPolicyActive',
    permissive?.status === (behind ? 'warn' : 'info') && permissive.evidence.includes(' · policy high · permissive · ') && (behind || permissive.fix?.startsWith('Tighten if desired') === true) && clamped?.status === (behind ? 'warn' : 'ok') && clamped.evidence.includes(' · policy default high · untrusted-srv:low · '),
    `${permissive?.status}: ${permissive?.evidence} | ${clamped?.status}: ${clamped?.evidence}`,
    'the mcp row of runtimeChecks in src/platform/health/sections/runtime.ts must pick its status, evidence policy text and fix text from isMcpPolicyActive, not from the displayed string being high',
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MCP-POLICY-HONEST PROOFS PASS')
else console.log(`❌ ${failures} MCP-POLICY-HONEST PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
