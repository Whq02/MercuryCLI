#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-permit-backstop.ts — the
//  streamModel PROVIDER-BOUNDARY backstop, driven through the REAL
//  queryEvents core with deps fakes.
//
//  MECHANISM-REMOVAL SENSITIVITY BY CONSTRUCTION: §1 pins that at lanes=1
//  two concurrent runs' provider calls DO NOT OVERLAP and the queued run's
//  stream carries a truthful waitedMs>0 admission receipt — remove the
//  acquire (or the finally release) from streamModel and §1/§2 red
//  immediately (overlap appears / the held permit leaks).
//
//  §1  serialization at the boundary + the model_permit receipts.
//  §2  release on FAULT: a throwing provider leaves zero held permits and
//      the next run admits immediately.
//  §3  the release rides the attempt's finally — after any settled run the
//      governor board is empty (no leak across normal completion either).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sh-permit-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'sh-permit-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'sh-permit-teams-'))
for (const k of [
  'MERCURY_SIMPLE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_RELEVANT_RECALL',
  'CLAUDE_TEAM_NAME',
  'CLAUDE_AGENT_NAME',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { queryEvents } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const gov = await import('../../src/services/capacity/governor.ts')
const compose = await import('../../src/services/capacity/composeCeilings.ts')

/** The acquire seam now REFRESHES composed ceilings before every
 *  permit (composition owns the ceilings — a raw setGovernorCeilings pin
 *  would be overwritten on the first acquire, by design). The prover pins
 *  lanes through the §5.6 OPERATOR term instead: the registered
 *  MERCURY_MODEL_LANES env — the production-true serialization pin. */
function pinLanes(n: number | null): void {
  if (n === null) delete process.env.MERCURY_MODEL_LANES
  else process.env.MERCURY_MODEL_LANES = String(n)
  compose._resetComposeCeilingsForTesting()
}

const MODEL = 'claude-opus-4-8'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — permit backstop exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let uuidN = 0
const nextUuid = (): string => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`

interface Span {
  enter: number
  exit: number
}

/** One run through the REAL core: a provider fake that HOLDS the boundary
 *  for holdMs (or throws), recording its occupancy span; returns the span
 *  list + every model_permit event seen on the stream. */
async function runOnce(
  name: string,
  opts: { holdMs?: number; throwFirst?: boolean },
): Promise<{ spans: Span[]; permits: Array<{ waitedMs: number; reacquired: boolean }> }> {
  const abortController = new AbortController()
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const spans: Span[] = []
  const permits: Array<{ waitedMs: number; reacquired: boolean }> = []
  let call = 0
  async function* callModel(): AsyncGenerator<unknown> {
    call++
    const span: Span = { enter: Date.now(), exit: 0 }
    spans.push(span)
    try {
      if (opts.throwFirst && call === 1) {
        throw new Error(`${name}: provider fault`)
      }
      await sleep(opts.holdMs ?? 0)
      yield createAssistantMessage({ content: `${name}-reply-${call}` })
    } finally {
      span.exit = Date.now()
    }
  }
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools: [],
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never) => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(50),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  const gen = queryEvents({
    messages: [createUserMessage({ content: `${name}-prompt` })] as never,
    systemPrompt: ['permit rig'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'allow' })) as never,
    toolUseContext: ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({
        compactionResult: undefined,
        consecutiveFailures: undefined,
        consecutiveRapidRefills: undefined,
        rapidRefillBreakerTripped: false,
      })) as never,
      microcompact: (async (msgs: unknown[]) => ({ messages: msgs })) as never,
      uuid: nextUuid,
    } as never,
  })
  let r = await gen.next()
  while (!r.done) {
    const ev = r.value as { kind?: string; waitedMs?: number; reacquired?: boolean }
    if (ev && ev.kind === 'model_permit') {
      permits.push({ waitedMs: ev.waitedMs ?? -1, reacquired: ev.reacquired ?? false })
    }
    r = await gen.next()
  }
  return { spans, permits }
}

console.log('permit backstop — serialization, receipts, fault release (the real core, lanes=1)')

console.log('\n§1 — two concurrent runs serialize at the provider boundary')
{
  gov._resetCapacityGovernorForTesting()
  pinLanes(1)
  const [a, b] = await Promise.all([
    runOnce('a', { holdMs: 120 }),
    runOnce('b', { holdMs: 120 }),
  ])
  const spans = [...a.spans, ...b.spans].sort((x, y) => x.enter - y.enter)
  const overlap = spans.length === 2 && spans[1]!.enter < spans[0]!.exit
  check('both runs reached the provider exactly once each', spans.length === 2, String(spans.length))
  check('their provider occupancy DOES NOT overlap (the backstop serialized)', !overlap, JSON.stringify(spans))
  const allPermits = [...a.permits, ...b.permits]
  check('each attempt carries exactly one admission receipt', a.permits.length === 1 && b.permits.length === 1, JSON.stringify(allPermits))
  const waited = allPermits.filter(p => p.waitedMs > 0)
  check("the queued run's receipt is TRUTHFUL (waitedMs > 0 on exactly one)", waited.length === 1, JSON.stringify(allPermits))
  check('the board is empty after both settle (the finally released)', gov.heldPermits().length === 0, String(gov.heldPermits().length))
}

console.log('\n§2 — a provider FAULT releases the permit')
{
  gov._resetCapacityGovernorForTesting()
  pinLanes(1)
  await runOnce('faulty', { throwFirst: true }).catch(() => null)
  check('zero permits held after the fault settled', gov.heldPermits().length === 0, String(gov.heldPermits().length))
  const next = await runOnce('after-fault', { holdMs: 5 })
  check('the next run admits immediately (waitedMs 0)', next.permits.length === 1 && next.permits[0]!.waitedMs === 0, JSON.stringify(next.permits))
}

console.log('\n§3 — normal completion leaks nothing')
{
  gov._resetCapacityGovernorForTesting()
  pinLanes(null)
  const solo = await runOnce('solo', { holdMs: 10 })
  check('one receipt, granted immediately', solo.permits.length === 1 && solo.permits[0]!.waitedMs === 0, JSON.stringify(solo.permits))
  check('the board is empty', gov.heldPermits().length === 0, String(gov.heldPermits().length))
  gov._resetCapacityGovernorForTesting()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-permit-backstop — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 3)
