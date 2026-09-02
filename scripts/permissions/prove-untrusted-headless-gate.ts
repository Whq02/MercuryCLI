#!/usr/bin/env bun
// prove-untrusted-headless-gate — FC-144: a never-trusted repository must not
// execute its own code on a headless run. The interactive road gates
// checkout-delivered executables behind the workspace-trust dialog; the
// headless road had NO gate — a fresh clone's SessionStart hooks,
// apiKeyHelper and .mcp.json servers all spawned on the first `mercury -p`.
//
//   §1 the predicate (untrustedWorkspaceHeadless).
//   §2 the hooks snapshot composes from OUTSIDE-CHECKOUT sources under the
//      gate; the full merge once trusted.
//   §3 the outside-checkout settings readers + call-shaped pins on the four
//      gated sites.
//   §4 project MCP: no headless auto-approval without trust; the assembly
//      excludes .mcp.json servers under the gate.
//   §5 LIVE on the built artifact: untrusted run — checkout hook and helper
//      do NOT fire, the config home's hook DOES; mcp list hides the checkout
//      server. Trusted run (real trust record) — everything fires/lists.
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'uhg-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')

// The checkout fixture: project settings with a hook + helper, and .mcp.json.
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'uhg-proj-')))
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
writeFileSync(
  join(PROJ, '.mercury', 'settings.json'),
  JSON.stringify({
    apiKeyHelper: `touch ${join(PROJ, 'helper-marker')} && echo sk-proj-fixture`,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${join(PROJ, 'proj-marker')}` }] }] },
  }),
)
writeFileSync(join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { fixsrv: { command: 'node', args: ['-e', 'setTimeout(()=>{},100)'] } } }))
// The operator's own config home: a user hook + user helper.
writeFileSync(
  join(HOME, 'settings.json'),
  JSON.stringify({
    apiKeyHelper: 'echo sk-user-fixture',
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${join(PROJ, 'user-marker')}` }] }] },
  }),
)

const { setIsInteractive, setSessionTrustAccepted, setProjectRoot, setOriginalCwd } = await import('../../src/bootstrap/state.js')
const { setCwd } = await import('../../src/utils/Shell.js')
const trustModule = (await import('../../src/utils/config/trust.js')) as unknown as {
  untrustedWorkspaceHeadless?: () => boolean
  resetTrustDialogAcceptedCacheForTesting: () => void
}
// Base-tolerant: at the pre-fix tree the predicate does not exist — legs
// then fail visibly instead of crashing the prover at import.
const untrustedWorkspaceHeadless = trustModule.untrustedWorkspaceHeadless ?? ((): boolean => false)
const predicateExported = typeof trustModule.untrustedWorkspaceHeadless === 'function'
const resetTrustDialogAcceptedCacheForTesting = trustModule.resetTrustDialogAcceptedCacheForTesting
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')

setCwd(PROJ)
// The settings project/local sources resolve from the ORIGINAL cwd and the
// project root (the live boot sets all three; this prover must too or the
// checkout fixture's settings.json is invisible to the merge).
setOriginalCwd(PROJ)
setProjectRoot(PROJ)
resetSettingsCache()

section('§1 THE PREDICATE')
{
  check('the predicate is exported (untrustedWorkspaceHeadless)', predicateExported)
  setIsInteractive(true)
  resetTrustDialogAcceptedCacheForTesting()
  check('interactive ⇒ false (the dialog road owns it)', untrustedWorkspaceHeadless() === false)
  setIsInteractive(false)
  resetTrustDialogAcceptedCacheForTesting()
  check('headless + no trust record ⇒ TRUE', untrustedWorkspaceHeadless() === true)
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
  check('headless + trust ⇒ false', untrustedWorkspaceHeadless() === false)
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
}

section('§2 THE HOOKS SNAPSHOT UNDER THE GATE')
{
  const { getHooksConfigFromSnapshot, resetHooksConfigSnapshot } = await import(
    '../../src/utils/hooks/hooksConfigSnapshot.js'
  )
  const sessionStartCommands = (snapshot: unknown): string[] => {
    const groups =
      ((snapshot ?? {}) as { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> }).SessionStart ?? []
    return groups.flatMap(g => (g.hooks ?? []).map(h => h.command ?? ''))
  }
  setIsInteractive(false)
  resetTrustDialogAcceptedCacheForTesting()
  resetSettingsCache()
  resetHooksConfigSnapshot()
  const gated = sessionStartCommands(getHooksConfigFromSnapshot())
  check(
    'gated: the config-home hook rides, the checkout hook does NOT',
    gated.some(c => c.includes('user-marker')) && !gated.some(c => c.includes('proj-marker')),
    JSON.stringify(gated),
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
  )
  const outsideHooks = JSON.stringify(getHooksFromOutsideCheckoutSources())
  check(
    'the outside-checkout hooks map carries only the config-home hook',
    outsideHooks.includes('user-marker') && !outsideHooks.includes('proj-marker'),
  )
  const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf8')
  check(
    'auth: getConfiguredApiKeyHelper gates (call-shaped)',
    /untrustedWorkspaceHeadless\(\)\) return getApiKeyHelperFromOutsideCheckoutSources\(\)/.test(src('utils', 'auth.ts')),
  )
  check(
    'hooks snapshot: the compose arm gates (call-shaped)',
    /untrustedWorkspaceHeadless\(\)/.test(src('utils', 'hooks', 'hooksConfigSnapshot.ts')) &&
      /getHooksFromOutsideCheckoutSources\(\)/.test(src('utils', 'hooks', 'hooksConfigSnapshot.ts')),
  )
  check(
    'mcp assembly: .mcp.json excluded under the gate (call-shaped)',
    /projectUntrusted \? emptyRead : getProjectMcpConfigs\(\)/.test(src('services', 'mcp', 'config.ts')),
  )
  check(
    'mcp approval: headless auto-approve now requires TRUST (call-shaped)',
    /getIsNonInteractiveSession\(\) && projectSourceEnabled && checkHasTrustDialogAccepted\(\)/.test(
      src('services', 'mcp', 'utils.ts'),
    ),
  )
}

section('§4 PROJECT MCP UNDER THE GATE')
{
  const { getProjectMcpServerStatus } = await import('../../src/services/mcp/utils.js')
  const { getMercuryMcpConfigs } = await import('../../src/services/mcp/config.js')
  setIsInteractive(false)
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  resetSettingsCache()
  check(
    "gated: the checkout server is NOT auto-approved ('pending')",
    getProjectMcpServerStatus('fixsrv') === 'pending',
    getProjectMcpServerStatus('fixsrv'),
  )
  const gatedServers = Object.keys((await getMercuryMcpConfigs()).servers)
  check('gated: the assembly excludes the .mcp.json server', !gatedServers.includes('fixsrv'), JSON.stringify(gatedServers))
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
  check(
    'trusted: headless auto-approval stands (the historical behavior)',
    getProjectMcpServerStatus('fixsrv') === 'approved',
  )
  const trustedServers = Object.keys((await getMercuryMcpConfigs()).servers)
  check('trusted: the assembly carries the .mcp.json server', trustedServers.includes('fixsrv'))
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
}

section('§5 THE ARTIFACT LIVE (fresh checkout, headless)')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    const LIVE_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'uhg-live-home-')))
    const LIVE_PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'uhg-live-proj-')))
    mkdirSync(join(LIVE_PROJ, '.mercury'), { recursive: true })
    const marker = (name: string): string => join(LIVE_PROJ, name)
    writeFileSync(
      join(LIVE_PROJ, '.mercury', 'settings.json'),
      JSON.stringify({
        apiKeyHelper: `touch ${marker('helper-marker')} && echo sk-proj-fixture`,
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker('proj-marker')}` }] }] },
      }),
    )
    writeFileSync(join(LIVE_PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { fixsrv: { command: 'node', args: ['-e', 'setTimeout(()=>{},100)'] } } }))
    writeFileSync(
      join(LIVE_HOME, 'settings.json'),
      JSON.stringify({
        apiKeyHelper: 'echo sk-user-fixture',
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker('user-marker')}` }] }] },
      }),
    )
    // No real credential can be reached: the user-scope fixture helper sits
    // ABOVE the keychain arm in the auth ladder, so the run fails fast on an
    // invalid fixture key and never touches the operator's account.
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

    const untrustedRun = run(['-p', 'hi'])
    check('untrusted -p: the checkout SessionStart hook did NOT fire', !existsSync(marker('proj-marker')))
    check('untrusted -p: the checkout apiKeyHelper did NOT execute', !existsSync(marker('helper-marker')))
    check(
      'untrusted -p: the config-home SessionStart hook DID fire (source-scoped, not blanket)',
      existsSync(marker('user-marker')),
      `rc=${untrustedRun.status} err=${untrustedRun.stderr.slice(0, 120).replace(/\s+/g, ' ')}`,
    )
    const untrustedList = run(['mcp', 'list'])
    check(
      'untrusted mcp list: the checkout server is not loaded',
      !untrustedList.stdout.includes('fixsrv'),
      untrustedList.stdout.slice(0, 120).replace(/\s+/g, ' '),
    )

    // Trust the directory for real (the record one interactive boot writes).
    writeFileSync(
      join(LIVE_HOME, '.mercury.json'),
      JSON.stringify({ projects: { [LIVE_PROJ]: { hasTrustDialogAccepted: true } } }),
    )
    rmSync(marker('user-marker'), { force: true })
    const trustedRun = run(['-p', 'hi'])
    check(
      'trusted -p: the checkout hook fires (the historical behavior)',
      existsSync(marker('proj-marker')),
      `rc=${trustedRun.status} err=${trustedRun.stderr.slice(0, 120).replace(/\s+/g, ' ')}`,
    )
    check('trusted -p: the config-home hook still fires', existsSync(marker('user-marker')))
    const trustedList = run(['mcp', 'list'])
    check('trusted mcp list: the checkout server is listed', trustedList.stdout.includes('fixsrv'))

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
