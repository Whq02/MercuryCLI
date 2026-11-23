#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Created = { command: string; args: string[] | null; shell: string | null; cwd: string | null }
type Call = { threw: string | null; nothing: boolean; code: number | null; text: string; ms: number }
type Scene = { created: Created[]; calls: Call[]; record: string; launcherShell: string; leftBehind: boolean[]; ranCount: number }
type Kind = 'starts' | 'starts nothing' | 'refuses' | 'answers create late' | 'output lags' | 'never settles' | 'truncates' | 'reports the exit'

if (process.argv.includes('--scenes')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const bridge = await import('../../src/integrations/acp/ideToolBridge.ts')
  const { PeerDeadline } = await import('../../src/daemon/runner-wire/peer.ts')
  const { setCwd, terminalShellInvocation } = await import('../../src/platform/shell/shellExec.ts')
  const { systemShellRecord } = await import('../../src/platform/shell/shellRecord.ts')
  const home = homedir()
  setCwd(home)
  const record = (await systemShellRecord()).path

  const scene = async (kind: Kind): Promise<Scene> => {
    const created: Created[] = []
    type Terminal = { chunks: Array<{ at: number; text: string }>; exit: Promise<number | null>; code: number | null | undefined; lagMs: number }
    const terminals = new Map<string, Terminal>()
    const of = (params: { terminal_id: string }): Terminal => terminals.get(params.terminal_id) ?? { chunks: [], exit: Promise.resolve(1), code: 1, lagMs: 0 }
    const shown = (terminal: Terminal): { output: string; truncated: boolean; exit_status?: { exit_code: number | null } } => {
      const visible = terminal.chunks.filter(chunk => Date.now() - chunk.at >= terminal.lagMs).map(chunk => chunk.text).join('')
      if (kind === 'never settles') return { output: `${visible}${'.'.repeat(Math.floor(Date.now() / 50) % 100000)}`, truncated: false }
      if (kind === 'truncates' && visible.length > 80) return { output: visible.slice(-80), truncated: true }
      if (kind === 'reports the exit' && terminal.code !== undefined) return { output: visible, truncated: false, exit_status: { exit_code: terminal.code } }
      return { output: visible, truncated: false }
    }
    bridge.registerIdeToolDoor({
      capabilities: () => ({ readTextFile: false, writeTextFile: false, terminal: true }),
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => ({}),
      terminalCreate: async (params: { command: string; args?: string[]; cwd?: string | null; env?: Array<{ name: string; value: string }> }) => {
        created.push({ command: params.command, args: params.args ?? null, shell: params.env?.find(entry => entry.name === 'SHELL')?.value ?? null, cwd: params.cwd ?? null })
        if (kind === 'refuses') throw new Error('this editor starts no program by name')
        const terminal_id = `terminal-${created.length}`
        if (kind === 'starts nothing') {
          terminals.set(terminal_id, { chunks: [{ at: 0, text: 'ready\n' }], exit: Promise.resolve(0), code: 0, lagMs: 0 })
          return { terminal_id }
        }
        const child = spawn(params.command, params.args ?? [], { cwd: params.cwd ?? home, env: Object.fromEntries((params.env ?? []).map(entry => [entry.name, entry.value])), stdio: ['ignore', 'pipe', 'pipe'] })
        const row: Terminal = { chunks: [], exit: Promise.resolve(null), code: undefined, lagMs: kind === 'output lags' && created.length > 1 ? 700 : 0 }
        row.exit = new Promise<number | null>(done => { child.once('close', code => { row.code = code; done(code) }); child.once('error', () => { row.code = 127; done(127) }) })
        child.stdout.on('data', chunk => { row.chunks.push({ at: Date.now(), text: String(chunk) }) })
        child.stderr.on('data', chunk => { row.chunks.push({ at: Date.now(), text: String(chunk) }) })
        terminals.set(terminal_id, row)
        if (kind === 'answers create late' && created.length === 2) {
          await row.exit
          throw new PeerDeadline('terminal/create', created.length, 30_000)
        }
        return { terminal_id }
      },
      terminalOutput: async (params: { terminal_id: string }) => shown(of(params)),
      terminalWaitForExit: async (params: { terminal_id: string }) => ({ exit_code: await of(params).exit }),
      terminalKill: async () => ({}),
      terminalRelease: async () => ({}),
    } as never)
    const calls: Call[] = []
    const leftBehind: boolean[] = []
    const first = kind === 'truncates' ? 'for i in $(seq 1 40); do echo "line $i of forty"; done' : kind === 'starts' || kind === 'starts nothing' || kind === 'refuses' ? 'echo "first:$BASH_VERSION:$0"; X="a b"; printf "[%s]" $X; echo' : 'echo ran >> "$HOME/ran-count"; echo first-output'
    for (const command of [first, 'echo second']) {
      const shell = await terminalShellInvocation(command, false)
      const began = Date.now()
      try {
        const handle = await bridge.execViaIdeTerminal(new AbortController().signal, { cwd: home, timeout: 30_000, shell })
        if (handle === null) calls.push({ threw: null, nothing: true, code: null, text: '', ms: Date.now() - began })
        else {
          const result = await handle.result
          calls.push({ threw: null, nothing: false, code: result.code, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), ms: Date.now() - began })
        }
      } catch (error) {
        calls.push({ threw: error instanceof bridge.IdeTerminalUnavailableError ? error.message : `another error: ${String(error)}`, nothing: false, code: null, text: '', ms: Date.now() - began })
      }
      await new Promise(done => setTimeout(done, 50))
      leftBehind.push(shell.leftBehind.some(path => existsSync(path)))
    }
    bridge.registerIdeToolDoor(null)
    const count = join(home, 'ran-count')
    const ranCount = existsSync(count) ? readFileSync(count, 'utf8').trim().split('\n').length : 0
    rmSync(count, { force: true })
    return { created, calls, record, launcherShell: process.env.SHELL ?? '', leftBehind, ranCount }
  }
  const wanted = process.argv[process.argv.indexOf('--scenes') + 1] as Kind
  console.log(`SCENES ${JSON.stringify(await scene(wanted))}`)
  process.exit(0)
}

let failures = 0
const terminalFixHint = 'change execViaIdeTerminal in src/integrations/acp/ideToolBridge.ts or terminalShellInvocation in src/platform/shell/shellExec.ts'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' · ' : '') + terminalFixHint : ''}`)
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
  const whys = new Map<Kind, string>()
  const sceneOf = (kind: Kind): Scene | undefined => {
    const child = spawnSync(process.execPath, [import.meta.path, '--scenes', kind], { encoding: 'utf8', env })
    const line = (child.stdout ?? '').split('\n').find(text => text.startsWith('SCENES '))
    whys.set(kind, `exit ${String(child.status)} · ${JSON.stringify(String(child.stderr ?? '').slice(-400))}`)
    return line === undefined ? undefined : (JSON.parse(line.slice(7)) as Scene)
  }
  const told = (scene: Scene | undefined, kind?: Kind): string => (scene === undefined ? (whys.get(kind ?? 'starts') ?? '') : JSON.stringify({ created: scene.created.map(row => ({ ...row, args: row.args?.map(arg => arg.slice(0, 80)) ?? null })), calls: scene.calls, ranCount: scene.ranCount }).slice(0, 1200))
  const probe = /^printf '%s\\n' mercury-shell-[0-9a-f]+$/

  console.log('\n(1) an editor that starts what it is asked')
  const starts = sceneOf('starts')
  check('terminal/create is asked three times for two commands: once on a harmless line, then once for each command', starts?.created.length === 3 && probe.test(starts.created[0]?.args?.[1] ?? ''), told(starts))
  check('each time the program is the record\'s shell by its path and the arguments are -c and one line', starts !== undefined && starts.created.length > 0 && starts.created.every(row => row.command === starts.record && row.args?.length === 2 && row.args[0] === '-c'), told(starts))
  check('the command rides inside the line the local road builds: the frame holds it quoted after eval, and no argument is the raw command', starts !== undefined && (starts.created[1]?.args?.[1] ?? '').includes("eval 'echo \"first:$BASH_VERSION:$0\"") && (starts.created[2]?.args?.[1] ?? '').includes("eval 'echo second'"), told(starts))
  check('the terminal is handed the SHELL the launcher had, not the shell that runs', starts !== undefined && starts.created.length > 0 && starts.created.every(row => row.shell === starts.launcherShell && row.shell === '/bin/zsh'), told(starts))
  check('the command runs in the record\'s bash in the editor\'s terminal: bash names itself and splits the words', starts !== undefined && starts.calls[0]?.code === 0 && new RegExp(`^first:\\d[^:]*:${starts.record.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\[a\\]\\[b\\]$`).test(starts.calls[0].text) && starts.calls[1]?.text === 'second', told(starts))
  check('what the frame writes beside the command is removed when the terminal ends', starts !== undefined && starts.leftBehind.every(left => !left), JSON.stringify(starts?.leftBehind))

  console.log('\n(2) an editor whose terminal starts nothing')
  const nothing = sceneOf('starts nothing')
  check('it is asked once, on the harmless line, and never handed a command', nothing?.created.length === 1 && probe.test(nothing.created[0]?.args?.[1] ?? ''), told(nothing))
  check('the first command is passed to the local road with one sentence saying so', /^The editor's terminal could not start Mercury's shell \(.*\); this command ran in the local shell, and so will the rest of this session's\.$/.test(nothing?.calls[0]?.threw ?? ''), told(nothing))
  check('the answer is kept: the second command goes to the local road without a word and without asking again', nothing?.calls[1]?.nothing === true && nothing.calls[1].threw === null, told(nothing))

  console.log('\n(3) an editor that refuses to start a program by name')
  const refuses = sceneOf('refuses')
  check('it is asked once and its own words are in the sentence', refuses?.created.length === 1 && /could not start Mercury's shell \(this editor starts no program by name\)/.test(refuses.calls[0]?.threw ?? ''), told(refuses))
  check('the answer is kept for the session', refuses?.calls[1]?.nothing === true && refuses.calls[1].threw === null, told(refuses))

  console.log('\n(4) an editor that starts the program and does not answer terminal/create within its deadline')
  const late = sceneOf('answers create late')
  check(
    'the command is not handed to the local road: the answer is an error that says it may be running in the editor\'s terminal and was not run again',
    late !== undefined && late.calls[0]?.threw === null && late.calls[0].nothing === false && late.calls[0].code === 1 && /^The editor did not answer the request for a terminal within 30 s, so this command may be running in the editor's terminal; it was not run again in the local shell\./.test(late.calls[0].text),
    told(late, 'answers create late'),
  )
  check('the command ran once, where the editor started it', late?.ranCount === 1, told(late, 'answers create late'))
  check('the next command goes to the editor\'s terminal as before', late?.calls[1]?.code === 0 && late.calls[1].text === 'second', told(late, 'answers create late'))

  console.log('\n(5) an editor whose terminal/output shows what the program printed 700 ms ago')
  const lags = sceneOf('output lags')
  check('both results hold the output: it is waited for after the exit', lags?.calls[0]?.text === 'first-output' && lags.calls[1]?.text === 'second', told(lags, 'output lags'))

  console.log('\n(6) an editor whose terminal/output never stops growing')
  const never = sceneOf('never settles')
  check(
    'the wait ends at its bound of 3 s, and the result names the bound',
    never !== undefined && never.calls[0]?.code === 0 && never.calls[0].ms < 6_000 && never.calls[0].text.includes("The editor's terminal was still printing 3 s after the command ended, so the end of its output may be missing here."),
    told(never, 'never settles'),
  )

  console.log('\n(7) an editor that keeps the last 80 bytes and says the output is truncated')
  const truncates = sceneOf('truncates')
  check(
    'the result says the editor kept only the end of the output',
    truncates !== undefined && truncates.calls[0]?.text.includes('line 40 of forty') === true && !truncates.calls[0].text.includes('line 1 of forty') && truncates.calls[0].text.includes("The editor's terminal kept only the end of this output: it reports the output as truncated.") && truncates.calls[1]?.text === 'second',
    told(truncates, 'truncates'),
  )

  console.log('\n(8) an editor whose terminal/output carries the exit status, as the protocol has it')
  const reports = sceneOf('reports the exit')
  check('nothing is waited for after the exit: each command returns within a second, with its output', reports !== undefined && reports.calls.length === 2 && reports.calls.every(call => call.code === 0 && call.ms < 1_000) && reports.calls[0]?.text === 'first-output' && reports.calls[1]?.text === 'second', told(reports, 'reports the exit'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-editor-terminal-shell: ALL LAWS HOLD' : `\nprove-editor-terminal-shell: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
