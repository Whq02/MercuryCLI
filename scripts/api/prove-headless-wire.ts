import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'headless-wire-'))
const home = join(scratch, 'home')
const work = join(scratch, 'project')
mkdirSync(home)
mkdirSync(work)
writeFileSync(join(work, 'package.json'), '{"scripts":{"test":"node --test"}}\n')
writeFileSync(join(work, 'note.txt'), 'alpha\n')
const requests: Array<{ bytes: number; body: any }> = []
const turns = [
  { name: 'Read', arguments: { file_path: join(work, 'note.txt') } },
  { name: 'Edit', arguments: { file_path: join(work, 'note.txt'), old_string: 'alpha', new_string: 'beta' } },
  { name: 'Read', arguments: { file_path: join(work, 'note.txt') } },
]
const api = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks)
  if (!raw.length) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return }
  const body = JSON.parse(raw.toString('utf8'))
  const turn = turns[requests.length]
  requests.push({ bytes: raw.length, body })
  const delta = turn ? { role: 'assistant', reasoning_content: 'Use the requested file operation.', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: turn.name, arguments: JSON.stringify(turn.arguments) } }] } : { role: 'assistant', content: 'The note now reads beta.' }
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(data({ id: `chat_${requests.length}`, model: 'glm-5.3', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] }) + data({ id: `chat_${requests.length}`, model: 'glm-5.3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: turn ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } }) + 'data: [DONE]\n\n')
})
await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
try {
  const env = { HOME: home, PATH: process.env.PATH!, SHELL: process.env.SHELL ?? '/bin/sh', TERM: 'dumb', TMPDIR: scratch, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ZAI_API_KEY: 'fixture-zai-key', ZAI_KEY_PLAN: 'coding', MERCURY_ZAI_CODING_API_BASE: `http://127.0.0.1:${(api.address() as { port: number }).port}/api/coding/paas/v4` }
  const child = spawn('node', [join(root, 'dist/mercury.mjs'), 'run', '--format', 'rows', '--model', 'glm-5.3', '--effort', 'max', '--mode', 'flow', '-'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end('Read note.txt, replace alpha with beta, then read it to check the result.')
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  assert.equal(code, 0, output)
  assert.equal(readFileSync(join(work, 'note.txt'), 'utf8'), 'beta\n')
  assert.ok(requests.length >= 4)
  const first = requests[0]!.body
  assert.ok(first.messages[0].content.includes('running unattended'))
  assert.ok(!first.messages[0].content.includes('Write down important information from tool results'))
  assert.deepEqual(first.tools.map((tool: any) => tool.function.name).sort(), ['AstSearch', 'Bash', 'ChangeSet', 'Crewmate', 'Edit', 'Eval', 'Glob', 'Grep', 'LspRead', 'Read', 'Skill', 'Test', 'ToolSearch', 'Write'].sort())
  const announcement = first.messages.find((message: any) => typeof message.content === 'string' && message.content.startsWith('<system-reminder>\nDeferred tools:'))
  assert.ok(announcement)
  const lines = announcement.content.split('\n').slice(2, -1)
  assert.ok(lines.includes('Debug') && lines.includes('Browser') && lines.includes('AskUserQuestion'))
  assert.ok(lines.every((line: string) => !line.includes(' — ')))
  const hashes: string[] = []
  for (let i = 0; i < 4; i++) {
    const { body, bytes } = requests[i]!
    assert.equal(body.model, 'glm-5.3')
    assert.equal(body.reasoning_effort, 'max')
    assert.equal(body.thinking.type, 'enabled')
    assert.equal(body.max_tokens, 131072)
    assert.deepEqual(body.tools, first.tools)
    if (i > 0) {
      const previous = requests[i - 1]!.body
      assert.deepEqual(body.messages.slice(0, previous.messages.length), previous.messages, 'replay remains append-only')
    }
    const hash = createHash('sha256').update(JSON.stringify({ tools: body.tools, messages: body.messages.slice(0, first.messages.length) })).digest('hex')
    hashes.push(hash)
    console.log(JSON.stringify({ request: i + 1, bytes, toolBytes: Buffer.byteLength(JSON.stringify(body.tools)), prefixHash: hash }))
  }
  assert.equal(new Set(hashes).size, 1)
  const final = JSON.stringify(requests[3]!.body.messages)
  assert.equal(final.split('# Tool manual: Read').length - 1, 1)
  assert.equal(final.split('# Tool manual: Edit').length - 1, 1)
  assert.equal(output.split('\n').filter(line => line.includes('"type":"reasoning"') && line.includes('Use the requested file operation.')).length, 3)
  console.log('PASS headless request bytes, full roster, reasoning, output ceiling and frozen prefix')
} finally {
  await new Promise<void>(resolve => api.close(() => resolve()))
  rmSync(scratch, { recursive: true, force: true })
}
