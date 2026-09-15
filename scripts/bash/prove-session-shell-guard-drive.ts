#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const dist = resolve(argument('--dist') ?? join(ROOT, 'dist', 'mercury.mjs'))
const vendoredNode = join(dirname(dist), 'vendor', 'node', 'bin', 'node')
const nodeBin = existsSync(vendoredNode) ? vendoredNode : Bun.which('node')
if (!existsSync(dist) || !nodeBin) {
  console.error(`x built bundle absent: ${dist}`)
  process.exit(2)
}
if (process.platform === 'win32') {
  console.log('prove-session-shell-guard-drive: the owned daemon rides a POSIX owner pipe — nothing to drive on win32')
  process.exit(0)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'session-shell-guard-')))
const home = join(scratch, 'home')
const cwd = join(scratch, 'work')
const daemonDir = join(home, 'daemon')
mkdirSync(cwd, { recursive: true })
mkdirSync(daemonDir, { recursive: true })
seedFirstRun(home, [cwd])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipSovereignConsentPrompt: true }, null, 2))
writeFileSync(join(cwd, 'README.md'), '# guard probe\n')

const drivePins = ['MERCURY_TERMINAL_TITLE', 'MERCURY_LOCAL_PROBE_TARGETS', 'MERCURY_UPDATE_NOTICE', 'MERCURY_TURN_RECEIPT', 'MERCURY_VERIFY_EVIDENCE', 'MERCURY_LIVE_GLYPHS', 'MERCURY_LIVE_CLOCK', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_OASIS_BG', 'MERCURY_BOOT_PREFLIGHT']
const guardCommand =
  'unset ' + drivePins.join(' ') + '; ' +
  '. ' + q(join(ROOT, 'scripts', 'lib', 'suite-env.sh')) + '; ' +
  '(suite_env_guard ' + q(join(ROOT, 'scripts', 'substrate', 'run-all.sh')) + '); echo "guard rc=$?"; ' +
  'if [ -n "${MERCURY_DAEMON_SELF_WARM_CONSENT:-}" ]; then echo consent-stamp=present; else echo consent-stamp=absent; fi'
const MODEL = 'claude-opus-4-8'
const turns: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'Bash', input: { command: guardCommand, description: 'a suite guard inside the session tool shell' }, whenModel: 'opus' },
  { kind: 'text', text: 'guard-probe: done', whenModel: 'opus' },
  { kind: 'text', text: 'guard-probe: done', whenModel: 'opus' },
]
const fixture = await startFixtureApi(turns)
const env: NodeJS.ProcessEnv = {
  HOME: home,
  PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  SHELL: '/bin/bash',
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetMs(1000) / 1000),
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_UPDATE_NOTICE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_OASIS_BG: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  ANTHROPIC_BASE_URL: fixture.url,
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  OPENAI_API_KEY: '',
  OPENAI_BASE_URL: 'http://127.0.0.1:1',
  BROWSER: '/usr/bin/true',
}
const seconds = Math.ceil(vshotBudgetMs(90_000) / 1000)
const driveLog = join(scratch, 'drive.jsonl')
console.log(`session shell guard drive — bundle ${dist}\n  home ${home}\n  work ${cwd}`)
section('the screen boots with the bypass flag, spawns its owned daemon, and its first session runs the guard in the tool shell')
const startedAt = Date.now()
const outcome = await new Promise<{ exit: number | null; out: string }>(resolveRun => {
  const child = spawn(
    '/usr/bin/python3',
    [
      join(ROOT, 'scripts', 'streaming', 'ptydrive.py'),
      '--cols', '120',
      '--rows', '40',
      '--seconds', String(seconds),
      '--out', driveLog,
      '--send', 'after:↑↓ choose:900:\\r',
      '--send', 'after:Type a prompt:800:run the guard probe',
      '--send', 'after:run the guard probe:600:\\r',
      '--', nodeBin, dist, '--dangerously-bypass-permissions', '--model', MODEL,
    ],
    { cwd, env },
  )
  let out = ''
  child.stdout.on('data', d => (out += d))
  child.stderr.on('data', d => (out += d))
  child.on('close', exit => resolveRun({ exit, out }))
})
await fixture.close()
console.log(`        note: pty run exit ${outcome.exit} after ${Date.now() - startedAt}ms; ${fixture.messageRequests().length} model requests`)
const results: { text: string; isError: boolean }[] = []
const requests = fixture.messageRequests()
const last = requests[requests.length - 1]
for (const message of ((last?.body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? [])) {
  if (message.role !== 'user' || !Array.isArray(message.content)) continue
  for (const block of message.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) {
    if (block.type !== 'tool_result') continue
    const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as Array<{ text?: string }>).map(b => b.text ?? '').join('') : ''
    results.push({ text, isError: block.is_error === true })
  }
}
const result = results[0]
console.log(`        note: tool result${result === undefined ? ' absent' : result.isError ? ' (error)' : ''}: ${JSON.stringify(result?.text ?? '')}`)
const daemonLogPath = join(daemonDir, 'daemon.log')
const daemonLog = existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : ''
console.log(`        note: daemon log ${daemonLog === '' ? 'absent' : `${daemonLog.split('\n').length} lines; warm runner lines: ${daemonLog.split('\n').filter(l => l.includes('warm runner')).slice(0, 3).join(' | ')}`}`)
check('the screen spawned its own daemon into the scratch daemon dir', daemonLog !== '', daemonLogPath)
check('the session ran the guard command and its result reached the model', result !== undefined && /guard rc=\d+/.test(result.text), JSON.stringify(result))
const rc = result === undefined ? null : Number(/guard rc=(\d+)/.exec(result.text)?.[1] ?? 'NaN')
check('the suite guard admits the session tool shell (exit 0): the launch consent stamp never reaches it', rc === 0, `guard rc=${rc}`)
check('the consent stamp is absent from the tool shell', result !== undefined && result.text.includes('consent-stamp=absent'), JSON.stringify(result?.text.slice(0, 200)))
check('the refusal that named the stamp is gone', result === undefined || !result.text.includes('foreign MERCURY_* in the environment'), JSON.stringify(result?.text.slice(0, 300)))

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 8_000 }).catch(() => undefined)
await new Promise(r => setTimeout(r, 1_500))
const leftovers = spawnSync('pgrep', ['-f', scratch], { encoding: 'utf8' }).stdout.trim()
if (leftovers !== '') {
  for (const pid of leftovers.split('\n')) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch {
      void 0
    }
  }
}
console.log(`        note: processes of this run still alive after the daemon shutdown: ${leftovers === '' ? 'none' : leftovers.replace(/\n/g, ',')}`)
if (failures === 0) rmSync(scratch, { recursive: true, force: true })
else console.log(`        note: world kept for reading: ${scratch}`)
console.log(failures === 0 ? '\nOK prove-session-shell-guard-drive: 0 failures' : `\nFAIL prove-session-shell-guard-drive: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
