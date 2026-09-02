#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import {
  countTrackedRunningAgents,
  SleepTool,
  TERMINAL_TASK_STATUSES,
  TRACKED_AGENT_TASK_TYPES,
  TRACKED_ARM_GRACE_TICKS,
  TRACKED_SETTLE_POLL_MS,
  UNTRACKED_TASK_TYPES,
} from '../../src/tools/SleepTool/SleepTool.tsx'
import { isTerminalTaskStatus, type TaskStatus } from '../../src/Task.ts'
import type { AppState } from '../../src/state/AppState.js'

const t = checker()

const stateWith = (tasks: Record<string, unknown>): (() => AppState) =>
  (() => ({ tasks }) as unknown as AppState)

type SleepOut = { message: string; slept_seconds: number; interrupted: boolean }

async function runSleep(
  seconds: number,
  getAppState: () => AppState,
  abortController = new AbortController(),
  agentId?: string,
): Promise<{ out: SleepOut; elapsedMs: number }> {
  const started = Date.now()
  const result = (await SleepTool.call({ seconds }, {
    abortController,
    getAppState,
    agentId,
  } as never)) as { data: SleepOut }
  return { out: result.data, elapsedMs: Date.now() - started }
}

t.section('§1 — what counts as harness-tracked, TOTAL over the TaskType union')
{
  const taskSrc = readFileSync('src/Task.ts', 'utf8')
  const unionMatch = taskSrc.match(/export type TaskType =\n((?:\s*\|\s*'[a-z_]+'\n)+)/)
  const union = [...(unionMatch?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(m => m[1]!)
  t.check('the TaskType union was read from src/Task.ts', union.length >= 7, union.join(','))
  t.check(
    'every union member is TRACKED or a DOCUMENTED exclusion — no silent misses',
    union.every(ty => TRACKED_AGENT_TASK_TYPES.has(ty) || UNTRACKED_TASK_TYPES.has(ty)),
    union.filter(ty => !TRACKED_AGENT_TASK_TYPES.has(ty) && !UNTRACKED_TASK_TYPES.has(ty)).join(',') || 'total',
  )
  t.check(
    'and no type is both tracked and excluded',
    union.every(ty => !(TRACKED_AGENT_TASK_TYPES.has(ty) && UNTRACKED_TASK_TYPES.has(ty))),
    'disjoint',
  )
  t.check(
    'every exclusion carries its reason on the record',
    [...UNTRACKED_TASK_TYPES.values()].every(r => r.length > 10),
    'decisions, not omissions',
  )
  const statuses: TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'killed']
  t.check(
    "the tool's terminal-status mirror matches Task.ts isTerminalTaskStatus exactly",
    statuses.every(s => TERMINAL_TASK_STATUSES.has(s) === isTerminalTaskStatus(s)),
    [...TERMINAL_TASK_STATUSES].join(','),
  )

  for (const ty of ['local_agent', 'in_process_teammate', 'remote_agent', 'local_workflow']) {
    t.check(
      `a running ${ty} counts`,
      countTrackedRunningAgents(stateWith({ a: { id: 'x', type: ty, status: 'running' } })) === 1,
      'one',
    )
  }
  t.check(
    'a PENDING dispatch counts too — dispatch-then-wait can land in the first beat',
    countTrackedRunningAgents(stateWith({ a: { id: 'x', type: 'local_agent', status: 'pending' } })) === 1,
    'non-terminal, not literally running',
  )
  t.check(
    'a FINISHED agent does not',
    countTrackedRunningAgents(stateWith({ a: { id: 'x', type: 'local_agent', status: 'completed' } })) === 0,
    'zero',
  )
  t.check(
    'a running background SHELL does not — the REAL excluded type, not a fictional one',
    countTrackedRunningAgents(stateWith({ a: { id: 'x', type: 'local_bash', status: 'running' } })) === 0,
    'local_bash excluded by decision',
  )
  t.check(
    "a subagent's OWN task never counts as work it awaits",
    countTrackedRunningAgents(
      stateWith({ a: { id: 'agent-self', type: 'local_agent', status: 'running' } }),
      'agent-self',
    ) === 0,
    'self-excluded',
  )
  t.check(
    'an unreadable registry degrades to "nothing tracked" — the redirect is an optimisation, never a dependency',
    countTrackedRunningAgents(() => {
      throw new Error('no state')
    }) === 0,
    'safe',
  )
}

t.section('§2 — the redirect: the wait ends when the tracked work does')
{
  let status = 'running'
  setTimeout(() => {
    status = 'completed'
  }, 600).unref?.()
  const { out, elapsedMs } = await runSleep(
    20,
    () => ({ tasks: { a: { id: 'x', type: 'local_agent', status } } }) as unknown as AppState,
  )
  t.check(
    'the wait returns as soon as the work settles, not when the timer says so',
    elapsedMs < 3000,
    `${elapsedMs} ms of a requested 20 000 ms`,
  )
  t.check('and it did wait for it — not an instant no-op', elapsedMs >= 500, `${elapsedMs} ms`)
  t.check('reported as a normal, uninterrupted return', out.interrupted === false, JSON.stringify(out.interrupted))
  t.check(
    'saying plainly WHY it came back early',
    /tracked work you were waiting on finished/.test(out.message),
    out.message,
  )
  t.check(
    'and teaching the durable lesson — completion arrives on its own',
    /completion arrives on its own/.test(out.message),
    'the redirect explains itself',
  )
  t.check('the elapsed time is honest', out.slept_seconds <= 3, `${out.slept_seconds}s`)

  let tasks2: Record<string, unknown> = {}
  setTimeout(() => {
    tasks2 = { a: { id: 'x', type: 'local_agent', status: 'running' } }
  }, 300).unref?.()
  setTimeout(() => {
    tasks2 = { a: { id: 'x', type: 'local_agent', status: 'completed' } }
  }, 900).unref?.()
  const race = await runSleep(15, () => ({ tasks: tasks2 }) as unknown as AppState)
  t.check(
    'a dispatch registering just after entry still redirects (grace arming)',
    race.elapsedMs < 3000 && /tracked work you were waiting on finished/.test(race.out.message),
    `${race.elapsedMs} ms — ${race.out.message}`,
  )
}

t.section('§3 — a wait with nothing tracked is unchanged, and never relabelled late')
{
  const { out, elapsedMs } = await runSleep(1, stateWith({}))
  t.check('it runs its full duration', elapsedMs >= 950, `${elapsedMs} ms`)
  t.check('with the classic message', /^Slept for \d+s$/.test(out.message), out.message)
  t.check('and reports the seconds it waited', out.slept_seconds === 1, `${out.slept_seconds}`)

  const graceMs = TRACKED_ARM_GRACE_TICKS * TRACKED_SETTLE_POLL_MS
  let tasks: Record<string, unknown> = {}
  setTimeout(() => {
    tasks = { a: { id: 'x', type: 'local_agent', status: 'running' } }
  }, graceMs + 500).unref?.()
  const later = await runSleep(2, () => ({ tasks }) as unknown as AppState)
  t.check(
    'work appearing after the grace window does not turn the wait into a redirect',
    later.elapsedMs >= 1950 && /^Slept for \d+s$/.test(later.out.message),
    `${later.elapsedMs} ms — ${later.out.message}`,
  )
}

t.section('§4 — abort still wins over both')
{
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300).unref?.()
  const { out, elapsedMs } = await runSleep(
    30,
    stateWith({ a: { id: 'x', type: 'local_agent', status: 'running' } }),
    ac,
  )
  t.check('the wait ends on abort', elapsedMs < 2000, `${elapsedMs} ms`)
  t.check('and says it was interrupted', out.interrupted === true, JSON.stringify(out))
  t.check(
    'never claiming the tracked work finished — it did not',
    !/tracked work/.test(out.message),
    out.message,
  )
}

t.section('§5 — the mechanism is the TOOL, not an exhortation')
{
  const src = readFileSync('src/tools/SleepTool/SleepTool.tsx', 'utf8')
  t.check(
    'the tool reads the task registry itself',
    src.includes('countTrackedRunningAgents(getAppState, agentId)'),
    'mechanical',
  )
  t.check(
    'and settles on the tracked work rather than the timer',
    src.includes('if (countTrackedRunningAgents(getAppState, agentId) === 0)'),
    'redirect',
  )
  t.check(
    'the requested duration stays the CEILING — no wait outlives what was asked',
    src.includes('const timer = setTimeout('),
    'ceiling kept',
  )
  t.check(
    'the settle poll is cheap and named, not a magic number in a loop',
    TRACKED_SETTLE_POLL_MS > 0 && TRACKED_SETTLE_POLL_MS <= 500,
    `${TRACKED_SETTLE_POLL_MS} ms`,
  )
  t.check(
    'the arming grace is short and named — same-block dispatches, nothing later',
    TRACKED_ARM_GRACE_TICKS * TRACKED_SETTLE_POLL_MS <= 2000,
    `${TRACKED_ARM_GRACE_TICKS * TRACKED_SETTLE_POLL_MS} ms`,
  )
  t.check(
    "and the watcher is unref'd so a wait can never hold the process open",
    src.includes('watch?.unref?.()'),
    'no lingering handle',
  )
}

t.section('§6 — REAL BINARY, REAL AGENT: the same-block dispatch-then-wait pattern')
{
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const scratch = mkdtempSync(join(tmpdir(), 'hz-sleep-live-'))
    const home = join(scratch, 'home')
    const API_KEY = 'sk-ant-fixture-sleep-redirect-00000000000'
    {
      const seed = spawn(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
        cwd: process.cwd(),
        env: { ...process.env, ANTHROPIC_API_KEY: API_KEY },
      })
      await new Promise<void>(r => seed.on('exit', () => r()))
    }

    const fixture = await startFixtureApi([
      {
        kind: 'paced_tool_use',
        preDeltas: ['dispatching, then waiting '],
        gapMs: 50,
        tools: [
          {
            name: 'Agent',
            input: {
              description: 'slow probe',
              prompt: 'Reply with the single word done. Do not use any tools.',
              run_in_background: true,
            },
          },
          { name: 'Sleep', input: { seconds: 45 } },
        ],
        whenModel: 'opus',
      },
      {
        kind: 'paced',
        deltas: Array.from({ length: 16 }, (_, i) => `working-${i} `),
        gapMs: 500,
        whenModel: 'opus',
      },
      {
        kind: 'paced_tool_use',
        preDeltas: ['now a plain wait '],
        gapMs: 50,
        tools: [{ name: 'Sleep', input: { seconds: 3 } }],
        whenModel: 'opus',
      },
      { kind: 'text', text: 'finished', whenModel: 'opus' },
      ...Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'ok' })),
    ])

    const started = Date.now()
    const child = spawn(
      'node',
      [BIN, '-p', 'go', '--output-format', 'stream-json', '--verbose'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: home,
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: API_KEY,
          MERCURY_BOOT_PREFLIGHT: '0',
          MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
          MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
          MERCURY_TEAMS_DIR: join(scratch, 'teams'),
          MERCURY_TABULA_DIR: join(scratch, 'tabula'),
        },
      },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    const killer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    const exit = await new Promise<number | null>(r => child.on('exit', c => r(c)))
    clearTimeout(killer)
    const wallMs = Date.now() - started
    await fixture.close()

    const sleepResults: string[] = []
    let agentDispatched = false
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line) as { message?: { content?: unknown } }
        const content = evt?.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type === 'tool_use' && block?.name === 'Agent') agentDispatched = true
          if (block?.type !== 'tool_result') continue
          const c = block.content
          const text =
            typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? (c as Array<{ text?: string }>).map(x => x?.text ?? '').join(' ')
                : ''
          if (/[Ss]lept|tracked work|Sleep interrupted/.test(text)) sleepResults.push(text)
        }
      } catch {
      }
    }

    t.check('the headless run exited cleanly', exit === 0, `exit=${exit} ${err.slice(-200)}`)
    t.check('the Agent dispatch really happened', agentDispatched, 'no Agent tool_use seen')
    t.check('both Sleep results captured', sleepResults.length >= 2, JSON.stringify(sleepResults))
    t.check(
      'REDIRECT on a REAL same-block agent: Sleep(45) settled when the tracked work did',
      /tracked work you were waiting on finished/.test(sleepResults[0] ?? ''),
      sleepResults[0] ?? 'missing (pre-fix: full 45 s — entry-only arming lost the race)',
    )
    t.check('and nowhere near its ceiling', wallMs < 40_000, `${wallMs} ms total for a 45 s request`)
    t.check(
      'NEGATIVE: with the agent completed, Sleep(3) ran full duration, classic message',
      /Slept for 3s/.test(sleepResults[1] ?? ''),
      sleepResults[1] ?? 'missing',
    )
    rmSync(scratch, { recursive: true, force: true })
  }
}

t.finish('prove-sleep-redirect')
