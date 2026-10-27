import '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv } from '../daemon/dupline-world.ts'
import { frameLines } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_TOOL_SEARCH
delete process.env.MERCURY_TOOL_DEFER

const { displayToolName, TOOL_NAME_DISPLAY_LIMIT } = await import('../../src/utils/toolNameDisplay.ts')
const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { gateToolCall, toolCallRefusalDiagnostic, toolCallRefusalNote, toolCallRefusalResultText, toolCallRefusalCorrection } = await import('../../src/services/providers/toolCallGate.ts')
const { itemRowsOf, refusedCallRowsOf } = await import('../../src/rows/project.ts')
const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the unknown-tool-name proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const LONG = 'Writ' + 'e'.repeat(199_996)
const SHORT = 'Writee'
const HEAD = `${LONG.slice(0, TOOL_NAME_DISPLAY_LIMIT)}…`

type FakeTool = Record<string, unknown> & { name: string }
function makeTool(name: string): FakeTool {
  return {
    name,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: undefined }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', content: typeof data === 'string' ? data : j(data), tool_use_id: id }),
    call: async () => ({ data: `${name} ran` }),
  }
}
function makeContext(tools: FakeTool[]): Record<string, unknown> {
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as never },
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map(),
    options: { tools, mcpClients: [], isNonInteractiveSession: true },
  }
}
const ASSISTANT = { uuid: 'uuid-bound', requestId: 'req_bound', message: { id: 'msg_bound' } } as never
const ALLOW = async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })
type Block = { type: string; content?: unknown; is_error?: boolean }
async function call(tools: FakeTool[], name: string): Promise<{ text: string; isError: boolean }> {
  let result: Block | undefined
  for await (const update of runToolUse({ type: 'tool_use', id: 'toolu_bound', name, input: {} } as never, ASSISTANT, ALLOW as never, makeContext(tools) as never)) {
    const content = (update as { message?: { message?: { content?: Block[] } } }).message?.message?.content
    const block = Array.isArray(content) ? content.find(b => b.type === 'tool_result') : undefined
    if (block !== undefined) result = block
  }
  return { text: String(result?.content ?? ''), isError: result?.is_error === true }
}
const ROSTER = (): FakeTool[] => [makeTool('Read'), makeTool('Write'), makeTool('Bash'), makeTool('Grep')]

console.log('============================================================')
console.log(' An unknown tool name is echoed bounded — result, row, log')
console.log('============================================================')

section('§1 the one display bound')
{
  check(`the limit is ${TOOL_NAME_DISPLAY_LIMIT} characters`, TOOL_NAME_DISPLAY_LIMIT === 120)
  check('a 200,000-character name shows as its first 120 characters and an ellipsis', displayToolName(LONG) === HEAD && displayToolName(LONG).length === 121, j(displayToolName(LONG).length))
  check('a 30-character name is unchanged', displayToolName('a'.repeat(30)) === 'a'.repeat(30))
  check('a 120-character name is unchanged', displayToolName('b'.repeat(120)) === 'b'.repeat(120))
  check('a 121-character name is cut to 120 and the ellipsis', displayToolName('c'.repeat(121)) === `${'c'.repeat(120)}…`)
  check('an MCP-style name is unchanged', displayToolName('mcp__ext_filmcraft_app__craft_connect') === 'mcp__ext_filmcraft_app__craft_connect')
  const astral = `${'d'.repeat(119)}🚀${'e'.repeat(50)}`
  check('the cut never splits a surrogate pair', displayToolName(astral) === `${'d'.repeat(119)}🚀…`, j(displayToolName(astral)))
  check('the empty name stays empty', displayToolName('') === '')
}

section('§2 the executor\'s refusal (the tool_result the model reads)')
{
  const long = await call(ROSTER(), LONG)
  check('a 200,000-character unknown name answers an error result', long.isError, j(long.isError))
  check('…whose text is under 400 characters', long.text.length < 400, `length ${long.text.length}`)
  check('…and opens with the bounded name', long.text.includes(`No such tool available: ${HEAD}.`), long.text.slice(0, 200))
  check('…never carrying the whole name', !long.text.includes(LONG.slice(0, 1000)))
  const short = await call(ROSTER(), SHORT)
  check('a 30-character unknown name is echoed whole', short.isError && short.text.includes(`No such tool available: ${SHORT}.`), short.text)
  check('…and the Did-you-mean suggestion still names the closest tool', short.text.includes('Did you mean `Write`?'), short.text)
  const far = await call(ROSTER(), 'Rea')
  check('a near miss of Read still suggests Read', far.text.includes('Did you mean `Read`?'), far.text)
}

section('§3 the transport gate: the refusal\'s reason, note, result text, correction and debug line')
{
  const tools = ROSTER() as never
  const verdict = gateToolCall(tools, { id: 'call_0', name: LONG, argumentsRaw: '{}', malformed: false })
  check('the gate refuses the call as unknown-tool', !verdict.ok && verdict.refusal.code === 'unknown-tool', j(verdict.ok))
  if (!verdict.ok) {
    const refusal = verdict.refusal
    check('the refusal record keeps the whole name (pairing is unchanged)', refusal.name === LONG)
    check('the reason is bounded', refusal.reason.length < 400 && refusal.reason === `No such tool available: ${HEAD}`, `length ${refusal.reason.length}`)
    const diagnostic = toolCallRefusalDiagnostic(refusal)
    check('the debug line is bounded', diagnostic.length < 600, `length ${diagnostic.length}`)
    check('the debug line names the bounded name and the code', diagnostic.startsWith(`refused tool call ${HEAD} (unknown-tool, call call_0)`), diagnostic.slice(0, 200))
    const note = toolCallRefusalNote('local', refusal)
    check('the operator note is bounded', note.length < 600 && note.includes(`No such tool available: ${HEAD} —`), `length ${note.length}`)
    const text = toolCallRefusalResultText(refusal)
    check('the result text is bounded', text.length < 400, `length ${text.length}`)
    const correction = toolCallRefusalCorrection([refusal])
    check('the correction turn is bounded', correction.length < 1_500 && correction.includes(`unknown tool ${HEAD}:`), `length ${correction.length}`)
  }
  const shortVerdict = gateToolCall(tools, { id: 'call_1', name: SHORT, argumentsRaw: '{}', malformed: false })
  check('a short unknown name rides the reason whole', !shortVerdict.ok && shortVerdict.refusal.reason === `No such tool available: ${SHORT}`, j(shortVerdict))
}

section('§4 the rows: tool_call rows carry the bounded name')
{
  const scope = { session_id: 'sess_bound', turn: 1 }
  const rows = itemRowsOf(scope, 'msg_1', [{ type: 'tool_use', id: 'call_0', name: LONG, input: {} }] as never)
  const callRow = rows.find(row => row.type === 'tool_call') as { tool?: string } | undefined
  check('the tool_call row of a model block is bounded', callRow?.tool === HEAD, j(callRow?.tool?.length))
  const refusedRows = refusedCallRowsOf(scope, 'msg_1', [{ id: 'call_0', name: LONG, argumentsRaw: '{}', argumentsLength: 2, code: 'unknown-tool', reason: `No such tool available: ${HEAD}` }], 0)
  const refusedCall = refusedRows.find(row => row.type === 'tool_call') as { tool?: string } | undefined
  check('the refused-call row is bounded', refusedCall?.tool === HEAD, j(refusedCall?.tool?.length))
  const shortRows = itemRowsOf(scope, 'msg_2', [{ type: 'tool_use', id: 'call_1', name: SHORT, input: {} }] as never)
  check('a short name rides the row whole', (shortRows.find(row => row.type === 'tool_call') as { tool?: string } | undefined)?.tool === SHORT)
  const shim = findToolForRender([] as never, LONG)
  const shown = (shim as { userFacingName?: () => string }).userFacingName?.()
  check('the interactive card of an absent tool paints the bounded name', shown === HEAD, j(shown?.length))
}

section('§5 the product: a scripted 200,000-character tool call on the built build')
{
  const MODEL = 'qwen2.5-coder:3b'
  const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'unknown-tool-name-')))
  const home = join(root, 'home')
  const cwd = join(root, 'work')
  seedScratchHome(home, cwd)
  const row = (fields: Record<string, unknown>): string => `${JSON.stringify({ model: MODEL, created_at: '2026-10-27T10:00:00.000000Z', ...fields })}\n`
  const done = (): string => row({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 900_000_000, load_duration: 50_000_000, prompt_eval_count: 420, prompt_eval_duration: 300_000_000, eval_count: 24, eval_duration: 500_000_000 })
  const toolCall = (name: string): string => row({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: {} } }] }, done: false })
  let script: string[][] = []
  const chats: string[] = []
  const jsonReply = (res: ServerResponse, body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
    })
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (url === '/api/tags') return jsonReply(res, { models: [{ name: MODEL, model: MODEL, modified_at: '2026-10-01T00:00:00Z', size: 1_900_000_000, digest: 'f'.repeat(64), details: { family: 'qwen2', families: ['qwen2'], parameter_size: '3.1B', quantization_level: 'Q4_K_M' } }] })
      if (url === '/api/version') return jsonReply(res, { version: '0.34.4' })
      if (url === '/api/ps') return jsonReply(res, { models: [] })
      if (url === '/api/show') return jsonReply(res, { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 262_144 }, parameters: 'num_ctx 262144', details: { family: 'qwen2', parameter_size: '3.1B', quantization_level: 'Q4_K_M' } })
      if (url === '/api/chat' && req.method === 'POST') {
        chats.push(body)
        const answer = script.shift() ?? [row({ message: { role: 'assistant', content: 'script exhausted' }, done: false }), done()]
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(answer.join(''))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  const base: string = await new Promise(resolve => {
    ollama.listen(0, '127.0.0.1', () => {
      const address = ollama.address()
      resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`)
    })
  })
  const port = Number(new URL(base).port)
  const env = { ...childEnv(home, port), MERCURY_LOCAL_PROBE_TARGETS: `ollama=${base}`, MERCURY_LOCAL_BASE_URL: base }
  const logFile = join(root, 'debug.log')
  const run = (name: string): Promise<{ stdout: string; code: number | null }> => {
    script = [[toolCall(name), done()], [row({ message: { role: 'assistant', content: 'done' }, done: false }), done()]]
    return new Promise(resolve => {
      const child = spawn(NODE, [DIST, 'run', '--model', `local/${MODEL}`, '--ephemeral', '--mode', 'implement', '--format', 'rows', '-d', '--log-file', logFile, 'call the tool'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', () => {})
      child.on('close', code => { clearTimeout(timer); resolve({ stdout, code }) })
      child.on('error', () => { clearTimeout(timer); resolve({ stdout, code: null }) })
    })
  }
  try {
    console.log(`build under proof: ${DIST}`)
    const spent = await run(LONG)
    const frames = frameLines(spent.stdout)
    const result = frames.find(frame => frame.type === 'tool_result') as { output?: string } | undefined
    const callLine = spent.stdout.split('\n').find(line => line.includes('"tool_call"')) ?? ''
    check('the tool_result row text is under 2,000 characters (the bounded name plus the session\'s offered-tools clause; was 201,094)', typeof result?.output === 'string' && result.output.length < 2_000, `length ${result?.output?.length ?? 'none'}`)
    check('…and names the bounded tool', typeof result?.output === 'string' && result.output.includes(`No such tool available: ${HEAD}.`), result?.output?.slice(0, 200) ?? 'none')
    check('the tool_call row is bounded (under 1,000 characters)', callLine.length > 0 && callLine.length < 1_000, `length ${callLine.length}`)
    const logSize = existsSync(logFile) ? statSync(logFile).size : -1
    check('the debug log of the run is under 64 KB (was ~410 KB)', logSize >= 0 && logSize < 65_536, `size ${logSize}`)
    check('the run completes after the model\'s closing words with exit 0', spent.code === 0, j({ code: spent.code, statuses: frames.map(frame => frame.type) }))
    const second = chats[1] ?? ''
    const rides = second.split(LONG).length - 1
    let resultTexts: string[] = []
    try {
      const parsed = JSON.parse(second) as { messages?: Array<{ role?: string; content?: unknown }> }
      resultTexts = (parsed.messages ?? []).filter(message => message.role === 'tool').map(message => String(message.content ?? ''))
    } catch {
      resultTexts = []
    }
    check('the next request\'s tool result text no longer repeats the name', chats.length === 2 && resultTexts.length === 1 && !resultTexts[0]!.includes(LONG.slice(0, 1_000)), j({ chats: chats.length, results: resultTexts.length }))
    check('the name rides back only as the model\'s own call and the wire\'s pairing field for its result (twice; was three times)', rides === 2, j({ rides }))
  } finally {
    ollama.close()
    rmSync(root, { recursive: true, force: true })
  }
}

clearTimeout(guard)
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL UNKNOWN-TOOL-NAME PROOFS PASS' : `❌ ${failures} UNKNOWN-TOOL-NAME PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
