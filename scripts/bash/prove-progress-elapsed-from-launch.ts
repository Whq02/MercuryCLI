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
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'elapsed-from-launch-')))
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
  toolUseId: 'elapsed-from-launch',
} as never
type Progress = { toolUseID: string; data: { type: string; elapsedTimeSeconds: number; output: string; totalLines: number } }
type Caller = { call: (input: never, context: never, canUseTool?: undefined, parentMessage?: undefined, onProgress?: (p: Progress) => void) => Promise<{ data: { stdout: string } }> }

section('§1 five one-second ticks: every progress row counts its seconds from the launch of the command')
const seen: Array<{ elapsed: number; receivedAt: number }> = []
const launchedAt = Date.now()
const result = await (BashTool as unknown as Caller).call({ command: 'for i in 1 2 3 4 5; do echo $i; sleep 1; done' } as never, toolContext, undefined, undefined, p => {
  if (p.data.type === 'bash_progress') seen.push({ elapsed: p.data.elapsedTimeSeconds, receivedAt: Date.now() })
})
const finishedAt = Date.now()
check('the command finished with its five lines', result.data.stdout.trim().split('\n').join(',') === '1,2,3,4,5', JSON.stringify(result.data.stdout))
check(`the command took about five seconds (${finishedAt - launchedAt} ms)`, finishedAt - launchedAt >= 4500 && finishedAt - launchedAt < 15000)
check('progress rows were received after the quiet window', seen.length >= 2, `${seen.length} rows`)
const expected = seen.map(s => Math.floor((s.receivedAt - launchedAt) / 1000))
const drift = seen.map((s, i) => s.elapsed - (expected[i] as number))
check('every row’s elapsed is within one second of the seconds since launch', drift.every(d => Math.abs(d) <= 1), `elapsed ${JSON.stringify(seen.map(s => s.elapsed))} vs since launch ${JSON.stringify(expected)}`)
check('no row reads two or more seconds short of the launch clock (the quiet window is counted)', drift.every(d => d > -2), `drift ${JSON.stringify(drift)}`)
const late = seen.filter(s => s.receivedAt - launchedAt >= 3500)
check('a row received 3.5 s or more after launch reads at least 3', late.length > 0 && late.every(s => s.elapsed >= 3), `late rows ${JSON.stringify(late.map(s => [s.elapsed, s.receivedAt - launchedAt]))}`)
console.log(`  rows: ${seen.map(s => `${s.elapsed}s@+${s.receivedAt - launchedAt}ms`).join(' · ')}`)

for (const dir of [SCRATCH, proofHome]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    continue
  }
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
