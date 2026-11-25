#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first or name a bundle with --dist`)
  process.exit(1)
}
const FRAMES = argAfter('--frames')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond || !detail ? '' : ` — ${detail}; the prepare step is held by runWorktreePrepareCommand in src/platform/git/worktree/worktree.ts and run by runStepsHeldForTrust, which src/boot/setupScreens.tsx calls after the trust card's yes`}`)
}

const SCRATCH = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'worktree-prepare-trust-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_HOME

const git = (args: string[], cwd: string): string => {
  const run = spawnSync('git', ['-c', 'user.email=proof@example.test', '-c', 'user.name=proof', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout.trim()
}

const { guardLoginDriverWrite } = await import('../lib/loginDriverGuard.ts')
guardLoginDriverWrite('the worktree prepare drive', process.env)
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(HOME, [])

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
  MERCURY_HOME: '',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_WARM_RUNNER: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
  MERCURY_OPENAI_CHATGPT_BASE: 'http://127.0.0.1:1',
  MERCURY_OPENAI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:1',
  MERCURY_GEMINI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_DEEPSEEK_API_BASE: 'http://127.0.0.1:1',
  MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_MOONSHOT_API_BASE: 'http://127.0.0.1:1',
  MERCURY_HUGGINGFACE_API_BASE: 'http://127.0.0.1:1',
  BROWSER: '/usr/bin/true',
}
for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete childEnv[name]

function runChild(command: string, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { env: { ...childEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('exit', code => {
      clearTimeout(killer)
      resolve({ status: code, stderr })
    })
  })
}

function world(tag: string): { repo: string; sentinel: string } {
  const repo = join(SCRATCH, tag)
  const sentinel = join(SCRATCH, `${tag}.prepare-ran`)
  mkdirSync(join(repo, '.mercury'), { recursive: true })
  git(['init', '-q', '-b', 'main'], repo)
  writeFileSync(join(repo, 'README.md'), 'a repository\n')
  writeFileSync(join(repo, '.mercury', 'settings.json'), `${JSON.stringify({ workspace: { worktree: { prepare: `printf ran >> ${JSON.stringify(sentinel)}` } } })}\n`)
  git(['add', 'README.md', '.mercury/settings.json'], repo)
  git(['commit', '-q', '-m', 'first'], repo)
  return { repo, sentinel }
}

type Mark = { label: string; grid: Array<Array<{ c: string }>> }
const rowsOf = (grid: Mark['grid']): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))

async function start(tag: string, answer: string): Promise<{ status: number | null; card: string[]; sentinel: string; stderr: string } | null> {
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') {
    console.log(`  [SKIP] capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
    return null
  }
  const at = world(tag)
  const out = join(SCRATCH, `${tag}.json`)
  const cfgPath = join(SCRATCH, `${tag}-cfg.json`)
  const sends = [
    { requireAwait: true, awaitText: 'Yes, I trust this folder', minTick: 2, awaitSettleTicks: 3, data: answer, mark: 'card' },
    { afterPrevTicks: 25, data: '', mark: 'after' },
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--worktree', `o02-${tag}`], cwd: at.repo, cols: 120, rows: 40, sends, total: 120, out }))
  const res = await runChild(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], vshotBudgetMs(300_000))
  let marks: Mark[] = []
  try {
    marks = (JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }).marks ?? []
  } catch (error) {
    console.log(`  the capture of ${tag} left no frames: ${String(error)}`)
  }
  const card = marks.find(mark => mark.label === 'card')
  return { status: res.status, card: card === undefined ? [] : rowsOf(card.grid), sentinel: existsSync(at.sentinel) ? readFileSync(at.sentinel, 'utf8') : '', stderr: res.stderr.slice(-240) }
}

try {
  console.log('Y: mercury --worktree in a folder never trusted, the trust card answered yes')
  const yes = await start('yes', '\r')
  if (yes !== null) {
    check('the trust card was shown', yes.card.some(row => row.includes('Yes, I trust this folder')), `${yes.status} ${yes.stderr} ${yes.card.slice(0, 6).join(' / ')}`)
    check('the held prepare step ran after the yes, once', yes.sentinel === 'ran', `the sentinel reads ${JSON.stringify(yes.sentinel)}`)
  }
  console.log('N: the same start, the trust card answered no')
  const no = await start('no', '\x1b[B\r')
  if (no !== null) {
    check('the trust card was shown', no.card.some(row => row.includes('No, exit')), `${no.status} ${no.stderr} ${no.card.slice(0, 6).join(' / ')}`)
    check('the prepare step never ran', no.sentinel === '', `the sentinel reads ${JSON.stringify(no.sentinel)}`)
  }
} finally {
  if (!process.argv.includes('--keep')) rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? 'prove-worktree-prepare-after-trust-drive: ALL HOLD' : `prove-worktree-prepare-after-trust-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
