#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_SHELL_ENGINE
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'signal-exit-words-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { exitLine } = await import('../../src/tools/shell/commandSemantics.ts')
const { formatError } = await import('../../src/tools/kit/toolErrors.ts')

const KILLED = 'exit 137 · killed (out of memory or a kill signal)'
const CRASHED = 'exit 139 · crashed (segmentation fault)'
const ABORTED = 'exit 134 · aborted (SIGABRT)'
const TERMINATED = 'exit 143 · terminated (SIGTERM)'

section('§1 the exit line, by code')
check('137 reads killed, with out of memory named', exitLine(137) === KILLED, `${exitLine(137)} — exitLine in src/tools/shell/commandSemantics.ts must map code 137 to the killed words`)
check('139 reads crashed (segmentation fault)', exitLine(139) === CRASHED, `${exitLine(139)} — exitLine in src/tools/shell/commandSemantics.ts must map code 139 to the crashed words`)
check('134 reads aborted (SIGABRT)', exitLine(134) === ABORTED, `${exitLine(134)} — exitLine in src/tools/shell/commandSemantics.ts must map code 134 to the aborted words`)
check('143 reads terminated (SIGTERM)', exitLine(143) === TERMINATED, `${exitLine(143)} — exitLine in src/tools/shell/commandSemantics.ts must map code 143 to the terminated words`)
for (const code of [1, 2, 3, 127, 130, 138, 144, 145]) check(`${code} keeps the plain exit line`, exitLine(code) === `Exited with code ${code}`, `${exitLine(code)} — exitLine in src/tools/shell/commandSemantics.ts must give only the four signal codes special words`)
check('a 137 the harness itself caused keeps the plain exit line', exitLine(137, false) === 'Exited with code 137', `${exitLine(137, false)} — exitLine in src/tools/shell/commandSemantics.ts must keep the plain line when its second argument says the harness caused the exit`)
check('a 143 the harness itself caused keeps the plain exit line', exitLine(143, false) === 'Exited with code 143', `${exitLine(143, false)} — exitLine in src/tools/shell/commandSemantics.ts must keep the plain line when its second argument says the harness caused the exit`)
{
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    check('on win32 every code keeps the plain exit line', [134, 137, 139, 143].every(code => exitLine(code) === `Exited with code ${code}`), `${[134, 137, 139, 143].map(code => exitLine(code)).join(' | ')} — exitLine in src/tools/shell/commandSemantics.ts must return the plain line on win32`)
  } finally {
    Object.defineProperty(process, 'platform', desc)
  }
}

if (process.platform === 'win32') {
  console.log('\n  [SKIP — LOUD] the live legs send POSIX signals; on win32 the exit line is pinned by §1 alone')
} else {
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  let appState = getDefaultAppState()
  const toolContext = {
    options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => {
      appState = update(appState)
    },
    abortController: new AbortController(),
    toolUseId: 'signal-exit-words',
  } as never
  type Caller = { call: (input: never, context: never) => Promise<{ data: unknown }> }
  type Drive = { ok: true; content: string } | { ok: false; code: number | undefined; text: string; model: string }
  async function drive(command: string, timeout = 20_000): Promise<Drive> {
    try {
      const result = await (BashTool as unknown as Caller).call({ command, timeout } as never, toolContext)
      return { ok: true, content: JSON.stringify(result.data).slice(0, 200) }
    } catch (error) {
      const e = error as { code?: number; stderr?: string; stdout?: string }
      return { ok: false, code: e.code, text: `${e.stdout ?? ''}${e.stderr ?? ''}`, model: formatError(error) }
    }
  }
  const lastLine = (text: string): string => text.trimEnd().split('\n').pop() ?? ''
  const live = async (label: string, command: string, code: number, line: string): Promise<void> => {
    section(label)
    const r = await drive(`ulimit -c 0; ${command}`)
    check('the call is an error', !r.ok, r.ok ? `${r.content} — the signalled command should throw from BashTool.call in src/tools/shell/BashTool.tsx` : '')
    if (r.ok) return
    check(`the exit code is ${code}`, r.code === code, `${String(r.code)} — the thrown ShellError code comes from the shell result in src/tools/shell/BashTool.tsx`)
    check(`the result ends with the line, word for word: ${line}`, lastLine(r.text) === line, `${JSON.stringify(r.text.slice(-200))} — the last line of the result comes from exitLine in src/tools/shell/commandSemantics.ts`)
    check('no plain Exited with code line rides beside it', !r.text.includes('Exited with code'), `${JSON.stringify(r.text.slice(-200))} — a signal exit must print the exitLine words in src/tools/shell/commandSemantics.ts and not the plain line`)
    check(`the model text opens with the headline and closes with the line`, r.model.startsWith(`Shell command failed (exit code ${code})`) && lastLine(r.model) === line, `${JSON.stringify(r.model.slice(-240))} — the model text is built by formatError in src/tools/kit/toolErrors.ts; it must open with the failure headline and end with the exit line`)
  }
  await live('§2 a child killed by SIGKILL', "sh -c 'kill -KILL $$'", 137, KILLED)
  await live('§3 a child that dies of SIGSEGV', "sh -c 'kill -SEGV $$'", 139, CRASHED)
  await live('§4 a child that aborts (SIGABRT)', "sh -c 'kill -ABRT $$'", 134, ABORTED)
  await live('§5 a child terminated by SIGTERM', "sh -c 'kill -TERM $$'", 143, TERMINATED)

  section('§6 an ordinary failure keeps the plain exit line')
  const plain = await drive('echo before; exit 3')
  check('exit 3 is an error ending with Exited with code 3', !plain.ok && plain.code === 3 && lastLine(plain.text) === 'Exited with code 3' && plain.text.includes('before'), `${plain.ok ? plain.content : JSON.stringify(plain.text.slice(-120))} — an ordinary exit must keep the plain line from exitLine in src/tools/shell/commandSemantics.ts`)

  section("§7 a timeout the harness enforces keeps its own words and the plain exit line — the code is 143, the death was the harness's")
  const timedOut = await drive('sleep 30', 1500)
  check('the timeout result carries Command timed out and ends with Exited with code 143', !timedOut.ok && timedOut.code === 143 && timedOut.text.includes('Command timed out after') && lastLine(timedOut.text) === 'Exited with code 143' && !timedOut.text.includes(TERMINATED), `${timedOut.ok ? timedOut.content : JSON.stringify(timedOut.text.slice(-240))} — a harness timeout must keep the plain exit line: exitLine in src/tools/shell/commandSemantics.ts takes a flag for exits the harness caused`)
}

for (const dir of [SCRATCH, proofHome]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    continue
  }
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
