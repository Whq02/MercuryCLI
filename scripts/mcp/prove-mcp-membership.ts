#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  console.log('\nTIMEOUT — membership prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' MCP membership — one owner, every connect road')
console.log('============================================================')

section('§1 owner semantics: the per-project record, verbatim')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { isMcpCatalogueMember } = await import('../../src/services/mcp/membership.ts')
  const { setMcpServerEnabled } = await import('../../src/services/mcp/config.ts')

  t('an unconfigured name is a member (default-on)', isMcpCatalogueMember('alpha') === true)
  setMcpServerEnabled('blocked-server', false)
  t(
    'a record-disabled name is NOT a member (the opt-out list bites)',
    isMcpCatalogueMember('blocked-server') === false,
    'the disabledMcpServers record did not reach the predicate',
  )
  t('a sibling name is untouched by the exclusion', isMcpCatalogueMember('alpha') === true)
  setMcpServerEnabled('blocked-server', true)
  t('re-enable restores membership', isMcpCatalogueMember('blocked-server') === true)
  setMcpServerEnabled('blocked-server', false)
  t(
    'the ide bridge name is a member by default (no record row — never severed by any product door)',
    isMcpCatalogueMember('ide') === true,
  )
}

section('§2 runner partition: excluded never reaches the member half')
{
  const { partitionMcpConfigsByMembership } = await import('../../src/services/mcp/membership.ts')
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
    `members=${members.map(([n]) => n).join(',')} excluded=${excluded.map(([n]) => n).join(',')}`,
  )
  t(
    'members preserve batch order',
    members.map(([n]) => n).join(',') === 'alpha,zeta',
  )
  t('excluded carries its config (the disabled roster row seeds from it)', excluded[0]?.[1] !== undefined)
  const empty = partitionMcpConfigsByMembership({} as never)
  t('empty catalogue partitions empty', empty.members.length === 0 && empty.excluded.length === 0)
}

section('§2b source-shape: the batch consults the partition')
{
  const source = readFileSync(join(REPO, 'src', 'main.tsx'), 'utf8')
  const start = source.indexOf('async function connectMcpBatch')
  const end = source.indexOf('function dedupeByName')
  const body = start >= 0 && end > start ? source.slice(start, end) : ''
  t('connectMcpBatch found ahead of dedupeByName', body.length > 0)
  t(
    'the batch consults the membership partition',
    body.includes('partitionMcpConfigsByMembership('),
    'the runner road lost its membership consult',
  )
  t(
    'the connect map runs over MEMBERS',
    body.includes('members.map(async ([name, config])'),
    'the dial half no longer scoped to members',
  )
  t(
    "excluded entries seed as 'disabled' roster rows",
    body.includes("...excluded.map(([name, config]) => ({ name, type: 'disabled' as const, config }))"),
  )
  t(
    'POISON absent: no raw-entries dial remains',
    !body.includes('entries.map(async ([name, config])'),
    'a raw entries dial would connect disk-disabled servers again',
  )
}

section('§3 subagent ∩: names resolve only within the parent catalogue')
{
  const { connectAgentMcpServers } = await import('../../src/tools/AgentTool/runAgent.ts')
  const { connectToServer, getServerCacheKey } = await import('../../src/services/mcp/client.ts')

  const parentCfg = { type: 'stdio', command: 'parent-cmd', scope: 'local' } as never
  const disabledCfg = { type: 'stdio', command: 'blocked-cmd', scope: 'local' } as never
  const sdkCfg = { type: 'sdk', name: 'wired', scope: 'dynamic' } as never
  const catalogue = [
    { name: 'shared-server', type: 'connected', config: parentCfg },
    { name: 'blocked-server', type: 'disabled', config: disabledCfg },
    { name: 'wired-sdk', type: 'connected', config: sdkCfg },
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

  const outcome = await connectAgentMcpServers(
    ['shared-server', 'outside-server', 'blocked-server', 'wired-sdk'] as never,
    definition,
    catalogue as never,
  )
  t(
    'a lawful member grant connects through the PARENT ROW config (cache hit, no dial)',
    outcome.clients.length === 1 && (outcome.clients[0] as { name?: string }).name === 'shared-server',
    `clients=${outcome.clients.map(c => (c as { name?: string }).name).join(',')}`,
  )
  t(
    'POISON armed: the outside name refused (no widening past the parent catalogue)',
    !outcome.clients.some(c => (c as { name?: string }).name === 'outside-server'),
  )
  t(
    "POISON armed: the 'disabled' row refused (a disk-disabled server cannot ride a grant)",
    !outcome.clients.some(c => (c as { name?: string }).name === 'blocked-server'),
  )
  t(
    'the sdk-typed row refused typed (the child path cannot construct the SDK transport)',
    !outcome.clients.some(c => (c as { name?: string }).name === 'wired-sdk'),
  )
  t(
    'no refusal arm dialed the memo (no connection was opened only to refuse it)',
    !memo.has(getServerCacheKey('outside-server', parentCfg)) &&
      !memo.has(getServerCacheKey('blocked-server', disabledCfg)) &&
      !memo.has(getServerCacheKey('wired-sdk', sdkCfg)),
  )
  t(
    'the parent row key still owns the one connection (no re-key, no second dial)',
    memo.has(parentKey) === true,
  )
  memo.delete(parentKey)
}

section('§4 cache key = name + config JSON, no session dimension')
{
  const { getServerCacheKey } = await import('../../src/services/mcp/client.ts')
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
  )
}

section('§5 the config key answers the BOOT project for the process lifetime')
{
  const { getProjectPathForConfig } = await import('../../src/utils/config/projectConfig.ts')
  const { setOriginalCwd, getOriginalCwd } = await import('../../src/bootstrap/state.ts')
  const bootKey = getProjectPathForConfig()
  t('the boot key derives from the boot cwd', bootKey.length > 0)
  const before = getOriginalCwd()
  const ELSEWHERE = join(SCRATCH, 'other-project')
  mkdirSync(ELSEWHERE, { recursive: true })
  try {
    setOriginalCwd(ELSEWHERE)
    t(
      'POISON armed: a moved originalCwd never re-homes the config key mid-process',
      getProjectPathForConfig() === bootKey,
      `key drifted to ${getProjectPathForConfig()}`,
    )
  } finally {
    setOriginalCwd(before)
  }
}

section('§6 the control-wire reconnect refuses a disabled server (source-shape)')
{
  const source = readFileSync(join(REPO, 'src', 'cli', 'print.ts'), 'utf8')
  const start = source.indexOf("case 'mcp_reconnect': {")
  const end = source.indexOf("case 'mcp_toggle': {")
  const body = start >= 0 && end > start ? source.slice(start, end) : ''
  t('the mcp_reconnect case found ahead of mcp_toggle', body.length > 0)
  const consultAt = body.indexOf('isMcpCatalogueMember(')
  const dialAt = body.indexOf('connectToServer(')
  t(
    'POISON armed: the handler consults the membership owner',
    consultAt >= 0,
    'the wire reconnect lost its membership consult — it would dial past the record again',
  )
  t('the consult precedes the dial', consultAt >= 0 && dialAt > consultAt)
  t(
    'the refusal is a typed error frame, not a silent skip',
    body.includes('respondError') && body.includes('is disabled'),
  )
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} membership assertion(s) failed`)
  process.exit(1)
}
console.log('✅ MCP membership fences hold')
process.exit(0)
