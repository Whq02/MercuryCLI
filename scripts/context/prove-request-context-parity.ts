#!/usr/bin/env bun
// ============================================================================
//  scripts/context/prove-request-context-parity.ts
//  ORACLE: /context and the outgoing API request share ONE RequestContextPlan
//  — same transform, same digest, for the same owner/epoch (slice-3
//  invariants, flipped from the slice-0 divergence pins).
//
//  Proven here:
//   · apply vs inspect parity on a normal turn, a tool-heavy turn, and a
//     stale-cache turn where the time-based content-clear fires;
//   · inspect is SIDE-EFFECT-FREE: it never consumes the content-replacement
//     state and never advances the applied-plan cache;
//   · apply records the plan + digest by owner (the /context drill-down and
//     the doctor parity probe read it);
//   · reductions are honestly accounted (counts + reasons).
//
//  Run:  ~/.bun/bin/bun run scripts/context/prove-request-context-parity.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type AnyMessage = Record<string, unknown>

function toolTurn(i: number, stampMsAgo: number): AnyMessage[] {
  const now = Date.now()
  return [
    {
      type: 'assistant',
      uuid: `asst-${i}`,
      timestamp: new Date(now - stampMsAgo).toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `tu-${i}`, name: 'Read', input: { file_path: `/tmp/f${i}` } },
        ],
      },
    },
    {
      type: 'user',
      uuid: `res-${i}`,
      timestamp: new Date(now - stampMsAgo + 1000).toISOString(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `tu-${i}`,
            content: `file ${i} contents `.repeat(50),
          },
        ],
      },
    },
  ]
}

async function main(): Promise<void> {
  process.env.MERCURY_TIME_BASED_MC = '1'

  const ok = await import('../../src/services/run/ownerKey.js')
  const planMod = await import('../../src/services/run/requestContextPlan.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'parity', lane: 'main' })
  const skip = new Set<string>()

  section('1. apply/inspect parity — stale-cache turn (time-based clear fires)')
  {
    const NINETY_MIN = 90 * 60_000
    const messages: AnyMessage[] = []
    for (let i = 0; i < 8; i++) messages.push(...toolTurn(i, NINETY_MIN + (8 - i) * 60_000))

    const inspected = await planMod.buildRequestContextPlan(
      {
        messages: messages as never,
        owner,
        querySource: 'repl_main_thread' as never,
        contentReplacementState: undefined,
        skipToolNames: skip,
      },
      'inspect',
    )
    const applied = await planMod.buildRequestContextPlan(
      {
        messages: messages as never,
        owner,
        querySource: 'repl_main_thread' as never,
        contentReplacementState: undefined,
        skipToolNames: skip,
      },
      'apply',
    )
    check('the time-based clear actually fired', applied.reductions.timeBasedCleared > 0)
    check(
      'INSPECT digest === APPLY digest (one plan, one truth)',
      inspected.digest === applied.digest,
      `${inspected.digest.slice(0, 12)} vs ${applied.digest.slice(0, 12)}`,
    )
    check(
      'reduction accounting matches across modes',
      inspected.reductions.timeBasedCleared === applied.reductions.timeBasedCleared,
    )
    check(
      'the applied plan is cached by owner',
      planMod.getLastAppliedPlan(owner)?.digest === applied.digest,
    )
  }

  section('2. inspect is side-effect-free')
  {
    const messages = toolTurn(0, 1000) // fresh — nothing to clear
    const before = planMod.getLastAppliedPlan(owner)?.digest
    const state = { seenIds: new Set<string>(), replacements: new Map<string, string>() }
    await planMod.buildRequestContextPlan(
      {
        messages: messages as never,
        owner,
        querySource: 'repl_main_thread' as never,
        contentReplacementState: state as never,
        skipToolNames: skip,
      },
      'inspect',
    )
    check('inspect never becomes the applied plan', planMod.getLastAppliedPlan(owner)?.digest === before)
    check('inspect never consumes the replacement state', state.seenIds.size === 0)
  }

  section('3. normal + tool-heavy turns are digest-stable across modes')
  {
    for (const [label, msgs] of [
      ['normal', toolTurn(0, 1000)],
      ['tool-heavy', [0, 1, 2, 3, 4].flatMap(i => toolTurn(i, 1000 + i))],
    ] as const) {
      const a = await planMod.buildRequestContextPlan(
        { messages: msgs as never, owner, querySource: 'repl_main_thread' as never, contentReplacementState: undefined, skipToolNames: skip },
        'apply',
      )
      const b = await planMod.buildRequestContextPlan(
        { messages: msgs as never, owner, querySource: 'repl_main_thread' as never, contentReplacementState: undefined, skipToolNames: skip },
        'inspect',
      )
      check(`${label} turn: apply/inspect digests match`, a.digest === b.digest)
    }
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
