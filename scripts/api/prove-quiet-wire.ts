import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bindingDropsFor, handoffTurn, isHandoffRequest, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'quiet-wire-'))
const home = join(scratch, 'home')
const work = join(scratch, 'project')
mkdirSync(home)
mkdirSync(join(work, '.mercury/skills/quiet-fixture'), { recursive: true })
writeFileSync(join(work, '.mercury/skills/quiet-fixture/SKILL.md'), '---\ndescription: Inspect a fixture note.\n---\nRead the note before editing it.\n')
writeFileSync(join(work, 'notes.txt'), 'alpha\nbeta\n')
const model = 'claude-fable-5-1'
const turns: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'Read', input: { file_path: join(work, 'notes.txt') }, thinking: 'Read the note.', model },
  { kind: 'tool_use', name: 'Edit', input: { file_path: join(work, 'notes.txt'), old_string: 'beta', new_string: 'beta\ngamma' }, thinking: 'Append the requested line.', model },
  { kind: 'tool_use', name: 'Bash', input: { command: 'cat notes.txt && wc -l notes.txt', description: 'Check the edited note and line count' }, thinking: 'Check the result.', model },
  { kind: 'text', text: 'Three-step task complete.', thinking: 'The check returned three lines.', model },
  handoffTurn(),
]
const api = await startFixtureApi(turns, { bindingCheck: true, apiChecks: true, jsonForNonStream: true })
type Capture = { url: string; totalBytes: number; body: any }
const captured: Capture[] = []
const proxy = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw) captured.push({ url: request.url!, totalBytes: Buffer.byteLength(raw), body: JSON.parse(raw) })
    const upstream = await fetch(api.url + request.url, { method: request.method, headers: { 'content-type': 'application/json' }, ...(raw ? { body: raw } : {}) })
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
    for await (const chunk of upstream.body!) response.write(chunk)
    response.end()
  } catch (error) {
    response.writeHead(500)
    response.end(String(error))
  }
})
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
const port = (proxy.address() as { port: number }).port
const clean = (value: any): any => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, clean(item)])) : value
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(clean(value))).digest('hex')
try {
  const env = {
    HOME: home, PATH: process.env.PATH!, TMPDIR: scratch, TERM: 'dumb',
    MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    MERCURY_THINKING_BINDING: 'drop_block', MERCURY_TOOL_SEARCH: '0',
  }
  const child = spawn('node', [join(root, 'dist/mercury.mjs'), 'run', 'Read notes.txt, append gamma after beta, then run cat notes.txt and wc -l notes.txt to check the result.', '--model', model, '--effort', 'max', '--sovereign'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  assert.equal(code, 0, `mercury run exited ${code}, not 0; read its output below, and rebuild dist/mercury.mjs (bun run build.ts) if it is stale\n${output}`)
  assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'alpha\nbeta\ngamma\n', 'the scripted Edit did not land in notes.txt: the Read, Edit or Bash tool turn failed in the run, see the run output')
  const requests = captured.filter(request => request.url.startsWith('/v1/messages') && !request.url.includes('count_tokens') && !isHandoffRequest(request))
  assert.equal(requests.length, 4, `expected 4 model requests (read, edit, check, final text) and saw ${requests.length}; an extra or missing request means the turn loop sent or skipped a call\n${output}`)
  const first = requests[0]!.body
  let previous: any = null
  let initialUserBytes = 0
  const metrics = requests.map((request, index) => {
    const body = request.body
    assert.equal(body.model, model, `request ${index + 1} changed the model mid-task; the model must stay the one selected`)
    assert.equal(body.thinking?.type, 'adaptive', `request ${index + 1} dropped adaptive thinking; thinking must stay adaptive on every request`)
    assert.equal(body.output_config?.effort, 'max', `request ${index + 1} changed the effort from max; effort must stay as selected on every request`)
    assert.deepEqual(body.tools, first.tools, `request ${index + 1} sent a different tools array than request 1; the tool list must stay identical across the task so the cached prefix holds`)
    assert.deepEqual(body.system, first.system, `request ${index + 1} sent a different system prompt than request 1; the system prompt must stay identical across the task so the cached prefix holds`)
    assert.equal(body.max_tokens, first.max_tokens, `request ${index + 1} changed max_tokens from request 1; it must stay constant across the task`)
    assert.deepEqual(bindingDropsFor(body), [], `request ${index + 1} dropped a thinking block the model had bound; thinking blocks must be replayed, not dropped`)
    if (previous) assert.deepEqual(clean(body.messages.slice(0, previous.messages.length)), clean(previous.messages), `every earlier message stays byte-identical; request ${index + 1} rewrote a message already sent, so the history must be append-only`)
    previous = body
    const text = body.messages.filter((message: any) => message.role === 'user').flatMap((message: any) => typeof message.content === 'string' ? [message.content] : message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text))
    const userBytes = text.reduce((n: number, item: string) => n + Buffer.byteLength(item), 0)
    if (index === 0) initialUserBytes = userBytes
    else assert.equal(userBytes, initialUserBytes, `no repeated user-context injection; request ${index + 1} carries ${userBytes} user text bytes against ${initialUserBytes} in request 1, so something re-injected context (see src/engine/attachment-shapes/userContext.ts getUserContextAttachment)`)
    assert.equal(text.filter((item: string) => item.includes('# environment')).length, 1, `request ${index + 1} carries the environment block a number of times other than one; it must appear exactly once`)
    assert.equal(text.filter((item: string) => item.includes('The skills this session offers')).length, 1, `request ${index + 1} carries the skills listing a number of times other than one; it must appear exactly once`)
    assert.ok(text.every((item: string) => !item.includes('# Tool manual:')), `unused tools carry no full manuals; request ${index + 1} sent a full tool manual for a tool not yet used, see src/engine/attachments/toolManuals.ts`)
    for (const name of ['Debug', 'Browser', 'Crewmate']) {
      const tool = body.tools.find((tool: any) => tool.name === name)
      assert.ok(tool, `request ${index + 1} has no ${name} tool in its tools array`)
      assert.ok(Buffer.byteLength(tool.description) <= 4096, `${name} exceeds the short-description ceiling of 4096 bytes; shorten that tool's description in its tool definition under src/tools`)
    }
    const allText = JSON.stringify(body.messages)
    if (index > 0) assert.equal(allText.split('Assess harm in context').length - 1, 1, `request ${index + 1} repeats the harm-assessment reminder; it must appear exactly once in the history`)
    return { request: index + 1, bytes: request.totalBytes, toolsBytes: Buffer.byteLength(JSON.stringify(body.tools)), userBlockBytes: userBytes, newUserBlockBytes: index === 0 ? userBytes : 0, prefixHash: hash({ system: body.system, tools: body.tools, messages: body.messages.slice(0, first.messages.length) }), thinkingDrops: 0, toolCount: body.tools.length }
  })
  assert.equal(new Set(metrics.map(row => row.prefixHash)).size, 1, `the cached prefix (system, tools, first messages) differs between requests; compare the prefixHash values below and find which request first changed\n${JSON.stringify(metrics.map(row => [row.request, row.prefixHash]))}`)
  console.log(JSON.stringify({ road: 'Anthropic Messages', account: 'fixture API key', selectedModel: model, servedModel: model, metrics }, null, 2))
  console.log('PASS read, edit and check preserve all tools, effort, thinking and the append-only cached prefix')
} finally {
  await new Promise<void>(resolve => proxy.close(() => resolve()))
  await api.close()
  rmSync(scratch, { recursive: true, force: true })
}
