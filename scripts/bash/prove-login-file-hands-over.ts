#!/usr/bin/env bun
import { plugin } from 'bun'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Ran = { code: number; ms: number; text: string }
type Said = { status: string; evidence: string; fix?: string }
type Helpers = Record<string, { pid: number; alive: boolean }>
type Row = { first: Ran; second: Ran; carried: Ran; options: Ran; wiped: Ran; waitedOnAlive: boolean | null; helpers: Helpers; absence: string | null; snapshots: number; otherShellStarts: number; pathHead: string; described: { ms: number; text: string }; toolNeverStarted: string; toolFirst: string; toolSecond: string; said: Said | null; many: Ran; readWithNoProgram: string; helper: Ran; extglobOn: Ran }
type Asked = { said: Said | null; ms: number; limit: number | null; snapshotFolder: boolean; tempLeft: number; waitedOnAlive: boolean | null; otherShellStarts: number }
type First = { withoutBash: number; begunMs: number | null; startsInAll: number; described: string }
type Listed = { drawnOnAScreen: boolean; offeredWithout: boolean; withoutBash: number; offeredWith: boolean; beforeAnyRequest: number; runsInAll: number; described: string }
type Lines = { beforeAnyToolList: number; offered: boolean; saw: string[]; described: string }

function waitedOn(home: string): boolean | null {
  if (!existsSync(join(home, 'waited-on.pid'))) return null
  const pid = Number(readFileSync(join(home, 'waited-on.pid'), 'utf8').trim())
  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

function helpers(home: string): Helpers {
  const found: Helpers = {}
  for (const name of readdirSync(home)) {
    if (!name.endsWith('.helper')) continue
    const pid = Number(readFileSync(join(home, name), 'utf8').trim())
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    found[name.slice(0, -'.helper'.length)] = { pid, alive }
  }
  return found
}

async function helpersAfter(home: string, waitMs: number): Promise<Helpers> {
  const began = Date.now()
  while (Object.values(helpers(home)).some(helper => helper.alive) && Date.now() - began < waitMs) await new Promise(done => setTimeout(done, 25))
  return helpers(home)
}

function otherShellStarts(home: string): number {
  const marker = join(home, 'other-shell-was-started')
  return existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0
}

if (process.argv.includes('--row')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  plugin({
    name: 'stub-color-diff-napi',
    setup(build) {
      build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
    },
  })
  const home = homedir()
  const { exec, setCwd } = await import('../../src/platform/shell/shellExec.ts')
  const record = await import('../../src/platform/shell/shellRecord.ts')
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { formatError } = await import('../../src/tools/kit/toolErrors.ts')
  setCwd(home)
  let appState = getDefaultAppState()
  const toolContext = {
    options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
    abortController: new AbortController(),
    toolUseId: 'login-file-call',
  } as never
  const asTool = async (command: string, cwd?: string): Promise<string> => {
    try {
      const result = await BashTool.call({ command, ...(cwd === undefined ? {} : { cwd }) }, toolContext)
      return String(BashTool.mapToolResultToToolResultBlockParam(result.data, 'x').content)
    } catch (error) {
      return `threw: ${formatError(error)}`
    }
  }
  const run = async (command: string): Promise<Ran> => {
    const started = Date.now()
    const handle = await exec(command, new AbortController().signal, 'bash', { timeout: 60_000 })
    const result = await handle.result
    return { code: result.code, ms: Date.now() - started, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
  }
  const describeStarted = Date.now()
  const description = await BashTool.prompt({ tools: [] } as never)
  const described = { ms: Date.now() - describeStarted, text: description.split('\n\n').find(part => part.startsWith('In the main conversation')) ?? '' }
  const first = await run('echo "ran: bash=${BASH_VERSION:-no} zsh=${ZSH_VERSION:-no} path-head=${PATH%%:*}"')
  const waitedOnAlive = waitedOn(home)
  const helpersLeft = await helpersAfter(home, 1_000)
  const second = await run('echo second-ran')
  const carried = await run('alias ll 2>/dev/null; myfunc 2>/dev/null; above_guard 2>/dev/null; true')
  const options = await run(`set -o | awk '$1 == "braceexpand" || $1 == "monitor" || $1 == "noclobber" || $1 == "onecmd" { printf "%s=%s ", $1, $2 }'`)
  const many = await run('fn_0 2>&1; fn_299 2>&1; declare -F | grep -c "^declare -f fn_"')
  const helper = await run('calls_helper 2>&1; declare -F uses_extglob > /dev/null && echo extglob-fn-is-defined; uses_extglob aab 2>&1; shopt -p extglob')
  const extglobOn = await run('shopt -s extglob\nuses_extglob aab 2>&1')
  const wiped = await run('echo wiped; rm -f "$TMPDIR"/mercury-cwd-*; exit 0')
  const toolNeverStarted = await asTool('echo never-started', join(home, 'a-folder-that-is-not-there'))
  const toolFirst = await asTool('echo tool-first')
  const toolSecond = await asTool('echo tool-second')
  const said = await record.shellRow().catch(() => null)
  const snapshots = join(process.env.MERCURY_CONFIG_DIR ?? '', 'shell-snapshots')
  const taken = existsSync(snapshots) ? readdirSync(snapshots)[0] : undefined
  const readWithNoProgram =
    taken === undefined
      ? 'no snapshot'
      : `${spawnSync((await record.systemShellRecord()).path, ['-c', 'source "$1"; n=0; while read -r _ _ name; do case "$name" in fn_*) n=$((n+1)) ;; esac; done < <(declare -F); echo "$n"', '_', join(snapshots, taken)], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: home } }).stdout}`.trim()
  const row: Row = {
    first,
    second,
    carried,
    options,
    wiped,
    waitedOnAlive,
    helpers: helpersLeft,
    absence: record.loginFilesNotCarried()?.why ?? null,
    snapshots: existsSync(snapshots) ? readdirSync(snapshots).length : 0,
    otherShellStarts: otherShellStarts(home),
    pathHead: (process.env.PATH ?? '').split(':')[0] ?? '',
    described,
    toolNeverStarted,
    toolFirst,
    toolSecond,
    said,
    many,
    readWithNoProgram,
    helper,
    extglobOn,
  }
  console.log(`ROW ${JSON.stringify(row)}`)
  process.exit(0)
}

if (process.argv.includes('--asked-alone')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const home = homedir()
  const { beginReadOnlyDiagnostic } = await import('../../src/platform/logs/diagnosticReadOnly.ts')
  beginReadOnlyDiagnostic(process.argv.includes('--another-row-asked') ? 'runtime' : undefined)
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const spec = runtimeChecks().find(row => row.id === 'shell')
  const started = Date.now()
  const said = spec === undefined ? null : ((await spec.run()) as Said)
  const asked: Asked = {
    said,
    ms: Date.now() - started,
    limit: spec?.timeoutMs ?? null,
    snapshotFolder: existsSync(join(process.env.MERCURY_CONFIG_DIR ?? '', 'shell-snapshots')),
    tempLeft: readdirSync(tmpdir()).filter(name => name.startsWith('mercury-login-run-')).length,
    waitedOnAlive: waitedOn(home),
    otherShellStarts: otherShellStarts(home),
  }
  console.log(`ASKED ${JSON.stringify(asked)}`)
  process.exit(0)
}

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

if (process.argv.includes('--first-prompt')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  plugin({
    name: 'stub-color-diff-napi',
    setup(build) {
      build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
    },
  })
  const home = homedir()
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  await getSystemPrompt([{ name: 'Read' }] as never, 'claude-opus-4-8')
  await pause(1_500)
  const withoutBash = otherShellStarts(home)
  await getSystemPrompt([BashTool] as never, 'claude-opus-4-8')
  const began = Date.now()
  let begunMs: number | null = null
  while (begunMs === null && Date.now() - began < 5_000) {
    if (otherShellStarts(home) > 0) begunMs = Date.now() - began
    else await pause(25)
  }
  const description = await BashTool.prompt({ tools: [] } as never)
  const first: First = { withoutBash, begunMs, startsInAll: otherShellStarts(home), described: description.split('\n\n').find(part => part.startsWith('In the main conversation')) ?? '' }
  console.log(`FIRST ${JSON.stringify(first)}`)
  process.exit(0)
}

if (process.argv.includes('--tool-list')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  plugin({
    name: 'stub-color-diff-napi',
    setup(build) {
      build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
    },
  })
  const home = homedir()
  const runs = (): number => (existsSync(join(home, 'login-runs')) ? readFileSync(join(home, 'login-runs'), 'utf8').trim().split('\n').length : 0)
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { getTools } = await import('../../src/tools/kit/toolList.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
  const empty = getEmptyToolPermissionContext()
  setIsInteractive(true)
  const drawn = getTools(empty)
  setIsInteractive(false)
  const without = getTools({ ...empty, baseTools: ['Read'] })
  await pause(1_500)
  const withoutBash = runs()
  const withBash = getTools(empty)
  const began = Date.now()
  while (runs() === 0 && Date.now() - began < 8_000) await pause(25)
  const beforeAnyRequest = runs()
  await getSystemPrompt([BashTool] as never, 'claude-opus-4-8')
  const description = await BashTool.prompt({ tools: [] } as never)
  const listed: Listed = {
    drawnOnAScreen: drawn.some(tool => tool.name === 'Bash'),
    offeredWithout: without.some(tool => tool.name === 'Bash'),
    withoutBash,
    offeredWith: withBash.some(tool => tool.name === 'Bash'),
    beforeAnyRequest,
    runsInAll: runs(),
    described: description.split('\n\n').find(part => part.startsWith('In the main conversation')) ?? '',
  }
  console.log(`LIST ${JSON.stringify(listed)}`)
  process.exit(0)
}

if (process.argv.includes('--first-lines')) {
  const kind = process.argv[process.argv.indexOf('--first-lines') + 1] ?? ''
  const ARGUMENTS: Record<string, string[]> = {
    run: ['run', '--format', 'text', 'say hi'],
    runner: ['runner', '--model', 'claude-opus-4-8'],
    screen: [],
    toolset: ['run', '--toolset', 'Read', 'Edit', '--', 'say hi'],
    blocked: ['run', '--block-tools', 'Bash', '--', 'say hi'],
    pending: ['run', '--format', 'text', 'say hi'],
    'ends-early': ['run', '--format', 'text', 'say hi'],
  }
  process.argv = [process.argv[0]!, 'mercury', ...(ARGUMENTS[kind] ?? [])]
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  plugin({
    name: 'stub-color-diff-napi',
    setup(build) {
      build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
    },
  })
  const home = homedir()
  const runs = (): string[] => (existsSync(join(home, 'login-runs')) ? readFileSync(join(home, 'login-runs'), 'utf8').trim().split('\n') : [])
  const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
  setIsInteractive(kind === 'screen')
  const { init } = await import('../../src/boot/entrypoints/init.ts')
  await init()
  if (kind === 'ends-early') {
    const began = Date.now()
    while (!existsSync(join(home, 'waited-on.pid')) && Date.now() - began < 8_000) await pause(25)
    console.log(`EARLY ${JSON.stringify({ started: existsSync(join(home, 'waited-on.pid')) })}`)
    process.exit(0)
  }
  const early = kind === 'run' || kind === 'runner'
  const began = Date.now()
  while (early && runs().length === 0 && Date.now() - began < 8_000) await pause(25)
  if (!early) await pause(1_500)
  const beforeAnyToolList = runs().length
  const { getTools } = await import('../../src/tools/kit/toolList.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const empty = getEmptyToolPermissionContext()
  if (kind === 'pending') {
    const { getInitialSettings } = await import('../../src/platform/settings/settings.ts')
    for (const [key, value] of Object.entries(getInitialSettings().environment?.values ?? {})) process.env[key] = String(value)
  }
  const list = getTools(kind === 'toolset' ? { ...empty, baseTools: ['Read', 'Edit'] } : kind === 'blocked' ? { ...empty, alwaysDenyRules: { ...empty.alwaysDenyRules, cliArg: ['Bash'] } } : empty)
  const offered = list.some(tool => tool.name === 'Bash')
  let described = ''
  if (offered && kind !== 'screen') {
    await getSystemPrompt([BashTool] as never, 'claude-opus-4-8')
    described = (await BashTool.prompt({ tools: [] } as never)).split('\n\n').find(part => part.startsWith('In the main conversation')) ?? ''
  } else {
    await pause(1_500)
  }
  const lines: Lines = { beforeAnyToolList, offered, saw: runs(), described }
  console.log(`LINES ${JSON.stringify(lines)}`)
  process.exit(0)
}

if (process.argv.includes('--ends-early')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  plugin({
    name: 'stub-color-diff-napi',
    setup(build) {
      build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
    },
  })
  const home = homedir()
  if (process.argv.includes('--stays')) process.on('SIGQUIT', () => { if (process.listenerCount('SIGQUIT') === 1) process.exit(131) })
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  if (process.argv.includes('--by-the-tool-list')) {
    const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
    enableConfigs()
    const { getTools } = await import('../../src/tools/kit/toolList.ts')
    const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
    getTools(getEmptyToolPermissionContext())
  } else {
    void BashTool.prompt({ tools: [] } as never)
  }
  const began = Date.now()
  while (!existsSync(join(home, 'waited-on.pid')) && Date.now() - began < 8_000) await pause(25)
  console.log(`EARLY ${JSON.stringify({ started: existsSync(join(home, 'waited-on.pid')) })}`)
  if (process.argv.includes('--stays')) await pause(20_000)
  process.exit(0)
}

if (process.argv.includes('--start-up-files')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { checkPathSafetyForAutoEdit } = await import('../../src/permissions/rules/filesystem.ts')
  const home = homedir()
  const asked = Object.fromEntries(['.bash_profile', '.bash_login', '.profile', '.bashrc', 'notes.txt'].map(name => [name, checkPathSafetyForAutoEdit(join(home, name)).safe === false]))
  console.log(`FILES ${JSON.stringify(asked)}`)
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' A bash login file that hands the shell over, exits, reads or waits: every command still runs')
console.log('============================================================')

if (process.platform === 'win32') {
  console.log('  [SKIP] this proof drives the macOS and Linux road; the Windows road has its own proofs')
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'login-file-hands-over-')))
const ZSH = '/bin/zsh'
const realZsh = existsSync(ZSH)
const readsByZsh = realZsh ? 1 : 0

function home(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name)
  mkdirSync(dir)
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

const standIn = join(scratch, 'other-shell')
writeFileSync(standIn, '#!/bin/sh\necho started >> "$HOME/other-shell-was-started"\ncat > /dev/null\n')
chmodSync(standIn, 0o755)
const other = realZsh ? ZSH : standIn

const HANDS_OVER = {
  '.bash_profile': `export SHELL=${other}\n[ -z "$ZSH_VERSION" ] && exec "$SHELL" -l\n`,
  '.zshenv': 'echo started >> "$HOME/other-shell-was-started"\n',
}
const WAITS = { '.bash_profile': 'sh -c \'echo $$ > "$HOME/waited-on.pid"; exec sleep 600\'\n' }
const DEFINES = { '.bash_profile': 'alias ll="ls -la"\nmyfunc() { echo fn-from-the-login-file; }\nset -o noclobber\n' }

const AGENT = join(scratch, 'agent-stand-in.mjs')
writeFileSync(AGENT, "import { spawn } from 'node:child_process'\nconst agent = spawn('/bin/sleep', [process.argv[2]], { detached: true, stdio: 'ignore' })\nagent.unref()\nconsole.log(`SSH_AGENT_PID=${agent.pid}; export SSH_AGENT_PID;`)\n")
const STARTS_HELPERS = {
  '.bash_profile': [
    'sleep 47101 &',
    'echo $! > "$HOME/plain-job.helper"',
    'nohup sleep 47102 >/dev/null 2>&1 &',
    'echo $! > "$HOME/nohup-job.helper"',
    `eval "$('${process.execPath}' '${AGENT}' 47103)"`,
    'echo "$SSH_AGENT_PID" > "$HOME/agent.helper"',
    'myfunc() { echo fn-from-the-login-file; }',
    '',
  ].join('\n'),
}
const agentFromBefore = Number(/SSH_AGENT_PID=(\d+);/.exec(spawnSync(process.execPath, [AGENT, '47104'], { encoding: 'utf8' }).stdout)?.[1])
const EXPORTS_THE_AGENT_FROM_BEFORE = { '.bash_profile': `export SSH_AGENT_PID=${agentFromBefore}\necho "$SSH_AGENT_PID" > "$HOME/agent.helper"\nmyfunc() { echo fn-from-the-login-file; }\n` }
const A_SECOND_AND_MORE = 1_100

const HOMES: Record<string, { dir: string; env?: Record<string, string>; after?: number }> = {
  'hands-over': { dir: home('hands-over', HANDS_OVER) },
  exits: { dir: home('exits', { '.bash_profile': 'exit 0\n' }) },
  'reads-stdin': { dir: home('reads-stdin', { '.bash_profile': 'read -r answer\necho "got:$answer"\n' }) },
  slow: { dir: home('slow', WAITS) },
  'prints-at-length': { dir: home('prints-at-length', { '.bash_profile': 'head -c 2200000 /dev/zero | tr "\\0" x\n' }) },
  'no-snapshot-folder': { dir: home('no-snapshot-folder', {}) },
  'unsets-path': { dir: home('unsets-path', { '.bash_profile': 'alias ll="ls -la"\nmyfunc() { echo fn-from-the-login-file; }\nunset PATH\n' }) },
  'ends-unread': {
    dir: home('ends-unread', { '.bashenv': 'case "$BASH_EXECUTION_STRING" in *mercury-cwd-*) exit 0 ;; esac\n' }),
  },
  'login-file-only': { dir: home('login-file-only', DEFINES) },
  'starts-helpers': { dir: home('starts-helpers', STARTS_HELPERS) },
  'agent-from-before': { dir: home('agent-from-before', EXPORTS_THE_AGENT_FROM_BEFORE), after: A_SECOND_AND_MORE },
  'what-is-carried': {
    dir: home('what-is-carried', {
      '.bash_profile': 'shopt -s extglob\n_helper() { echo helper-ran; }\ncalls_helper() { _helper; }\nuses_extglob() { case "$1" in +(a|b)) echo extglob-fn-matched;; *) echo extglob-fn-no-match;; esac; }\nalias ll="ls -la"\n',
    }),
  },
  'engine-armed': { dir: home('engine-armed', { '.profile': 'alias ll="ls -la"\nmyfunc() { echo fn-from-the-login-file; }\n' }), env: { MERCURY_SHELL_ENGINE: 'brush' } },
  'engine-armed-bash-env': { dir: home('engine-armed-bash-env', { '.profile': 'alias ll="ls -la"\nmyfunc() { echo fn-from-the-login-file; }\n', '.bashenv': 'export FROM_BASH_ENV=1\n' }) },
  'posix-mode': { dir: home('posix-mode', { '.bash_profile': 'alias ll="ls -la"\nmyfunc() { echo fn-from-the-login-file; }\nset -o posix\n' }) },
  'many-functions': { dir: home('many-functions', { '.bash_profile': `${Array.from({ length: 300 }, (_, index) => `fn_${index}() { echo ${index}; }`).join('\n')}\n` }) },
  'guarded-bashrc': {
    dir: home('guarded-bashrc', {
      '.profile': 'if [ -n "$BASH_VERSION" ]; then\n  if [ -f "$HOME/.bashrc" ]; then\n    . "$HOME/.bashrc"\n  fi\nfi\n',
      '.bashrc': 'above_guard() { echo fn-above-the-guard; }\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\nalias ll="ls -la"\nmyfunc() { echo fn-below-the-guard; }\n',
    }),
  },
}
HOMES['ends-unread']!.env = { BASH_ENV: join(HOMES['ends-unread']!.dir, '.bashenv') }
HOMES['engine-armed-bash-env']!.env = { MERCURY_SHELL_ENGINE: 'brush', BASH_ENV: join(HOMES['engine-armed-bash-env']!.dir, '.bashenv') }
const locked = join(HOMES['no-snapshot-folder']!.dir, 'locked')
mkdirSync(locked, { mode: 0o555 })
HOMES['no-snapshot-folder']!.env = { MERCURY_CONFIG_DIR: join(locked, 'config-home') }
const isRoot = process.getuid?.() === 0
const ALONE: Record<string, string> = {
  'hands-over': home('alone-hands-over', HANDS_OVER),
  slow: home('alone-slow', WAITS),
  'login-file-only': home('alone-login-file-only', DEFINES),
}
const ANOTHER_ROW = home('alone-another-row-asked', HANDS_OVER)
const FIRST_PROMPT = home('first-prompt', HANDS_OVER)
const ENDS_EARLY = home('ends-early', WAITS)
const ENDS_EARLY_LISTED = home('ends-early-by-the-tool-list', WAITS)
const TOOL_LIST = home('tool-list', { '.bash_profile': 'echo run >> "$HOME/login-runs"\nmyfunc() { echo fn-from-the-login-file; }\n' })
const FIRST_LINES_KINDS = ['run', 'runner', 'screen', 'toolset', 'blocked', 'pending']
const FIRST_LINES: Record<string, string> = Object.fromEntries(
  FIRST_LINES_KINDS.map(kind => [kind, home(`first-lines-${kind}`, { '.bash_profile': 'echo "run:${ANTHROPIC_BASE_URL:-unset}" >> "$HOME/login-runs"\nmyfunc() { echo fn-from-the-login-file; }\n' })]),
)
const ENDS_EARLY_FIRST = home('ends-early-by-the-first-lines', WAITS)
const QUITS = home('quits-in-flight', { '.bash_profile': 'echo $$ > "$HOME/login-shell.helper"\nsh -c \'echo $$ > "$HOME/waited-on.helper"; echo $$ > "$HOME/waited-on.pid"; exec sleep 47105\'\n' })
const projectOf = (dir: string): string => join(dir, 'project')
for (const dir of [...Object.values(FIRST_LINES), ENDS_EARLY_FIRST]) mkdirSync(projectOf(dir))
const HOST_MANAGED_VALUE = 'http://127.0.0.1:9/named-by-the-settings'
mkdirSync(join(FIRST_LINES.pending!, 'config-home'))
writeFileSync(join(FIRST_LINES.pending!, 'config-home', 'settings.json'), JSON.stringify({ environment: { values: { ANTHROPIC_BASE_URL: HOST_MANAGED_VALUE } } }))

function drive<T>(dir: string, mode: string, mark: string, env: Record<string, string> = {}, cwd?: string, heard?: (child: ChildProcess, said: string) => void): Promise<{ row: T | null; said: string; exit: number | null }> {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(?:BASH_ENV|ENV|MERCURY_SHELL_PREFIX|MERCURY_SHELL_ENGINE|MERCURY_WINDOWS_SHELL_ROAD)$/.test(key)) continue
    childEnv[key] = value
  }
  mkdirSync(join(dir, 'temp'))
  Object.assign(childEnv, { HOME: dir, SHELL: ZSH, MERCURY_CONFIG_DIR: join(dir, 'config-home'), TMPDIR: join(dir, 'temp') }, env)
  return new Promise(done => {
    const child = spawn(process.execPath, [import.meta.path, ...mode.split(' ')], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd === undefined ? {} : { cwd }) })
    let said = ''
    child.stdout.on('data', chunk => {
      said += String(chunk)
      heard?.(child, said)
    })
    child.stderr.on('data', chunk => { said += String(chunk) })
    child.once('close', code => {
      const line = said.split('\n').find(text => text.startsWith(mark))
      done({ row: line === undefined ? null : (JSON.parse(line.slice(mark.length)) as T), said: said.slice(-400), exit: code })
    })
  })
}

async function quitInFlight(dir: string): Promise<{ started: boolean; said: string; left: Helpers; exit: number | null }> {
  let quitAt = 0
  const ended = await drive<{ started: boolean }>(dir, '--ends-early --stays', 'EARLY ', {}, undefined, (child, said) => {
    if (quitAt !== 0 || !said.includes('EARLY ')) return
    quitAt = Date.now()
    child.kill('SIGQUIT')
  })
  return { started: ended.row?.started === true && quitAt !== 0, said: ended.said, left: await helpersAfter(dir, Math.max(0, 1_000 - (Date.now() - quitAt))), exit: ended.exit }
}

const FAST_MS = 8_000
const BOUND_MS = 10_000

try {
  const names = Object.keys(HOMES)
  const aloneNames = Object.keys(ALONE)
  const [answers, alone, anotherRow, firstPrompt, endsEarly, endsEarlyListed, toolList, firstLines, endsEarlyFirst, quit] = await Promise.all([
    Promise.all(names.map(name => pause(HOMES[name]!.after ?? 0).then(() => drive<Row>(HOMES[name]!.dir, '--row', 'ROW ', HOMES[name]!.env)))),
    Promise.all(aloneNames.map(name => drive<Asked>(ALONE[name]!, '--asked-alone', 'ASKED '))),
    drive<Asked>(ANOTHER_ROW, '--asked-alone --another-row-asked', 'ASKED '),
    drive<First>(FIRST_PROMPT, '--first-prompt', 'FIRST '),
    drive<{ started: boolean }>(ENDS_EARLY, '--ends-early', 'EARLY '),
    drive<{ started: boolean }>(ENDS_EARLY_LISTED, '--ends-early --by-the-tool-list', 'EARLY '),
    drive<Listed>(TOOL_LIST, '--tool-list', 'LIST '),
    Promise.all(FIRST_LINES_KINDS.map(kind => drive<Lines>(FIRST_LINES[kind]!, `--first-lines ${kind}`, 'LINES ', kind === 'pending' ? { MERCURY_PROVIDER_MANAGED_BY_HOST: '1' } : {}, projectOf(FIRST_LINES[kind]!)))),
    drive<{ started: boolean }>(ENDS_EARLY_FIRST, '--first-lines ends-early', 'EARLY ', {}, projectOf(ENDS_EARLY_FIRST)),
    quitInFlight(QUITS),
  ])
  const leftByTheEarlyEnd = waitedOn(ENDS_EARLY)
  const leftByTheEarlyEndListed = waitedOn(ENDS_EARLY_LISTED)
  const leftByTheEarlyEndFirst = waitedOn(ENDS_EARLY_FIRST)
  const linesOf = (kind: string): Lines | null => firstLines[FIRST_LINES_KINDS.indexOf(kind)]!.row
  const shownLines = (...kinds: string[]): string => JSON.stringify(kinds.map(kind => firstLines[FIRST_LINES_KINDS.indexOf(kind)]!.row ?? firstLines[FIRST_LINES_KINDS.indexOf(kind)]!.said)).slice(0, 1_100)
  const of = (name: string): { row: Row | null; said: string } => answers[names.indexOf(name)]!
  const ranInBash = (ran: Ran | undefined): boolean => ran !== undefined && ran.code === 0 && /ran: bash=\d/.test(ran.text) && ran.text.includes('zsh=no')
  const told = (name: string): string => JSON.stringify(of(name).row ?? of(name).said).slice(0, 700)
  const waited = (row: Row): number => row.described.ms + row.first.ms

  for (const name of ['hands-over', 'exits', 'reads-stdin', 'slow']) {
    const row = of(name).row
    check(`${name}: the first command runs in bash and prints`, ranInBash(row?.first), told(name))
    check(`${name}: the second command runs at once`, row?.second.code === 0 && row.second.text === 'second-ran' && row.second.ms < FAST_MS, told(name))
    check(`${name}: no command reads the login file — PATH is the launcher's, first folder first, and nothing the file prints is in the output`, row !== null && row.first.text.includes(`path-head=${row.pathHead}`) && !row.first.text.includes('got:') && !row.second.text.includes('got:'), told(name))
  }

  const handsOver = of('hands-over').row
  check('hands-over: neither the description nor the first command waits for the other shell', handsOver !== null && waited(handsOver) < FAST_MS, told('hands-over'))
  check(
    `hands-over: the user's own file started ${realZsh ? 'zsh' : 'the other shell'} once, in the one login run${realZsh ? ', Mercury started it once more to read what its files export' : ''}, and no command started it again`,
    handsOver !== null && handsOver.otherShellStarts === 1 + readsByZsh,
    told('hands-over'),
  )
  check('hands-over: no snapshot stands, and the record of why says a login file ended the shell or handed it over', handsOver !== null && handsOver.snapshots === 0 && /a login file ended the shell or handed it to another program/.test(handsOver.absence ?? ''), told('hands-over'))

  const exits = of('exits').row
  check('exits: neither the description nor the first command waits', exits !== null && waited(exits) < FAST_MS, told('exits'))
  check('exits: no snapshot stands, and the record of why says a login file ended the shell or handed it over', exits !== null && exits.snapshots === 0 && /a login file ended the shell or handed it to another program/.test(exits.absence ?? ''), told('exits'))

  const reads = of('reads-stdin').row
  check('reads-stdin: the login run finds its standard input closed, so neither the description nor the first command waits', reads !== null && waited(reads) < FAST_MS, told('reads-stdin'))
  check('reads-stdin: the snapshot is taken', reads !== null && reads.snapshots === 1 && reads.absence === null, told('reads-stdin'))

  const slow = of('slow').row
  check(
    `slow: the login run is ended at its bound of ${BOUND_MS / 1000} s, so a session waits that long once and no longer`,
    slow !== null && waited(slow) >= BOUND_MS - 1_000 && waited(slow) < BOUND_MS + FAST_MS,
    told('slow'),
  )
  check('slow: no snapshot stands, and the record of why says the login run was killed at the bound', slow !== null && slow.snapshots === 0 && /did not end within 10 s and was killed/.test(slow.absence ?? ''), told('slow'))
  check('slow: what the login file was waiting on ends with the login run — it is not alive when the first command has returned', slow !== null && slow.waitedOnAlive === false, told('slow'))

  const prints = of('prints-at-length').row
  check(
    'prints-at-length: a login file that prints past 1 MiB is ended there, commands run, and the record of why names the limit',
    ranInBash(prints?.first) && prints !== null && prints.first.ms < FAST_MS && /printed more than 1 MiB and was ended/.test(prints.absence ?? ''),
    told('prints-at-length'),
  )
  const noFolder = of('no-snapshot-folder').row
  if (isRoot) console.log('  [SKIP] no-snapshot-folder: this run is root, and no folder refuses root')
  else {
    check(
      'no-snapshot-folder: with a config home that cannot be made commands run, and the record of why says the folder could not be made and that no login run was tried',
      ranInBash(noFolder?.first) && /^the folder .* could not be made \(.*\), so no login run was tried$/.test(noFolder?.absence ?? ''),
      told('no-snapshot-folder'),
    )
  }

  const loginOnly = of('login-file-only').row
  check(
    'login-file-only: what ~/.bash_profile defines is carried to a command though no ~/.bashrc exists — its alias and its function',
    loginOnly !== null && loginOnly.carried.text.includes("alias ll='ls -la'") && loginOnly.carried.text.includes('fn-from-the-login-file') && loginOnly.snapshots === 1,
    told('login-file-only'),
  )
  const startsHelpers = of('starts-helpers').row
  check(
    'starts-helpers: what the login file started is ended with the login run — its background job, its nohup job and the agent it started and exports in SSH_AGENT_PID are gone when the first command has returned, and what the file defines is carried',
    startsHelpers !== null && ['plain-job', 'nohup-job', 'agent'].every(name => (startsHelpers.helpers[name]?.pid ?? 0) > 1 && startsHelpers.helpers[name]?.alive === false) && startsHelpers.carried.text.includes('fn-from-the-login-file'),
    JSON.stringify(startsHelpers === null ? of('starts-helpers').said : { helpers: startsHelpers.helpers, carried: startsHelpers.carried }).slice(0, 700),
  )
  const agentBefore = of('agent-from-before').row
  check(
    'agent-from-before: an agent that was alive before the login run, whose pid the login file exports in SSH_AGENT_PID, is alive after it, and what the file defines is carried',
    agentBefore !== null && agentFromBefore > 1 && agentBefore.helpers.agent?.pid === agentFromBefore && agentBefore.helpers.agent.alive === true && agentBefore.carried.text.includes('fn-from-the-login-file'),
    JSON.stringify(agentBefore === null ? of('agent-from-before').said : { started: agentFromBefore, helpers: agentBefore.helpers, carried: agentBefore.carried }).slice(0, 700),
  )
  const manyFunctions = of('many-functions').row
  check(
    'many-functions: all 300 functions of the login file are carried to a command',
    manyFunctions !== null && manyFunctions.many.text === '0\n299\n300',
    JSON.stringify(manyFunctions?.many),
  )
  check(
    'many-functions: a command that reads what is carried starts no program for it — the file read with no program on PATH defines all 300',
    manyFunctions !== null && manyFunctions.readWithNoProgram === '300',
    JSON.stringify(manyFunctions?.readWithNoProgram),
  )
  check(
    'many-functions: 300 carried functions do not slow a command — its second command starts within 300 ms of the same command where three things are carried',
    manyFunctions !== null && loginOnly !== null && manyFunctions.second.ms - loginOnly.second.ms < 300,
    `${manyFunctions?.second.ms} ms with 300 functions, ${loginOnly?.second.ms} ms with one`,
  )
  const whatIsCarried = of('what-is-carried').row
  const said4 = (whatIsCarried?.helper.text ?? '').split('\n')
  check(
    'what-is-carried: a function whose name begins with an underscore is carried, so the function that calls it works',
    said4[0] === 'helper-ran',
    JSON.stringify(whatIsCarried?.helper),
  )
  check(
    'what-is-carried: a function whose body holds an extended glob is carried, and extglob is off when a command starts though the login file switched it on: the pattern does not match there',
    said4[1] === 'extglob-fn-is-defined' && said4[2] === 'extglob-fn-no-match' && said4[3] === 'shopt -u extglob',
    JSON.stringify(whatIsCarried?.helper),
  )
  check(
    'what-is-carried: the same function matches in a command that switches extglob on before it calls it',
    whatIsCarried !== null && whatIsCarried.extglobOn.text === 'extglob-fn-matched',
    JSON.stringify(whatIsCarried?.extglobOn),
  )
  const engineArmed = of('engine-armed').row
  const engineWithBashEnv = of('engine-armed-bash-env').row
  if (!/^brush /.test(engineArmed?.said?.evidence ?? '')) console.log('  [SKIP] engine-armed: the bundled engine does not serve here (its pack is absent), so its login run is not driven')
  else {
    check(
      'engine-armed: under the bundled engine what ~/.profile defines is carried to a command, its alias and its function',
      engineArmed !== null && engineArmed.carried.text.includes("alias ll='ls -la'") && engineArmed.carried.text.includes('fn-from-the-login-file'),
      JSON.stringify(engineArmed?.carried),
    )
    check(
      'engine-armed: a command there runs with job control off, and onecmd off: the options carried are those that are on',
      engineArmed?.options.text === 'braceexpand=on monitor=off noclobber=off onecmd=off',
      JSON.stringify(engineArmed?.options),
    )
    check(
      'engine-armed-bash-env: with BASH_ENV set where Mercury was started the engine still takes its login run, and commands run with what ~/.profile defines',
      engineWithBashEnv !== null && engineWithBashEnv.first.code === 0 && engineWithBashEnv.carried.text.includes("alias ll='ls -la'") && engineWithBashEnv.carried.text.includes('fn-from-the-login-file'),
      JSON.stringify({ first: engineWithBashEnv?.first, carried: engineWithBashEnv?.carried }),
    )
  }
  const posixMode = of('posix-mode').row
  check(
    'posix-mode: under set -o posix the alias is carried as an alias, with the function',
    posixMode !== null && posixMode.carried.text.includes("ll='ls -la'") && posixMode.carried.text.includes('fn-from-the-login-file'),
    JSON.stringify(posixMode?.carried),
  )
  const guarded = of('guarded-bashrc').row
  check(
    'guarded-bashrc: a ~/.bashrc that returns for a shell that is not interactive carries what stands above that line and nothing below it',
    guarded !== null && guarded.carried.text.includes('fn-above-the-guard') && !guarded.carried.text.includes('fn-below-the-guard') && !guarded.carried.text.includes('alias ll'),
    told('guarded-bashrc'),
  )

  check(
    'login-file-only: an option the login file switched on is on in a command, and an option that was off is off — job control (monitor) and onecmd among them, though both names hold the letters "on"',
    loginOnly?.options.text === 'braceexpand=on monitor=off noclobber=on onecmd=off',
    JSON.stringify(loginOnly?.options),
  )
  check(
    'guarded-bashrc: with a ~/.bashrc the same holds — a command runs with job control off',
    guarded?.options.text === 'braceexpand=on monitor=off noclobber=off onecmd=off',
    JSON.stringify(guarded?.options),
  )

  check(
    'a command that removes the file its directory is written to and ends the shell itself is still a command that ran: exit 0 and its output, with no word about an unread command',
    loginOnly !== null && loginOnly.wiped.code === 0 && loginOnly.wiped.text === 'wiped',
    JSON.stringify(loginOnly?.wiped),
  )

  const filesHome = home('start-up-files', {})
  const files = await new Promise<Record<string, boolean> | null>(done => {
    const child = spawn(process.execPath, [import.meta.path, '--start-up-files'], { env: { ...process.env, HOME: filesHome, MERCURY_CONFIG_DIR: join(filesHome, 'config-home') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''
    child.stdout.on('data', chunk => { said += String(chunk) })
    child.once('close', () => {
      const line = said.split('\n').find(text => text.startsWith('FILES '))
      done(line === undefined ? null : (JSON.parse(line.slice(6)) as Record<string, boolean>))
    })
  })
  check(
    'a write to any file bash reads at login is asked about: ~/.bash_profile, ~/.bash_login and ~/.profile, and ~/.bashrc with them; a plain file in the same folder is not',
    files !== null && files['.bash_profile'] === true && files['.bash_login'] === true && files['.profile'] === true && files['.bashrc'] === true && files['notes.txt'] === false,
    JSON.stringify(files),
  )

  const unread = of('ends-unread').row
  check(
    'ends-unread: a shell that ends before it reads the command is not an exit 0 with nothing — the result is an error that says so',
    unread !== null && unread.first.code !== 0 && /ended before it read this command/.test(unread.first.text) && !unread.first.text.includes('ran:') && unread.second.code !== 0 && /ended before it read this command/.test(unread.second.text),
    told('ends-unread'),
  )

  const LINE = 'Nothing your bash login files define is carried in this session: '
  const HANDED = /ended before it carried anything: a login file ended the shell or handed it to another program/
  const NOT_CARRIED: Array<[string, RegExp, RegExp]> = [
    ['hands-over', HANDED, /that ends the shell or starts another one \(`exec zsh -l`\) and run it only in an interactive shell/],
    ['exits', HANDED, /that ends the shell or starts another one \(`exec zsh -l`\) and run it only in an interactive shell/],
    ['slow', /did not end within 10 s and was killed: a login file waits or runs long/, /Find what waits in the files bash reads at login/],
    ['prints-at-length', /printed more than 1 MiB and was ended: a login file prints at length/, /Find what prints in the files bash reads at login/],
    ['unsets-path', /the login files leave PATH without awk, sed, head or cat, which the login run needs to carry anything/, /Keep \/usr\/bin and \/bin on PATH in the files bash reads at login/],
    ...(isRoot ? [] : ([['no-snapshot-folder', /could not be made \(.*\), so no login run was tried/, /or name another in MERCURY_CONFIG_DIR, then restart Mercury/]] as Array<[string, RegExp, RegExp]>)),
  ]
  for (const [name, why, change] of NOT_CARRIED) {
    const row = of(name).row
    const shown = JSON.stringify(row === null ? of(name).said : { described: row.described, toolFirst: row.toolFirst, toolSecond: row.toolSecond, said: row.said }).slice(0, 1800)
    check(
      `${name}: the Bash tool's description, composed before the first command, does not say a call starts from your profile; it says no call carries the profile's aliases, functions or options in this session`,
      row !== null && !row.described.text.includes('starts from your profile') && row.described.text.endsWith('and no call carries the aliases, functions or options of your profile (bash) in this session.'),
      shown,
    )
    check(
      `${name}: the first result of the Bash tool carries one line that says the login files are not carried, why, and what to change`,
      row !== null && row.toolFirst.includes('tool-first') && row.toolFirst.split('\n').filter(line => line.startsWith(LINE)).length === 1 && row.toolFirst.split(LINE).length === 2 && why.test(row.toolFirst) && change.test(row.toolFirst),
      shown,
    )
    check(`${name}: the second result does not carry it`, row !== null && row.toolSecond.includes('tool-second') && !/login files|login run/.test(row.toolSecond), shown)
    check(
      `${name}: a call before it that never started (its folder is not there) is an error without the line, and does not use the line up`,
      row !== null && row.toolNeverStarted.startsWith('threw:') && /does not exist/.test(row.toolNeverStarted) && !/login files|login run/.test(row.toolNeverStarted) && row.toolFirst.includes(LINE),
      JSON.stringify({ neverStarted: row?.toolNeverStarted, first: row?.toolFirst }).slice(0, 900),
    )
    check(
      `${name}: the health check's shell row, asked in the session, warns with the same reason, and its fix says what to change`,
      row !== null && row.said !== null && row.said.status === 'warn' && row.said.evidence.includes('nothing the bash login files define is carried: ') && why.test(row.said.evidence) && change.test(row.said.fix ?? ''),
      shown,
    )
  }
  for (const name of ['reads-stdin', 'login-file-only', 'guarded-bashrc']) {
    const row = of(name).row
    check(
      `${name}: where the login files are carried the description says each call starts from your profile, no result carries the line and the health row does not speak of login files`,
      row !== null && row.described.text.endsWith('and each call starts from your profile (bash).') && row.toolFirst.includes('tool-first') && !/login files|login run/.test(`${row.toolFirst}${row.toolSecond}`) && row.said !== null && !/login files|login run/.test(`${row.said.evidence}${row.said.fix ?? ''}`),
      JSON.stringify(row === null ? of(name).said : { described: row.described, toolFirst: row.toolFirst, toolSecond: row.toolSecond, said: row.said }).slice(0, 1800),
    )
  }
  check(
    'slow: the ten seconds are paid when the description is composed, so what it says is true before the first request, and the first command does not wait again',
    slow !== null && slow.described.ms >= BOUND_MS - 1_000 && slow.first.ms < FAST_MS,
    JSON.stringify({ described: slow?.described.ms, first: slow?.first.ms }),
  )

  const asked = (name: string): { row: Asked | null; said: string } => alone[aloneNames.indexOf(name)]!
  const shownAlone = (name: string): string => JSON.stringify(asked(name).row ?? asked(name).said).slice(0, 1400)
  const aloneHandsOver = asked('hands-over').row
  check(
    `asked with no session, hands-over: the health check takes one login run of its own${realZsh ? ' and one read of what the zsh files export' : ''}, and its shell row warns with the reason and what to change`,
    aloneHandsOver !== null && aloneHandsOver.said !== null && aloneHandsOver.said.status === 'warn' && HANDED.test(aloneHandsOver.said.evidence) && /run it only in an interactive shell/.test(aloneHandsOver.said.fix ?? '') && aloneHandsOver.otherShellStarts === 1 + readsByZsh,
    shownAlone('hands-over'),
  )
  const aloneSlow = asked('slow').row
  check(
    `asked with no session, slow: the row has a limit of its own above the ${BOUND_MS / 1000} s a login run may take, so it names the reason where the default limit of 10 s would read unknown`,
    aloneSlow !== null && aloneSlow.limit !== null && aloneSlow.limit > BOUND_MS + 1_000 && aloneSlow.ms < aloneSlow.limit && aloneSlow.said !== null && aloneSlow.said.status === 'warn' && /did not end within 10 s and was killed/.test(aloneSlow.said.evidence),
    shownAlone('slow'),
  )
  check('asked with no session, slow: what the login file was waiting on is ended with that login run', aloneSlow !== null && aloneSlow.waitedOnAlive === false, shownAlone('slow'))
  const aloneFine = asked('login-file-only').row
  check(
    'asked with no session, login-file-only: where the login files are carried the row does not speak of them',
    aloneFine !== null && aloneFine.said !== null && /Bash tool runs under it/.test(aloneFine.said.evidence) && !/login files|login run/.test(`${aloneFine.said.evidence}${aloneFine.said.fix ?? ''}`),
    shownAlone('login-file-only'),
  )
  for (const name of aloneNames) {
    const row = asked(name).row
    check(`asked with no session, ${name}: a health check writes nothing for it — no snapshot folder in the config home and nothing left in the temp folder`, row !== null && !row.snapshotFolder && row.tempLeft === 0, shownAlone(name))
  }
  check(
    'asked with no session for another row alone (health --only): no login shell is started, and nothing is written',
    anotherRow.row !== null && anotherRow.row.otherShellStarts === 0 && anotherRow.row.tempLeft === 0 && !anotherRow.row.snapshotFolder && anotherRow.row.said !== null && !/login files|login run/.test(anotherRow.row.said.evidence),
    JSON.stringify(anotherRow.row ?? anotherRow.said).slice(0, 900),
  )
  check(
    'where no tool list was settled first, the login run begins when a request that offers the Bash tool is prepared, beside the rest of that request: a request that does not offer it starts none, and the description then waits for that one run and takes no second',
    firstPrompt.row !== null && firstPrompt.row.withoutBash === 0 && firstPrompt.row.begunMs !== null && firstPrompt.row.startsInAll === 1 + readsByZsh && firstPrompt.row.described.endsWith('and no call carries the aliases, functions or options of your profile (bash) in this session.'),
    JSON.stringify(firstPrompt.row ?? firstPrompt.said).slice(0, 900),
  )
  check(
    'a process that ends while its login run is still going ends what that run started',
    endsEarly.row !== null && endsEarly.row.started && leftByTheEarlyEnd === false,
    `${JSON.stringify(endsEarly.row ?? endsEarly.said).slice(0, 600)} · alive after the process ended: ${String(leftByTheEarlyEnd)}`,
  )
  check(
    'the login run starts when a process that is no screen settles a tool list with the Bash tool in it, before any request is prepared; a list without Bash starts none, and the list a screen takes to draw its rows, Bash among them, starts none',
    toolList.row !== null && toolList.row.drawnOnAScreen === true && toolList.row.offeredWithout === false && toolList.row.withoutBash === 0 && toolList.row.offeredWith === true && toolList.row.beforeAnyRequest === 1,
    JSON.stringify(toolList.row ?? toolList.said).slice(0, 900),
  )
  check(
    '…the first request then waits for that one run and takes no second, and its description says the files are carried',
    toolList.row !== null && toolList.row.runsInAll === 1 && toolList.row.described.endsWith('and each call starts from your profile (bash).'),
    JSON.stringify(toolList.row ?? toolList.said).slice(0, 900),
  )
  check(
    'a process that ends while the run its tool list started is still going leaves no child of it',
    endsEarlyListed.row !== null && endsEarlyListed.row.started && leftByTheEarlyEndListed === false,
    `${JSON.stringify(endsEarlyListed.row ?? endsEarlyListed.said).slice(0, 600)} · alive after the process ended: ${String(leftByTheEarlyEndListed)}`,
  )
  check(
    'a process that knows from its arguments that it is a headless run starts its login run in its first lines, when its settings and environment are read and before any tool list is taken; a runner does the same',
    linesOf('run')?.beforeAnyToolList === 1 && linesOf('runner')?.beforeAnyToolList === 1,
    shownLines('run', 'runner'),
  )
  check(
    '…and neither the tool list nor the first request takes a second: one login run in the process, and the description says the files are carried',
    ['run', 'runner'].every(kind => linesOf(kind) !== null && linesOf(kind)!.offered && linesOf(kind)!.saw.length === 1 && linesOf(kind)!.described.endsWith('and each call starts from your profile (bash).')),
    shownLines('run', 'runner'),
  )
  check(
    "the screen's own process starts none: neither its first lines nor the tool list it draws its rows from, Bash among them",
    linesOf('screen') !== null && linesOf('screen')!.beforeAnyToolList === 0 && linesOf('screen')!.offered && linesOf('screen')!.saw.length === 0,
    shownLines('screen'),
  )
  check(
    'a run whose arguments leave Bash out starts none, in its first lines or at its tool list: --toolset without Bash, and --block-tools with Bash',
    ['toolset', 'blocked'].every(kind => linesOf(kind) !== null && linesOf(kind)!.beforeAnyToolList === 0 && !linesOf(kind)!.offered && linesOf(kind)!.saw.length === 0),
    shownLines('toolset', 'blocked'),
  )
  check(
    'where the settings name an environment value that is not in place at the first lines (one a host manages, which the first pass leaves out), the run waits for the tool list as before: the login files see the value a command will see',
    linesOf('pending') !== null && linesOf('pending')!.beforeAnyToolList === 0 && linesOf('pending')!.saw.length === 1 && linesOf('pending')!.saw[0] === `run:${HOST_MANAGED_VALUE}`,
    shownLines('pending'),
  )
  check(
    'a process that ends while the run its first lines started is still going leaves no child of it',
    endsEarlyFirst.row !== null && endsEarlyFirst.row.started && leftByTheEarlyEndFirst === false,
    `${JSON.stringify(endsEarlyFirst.row ?? endsEarlyFirst.said).slice(0, 600)} · alive after the process ended: ${String(leftByTheEarlyEndFirst)}`,
  )
  check(
    'a process that is sent SIGQUIT while its login run is still going leaves no login shell and ends by the signal: the shell and what the login file waited on are gone within a second, and the process, whose own SIGQUIT listener leaves the signal alone while another listener stands (as the exit hook of the product does), exits 131',
    quit.started && quit.exit === 131 && ['login-shell', 'waited-on'].every(name => (quit.left[name]?.pid ?? 0) > 1 && quit.left[name]?.alive === false),
    JSON.stringify(quit).slice(0, 700),
  )
} finally {
  const left = [HOMES['starts-helpers']!.dir, HOMES['agent-from-before']!.dir, QUITS].flatMap(dir => Object.values(helpers(dir)).map(helper => helper.pid))
  for (const pid of [...left, agentFromBefore]) {
    try {
      if (pid > 1) process.kill(pid, 'SIGKILL')
    } catch {
    }
  }
  rmSync(scratch, { recursive: true, force: true })
}

{
  console.log('\nthe PATH a command gets from the launch PATH and the login shell\'s')
  const { pathWithLoginEntries } = await import('../../src/platform/processes/subprocessEnv.ts')
  const terminal = '/Users/u/.local/bin:/Users/u/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  const merged = (launch: string, login: string, platform = 'darwin'): string => pathWithLoginEntries(launch, { PATH: login }, platform)
  check('started bare (/usr/bin:/bin), a command gets the terminal\'s PATH in the terminal\'s order', merged('/usr/bin:/bin', terminal) === terminal, merged('/usr/bin:/bin', terminal))
  const withVenv = `/w/venv/bin:${terminal}`
  check('started from a terminal with a venv in front, PATH is untouched, whatever order the login shell gives it', merged(withVenv, `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/w/venv/bin:/Users/u/.local/bin:/Users/u/bin:/opt/homebrew/bin`) === withVenv && merged(withVenv, `/Users/u/.local/bin:/Users/u/bin:/opt/homebrew/bin:${withVenv}`) === withVenv)
  check('started with the terminal\'s own PATH, nothing changes', merged(terminal, `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/u/.local/bin:/Users/u/bin:/opt/homebrew/bin`) === terminal)
  check('a folder the launcher put in front stays in front of what the login files add, and the system\'s folders take the login shell\'s place', merged('/w/venv/bin:/usr/bin:/bin', '/Users/u/.local/bin:/opt/homebrew/bin:/w/venv/bin:/usr/bin:/bin') === '/w/venv/bin:/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin', merged('/w/venv/bin:/usr/bin:/bin', '/Users/u/.local/bin:/opt/homebrew/bin:/w/venv/bin:/usr/bin:/bin'))
  check('a launch folder the login shell drops is kept, in front', merged('/w/venv/bin:/usr/bin:/bin', '/usr/local/bin:/usr/bin:/bin') === '/w/venv/bin:/usr/local/bin:/usr/bin:/bin', merged('/w/venv/bin:/usr/bin:/bin', '/usr/local/bin:/usr/bin:/bin'))
  check('on Windows the folders the login files add still follow the bash\'s own', merged('/usr/bin:/c/Windows', '/c/probe:/usr/bin:/c/Windows:/usr/local/bin', 'win32') === '/usr/bin:/c/Windows:/c/probe:/usr/local/bin', merged('/usr/bin:/c/Windows', '/c/probe:/usr/bin:/c/Windows:/usr/local/bin', 'win32'))
}

console.log(failures === 0 ? '\nprove-login-file-hands-over: ALL LAWS HOLD' : `\nprove-login-file-hands-over: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
