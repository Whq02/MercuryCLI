#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Created = { command: string; args: string[] | null; shell: string | null; cwd: string | null }
type Call = { threw: string | null; nothing: boolean; code: number | null; text: string }
type Scene = { created: Created[]; calls: Call[]; record: string; launcherShell: string; leftBehind: boolean[] }

if (process.argv.includes('--scenes')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const bridge = await import('../../src/services/acp/ideToolBridge.ts')
  const { setCwd, terminalShellInvocation } = await import('../../src/utils/Shell.ts')
  const { systemShellRecord } = await import('../../src/utils/shell/shellRecord.ts')
  const home = homedir()
  setCwd(home)
  const record = (await systemShellRecord()).path

  const scene = async (kind: 'starts' | 'starts nothing' | 'refuses'): Promise<Scene> => {
    const created: Created[] = []
    const terminals = new Map<string, { output: string; exit: Promise<number | null> }>()
    const of = (params: { terminal_id: string }): { output: string; exit: Promise<number | null> } => terminals.get(params.terminal_id) ?? { output: '', exit: Promise.resolve(1) }
    bridge.registerIdeToolDoor({
      capabilities: () => ({ readTextFile: false, writeTextFile: false, terminal: true }),
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => ({}),
      terminalCreate: async (params: { command: string; args?: string[]; cwd?: string | null; env?: Array<{ name: string; value: string }> }) => {
        created.push({ command: params.command, args: params.args ?? null, shell: params.env?.find(entry => entry.name === 'SHELL')?.value ?? null, cwd: params.cwd ?? null })
        if (kind === 'refuses') throw new Error('this editor starts no program by name')
        const terminal_id = `terminal-${created.length}`
        if (kind === 'starts nothing') {
          terminals.set(terminal_id, { output: 'ready\n', exit: Promise.resolve(0) })
          return { terminal_id }
        }
        const child = spawn(params.command, params.args ?? [], { cwd: params.cwd ?? home, env: Object.fromEntries((params.env ?? []).map(entry => [entry.name, entry.value])), stdio: ['ignore', 'pipe', 'pipe'] })
        const row = { output: '', exit: new Promise<number | null>(done => { child.once('close', code => done(code)); child.once('error', () => done(127)) }) }
        child.stdout.on('data', chunk => { row.output += String(chunk) })
        child.stderr.on('data', chunk => { row.output += String(chunk) })
        terminals.set(terminal_id, row)
        return { terminal_id }
      },
      terminalOutput: async (params: { terminal_id: string }) => ({ output: of(params).output, truncated: false }),
      terminalWaitForExit: async (params: { terminal_id: string }) => ({ exit_code: await of(params).exit }),
      terminalKill: async () => ({}),
      terminalRelease: async () => ({}),
    } as never)
    const calls: Call[] = []
    const leftBehind: boolean[] = []
    for (const command of ['echo "first:$BASH_VERSION:$0"; X="a b"; printf "[%s]" $X; echo', 'echo second']) {
      const shell = await terminalShellInvocation(command, false)
      try {
        const handle = await bridge.execViaIdeTerminal(new AbortController().signal, { cwd: home, timeout: 30_000, shell })
        if (handle === null) calls.push({ threw: null, nothing: true, code: null, text: '' })
        else {
          const result = await handle.result
          calls.push({ threw: null, nothing: false, code: result.code, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() })
        }
      } catch (error) {
        calls.push({ threw: error instanceof bridge.IdeTerminalUnavailableError ? error.message : `another error: ${String(error)}`, nothing: false, code: null, text: '' })
      }
      await new Promise(done => setTimeout(done, 50))
      leftBehind.push(shell.leftBehind.some(path => existsSync(path)))
    }
    bridge.registerIdeToolDoor(null)
    return { created, calls, record, launcherShell: process.env.SHELL ?? '', leftBehind }
  }
  console.log(`SCENES ${JSON.stringify({ starts: await scene('starts'), nothing: await scene('starts nothing'), refuses: await scene('refuses') })}`)
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' The editor\'s terminal is asked for the record\'s shell, once to see that it starts and then for each command')
console.log('============================================================')

if (process.platform === 'win32') {
  console.log('  [SKIP] this proof drives the macOS and Linux road; the Windows road has its own proofs')
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'editor-terminal-shell-')))
const userHome = join(scratch, 'user-home')
mkdirSync(userHome)

try {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(?:BASH_ENV|ENV|MERCURY_SHELL_PREFIX|MERCURY_SHELL_ENGINE|MERCURY_WINDOWS_SHELL_ROAD)$/.test(key)) continue
    env[key] = value
  }
  Object.assign(env, { HOME: userHome, SHELL: '/bin/zsh', MERCURY_CONFIG_DIR: join(scratch, 'config-home') })
  const child = spawnSync(process.execPath, [import.meta.path, '--scenes'], { encoding: 'utf8', env })
  const line = (child.stdout ?? '').split('\n').find(text => text.startsWith('SCENES '))
  const scenes = line === undefined ? null : (JSON.parse(line.slice(7)) as { starts: Scene; nothing: Scene; refuses: Scene })
  const why = `exit ${String(child.status)} · ${JSON.stringify(String(child.stderr ?? '').slice(-400))}`
  const told = (scene: Scene | undefined): string => (scene === undefined ? why : JSON.stringify({ created: scene.created.map(row => ({ ...row, args: row.args?.map(arg => arg.slice(0, 80)) ?? null })), calls: scene.calls }).slice(0, 900))
  const probe = /^printf '%s\\n' mercury-shell-[0-9a-f]+$/

  console.log('\n(1) an editor that starts what it is asked')
  const starts = scenes?.starts
  check('terminal/create is asked three times for two commands: once on a harmless line, then once for each command', starts?.created.length === 3 && probe.test(starts.created[0]?.args?.[1] ?? ''), told(starts))
  check('each time the program is the record\'s shell by its path and the arguments are -c and one line', starts !== undefined && starts.created.length > 0 && starts.created.every(row => row.command === starts.record && row.args?.length === 2 && row.args[0] === '-c'), told(starts))
  check('the command rides inside the line the local road builds: the frame holds it quoted after eval, and no argument is the raw command', starts !== undefined && (starts.created[1]?.args?.[1] ?? '').includes("eval 'echo \"first:$BASH_VERSION:$0\"") && (starts.created[2]?.args?.[1] ?? '').includes("eval 'echo second'"), told(starts))
  check('the terminal is handed the SHELL the launcher had, not the shell that runs', starts !== undefined && starts.created.length > 0 && starts.created.every(row => row.shell === starts.launcherShell && row.shell === '/bin/zsh'), told(starts))
  check('the command runs in the record\'s bash in the editor\'s terminal: bash names itself and splits the words', starts !== undefined && starts.calls[0]?.code === 0 && new RegExp(`^first:\\d[^:]*:${starts.record.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\[a\\]\\[b\\]$`).test(starts.calls[0].text) && starts.calls[1]?.text === 'second', told(starts))
  check('what the frame writes beside the command is removed when the terminal ends', starts !== undefined && starts.leftBehind.every(left => !left), JSON.stringify(starts?.leftBehind))

  console.log('\n(2) an editor whose terminal starts nothing')
  const nothing = scenes?.nothing
  check('it is asked once, on the harmless line, and never handed a command', nothing?.created.length === 1 && probe.test(nothing.created[0]?.args?.[1] ?? ''), told(nothing))
  check('the first command is passed to the local road with one sentence saying so', /^The editor's terminal could not start Mercury's shell \(.*\); this command ran in the local shell, and so will the rest of this session's\.$/.test(nothing?.calls[0]?.threw ?? ''), told(nothing))
  check('the answer is kept: the second command goes to the local road without a word and without asking again', nothing?.calls[1]?.nothing === true && nothing.calls[1].threw === null, told(nothing))

  console.log('\n(3) an editor that refuses to start a program by name')
  const refuses = scenes?.refuses
  check('it is asked once and its own words are in the sentence', refuses?.created.length === 1 && /could not start Mercury's shell \(this editor starts no program by name\)/.test(refuses.calls[0]?.threw ?? ''), told(refuses))
  check('the answer is kept for the session', refuses?.calls[1]?.nothing === true && refuses.calls[1].threw === null, told(refuses))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-editor-terminal-shell: ALL LAWS HOLD' : `\nprove-editor-terminal-shell: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
