#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { execFileSync } from 'node:child_process'

const withBash = process.argv.includes('--with-bash')
const tally = makeTally(withBash ? 'prove-git-readonly-settings --with-bash' : 'prove-git-readonly-settings')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'git-readonly-settings-')))
const repo = join(scratch, 'repo')
const runHome = join(scratch, 'mercury')
mkdirSync(repo, { recursive: true })
seedScratchHome(runHome, repo)
const MODEL = 'qwen2.5-coder:3b'
const marker = (name: string) => join(scratch, `${name}.marker`)
const names = ['diff', 'textconv', 'monitor']
const clear = () => names.forEach(name => rmSync(marker(name), { force: true }))
const script = (name: string, body: string): string => {
  const path = join(scratch, `${name}.sh`)
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(marker(name))}\n${body}\n`)
  if (process.platform !== 'win32') execFileSync('chmod', ['+x', path])
  return path
}
const envForGit = {
  ...process.env,
  HOME: scratch,
  GIT_CONFIG_GLOBAL: join(scratch, 'global-config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'proof',
  GIT_AUTHOR_EMAIL: 'proof@local',
  GIT_COMMITTER_NAME: 'proof',
  GIT_COMMITTER_EMAIL: 'proof@local',
}
const plain = (args: string[]): string => execFileSync('git', args, { cwd: repo, env: envForGit, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
plain(['init', '--quiet', '--initial-branch=main'])
writeFileSync(join(repo, '.gitattributes'), '*.txt diff=txt\n')
writeFileSync(join(repo, 'local.txt'), 'one\ntwo\n')
plain(['add', '.'])
plain(['commit', '--quiet', '-m', 'seed'])
const head = plain(['rev-parse', 'HEAD']).trim()
plain(['config', 'diff.external', script('diff', 'exit 0')])
plain(['config', 'diff.txt.textconv', script('textconv', 'cat "$1"')])
plain(['config', 'core.fsmonitor', script('monitor', 'exit 0')])
writeFileSync(join(repo, 'local.txt'), 'one\ntwo\nthree\n')
clear()
plain(['diff', 'HEAD'])
tally.check('the plain-git control runs the configured diff command', existsSync(marker('diff')))
clear()

type Call = { name: string; arguments: Record<string, unknown> }
type ChatBody = { messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] }
type Answer = string[]
const calls: Call[] = [
  { name: 'Git', arguments: { op: 'diff', scope: 'worktree' } },
  { name: 'Git', arguments: { op: 'diff', scope: 'commit', ref: head } },
  ...(withBash ? [
    { name: 'Bash', arguments: { command: 'git diff --no-color --unified=3' } },
    { name: 'Bash', arguments: { command: 'git show HEAD' } },
    { name: 'Bash', arguments: { command: 'git log -p -1' } },
    { name: 'Bash', arguments: { command: 'git status --porcelain' } },
    { name: 'Bash', arguments: { command: 'git diff --no-ext-diff --no-textconv --no-color && git status --porcelain' } },
    { name: 'Bash', arguments: { command: 'git log -p -1 | cat' } },
    { name: 'Bash', arguments: { command: 'git stash show -p' } },
  ] : []),
]
const row = (fields: Record<string, unknown>): string => `${JSON.stringify({ model: MODEL, created_at: '2026-10-27T10:00:00.000000Z', ...fields })}\n`
const done = (): string => row({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 900_000_000, load_duration: 50_000_000, prompt_eval_count: 420, prompt_eval_duration: 300_000_000, eval_count: 24, eval_duration: 500_000_000 })
const toolAnswer = (call: Call, index: number): Answer => [row({ message: { role: 'assistant', content: '', tool_calls: [{ id: `proof-call-${index}`, function: { name: call.name, arguments: call.arguments } }] }, done: false }), done()]
const textAnswer = (text: string): Answer => [row({ message: { role: 'assistant', content: text }, done: false }), done()]
const answers: Answer[] = [...calls.map((call, index) => toolAnswer(call, index)), textAnswer('Repository inspection complete.')]
const chats: ChatBody[] = []
const requests: string[] = []
const json = (res: ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', chunk => { body += String(chunk) })
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    requests.push(url)
    if (url === '/api/tags') return json(res, { models: [{ name: MODEL, model: MODEL, modified_at: '2026-10-01T00:00:00Z', size: 1_900_000_000, digest: 'f'.repeat(64), details: { family: 'qwen2', families: ['qwen2'], parameter_size: '3.1B', quantization_level: 'Q4_K_M' } }] })
    if (url === '/api/version') return json(res, { version: '0.34.4' })
    if (url === '/api/ps') return json(res, { models: [] })
    if (url === '/api/show') return json(res, { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32_768 }, parameters: '', details: { family: 'qwen2', parameter_size: '3.1B', quantization_level: 'Q4_K_M' } })
    if (url === '/api/chat' && req.method === 'POST') {
      let parsed: ChatBody = {}
      try { parsed = JSON.parse(body || '{}') as ChatBody } catch {}
      chats.push(parsed)
      const answer = answers.shift() ?? textAnswer('script exhausted')
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(answer.join(''))
      return
    }
    json(res, { error: 'not found' })
  })
})
const base: string = await new Promise(resolve => {
  ollama.listen(0, '127.0.0.1', () => {
    const address = ollama.address()
    resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`)
  })
})
const port = Number(new URL(base).port)
const env: NodeJS.ProcessEnv = { ...childEnv(runHome, port), HOME: scratch, GIT_CONFIG_GLOBAL: join(scratch, 'global-config'), GIT_CONFIG_NOSYSTEM: '1', MERCURY_LOCAL_PROBE_TARGETS: `ollama=${base}`, MERCURY_LOCAL_BASE_URL: base }
delete env.MERCURY_HOME

function run(): Promise<{ frames: Frame[]; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--model', `local/${MODEL}`, '--ephemeral', '--mode', 'default', '--format', 'rows', '-d', 'Inspect the repository and finish.'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('close', code => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr, code }) })
    child.on('error', error => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr: String(error), code: null }) })
  })
}

try {
  console.log(`build under proof: ${DIST}`)
  const spent = await run()
  const outcome = spent.frames.find(isOutcome) as { status?: string; answer?: string } | undefined
  const lastMessages = chats.flatMap(chat => chat.messages ?? [])
  const toolText = lastMessages.filter(message => message.role === 'tool').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
  tally.check('the scripted model completed every tool round with exit 0', chats.length === calls.length + 1 && answers.length === 0 && spent.code === 0 && outcome?.status === 'completed', JSON.stringify({ chats: chats.length, remaining: answers.length, code: spent.code, outcome, stderr: spent.stderr.slice(-500) }))
  tally.check('no approval row interrupted the read-only run', !spent.frames.some(frame => /ask|permission/.test(String(frame.type))), JSON.stringify(spent.frames.map(frame => frame.type)))
  tally.check('Git worktree diff returned the changed file and hunk', toolText.includes('worktree: 1 file(s), 1 hunk(s)') && toolText.includes('local.txt'), toolText.slice(0, 800))
  tally.check('Git commit diff returned its hunk', toolText.includes(`commit ${head}: 2 file(s), 2 hunk(s)`), `${toolText.slice(0, 800)} ${JSON.stringify(spent.frames.filter(frame => frame.type === 'tool_call'))}`)
  if (withBash) {
    tally.check('read-only Bash diff kept the worktree patch', toolText.includes('+three'), toolText.slice(0, 1200))
    tally.check('read-only Bash show and log kept the commit patch', (toolText.match(/\+two/g) ?? []).length >= 2, toolText.slice(0, 1200))
    tally.check('read-only Bash status returned the changed file', toolText.includes('M local.txt'), toolText.slice(0, 1200))
    tally.check('read-only stash show completed its empty-stash road', toolText.includes('No stash entries found.'), toolText.slice(-1200))
  }
  tally.check('no configured diff, text conversion, or file monitor command ran', names.every(name => !existsSync(marker(name))), names.filter(name => existsSync(marker(name))).join(', '))
  tally.check('the stand-in served chat without loading a model', chats.length > 0 && !requests.some(url => url === '/api/generate' || url === '/api/pull'), JSON.stringify(requests))
} finally {
  ollama.close()
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()
