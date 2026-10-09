#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { retryReasonWords } = await import('../../src/services/providers/streamIdleBudget.ts')
const { vshotBudgetMs } = await import('../lib/captureDriver.ts')

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this prover drives the artifact)', false)
  console.log('\nprove-retry-wait-reason-words: 1 FAILURE(S)')
  process.exit(1)
}
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const node = existsSync(vendoredNode) ? vendoredNode : 'node'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'retry-reason-')))
const home = join(SCRATCH, 'home')
const work = join(SCRATCH, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'README.md'), '# retry reason fixture\n')
seedFirstRun(home, [work])
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MERCURY_MODEL']) delete process.env[k]

const DEAD = 'http://127.0.0.1:9'
const env: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_HOME: join(home, 'proof-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_UPDATE_NOTICE: '0',
  MERCURY_MODEL: 'claude-opus-5',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: DEAD,
  MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
  BROWSER: '/usr/bin/true',
}

type Frame = Record<string, unknown>
console.log("a retry wait's reason is the cause in words — what the seat already says in its status strip — never the error's class")
const child = spawn(node, [DIST, 'run', 'say the word', '--model', 'claude-opus-5', '--format', 'rows'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
let firstRetry: Frame | null = null
child.stdout.on('data', chunk => {
  stdout += chunk.toString()
  if (firstRetry !== null) return
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let frame: Frame | null = null
    try {
      frame = JSON.parse(line) as Frame
    } catch {
      frame = null
    }
    if (frame !== null && frame.type === 'wait' && frame.state === 'retry') {
      firstRetry = frame
      child.kill('SIGTERM')
      break
    }
  }
})
child.stderr.on('data', chunk => { stderr += chunk.toString() })
const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(90_000))
await new Promise<void>(resolveRun => child.once('exit', () => resolveRun()))
clearTimeout(killer)

try {
  check('the run against a refused base reached its first retry wait row', firstRetry !== null, stderr.split('\n').filter(l => l.trim()).slice(-3).join(' | ').slice(0, 300))
  if (firstRetry !== null) {
    const reason = String(firstRetry.reason ?? '')
    const refused = retryReasonWords(null, 'connect ECONNREFUSED 127.0.0.1:9')
    check(`the reason is the seat's own cause words (${JSON.stringify(reason)})`, reason !== 'unknown' && reason !== 'server_error' && reason !== 'rate_limit' && reason !== 'authentication_failed' && reason.length > 0, reason)
    check(`the words name the refused connection the way the strip does (${JSON.stringify(refused)})`, reason === refused || /refused|unreachable|connection/.test(reason), reason)
    check('the row keeps its attempt, delay and since', typeof firstRetry.attempt === 'number' && typeof firstRetry.delay_ms === 'number' && typeof firstRetry.since_ms === 'number', JSON.stringify(firstRetry))
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-retry-wait-reason-words: ALL LAWS HOLD' : `\nprove-retry-wait-reason-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
