#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-capability-kill.ts
//  PROOF: the capability kill-switch (the bypass-immune deny gate) enforces its
//  security semantics correctly — exercised against the REAL production module
//  src/utils/permissions/capabilityGate.ts. This gate had NO committed
//  regression coverage; it is the most security-critical piece of the substrate
//  (a deny that must fire even under --dangerously-skip-permissions), so its
//  matching grammar must never silently drift.
//
//  Covers: empty store = no opinion · exact kill · all-agents '*' · all-tools
//  '*' · MCP server-scoped kill (bare + mcp__ form) · capabilityKillReason
//  pattern · MERCURY_KILL env grammar (bare / agent:tool / *:tool) · additive
//  reseed · clear · fail-safe (junk env, empty tool name).
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  killCapability,
  isCapabilityKilled,
  capabilityKillReason,
  isToolKilled,
  toolKillReason,
  listCapabilityKills,
  clearAllCapabilityKills,
  reseedCapabilityKillsFromEnv,
} from '../../src/utils/permissions/capabilityGate.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>).MACRO
}

console.log('============================================================')
console.log(' Capability kill-switch — security regression proof')
console.log('============================================================')

// Start clean (import-time seedFromEnv may have read a stray MERCURY_KILL).
delete process.env.MERCURY_KILL
clearAllCapabilityKills()

section('Empty store ⇒ no opinion (deny-only, never auto-allows)')
check('isCapabilityKilled false on empty store', isCapabilityKilled('Bash', 'main') === false)
check('capabilityKillReason null on empty store', capabilityKillReason('Bash', 'main') === null)

section('Exact, agent-scoped kill')
clearAllCapabilityKills()
killCapability('explorer', 'Bash')
check('killed for the exact (agent, tool)', isCapabilityKilled('Bash', 'explorer') === true)
check('NOT killed for a different agent', isCapabilityKilled('Bash', 'builder') === false)
check('NOT killed for a different tool, same agent', isCapabilityKilled('WebFetch', 'explorer') === false)
check('kill reason reconstructs the pattern', capabilityKillReason('Bash', 'explorer')?.killPattern === 'explorer:Bash')

section("All-agents '*' kill fires for ANY agent")
clearAllCapabilityKills()
killCapability('*', 'WebFetch')
check('killed for agent A', isCapabilityKilled('WebFetch', 'main') === true)
check('killed for agent B', isCapabilityKilled('WebFetch', 'explorer') === true)
check('killed even when agentType is undefined (default thread)', isCapabilityKilled('WebFetch', undefined) === true)
check("reason shows the '*' agent token", capabilityKillReason('WebFetch', 'main')?.killPattern === '*:WebFetch')

section("All-tools '*' kill takes down every tool for that agent")
clearAllCapabilityKills()
killCapability('explorer', '*')
check('every tool killed for explorer (Bash)', isCapabilityKilled('Bash', 'explorer') === true)
check('every tool killed for explorer (Write)', isCapabilityKilled('Write', 'explorer') === true)
check('but NOT for a different agent', isCapabilityKilled('Bash', 'main') === false)

section('MCP server-scoped kill (one entry kills the whole server)')
clearAllCapabilityKills()
killCapability('*', 'github')
check('bare server name kills a server tool', isCapabilityKilled('mcp__github__create_issue', 'main') === true)
check('does NOT kill a different server', isCapabilityKilled('mcp__gitlab__create_issue', 'main') === false)
clearAllCapabilityKills()
killCapability('*', 'mcp__github')
check('mcp__<server> form also kills the whole server', isCapabilityKilled('mcp__github__list_issues', 'main') === true)

section('MERCURY_KILL env grammar (bare / agent:tool / *:tool)')
clearAllCapabilityKills()
process.env.MERCURY_KILL = 'Bash, explorer:WebFetch , *:NotebookEdit ,  '
reseedCapabilityKillsFromEnv()
check('bare entry ⇒ all-agents kill', isCapabilityKilled('Bash', 'anyone') === true)
check('agent:tool ⇒ scoped kill (hits)', isCapabilityKilled('WebFetch', 'explorer') === true)
check('agent:tool ⇒ scoped kill (misses other agent)', isCapabilityKilled('WebFetch', 'builder') === false)
check('*:tool ⇒ all-agents kill', isCapabilityKilled('NotebookEdit', 'builder') === true)
check('empty entries skipped (no junk key)', !Object.prototype.hasOwnProperty.call(listCapabilityKills(), ''))

section('Reseed is ADDITIVE (operator can tighten, never loosen)')
const before = isCapabilityKilled('Edit', 'main')
process.env.MERCURY_KILL = 'Edit'
reseedCapabilityKillsFromEnv()
check('reseed added the new kill', before === false && isCapabilityKilled('Edit', 'main') === true)
check('reseed kept the prior kills (Bash still killed)', isCapabilityKilled('Bash', 'main') === true)

section('Fail-safe: junk env + empty tool name never throw / never false-deny')
clearAllCapabilityKills()
delete process.env.MERCURY_KILL
reseedCapabilityKillsFromEnv()
check('no env ⇒ no kills', Object.keys(listCapabilityKills()).length === 0)
killCapability('main', '   ') // whitespace-only tool name
check('empty/whitespace kill is not stored', isCapabilityKilled('', 'main') === false && Object.keys(listCapabilityKills()).length === 0)
check('empty toolName query ⇒ false (never crashes)', isCapabilityKilled('', 'main') === false)

section('Alias-aware kill (isToolKilled / toolKillReason) — a tool invoked by an alias')
clearAllCapabilityKills()
const aliasedTool = { name: 'Workflow', aliases: ['RunWorkflow', 'wf'] }
killCapability('*', 'wf') // operator kills by an ALIAS
check('isCapabilityKilled(primary) misses the alias kill (the gap)', isCapabilityKilled('Workflow', 'main') === false)
check('isToolKilled fires on an alias kill (the fix)', isToolKilled(aliasedTool, 'main') === true)
check('toolKillReason reports the matched alias pattern', toolKillReason(aliasedTool, 'main')?.killPattern === '*:wf')
clearAllCapabilityKills()
killCapability('*', 'Workflow') // operator kills by the PRIMARY name
check('isToolKilled fires when the primary is killed (any invocation name)', isToolKilled(aliasedTool, 'main') === true)
check('a tool with no aliases still works via isToolKilled', isToolKilled({ name: 'Bash' }, 'main') === false)
killCapability('*', 'Bash')
check('isToolKilled on a no-alias tool matches its name', isToolKilled({ name: 'Bash' }, 'main') === true)

section('clearAllCapabilityKills wipes the store')
killCapability('*', 'Bash')
clearAllCapabilityKills()
check('store empty after clear', Object.keys(listCapabilityKills()).length === 0 && isCapabilityKilled('Bash', 'main') === false)

// ── per-agent DEFAULT posture (MERCURY_AGENT_CAP) — additive, stamp-gated ───────
section('per-agent default posture (MERCURY_AGENT_CAP) — max-risk / deny-cat')
{
  setStamp(true)
  clearAllCapabilityKills()
  delete process.env.MERCURY_KILL
  // Deterministic test tools (classified by the manifest's deriveRisk/deriveCategory).
  const Bash = { name: 'Bash' } // exec / high
  const Web = { name: 'WebFetch' } // net / high
  const Read = { name: 'Read', isReadOnly: () => true } // read / low
  const Write = { name: 'Write' } // edit / medium

  delete process.env.MERCURY_AGENT_CAP
  check('no MERCURY_AGENT_CAP ⇒ nothing denied (byte-identical)', isToolKilled(Bash, 'worker') === false)

  process.env.MERCURY_AGENT_CAP = 'worker:max-risk=low'
  check('worker max-risk=low DENIES high-risk Bash', isToolKilled(Bash, 'worker') === true)
  check('worker max-risk=low ALLOWS low-risk Read', isToolKilled(Read, 'worker') === false)
  check('a DIFFERENT agent (reviewer) is unaffected', isToolKilled(Bash, 'reviewer') === false)
  check('reason names the matched rule', toolKillReason(Bash, 'worker')?.killPattern === 'worker:max-risk=low')

  process.env.MERCURY_AGENT_CAP = 'worker:deny-cat=exec,net'
  check('deny-cat exec DENIES Bash', isToolKilled(Bash, 'worker') === true)
  check('deny-cat net DENIES WebFetch', isToolKilled(Web, 'worker') === true)
  check('deny-cat exec,net does NOT deny edit (Write)', isToolKilled(Write, 'worker') === false)

  process.env.MERCURY_AGENT_CAP = '*:max-risk=low'
  check('*:max-risk=low denies Bash for ANY agent', isToolKilled(Bash, 'whoever') === true)

  // explicit kill always wins / coexists (additive — policy never loosens).
  process.env.MERCURY_AGENT_CAP = 'worker:max-risk=low'
  killCapability('reviewer', 'Read')
  check('explicit kill still fires alongside a policy (Read killed for reviewer)', isToolKilled(Read, 'reviewer') === true)
  clearAllCapabilityKills()

  // the operator's cap policy holds under ANY
  // stamp (a mis-stamped build can't silently drop a restriction).
  setStamp(false)
  check('bare stamp ⇒ policy STILL applies (max-risk=low denies Bash)', isToolKilled(Bash, 'worker') === true)
  setStamp(true)
  // RE-TRUED for FC-145: this leg used to PIN the defect ("junk policy ⇒ no
  // denial") — the module's own invariant says parse fails CLOSED, and an
  // empty policy denying nothing is the OPEN state. A set-but-unintelligible
  // posture now clamps ALL agents to max-risk=low.
  process.env.MERCURY_AGENT_CAP = 'totally-malformed-no-colon'
  check('junk policy FAILS CLOSED — clamps all agents to max-risk=low (FC-145)', isToolKilled(Bash, 'worker') === true)
  delete process.env.MERCURY_AGENT_CAP
  setStamp(false)
}

// ── FC-145 — a malformed posture fails CLOSED (never silently allows) ─────────
section('FC-145 — malformed MERCURY_AGENT_CAP: forgive, clamp, name')
{
  setStamp(true)
  clearAllCapabilityKills()
  delete process.env.MERCURY_KILL
  const Bash = { name: 'Bash' } // exec / high
  const Read = { name: 'Read', isReadOnly: () => true } // read / low
  const Write = { name: 'Write' } // edit / medium

  process.env.MERCURY_AGENT_CAP = 'worker:max-risk=lowe'
  check("typo'd level clamps its agent: lowe ⇒ worker capped low, Bash DENIED", isToolKilled(Bash, 'worker') === true)
  check('… while low-risk Read still runs (a clamp, not a brick)', isToolKilled(Read, 'worker') === false)
  check('… and a DIFFERENT agent stays unclamped', isToolKilled(Bash, 'reviewer') === false)

  process.env.MERCURY_AGENT_CAP = 'worker:max-risk=none'
  check("unrecognized level 'none' clamps low (denies Bash)", isToolKilled(Bash, 'worker') === true)

  process.env.MERCURY_AGENT_CAP = 'worker:max-risk=low,reviewer:max-risk=medium'
  check('comma-for-semicolon forgiven: worker capped low', isToolKilled(Bash, 'worker') === true)
  check('… and the comma tail LANDS as its own directive: reviewer capped medium', isToolKilled(Bash, 'reviewer') === true)
  check('… reviewer medium still allows edit-class Write', isToolKilled(Write, 'reviewer') === false)

  let getRejects: (() => string[]) | null = null
  try {
    const mod = (await import('../../src/utils/permissions/capabilityGate.js')) as {
      getAgentCapParseRejects?: () => string[]
    }
    getRejects = mod.getAgentCapParseRejects ?? null
  } catch {
    /* legs fail cleanly */
  }
  process.env.MERCURY_AGENT_CAP = 'worker:max-risk=lowe'
  const junkRejects = getRejects ? getRejects() : null
  check(
    'the unread part is RECORDED (getAgentCapParseRejects)',
    junkRejects !== null && junkRejects.some(t => t.includes('lowe')),
    JSON.stringify(junkRejects),
  )
  process.env.MERCURY_AGENT_CAP = 'worker:max-risk=low;reviewer:deny-cat=exec'
  const cleanRejects = getRejects ? getRejects() : null
  check('clean value ⇒ zero rejects (control)', cleanRejects !== null && cleanRejects.length === 0, JSON.stringify(cleanRejects))

  {
    const snapshotSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'cockpit', 'substrateSnapshot.ts'), 'utf8')
    check(
      'the cockpit posture row names unreadable parts (call-shaped)',
      /getAgentCapParseRejects/.test(snapshotSrc) && /FAIL CLOSED/.test(snapshotSrc),
    )
    const healthSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'healthReport.ts'), 'utf8')
    check(
      'the doctor gate row consults the rejects and can WARN (call-shaped)',
      /getAgentCapParseRejects/.test(healthSrc) && /capRejects\.length > 0/.test(healthSrc),
    )
  }

  delete process.env.MERCURY_AGENT_CAP
  setStamp(false)
}

// cleanup
delete process.env.MERCURY_KILL
delete process.env.MERCURY_AGENT_CAP
setStamp(false)
clearAllCapabilityKills()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CAPABILITY-KILL PROOFS PASS')
else console.log(`❌ ${failures} CAPABILITY-KILL PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
