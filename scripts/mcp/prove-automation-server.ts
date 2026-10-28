import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { compatRoadFixture } from '../sdk/compatRoadFixture.ts'

const root = resolve(import.meta.dir, '../..')
const binary = process.env.MERCURY_PROOF_DIST ?? join(root, 'dist/mercury.mjs')
const f = await compatRoadFixture()
const token = 'fixture-mcp-bearer-token-not-a-real-secret'
const tokenFile = join(f.home, 'mcp-token')
writeFileSync(tokenFile, token, { mode: 0o600 })
const schemaPins: Record<string, string> = {
  mercury_run: 'a127ac4ac1bf2341c45fd431cc12c96cdf8981471772ef456de5c0418fa3c040',
  mercury_session_rows: '8df32840bd8bb7cc7055e4e97e62bb080e37b06f374a85b487a764aa3cfecb1d',
  mercury_sessions: '71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892',
  mercury_send: 'c6de798730e4b3d6c696b8ea80c88c879769d1f9dbc65157ec0ef3ab2859e8aa',
  mercury_recall: '204ca8e07385edac3c8546f4bad3d92cdd7e51310a69e38a26f755b22ca10cff',
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
const clients: Client[] = []
const children: ChildProcess[] = []
const check = (label: string) => console.log(`PASS ${label}`)
const data = (result: any): any => {
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return result.structuredContent ?? JSON.parse(result.content[0].text)
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => data(await client.callTool({ name, arguments: args }, { timeout: 120_000 }))
function client(mode: 'auto' | 'legacy' = 'auto', permissions = true): Client {
  const next = new Client({ name: 'mercury-server-proof', version: '1' }, { versionNegotiation: { mode }, capabilities: permissions ? { elicitation: { form: {} } } : {} })
  clients.push(next)
  return next
}
async function http(tokenFromFile = true): Promise<{ url: string; token: string; child: ChildProcess; stderr: () => string }> {
  const child = spawn('node', [binary, 'mcp-server', '--transport', 'http', '--port', '0', '--origin', 'https://mcp.example.test', '--model', f.model, ...(tokenFromFile ? ['--token-file', tokenFile] : [])], { cwd: f.cwd, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP boot did not finish: ${stderr}`)), 30_000)
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`HTTP boot exited ${code}: ${stderr}`)) })
    child.stderr!.on('data', () => {
      const match = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(stderr)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
  })
  return { url, token: tokenFromFile ? token : /Bearer token: (\S+)/.exec(stderr)![1]!, child, stderr: () => stderr }
}

async function exercise(c: Client, label: string): Promise<void> {
  const listed = await c.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['mercury_recall', 'mercury_run', 'mercury_send', 'mercury_session_rows', 'mercury_sessions'])
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(createHash('sha256').update(JSON.stringify(canonical(tool.inputSchema))).digest('hex'), schemaPins[tool.name], `${tool.name} schema changed: ${JSON.stringify(tool.inputSchema)}`)
  }
  check(`${label} initialize and discovery`)
  const malformed = await c.callTool({ name: 'mercury_session_rows', arguments: { session_id: 'not-a-session', limit: 0 } })
  assert.equal(malformed.isError, true)
  const missing = await c.callTool({ name: 'mercury_session_rows', arguments: { session_id: randomUUID() } })
  assert.equal(missing.isError, true)
  check(`${label} schema refusal and handler failure remain tool errors`)
  const prompt = `${label}-fresh`
  f.script({ when: prompt, text: `${label}-ANSWER` })
  const result = await call(c, 'mercury_run', { prompt, model: f.model, mode: 'default' })
  assert.equal(result.source, 'stream')
  assert.ok(result.rows.some((row: any) => row.type === 'outcome' && row.status === 'completed'))
  assert.ok(result.rows.some((row: any) => row.type === 'text' && row.text.includes(`${label}-ANSWER`)))
  const rows = await call(c, 'mercury_session_rows', { session_id: result.session_id, limit: 2 })
  assert.equal(rows.rows.length, 2)
  assert.ok(rows.next_before > 0)
  const roster = await call(c, 'mercury_sessions')
  assert.ok(roster.sessions.some((row: any) => row.session_id === result.session_id))
  const recall = await call(c, 'mercury_recall', { query: 'mcp-proof-missing', limit: 3 })
  assert.deepEqual(recall.pointers, [])
  const resources = await c.listResources()
  assert.ok(resources.resources.some(row => row.uri === 'mercury://transcript'))
  const transcript = await c.readResource({ uri: `mercury://transcript/session/${result.session_id}` })
  assert.ok(JSON.stringify(transcript).includes(prompt))
  check(`${label} run, rows, sessions, recall and Inspect resources`)
  const escalated = await c.callTool({ name: 'mercury_run', arguments: { prompt: 'must not run', mode: 'sovereign' } })
  assert.equal(escalated.isError, true)
  const marker = join(f.cwd, `${label}-permission.txt`)
  let release!: (value: unknown) => void
  let asked!: () => void
  const asking = new Promise<void>(resolve => { asked = resolve })
  const permission = new Promise(resolve => { release = resolve })
  c.setRequestHandler('elicitation/create', async () => { asked(); return await permission as never })
  const heldPrompt = `${label}-held`
  f.script({ when: heldPrompt, call: { name: 'Write', input: { file_path: marker, content: 'permission fixture' } } }, { when: heldPrompt, text: 'permission-finished' })
  const turn = call(c, 'mercury_run', { prompt: heldPrompt, model: f.model, mode: 'default' })
  await Promise.race([asking, turn.then(() => { throw new Error('The write did not ask') })])
  assert.equal(existsSync(marker), false)
  const activeRoster = await call(c, 'mercury_sessions')
  const active = activeRoster.sessions.find((row: any) => row.session_id !== result.session_id && !roster.sessions.some((saved: any) => saved.session_id === row.session_id))
  assert.ok(active, 'the active session is listed')
  const sent = await call(c, 'mercury_send', { session_id: active.session_id, sender: 'fixture-bot', message: 'MCP-INBOX-LANDED', message_id: randomUUID() })
  assert.equal(sent.accepted, true)
  release({ action: 'decline' })
  await turn
  assert.equal(existsSync(marker), false)
  assert.ok(f.requests.some(request => JSON.stringify(request.body.messages).includes('MCP-INBOX-LANDED')), 'the model received the inbox message')
  check(`${label} permission denial and named-sender inbox delivery`)
  const missingSend = await c.callTool({ name: 'mercury_send', arguments: { session_id: randomUUID(), sender: 'fixture', message: 'not live' } })
  assert.equal(missingSend.isError, true)
  c.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { allow: true } }))
  const allowedPrompt = `${label}-allowed`
  f.script({ when: allowedPrompt, call: { name: 'Write', input: { file_path: marker, content: 'permission fixture' } } }, { when: allowedPrompt, text: 'allowed-finished' })
  const continued = await call(c, 'mercury_run', { session_id: result.session_id, prompt: allowedPrompt, mode: 'default' })
  assert.equal(continued.session_id, result.session_id)
  assert.equal(readFileSync(marker, 'utf8'), 'permission fixture')
  check(`${label} named session continues and an explicit permission answer reaches Write`)
}

try {
  const stdio = client()
  const pipe = new StdioClientTransport({ command: 'node', args: [binary, 'mcp-server', '--model', f.model], cwd: f.cwd, env: f.env as Record<string, string>, stderr: 'pipe' })
  let stderr = ''
  pipe.stderr?.on('data', chunk => { stderr += chunk.toString() })
  try { await stdio.connect(pipe); await exercise(stdio, 'stdio') }
  catch (error) { console.error(stderr); throw error }
  await stdio.close()
  const hosted = await http()
  const network = client()
  await network.connect(new StreamableHTTPClientTransport(new URL(hosted.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  await exercise(network, 'http')
  await assert.rejects(network.readResource({ uri: `mercury://file/${tokenFile}` }))
  const envFile = join(f.cwd, '.env')
  writeFileSync(envFile, 'DO_NOT_EXPOSE=fixture')
  await assert.rejects(network.readResource({ uri: 'mercury://file/.env' }))
  const legacy = client('legacy')
  await legacy.connect(new StdioClientTransport({ command: 'node', args: [binary, 'mcp-server', '--model', f.model], cwd: f.cwd, env: f.env as Record<string, string>, stderr: 'pipe' }))
  await exercise(legacy, 'legacy-stdio')
  const unattended = client('auto', false)
  await unattended.connect(new StreamableHTTPClientTransport(new URL(hosted.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  const noHostFile = join(f.cwd, 'no-host.txt')
  f.script({ when: 'without-host', call: { name: 'Write', input: { file_path: noHostFile, content: 'must not write' } } }, { when: 'without-host', text: 'refused' })
  const denied = await call(unattended, 'mercury_run', { prompt: 'without-host', model: f.model })
  assert.ok(denied.rows.some((row: any) => row.type === 'tool_result' && row.status === 'error' && row.output.includes('cannot answer permission requests')), JSON.stringify(denied.rows))
  assert.equal(existsSync(noHostFile), false)
  check('resources respect the project boundary and file permission rules; a host without permission forms cannot approve writes')
  for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await fetch(hosted.url, { method })).status, 401)
  assert.equal((await fetch(hosted.url, { headers: { Authorization: `Bearer ${token}`, Host: 'attacker.example' } })).status, 403)
  assert.equal((await fetch(hosted.url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://attacker.example' } })).status, 403)
  assert.ok(!hosted.stderr().includes(token))
  const publicRequest = await fetch(hosted.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Host: 'mcp.example.test', Origin: 'https://mcp.example.test', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
  assert.notEqual(publicRequest.status, 401)
  assert.notEqual(publicRequest.status, 403)
  check('HTTP token, Host and Origin checks; token file is not printed')
  const generated = await http(false)
  assert.equal((generated.stderr().match(/Bearer token:/g) ?? []).length, 1)
  assert.ok(generated.token.length >= 32)
  const generatedClient = client()
  await generatedClient.connect(new StreamableHTTPClientTransport(new URL(generated.url), { requestInit: { headers: { Authorization: `Bearer ${generated.token}` } } }))
  await generatedClient.listTools()
  check('generated token is printed once and authenticates the SDK client')
  const untrusted = join(f.home, 'untrusted')
  mkdirSync(untrusted)
  const refusal = spawn('node', [binary, 'mcp-server'], { cwd: untrusted, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let reason = ''
  refusal.stderr.on('data', chunk => { reason += chunk.toString() })
  const code = await new Promise(resolve => refusal.once('close', resolve))
  assert.notEqual(code, 0)
  assert.match(reason, /Trust this folder/)
  assert.ok(readFileSync(join(root, 'src/main.tsx'), 'utf8').includes(".description('Serve Mercury tools over MCP (stdio or authenticated HTTP)')"))
  check('untrusted startup refuses and the exact help line is pinned')
} finally {
  await Promise.allSettled(clients.map(c => c.close()))
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })))
  await f.close()
  rmSync(proofHome, { recursive: true, force: true })
}
