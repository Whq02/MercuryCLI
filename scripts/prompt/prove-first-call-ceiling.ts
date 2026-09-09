#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')
const dist = join(root, 'dist', 'mercury.mjs')
const node = join(root, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const rare = ['Service', 'Inspect', 'AstEdit', 'AstSearch', 'Sleep', 'TeamBrief', 'Checkpoint', 'ArtifactsList', 'Rewind']
let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}`)
}
check('the built product and its runtime are present', existsSync(dist) && existsSync(node))
if (!existsSync(dist) || !existsSync(node)) process.exit(1)
const captured: Array<{ route: string; body: Record<string, any> }> = []
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const usage = { input_tokens: 8, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', supported_reasoning_levels: ['high'], default_reasoning_level: 'high', visibility: 'list', supported_in_api: true, context_window: 272000, input_modalities: ['text', 'image'] }] }))
      return
    }
    if (request.method !== 'POST' || (!path.endsWith('/responses') && !path.endsWith('/messages'))) {
      response.writeHead(404)
      response.end('{}')
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const route = path.endsWith('/responses') ? 'openai' : 'anthropic'
    captured.push({ route, body })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (route === 'openai') {
      response.end([
        sse({ type: 'response.created', response: { id: 'resp_ceiling' } }),
        sse({ type: 'response.output_text.delta', delta: 'FIRST-CALL-DONE' }),
        sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIRST-CALL-DONE' }] } }),
        sse({ type: 'response.completed', response: { id: 'resp_ceiling', usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } }),
      ].join(''))
      return
    }
    const events = [
      ['message_start', { message: { id: 'msg_ceiling', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'FIRST-CALL-DONE' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }],
      ['message_stop', {}],
    ] as const
    response.end(events.map(([type, event]) => `event: ${type}\n${sse({ type, ...event })}`).join(''))
  })
})
await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
const base = `http://127.0.0.1:${address.port}`
try {
  for (const route of ['anthropic', 'openai']) {
    const home = mkdtempSync(join(tmpdir(), 'request-ceiling-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'request-ceiling-project-'))
    mkdirSync(join(home, 'user-home'))
    writeFileSync(join(cwd, 'README.md'), '# Fixture project\n')
    const key = 'sk-request-ceiling-fixture-only'
    writeFileSync(join(home, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] } }))
    writeFileSync(join(home, 'settings.json'), '{}')
    const model = route === 'anthropic' ? 'claude-fable-5-1' : 'gpt-6-astra'
    const env: Record<string, string> = {
      HOME: join(home, 'user-home'),
      PATH: [dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(process.platform === 'win32' ? ';' : ':'),
      TERM: 'dumb', NO_COLOR: '1', LANG: 'en_US.UTF-8',
      MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0',
      ANTHROPIC_BASE_URL: base,
      ...(route === 'anthropic' ? { ANTHROPIC_API_KEY: key, MERCURY_TOOL_SEARCH: 'on' } : { OPENAI_API_KEY: key, MERCURY_OPENAI_API_BASE: `${base}/openai/v1`, MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`, MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth` }),
    }
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveRun => {
      const child = spawn(node, [dist, '-p', 'Read README.md and state its first heading.', '--model', model, '--output-format', 'stream-json', '--permission-mode', 'default', '--max-turns', '2'], { cwd, env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', data => { stdout += data })
      child.stderr.on('data', data => { stderr += data })
      const deadline = setTimeout(() => child.kill('SIGKILL'), 60000)
      child.on('close', code => { clearTimeout(deadline); resolveRun({ code, stdout, stderr }) })
    })
    check(`${route}: the built product completes its fixture turn`, result.code === 0 && result.stdout.includes('FIRST-CALL-DONE'), result.stderr.slice(-300))
    const requests = captured.filter(request => request.route === route)
    check(`${route}: exactly one main request is captured`, requests.length === 1, String(requests.length))
    const body = requests[0]?.body
    if (!body) continue
    const normalize = (value: string) => value.replaceAll(home, '<home>').replaceAll(cwd, '<project>')
    const bytes = (value: unknown) => Buffer.byteLength(normalize(JSON.stringify(value)), 'utf8')
    const tools = body.tools as Array<Record<string, any>>
    const eager = tools.filter(tool => tool.defer_loading !== true)
    const system = route === 'anthropic' ? body.system.map((block: any) => block.text).join('') : body.instructions
    const messages = route === 'anthropic' ? body.messages : body.input
    const reminderTexts = messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).map((block: any) => block.text).filter((text: unknown) => typeof text === 'string' && text.startsWith('<system-reminder>'))
    const systemBytes = Buffer.byteLength(normalize(system), 'utf8')
    const eagerBytes = eager.reduce((total, tool) => total + bytes(tool), 0)
    const attachmentBytes = reminderTexts.reduce((total: number, text: string) => total + Buffer.byteLength(normalize(text), 'utf8'), 0)
    check(`${route}: system text stays under 27000 bytes`, systemBytes <= 27000, String(systemBytes))
    check(`${route}: initial definitions stay under 45000 bytes`, eagerBytes <= 45000, String(eagerBytes))
    check(`${route}: at most twelve tools load initially`, eager.length <= 12, String(eager.length))
    check(`${route}: initial attachments stay under 6800 bytes`, attachmentBytes <= 6800, String(attachmentBytes))
    check(`${route}: the complete request stays within its byte ceiling`, bytes(body) <= (route === 'anthropic' ? 235000 : 81000), String(bytes(body)))
    check(`${route}: daily file and execution tools remain loaded`, ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Agent', 'ToolSearch'].every(name => eager.some(tool => tool.name === name)))
    check(`${route}: rare tools remain discoverable without loading initially`, rare.every(name => !eager.some(tool => tool.name === name) && reminderTexts.some((text: string) => text.split('\n').includes(name))))
  }
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
}
process.exit(failures === 0 ? 0 : 1)
