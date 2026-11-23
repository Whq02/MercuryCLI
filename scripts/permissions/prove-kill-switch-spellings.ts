#!/usr/bin/env bun

process.env.NODE_ENV = 'test'
process.env.MERCURY_KILL = ''
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const {
  clearAllCapabilityKills,
  isCapabilityKilled,
  isToolKilled,
  capabilityKillReason,
  reseedCapabilityKillsFromEnv,
  listCapabilityKills,
} = await import('../../src/permissions/rules/capabilityGate.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : ' — fix: how MERCURY_KILL entries are read and matched is reseedCapabilityKillsFromEnv, isCapabilityKilled and capabilityKillReason in src/permissions/rules/capabilityGate.ts; the kills row of the health check (section 4) is in src/platform/health/sections/settings.ts'}`)
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

section('§4 HEALTH WIRING')
{
  const { settingsChecks } = await import('../../src/platform/health/sections/settings.ts')
  const killsRow = settingsChecks().find(row => row.id === 'kills')
  reseedWith('nosuchbuiltin')
  const unmatchedSays = await killsRow?.run()
  reseedWith('Read')
  const matchedSays = await killsRow?.run()
  check(
    'the kills row annotates entries matching no builtin',
    unmatchedSays?.evidence.includes('nosuchbuiltin (no such builtin — read as an MCP server name)') === true && !/no such builtin/.test(matchedSays?.evidence ?? 'no such builtin'),
    `${unmatchedSays?.evidence} | ${matchedSays?.evidence}`,
  )
  check(
    'unmatched entries elevate the row to warn',
    unmatchedSays?.status === 'warn' && matchedSays?.status === 'info',
    `${unmatchedSays?.status} | ${matchedSays?.status}`,
  )
  check(
    'the remedy teaches the unambiguous server spelling',
    unmatchedSays?.fix?.includes('mcp__<server>') === true && !matchedSays?.fix?.includes('mcp__<server>'),
    `${unmatchedSays?.fix} | ${matchedSays?.fix}`,
  )
}

clearAllCapabilityKills()
if (failures > 0) {
  console.error(`\nprove-kill-switch-spellings: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-kill-switch-spellings: all green')
