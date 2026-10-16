#!/usr/bin/env bun
import { plugin } from 'bun'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'plain-tool-result-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)
const ESC = '\u001b'
const escapes = (text: string): number => (text.match(/\u001b\[[0-9;]*[A-Za-z]/g) ?? []).length

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
  toolUseId: 'plain-tool-result',
} as never
type Out = { stdout: string; stderr: string }
type Caller = { call: (input: never, context: never) => Promise<{ data: unknown }> }
type Mapper = { mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown } }
const mapped = (out: unknown): string => {
  const block = (BashTool as unknown as Mapper).mapToolResultToToolResultBlockParam(out as never, 'plain-tool-result')
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}

try {
  section('§1 the pass, step 6: a vitest run whose result began with colour sequences on every line')
  const vitest = `${ESC}[1m${ESC}[30m${ESC}[46m RUN ${ESC}[49m${ESC}[39m${ESC}[22m ${ESC}[36mv3.2.4${ESC}[39m ${ESC}[90m/private/tmp/defu${ESC}[39m\n\n ${ESC}[32m✓${ESC}[39m test/utils.test.ts ${ESC}[2m(2 tests)${ESC}[22m ${ESC}[32m3${ESC}[2mms${ESC}[22m${ESC}[39m\n ${ESC}[32m✓${ESC}[39m test/defu.test.ts ${ESC}[2m(21 tests)${ESC}[22m ${ESC}[32m8${ESC}[2mms${ESC}[22m${ESC}[39m\n\n${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m2 passed${ESC}[39m${ESC}[22m${ESC}[90m (2)${ESC}[39m\n${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m23 passed${ESC}[39m${ESC}[22m${ESC}[90m (23)${ESC}[39m\n`
  const fixtureOut = { stdout: vitest, stderr: `${ESC}[33mwarning${ESC}[39m: a coloured warning\n`, interrupted: false }
  const plain = mapped(fixtureOut)
  check(`the fixture carried ${escapes(vitest)} escape sequences`, escapes(vitest) > 20)
  check('the model-facing content carries zero escape bytes', !plain.includes(ESC), JSON.stringify(plain.slice(0, 80)))
  check('the words survive the strip: the run line, both files, the two totals', plain.includes('RUN  v3.2.4 /private/tmp/defu') && plain.includes('✓ test/utils.test.ts (2 tests) 3ms') && plain.includes('Test Files  2 passed (2)') && plain.includes('Tests  23 passed (23)'), plain)
  check('stderr reaches the model plain too', plain.includes('warning: a coloured warning') && !plain.includes(`${ESC}[33m`))
  check('the result record itself keeps the raw bytes (the on-screen card paints what the process wrote)', fixtureOut.stdout.includes(ESC) && fixtureOut.stderr.includes(ESC))

  section('§2 the real tool: a command that prints colour')
  const input = { command: "printf '\\033[31mred\\033[0m plain\\n'; printf '\\033[1merr\\033[0m\\n' 1>&2" }
  await BashTool.prepare?.(input as never)
  const result = await (BashTool as unknown as Caller).call(input as never, toolContext)
  const out = result.data as Out
  check('the process wrote the escape bytes and the tool records them (the two streams merged, as the tool promises)', out.stdout.includes(`${ESC}[31m`) && out.stdout.includes(`${ESC}[1m`), JSON.stringify(out))
  const content = mapped(out)
  check('the model reads "red plain" and "err" with no escape byte', content.includes('red plain') && content.includes('err') && !content.includes(ESC), JSON.stringify(content))

  section('§3 the renderer and the search text are untouched (the card keeps the raw bytes)')
  const src = readFileSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx'), 'utf8')
  check('the strip sits in the model-facing mapper alone', /let stdout = stripAnsi\(output\.stdout\)/.test(src) && /let errorText = stripAnsi\(output\.stderr\)\.trimEnd\(\)/.test(src))
  check('the search text and the truncation predicate read the raw output', /extractSearchText\(output: Out\): string \{\s*return output\.stderr \? `\$\{output\.stdout\}\\n\$\{output\.stderr\}` : output\.stdout/.test(src) && /isOutputLineTruncated\(output\.stdout\)/.test(src))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n✅ plain tool result — ALL PASS' : `\n❌ plain tool result — ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
