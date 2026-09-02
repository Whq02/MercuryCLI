#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-mcp-membership.ts — the MCP membership fences:
//  ONE membership-predicate owner, consulted on every connect
//  road; the runner batch honors it; the subagent name-grant resolves only
//  within the parent's catalogue; the isolation laws hold their shape.
//
//  THE LAW: membership has ONE owner (isMcpCatalogueMember,
//  services/mcp/membership.ts) carrying the landed per-project
//  disabledMcpServers/enabledMcpServers semantics. Every connect road
//  consults it; the session-kit lane's later filter swap edits its body at
//  exactly one place.
//
//    §1  the owner speaks the record: a server the record disables is not a
//        member; an unknown name is (default-on); re-enabling restores it.
//        POISON: the opt-out list ignored (yesterday's runner-road truth).
//    §2  the runner batch partition: excluded names never reach the member
//        half; members preserve batch order; the empty catalogue partitions
//        empty. POISON: a disabled name in members (it would be dialed).
//    §2b source-shape ratchet: main.tsx's connectMcpBatch consults the
//        partition and dials MEMBERS only; excluded entries seed as
//        'disabled' rows. POISON: the batch mapping raw entries again.
//    §3  the subagent name-grant fence (connectAgentMcpServers): a name
//        outside the parent catalogue refuses; a 'disabled' row refuses; an
//        sdk-typed row refuses typed (the child path cannot construct the
//        SDK control transport — connectImpl throws on 'sdk'); a lawful
//        member connects THROUGH THE PARENT ROW'S CONFIG (the shared-cache
//        law — proven by a pre-seeded memo entry under that exact key, no
//        spawn); the inline arm is byte-outside this fence (Q2 open).
//    §4  cache-scope law: getServerCacheKey = name + ':' + full config
//        JSON, NO session dimension — the connection cache is scoped by the
//        single-session process (one runner child per admission), not by a
//        key field. A session field appearing here = the architecture
//        changed = this pin reds and the fence census must be re-read.
//    §5  project-key law: getProjectPathForConfig answers the BOOT project
//        for the process lifetime — a later setOriginalCwd (the worktree
//        roads) never re-homes the per-project MCP record mid-process, so a
//        project switch can never inherit the old project's disable set.
//    §6  wire parity (source-shape): the control-wire mcp_reconnect handler
//        consults the owner BEFORE dialing — the screen registry's manual
//        reconnect refuses a disabled server, and the wire refuses typed
//        instead of connecting past the record. The live wire drill
//        (request in, error frame out) NEEDS-REAL-BOX; this pin holds the
//        consult's presence and order.
//
//  Hermetic: scratch config home + scratch non-git project cwd; no network;
//  no server is ever spawned (refusal arms never dial; the lawful arm is a
//  memo cache hit).
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-mcp-membership.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-membership-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
// A scratch NON-git project directory owns the per-project record: the
// project key derives from the boot cwd (no git root above tmpdir).
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

// ── §1 the owner speaks the record ──────────────────────────────────────────
section('§1 owner semantics: the per-project record, verbatim')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { isMcpCatalogueMember } = await import('../../src/services/mcp/membership.ts')
  const { setMcpServerEnabled } = await import('../../src/services/mcp/config.ts')

  t('an unconfigured name is a member (default-on)', isMcpCatalogueMember('alpha') === true)
  // The record is written by the product's own pen — the same door the
  // /mcp toggle drives (setMcpServerEnabled → saveCurrentProjectConfig).
  setMcpServerEnabled('blocked-server', false)
  t(
    'a record-disabled name is NOT a member (the opt-out list bites)',
    isMcpCatalogueMember('blocked-server') === false,
    'the disabledMcpServers record did not reach the predicate',
  )
  t('a sibling name is untouched by the exclusion', isMcpCatalogueMember('alpha') === true)
  setMcpServerEnabled('blocked-server', true)
  t('re-enable restores membership', isMcpCatalogueMember('blocked-server') === true)
  setMcpServerEnabled('blocked-server', false) // re-disable: later sections reuse it
  t(
    'the ide bridge name is a member by default (no record row — never severed by any product door)',
    isMcpCatalogueMember('ide') === true,
  )
}

// ── §2 the runner batch partition ───────────────────────────────────────────
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

// ── §2b source-shape ratchet: connectMcpBatch dials members only ────────────
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

// ── §3 the subagent name-grant fence ────────────────────────────────────────
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

  // The lawful arm never spawns: the memo is pre-seeded under EXACTLY the
  // parent row's key, so a fence that dials with the parent's own config is
  // a cache hit — and a fence that re-resolved a different config would
  // MISS and (here) dial for real; the clients assertion below would then
  // fail on the connect error.
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

// ── §4 cache-scope law ──────────────────────────────────────────────────────
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

// ── §5 project-key law ──────────────────────────────────────────────────────
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

// ── §6 wire parity: mcp_reconnect consults before it dials ──────────────────
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
