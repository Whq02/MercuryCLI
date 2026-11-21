#!/usr/bin/env bun
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slashed } from '../lib/platformPath.ts'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'uhg-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', fixHint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && fixHint ? ' — ' + fixHint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')

const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'uhg-proj-')))
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
writeFileSync(
  join(PROJ, '.mercury', 'settings.json'),
  JSON.stringify({
    credentials: { keyCommand: `touch ${join(PROJ, 'helper-marker')} && echo sk-proj-fixture` },
    events: { hooks: { 'session.start': [{ run: `touch ${join(PROJ, 'proj-marker')}` }] } },
  }),
)
writeFileSync(join(PROJ, '.mercury', 'mcp.json'), JSON.stringify({ mcpServers: { fixsrv: { command: 'node', args: ['-e', 'setTimeout(()=>{},100)'] } } }))
writeFileSync(
  join(HOME, 'settings.json'),
  JSON.stringify({
    credentials: { keyCommand: 'echo sk-user-fixture' },
    events: { hooks: { 'session.start': [{ run: `touch ${join(PROJ, 'user-marker')}` }] } },
  }),
)

const { setIsInteractive, setSessionTrustAccepted, setProjectRoot, setOriginalCwd } = await import('../../src/bootstrap/state.js')
const { setCwd } = await import('../../src/utils/Shell.js')
const { normalizePathForConfigKey } = await import('../../src/utils/path.js')
const trustModule = (await import('../../src/utils/config/trust.js')) as unknown as {
  untrustedWorkspaceHeadless?: () => boolean
  resetTrustDialogAcceptedCacheForTesting: () => void
}
const untrustedWorkspaceHeadless = trustModule.untrustedWorkspaceHeadless ?? ((): boolean => false)
const predicateExported = typeof trustModule.untrustedWorkspaceHeadless === 'function'
const resetTrustDialogAcceptedCacheForTesting = trustModule.resetTrustDialogAcceptedCacheForTesting
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')

setCwd(PROJ)
setOriginalCwd(PROJ)
setProjectRoot(PROJ)
resetSettingsCache()

section('§1 THE PREDICATE')
{
  check('the predicate is exported (untrustedWorkspaceHeadless)', predicateExported, '', 'export untrustedWorkspaceHeadless from src/utils/config/trust.ts')
  setIsInteractive(true)
  resetTrustDialogAcceptedCacheForTesting()
  check('interactive ⇒ false (the dialog road owns it)', untrustedWorkspaceHeadless() === false, '', 'untrustedWorkspaceHeadless in src/utils/config/trust.ts must return false for an interactive session')
  setIsInteractive(false)
  resetTrustDialogAcceptedCacheForTesting()
  check('headless + no trust record ⇒ TRUE', untrustedWorkspaceHeadless() === true, '', 'untrustedWorkspaceHeadless in src/utils/config/trust.ts must return true for a headless run with no trust record')
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
  check('headless + trust ⇒ false', untrustedWorkspaceHeadless() === false, '', 'untrustedWorkspaceHeadless in src/utils/config/trust.ts must return false once the session trust is accepted')
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  {
    const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
    const { getGlobalMercuryFile } = await import('../../src/utils/env.js')
    const trustRead = (await import('../../src/utils/config/trust.js')).checkHasTrustDialogAccepted
    enableConfigs()
    const configFile = getGlobalMercuryFile()
    rmSync(configFile, { force: true })
    mkdirSync(configFile)
    delete process.env.NODE_ENV
    let read = 'answered'
    let predicate = 'threw'
    try {
      try { trustRead() } catch { read = 'threw' }
      try { predicate = String(untrustedWorkspaceHeadless()) } catch (error) { predicate = `threw ${String(error)}` }
    } finally {
      process.env.NODE_ENV = 'test'
      rmSync(configFile, { recursive: true, force: true })
      resetTrustDialogAcceptedCacheForTesting()
    }
    check('the rig holds: with a folder standing where the config file should be, which no platform reads as a file, the trust read throws', read === 'threw', read, 'checkHasTrustDialogAccepted in src/utils/config/trust.ts no longer throws on an unreadable config file; this rig needs a config path it cannot read')
    check('headless + a trust record that cannot be read ⇒ false: the run goes on with the checkout as on 1.0.11, a check that could not finish holds nothing back', predicate === 'false', predicate, 'untrustedWorkspaceHeadless in src/utils/config/trust.ts must return false when the trust read throws')
  }
}

section('§2 THE HOOKS SNAPSHOT UNDER THE GATE')
{
  const { hooksSnapshot, resetHooksSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.js')
  const resetHooksConfigSnapshot = resetHooksSnapshot
  const getHooksConfigFromSnapshot = (): unknown => hooksSnapshot().hooks
  const sessionStartCommands = (snapshot: unknown): string[] =>
    ((snapshot ?? []) as Array<{ event: string; entry: { run?: string } }>).filter(h => h.event === 'session.start').map(h => h.entry.run ?? '')
  setIsInteractive(false)
  resetTrustDialogAcceptedCacheForTesting()
  resetSettingsCache()
  resetHooksConfigSnapshot()
  const gated = sessionStartCommands(getHooksConfigFromSnapshot())
  check(
    'gated: the config-home hook rides, the checkout hook does NOT',
    gated.some(c => c.includes('user-marker')) && !gated.some(c => c.includes('proj-marker')),
    JSON.stringify(gated),
    'hooksSnapshot in src/utils/hooks/hooksConfigSnapshot.ts must leave out checkout hooks while untrustedWorkspaceHeadless is true',
  )
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
  resetSettingsCache()
  resetHooksConfigSnapshot()
  const trusted = sessionStartCommands(getHooksConfigFromSnapshot())
  check(
    'trusted: BOTH hooks ride (the historical merge)',
    trusted.some(c => c.includes('user-marker')) && trusted.some(c => c.includes('proj-marker')),
    JSON.stringify(trusted),
    'hooksSnapshot in src/utils/hooks/hooksConfigSnapshot.ts must merge user and checkout hooks once the session trust is accepted',
  )
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  resetHooksConfigSnapshot()
}

section('§3 OUTSIDE-CHECKOUT READERS + THE GATED SITES (call-shaped)')
{
  const settingsModule = (await import('../../src/utils/settings/settings.js')) as unknown as {
    getApiKeyHelperFromOutsideCheckoutSources?: () => string | undefined
    getHooksFromOutsideCheckoutSources?: () => unknown
  }
  const getApiKeyHelperFromOutsideCheckoutSources =
    settingsModule.getApiKeyHelperFromOutsideCheckoutSources ?? ((): string | undefined => undefined)
  const getHooksFromOutsideCheckoutSources = settingsModule.getHooksFromOutsideCheckoutSources ?? ((): unknown => null)
  resetSettingsCache()
  check(
    'the outside-checkout helper is the USER one (checkout helper invisible)',
    getApiKeyHelperFromOutsideCheckoutSources() === 'echo sk-user-fixture',
    String(getApiKeyHelperFromOutsideCheckoutSources()),
    'getApiKeyHelperFromOutsideCheckoutSources in src/utils/settings/settings.ts must read only the config-home credentials.keyCommand',
  )
  const outsideHooks = JSON.stringify(getHooksFromOutsideCheckoutSources())
  check(
    'the outside-checkout hooks map carries only the config-home hook',
    outsideHooks.includes('user-marker') && !outsideHooks.includes('proj-marker'),
    outsideHooks,
    'getHooksFromOutsideCheckoutSources in src/utils/settings/settings.ts must return only the config-home hooks',
  )
}

section('§4 PROJECT MCP UNDER THE GATE')
{
  const { getProjectMcpServerStatus, projectMcpApprovalEntry } = await import('../../src/services/mcp/utils.js')
  const { getMercuryMcpConfigs, getProjectMcpConfigsFromCwd } = await import('../../src/services/mcp/config.js')
  setIsInteractive(false)
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  resetSettingsCache()
  const fixsrv = getProjectMcpConfigsFromCwd().servers.fixsrv!
  check(
    "gated: the checkout server is NOT auto-approved ('pending')",
    getProjectMcpServerStatus('fixsrv', fixsrv) === 'pending',
    getProjectMcpServerStatus('fixsrv', fixsrv),
    'getProjectMcpServerStatus in src/services/mcp/utils.ts must answer pending for a checkout server in an untrusted headless run',
  )
  const gatedServers = Object.keys((await getMercuryMcpConfigs()).servers)
  check('gated: the assembly excludes the project MCP file server', !gatedServers.includes('fixsrv'), JSON.stringify(gatedServers), 'getMercuryMcpConfigs in src/services/mcp/config.ts must leave out the project MCP file server while the workspace is untrusted')
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
  check(
    "trusted but never approved: still 'pending' (trust alone approves nothing)",
    getProjectMcpServerStatus('fixsrv', fixsrv) === 'pending',
    getProjectMcpServerStatus('fixsrv', fixsrv),
    'getProjectMcpServerStatus in src/services/mcp/utils.ts must not approve a project server on trust alone',
  )
  const trustedServers = Object.keys((await getMercuryMcpConfigs()).servers)
  check('trusted but never approved: the assembly leaves the project MCP file server out', !trustedServers.includes('fixsrv'), JSON.stringify(trustedServers), 'getMercuryMcpConfigs in src/services/mcp/config.ts must leave out a project server that was never approved')
  writeFileSync(join(PROJ, '.mercury', 'settings.local.json'), JSON.stringify({ kit: { projectOn: [projectMcpApprovalEntry('fixsrv', fixsrv)] } }))
  resetSettingsCache()
  check(
    "trusted and approved for this definition: 'approved'",
    getProjectMcpServerStatus('fixsrv', fixsrv) === 'approved',
    getProjectMcpServerStatus('fixsrv', fixsrv),
    'getProjectMcpServerStatus in src/services/mcp/utils.ts must answer approved when settings.local.json carries the entry from projectMcpApprovalEntry',
  )
  const approvedServers = Object.keys((await getMercuryMcpConfigs()).servers)
  check('trusted and approved: the assembly carries the project MCP file server', approvedServers.includes('fixsrv'), JSON.stringify(approvedServers), 'getMercuryMcpConfigs in src/services/mcp/config.ts must include a trusted and approved project server')
  rmSync(join(PROJ, '.mercury', 'settings.local.json'), { force: true })
  resetSettingsCache()
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
}

section('§5 THE ARTIFACT LIVE (fresh checkout, headless)')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false, '', 'run bun run build.ts to write dist/mercury.mjs')
  } else {
    const LIVE_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'uhg-live-home-')))
    const LIVE_PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'uhg-live-proj-')))
    mkdirSync(join(LIVE_PROJ, '.mercury'), { recursive: true })
    const marker = (name: string): string => slashed(join(LIVE_PROJ, name))
    writeFileSync(
      join(LIVE_PROJ, '.mercury', 'settings.json'),
      JSON.stringify({
        credentials: { keyCommand: `touch ${marker('helper-marker')} && echo sk-proj-fixture` },
        events: { hooks: { 'session.start': [{ run: `touch ${marker('proj-marker')}` }] } },
      }),
    )
    writeFileSync(join(LIVE_PROJ, '.mercury', 'mcp.json'), JSON.stringify({ mcpServers: { fixsrv: { command: 'node', args: ['-e', 'setTimeout(()=>{},100)'] } } }))
    writeFileSync(
      join(LIVE_HOME, 'settings.json'),
      JSON.stringify({
        credentials: { keyCommand: 'echo sk-user-fixture' },
        events: { hooks: { 'session.start': [{ run: `touch ${marker('user-marker')}` }] } },
      }),
    )
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      MERCURY_CONFIG_DIR: LIVE_HOME,
      NODE_ENV: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      MERCURY_OAUTH_TOKEN: undefined,
    }
    const run = (args: string[]): { stdout: string; stderr: string; status: number | null } => {
      const result = spawnSync('node', [DIST, ...args], {
        cwd: LIVE_PROJ,
        env: childEnv as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 90000,
      })
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
    }

    const untrustedRun = run(['run', 'hi'])
    check('untrusted run: the checkout session.start hook did NOT fire', !existsSync(marker('proj-marker')), '', 'an untrusted headless run in the built artifact ran a checkout hook; check hooksSnapshot in src/utils/hooks/hooksConfigSnapshot.ts and untrustedWorkspaceHeadless in src/utils/config/trust.ts')
    check('untrusted run: the checkout credentials.keyCommand did NOT execute', !existsSync(marker('helper-marker')), '', 'an untrusted headless run in the built artifact ran the checkout key command; check getApiKeyHelperFromOutsideCheckoutSources in src/utils/settings/settings.ts')
    check(
      'untrusted run: the config-home session.start hook DID fire (source-scoped, not blanket)',
      existsSync(marker('user-marker')),
      `rc=${untrustedRun.status} err=${untrustedRun.stderr.slice(0, 120).replace(/\s+/g, ' ')}`,
      'the untrusted run must still fire config-home hooks; the gate in src/utils/hooks/hooksConfigSnapshot.ts must drop only checkout sources',
    )
    const untrustedList = run(['mcp', 'list'])
    check(
      'untrusted mcp list: the checkout server is not loaded',
      !untrustedList.stdout.includes('fixsrv'),
      untrustedList.stdout.slice(0, 120).replace(/\s+/g, ' '),
      'mcp list in an untrusted checkout must not load the project server; check getMercuryMcpConfigs in src/services/mcp/config.ts',
    )

    writeFileSync(
      join(LIVE_HOME, '.mercury.json'),
      JSON.stringify({ projects: { [normalizePathForConfigKey(LIVE_PROJ)]: { hasTrustDialogAccepted: true } } }),
    )
    rmSync(marker('user-marker'), { force: true })
    const trustedRun = run(['run', 'hi'])
    check(
      'trusted run: the checkout hook fires (the historical behavior)',
      existsSync(marker('proj-marker')),
      `rc=${trustedRun.status} err=${trustedRun.stderr.slice(0, 120).replace(/\s+/g, ' ')}`,
      'a trusted run must fire the checkout hook; check hooksSnapshot in src/utils/hooks/hooksConfigSnapshot.ts and the trust record the test wrote to .mercury.json',
    )
    check('trusted run: the config-home hook still fires', existsSync(marker('user-marker')), '', 'a trusted run must keep firing config-home hooks; check hooksSnapshot in src/utils/hooks/hooksConfigSnapshot.ts')
    const trustedList = run(['mcp', 'list'])
    check(
      'trusted mcp list: the never-approved checkout server is named as skipped, not probed',
      trustedList.stdout.includes('MCP server fixsrv (project) skipped: not approved · open Mercury in this folder to approve it') && !/fixsrv: node/.test(trustedList.stdout),
      trustedList.stdout.slice(0, 200).replace(/\s+/g, ' '),
      'mcp list must name a never-approved project server as skipped without probing it; check getProjectMcpServerStatus in src/services/mcp/utils.ts and the skipped line in src/services/mcp/config.ts',
    )

    rmSync(LIVE_HOME, { recursive: true, force: true })
    rmSync(LIVE_PROJ, { recursive: true, force: true })
  }
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-untrusted-headless-gate: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-untrusted-headless-gate: all green')
