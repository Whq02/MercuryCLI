#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-mcp-policy.ts
//  PROOF: the MCP risk policy gate (filters external MCP tools by annotation
//  risk) classifies + admits correctly, including the HOSTILE-annotation
//  hardening — a malicious server must not be able to downgrade its own risk.
//  Exercised against the REAL production module src/services/mcp/toolPolicy.ts.
//  This gate had no committed regression coverage.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyMcpToolRisk,
  describeUntrustedMcpHardening,
  getMaxExposedRisk,
  getMaxExposedRiskForServer,
  isUntrustedMcpHardeningOn,
  mcpToolAllowed,
  mcpPolicyDenyReason,
} from '../../src/services/mcp/toolPolicy.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' MCP risk-policy gate — security regression proof')
console.log('============================================================')

section('classifyMcpToolRisk — honest annotations')
check('readOnlyHint:true ⇒ low', classifyMcpToolRisk({ readOnlyHint: true }) === 'low')
check('destructiveHint:true ⇒ high', classifyMcpToolRisk({ destructiveHint: true }) === 'high')
check('openWorldHint:true ⇒ high', classifyMcpToolRisk({ openWorldHint: true }) === 'high')
check('no annotations ⇒ medium (unknown is NOT low)', classifyMcpToolRisk({}) === 'medium')
check('undefined annotations ⇒ medium', classifyMcpToolRisk(undefined) === 'medium')

section('classifyMcpToolRisk — HOSTILE annotations (server cannot downgrade)')
check('readOnly + destructive contradiction ⇒ high (refuse the low downgrade)', classifyMcpToolRisk({ readOnlyHint: true, destructiveHint: true }) === 'high')
check('readOnly + open-world ⇒ high (exfiltration vector: reads AND reaches out)', classifyMcpToolRisk({ readOnlyHint: true, openWorldHint: true }) === 'high')
check('pure read-only (no destructive/open-world) is still low', classifyMcpToolRisk({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }) === 'low')
// @ts-expect-error intentionally hostile non-boolean shapes
check('readOnlyHint:"yes" (truthy non-bool) ⇒ NOT low (medium)', classifyMcpToolRisk({ readOnlyHint: 'yes' }) === 'medium')
// @ts-expect-error
check('readOnlyHint:1 ⇒ NOT low (medium)', classifyMcpToolRisk({ readOnlyHint: 1 }) === 'medium')
// @ts-expect-error
check('readOnlyHint:{} ⇒ NOT low (medium)', classifyMcpToolRisk({ readOnlyHint: {} }) === 'medium')
// a destructive tool that ALSO sends a junk readOnly must stay high
// @ts-expect-error
check('destructive + readOnly:"true"(string) ⇒ high (no downgrade)', classifyMcpToolRisk({ destructiveHint: true, readOnlyHint: 'true' }) === 'high')

section('getMaxExposedRisk — threshold resolution (permissive default)')
delete process.env.MERCURY_MCP_MAX_RISK
check('unset ⇒ high (permissive default exposes everything)', getMaxExposedRisk() === 'high')
process.env.MERCURY_MCP_MAX_RISK = 'low'
check("'low' honored", getMaxExposedRisk() === 'low')
process.env.MERCURY_MCP_MAX_RISK = 'MEDIUM'
check('case-insensitive (MEDIUM)', getMaxExposedRisk() === 'medium')
process.env.MERCURY_MCP_MAX_RISK = '  High '
check('trims + lowercases ("  High ")', getMaxExposedRisk() === 'high')
process.env.MERCURY_MCP_MAX_RISK = 'banana'
check('junk ⇒ high (never throws, permissive fallback)', getMaxExposedRisk() === 'high')

section('mcpToolAllowed — admit at-or-below threshold')
process.env.MERCURY_MCP_MAX_RISK = 'low'
check('max=low: a low tool is allowed', mcpToolAllowed('s', 't', { readOnlyHint: true }) === true)
check('max=low: a medium tool is DENIED', mcpToolAllowed('s', 't', {}) === false)
check('max=low: a high tool is DENIED', mcpToolAllowed('s', 't', { destructiveHint: true }) === false)
process.env.MERCURY_MCP_MAX_RISK = 'medium'
check('max=medium: medium allowed', mcpToolAllowed('s', 't', {}) === true)
check('max=medium: high DENIED', mcpToolAllowed('s', 't', { openWorldHint: true }) === false)
delete process.env.MERCURY_MCP_MAX_RISK
check('default (high): even a high tool is allowed', mcpToolAllowed('s', 't', { destructiveHint: true }) === true)

section('mcpPolicyDenyReason — names the risk + the policy max')
process.env.MERCURY_MCP_MAX_RISK = 'low'
{
  const reason = mcpPolicyDenyReason('github', 'create_issue', { destructiveHint: true })
  check('reason names the tool', reason.includes('github/create_issue'))
  check('reason names the risk (high) + the max (low)', reason.includes('high') && reason.includes('low'))
  check('reason cites the env var', reason.includes('MERCURY_MCP_MAX_RISK'))
}
delete process.env.MERCURY_MCP_MAX_RISK

section('per-server max-risk — MERCURY_MCP_MAX_RISK=default + server:risk overrides')
{
  // bare value only ⇒ byte-identical to the global default for every server.
  process.env.MERCURY_MCP_MAX_RISK = 'low'
  check('bare value: getMaxExposedRisk default = low', getMaxExposedRisk() === 'low')
  check('bare value: every server resolves to the default (low)', getMaxExposedRiskForServer('anything') === 'low')

  // default high, but clamp one untrusted server to low — trusted servers stay high.
  process.env.MERCURY_MCP_MAX_RISK = 'high,untrusted-srv:low'
  check('default stays high (global)', getMaxExposedRisk() === 'high')
  check('trusted server resolves to high (the default)', getMaxExposedRiskForServer('github') === 'high')
  check('untrusted server clamped to low (override wins)', getMaxExposedRiskForServer('untrusted-srv') === 'low')
  check('server match is case-insensitive', getMaxExposedRiskForServer('Untrusted-SRV') === 'low')
  // the gate bites per server: a high-risk tool is allowed on the trusted server, denied on the clamped one.
  check('high-risk tool ALLOWED on trusted server', mcpToolAllowed('github', 'create_issue', { destructiveHint: true }) === true)
  check('high-risk tool DENIED on the clamped server', mcpToolAllowed('untrusted-srv', 'rm', { destructiveHint: true }) === false)
  check('low-risk tool still allowed on the clamped server', mcpToolAllowed('untrusted-srv', 'read', { readOnlyHint: true }) === true)
  // deny reason cites the per-server max.
  check('deny reason cites the per-server max (low)', mcpPolicyDenyReason('untrusted-srv', 'rm', { destructiveHint: true }).includes('low'))

  // multiple overrides + a default.
  process.env.MERCURY_MCP_MAX_RISK = 'low,scratch:medium,ci:high'
  check('multi: default low', getMaxExposedRiskForServer('other') === 'low')
  check('multi: scratch:medium', getMaxExposedRiskForServer('scratch') === 'medium')
  check('multi: ci:high', getMaxExposedRiskForServer('ci') === 'high')

  // junk segments are ignored; an all-junk value is the permissive default.
  process.env.MERCURY_MCP_MAX_RISK = 'banana,foo:purple'
  check('all-junk ⇒ permissive default high', getMaxExposedRiskForServer('foo') === 'high' && getMaxExposedRisk() === 'high')
  delete process.env.MERCURY_MCP_MAX_RISK
  check('unset ⇒ permissive default high for any server', getMaxExposedRiskForServer('x') === 'high')
}

section('untrusted-server HARDENING — DEFAULT-OFF fork opt-in (MERCURY_MCP_UNTRUSTED_HARDENING=1)')
{
  const MACRO_KEY = 'MACRO' as const
  const setStamp = (on: boolean): void => {
    if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
    else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
  }
  // Clean slate: no bare policy, no trust list.
  delete process.env.MERCURY_MCP_MAX_RISK
  delete process.env.MERCURY_MCP_TRUSTED_SERVERS

  // --- DEFAULT-OFF ---
  setStamp(true)
  delete process.env.MERCURY_MCP_UNTRUSTED_HARDENING
  check('fork + env unset ⇒ hardening OFF', isUntrustedMcpHardeningOn() === false)
  // describe() now names BOTH states honestly (it gained its first
  // real consumer, the /doctor MCP check, which composes it into an evidence
  // line — a bare '' dangled a separator there). OFF is a described state, not ''.
  check('OFF ⇒ describe names the off state (honest, not empty)', describeUntrustedMcpHardening() === 'untrusted-hardening off')
  // THE load-bearing assertion: a high-risk untrusted tool is ALLOWED when OFF.
  check('OFF ⇒ high-risk untrusted tool ALLOWED (byte-identical to bare gate)',
    mcpToolAllowed('rando', 'wipe', { destructiveHint: true }) === true)
  process.env.MERCURY_MCP_UNTRUSTED_HARDENING = 'true'
  check('fork + env="true" ⇒ OFF (only exact "1" opts in)', isUntrustedMcpHardeningOn() === false)
  process.env.MERCURY_MCP_UNTRUSTED_HARDENING = '0'
  check('fork + env="0" ⇒ OFF', isUntrustedMcpHardeningOn() === false)

  // --- opt-in ON ---
  process.env.MERCURY_MCP_UNTRUSTED_HARDENING = '1'
  check('fork + env="1" ⇒ hardening ON', isUntrustedMcpHardeningOn() === true)
  check('ON ⇒ describe names the third-party gate', describeUntrustedMcpHardening().includes('untrusted'))
  // THE mirror assertion: the same high-risk untrusted tool is now DENIED.
  check('ON ⇒ high-risk untrusted tool DENIED (the real effect)',
    mcpToolAllowed('rando', 'wipe', { destructiveHint: true }) === false)
  check('ON ⇒ open-world untrusted tool DENIED',
    mcpToolAllowed('rando', 'fetch', { openWorldHint: true }) === false)
  check('ON ⇒ medium untrusted tool still ALLOWED (clamp is to medium, not low)',
    mcpToolAllowed('rando', 'do', {}) === true)
  check('ON ⇒ unverified readOnlyHint floored to medium but still ALLOWED (ceiling=medium)',
    mcpToolAllowed('rando', 'peek', { readOnlyHint: true }) === true)
  // deny reason names the actionable lift.
  {
    const reason = mcpPolicyDenyReason('rando', 'wipe', { destructiveHint: true })
    check('ON deny reason cites the hardening switch + trust list',
      reason.includes('MERCURY_MCP_UNTRUSTED_HARDENING') && reason.includes('MERCURY_MCP_TRUSTED_SERVERS'))
  }

  // --- ON + trusted server is exempt (allowlist honored) ---
  process.env.MERCURY_MCP_TRUSTED_SERVERS = 'rando,internal'
  check('ON + server on allowlist ⇒ high-risk tool ALLOWED again',
    mcpToolAllowed('rando', 'wipe', { destructiveHint: true }) === true)
  check('ON + a DIFFERENT untrusted server ⇒ still DENIED',
    mcpToolAllowed('thirdparty', 'wipe', { destructiveHint: true }) === false)
  delete process.env.MERCURY_MCP_TRUSTED_SERVERS

  // --- ON, but an EXPLICIT per-server override is honored as deliberate opt-in ---
  process.env.MERCURY_MCP_MAX_RISK = 'rando:high'
  check('ON + explicit srv:high override ⇒ high-risk tool ALLOWED (operator deliberate)',
    mcpToolAllowed('rando', 'wipe', { destructiveHint: true }) === true)
  delete process.env.MERCURY_MCP_MAX_RISK

  // --- the opt-in works under ANY stamp — a mis-stamped build cannot
  // silently drop the hardening.
  setStamp(false)
  process.env.MERCURY_MCP_UNTRUSTED_HARDENING = '1'
  check('bare stamp + env="1" ⇒ hardening ON (stamp-independence)', isUntrustedMcpHardeningOn() === true)
  check('bare stamp ⇒ high-risk untrusted tool STILL DENIED',
    mcpToolAllowed('rando', 'wipe', { destructiveHint: true }) === false)

  // restore
  delete process.env.MERCURY_MCP_UNTRUSTED_HARDENING
  delete process.env.MERCURY_MCP_TRUSTED_SERVERS
  setStamp(false)
}

section('FC-141 — a mistyped tightening never widens SILENTLY (forgive + name)')
{
  let getRejects: (() => string[]) | null = null
  let describePolicy: (() => string) | null = null
  try {
    const mod = (await import('../../src/services/mcp/toolPolicy.js')) as {
      getMcpPolicyRejects?: () => string[]
      describeMcpPolicy: () => string
    }
    getRejects = mod.getMcpPolicyRejects ?? null
    describePolicy = mod.describeMcpPolicy
  } catch {
    /* legs below fail cleanly */
  }

  process.env.MERCURY_MCP_MAX_RISK = 'low ;'
  check("trailing separator debris forgiven: 'low ;' ⇒ low", getMaxExposedRisk() === 'low')
  process.env.MERCURY_MCP_MAX_RISK = 'medium;probe-srv:low'
  check(
    "the sibling flag's separator forgiven: 'medium;probe-srv:low' ⇒ default medium",
    getMaxExposedRisk() === 'medium',
  )
  check('… and its per-server override lands', getMaxExposedRiskForServer('probe-srv') === 'low')
  process.env.MERCURY_MCP_MAX_RISK = '"low"'
  check(
    'stray surrounding quotes forgiven (the Windows set VAR= form)',
    getMaxExposedRisk() === 'low',
  )
  process.env.MERCURY_MCP_MAX_RISK = 'readonly'
  check('true junk keeps the documented permissive fallback', getMaxExposedRisk() === 'high')
  const junkRejects = getRejects ? getRejects() : null
  check(
    '… but the token is RECORDED (getMcpPolicyRejects)',
    junkRejects !== null && junkRejects.includes('readonly'),
    JSON.stringify(junkRejects),
  )
  const junkDesc = describePolicy ? describePolicy() : ''
  check(
    '… and every policy description names it (REJECTED clause)',
    junkDesc.includes('REJECTED') && junkDesc.includes('readonly'),
    junkDesc,
  )
  {
    const health = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'healthReport.ts'), 'utf8')
    check(
      'the doctor MCP-policy row consults the rejects and can WARN (call-shaped)',
      /getMcpPolicyRejects\(\)/.test(health) && /policyRejects\.length > 0 \? 'warn'/.test(health),
    )
  }
  process.env.MERCURY_MCP_MAX_RISK = 'low,scratch:medium'
  const cleanRejects = getRejects ? getRejects() : null
  check('clean value ⇒ zero rejects (control)', cleanRejects !== null && cleanRejects.length === 0, JSON.stringify(cleanRejects))
  delete process.env.MERCURY_MCP_MAX_RISK
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MCP-POLICY PROOFS PASS')
else console.log(`❌ ${failures} MCP-POLICY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
