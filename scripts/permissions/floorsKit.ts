import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import { removeScratch } from '../lib/removeScratch.ts'

const TREE = resolve(import.meta.dir, '..', '..')
const FAKE_USER = 'operator'

if (!process.env.FLOORS_KIT_ROOT) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'floors-kit-')))
  const config = join(root, 'config')
  const home = join(root, 'home', 'Users', FAKE_USER)
  mkdirSync(join(config, 'tmp'), { recursive: true })
  mkdirSync(home, { recursive: true })
  const child = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    env: { ...process.env, HOME: home, USERPROFILE: home, USER: FAKE_USER, LOGNAME: FAKE_USER, FLOORS_KIT_ROOT: root, MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(config, 'tmp'), MERCURY_DAEMON_DIR: join(config, 'daemon') },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  removeScratch(root)
  process.exit(child.exitCode ?? 99)
}

const ROOT = process.env.FLOORS_KIT_ROOT
const CONFIG_HOME = join(ROOT, 'config')
const OWN_HOME = join(ROOT, 'home', 'Users', FAKE_USER)
const PROJECT = join(ROOT, 'project')
if (homedir() !== OWN_HOME) {
  process.stderr.write(`floors kit: the scratch home did not take (os.homedir() is ${homedir()}, wanted ${OWN_HOME})\n`)
  process.exit(98)
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

mkdirSync(PROJECT, { recursive: true })
mkdirSync(join(CONFIG_HOME, 'daemon'), { recursive: true })
for (const dir of ['.ssh', '.aws', 'Documents']) mkdirSync(join(OWN_HOME, dir), { recursive: true })
writeFileSync(join(OWN_HOME, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA stand-in\n')
for (const file of ['.credentials.json', '.provider-secrets.json', 'mcp-auth.json', 'browser-secrets.json']) writeFileSync(join(CONFIG_HOME, file), '{"secret":"CANARY-MERCURY-SECRET-2207"}\n')
mkdirSync(join(CONFIG_HOME, 'runtime', 'current'), { recursive: true })
writeFileSync(join(CONFIG_HOME, 'runtime', 'current', 'mercury.mjs'), 'export {}\n')
mkdirSync(join(PROJECT, '.git'), { recursive: true })
mkdirSync(join(PROJECT, 'sub'), { recursive: true })
mkdirSync(join(PROJECT, 'secrets'), { recursive: true })
mkdirSync(join(PROJECT, 'build'), { recursive: true })
writeFileSync(join(PROJECT, 'secrets', 'k.txt'), 'K\n')
writeFileSync(join(PROJECT, '.env'), 'SECRET=CANARY-DOTENV-3318\n')
writeFileSync(join(PROJECT, 'MERCURY.md'), '# instructions\n')
writeFileSync(join(PROJECT, 'notes.txt'), 'notes\n')
try {
  symlinkSync(join(CONFIG_HOME, '.credentials.json'), join(PROJECT, 'link-creds'))
} catch (error) {
  if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
}
process.chdir(PROJECT)

const standIn = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
const DAEMON_PID = standIn.pid ?? 0
process.on('exit', () => {
  try {
    standIn.kill()
  } catch {
  }
})

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
const { daemonStatePath } = await import('../../src/daemon/controlSocket.ts')
const { MonitorTool } = await import('../../src/tools/MonitorTool/MonitorTool.ts')
const { ServiceTool } = await import('../../src/tools/ServiceTool/ServiceTool.ts')
const { JourneyTool } = await import('../../src/tools/JourneyTool/JourneyTool.ts')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
const { setOriginalCwd, setCwdState, setProjectRoot } = await import('../../src/bootstrap/state.ts')
enableConfigs()
setOriginalCwd(PROJECT)
setCwdState(PROJECT)
setProjectRoot(PROJECT)
writeFileSync(daemonStatePath(), JSON.stringify({ pid: DAEMON_PID, startedAt: Date.now(), script: join(CONFIG_HOME, 'runtime', 'current', 'mercury.mjs') }))

type Decision = { behavior: string; message?: string; updatedInput?: Record<string, unknown>; decisionReason?: { type?: string; rule?: { ruleValue?: { toolName?: string; ruleContent?: string } } } }
export type Rules = { deny?: string[]; allow?: string[]; ask?: string[] }
const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
} as never
const TOOLS: Record<string, unknown> = { Bash: bash, Monitor: MonitorTool, Service: ServiceTool, Journey: JourneyTool, Debug: DebugTool }

export async function decide(tool: string, input: Record<string, unknown>, mode: string, rules: Rules = {}): Promise<Decision> {
  const state = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode,
      isBypassPermissionsModeAvailable: mode === 'sovereign',
      alwaysDenyRules: rules.deny ? { localSettings: rules.deny } : {},
      alwaysAllowRules: rules.allow ? { localSettings: rules.allow } : {},
      alwaysAskRules: rules.ask ? { localSettings: rules.ask } : {},
    },
  }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: { tools: [] }, readFileState: new Map() } as never
  try {
    const outcome = await decideToolPermissionWithModes(TOOLS[tool] as never, input, context, { message: { id: 'floors-kit' } } as never, 'floors-kit')
    return outcome.decision as Decision
  } catch (error) {
    return { behavior: 'threw', message: error instanceof Error ? error.message : String(error) }
  }
}

const NAMED: Array<[string, string]> = [[OWN_HOME, '<home>'], [CONFIG_HOME, '<config>'], [PROJECT, '<project>']]
const named = (text: string): string => NAMED.reduce((out, [path, word]) => out.replaceAll(path, word), text)
export const fill = (text: string): string =>
  text.replaceAll('<HOME>', OWN_HOME).replaceAll('<USER>', FAKE_USER).replaceAll('<CONFIG>', CONFIG_HOME).replaceAll('<PROJECT>', PROJECT).replaceAll('<DAEMON_PID>', String(DAEMON_PID)).replaceAll('<OWN_PID>', String(process.pid))
export const shown = (text: string): string => JSON.stringify(named(text).replaceAll(String(DAEMON_PID), '<daemon pid>'))
export const said = (decision: Decision): string => `${decision.behavior}${decision.message ? `: ${named(decision.message.replaceAll('\n', ' ')).slice(0, 160)}` : ''}`

let failures = 0
let checks = 0

export function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}

export function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}

export function note(text: string): void {
  console.log(`  [NOTE] ${text}`)
}

export function pageText(): string {
  return readFileSync(join(TREE, 'docs', 'TRUST.md'), 'utf8').replace(/\s+/g, ' ')
}

export function sourceText(relativePath: string): string {
  return readFileSync(join(TREE, relativePath), 'utf8')
}

export function finish(name: string): never {
  console.log(`\n${name}: ${checks} checks, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}
