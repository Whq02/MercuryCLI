#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const FIXTURE = join(REPO, 'scripts', 'streaming', 'turn-end-fixture-server.ts')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')
if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the pin drives the BUILT runner)')
  process.exit(1)
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const HOLD_ASK = 'hold after settle'
const WITHDRAWN_WORDS = 'the words to take back'
const TAKEN_WORDS = 'the words the runner takes'
const IDLE_MS = 5_000
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'

const RUN_HOME = join(realpathSync(tmpdir()), `mercury-recall-runner-${process.pid}`)
const CWD = join(RUN_HOME, 'repo')
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
const PROBE_KEY = 'sk-ant-recall-runner-key'
writeFileSync(
  join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }),
)
writeFileSync(join(RUN_HOME, 'settings.json'), '{}')

const captureFile = join(RUN_HOME, 'wire.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn(BUN, ['run', FIXTURE, captureFile, CWD], { stdio: ['ignore', 'pipe', 'pipe'] })
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})

const env: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  MERCURY_DAEMON_DIR: join(RUN_HOME, 'daemon'),
  MERCURY_TEAMS_DIR: join(RUN_HOME, 'teams'),
  MERCURY_TABULA_DIR: join(RUN_HOME, 'tabula'),
  MERCURY_HOME: join(RUN_HOME, 'proof-home'),
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  MERCURY_STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
}
delete env.NODE_ENV
delete env.ANTHROPIC_AUTH_TOKEN

const runner = spawn('node', [DIST, '-p', '--input-format=stream-json', '--output-format=stream-json', '--model', 'claude-opus-4-8'], {
  cwd: CWD,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
const lines: Array<Record<string, unknown>> = []
const waiters: Array<{ test: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = []
let stdoutBuffer = ''
let stderrText = ''
runner.stdout.on('data', (chunk: Buffer) => {
  stdoutBuffer += chunk.toString('utf8')
  let nl: number
  while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, nl)
    stdoutBuffer = stdoutBuffer.slice(nl + 1)
    if (line.trim() === '') continue
    try {
      const frame = JSON.parse(line) as Record<string, unknown>
      lines.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.test(frame)) waiters.splice(i, 1)[0]!.resolve(frame)
      }
    } catch {
    }
  }
})
runner.stderr.on('data', (chunk: Buffer) => {
  stderrText += chunk.toString('utf8')
})
const exited = new Promise<number | null>(resolve => runner.on('exit', code => resolve(code)))
function waitFor(label: string, test: (frame: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const seen = lines.find(test)
  if (seen !== undefined) return Promise.resolve(seen)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const at = waiters.findIndex(w => w.resolve === done)
      if (at >= 0) waiters.splice(at, 1)
      console.log(`  [wait] ${label}: nothing within ${timeoutMs} ms`)
      resolve(null)
    }, timeoutMs)
    const done = (frame: Record<string, unknown>): void => {
      clearTimeout(timer)
      resolve(frame)
    }
    waiters.push({ test, resolve: done })
  })
}
const send = (frame: Record<string, unknown>): void => {
  runner.stdin.write(`${JSON.stringify(frame)}\n`)
}
const user = (text: string, uuid: string): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content: text }, uuid, session_id: '' })
const control = (requestId: string, clientMessageId: string): Record<string, unknown> => ({ type: 'control_request', request_id: requestId, request: { subtype: 'withdraw_send', client_message_id: clientMessageId } })
const responseOf = (frame: Record<string, unknown> | null): Record<string, unknown> => {
  const r = frame?.response as { subtype?: string; response?: Record<string, unknown>; error?: string } | undefined
  return r?.response ?? (r?.error !== undefined ? { error: r.error } : {})
}
const isControlResponse = (requestId: string) => (f: Record<string, unknown>): boolean => f.type === 'control_response' && (f.response as { request_id?: string } | undefined)?.request_id === requestId
const isResult = (f: Record<string, unknown>): boolean => f.type === 'result'
const isStreaming = (f: Record<string, unknown>): boolean => f.type === 'stream_event' || f.type === 'assistant'

const reap = async (): Promise<void> => {
  try {
    runner.stdin.end()
  } catch {
  }
  await Promise.race([exited, new Promise(r => setTimeout(r, 8_000))])
  try {
    runner.kill('SIGKILL')
  } catch {
  }
  try {
    fixture.kill('SIGTERM')
  } catch {
  }
}

send(user(`${HOLD_ASK} please`, '00000000-0000-4000-8000-000000000000'))
const streaming = await waitFor('the hold turn streams', isStreaming, 30_000)
section('W1 a queued identity comes back')
check('the hold turn is in flight (the runner streams the reply the fixture then holds)', streaming !== null, stderrText.split('\n').slice(-5).join(' | '))
send(user(WITHDRAWN_WORDS, U1))
await new Promise(r => setTimeout(r, 300))
send(control('w1', U1))
const w1 = responseOf(await waitFor('w1', isControlResponse('w1'), 5_000))
check('the withdraw answers withdrawn: true with the words', w1.withdrawn === true && w1.text === WITHDRAWN_WORDS, j(w1))

section('W2 a popped identity and a stranger answer unknown')
send(control('w2', U1))
const w2 = responseOf(await waitFor('w2', isControlResponse('w2'), 5_000))
check("the same identity again answers withdrawn: false, reason unknown (it never ran)", w2.withdrawn === false && w2.reason === 'unknown', j(w2))
send(control('w3', '99999999-9999-4999-8999-999999999999'))
const w3 = responseOf(await waitFor('w3', isControlResponse('w3'), 5_000))
check("a stranger's identity answers unknown", w3.withdrawn === false && w3.reason === 'unknown', j(w3))

section('W3 an identity the driver took answers taken')
send(user(TAKEN_WORDS, U2))
const firstResult = await waitFor('the hold turn ends at the budget', isResult, IDLE_MS + 30_000)
check('the hold turn ended typed at the idle budget', firstResult !== null, stderrText.split('\n').slice(-5).join(' | '))
const secondResult = await waitFor('the drained turn ends', f => isResult(f) && f !== firstResult, 30_000)
check('the queued words ran as the next turn (the driver drained them at the end)', secondResult !== null, j(lines.filter(isResult).length))
send(control('w4', U2))
const w4 = responseOf(await waitFor('w4', isControlResponse('w4'), 5_000))
check('the withdraw of a taken identity answers withdrawn: false, reason taken', w4.withdrawn === false && w4.reason === 'taken', j(w4))

section('W4 the wire, and the runner alive')
send(user('after the withdraws', '33333333-3333-4333-8333-333333333333'))
const thirdResult = await waitFor('the words after the withdraws are answered', f => isResult(f) && f !== firstResult && f !== secondResult, 30_000)
check('the runner answered words sent after the withdraws — alive', thirdResult !== null)
await reap()
type Wire = { kind: string; n?: number; ask?: string; texts?: string[]; tools?: number }
const wire: Wire[] = readFileSync(captureFile, 'utf8')
  .split('\n')
  .filter(l => l.trim() !== '')
  .map(l => JSON.parse(l) as Wire)
  .filter(w => w.kind === 'anthropic')
for (const c of wire) console.log(`  #${c.n} ask=${j((c.ask ?? '').slice(0, 60))} tools=${c.tools ?? 0}`)
const carries = (words: string): number => wire.filter(c => (c.tools ?? 0) > 0 && ((c.ask ?? '').includes(words) || j(c.texts ?? []).includes(words))).length
check('no request ever carried the withdrawn words', carries(WITHDRAWN_WORDS) === 0, `${carries(WITHDRAWN_WORDS)} requests`)
check('exactly one request carried the taken words (the drained turn)', carries(TAKEN_WORDS) === 1, `${carries(TAKEN_WORDS)} requests`)

if (failures === 0) rmSync(RUN_HOME, { recursive: true, force: true })
else {
  console.log(`[forensics] world kept: ${RUN_HOME}`)
  console.log(stderrText.split('\n').slice(-20).join('\n'))
}
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-recall-runner: ALL LAWS HOLD' : `prove-recall-runner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
