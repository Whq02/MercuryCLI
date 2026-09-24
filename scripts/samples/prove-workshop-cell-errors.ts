#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-workshop-cell-errors-'))
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_WORKSHOP

const { runWorkshopCell, workshopGeneration } = await import('../../src/services/workshop/runtime.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — workshop cell errors proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'mercury-workshop-cell-errors-work-'))
const owner = makeOwnerKey({ workspace: workDir, sessionId: 'workshop-cell-errors', lane: 'main' } as never)
const refusing = {
  inspect: async () => 'inspect-unused',
  tool: async (name: string) => {
    throw new Error(`no tool '${name}' in this session's catalog`)
  },
  agent: async () => 'agent-unused',
}
const slowThenRefusing = {
  ...refusing,
  tool: async (name: string) => {
    if (name === 'Slow') {
      await new Promise(r => setTimeout(r, 50))
      return 'slow-tool-result'
    }
    throw new Error(`no tool '${name}' in this session's catalog`)
  },
}
function run(code: string, extras: Record<string, unknown> = {}) {
  return runWorkshopCell({
    owner,
    cwd: workDir,
    cell: { language: 'js', code, ...extras } as never,
    bridge: (extras.bridge as typeof refusing) ?? refusing,
  })
}
const WORKER_FRAME = /\[worker eval\]|node:internal|MessagePort/
const brief = (r: { error?: string }): string => JSON.stringify((r.error ?? '').slice(0, 400))

section('S1. a syntax error late in a long one-line cell with a top-level await')
{
  const filler = 'a'.repeat(3900)
  const cell = `var md='/tmp/notes.md'; await mercury.tool('Edit',{file_path:md,old_string:'${filler}',new_string:'b'); await mercury.tool('Edit',{file_path:md,old_string:'c',new_string:'d'})`
  const column = cell.indexOf("'b')") + 3
  const s1 = await run(cell)
  check('S1a the cell failed and nothing was killed', s1.state === 'failed' && !s1.runtimeKilled, JSON.stringify({ state: s1.state, killed: s1.runtimeKilled }))
  check('S1b the error opens with SyntaxError and its message', /^SyntaxError: \S/.test(s1.error ?? ''), brief(s1))
  check('S1c the error names the parse position: line 1, the column of the unexpected token', (s1.error ?? '').includes(`(${s1.cellId}.js:1:${column + 1})`), `expected column ${column + 1} · ${brief(s1)}`)
  check('S1d an excerpt with a caret shows the position', /\n\s+near: .*\n\s+\^/.test(s1.error ?? ''), brief(s1))
  check('S1e bounded: no echo of the whole source line', (s1.error ?? '').length < 1500 && !(s1.error ?? '').includes(filler.slice(0, 500)), `length=${s1.error?.length}`)
  check('S1f no misleading top-level-await complaint', !/await is only valid/.test(s1.error ?? ''), brief(s1))
}

section('S2. a short syntax error in a plain cell')
{
  const s2 = await run('const broken = (')
  check('S2a SyntaxError first, with line 1 and the column of the end of input', /^SyntaxError: .+ \(cell-js-g\d+-\d+\.js:1:1[67]\)/.test(s2.error ?? ''), brief(s2))
  check('S2b no worker-internal frames', !WORKER_FRAME.test(s2.error ?? ''), brief(s2))
}

section('S3. a failed bridge call: the call is named, the cell stops there, the location is the cell line')
{
  const before = workshopGeneration(owner, 'js')
  const s3 = await run("const first = 1\nconst out = await mercury.tool('Read', { file_path: '/nowhere' })\nout")
  check('S3a the error names the bridge call by ordinal and tool, then the tool\'s own words', /^bridge call 1 \(Read\) failed: no tool 'Read' in this session's catalog$/m.test(s3.error ?? ''), brief(s3))
  check('S3b the result says the cell stopped at that call', /^the cell stopped at that call$/m.test(s3.error ?? ''), brief(s3))
  check('S3c the location is the cell\'s own line, with the top-level-await wrapper not counted', new RegExp(`^\\s+at .*${s3.cellId}\\.js:2:\\d+`, 'm').test(s3.error ?? ''), brief(s3))
  check('S3d no worker-internal frames', !WORKER_FRAME.test(s3.error ?? ''), brief(s3))
  check('S3e a failed bridge call does not kill the runtime', s3.state === 'failed' && !s3.runtimeKilled && workshopGeneration(owner, 'js') === before && s3.nestedCalls === 1, JSON.stringify({ state: s3.state, killed: s3.runtimeKilled, calls: s3.nestedCalls }))
  const s3b = await run("await mercury.tool('Slow', {}); await mercury.tool('Slow', {}); await mercury.tool('Missing', {})", { bridge: slowThenRefusing })
  check('S3f the ordinal counts the cell\'s own calls: the third call is named', /^bridge call 3 \(Missing\) failed: /m.test(s3b.error ?? '') && s3b.nestedCalls === 3, brief(s3b))
  const s3c = await run("const caught = await mercury.tool('Missing', {}).catch(e => 'caught: ' + e.message)\ncaught")
  check('S3g a cell that catches the rejection continues and reads the tool\'s words', s3c.state === 'succeeded' && /caught: no tool 'Missing'/.test(s3c.valuePreview), JSON.stringify(s3c).slice(0, 300))
  const s3d = await run("const items = await mercury.parallel([() => mercury.tool('Slow', {}), () => mercury.tool('Missing', {})])\nitems", { bridge: slowThenRefusing })
  check('S3h a rejection inside mercury.parallel is named the same way', /^bridge call \d \(Missing\) failed: /m.test(s3d.error ?? ''), brief(s3d))
}

section('S4. a thrown error: name and message first, then the cell\'s own frames')
{
  const s4 = await run("const n = 1\nfunction blow() { throw new TypeError('boom') }\nblow()")
  check('S4a the first line is the error, not an echo of the source', /^TypeError: boom\n/.test(s4.error ?? ''), brief(s4))
  check('S4b the throwing function and its line', new RegExp(`^\\s+at blow \\(${s4.cellId}\\.js:2:\\d+\\)`, 'm').test(s4.error ?? ''), brief(s4))
  check('S4c no worker-internal frames', !WORKER_FRAME.test(s4.error ?? ''), brief(s4))
  const s5 = await run("const a = await Promise.resolve(1)\nconst b = 2\nthrow new RangeError('late')")
  check('S5 a throw in a top-level-await cell reports the cell\'s own line', /^RangeError: late\n/.test(s5.error ?? '') && new RegExp(`^\\s+at .*${s5.cellId}\\.js:3:\\d+`, 'm').test(s5.error ?? ''), brief(s5))
  const s6 = await run('throw { code: 7 }')
  check('S6 a thrown non-error is shown, never [object Object]', /code: 7/.test(s6.error ?? '') && !/\[object Object\]/.test(s6.error ?? ''), brief(s6))
  const s7 = await run("throw new Error('x'.repeat(6000))")
  check('S7 a long message is bounded with the head first', /^Error: xxxx/.test(s7.error ?? '') && (s7.error ?? '').length <= 4000, `length=${s7.error?.length}`)
}

section('S8. through the tool: a nested tool\'s refusal reaches the cell without the transcript wrapper')
{
  const { WorkshopTool } = await import('../../src/tools/WorkshopTool/WorkshopTool.ts')
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const target = join(workDir, 'unread.txt')
  writeFileSync(target, 'one\ntwo\nthree\n')
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' },
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    speculation: { status: 'idle' },
  }
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map(),
    nestedMemoryAttachmentTriggers: new Set(),
    dynamicSkillDirTriggers: new Set(),
    userModified: false,
    updateFileHistoryState: () => {},
    options: { tools: [FileReadTool, FileEditTool, WorkshopTool], mcpClients: [], isNonInteractiveSession: true },
  }
  const ALLOW = async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })
  const PARENT = { uuid: 'ws-parent', requestId: 'ws-req', message: { id: 'ws-msg' } }
  const out = await (WorkshopTool as { call: Function }).call(
    { cells: [{ language: 'js', code: `await mercury.tool('Edit', { file_path: ${JSON.stringify(target)}, old_string: 'two', new_string: 'deux' })` }] },
    ctx,
    ALLOW,
    PARENT,
  )
  const cell = out.data.cells[0]
  check('S8a the cell failed on its one bridge call, named as the Edit', cell.state === 'failed' && cell.nestedCalls === 1 && /^bridge call 1 \(Edit\) failed: \S/m.test(cell.error ?? ''), brief(cell))
  check('S8b the refusal\'s words are carried bare: no <tool_use_error> wrapper', !(cell.error ?? '').includes('<tool_use_error>') && !(cell.error ?? '').includes('</tool_use_error>'), brief(cell))
  check('S8c the rendered result carries the same first line', /^error: bridge call 1 \(Edit\) failed: /m.test(out.data.result), JSON.stringify(out.data.result.slice(0, 300)))
  const recursive = await (WorkshopTool as { call: Function }).call(
    { cells: [{ language: 'js', code: "await mercury.tool('Workshop', { cells: [] })" }] },
    { ...ctx, abortController: new AbortController() },
    ALLOW,
    PARENT,
  )
  check('S8d the recursion refusal keeps its words under the bridge-call head', /^bridge call 1 \(Workshop\) failed: recursive Workshop calls are refused/m.test(recursive.data.cells[0].error ?? ''), brief(recursive.data.cells[0]))
}

section('S9. the runtime hands a bridge value object to the cell unchanged, and a rejection still stops it')
{
  const valued = {
    ...refusing,
    tool: async (name: string) => {
      if (name === 'Bash') return { code: 1, stdout: 'out-line\nerr-line\n\nExited with code 1', stderr: '' }
      throw new Error(`no tool '${name}' in this session's catalog`)
    },
  }
  const s9 = await run("const r = await mercury.tool('Bash', { command: 'exit 1' })\nJSON.stringify([r.code, r.stdout.split('\\n')[1], r.stderr])", { bridge: valued })
  check('S9a a value object crosses the worker boundary whole: code, stdout and stderr read in the cell', s9.state === 'succeeded' && s9.valuePreview === "'[1,\"err-line\",\"\"]'" && s9.nestedCalls === 1, JSON.stringify(s9).slice(0, 300))
  const s9b = await run("await mercury.tool('Missing', {})", { bridge: valued })
  check('S9b a rejected call still fails the cell at that call', s9b.state === 'failed' && /^bridge call 1 \(Missing\) failed: no tool 'Missing'/m.test(s9b.error ?? ''), brief(s9b))
}

disposeOwner(owner)
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ workshop cell errors: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ workshop cell errors: every law holds')
process.exit(0)
