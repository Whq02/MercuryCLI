#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-membership-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — membership prover exceeded 60s; look at the section printed last above, most likely connectAgentMcpServers (src/tools/crewmate/runCrewmate.ts) dialing a server')
  process.exit(1)
}, 60_000)
watchdog.unref?.()


console.log('============================================================')
console.log(' MCP membership — one owner, every connect road')
console.log('============================================================')

section('§1 owner semantics: the per-project record, verbatim')
{
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { isMcpCatalogueMember } = await import('../../src/integrations/mcp/membership.ts')
  const { setMcpServerEnabled } = await import('../../src/integrations/mcp/serverConfigs.ts')

  t('an unconfigured name is a member (default-on)', isMcpCatalogueMember('alpha') === true, 'isMcpCatalogueMember (src/integrations/mcp/membership.ts) must treat a name with no disabled record as a member')
  setMcpServerEnabled('blocked-server', false)
  t(
    'a record-disabled name is NOT a member (the opt-out list bites)',
    isMcpCatalogueMember('blocked-server') === false,
    'isMcpCatalogueMember (src/integrations/mcp/membership.ts) must read the disabledMcpServers record that setMcpServerEnabled (src/integrations/mcp/serverConfigs.ts) writes',
  )
  t('a sibling name is untouched by the exclusion', isMcpCatalogueMember('alpha') === true, 'isMcpCatalogueMember (src/integrations/mcp/membership.ts) must exclude only the names in the disabled record')
  setMcpServerEnabled('blocked-server', true)
  t('re-enable restores membership', isMcpCatalogueMember('blocked-server') === true, 'setMcpServerEnabled(name, true) in src/integrations/mcp/serverConfigs.ts must remove the name from the disabled record')
  setMcpServerEnabled('blocked-server', false)
}

section('§2 runner partition: excluded never reaches the member half')
{
  const { partitionMcpConfigsByMembership } = await import('../../src/integrations/mcp/membership.ts')
  type Cfg = { type: 'stdio'; command: string; scope: 'dynamic' }
  const cfg = (command: string): Cfg => ({ type: 'stdio', command, scope: 'dynamic' })
  const { members, excluded } = partitionMcpConfigsByMembership({
    'alpha': cfg('a'),
    'blocked-server': cfg('b'),
    'zeta': cfg('z'),
  } as never)
  t(
    'POISON armed: the disabled name lands in excluded, never members',
    members.every(([name]) => name !== 'blocked-server') &&
      excluded.some(([name]) => name === 'blocked-server'),
    `partitionMcpConfigsByMembership (src/integrations/mcp/membership.ts) must put disabled names in excluded only; members=${members.map(([n]) => n).join(',')} excluded=${excluded.map(([n]) => n).join(',')}`,
  )
  t(
    'members preserve batch order',
    members.map(([n]) => n).join(',') === 'alpha,zeta',
    'partitionMcpConfigsByMembership (src/integrations/mcp/membership.ts) must keep the order of the input batch in members',
  )
  t('excluded carries its config (the disabled roster row seeds from it)', excluded[0]?.[1] !== undefined, 'partitionMcpConfigsByMembership (src/integrations/mcp/membership.ts) must return each excluded entry as a name and config pair')
  const empty = partitionMcpConfigsByMembership({} as never)
  t('empty catalogue partitions empty', empty.members.length === 0 && empty.excluded.length === 0, 'partitionMcpConfigsByMembership (src/integrations/mcp/membership.ts) must return two empty lists for an empty catalogue')
}


section('§3 subagent ∩: names resolve only within the parent catalogue')
{
  const { connectCrewmateMcpServers } = await import('../../src/tools/crewmate/runCrewmate.ts')
  const { connectToServer, getServerCacheKey } = await import('../../src/integrations/mcp/client.ts')

  const parentCfg = { type: 'stdio', command: 'parent-cmd', scope: 'local' } as never
  const disabledCfg = { type: 'stdio', command: 'blocked-cmd', scope: 'local' } as never
  const catalogue = [
    { name: 'shared-server', type: 'connected', config: parentCfg },
    { name: 'blocked-server', type: 'disabled', config: disabledCfg },
  ] as never[]
  const definition = { agentType: 'prover-agent', source: 'built-in' } as never

  const fakeConnection = {
    type: 'connected',
    name: 'shared-server',
    client: {},
    capabilities: {},
    config: parentCfg,
    cleanup: async () => {},
  }
  const memo = (connectToServer as unknown as { cache: Map<string, unknown> }).cache
  const parentKey = getServerCacheKey('shared-server', parentCfg)
  memo.set(parentKey, Promise.resolve(fakeConnection))

  const outcome = await connectCrewmateMcpServers(
    ['shared-server', 'outside-server', 'blocked-server'] as never,
    definition,
    catalogue as never,
  )
  t(
    'a lawful member grant connects through the PARENT ROW config (cache hit, no dial)',
    outcome.clients.length === 1 && (outcome.clients[0] as { name?: string }).name === 'shared-server',
    `connectAgentMcpServers (src/tools/crewmate/runCrewmate.ts) must connect a granted name that is a connected row of the parent catalogue through the cached connection; clients=${outcome.clients.map(c => (c as { name?: string }).name).join(',')}`,
  )
  t(
    'POISON armed: the outside name refused (no widening past the parent catalogue)',
    !outcome.clients.some(c => (c as { name?: string }).name === 'outside-server'),
    'connectAgentMcpServers (src/tools/crewmate/runCrewmate.ts) must refuse a granted name that is not in the parent catalogue',
  )
  t(
    "POISON armed: the 'disabled' row refused (a disk-disabled server cannot ride a grant)",
    !outcome.clients.some(c => (c as { name?: string }).name === 'blocked-server'),
    'connectAgentMcpServers (src/tools/crewmate/runCrewmate.ts) must refuse a catalogue row whose type is disabled',
  )
  t(
    'no refusal arm dialed the memo (no connection was opened only to refuse it)',
    !memo.has(getServerCacheKey('outside-server', parentCfg)) &&
      !memo.has(getServerCacheKey('blocked-server', disabledCfg)),
    'connectAgentMcpServers (src/tools/crewmate/runCrewmate.ts) must check the parent catalogue before it calls connectToServer',
  )
  t(
    'the parent row key still owns the one connection (no re-key, no second dial)',
    memo.has(parentKey) === true,
    'connectAgentMcpServers (src/tools/crewmate/runCrewmate.ts) must reuse the parent row config so the key from getServerCacheKey (src/integrations/mcp/client.ts) stays the same',
  )
  memo.delete(parentKey)
}

section('§4 cache key = name + config JSON, no session dimension')
{
  const { getServerCacheKey } = await import('../../src/integrations/mcp/client.ts')
  const cfg = { type: 'stdio', command: 'c', args: ['x'], scope: 'local' } as never
  t(
    'the key is exactly name + ":" + JSON(config)',
    getServerCacheKey('srv', cfg) === `srv:${JSON.stringify(cfg)}`,
    'the cache key changed shape — if a session field arrived, the single-session-process law moved; re-read the fence census',
  )
  t(
    'two configs, two keys (same name never collides across configs)',
    getServerCacheKey('srv', cfg) !==
      getServerCacheKey('srv', { type: 'stdio', command: 'other', scope: 'local' } as never),
    'getServerCacheKey (src/integrations/mcp/client.ts) must include the config JSON in the key',
  )
}

section('§5 the config key answers the BOOT project for the process lifetime')
{
  const { getProjectPathForConfig } = await import('../../src/platform/config/projectConfig.ts')
  const { setOriginalCwd, getOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
  const bootKey = getProjectPathForConfig()
  t('the boot key derives from the boot cwd', bootKey.length > 0, 'getProjectPathForConfig (src/platform/config/projectConfig.ts) must return a non-empty key for the boot cwd')
  const before = getOriginalCwd()
  const ELSEWHERE = join(SCRATCH, 'other-project')
  mkdirSync(ELSEWHERE, { recursive: true })
  try {
    setOriginalCwd(ELSEWHERE)
    t(
      'POISON armed: a moved originalCwd never re-homes the config key mid-process',
      getProjectPathForConfig() === bootKey,
      `getProjectPathForConfig (src/platform/config/projectConfig.ts) must stay memoized on the boot cwd; key drifted to ${getProjectPathForConfig()}`,
    )
  } finally {
    setOriginalCwd(before)
  }
}


console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} membership assertion(s) failed`)
  process.exit(1)
}
console.log('✅ MCP membership fences hold')
process.exit(0)
