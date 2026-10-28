#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at >= 0 ? process.argv[at + 1]! : join(import.meta.dir, '../../dist/mercury.mjs'))
const home = mkdtempSync(join(tmpdir(), 'lean-write-road-'))
const target = join(home, 'made', 'new.txt')
const CONTENT = 'made under lean\n'
const api = await startFixtureApi([
  { kind: 'tool_use', name: 'Write', input: { file_path: target, content: CONTENT } },
  { kind: 'text', text: 'done' },
])
const env = { HOME: home, PATH: process.env.PATH, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-lean-write', ANTHROPIC_BASE_URL: api.url, TMPDIR: tmpdir(), NO_COLOR: '1' }
writeFileSync(join(home, '.config.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['fixture-key-lean-write'.slice(-20)] }, projects: { [home]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!ok) failures++
}
async function run(argv: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn('node', [dist, ...argv], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', data => { out += data })
  child.stderr.on('data', data => { err += data })
  child.stdin.on('error', () => {})
  child.stdin.end()
  const clock = setTimeout(() => child.kill('SIGKILL'), 120_000)
  return new Promise((resolveRun, reject) => {
    child.on('error', error => { clearTimeout(clock); reject(error) })
    child.on('close', code => { clearTimeout(clock); resolveRun({ code, out, err }) })
  })
}
type Body = { tools?: Array<{ name: string; description?: string }>; messages?: Array<{ role: string; content: unknown }> }
const toolResults = (body: Body | undefined): Array<{ tool_use_id?: string; is_error?: boolean; content?: unknown }> =>
  (body?.messages ?? []).flatMap(m => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>).filter(b => b.type === 'tool_result') : []))

try {
  console.log('§1 a create-a-file turn under --lean: the model is offered Write, told to use it, and the file lands')
  const answer = await run(['run', 'create a new file', '--lean', '--ephemeral', '--sovereign'])
  const requests = api.messageRequests()
  const first = requests[0]?.body as Body | undefined
  const names = (first?.tools ?? []).map(tool => tool.name)
  check('the lean roster offers Bash, Read, Edit and Write', ['Bash', 'Read', 'Edit', 'Write'].every(name => names.includes(name)), names.join(','))
  check('the lean roster stays lean: no Glob, Grep, Crewmate, Web or LSP tools', !names.some(name => ['Glob', 'Grep', 'Crewmate', 'WebFetch', 'WebSearch', 'LspRead'].includes(name)), names.join(','))
  const bash = (first?.tools ?? []).find(tool => tool.name === 'Bash')?.description ?? ''
  const prefer = /Prefer the dedicated tools when they fit: ([^.]+)\./.exec(bash)?.[1] ?? ''
  check('the Bash tool names only the roads lean offers: Read, Edit and Write — never Glob or Grep', prefer === 'Read to read a file, Edit to change one, Write to create one', prefer || bash.slice(0, 200))
  check('the run answered', answer.code === 0 && answer.out.trim() === 'done', JSON.stringify(answer).slice(0, 300))
  check('Write created the file with the content the model gave', existsSync(target) && readFileSync(target, 'utf8') === CONTENT, existsSync(target) ? readFileSync(target, 'utf8') : 'no file')
  const results = toolResults(requests[1]?.body as Body | undefined)
  check('the Write call came back to the model as a success, not an unknown tool', results.length === 1 && results[0]!.is_error !== true && !JSON.stringify(results[0]!.content).includes('No such tool'), JSON.stringify(results).slice(0, 300))
  check('two requests: the Write turn and the answer, nothing retried', requests.length === 2, String(requests.length))
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`\nprove-lean-write-road: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
