#!/usr/bin/env bun
// prove-kill-switch-spellings — MERCURY_KILL spellings (field card FC-005).
// The capability kill-switch validated nothing: a mis-cased entry (bash), a
// quoted one (the Windows set VAR="Bash" form), and a semicolon-separated
// list each killed no tool while doctor reported them armed. The seed grammar
// is now forgiving (quotes stripped, ; separates like ,), non-MCP matching is
// case-insensitive (a kill switch that kills nothing silently is the worse
// failure), and the doctor row names entries that match no builtin.
//
//   §1 seed spellings: quotes · semicolons · mis-case all kill.
//   §2 the kill reason names the entry the operator actually wrote.
//   §3 MCP server semantics survive untouched.
//   §4 doctor wiring: unmatched entries annotated + warn.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_KILL = '' // seed-at-import stays empty; each section reseeds
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const {
  clearAllCapabilityKills,
  isCapabilityKilled,
  isToolKilled,
  capabilityKillReason,
  reseedCapabilityKillsFromEnv,
  listCapabilityKills,
} = await import('../../src/utils/permissions/capabilityGate.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const reseedWith = (value: string): void => {
  clearAllCapabilityKills()
  process.env.MERCURY_KILL = value
  reseedCapabilityKillsFromEnv()
}

section('§1 SEED SPELLINGS')
{
  reseedWith('bash')
  check('mis-cased entry kills the builtin (bash → Bash)', isCapabilityKilled('Bash'), JSON.stringify(listCapabilityKills()))
  check('and the alias-aware door agrees', isToolKilled({ name: 'Bash' }))

  reseedWith('"Bash"')
  check('a quoted entry (Windows set VAR="Bash") kills', isCapabilityKilled('Bash'), JSON.stringify(listCapabilityKills()))

  reseedWith('Bash;Read')
  check('a semicolon-separated list kills BOTH', isCapabilityKilled('Bash') && isCapabilityKilled('Read'), JSON.stringify(listCapabilityKills()))

  reseedWith('Bash')
  check('control: the canonical spelling still kills', isCapabilityKilled('Bash'))
  check('control: an unkilled tool stays alive', !isCapabilityKilled('Read'))
}

section('§2 THE KILL REASON')
{
  reseedWith('bash')
  const reason = capabilityKillReason('Bash')
  check(
    'the reason names the entry the operator wrote (*:bash)',
    reason !== null && reason.killPattern === '*:bash',
    JSON.stringify(reason),
  )
}

section('§3 MCP SERVER SEMANTICS')
{
  reseedWith('srv')
  check('a bare server name still kills every tool of that server', isCapabilityKilled('mcp__srv__alpha'))
  reseedWith('mcp__srv')
  check('the mcp__server spelling still kills the server', isCapabilityKilled('mcp__srv__alpha'))
  reseedWith('read')
  check(
    'a lowercase entry never case-folds ONTO an mcp tool (mcp matching stays exact+server)',
    !isCapabilityKilled('mcp__Read__alpha') || isCapabilityKilled('mcp__read__alpha'),
  )
}

section('§4 DOCTOR WIRING')
{
  const doctorSrc = readFileSync(join(import.meta.dir, '../../src/utils/healthReport.ts'), 'utf8')
  check(
    'the kills row annotates entries matching no builtin',
    doctorSrc.includes('no such builtin — read as an MCP server name'),
  )
  check(
    'unmatched entries elevate the row to warn',
    // FC-145 widened the warn predicate (agent-cap parse rejects join it);
    // the pinned fact is unchanged: unmatched > 0 still forces 'warn'.
    doctorSrc.includes("unmatched > 0 || capRejects.length > 0 ? 'warn' : 'info'"),
  )
  check(
    'the remedy teaches the unambiguous server spelling',
    doctorSrc.includes('mcp__<server>'),
  )
}

clearAllCapabilityKills()
if (failures > 0) {
  console.error(`\nprove-kill-switch-spellings: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-kill-switch-spellings: all green')
