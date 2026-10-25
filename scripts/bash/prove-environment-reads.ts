import { plugin } from 'bun'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({ name: 'environment-read-native', setup(build) { build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } })) } })
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'environment-reads-')))
const before = process.cwd()
mkdirSync(join(scratch, 'run'))
process.chdir(join(scratch, 'run'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.FIRST_HOUR_ENV_FIXTURE = 'environment-read-fixture'
delete process.env.MERCURY_SHELL_ENGINE
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.js')
const { getFirstWordPrefix } = await import('../../src/tools/BashTool/bashPermissions.js')
const { windowsPathToPosixPath } = await import('../../src/utils/windowsPaths.js')
const nativeHome = process.env.HOME ?? process.env.USERPROFILE ?? ''
const printedHome = process.platform === 'win32' ? windowsPathToPosixPath(nativeHome) : nativeHome
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
let appState = { ...getDefaultAppState(), toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const, shouldAvoidPermissionPrompts: true } }
const context = {
  options: { engineModel: 'proof-model', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(), messages: [],
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
  abortController: new AbortController(), toolUseId: 'environment-reads',
}
async function decide(command: string, headless = true, deny: string[] = []) {
  appState.toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default', shouldAvoidPermissionPrompts: headless, alwaysDenyRules: { localSettings: deny } }
  const input = { command }
  await BashTool.prepare?.(input as never)
  return (await decideToolPermissionWithModes(BashTool as never, input, context as never, { message: { id: 'environment-reads' } } as never, 'environment-reads')).decision
}
try {
  for (const command of ['env', 'env -0', 'printenv', 'printenv FIRST_HOUR_ENV_FIXTURE', 'env | grep FIRST_HOUR_ENV_FIXTURE', 'printenv HOME']) {
    const verdict = await decide(command)
    check(`${command}: default headless allows without a card`, verdict.behavior === 'allow', JSON.stringify(verdict))
    if (verdict.behavior !== 'allow') continue
    const { data } = await (BashTool as unknown as { call: (input: unknown, context: unknown) => Promise<{ data: { code?: number; stdout: string } }> }).call({ command }, context)
    const want = command === 'printenv HOME' ? printedHome : 'environment-read-fixture'
    check(`${command}: completed with exit 0 and output`, data.code === 0 && want !== '' && data.stdout.includes(want))
  }
  for (const command of ['env echo fixture', 'env VAR=x echo fixture', 'env -i echo fixture', 'env -0 echo fixture', 'env -S "echo fixture"', 'env > environment.txt', 'printenv HOME PATH', 'printenv > environment.txt', 'printenv $(echo HOME)']) {
    const interactive = await decide(command, false)
    const headless = await decide(command)
    check(`${command}: still asks interactively`, interactive.behavior === 'ask', JSON.stringify(interactive))
    check(`${command}: auto-denied headless`, headless.behavior === 'deny', JSON.stringify(headless))
  }
  check('env never offers a blanket executable prefix', getFirstWordPrefix('env') === null && getFirstWordPrefix('env echo fixture') === null)
  for (const command of ['env', 'printenv HOME', 'env | grep HOME']) {
    const denied = await decide(command, true, ['Bash(env)', 'Bash(printenv *)'])
    check(`${command}: explicit deny still wins`, denied.behavior === 'deny', JSON.stringify(denied))
  }
} finally {
  process.chdir(before)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `environment-reads: ${failures} FAILURE(S)` : 'environment-reads: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
