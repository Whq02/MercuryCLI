import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dist = join(root, 'dist', 'mercury.mjs')
const ptydrive = join(root, 'scripts', 'streaming', 'ptydrive.py')
if (!existsSync(dist)) {
  console.error(`missing ${dist}`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`skip: posix ptydrive requires posix-pty (${driver.kind})`)
  process.exit(0)
}
const pythonBin = driver.python
const home = realpathSync(mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'paste-quick-enter-')))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPERATOR = 'sam'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { scenario, cleanupScenario, SID } = await import('../ui/renderScenarios.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

function makeBody(tag: string, multiline = false): string {
  let out = `${tag} head`
  let n = 1
  while (out.length < 860) {
    out += multiline && n % 4 === 0 ? `\r\nLine ${n} of ${tag} stays intact.` : ` Clause ${n} of ${tag} carries words.`
    n++
  }
  return `${out} ${tag} tail.`
}

const replyFor = (n: number): string => `ACK_QUICK_PASTE_${n}`
const api = await startFixtureApi(
  [1, 2, 3, 4].map(n => ({ kind: 'paced' as const, deltas: [replyFor(n)], gapMs: 0, startDelayMs: 150 })),
)

const daemonHome = join(home, 'd')
mkdirSync(daemonHome, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonHome
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_AWAY_SUMMARY: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_REDUCED_MOTION: '1',
}

let daemonLog = ''
const daemon = spawn('node', [dist, 'daemon', 'run', root], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const daemonReady = await new Promise<boolean>(settle => {
  const timer = setTimeout(() => settle(false), vshotBudgetMs(60_000))
  const onData = (chunk: Buffer): void => {
    daemonLog += String(chunk)
    if (daemonLog.includes('control socket up')) {
      clearTimeout(timer)
      settle(true)
    }
  }
  daemon.stdout.on('data', onData)
  daemon.stderr.on('data', onData)
  daemon.on('exit', () => {
    clearTimeout(timer)
    settle(false)
  })
})
check('isolated fixture daemon started', daemonReady, daemonLog.slice(-200))

async function runPty(
  name: string,
  sends: string[],
  seconds = 10,
  anchor?: string,
): Promise<{ code: number | null; stderr: string; events: Array<Record<string, unknown>> }> {
  scenario('resume-2turn', 120, 40)
  const outPath = join(home, `${name}.jsonl`)
  const args = [
    ptydrive,
    '--cols',
    '120',
    '--rows',
    '40',
    '--seconds',
    String(seconds),
    '--out',
    outPath,
    ...(anchor ? ['--anchor', anchor] : []),
    ...sends.flatMap(s => ['--send', s]),
    '--',
    'node',
    dist,
    '--resume',
    SID,
    '--model',
    'claude-sonnet-5',
  ]
  const res = await new Promise<{ code: number | null; stderr: string }>(settle => {
    const child = spawn(pythonBin, args, { cwd: root, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', c => {
      stderr += String(c)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(120_000))
    child.on('exit', code => {
      clearTimeout(timer)
      settle({ code, stderr })
    })
  })
  cleanupScenario('resume-2turn')
  const raw = existsSync(outPath) ? readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean) : []
  const events = raw.map(l => JSON.parse(l) as Record<string, unknown>)
  return { ...res, events }
}

const escapeForPtydrive = (s: string): string =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\x1b/g, '\\x1b')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')

try {
  {
    const body1 = makeBody('BRACKET_ZERO')
    const before = api.messageRequests().length
    const run1 = await runPty(
      'leg1-bracket-0ms',
      [
        `after:Type a prompt:80:\\x1b[200~${escapeForPtydrive(body1)}\\x1b[201~\\r`,
        `after:${replyFor(1)}:100:\\x03\\x03`,
      ],
      9,
    )
    const got = api.messageRequests().slice(before)
    const sentWhole = got.some(
      r =>
        JSON.stringify(r.body).includes('BRACKET_ZERO head') &&
        JSON.stringify(r.body).includes('BRACKET_ZERO tail.') &&
        !JSON.stringify(r.body).includes('[Pasted text #'),
    )
    check(
      'bracketed paste + Enter in the same PTY write (0 ms) sends the whole paste on the first Enter',
      sentWhole,
      `requests=${got.length} stderr=${run1.stderr.slice(-160)}`,
    )
  }

  {
    const body2 = makeBody('BRACKET_40MS')
    const before = api.messageRequests().length
    const run2 = await runPty(
      'leg2-bracket-40ms',
      [
        `1080:\\x1b[200~${escapeForPtydrive(body2)}\\x1b[201~`,
        `1120:\\r`,
        `after:${replyFor(2)}:100:\\x03\\x03`,
      ],
      9,
      'Type a prompt:1000',
    )
    const sentEvents = run2.events.filter(e => typeof e.sent === 'number')
    const gapMs =
      sentEvents.length >= 2 ? Number(sentEvents[1]!.sent) - Number(sentEvents[0]!.sent) : Number.POSITIVE_INFINITY
    const got = api.messageRequests().slice(before)
    const sentWhole = got.some(
      r =>
        JSON.stringify(r.body).includes('BRACKET_40MS head') &&
        JSON.stringify(r.body).includes('BRACKET_40MS tail.') &&
        !JSON.stringify(r.body).includes('[Pasted text #'),
    )
    check(
      'bracketed paste + Enter ~40 ms later (< 100 ms) sends the whole paste on the first Enter',
      gapMs >= 10 && gapMs < 95 && sentWhole,
      `gapMs=${gapMs} requests=${got.length}`,
    )
  }

  {
    const body3 = makeBody('BURST_40MS')
    const before = api.messageRequests().length
    const run3 = await runPty(
      'leg3-burst-40ms',
      [
        `1080:${escapeForPtydrive(body3)}`,
        `1120:\\r`,
        `after:${replyFor(3)}:100:\\x03\\x03`,
      ],
      9,
      'Type a prompt:1000',
    )
    const sentEvents = run3.events.filter(e => typeof e.sent === 'number')
    const gapMs =
      sentEvents.length >= 2 ? Number(sentEvents[1]!.sent) - Number(sentEvents[0]!.sent) : Number.POSITIVE_INFINITY
    const got = api.messageRequests().slice(before)
    const sentWhole = got.some(
      r =>
        JSON.stringify(r.body).includes('BURST_40MS head') &&
        JSON.stringify(r.body).includes('BURST_40MS tail.') &&
        !JSON.stringify(r.body).includes('[Pasted text #'),
    )
    check(
      'unbracketed burst paste + Enter ~40 ms later (< 100 ms) sends the whole paste on the first Enter',
      gapMs >= 10 && gapMs < 95 && sentWhole,
      `gapMs=${gapMs} requests=${got.length}`,
    )
  }

  {
    const body4 = `${makeBody('MULTILINE_SAFE', true)}\r\n`
    const before = api.messageRequests().length
    await runPty(
      'leg4-multiline-no-autosend',
      [`after:Type a prompt:80:\\x1b[200~${escapeForPtydrive(body4)}\\x1b[201~`],
      4,
    )
    const afterNoEnter = api.messageRequests().slice(before)
    check(
      'a multiline paste ending in CRLF with no following Enter stays a draft and never auto-submits',
      afterNoEnter.length === 0,
      `requests=${afterNoEnter.length}`,
    )
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {}
  daemon.kill()
  await api.close()
  cleanupScenario('resume-2turn')
  rmSync(home, { recursive: true, force: true })
}

console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
