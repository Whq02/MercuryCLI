import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const root = resolve(import.meta.dir, '..', '..')
export const dist = join(root, 'dist', 'mercury.mjs')
const vendoredNode = join(root, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
export const node = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'

export type ScriptedReply =
  | { kind: 'text'; text: string }
  | { kind: 'tool_calls'; calls: Array<{ name: string; args: Record<string, unknown> }> }

export interface ChatFunction {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>
  tools: Array<{ type: string; function: ChatFunction }>
}

export interface BriefingCapture {
  requests: ChatRequest[]
  code: number | null
  stdout: string
  stderr: string
  home: string
  cwd: string
  normalize(value: string): string
}

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

function replyBody(reply: ScriptedReply, n: number): string {
  const usage = { prompt_tokens: 8, completion_tokens: 1 }
  if (reply.kind === 'text') {
    return [
      sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: reply.text } }] }),
      sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }),
      'data: [DONE]\n\n',
    ].join('')
  }
  const calls = reply.calls.map((call, index) => ({ index, id: `call_${n}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
  return [
    sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: calls } }] }),
    sse({ id: `chat_${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }),
    'data: [DONE]\n\n',
  ].join('')
}

export async function captureBriefing(task: string, replies: ScriptedReply[], maxTurns = replies.length + 1): Promise<BriefingCapture> {
  const requests: ChatRequest[] = []
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
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest
      requests.push(body)
      const reply = replies[requests.length - 1] ?? replies[replies.length - 1] ?? { kind: 'text', text: 'FIRST-CALL-DONE' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(replyBody(reply, requests.length))
    })
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable')
  const base = `http://127.0.0.1:${address.port}`
  const home = mkdtempSync(join(tmpdir(), 'briefing-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'briefing-project-'))
  try {
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
      ZAI_API_KEY: 'briefing-fixture-key-not-real',
    }
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveRun => {
      const child = spawn(node, [dist, 'run', task, '--model', 'glm-5.3', '--format', 'rows', '--mode', 'default', '--max-turns', String(maxTurns)], { cwd, env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', data => { stdout += data })
      child.stderr.on('data', data => { stderr += data })
      const deadline = setTimeout(() => child.kill('SIGKILL'), 90000)
      child.on('close', code => { clearTimeout(deadline); resolveRun({ code, stdout, stderr }) })
    })
    return { requests, ...result, home, cwd, normalize: (value: string) => value.replaceAll(home, '<home>').replaceAll(cwd, '<project>') }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
}

export function systemTextOf(request: ChatRequest): string {
  return request.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('')
}

export function reminderTextsOf(request: ChatRequest): string[] {
  return request.messages
    .filter(message => message.role === 'user' && typeof message.content === 'string' && (message.content as string).startsWith('<system-reminder>'))
    .map(message => message.content as string)
}
