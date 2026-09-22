#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '../..')
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const BIN = arg('--dist') ?? join(REPO, 'dist/mercury.mjs')
const OUT = arg('--records')
const node = existsSync(join(dirname(BIN), 'vendor/node/bin/node')) ? join(dirname(BIN), 'vendor/node/bin/node') : 'node'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-family-')))
const childAsk = 'Return four for the inheritance-check fixture.'
const records: unknown[] = []
let failures = 0
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const event = (type: string, obj: unknown): string => `event: ${type}\n${sse(obj)}`
const catalogue = { models: ['gpt-5.6-sol', 'gpt-5.6-terra'].map((id, priority) => ({ id, slug: id, display_name: id, priority: priority + 1, visibility: 'public', supported_in_api: true, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 400000, input_modalities: ['text'] })) }
try {
  for (const [parent, word, expected] of [['gpt-5.6-terra', 'gpt', 'gpt-5.6-terra'], ['claude-sonnet-5', 'sonnet', 'claude-sonnet-5'], ['claude-sonnet-5', 'gpt', 'gpt-5.6-sol']]) {
    const home = join(root, `${parent}-${word}`)
    const cwd = join(home, 'project')
    mkdirSync(cwd, { recursive: true })
    seedFirstRun(home, [cwd])
    writeFileSync(join(home, 'settings.json'), '{}')
    const wire: Array<{ model: string; child: boolean; tool: boolean; url: string }> = []
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(catalogue))
        return
      }
      const chunks: Buffer[] = []
      req.on('data', part => chunks.push(part))
      req.on('end', () => {
        if (req.method !== 'POST' || (!url.includes('/responses') && !url.includes('/messages'))) { res.writeHead(404).end('{}'); return }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const items = body.input ?? body.messages ?? []
        const child = items.some((item: { role?: string; content?: unknown }) => item.role === 'user' && JSON.stringify(item.content).includes(childAsk))
        const result = items.some((item: { type?: string; content?: Array<{ type?: string }> }) => item.type === 'function_call_output' || (Array.isArray(item.content) && item.content.some(block => block.type === 'tool_result')))
        const tool = !child && !result
        wire.push({ model: body.model, child, tool, url })
        const input = { description: 'inheritance fixture', prompt: childAsk, model: word, subagent_type: 'mercury-general' }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (url.includes('/responses')) {
          res.write(sse({ type: 'response.created', response: { id: 'resp_fixture' } }))
          if (tool) res.write(sse({ type: 'response.output_item.done', item: { type: 'function_call', name: 'Agent', call_id: 'call_fixture', arguments: JSON.stringify(input) } }))
          else {
            res.write(sse({ type: 'response.output_text.delta', delta: 'four' }))
            res.write(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'four' }] } }))
          }
          res.end(sse({ type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 8, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }))
        } else {
          const usage = { input_tokens: 8, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
          res.write(event('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }))
          res.write(event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'toolu_fixture', name: 'Agent', input: {} } : { type: 'text', text: '' } }))
          res.write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'four' } }))
          res.write(event('content_block_stop', { type: 'content_block_stop', index: 0 }))
          res.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }))
          res.end(event('message_stop', { type: 'message_stop' }))
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture has no port')
    const base = `http://127.0.0.1:${address.port}`
    const env = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', OPENAI_API_KEY: 'fixture-openai-key', ANTHROPIC_BASE_URL: base, MERCURY_OPENAI_API_BASE: `${base}/openai/v1`, MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`, MERCURY_TASKS: '1', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LOCAL_PROBE_TARGETS: 'none' }
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_HOME', 'MERCURY_MODEL', 'NODE_ENV']) delete (env as Record<string, unknown>)[key]
    const proc = spawn(node, [BIN, '-p', '--model', parent!, '--output-format', 'json', '--permission-mode', 'bypassPermissions', 'Delegate the fixture arithmetic task.'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    const guard = setTimeout(() => proc.kill('SIGTERM'), vshotBudgetMs(120000))
    const rc = await new Promise<number | null>(resolve => proc.on('exit', resolve))
    clearTimeout(guard)
    await new Promise<void>(resolve => server.close(() => resolve()))
    const childModels = wire.filter(w => w.child).map(w => w.model)
    const ok = rc === 0 && wire.some(w => w.tool && w.model === parent) && childModels.length > 0 && childModels.every(model => model === expected)
    const record = { parent, word, expected, rc, childModels, wire, stdout, stderr }
    records.push(record)
    console.log(JSON.stringify(record, null, 2))
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${parent} + ${word} launches ${expected}`)
    if (!ok) failures++
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ bundle: BIN, records }, null, 2) + '\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
