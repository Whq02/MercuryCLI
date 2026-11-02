import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { endProcessGroup, spawnInOwnGroup } from '../lib/processGroup.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const root = resolve(import.meta.dir, '../..')
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const dist = resolve(arg('--dist') ?? join(root, 'dist/mercury.mjs'))
const node = Bun.which('node')!
const out = arg('--out')
if (out) mkdirSync(out, { recursive: true })
if (!existsSync(dist)) throw new Error(`Build the product first: ${dist}`)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'local-runner-lsp-')))
const model = 'qwen3.5:9b'
const names = ['LspRead', 'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest']
type Frame = Record<string, any>
type Request = { model: string; tools?: Array<{ function: { name: string } }>; messages: Frame[] }
type Call = { name: string; input: Record<string, unknown> }
let calls: Call[] = []
let requests: Request[] = []
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += String(chunk) })
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: model, owned_by: 'vllm', max_model_len: 262144 }] }))
      return
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404)
      res.end('{}')
      return
    }
    const body = JSON.parse(raw) as Request
    requests.push(body)
    const call = calls[requests.length - 1]
    const sse = (delta: unknown, finish: string | null = null): string => `data: ${JSON.stringify({
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10 } } : {}),
    })}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse({ role: 'assistant' }) + sse(call
      ? { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
      : { content: 'LOCAL-LSP-DONE' }) + sse({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n')
  })
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
try {
  for (const mode of ['on', 'rows', 'off', 'lean']) {
    const home = join(scratch, mode, 'home')
    const cwd = join(scratch, mode, 'project')
    mkdirSync(cwd, { recursive: true })
    seedFirstRun(home, [cwd])
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'local-lsp-fixture', private: true }))
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }))
    writeFileSync(join(cwd, 'lib.ts'), 'export const budget = 42\n')
    writeFileSync(join(cwd, 'main.ts'), 'import { budget } from "./lib"\nexport const total = budget\n')
    symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const enabled = mode === 'on' || mode === 'rows'
    calls = enabled ? [
      { name: 'ToolSearch', input: { query: 'select:LspRead' } },
      { name: 'LspRead', input: { operation: 'serverStatus', filePath: join(cwd, 'main.ts') } },
      { name: 'LspRead', input: { operation: 'goToDefinition', filePath: join(cwd, 'main.ts'), line: 2, character: 22 } },
      { name: 'LspRead', input: { operation: 'serverStatus', filePath: join(cwd, 'main.ts') } },
    ] : []
    requests = []
    const env: NodeJS.ProcessEnv = {
      HOME: home, USERPROFILE: home, PATH: `${dirname(node)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir(), SYSTEMROOT: process.env.SYSTEMROOT,
      TERM: 'dumb', NO_COLOR: '1', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: `vllm=${base}`,
      MERCURY_BOOT_PREFLIGHT: '0', ...(mode === 'off' ? { MERCURY_LSP: '0' } : {}),
    }
    const prompt = 'Load LspRead, inspect the server status, find the definition of budget on line 2 of main.ts, and inspect the server status again.'
    const started = performance.now()
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawnInOwnGroup(node, [dist, 'run', ...(mode === 'rows' ? ['--input=rows'] : [prompt]), '--model', `local/${model}`, '--ephemeral', '--mode', 'implement', '--format', 'rows', ...(mode === 'lean' ? ['--lean'] : [])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''; let stderr = ''
      const timer = setTimeout(() => endProcessGroup(child), 90_000)
      child.stdout!.on('data', chunk => { stdout += String(chunk) })
      child.stderr!.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => { clearTimeout(timer); endProcessGroup(child); reject(error) })
      child.on('close', code => { clearTimeout(timer); endProcessGroup(child); done({ code, stdout, stderr }) })
      child.stdin!.end(mode === 'rows' ? `${JSON.stringify({ type: 'prompt', content: prompt })}\n` : '')
    })
    if (out) {
      writeFileSync(join(out, `${mode}-rows.jsonl`), result.stdout)
      writeFileSync(join(out, `${mode}-stderr.txt`), result.stderr)
      writeFileSync(join(out, `${mode}-requests.json`), JSON.stringify(requests, null, 2))
    }
    const frames: Frame[] = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    const session = frames.find(frame => frame.type === 'session')
    const pool = session?.tools ?? []
    check(`${mode}: built headless run uses the local model`, session?.model === `local/${model}`, JSON.stringify(session?.model))
    check(`${mode}: run completes`, result.code === 0 && frames.some(frame => frame.type === 'outcome' && frame.status === 'completed' && frame.answer === 'LOCAL-LSP-DONE'), `${result.code}: ${result.stderr.slice(0, 500)}`)
    check(`${mode}: only the scripted local requests run`, requests.length === calls.length + 1 && requests.every(body => body.model === model), `requests=${requests.length}`)
    const first = requests[0]
    const schemas = first?.tools?.map(tool => tool.function.name) ?? []
    const firstText = JSON.stringify(first?.messages ?? [])
    if (!enabled) {
      check(`${mode}: explicit off or lean keeps LSP absent`, names.every(name => !pool.includes(name) && !schemas.includes(name) && !firstText.includes(`${name} — `)))
      continue
    }
    check(`${mode}: the complete LSP family is in the tool pool`, names.every(name => pool.includes(name)), pool.join(', '))
    check(`${mode}: LspRead is announced but not eagerly sent as a schema`, !schemas.includes('LspRead') && firstText.includes('LspRead — ') && schemas.includes('ToolSearch'), schemas.join(', '))
    const resultOf = (id: string): Frame | undefined => frames.find(frame => frame.type === 'tool_result' && frame.call_id === id)
    const admitted = resultOf('call_1')
    check(`${mode}: ToolSearch finds LspRead`, admitted?.status === 'ok' && admitted.output.includes('LspRead') && !admitted.output.includes('Nothing was loaded'), JSON.stringify(admitted))
    const admittedText = requests[1]?.messages.find(message => message.role === 'tool' && message.tool_call_id === 'call_1')?.content ?? ''
    check(`${mode}: the local admission carries the definition in the result`, admittedText.includes('<tools>') && admittedText.includes('"name":"LspRead"') && admittedText.includes('goToDefinition'), admittedText.slice(0, 500))
    check(`${mode}: admission never changes the tools prefix`, requests.every(body => JSON.stringify(body.tools) === JSON.stringify(first?.tools)))
    const before = resultOf('call_2')
    check(`${mode}: discovery leaves the TypeScript server stopped until use`, before?.status === 'ok' && /mercury-ts — stopped/.test(before.output) && !/ — (running|starting)/.test(before.output), JSON.stringify(before))
    const definition = resultOf('call_3')
    check(`${mode}: LspRead resolves budget to lib.ts line 1`, definition?.status === 'ok' && definition.output === 'Defined in lib.ts:1:14\n    export const budget = 42', JSON.stringify(definition))
    const onWire = requests[3]?.messages.find(message => message.role === 'tool' && message.tool_call_id === 'call_3')?.content ?? ''
    check(`${mode}: the actual definition result reaches the local model`, onWire === 'Defined in lib.ts:1:14\n    export const budget = 42', onWire)
    const after = resultOf('call_4')
    check(`${mode}: the definition starts the ordinary TypeScript server`, after?.status === 'ok' && /mercury-ts — running/.test(after.output), JSON.stringify(after))
    console.log(`[INFO] ${mode}: ${Math.round(performance.now() - started)} ms`)
  }
} finally {
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  removeScratch(scratch)
}
console.log(`prove-local-runner-lsp: ${checks - failures}/${checks} passed`)
process.exit(failures === 0 ? 0 : 1)
