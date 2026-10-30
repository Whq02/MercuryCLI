#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HANDOFF_ASK_MARK } from '../lib/fixtureApi.ts'

const root = resolve(import.meta.dir, '../..')
const source = process.env.PROVE_SRC ?? join(root, 'src')
const dist = process.env.PROVE_DIST ?? join(root, 'dist/mercury.mjs')
const vendored = join(root, 'dist/vendor/node/bin/node')
const node = existsSync(vendored) ? vendored : Bun.which('node')!
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const main = readFileSync(join(source, 'main.tsx'), 'utf8')
const print = main.slice(main.indexOf('async function runLaunch('))
check('runner discovery settles before the first pool snapshot', print.includes('await waitForInitialization()') && print.includes('let tools = [...getTools(') && print.indexOf('await waitForInitialization()') < print.indexOf('let tools = [...getTools('))
check('local runners keep the existing tool set', /qualifiedIdSpaceOf\(getEngineModel\(\)\)\?\.route !== 'local'/.test(print))
check('the explicit off gates runner discovery', print.includes('mercuryLspEnabled()'))
const stream = readFileSync(join(source, 'services/providers/anthropic/streamCore.ts'), 'utf8')
check('Anthropic never independently defers a mounted language service', !stream.includes('alsoDefer: shouldDeferLspTool'))
const economy = readFileSync(join(source, 'tools/ToolSearchTool/prompt.ts'), 'utf8')
check('the cloud rule names LspRead and Test, and reads the route (never the mounted state)', /ECONOMY_DEFERRED[^\n]*new Set\(\[[^\]]*'Test'[^\]]*'LspRead'[^\]]*\]\)/.test(economy) && /function defersOnCloudFor\([^)]*\)[^{]*\{\s*return isEconomyDeferred\(tool\) && onCloudRoute\(model\)/.test(economy))
if (process.argv.includes('--source-only')) process.exit(failures === 0 ? 0 : 1)
check('the built product exists', existsSync(dist))
if (!existsSync(dist)) process.exit(1)
const scratch = mkdtempSync(join(tmpdir(), 'runner-lsp-'))
const captured: any[] = []
let activeCwd = ''
const sse = (events: Array<[string, object]>): string => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('')
const toolUseEvents = (model: string, id: string, tool: { name: string; input: object }): Array<[string, object]> => {
  const usage = { input_tokens: 1, output_tokens: 1 }
  return [
    ['message_start', { message: { id: `msg_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }],
    ['content_block_start', { index: 0, content_block: { type: 'tool_use', id, name: tool.name, input: {} } }],
    ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }],
    ['message_stop', {}],
  ]
}
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (!req.url?.includes('/messages')) { res.writeHead(404); res.end('{}'); return }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    captured.push(body)
    const usage = { input_tokens: 1, output_tokens: 1 }
    const transcript = JSON.stringify(body.messages)
    const calls = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === 'tool_use').length
    if (transcript.includes('RUNNER-LSP-EDIT') && calls < 2) {
      const tool = calls === 0 ? { name: 'Read', input: { file_path: join(activeCwd, 'file.ts') } } : { name: 'Edit', input: { file_path: join(activeCwd, 'file.ts'), old_string: 'export const value = 1', new_string: 'export const value = 2' } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(toolUseEvents(body.model, `call_lsp_${calls}`, tool)))
      return
    }
    if (transcript.includes('RUNNER-LSP-LOAD') && calls < 2) {
      const tool = calls === 0 ? { name: 'ToolSearch', input: { query: 'select:LspRead' } } : { name: 'LspRead', input: { operation: 'serverStatus' } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(toolUseEvents(body.model, `call_load_${calls}`, tool)))
      return
    }
    const events: Array<[string, object]> = [
      ['message_start', { message: { id: 'msg_lsp', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'RUNNER-LSP-DONE' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }],
      ['message_stop', {}],
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(events))
  })
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const texts = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) texts(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) texts(item, out)
  return out
}
const announcementLines = (body: any): string[] => {
  for (const text of texts([body.system, body.messages])) {
    const at = text.indexOf('Deferred tools:')
    if (at === -1) continue
    const block = text.slice(at)
    const end = block.indexOf('</system-reminder>')
    return (end === -1 ? block : block.slice(0, end)).split('\n').map(line => line.trim()).filter(line => line !== '')
  }
  return []
}
const purposeLine = (lines: string[], name: string): string | undefined => lines.find(line => line.startsWith(`${name} — `) && line.length > `${name} — `.length)
const blocksOf = (message: any): any[] => Array.isArray(message?.content) ? message.content : []
const toolResultsOf = (body: any): any[] => body.messages.filter((m: any) => m.role === 'user').flatMap(blocksOf).filter((b: any) => b.type === 'tool_result')
try {
  for (const mode of ['on', 'off', 'lean', 'rows', 'edit-on', 'edit-off', 'load-on']) {
    const home = join(scratch, mode)
    const cwd = join(home, 'project')
    activeCwd = cwd
    const enabled = ['on', 'rows', 'edit-on', 'load-on'].includes(mode)
    const edits = mode.startsWith('edit-')
    const loads = mode === 'load-on'
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'file.ts'), 'export const value = 1\n')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'runner-lsp-fixture', devDependencies: { vitest: '*' } }))
    const key = 'proof-key-runner-lsp-not-real'
    writeFileSync(join(home, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 10, projects: { [cwd]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] } }))
    const env: NodeJS.ProcessEnv = {
      HOME: home, PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: 'dumb', NO_COLOR: '1',
      MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_TOOL_SEARCH: 'on',
      ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: base,
      MERCURY_LSP_SERVERS: JSON.stringify({ fixture: { command: node, args: [join(root, 'scripts/lsp/fixtures/fake-lsp-server.mjs')], extensionToLanguage: { '.fk': 'fixture' }, transport: 'stdio' } }),
      ...(!enabled && mode !== 'lean' ? { MERCURY_LSP: '0' } : {}),
    }
    const prompt = edits ? 'RUNNER-LSP-EDIT: Change value from 1 to 2 in file.ts.' : loads ? 'RUNNER-LSP-LOAD: Load LspRead and report the language servers.' : 'Reply with ready.'
    const argv = [dist, 'run', ...(mode === 'rows' ? ['--input=rows'] : [prompt]), '--format=rows', '--model', 'claude-sonnet-5', '--allowed-tools', 'Read,Edit', '--mode', 'sovereign', ...(mode === 'lean' ? ['--lean'] : [])]
    const before = captured.length
    const start = performance.now()
    const result = await new Promise<{ code: number | null; out: string; err: string }>(done => {
      const child = spawn(process.platform === 'darwin' ? '/usr/bin/time' : node, process.platform === 'darwin' ? ['-l', node, ...argv] : argv, { cwd, env })
      let out = ''; let err = ''
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { err += d })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 90000)
      child.on('close', code => { clearTimeout(timeout); done({ code, out, err }) })
      child.stdin.end(mode === 'rows' ? `${JSON.stringify({ type: 'prompt', content: 'Reply with ready.' })}\n` : '')
    })
    check(`${mode}: the real runner completes its fixture turn`, result.code === 0 && result.out.includes('RUNNER-LSP-DONE'), result.err.slice(0, 300))
    const requests = captured.slice(before).filter((body: any) => !JSON.stringify(body).includes(HANDOFF_ASK_MARK))
    const asks = captured.slice(before).length - requests.length
    const expectedRequests = edits || loads ? 3 : 1
    check(`${mode}: the expected request sequence was captured and no closing ask follows it (an unattended run leaves no note)`, requests.length === expectedRequests && asks === 0, `requests=${requests.length} asks=${asks}`)
    if (edits) check(`${mode}: the real edit completed`, readFileSync(join(cwd, 'file.ts'), 'utf8').includes('value = 2'), JSON.stringify(requests.at(-1)?.messages.slice(-2)))
    const first = requests[0]
    const tool = first?.tools?.find((t: any) => t.name === 'LspRead')
    if (!enabled) {
      check(`${mode}: LSP is absent`, tool === undefined)
    } else {
      const lines = announcementLines(first)
      const search = first?.tools?.find((t: any) => t.name === 'ToolSearch')
      const test = first?.tools?.find((t: any) => t.name === 'Test')
      check(`${mode}: LSP rides deferred on the hosted route — the discovered server mounts LspRead, the request defers it behind ToolSearch`, tool !== undefined && tool.defer_loading === true && tool.input_schema?.properties?.operation !== undefined, JSON.stringify({ present: tool !== undefined, defer_loading: tool?.defer_loading }))
      check(`${mode}: the announcement carries LspRead with its one-line purpose`, purposeLine(lines, 'LspRead') !== undefined, lines.filter(line => line.startsWith('Lsp')).join(' | '))
      check(`${mode}: Test rides deferred too, its vitest runner discovered, with its one-line purpose`, test !== undefined && test.defer_loading === true && purposeLine(lines, 'Test') !== undefined, JSON.stringify({ present: test !== undefined, defer_loading: test?.defer_loading, line: purposeLine(lines, 'Test') }))
      check(`${mode}: ToolSearch rides in full, so the deferred pair is loadable`, search !== undefined && search.defer_loading !== true && search.input_schema?.properties?.query !== undefined, JSON.stringify({ present: search !== undefined, defer_loading: search?.defer_loading }))
    }
    if (loads) {
      const admitted = toolResultsOf(requests[1]).flatMap(blocksOf).filter((b: any) => b.type === 'tool_reference').map((b: any) => b.tool_name)
      check(`${mode}: the select answered with the LspRead reference the server loads from (request 2 carries it)`, admitted.includes('LspRead'), JSON.stringify(toolResultsOf(requests[1])).slice(0, 300))
      const lspCall = requests[2]?.messages.flatMap(blocksOf).find((b: any) => b.type === 'tool_use' && b.name === 'LspRead')
      const lspResult = toolResultsOf(requests[2]).find((b: any) => b.tool_use_id === lspCall?.id)
      const resultText = texts(lspResult?.content).join('\n')
      check(`${mode}: the loaded LspRead answered a real call (serverStatus names the fixture server; request 3 carries the result)`, lspCall !== undefined && lspResult !== undefined && lspResult.is_error !== true && /fixture/.test(resultText), resultText.slice(0, 300))
      check(`${mode}: the roster never changed shape across the turn (LspRead stays a deferred entry on every request; admission rides the reference)`, requests.every((body: any) => body.tools?.find((t: any) => t.name === 'LspRead')?.defer_loading === true))
    }
    const rss = /([0-9]+)\s+maximum resident set size/.exec(result.err)?.[1]
    console.log(`[INFO] ${mode}: ${Math.round(performance.now() - start)} ms; peak RSS ${rss ?? 'unavailable'} bytes`)
  }
  process.env.MERCURY_CONFIG_DIR = scratch
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { mock } = await import('bun:test')
  mock.module(join(root, 'src/services/lsp/config.ts'), () => ({ getAllLspServers: async () => ({ servers: {}, errors: [] }) }))
  const manager = await import('../../src/services/lsp/manager.ts')
  manager.initializeLspServerManager()
  await manager.waitForInitialization()
  check('discovery with no reachable server leaves LSP absent', manager.getInitializationStatus().status === 'success' && !manager.isLspToolMounted())
  await manager.shutdownLspServerManager()
  const { defersOnCloudFor, isDeferredTool, isDeferredToolFor, loadsInFullFor } = await import('../../src/tools/ToolSearchTool/prompt.ts')
  const { LspReadTool } = await import('../../src/tools/LSPTool/LSPTool.ts')
  const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const local = 'local/qwen3-32b'
  const hosted = 'claude-sonnet-5'
  const project = join(scratch, 'on', 'project')
  check('the cloud rule reaches the hosted route and never the local one (LspRead and Test alike)', defersOnCloudFor(LspReadTool, hosted) && defersOnCloudFor(TestTool, hosted) && !defersOnCloudFor(LspReadTool, local) && !defersOnCloudFor(TestTool, local))
  const localVerdicts = runWithCwdOverride(project, () => ({
    lsp: isDeferredToolFor(LspReadTool, local),
    lspOwn: isDeferredTool(LspReadTool) && !loadsInFullFor(LspReadTool, local),
    test: isDeferredToolFor(TestTool, local),
    testOwn: isDeferredTool(TestTool) && !loadsInFullFor(TestTool, local),
    testHosted: isDeferredToolFor(TestTool, hosted),
  }))
  check('local route: each tool\'s own declaration decides, as before the cut — Test rides in full beside its discovered runner, LspRead keeps its deferrable declaration', localVerdicts.lsp === localVerdicts.lspOwn && localVerdicts.test === localVerdicts.testOwn && localVerdicts.test === false && localVerdicts.lsp === true, JSON.stringify(localVerdicts))
  check('hosted route: the same discovered runner leaves Test deferred', localVerdicts.testHosted === true)
} finally {
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
