#!/usr/bin/env bun
// ============================================================================
//  scripts/headless/prove-bash-line-in-flight.ts — a bash-mode line is a
//  turn. Over the REAL dist on the stream-json protocol:
//
//    §1 initialize is acknowledged;
//    §2 a bash-mode user frame RUNS as a shell in the session's own process
//       (its stdout lands in the session transcript under the bash tags),
//       settles as result:success, and the runner lives on;
//    §3 a running shell holds the turn OPEN — busy over the wire: no result
//       lands while the shell runs — and an interrupt frame kills the shell
//       promptly, settles the turn, and lands the interrupted receipt row;
//    §4 a prompt-mode turn runs afterwards; the model never saw the shell
//       lines; stdin end exits 0.
//
//  The defect this pins: the driver's dequeue gate admitted only prompt,
//  orphaned-permission and task-notification, so a `!` line threw, wrote an
//  error result and shut the runner down — the seat's busy edge (delivery
//  to result) fell within milliseconds, the footer never named esc, Esc
//  reached nothing, and the shell never ran. Past the gate the turn never
//  handed the composer mode to the engine, so the line would have gone to
//  the model as words.
//
//  Requires the prebuilt dist and node on PATH. Run:
//    ~/.bun/bin/bun run scripts/headless/prove-bash-line-in-flight.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'
import { INTERRUPT_MESSAGE } from '../../src/utils/messages/rejectionText.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const settle = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))

if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — bash-line-in-flight exceeded 150s')
  process.exit(1)
}, 150_000)
guard.unref?.()

type Envelope = Record<string, unknown> & { type: string; subtype?: string }

/** The session transcript: `<config home>/projects/<slug>/<session id>.jsonl`
 *  — located by name under the config home, whatever the slug. */
function findTranscript(dir: string, sessionId: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      const hit = findTranscript(full, sessionId)
      if (hit !== null) return hit
    } else if (name === `${sessionId}.jsonl`) {
      return full
    }
  }
  return null
}

/** Poll the transcript for a needle — the writer lands rows on its own
 *  timer, so a row can trail the wire frame by a beat. */
async function transcriptCarries(dir: string, sessionId: string, needle: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const path = findTranscript(dir, sessionId)
    if (path !== null) {
      try {
        if (readFileSync(path, 'utf8').includes(needle)) return true
      } catch {
        /* mid-write; poll again */
      }
    }
    if (Date.now() >= until) return false
    await settle(200)
  }
}

async function drive(): Promise<void> {
  const fixture: FixtureApi = await startFixtureApi([{ kind: 'text', text: 'B-TURN-AFTER-SHELL.' }])
  const home = mkdtempSync(join(tmpdir(), 'bash-line-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bash-line-cwd-'))
  const configDir = join(home, '.claude')
  mkdirSync(configDir, { recursive: true })
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
  }

  const child = spawn(
    nodeBin!,
    [DIST, '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', 'claude-opus-4-8'],
    { cwd, env },
  )
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)

  const lines: string[] = []
  const envelopes: Envelope[] = []
  let unparseable = 0
  let buf = ''
  const waiters: Array<{ pred: (e: Envelope) => boolean; res: (e: Envelope) => void }> = []
  child.stdout.on('data', d => {
    buf += String(d)
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl === -1) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      lines.push(line)
      try {
        const e = JSON.parse(line) as Envelope
        envelopes.push(e)
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.pred(e)) {
            const w = waiters.splice(i, 1)[0]!
            w.res(e)
          }
        }
      } catch {
        unparseable++
      }
    }
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  let exitedEarly = false
  const exited = new Promise<{ exit: number | null }>(res =>
    child.on('close', exit => {
      clearTimeout(killer)
      exitedEarly = true
      res({ exit })
    }),
  )

  const waitFor = (pred: (e: Envelope) => boolean, label: string, timeoutMs = 60_000): Promise<Envelope | undefined> =>
    new Promise(res => {
      const hit = envelopes.find(pred)
      if (hit) return res(hit)
      const t = setTimeout(() => {
        console.log(`  [dbg] waitFor timeout: ${label}; envelopes=${j(envelopes.map(e => `${e.type}:${e.subtype ?? ''}`))} stderr=${stderr.slice(0, 300)}`)
        res(undefined)
      }, timeoutMs)
      waiters.push({
        pred,
        res: e => {
          clearTimeout(t)
          res(e)
        },
      })
    })
  const send = (o: unknown): void => {
    child.stdin.write(JSON.stringify(o) + '\n')
  }
  const resultCount = (): number => envelopes.filter(e => e.type === 'result').length

  // ── §1 initialize ─────────────────────────────────────────────────────────
  section('§1 — initialize')
  send({ type: 'control_request', request_id: 'req_init', request: { subtype: 'initialize' } })
  const initResp = await waitFor(e => e.type === 'control_response' && j(e).includes('req_init'), 'initialize ack')
  check('initialize is acknowledged with success', !!initResp && j(initResp).includes('"success"'), j(initResp ?? {}).slice(0, 200))

  // ── §2 a bash line runs as a shell ────────────────────────────────────────
  section('§2 — a bash-mode line runs as a shell in the session process; the runner lives on')
  const nonce = `bash-line-${randomUUID().slice(0, 8)}`
  send({ type: 'user', message: { role: 'user', content: `echo ${nonce}` }, parent_tool_use_id: null, mode: 'bash', uuid: randomUUID() })
  const result1 = (await waitFor(e => e.type === 'result', 'the echo line result', 30_000)) as
    | (Envelope & { is_error?: boolean; session_id?: string })
    | undefined
  check(
    'the bash line settles as result:success — no refusal, no error envelope',
    result1?.subtype === 'success' && result1?.is_error !== true,
    j({ subtype: result1?.subtype, is_error: result1?.is_error, stderr: stderr.slice(0, 200) }),
  )
  check('the runner is still running after the bash line (the old gate shut it down)', !exitedEarly && child.exitCode === null)
  const initFrame = envelopes.find(e => e.type === 'system' && e.subtype === 'init') as (Envelope & { session_id?: string }) | undefined
  const sessionId = String(initFrame?.session_id ?? result1?.session_id ?? '')
  check('the turn carries a session id (system:init / result)', sessionId.length > 0)
  check(
    "the shell RAN: its stdout landed in the session transcript under the bash-stdout tag",
    await transcriptCarries(configDir, sessionId, `<bash-stdout>${nonce}`, 5_000),
    findTranscript(configDir, sessionId) === null ? 'no transcript file found' : 'stdout row absent',
  )
  check('the echoed command row carries the bash-input tag', await transcriptCarries(configDir, sessionId, `<bash-input>echo ${nonce}`, 2_000))

  // ── §3 a running shell holds the turn open; an interrupt ends it ──────────
  section('§3 — a running shell keeps the turn open (busy over the wire); an interrupt frame ends it with the receipt')
  const resultsBefore = resultCount()
  send({ type: 'user', message: { role: 'user', content: 'sleep 30' }, parent_tool_use_id: null, mode: 'bash', uuid: randomUUID() })
  await settle(1_500)
  check(
    'no result lands while the shell runs — the turn is OPEN for the shell’s duration (the seat’s busy edge)',
    resultCount() === resultsBefore && !exitedEarly,
    `${resultCount() - resultsBefore} result(s) landed within 1.5s; exited=${exitedEarly}`,
  )
  const t0 = Date.now()
  send({ type: 'control_request', request_id: 'req_int', request: { subtype: 'interrupt' } })
  const intResp = await waitFor(e => e.type === 'control_response' && j(e).includes('req_int'), 'interrupt ack', 10_000)
  check('the interrupt frame is acknowledged', !!intResp && j(intResp).includes('"success"'), j(intResp ?? {}).slice(0, 200))
  const result2 = (await waitFor(e => e.type === 'result' && e !== (result1 as unknown), 'the interrupted shell result', 15_000)) as
    | (Envelope & { is_error?: boolean })
    | undefined
  const elapsedMs = Date.now() - t0
  check('the interrupt ENDS the shell turn promptly — a result within 10s, far under the 30s sleep', !!result2 && elapsedMs < 10_000, `${elapsedMs}ms`)
  check('the interrupted shell turn settles as a result (the runner keeps its session; no error envelope)', result2?.subtype === 'success', j({ subtype: result2?.subtype }))
  check(
    `the interrupted receipt landed: the transcript carries the interrupt row (${INTERRUPT_MESSAGE})`,
    await transcriptCarries(configDir, sessionId, INTERRUPT_MESSAGE, 5_000),
  )

  // ── §4 the runner lives on ────────────────────────────────────────────────
  section('§4 — a prompt turn runs after the shell; the model never saw the shell lines; clean end')
  send({ type: 'user', message: { role: 'user', content: 'after the shell' }, parent_tool_use_id: null, uuid: randomUUID() })
  const result3 = (await waitFor(
    e => e.type === 'result' && e !== (result1 as unknown) && e !== (result2 as unknown),
    'the post-shell prompt result',
    60_000,
  )) as (Envelope & { result?: string }) | undefined
  check(
    'a prompt turn after the shell runs to result:success with the scripted text',
    result3?.subtype === 'success' && result3?.result === 'B-TURN-AFTER-SHELL.',
    j({ subtype: result3?.subtype, result: result3?.result }),
  )
  check('the model never saw the shell lines (exactly one model call in the whole drive)', fixture.messageRequests().length === 1, String(fixture.messageRequests().length))
  check(
    'no error_during_execution envelope anywhere (the old refusal shape)',
    !envelopes.some(e => e.type === 'result' && e.subtype === 'error_during_execution'),
  )
  child.stdin.end()
  const { exit } = await exited
  check('stdin end → exit 0 (the last turn succeeded)', exit === 0, `exit=${exit} stderr=${stderr.slice(0, 300)}`)
  check('every stdout line is individually JSON-parseable', unparseable === 0, `${unparseable} unparseable of ${lines.length}`)
  await fixture.close()
}

await drive()

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ BASH LINE IN FLIGHT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} BASH-LINE FAILURE(S)`)
process.exit(1)
