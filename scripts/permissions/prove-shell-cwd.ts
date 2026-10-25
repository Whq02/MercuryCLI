import { plugin } from 'bun'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shell-cwd-rules-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SRC = join(import.meta.dir, '../../src')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { setCwd, getShellCwd, resolveShellCwd, exec } = await import('../../src/utils/Shell.js')
const { getCwd, runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.js')
const { isPathTrusted, resetTrustDialogAcceptedCacheForTesting } = await import('../../src/utils/config/trust.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { powershellToolHasPermission } = await import('../../src/tools/PowerShellTool/powershellPermissions.js')
const { checkReadOnlyConstraints, prepareBashReadOnly, preparedBashReadsOnly } = await import('../../src/tools/BashTool/readOnlyValidation.js')
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.js')
const { pinnedCommandAnalysis } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
const { getCachedPowerShellPath } = await import('../../src/utils/shell/powershellDetection.js')
const realPowerShellParser = pinnedCommandAnalysis.parsePowerShellCommand
if (await getCachedPowerShellPath() === null) {
  console.log('PowerShell permission checks use literal-command AST fixtures; native pwsh is unavailable.')
  pinnedCommandAnalysis.parsePowerShellCommand = async text => {
    const words = text.match(/'[^']*'|\S+/g) ?? []
    const name = words.shift() ?? ''
    if (!['Get-Content', 'Set-Content', 'Get-Location', 'Set-Location', 'git'].includes(name)) throw new Error(`Unexpected fixture command: ${text}`)
    const args = words.map(word => word.replace(/^'|'$/g, ''))
    return { valid: true, statements: [{ statementType: 'pipeline', text, commands: [{ name, text, nameType: name === 'git' ? 'application' : 'cmdlet', args, elementType: 'command', elementTypes: args.map(() => 'StringConstant') }], nestedCommands: [], redirections: [] }], variables: [], errors: [], hasStopParsing: false, originalCommand: text }
  }
}
const project = join(scratch, 'project')
const sub = join(project, 'packages', 'one')
const other = join(project, 'packages', 'two')
const outside = join(scratch, 'outside')
for (const dir of [sub, other, outside, join(project, 'bare', 'objects'), join(project, 'bare', 'refs')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(project, 'bare', 'HEAD'), 'ref: refs/heads/main\n')
writeFileSync(join(sub, 'file'), 'needle\n')
symlinkSync(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
setCwd(project)
setOriginalCwd(project)
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const permission = (deny: string[] = [], allow: string[] = []) => ({
  ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: deny }, alwaysAllowRules: { session: allow },
})
async function decide(tool: 'Bash' | 'PowerShell', input: { command: string; cwd?: string }, rules = permission()) {
  return tool === 'Bash' ? bashToolHasPermission(input, rules) : powershellToolHasPermission(input, { getAppState: () => ({ toolPermissionContext: rules }), abortController: new AbortController() } as never)
}
try {
  for (const tool of ['Bash', 'PowerShell'] as const) {
    const command = tool === 'Bash' ? 'cat file' : 'Get-Content file'
    for (const cwd of [sub, relative(project, sub)]) {
      const input = { command, cwd }
      const result = await decide(tool, input)
      check(`${tool}: ${cwd === sub ? 'absolute' : 'relative'} cwd is allowed inside the workspace`, result.behavior === 'allow', result)
      check(`${tool}: an allow preserves the command and pins the resolved cwd`, result.behavior === 'allow' && result.updatedInput.command === command && result.updatedInput.cwd === sub, result)
      const denied = await decide(tool, input, permission([`Read(/${join(sub, 'file')})`]))
      check(`${tool}: relative operands use the per-call cwd for deny rules`, denied.behavior === 'deny', denied)
    }
    for (const cwd of [outside, relative(project, outside), join(project, 'escape')]) {
      const result = await decide(tool, { command, cwd })
      const cd = await decide(tool, { command: tool === 'Bash' ? `cd '${cwd}'` : `Set-Location '${cwd}'` })
      check(`${tool}: out-of-bound cwd uses the cd refusal`, result.behavior === 'ask' && result.message === cd.message, { result, cd })
    }
    const cwdDenied = await decide(tool, { command, cwd: sub }, permission([`Read(/${sub})`], [tool]))
    check(`${tool}: a denied cwd beats a whole-tool allow`, cwdDenied.behavior === 'deny', cwdDenied)
    const bare = await decide(tool, { command: 'git status', cwd: join(project, 'bare') })
    check(`${tool}: a bare-repository cwd still asks`, bare.behavior !== 'allow', bare)
    const outsideWrite = await decide(tool, { command: tool === 'Bash' ? 'touch ../../../outside/new' : 'Set-Content ../../../outside/new value', cwd: sub }, { ...permission(), mode: 'implement' })
    check(`${tool}: a relative write escaping from cwd still asks`, outsideWrite.behavior === 'ask', outsideWrite)
    const withinWrite = await decide(tool, { command: tool === 'Bash' ? 'touch new' : 'Set-Content new value', cwd: sub }, { ...permission(), mode: 'implement' })
    check(`${tool}: a workspace write no longer trips the compound-cd guard`, withinWrite.behavior === 'allow', withinWrite)
    for (const mode of ['default', 'implement', 'dontAsk', 'flow', 'sovereign'] as const) {
      const rules = { ...permission([`Read(/${sub})`], [tool]), mode }
      const result = await decideToolPermission({ name: tool } as never, { command, cwd: sub }, { getAppState: () => ({ toolPermissionContext: rules }), abortController: new AbortController() } as never, {
        isToolKilled: () => false,
        resolveToolVerdict: () => decide(tool, { command, cwd: sub }, rules),
      })
      check(`${tool}/${mode}: cwd deny survives the permission chain`, result.decision.behavior === 'deny', result.decision)
    }
  }
  const redirect = await decide('Bash', { command: 'cat < file', cwd: sub })
  check('an input redirect resolves against cwd without a compound-cd ask', redirect.behavior === 'allow', redirect)
  const moved = await exec(`cd '${other}'`, new AbortController().signal, 'bash', { timeout: 10_000 })
  await moved.result
  moved.cleanup()
  check('the control cd changed the shell directory', getShellCwd() === other, getShellCwd())
  check('relative cwd still resolves against the starting folder', resolveShellCwd(relative(project, sub)) === sub)
  const input = { command: 'git status', cwd: sub }
  await prepareBashReadOnly(input)
  check('read-only cache uses the explicit directory', preparedBashReadsOnly(input))
  check('read-only cache cannot be reused for a bare cwd', !preparedBashReadsOnly({ ...input, cwd: join(project, 'bare') }))
  check('bare cwd is not read-only', (await checkReadOnlyConstraints({ ...input, cwd: join(project, 'bare') }, false)).behavior !== 'allow')
  await runWithCwdOverride(sub, async () => {
    check('a crewmate resolves relative cwd from its own starting folder', resolveShellCwd('../two') === other)
    await decide('Bash', { command: 'pwd', cwd: '../two' })
    check('a crewmate permission check does not move its shell or workspace', getShellCwd() === sub && getCwd() === sub)
  })
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  const trustedBefore = [isPathTrusted(project), isPathTrusted(outside)]
  await decide('Bash', { command: 'pwd', cwd: outside })
  await decide('PowerShell', { command: 'Get-Location', cwd: sub })
  check('cwd checks grant no workspace trust and change no directory', JSON.stringify(trustedBefore) === JSON.stringify([isPathTrusted(project), isPathTrusted(outside)]) && getCwd() === project && getShellCwd() === other)

  const run = async (command: string, options: Record<string, unknown>) => {
    const running = await exec(command, new AbortController().signal, 'bash', { timeout: 20_000, shouldAutoBackground: false, ...options })
    const result = await running.result
    running.cleanup()
    return { out: result.stdout.trim(), code: result.code, stderr: result.stderr, shell: getShellCwd() }
  }
  const resting = getShellCwd()
  const absoluteRun = await run('pwd -P && cd / && pwd -P', { cwd: sub })
  check('Bash spawn: an absolute cwd runs there, and a cd inside the command leaves the session directory', absoluteRun.out === `${sub}\n/` && absoluteRun.shell === resting, absoluteRun)
  const relativeRun = await run('pwd -P', { cwd: relative(project, sub) })
  check('Bash spawn: a relative cwd starts from the starting folder, not the shell directory', relativeRun.out === sub && relativeRun.shell === resting, relativeRun)
  const missingRun = await run('pwd -P', { cwd: 'packages/none' })
  check('Bash spawn: a cwd that does not exist runs nothing', missingRun.code !== 0 && missingRun.out === '' && missingRun.stderr.includes('does not exist') && missingRun.shell === resting, missingRun)
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
  let appState = getDefaultAppState()
  const toolContext = {
    options: { tools: [], commands: [], mcpClients: [], mcpResources: {} },
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
    abortController: new AbortController(),
    toolUseId: 'shell-cwd',
  } as never
  const toolRun = await BashTool.call({ command: 'pwd -P && cd / && pwd -P', cwd: relative(project, sub) }, toolContext)
  check('Bash tool: the per-call cwd reaches the spawn and the session directory stays', toolRun.data.stdout.trim() === `${sub}\n/` && getShellCwd() === resting, toolRun.data)

  const preamble = `
    const { plugin } = await import('bun')
    plugin({ name: 'stub-color-diff-napi', setup(build) { build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } })) } })
    globalThis.MACRO = { VERSION: '1.0.0' }
    const src = ${JSON.stringify(SRC)}
    const { enableConfigs } = await import(src + '/utils/config.ts')
    enableConfigs()
    const { setCwd, getShellCwd, exec } = await import(src + '/utils/Shell.ts')
    const { setOriginalCwd } = await import(src + '/bootstrap/state.ts')
    setCwd(${JSON.stringify(project)})
    setOriginalCwd(${JSON.stringify(project)})
    const run = async (command, shell, options) => {
      const running = await exec(command, new AbortController().signal, shell, { timeout: 20000, shouldAutoBackground: false, ...options })
      const result = await running.result
      running.cleanup()
      return { out: result.stdout.trim(), code: result.code, stderr: result.stderr, shell: getShellCwd() }
    }
  `
  const child = (program: string, env: Record<string, string>): Record<string, any> => {
    const ran = spawnSync(process.execPath, ['-e', preamble + program], { env: { ...process.env, ...env, MERCURY_CONFIG_DIR: join(scratch, 'child-config') }, encoding: 'utf8', timeout: 120_000 })
    const line = (ran.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
    try {
      return JSON.parse(line)
    } catch {
      return { failed: ran.status, stdout: (ran.stdout ?? '').slice(-400), stderr: (ran.stderr ?? '').slice(-400) }
    }
  }

  const fakeBin = join(scratch, 'bin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'pwsh'), String.raw`#!/bin/bash
record=$(printf '%s\n' "$4" | sed -n "s/.*WriteAllText('\([^']*\)'.*/\1/p")
pwd -P
if [ -n "$record" ]; then printf '%s' "MOVE_TO" > "$record"; fi
`.replace('MOVE_TO', outside), { mode: 0o755 })
  const pwsh = child(`
    const { getCachedPowerShellPath } = await import(src + '/utils/shell/powershellDetection.ts')
    const found = await getCachedPowerShellPath()
    const control = await run('Get-Location', 'powershell', {})
    const resting = getShellCwd()
    const absolute = await run('Get-Location', 'powershell', { cwd: ${JSON.stringify(sub)} })
    const relative = await run('Get-Location', 'powershell', { cwd: 'packages/one' })
    const missing = await run('Get-Location', 'powershell', { cwd: 'packages/none' })
    const { PowerShellTool } = await import(src + '/tools/PowerShellTool/PowerShellTool.tsx')
    const tool = await PowerShellTool.call({ command: 'Get-Location', cwd: 'packages/one' }, { abortController: new AbortController(), getAppState: () => ({}), setAppState: () => {}, toolUseId: 'pwsh-cwd', options: { tools: [] } })
    console.log(JSON.stringify({ found, control, resting, absolute, relative, missing, tool: { out: tool.data.stdout.trim(), shell: getShellCwd() } }))
    process.exit(0)
  `, { PATH: `${fakeBin}:${process.env.PATH ?? ''}` })
  check('PowerShell spawn fixture: the stand-in pwsh is the PowerShell found', pwsh.found === join(fakeBin, 'pwsh'), pwsh)
  check('PowerShell spawn fixture: a call without cwd follows the recorded directory (the control)', pwsh.control?.out === project && pwsh.control?.shell === outside, pwsh)
  check('PowerShell spawn: an absolute cwd runs there and the session directory stays', pwsh.absolute?.out === sub && pwsh.absolute?.shell === pwsh.resting, pwsh)
  check('PowerShell spawn: a relative cwd starts from the starting folder', pwsh.relative?.out === sub && pwsh.relative?.shell === pwsh.resting, pwsh)
  check('PowerShell spawn: a cwd that does not exist runs nothing', pwsh.missing?.code !== 0 && pwsh.missing?.out === '' && String(pwsh.missing?.stderr).includes('does not exist'), pwsh)
  check('PowerShell tool: the per-call cwd reaches the spawn and the session directory stays', pwsh.tool?.out === sub && pwsh.tool?.shell === pwsh.resting, pwsh)

  const brush = child(`
    const { resolveShellEngine, endEngineSession } = await import(src + '/utils/shell/engineSession.ts')
    const engine = resolveShellEngine()
    if (engine.engine !== 'brush') {
      console.log(JSON.stringify({ skipped: String(engine.reason ?? engine.engine) }))
      process.exit(0)
    }
    const control = await run(${JSON.stringify(`cd '${other}'`)}, 'bash', {})
    const absolute = await run('pwd -P && cd / && pwd -P', 'bash', { cwd: ${JSON.stringify(sub)} })
    const relative = await run('pwd -P', 'bash', { cwd: 'packages/one' })
    const missing = await run('pwd -P', 'bash', { cwd: 'packages/none' })
    const after = await run('pwd -P', 'bash', {})
    await endEngineSession()
    console.log(JSON.stringify({ control, absolute, relative, missing, after }))
    process.exit(0)
  `, { MERCURY_SHELL_ENGINE: 'brush' })
  if (typeof brush.skipped === 'string') console.log(`[INFO] the shell engine leg did not run here: ${brush.skipped}`)
  else {
    check('engine spawn: the control cd moves the session directory', brush.control?.shell === other, brush)
    check('engine spawn: an absolute cwd runs there and a cd inside never moves the session', brush.absolute?.out === `${sub}\n/` && brush.absolute?.shell === other, brush)
    check('engine spawn: a relative cwd starts from the starting folder', brush.relative?.out === sub && brush.relative?.shell === other, brush)
    check('engine spawn: a cwd that does not exist runs nothing', brush.missing?.code !== 0 && brush.missing?.out === '' && String(brush.missing?.stderr).includes('does not exist'), brush)
    check('engine spawn: the next call without cwd runs in the session directory again', brush.after?.out === other && brush.after?.shell === other, brush)
  }
} finally {
  pinnedCommandAnalysis.parsePowerShellCommand = realPowerShellParser
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`shell-cwd-rules: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
