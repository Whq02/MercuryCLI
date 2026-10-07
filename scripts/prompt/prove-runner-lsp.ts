#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
if (process.argv.includes('--source-only')) process.exit(failures === 0 ? 0 : 1)
check('the built product exists', existsSync(dist))
if (!existsSync(dist)) process.exit(1)
const scratch = mkdtempSync(join(tmpdir(), 'runner-lsp-'))
const captured: any[] = []
let activeCwd = ''
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (!req.url?.includes('/messages')) { res.writeHead(404); res.end('{}'); return }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    captured.push(body)
    const usage = { input_tokens: 1, output_tokens: 1 }
    const edits = JSON.stringify(body.messages).includes('RUNNER-LSP-EDIT')
    const calls = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === 'tool_use').length
    if (edits && calls < 2) {
      const tool = calls === 0 ? { name: 'Read', input: { file_path: join(activeCwd, 'file.ts') } } : { name: 'Edit', input: { file_path: join(activeCwd, 'file.ts'), old_string: 'export const value = 1', new_string: 'export const value = 2' } }
      const events = [
        ['message_start', { message: { id: `msg_lsp_${calls}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
        ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `call_lsp_${calls}`, name: tool.name, input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }],
        ['message_stop', {}],
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''))
      return
    }
    const events = [
      ['message_start', { message: { id: 'msg_lsp', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'RUNNER-LSP-DONE' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }],
      ['message_stop', {}],
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`).join(''))
  })
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
try {
  for (const mode of ['on', 'off', 'lean', 'rows', 'edit-on', 'edit-off']) {
    const home = join(scratch, mode)
    const cwd = join(home, 'project')
    activeCwd = cwd
    const enabled = ['on', 'rows', 'edit-on'].includes(mode)
    const edits = mode.startsWith('edit-')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'file.ts'), 'export const value = 1\n')
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
    const argv = [dist, 'run', ...(mode === 'rows' ? ['--input=rows'] : [edits ? 'RUNNER-LSP-EDIT: Change value from 1 to 2 in file.ts.' : 'Reply with ready.']), '--format=rows', '--model', 'claude-sonnet-5', '--allowed-tools', 'Read,Edit', '--mode', 'sovereign', ...(mode === 'lean' ? ['--lean'] : [])]
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
    const requests = captured.slice(before)
    check(`${mode}: the expected request sequence was captured`, requests.length === (edits ? 3 : 1))
    if (edits) check(`${mode}: the real edit completed`, readFileSync(join(cwd, 'file.ts'), 'utf8').includes('value = 2'), JSON.stringify(requests.at(-1)?.messages.slice(-2)))
    const tool = requests[0]?.tools?.find((t: any) => t.name === 'LspRead')
    check(`${mode}: LSP ${enabled ? 'rides in full' : 'is absent'}`, enabled ? tool !== undefined && tool.defer_loading !== true && tool.input_schema?.properties?.operation !== undefined : tool === undefined)
    const rss = /([0-9]+)\s+maximum resident set size/.exec(result.err)?.[1]
    console.log(`[INFO] ${mode}: ${Math.round(performance.now() - start)} ms; peak RSS ${rss ?? 'unavailable'} bytes`)
  }
  process.env.MERCURY_CONFIG_DIR = scratch
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
} finally {
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
