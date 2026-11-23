#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-disable-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const disableHintFor = (name: string): string => {
  if (name.startsWith('§1b ')) return 'a derived managed path must descend from getManagedFilePath in src/platform/settings/managedPath.ts; fix the function named in this label'
  if (name.startsWith('§1c ')) return 'fix detectManagedSettingsWarnings in src/platform/health/healthDiagnostic.ts so it reads the policy file and reports what this check names'
  if (name.startsWith('§1 ')) return 'fix managedRootCandidates in src/platform/settings/managedPath.ts so each platform has one Mercury-named root'
  if (name.startsWith('§2c ')) return 'fix probeServer in src/commands/verbs/mcp.tsx (a disabled server must not be spawned, an enabled one must connect)'
  if (name.startsWith('§2 ')) return 'fix connectToServer and clearServerCache in src/integrations/mcp/client.ts so disabling ends the server and its helper and drops the cache row'
  return 'look at the function this check names'
}
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok ? ` — ${disableHintFor(name)}${detail ? `; ${detail}` : ''}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — disable-disconnects prover exceeded 90s')
  console.log('a connect, a clearServerCache or a probeServer call never returned; look at src/integrations/mcp/client.ts and src/commands/verbs/mcp.tsx')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

console.log('============================================================')
console.log(' Disable disconnects — managed root + no ghost process')
console.log('============================================================')

section('§1 managed policy root — one Mercury spelling per platform')
{
  const { managedRootCandidates } = await import('../../src/platform/settings/managedPath.ts')
  for (const platform of ['macos', 'windows', 'linux'] as const) {
    const candidates = managedRootCandidates(platform)
    t(`§1 ${platform}: one Mercury-named spelling`, candidates.length === 1 && /mercury/i.test(candidates[0]!), candidates.join(' | '))
  }
  const heldProgramData = process.env.ProgramData
  process.env.ProgramData = 'D:\\PolicyData'
  t('§1 windows honors %ProgramData%', managedRootCandidates('windows')[0] === 'D:\\PolicyData\\Mercury', managedRootCandidates('windows')[0])
  delete process.env.ProgramData
  t('§1 windows falls back to the literal ProgramData root', managedRootCandidates('windows')[0] === 'C:\\ProgramData\\Mercury', managedRootCandidates('windows')[0])
  t('§1 windows never points at Program Files', managedRootCandidates('windows').every(c => !/Program Files/i.test(c)))
  if (heldProgramData !== undefined) process.env.ProgramData = heldProgramData
}

section('§1b derived managed paths all live UNDER the managed root')
{
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const bootstrap = await import('../../src/boot/process-state/processState.ts')
  bootstrap.setIsInteractive(false)
  const { sep } = await import('node:path')
  const { getManagedFilePath, getManagedSettingsDropInDir } = await import('../../src/platform/settings/managedPath.ts')
  const { getSettingsFilePathForSource } = await import('../../src/platform/settings/settings.ts')
  const { getEnterpriseMcpFilePath } = await import('../../src/integrations/mcp/serverConfigs.ts')
  const { getManagedRulesDir, getInstructionFilePath } = await import('../../src/platform/config/derived.ts')
  const { getSkillsPath } = await import('../../src/integrations/skills/loadSkillsDir.ts')
  const root = getManagedFilePath()
  const doors: Array<[string, string | undefined]> = [
    ['getSettingsFilePathForSource(policySettings)', getSettingsFilePathForSource('policySettings' as never)],
    ['getManagedSettingsDropInDir()', getManagedSettingsDropInDir()],
    ['getEnterpriseMcpFilePath()', getEnterpriseMcpFilePath()],
    ['getManagedRulesDir()', getManagedRulesDir()],
    ['getInstructionFilePath(Managed)', getInstructionFilePath('Managed' as never)],
    ['getSkillsPath(policySettings, skills)', getSkillsPath('policySettings' as never, 'skills')],
  ]
  for (const [label, derived] of doors) {
    t(`§1b ${label} descends from the root`, typeof derived === 'string' && derived.startsWith(root + sep), `${String(derived)} is not under ${root}`)
  }
}

section('§1c the health check reads the POLICY FILE and can warn (field F-2.1)')
{
  const { getManagedFilePath } = await import('../../src/platform/settings/managedPath.ts')
  const { getFsImplementation, setFsImplementation, setOriginalFsImplementation } = await import(
    '../../src/platform/files/fsOperations.ts'
  )
  const { detectManagedSettingsWarnings } = await import('../../src/platform/health/healthDiagnostic.ts')
  const root = getManagedFilePath()
  const policyFile = join(root, 'managed-settings.json')
  const realFs = getFsImplementation()
  const errnoThrow = (code: string): never => {
    const error = new Error(code) as NodeJS.ErrnoException
    error.code = code
    throw error
  }
  const fakeFs = (answer: (path: string) => string): typeof realFs => ({
    ...realFs,
    readFileSync: (path: string, _options: { encoding: BufferEncoding }): string => answer(path),
  })
  try {
    setFsImplementation(
      fakeFs(path => {
        if (path === policyFile) return JSON.stringify({ extensions: { exclusive: 12345 } })
        if (path === root) return errnoThrow('EISDIR')
        return errnoThrow('ENOENT')
      }),
    )
    const invalidType = detectManagedSettingsWarnings()
    t(
      '§1c an invalid extensions.exclusive value WARNS',
      invalidType.length === 1 && invalidType[0]!.issue.includes('invalid value of type number'),
      JSON.stringify(invalidType),
    )
    setFsImplementation(fakeFs(() => errnoThrow('ENOENT')))
    t('§1c an absent policy file stays quiet', detectManagedSettingsWarnings().length === 0)
    setFsImplementation(fakeFs(path => (path === policyFile ? errnoThrow('EACCES') : errnoThrow('ENOENT'))))
    const unreadable = detectManagedSettingsWarnings()
    t(
      '§1c an unreadable policy file is reported, never swallowed',
      unreadable.length === 1 && unreadable[0]!.issue.includes('EACCES'),
      JSON.stringify(unreadable),
    )
  } finally {
    setOriginalFsImplementation()
  }
}

section('§2 disable ends the whole server tree (the npx/worker shape)')
if (process.platform !== 'win32') {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const bootstrap = await import('../../src/boot/process-state/processState.ts')
  bootstrap.setIsInteractive(false)
  const mcp = await import('../../src/integrations/mcp/client.ts')

  const pidsFile = join(SCRATCH, 'spawner-pids')
  const config = {
    type: 'stdio',
    command: process.execPath.includes('bun') ? 'node' : process.execPath,
    args: [join(import.meta.dir, '_fixture-stdio-spawner.mjs')],
    env: { MCP_SPAWNER_PIDS: pidsFile },
    scope: 'local',
  } as never
  const name = 'spawnersrv'
  const outcome = (await mcp.connectToServer(name, config)) as unknown as Record<string, unknown>
  t('§2 the spawner fixture connects', outcome.type === 'connected', String(outcome.error ?? outcome.type))
  await sleep(200)
  const [serverPid, helperPid] = readFileSync(pidsFile, 'utf8').split(':').map(Number)
  t('§2 server + helper are both up', alive(serverPid!) && alive(helperPid!), `pids ${serverPid}/${helperPid}`)

  await mcp.clearServerCache(name, config)

  let serverGone = !alive(serverPid!)
  let helperGone = !alive(helperPid!)
  const deadline = Date.now() + 5_000
  while ((!serverGone || !helperGone) && Date.now() < deadline) {
    await sleep(100)
    serverGone = !alive(serverPid!)
    helperGone = !alive(helperPid!)
  }
  t('§2 the server process is gone', serverGone, `pid ${serverPid}`)
  t('§2 the HELPER is gone too — no ghost (base leaves it running)', helperGone, `pid ${helperPid}`)
  t('§2 the connect cache row is gone', !mcp.connectToServer.cache.has(mcp.getServerCacheKey(name, config)))
} else {
  console.log('  [SKIP] live leg is POSIX-shaped on this host; the win32 leg rides the field task')
}

section('§2c mcp list/get report disabled instead of probing it (field F-3.1)')
{
  const cfg = await import('../../src/integrations/mcp/serverConfigs.ts')
  const cli = await import('../../src/commands/verbs/mcp.tsx')
  const pidsFile = join(SCRATCH, 'cli-ghost-pids')
  const name = 'cli-ghost-probe'
  const serverConfig = {
    type: 'stdio',
    command: process.execPath.includes('bun') ? 'node' : process.execPath,
    args: [join(import.meta.dir, '_fixture-stdio-spawner.mjs')],
    env: { MCP_SPAWNER_PIDS: pidsFile },
  }
  await cfg.addMcpConfig(name, serverConfig, 'local' as never)
  cfg.setMcpServerEnabled(name, false)
  const { existsSync } = await import('node:fs')
  const disabledOutcome = await cli.probeServer(name, { ...serverConfig, scope: 'local' } as never)
  t('§2c a disabled server reports disabled', disabledOutcome.outcome === 'disabled', JSON.stringify(disabledOutcome))
  t('§2c the disabled server was NEVER spawned', !existsSync(pidsFile), 'spawner pids file exists — the probe started it')
  cfg.setMcpServerEnabled(name, true)
  const enabledOutcome = await cli.probeServer(name, { ...serverConfig, scope: 'local' } as never)
  t('§2c the re-enabled server connects (positive control)', enabledOutcome.outcome === 'connected', JSON.stringify(enabledOutcome))
  t('§2c the re-enabled server really spawned', existsSync(pidsFile))
  const mcpClient = await import('../../src/integrations/mcp/client.ts')
  await mcpClient.clearServerCache(name, { ...serverConfig, scope: 'local' } as never)
  const [controlServerPid] = existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').split(':').map(Number) : []
  if (controlServerPid !== undefined && Number.isFinite(controlServerPid)) {
    let gone = !alive(controlServerPid)
    const reapDeadline = Date.now() + 5_000
    while (!gone && Date.now() < reapDeadline) {
      await sleep(100)
      gone = !alive(controlServerPid)
    }
    t('§2c the control server is reaped', gone, `pid ${controlServerPid}`)
  }
  const deadOutcome = await cli.probeServer('dead-command-probe', {
    type: 'stdio',
    command: '/nonexistent-mercury-dead-probe-command',
    args: [],
    scope: 'local',
  } as never)
  t(
    '§2c a dead command’s probe carries the client’s own reason (w4-f05-03 — never a bare label)',
    (deadOutcome.outcome === 'connection-error' || deadOutcome.outcome === 'failed-to-connect') &&
      typeof deadOutcome.reason === 'string' &&
      deadOutcome.reason.length > 0,
    JSON.stringify(deadOutcome),
  )
}


console.log(failures === 0 ? '\nPASS prove-disable-disconnects' : `\nFAIL prove-disable-disconnects (${failures})`)
process.exit(failures === 0 ? 0 : 1)
