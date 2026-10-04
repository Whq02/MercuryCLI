#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner } from '../lib/runnerHost.ts'

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

{
  const { bootRunner } = await import('../daemon/dupline-world.ts')
  const home = mkdtempSync(join(tmpdir(), 'headless-closed-'))
  const runner = bootRunner({ cwd: home, env: { ...process.env, MERCURY_CONFIG_DIR: home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }, extraArgv: ['--frobnicate'] })
  const pending = runner.waitFor('a row after an option refusal', () => false, 5_000).then(() => '', error => String(error))
  const code = await runner.exited
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<string>(resolve => { timer = setTimeout(() => resolve('deadline'), 1_000) })
  const rejection = await Promise.race([pending, deadline])
  clearTimeout(timer)
  check('the fixture wait ends when its child exits and names the refusal', code === 2 && rejection.includes('2') && rejection.includes('--frobnicate') && rejection !== 'deadline' && performance.now() - started < 1_000, rejection)
  if (rejection !== 'deadline') {
    const after = await runner.waitFor('an already closed child', () => false, 5_000).then(() => '', error => String(error))
    check('a wait started after exit is refused immediately', after.includes('2') && after.includes('--frobnicate'), after)
  }
  await runner.stop(100)
  rmSync(home, { recursive: true, force: true })
}

section('§1 — joinPromptValues / canBatchWith (pure)')
{
  const { joinPromptValues, canBatchWith } = await import('../../src/cli/run.ts')
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

section('§2 — the door: initialize · turn · session/set_mode · interrupt · clean end')

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
  mkdirSync(join(home, '.mercury'), { recursive: true })
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.mercury'),
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
  }

  const lines: string[] = []
  const envelopes: Envelope[] = []
  let unparseable = 0
  const waiters: Array<{ pred: (e: Envelope) => boolean; res: (e: Envelope) => void }> = []
  const host = hostRunner({
    node: nodeBin!,
    dist: DIST,
    argv: ['--model', 'claude-opus-4-8'],
    cwd,
    env,
    home,
    raw: text => {
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        lines.push(line)
        try {
          JSON.parse(line)
        } catch {
          unparseable++
        }
      }
    },
    onRow: row => {
      const e = row as Envelope
      envelopes.push(e)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(e)) {
          const w = waiters.splice(i, 1)[0]!
          w.res(e)
        }
      }
    },
  })
  const child = host.child
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  let stderr = ''
  child.stderr!.on('data', d => (stderr += d))
  const exited = host.exited.then(exit => {
    clearTimeout(killer)
    return { exit }
  })

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
  const send = (content: string): void => {
    void host.prompt(content).catch(() => undefined)
  }
  const answered = <T>(p: Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> => p.then(result => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))

  const initResp = await host.initialize().catch(() => null)
  check('initialize is answered', initResp !== null, j(envelopes.map(e => e.type)))
  check('the initialize answer names the session', typeof initResp?.session_id === 'string' && initResp.session_id.length > 0, j(initResp ?? {}).slice(0, 200))
  check('the initialize answer names the runner (version and pid)', typeof initResp?.runner?.version === 'string' && initResp.runner.pid === child.pid, j(initResp ?? {}).slice(0, 200))

  send('headless probe one')
  const sessionRow = await waitFor(e => e.type === 'session', 'session row')
  check('the stream opens with the session row', !!sessionRow && (sessionRow as { schema?: unknown }).schema === 1)
  const turnRow = await waitFor(e => e.type === 'turn' && (e as { state?: unknown }).state === 'started', 'turn row')
  check('the turn opens with its turn row', !!turnRow)
  const result1 = (await waitFor(e => e.type === 'outcome', 'first outcome')) as
    | (Envelope & { answer?: string; status?: string })
    | undefined
  check('the turn closes with a completed outcome carrying the scripted text', result1?.status === 'completed' && result1?.answer === 'H-TURN-ONE.', j({ s: result1?.status, r: result1?.answer }))
  check('a text row carried the text first', envelopes.some(e => e.type === 'text' && j(e).includes('H-TURN-ONE.')))

  const modeResp = await answered(host.request('session/set_mode', { mode: 'implement' }))
  check('session/set_mode is answered with the mode', modeResp.ok && modeResp.result.mode === 'implement', j(modeResp).slice(0, 200))
  const modeRow = await waitFor(e => e.type === 'mode', 'the mode row')
  check('the applied mode rides the stream as a mode row carrying the word', modeRow?.mode === 'implement', j(modeRow ?? {}).slice(0, 200))

  send('headless probe two')
  await fixture.messageRequestStarted(2)
  send('headless probe three (queued during the hang)')
  const intResp = await answered(host.request('turn/interrupt', { op_id: 'req_int' }))
  check('turn/interrupt is answered: a turn was there to interrupt', intResp.ok && intResp.result.interrupted === true, j(intResp).slice(0, 200))
  const result2 = (await waitFor(
    e => e.type === 'outcome' && e !== (result1 as unknown),
    'post-interrupt outcome',
  )) as (Envelope & { status?: string }) | undefined
  check(
    'the interrupted turn settles interrupted',
    result2?.status === 'interrupted',
    j({ s: result2?.status }),
  )
  const result3 = (await waitFor(
    e => e.type === 'outcome' && e !== (result1 as unknown) && e !== (result2 as unknown),
    'queued-prompt outcome',
  )) as (Envelope & { answer?: string; status?: string }) | undefined
  check(
    'the prompt queued during the hang runs right after the interrupt, unnudged (a completed outcome with its text)',
    result3?.status === 'completed' && result3?.answer === 'H-TURN-THREE.',
    j({ s: result3?.status, r: result3?.answer }),
  )
  const thirdCall = fixture.messageRequests()[2]
  check(
    "…and the model saw the queued prompt's own text",
    thirdCall !== undefined && JSON.stringify(thirdCall.body).includes('headless probe three'),
    String(fixture.messageRequests().length),
  )
  send('headless probe four')
  await fixture.messageRequestStarted(4)
  void host.request('turn/interrupt', { op_id: 'req_int2' }).catch(() => undefined)
  const result4 = (await waitFor(
    e => e.type === 'outcome' && ![result1, result2, result3].includes(e as never),
    'second post-interrupt outcome',
  )) as (Envelope & { status?: string }) | undefined
  check('the second interrupted turn settles interrupted too', result4?.status === 'interrupted', j({ s: result4?.status }))

  host.end()
  const { exit } = await exited
  check("stdin end → the exit code carries the last turn's status (interrupted ⇒ 1 here)", exit === 1, `exit=${exit} stderr=${stderr.slice(0, 300)}`)
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
