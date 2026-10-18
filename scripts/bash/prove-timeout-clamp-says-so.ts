#!/usr/bin/env bun
import { plugin } from 'bun'
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
delete process.env.MERCURY_SHELL_MAX_TIMEOUT_MS
delete process.env.MERCURY_SHELL_TIMEOUT_MS
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'timeout-clamp-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

let failures = 0
let count = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  count++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { getMaxTimeoutMs } = await import('../../src/tools/BashTool/prompt.ts')
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
  toolUseId: 'timeout-clamp',
} as never
type Caller = { call: (input: never, context: never) => Promise<{ data: unknown }> }
type Mapper = { mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown } }
async function drive(command: string, timeout: number): Promise<string> {
  const result = await (BashTool as unknown as Caller).call({ command, timeout } as never, toolContext)
  const block = (BashTool as unknown as Mapper).mapToolResultToToolResultBlockParam(result.data as never, 'timeout-clamp')
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}

try {
  const cap = getMaxTimeoutMs()
  console.log(`the cap on this host: ${cap} ms`)
  const over = await drive('echo clamp-probe', cap + 300_000)
  check('a timeout above the cap is named in the result with the cap that applied and the background road (the field rows 1B-15, 1C-08)', over.includes('clamp-probe') && over.includes('is above the cap') && over.includes('run_in_background'), over.slice(0, 400))
  const within = await drive('echo within-probe', Math.min(cap, 60_000))
  check('a timeout within the cap says nothing about it', within.includes('within-probe') && !within.includes('is above the cap'), within.slice(0, 300))
  const none = await drive('echo default-probe', undefined as never)
  check('no timeout given says nothing about it', none.includes('default-probe') && !none.includes('is above the cap'), none.slice(0, 300))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('TIMEOUT CLAMP SAYS SO RED')
  process.exit(1)
}
console.log('TIMEOUT CLAMP SAYS SO GREEN')
