#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { answeredWith, frameLines, lastOutcome } from '../lib/rows.ts'

const root = resolve(import.meta.dir, '..', '..')
const dist = join(root, 'dist', 'mercury.mjs')
const vendoredNode = join(root, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const node = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'

const CEILINGS = {
  tools: 24_050,
  system: 8_600,
  attachments: 6_350,
  request: 39_550,
} as const
const ECONOMY_DEFERRED = ['Crewmate', 'Skill', 'Test', 'LspRead', 'AstSearch']
const EAGER = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Eval', 'ChangeSet', 'ToolSearch']

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}`)
}
check('the built product is present', existsSync(dist))
if (!existsSync(dist)) process.exit(1)

const captured: Array<Record<string, any>> = []
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"data":[]}')
      return
    }
    captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      sse({ id: 'chat_census', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'FIRST-CALL-DONE' } }] }),
      sse({ id: 'chat_census', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 } }),
      'data: [DONE]\n\n',
    ].join(''))
  })
})
await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
const base = `http://127.0.0.1:${address.port}`

try {
  const home = mkdtempSync(join(tmpdir(), 'briefing-bytes-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'briefing-bytes-project-'))
  mkdirSync(join(home, 'user-home'))
  writeFileSync(join(cwd, 'README.md'), '# Fixture project\n')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', devDependencies: { vitest: '*' }, scripts: { test: 'vitest run' } }))
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com', HOME: join(home, 'user-home') }
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Dev'], ['config', 'user.email', 'dev@example.com'], ['add', 'README.md', 'package.json'], ['commit', '-q', '-m', 'Initial import']]) {
    execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' })
  }
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  writeFileSync(join(home, 'settings.json'), '{}')
  const env: Record<string, string> = {
    HOME: join(home, 'user-home'),
    PATH: [dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(process.platform === 'win32' ? ';' : ':'),
    TERM: 'dumb', NO_COLOR: '1', LANG: 'en_US.UTF-8',
    MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
    ZAI_API_KEY: 'briefing-bytes-fixture-key-not-real',
  }
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveRun => {
    const child = spawn(node, [dist, 'run', 'Read README.md and state its first heading.', '--model', 'glm-5.3', '--format', 'rows', '--mode', 'default', '--max-turns', '2'], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const deadline = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.on('close', code => { clearTimeout(deadline); resolveRun({ code, stdout, stderr }) })
  })
  const outcome = lastOutcome(frameLines(result.stdout))
  check('the built product completes its fixture turn on the ZAI road — one completed outcome row carrying the answer', result.code === 0 && answeredWith(result.stdout, 'FIRST-CALL-DONE'), `${JSON.stringify(outcome ?? null)} ${result.stderr.slice(-300)}`)
  check('exactly one request is captured, the main call', captured.length === 1, `${captured.length} requests`)
  const body = captured[0]
  if (body) {
    const normalize = (value: string) => value.replaceAll(home, '<home>').replaceAll(cwd, '<project>')
    const bytes = (value: unknown) => Buffer.byteLength(normalize(JSON.stringify(value)), 'utf8')
    const tools = (body.tools as Array<{ function: { name: string; description: string; parameters: unknown } }>).map(tool => tool.function)
    const messages = body.messages as Array<{ role: string; content: string }>
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('')
    const reminders = messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<system-reminder>')).map(message => message.content)
    const toolBytes = bytes(body.tools)
    const systemBytes = Buffer.byteLength(normalize(system), 'utf8')
    const attachmentBytes = reminders.reduce((total, text) => total + Buffer.byteLength(normalize(text), 'utf8'), 0)
    const requestBytes = bytes(body)
    console.log(`  [INFO] model ${body.model} · tools ${toolBytes} B in ${tools.length} definitions · system ${systemBytes} B · attachments ${attachmentBytes} B in ${reminders.length} reminders · request ${requestBytes} B`)
    for (const tool of tools) {
      console.log(`  [INFO]   ${tool.name}: ${bytes(tool)} B (description ${Buffer.byteLength(tool.description, 'utf8')} B, parameters ${bytes(tool.parameters)} B)`)
    }
    const roster = reminders.find(text => text.includes('Deferred tools:')) ?? ''
    const rosterLines = roster.split('\n').filter(line => line !== '' && !line.startsWith('<') && !line.startsWith('Deferred tools:'))
    console.log(`  [INFO] deferred roster: ${rosterLines.length} lines, ${Buffer.byteLength(roster, 'utf8')} B`)
    check(`the tool array stays under its ceiling (${CEILINGS.tools} B)`, toolBytes <= CEILINGS.tools, `${toolBytes} B`)
    check(`the system prompt stays under its ceiling (${CEILINGS.system} B)`, systemBytes <= CEILINGS.system, `${systemBytes} B`)
    check(`the first-call attachments stay under their ceiling (${CEILINGS.attachments} B)`, attachmentBytes <= CEILINGS.attachments, `${attachmentBytes} B`)
    check(`the whole request stays under its ceiling (${CEILINGS.request} B)`, requestBytes <= CEILINGS.request, `${requestBytes} B`)
    check('the daily tools and the door ride eager', EAGER.every(name => tools.some(tool => tool.name === name)), EAGER.filter(name => !tools.some(tool => tool.name === name)).join(', '))
    check('no economy-deferred tool carries a definition on the first call', ECONOMY_DEFERRED.every(name => !tools.some(tool => tool.name === name)), ECONOMY_DEFERRED.filter(name => tools.some(tool => tool.name === name)).join(', '))
    check('each economy-deferred tool is announced on the roster with its purpose', ECONOMY_DEFERRED.every(name => rosterLines.some(line => line.startsWith(`${name} — `) && line.length > name.length + 4)), ECONOMY_DEFERRED.filter(name => !rosterLines.some(line => line.startsWith(`${name} — `))).join(', '))
  }
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
}
process.exit(failures === 0 ? 0 : 1)
