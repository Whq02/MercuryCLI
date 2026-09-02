#!/usr/bin/env bun
// ============================================================================
//  scripts/headless/prove-headless-laws.ts — the headless engine's laws.
//
//    §1 the PURE input-batching laws — joinPromptValues (string join ·
//       block normalization) and canBatchWith (prompt-mode only · workload
//       match · isMeta match)
//    §2 the STREAM-JSON CONTROL PROTOCOL over the REAL dist against the
//       fixture API — a line-driven conversation: initialize →
//       control_response(success) with the command roster; a user message →
//       system:init + assistant + result:success envelopes;
//       set_permission_mode → ack; interrupt DURING a hanging turn → ack +
//       the turn terminalizes as error_during_execution, and a prompt QUEUED
//       while it hung runs next unnudged (interrupt = read your mail now);
//       stdin end → the
//       EXIT CODE REFLECTS THE LAST TURN'S is_error (interrupted final turn
//       ⇒ exit 1 — note: the SIGINT path exits 0, the 9.4 inconsistency).
//       Every stdout line individually JSON-parseable (J2's sibling).
//
//  Requires the prebuilt dist. Run:
//    ~/.bun/bin/bun run scripts/headless/prove-headless-laws.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'

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
  console.log('\n❌ TIMEOUT — headless laws exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

// ── §1 the pure batching laws ───────────────────────────────────────────────
section('§1 — joinPromptValues / canBatchWith (pure)')
{
  const { joinPromptValues, canBatchWith } = await import('../../src/cli/print.ts')
  check('a single value passes through untouched', joinPromptValues(['solo']) === 'solo')
  check('all-strings join with newlines', joinPromptValues(['a', 'b', 'c']) === 'a\nb\nc')
  const mixed = joinPromptValues(['head', [{ type: 'text', text: 'block' }] as never])
  check(
    'any block array normalizes EVERYTHING to blocks and concatenates',
    Array.isArray(mixed) && mixed.length === 2 && j(mixed[0]).includes('head') && j(mixed[1]).includes('block'),
    j(mixed),
  )

  const head = { mode: 'prompt', workload: 'w1', isMeta: false } as never
  const mk = (over: Record<string, unknown>) =>
    ({ mode: 'prompt', workload: 'w1', isMeta: false, ...over }) as never
  check('same mode/workload/isMeta batches', canBatchWith(head, mk({})))
  check('a non-prompt command never batches', !canBatchWith(head, mk({ mode: 'local' })))
  check('a workload mismatch never batches (attribution)', !canBatchWith(head, mk({ workload: 'w2' })))
  check('an isMeta mismatch never batches (hidden-marking)', !canBatchWith(head, mk({ isMeta: true })))
  check('undefined never batches', !canBatchWith(head, undefined))
}

// ── §2 the stream-JSON control protocol over the REAL dist ────────────────
section('§2 — the control protocol: initialize · turn · set_permission_mode · interrupt · clean end')

type Envelope = Record<string, unknown> & { type: string; subtype?: string }

async function driveProtocol(): Promise<void> {
  const fixture: FixtureApi = await startFixtureApi([
    { kind: 'text', text: 'H-TURN-ONE.' },
    { kind: 'hang', deltas: ['h-stream…'] },
    { kind: 'text', text: 'H-TURN-THREE.' },
    { kind: 'hang', deltas: ['h-stream-again…'] },
  ])
  const home = mkdtempSync(join(tmpdir(), 'headless-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'headless-cwd-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.claude'),
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
  const exited = new Promise<{ exit: number | null }>(res =>
    child.on('close', exit => {
      clearTimeout(killer)
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

  // 1 — initialize
  send({ type: 'control_request', request_id: 'req_init', request: { subtype: 'initialize' } })
  const initResp = (await waitFor(
    e => e.type === 'control_response' && j(e).includes('req_init'),
    'initialize control_response',
  )) as (Envelope & { response?: { subtype?: string; request_id?: string; response?: Record<string, unknown> } }) | undefined
  check('initialize is acknowledged with a control_response', !!initResp, j(envelopes.map(e => e.type)))
  const initPayload = j(initResp ?? {})
  check('the initialize ack reports success', initPayload.includes('"success"'), initPayload.slice(0, 200))
  check('the initialize ack carries the command roster', initPayload.includes('commands'), initPayload.slice(0, 200))

  // 2 — a user turn over the fixture
  send({ type: 'user', message: { role: 'user', content: 'headless probe one' }, parent_tool_use_id: null })
  const sysInit = await waitFor(e => e.type === 'system' && e.subtype === 'init', 'system:init')
  check('the turn opens with system:init', !!sysInit)
  const result1 = (await waitFor(e => e.type === 'result', 'first result')) as
    | (Envelope & { result?: string; is_error?: boolean })
    | undefined
  check('the turn closes with result:success carrying the scripted text', result1?.subtype === 'success' && result1?.result === 'H-TURN-ONE.', j({ s: result1?.subtype, r: result1?.result }))
  check('an assistant envelope carried the text first', envelopes.some(e => e.type === 'assistant' && j(e).includes('H-TURN-ONE.')))

  // 3 — set_permission_mode ack
  send({ type: 'control_request', request_id: 'req_mode', request: { subtype: 'set_permission_mode', mode: 'implement' } })
  const modeResp = await waitFor(e => e.type === 'control_response' && j(e).includes('req_mode'), 'mode ack')
  check('set_permission_mode is acknowledged', !!modeResp && j(modeResp).includes('"success"'), j(modeResp ?? {}).slice(0, 200))

  // 4 — interrupt during a HANGING turn, with a prompt QUEUED while it
  //     hangs: the interrupt ends the hanging turn only; the queued prompt
  //     (the daemon's reply leg delivers operator → session messages as
  //     exactly these user frames) runs next, unnudged — an interrupt is
  //     "read your mail now", never a stop that leaves the session dark.
  send({ type: 'user', message: { role: 'user', content: 'headless probe two' }, parent_tool_use_id: null })
  await fixture.messageRequestStarted(2)
  send({ type: 'user', message: { role: 'user', content: 'headless probe three (queued during the hang)' }, parent_tool_use_id: null })
  send({ type: 'control_request', request_id: 'req_int', request: { subtype: 'interrupt' } })
  const intResp = await waitFor(e => e.type === 'control_response' && j(e).includes('req_int'), 'interrupt ack')
  check('interrupt is acknowledged', !!intResp && j(intResp).includes('"success"'), j(intResp ?? {}).slice(0, 200))
  const result2 = (await waitFor(
    e => e.type === 'result' && e !== (result1 as unknown),
    'post-interrupt result',
  )) as Envelope | undefined
  check(
    'the interrupted turn terminalizes as error_during_execution (is_error)',
    result2?.subtype === 'error_during_execution' && (result2 as { is_error?: boolean })?.is_error === true,
    j({ s: result2?.subtype }),
  )
  const result3 = (await waitFor(
    e => e.type === 'result' && e !== (result1 as unknown) && e !== (result2 as unknown),
    'queued-prompt result',
  )) as (Envelope & { result?: string }) | undefined
  check(
    'the prompt queued during the hang runs right after the interrupt, unnudged (result:success with its text)',
    result3?.subtype === 'success' && result3?.result === 'H-TURN-THREE.',
    j({ s: result3?.subtype, r: result3?.result }),
  )
  const thirdCall = fixture.messageRequests()[2]
  check(
    "…and the model saw the queued prompt's own text",
    thirdCall !== undefined && JSON.stringify(thirdCall.body).includes('headless probe three'),
    String(fixture.messageRequests().length),
  )
  // A second hanging turn, interrupted, so the LAST turn is still an
  // interrupted one (the exit-code pin below reads the last turn).
  send({ type: 'user', message: { role: 'user', content: 'headless probe four' }, parent_tool_use_id: null })
  await fixture.messageRequestStarted(4)
  send({ type: 'control_request', request_id: 'req_int2', request: { subtype: 'interrupt' } })
  const result4 = (await waitFor(
    e => e.type === 'result' && ![result1, result2, result3].includes(e as never),
    'second post-interrupt result',
  )) as Envelope | undefined
  check('the second interrupted turn terminalizes as error_during_execution too', result4?.subtype === 'error_during_execution', j({ s: result4?.subtype }))

  // 5 — end: the exit code reflects the LAST turn's error status. The final
  // turn here was interrupted (error_during_execution) ⇒ exit 1. (The SIGNAL
  // path — SIGINT mid-stream — exits 0: the Phase-0 J5 pin, now a recorded
  // INCONSISTENCY feeding the 9.4 correction decision.)
  child.stdin.end()
  const { exit } = await exited
  check("stdin end → the exit code carries the last turn's is_error (1 here)", exit === 1, `exit=${exit} stderr=${stderr.slice(0, 300)}`)
  check('every stdout line is individually JSON-parseable', unparseable === 0, `${unparseable} unparseable of ${lines.length}`)
  check('exactly four model calls — an interrupted turn never continues; only the QUEUED prompt ran after it', fixture.messageRequests().length === 4, `${fixture.messageRequests().length}`)
  await fixture.close()
}

await driveProtocol()

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ HEADLESS LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} HEADLESS LAW FAILURE(S)`)
process.exit(1)
