#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-disable-disconnects.ts — disabling an MCP server
//  DISCONNECTS for real, and the managed policy root resolves per platform.
//
//  THE LAW: the managed settings root has one spelling per platform, Windows
//  under %ProgramData%; disabling a server (settings toggle, /mcp toggle, a
//  removed config entry — every door funnels through clearServerCache) ends
//  the live client AND every process the server started: no ghost pid, no
//  stale cache row.
//
//    §1 the managed-root table: one Mercury-named spelling per platform;
//       windows = %ProgramData%\Mercury (env honored, literal fallback);
//    §1b every path DERIVED from the managed root is its descendant — the
//       policy file, the drop-ins, managed-mcp.json, managed rules, the
//       Managed memory entrypoint, managed skills — and no consumer
//       dirname()s the root or reads it as a file (the two spellings that
//       once sat three divergent consumers under two green provers:
//       field F-2.1/F-2.2/F-2.3);
//    §1c the managed-settings health check fires on an invalid policy value
//       through the injected fs seam, stays quiet on an absent file, and
//       REPORTS an unreadable one (the old root-read EISDIR'd into a bare
//       catch and could never warn);
//    §2 live: a stdio server that SPAWNED A HELPER (the npx/worker shape) —
//       disable ends server AND helper (base leaves the helper: a leader-
//       only signal ladder cannot reach it), and the connect cache row is
//       gone;
//    §2c the CLI health commands (mcp list / mcp get) REPORT a disabled
//       server instead of probing it — the probe once spawned the server,
//       children and all, and printed "connected" with no hint of the
//       disable (field F-3.1);
//    §3 the cleanup delegates to the ONE kill owner (no bespoke platform
//       fork at the client).
//
//  Hermetic: scratch config home; no network. Poison control (base A/B):
//  §2's helper survives on the base tree.
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-disable-disconnects.ts
// ============================================================================
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
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
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
  process.exit(1)
}, 90_000)
watchdog.unref?.()

console.log('============================================================')
console.log(' Disable disconnects — managed root + no ghost process')
console.log('============================================================')

// ── §1 the managed-root table ───────────────────────────────────────────────
section('§1 managed policy root — one Mercury spelling per platform')
{
  const { managedRootCandidates } = await import('../../src/utils/settings/managedPath.ts')
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

// ── §1b derived managed paths descend from the root ─────────────────────────
section('§1b derived managed paths all live UNDER the managed root')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  const { sep } = await import('node:path')
  const { getManagedFilePath, getManagedSettingsDropInDir } = await import('../../src/utils/settings/managedPath.ts')
  const { getSettingsFilePathForSource } = await import('../../src/utils/settings/settings.ts')
  const { getEnterpriseMcpFilePath } = await import('../../src/services/mcp/config.ts')
  const { getManagedRulesDir, getMemoryPath } = await import('../../src/utils/config/derived.ts')
  const { getSkillsPath } = await import('../../src/skills/loadSkillsDir.ts')
  const root = getManagedFilePath()
  const doors: Array<[string, string | undefined]> = [
    ['getSettingsFilePathForSource(policySettings)', getSettingsFilePathForSource('policySettings' as never)],
    ['getManagedSettingsDropInDir()', getManagedSettingsDropInDir()],
    ['getEnterpriseMcpFilePath()', getEnterpriseMcpFilePath()],
    ['getManagedRulesDir()', getManagedRulesDir()],
    ['getMemoryPath(Managed)', getMemoryPath('Managed' as never)],
    ['getSkillsPath(policySettings, skills)', getSkillsPath('policySettings' as never, 'skills')],
  ]
  for (const [label, derived] of doors) {
    t(`§1b ${label} descends from the root`, typeof derived === 'string' && derived.startsWith(root + sep), `${String(derived)} is not under ${root}`)
  }
  // The two spellings that put three divergent consumers under two green
  // provers: the root is a DIRECTORY — no consumer dirname()s it into its
  // parent, and none reads it as a file.
  const { readdirSync } = await import('node:fs')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(child, 'utf8')
        if (source.includes('dirname(getManagedFilePath())') || source.includes('readFileSync(getManagedFilePath())')) {
          offenders.push(child)
        }
      }
    }
  }
  walk(join(import.meta.dir, '..', '..', 'src'))
  t('§1b no consumer dirnames the root or reads it as a file', offenders.length === 0, offenders.join(', '))
}

// ── §1c the managed-settings health check actually fires ────────────────────
section('§1c the health check reads the POLICY FILE and can warn (field F-2.1)')
{
  // The check once read the managed root itself — EISDIR into a bare catch,
  // structurally dead on every real install. Inject the fs seam: the policy
  // file carries exactly the invalid value the check exists to report, and
  // the root stays a directory that throws EISDIR when read as a file.
  const { getManagedFilePath } = await import('../../src/utils/settings/managedPath.ts')
  const { getFsImplementation, setFsImplementation, setOriginalFsImplementation } = await import(
    '../../src/utils/fsOperations.ts'
  )
  const { detectManagedSettingsWarnings } = await import('../../src/utils/healthDiagnostic.ts')
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
    // An invalid type in the policy file ⇒ the warning fires.
    setFsImplementation(
      fakeFs(path => {
        if (path === policyFile) return JSON.stringify({ strictExtensionOnlyCustomization: 12345 })
        if (path === root) return errnoThrow('EISDIR')
        return errnoThrow('ENOENT')
      }),
    )
    const invalidType = detectManagedSettingsWarnings()
    t(
      '§1c an invalid strictExtensionOnlyCustomization value WARNS',
      invalidType.length === 1 && invalidType[0]!.issue.includes('invalid value of type number'),
      JSON.stringify(invalidType),
    )
    // An absent policy file stays quiet.
    setFsImplementation(fakeFs(() => errnoThrow('ENOENT')))
    t('§1c an absent policy file stays quiet', detectManagedSettingsWarnings().length === 0)
    // A policy file that exists but cannot be read is REPORTED, not swallowed.
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

// ── §2 live: disable ends the server AND its helper ─────────────────────────
section('§2 disable ends the whole server tree (the npx/worker shape)')
if (process.platform !== 'win32') {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  const mcp = await import('../../src/services/mcp/client.ts')

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

  // The ONE disable door (settings toggle, /mcp toggle, removed entry all
  // funnel here through the registry's disconnect port).
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

// ── §2c the CLI health commands REPORT a disable, never override it ─────────
section('§2c mcp list/get report disabled instead of probing it (field F-3.1)')
{
  const cfg = await import('../../src/services/mcp/config.ts')
  const cli = await import('../../src/cli/handlers/mcp.tsx')
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
  // Positive control: re-enabled, the same probe really connects (so the
  // spawn-free half above is not a broken fixture), then the disable door
  // reaps it.
  cfg.setMcpServerEnabled(name, true)
  const enabledOutcome = await cli.probeServer(name, { ...serverConfig, scope: 'local' } as never)
  t('§2c the re-enabled server connects (positive control)', enabledOutcome.outcome === 'connected', JSON.stringify(enabledOutcome))
  t('§2c the re-enabled server really spawned', existsSync(pidsFile))
  const mcpClient = await import('../../src/services/mcp/client.ts')
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
  // The rendered words: disabled is a state the command PRINTS, and both
  // list and get ride the one probe.
  const cliSrc = readFileSync(join(import.meta.dir, '..', '..', 'src/cli/handlers/mcp.tsx'), 'utf8')
  t('§2c the disabled row has its own honest words', cliSrc.includes("'- disabled (enable from /mcp)'"))
  t('§2c list and get both ride the one probe', (cliSrc.match(/probeServer\(/g) ?? []).length >= 3)
  // w4-f05-03: the probe carries the client's own reason — never one
  // reasonless 'connection error' for every stdio failure.
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
  t('§2c the rendered failed rows append the reason to the line', cliSrc.includes('failed to connect${reason}') && cliSrc.includes('connection error${reason}'))
}

// ── §3 the cleanup delegates to the one kill owner ──────────────────────────
section('§3 the disconnect rides the one cross-platform kill owner')
{
  const clientSrc = readFileSync(join(import.meta.dir, '..', '..', 'src/services/mcp/client.ts'), 'utf8')
  t('§3 cleanup imports endProcessTree from the owner', clientSrc.includes("await import('../../utils/processGroup.js')") && clientSrc.includes('endProcessTree(pid, \'SIGINT\')'))
  // The sweep strikes the graceful receipt's SURVIVORS by pid before it
  // re-walks (a root the interrupt killed has reparented its detached
  // descendants — a fresh walk from the dead root found nothing).
  t('§3 graceful phase then a hard sweep of survivors', clientSrc.includes("endProcessTreeSurvivors(pid, graceful.survivors, 'SIGKILL')"))
  t('§3 no bespoke tree-kill invocation at the client (the owner runs it)', !/(execFile|exec|spawn)\(\s*['"]taskkill/.test(clientSrc))
}

console.log(failures === 0 ? '\nPASS prove-disable-disconnects' : `\nFAIL prove-disable-disconnects (${failures})`)
process.exit(failures === 0 ? 0 : 1)
