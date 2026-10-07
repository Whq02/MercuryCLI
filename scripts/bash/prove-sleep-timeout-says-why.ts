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
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'sleep-timeout-why-')))
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

const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { TaskStopTool } = await import('../../src/tools/TaskStopTool/TaskStopTool.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')

let appState = getDefaultAppState()
const toolContext = {
  options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
  toolUseId: 'sleep-timeout-why',
} as never
type Caller = { call: (input: never, context: never) => Promise<{ data: unknown }> }
type Mapper = { mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown } }
type Drive = { ok: true; out: { backgroundTaskId?: string; stdout: string }; content: string } | { ok: false; code: number | undefined; text: string }
async function drive(command: string, timeout: number): Promise<Drive> {
  try {
    const result = await (BashTool as unknown as Caller).call({ command, timeout } as never, toolContext)
    const block = (BashTool as unknown as Mapper).mapToolResultToToolResultBlockParam(result.data as never, 'sleep-timeout-why')
    return { ok: true, out: result.data as { backgroundTaskId?: string; stdout: string }, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
  } catch (error) {
    const e = error as { exitCode?: number; code?: number; stderr?: string; stdout?: string; message?: string }
    return { ok: false, code: e.exitCode ?? e.code, text: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n') }
  }
}
const WHY = 'A command whose first word is `sleep` is killed at its timeout instead of moving to the background; to wait longer, pass a larger `timeout` or use the Sleep tool.'

section('§1 `sleep 30` with timeout 2000: killed, and the error says why')
const startedAt = Date.now()
const slept = await drive('sleep 30', 2000)
const ms = Date.now() - startedAt
check('the call came back at its timeout', ms >= 1800 && ms < 8000, `${ms} ms`)
check('the result is an error (the command was killed, not moved)', !slept.ok, slept.ok ? JSON.stringify(slept.content.slice(0, 120)) : '')
if (!slept.ok) {
  check('the exit code is 143', slept.code === 143, String(slept.code))
  check('the error carries `Command timed out after 2s`', slept.text.includes('Command timed out after 2s'), JSON.stringify(slept.text.slice(0, 200)))
  check('the error says the command is killed at its timeout instead of moving to the background', slept.text.includes('is killed at its timeout instead of moving to the background'), JSON.stringify(slept.text))
  check('the line follows the timeout note and precedes the exit line, word for word', new RegExp(`Command timed out after 2s\\.\\n${WHY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\nExited with code 143`).test(slept.text), JSON.stringify(slept.text))
}

section('§2 a non-sleep command at its timeout does not carry that line')
const moved = await drive('while true; do sleep 1; done', 2000)
check('a looping command is moved to the background, not killed', moved.ok && typeof moved.out.backgroundTaskId === 'string', moved.ok ? JSON.stringify(moved.content.slice(0, 120)) : moved.text.slice(0, 160))
check('its result does not carry the sleep line', moved.ok ? !moved.content.includes('is killed at its timeout instead of moving to the background') : !moved.text.includes('is killed at its timeout instead of moving to the background'))
if (moved.ok && typeof moved.out.backgroundTaskId === 'string') await (TaskStopTool as unknown as Caller).call({ task_id: moved.out.backgroundTaskId } as never, toolContext)

section('§3 a sleep that finishes in time says nothing of the kind, and a sleep that fails for another reason neither')
const quick = await drive('sleep 0.2; echo rested', 5000)
check('a sleep inside its timeout is an ordinary result', quick.ok && quick.content.startsWith('rested') && !quick.content.includes('killed at its timeout'), quick.ok ? JSON.stringify(quick.content) : quick.text.slice(0, 120))
const broken = await drive('sleep notanumber', 5000)
check("a sleep that fails on its own carries only its own error, not the timeout line", !broken.ok && !broken.text.includes('Command timed out after') && !broken.text.includes('killed at its timeout'), broken.ok ? 'settled as a result' : JSON.stringify(broken.text.slice(0, 200)))

for (const dir of [SCRATCH, proofHome]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    continue
  }
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
