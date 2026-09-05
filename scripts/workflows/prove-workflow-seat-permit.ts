#!/usr/bin/env bun

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-seat-permit-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_MODEL_LANES

const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.js')
const gov = await import('../../src/services/capacity/governor.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

type Frame = { type?: string; data?: Record<string, unknown> }
type SpawnArgs = { prompt: string; onWait?: (words: string | null) => void; toolUseContext?: { abortController?: AbortController } }

function textEvent(text: string) {
  return {
    type: 'assistant' as const,
    message: { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 30 }, stop_reason: 'end_turn' },
  }
}

type Step = { call: number } | { idle: number }
const SCRIPT: Record<string, Step[]> = {
  'agent-a': [{ call: 100 }, { idle: 1500 }, { call: 100 }],
  'agent-b': [{ call: 900 }],
  'agent-c': [{ call: 900 }],
  'agent-d': [{ call: 900 }],
}
const HOLDERS = Object.keys(SCRIPT)

interface CallRecord {
  holder: string
  startedAt: number
  endedAt: number
  waitedMs: number
}

function makeHarness(abortController = new AbortController()) {
  const frames: Frame[] = []
  const calls: CallRecord[] = []
  const t0 = Date.now()
  let callSeq = 0
  const fakeSpawn = async function* (args: SpawnArgs) {
    const holder = HOLDERS.find(h => args.prompt.startsWith(h)) ?? 'an agent'
    const steps = SCRIPT[holder] ?? [{ call: 100 }]
    for (const step of steps) {
      if ('idle' in step) {
        await sleep(step.idle)
        continue
      }
      const grant = await gov.acquireModelPermit({
        lane: 'background-session',
        callId: `${holder}.c${++callSeq}`,
        holder,
        signal: args.toolUseContext?.abortController?.signal,
        onWait: args.onWait,
      })
      const startedAt = Date.now() - t0
      try {
        await sleep(step.call)
      } finally {
        gov.releaseModelPermit(grant.permitId)
        calls.push({ holder, startedAt, endedAt: Date.now() - t0, waitedMs: grant.waitedMs })
      }
    }
    yield textEvent(`${holder} landed`) as never
  }
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController,
      getAppState: () => ({
        toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
        mcp: { tools: [] },
      }),
      options: { agentDefinitions: { activeAgents: [] }, mainLoopModel: 'claude-fable-5-1' },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (frame: Frame) => {
      frames.push(frame)
    },
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: fakeSpawn as never,
  } as never) as {
    agent: (p: string, o?: Record<string, unknown>) => Promise<unknown>
    parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>
  }
  const latestByLabel = (): Map<string, Record<string, unknown>> => {
    const out = new Map<string, Record<string, unknown>>()
    for (const f of frames) {
      if (f.data?.type !== 'workflow_agent') continue
      out.set(String(f.data.label ?? ''), f.data)
    }
    return out
  }
  return { hooks, frames, calls, latestByLabel, t0 }
}

console.log('============================================================')
console.log(' a workflow agent holds a seat only while a model call is in flight')
console.log('============================================================')

section('P1–P4 two seats, four agents at once; a idle, b mid-call ⇒ c runs, d waits at the governor')
{
  gov._resetCapacityGovernorForTesting()
  gov.setGovernorCeilings({ modelLanes: 2, delegationLanes: 2 })
  const { hooks, calls, latestByLabel } = makeHarness()
  const run = hooks.parallel(HOLDERS.map(h => () => hooks.agent(`${h} do the work`, { label: h })))
  await sleep(400)
  const latest = latestByLabel()
  const state = gov._governorStateForTesting()
  const holders = gov.heldPermits().map(g => g.holder)
  const wordsOf = (label: string): string => String(latest.get(label)?.waitWords ?? '')
  const waitingOf = (label: string): string => String(latest.get(label)?.waiting ?? '')
  const frameWord = (label: string): string => {
    const f = latest.get(label)
    return f === undefined ? '(no frame)' : `${String(f.state)}${f.waiting !== undefined ? `/${String(f.waiting)}` : ''}${f.waitWords !== undefined ? ` "${String(f.waitWords)}"` : ''}`
  }
  console.log(`  at 400 ms: permits held ${state.held} (${holders.join(', ')}) · waiters ${state.waiters}`)
  for (const h of HOLDERS) console.log(`    ${h}: ${frameWord(h)}`)

  check('P2 the governor holds exactly two permits — the two calls in flight (b, c)', state.held === 2 && holders.includes('agent-b') && holders.includes('agent-c'), `${state.held}: ${holders.join(', ')}`)
  check('P2 the idle agent holds no permit (alive is not a seat)', !holders.includes('agent-a'), holders.join(', '))
  check("P1 c's call is in flight beside b's while a is idle (three agents past the scheduler)", calls.length === 1 && holders.includes('agent-c') && waitingOf('agent-c') !== 'seat', `${calls.length} landed calls · c: ${frameWord('agent-c')}`)
  check("P1 d waits at the GOVERNOR with the seat sentence naming b and c — never the idle a", waitingOf('agent-d') === 'seat' && /^waiting for a seat — 2 of 2 held \(agent-b, agent-c\)$/.test(wordsOf('agent-d')), frameWord('agent-d'))
  check('P1 exactly one waiter, and it is d', state.waiters === 1, String(state.waiters))
  check("P4 no tile carries a gate sentence naming the idle a as a holder", [...latest.values()].every(f => !String(f.waitWords ?? '').includes('agent-a')), [...latest.entries()].map(([k, f]) => `${k}: ${String(f.waitWords ?? '')}`).join(' | '))
  check("P4 a queued tile (state 'start', no attempt) never wears seat words of its own", [...latest.values()].every(f => !(f.state === 'start' && f.agentId === undefined && f.waitWords !== undefined)), 'gate words on a queued tile')

  const results = await run
  check('P3 every agent lands', results.length === 4 && results.every(r => typeof r === 'string' && r.endsWith('landed')), JSON.stringify(results))
  const callOf = (holder: string, n = 0): CallRecord | undefined => calls.filter(c => c.holder === holder)[n]
  const aFirst = callOf('agent-a', 0)
  const b = callOf('agent-b')
  const c = callOf('agent-c')
  const d = callOf('agent-d')
  console.log(`  calls: ${calls.map(x => `${x.holder}@${x.startedAt}→${x.endedAt} (waited ${x.waitedMs})`).join(' · ')}`)
  check("P3 c's call started the moment a's first call ended (a alive and idle), well before b's ended", c !== undefined && b !== undefined && aFirst !== undefined && c.waitedMs < 300 && c.startedAt >= aFirst.endedAt - 5 && c.startedAt < b.endedAt - 500, `c waited ${c?.waitedMs} started ${c?.startedAt} · a's first ended ${aFirst?.endedAt} · b ended ${b?.endedAt}`)
  check("P3 d's call waited for a seat and started once one freed (the queue only with two calls in flight)", d !== undefined && b !== undefined && c !== undefined && d.waitedMs > 0 && d.startedAt >= Math.min(b.endedAt, c.endedAt) - 5, `d waited ${d?.waitedMs} started ${d?.startedAt}`)
  check("P3 a's second call ran after its idle stretch without queuing anyone", callOf('agent-a', 1) !== undefined, `a calls ${calls.filter(x => x.holder === 'agent-a').length}`)
  const final = latestByLabel()
  check('P4 every tile settles done with no wait left on it', HOLDERS.every(h => final.get(h)?.state === 'done' && final.get(h)?.waiting === undefined), HOLDERS.map(h => `${h}: ${String(final.get(h)?.state)}`).join(', '))
  gov._resetCapacityGovernorForTesting()
}

console.log(failures === 0 ? '\n✅ workflow seat permit GREEN' : `\n❌ workflow seat permit RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
