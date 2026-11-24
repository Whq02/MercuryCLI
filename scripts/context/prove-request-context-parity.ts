#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` | ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type AnyMessage = Record<string, unknown>

const RESULT_REPEATS = 3000
const resultText = (i: number): string => `file ${i} contents `.repeat(RESULT_REPEATS)

function toolTurn(i: number, stampMsAgo: number): AnyMessage[] {
  const now = Date.now()
  return [
    {
      type: 'assistant',
      uuid: `asst-${i}`,
      timestamp: new Date(now - stampMsAgo).toISOString(),
      message: {
        id: `resp-${i}`,
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `tu-${i}`, name: 'Read', input: { file_path: '/fixture/read-target' } },
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
            content: resultText(i),
          },
        ],
      },
    },
  ]
}

async function main(): Promise<void> {
  process.env.MERCURY_TIME_BASED_MC = '1'

  const ok = await import('../../src/engine/run-owner/ownerKey.js')
  const planMod = await import('../../src/engine/run/requestContextPlan.js')
  const { PROTECT_NEWEST_TOOL_OUTPUT_TOKENS } = await import('../../src/engine/compaction/pruneProtections.js')
  const { getTimeBasedPruneConfig } = await import('../../src/engine/compaction/timeBasedPruneConfig.js')
  const { MAX_TOOL_RESULTS_PER_MESSAGE_CHARS } = await import('../../src/tools/kit/toolLimits.js')
  const { roughTokenCountEstimation } = await import('../../src/models/facts/tokenEstimation.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'parity', lane: 'main' })
  const skip = new Set<string>()

  section('0. the thirteen-turn fixture is sized so the ten-result window decides')
  {
    const resultTokens = roughTokenCountEstimation(resultText(0))
    const keepRecent = getTimeBasedPruneConfig().keepRecent
    check(
      'eleven results outweigh the newest-output protection, so the ten-result window decides and exactly three of thirteen are eligible',
      keepRecent === 10 && resultTokens * (keepRecent + 1) > PROTECT_NEWEST_TOOL_OUTPUT_TOKENS,
      `${resultTokens} tokens per result, keep ${keepRecent}, protection ${PROTECT_NEWEST_TOOL_OUTPUT_TOKENS}`,
      'resize RESULT_REPEATS in this file so eleven results outweigh PROTECT_NEWEST_TOOL_OUTPUT_TOKENS (src/engine/compaction/pruneProtections.ts) and keepRecent is 10 in getTimeBasedMCConfig (src/engine/compaction/timeBasedPruneConfig.ts)',
    )
    check(
      'each turn is its own response group under the aggregate tool-result budget',
      resultText(0).length < MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
      `${resultText(0).length} chars per result, budget ${MAX_TOOL_RESULTS_PER_MESSAGE_CHARS}`,
      'lower RESULT_REPEATS in this file or check MAX_TOOL_RESULTS_PER_MESSAGE_CHARS in src/tools/kit/toolLimits.ts',
    )
  }

  section('1. apply/inspect parity — stale-cache turn (time-based clear fires)')
  {
    const NINETY_MIN = 90 * 60_000
    const messages: AnyMessage[] = []
    for (let i = 0; i < 13; i++) messages.push(...toolTurn(i, NINETY_MIN + (13 - i) * 60_000))

    const inspected = await planMod.buildRequestContextPlan(
      {
        messages: messages as never,
        owner,
        querySource: 'main_thread' as never,
        contentReplacementState: undefined,
        skipToolNames: skip,
      },
      'inspect',
    )
    const applied = await planMod.buildRequestContextPlan(
      {
        messages: messages as never,
        owner,
        querySource: 'main_thread' as never,
        contentReplacementState: undefined,
        skipToolNames: skip,
      },
      'apply',
    )
    check('the time-based clear actually fired', applied.reductions.timeBasedCleared > 0, '', 'the time-based clear in buildRequestContextPlan (src/engine/run/requestContextPlan.ts) did not clear any result of the 90-minute-old turns; read its timeBasedCleared branch and timeBasedMCConfig')
    check(
      'INSPECT digest === APPLY digest (one plan, one truth)',
      inspected.digest === applied.digest,
      `${inspected.digest.slice(0, 12)} vs ${applied.digest.slice(0, 12)}`,
      'buildRequestContextPlan in src/engine/run/requestContextPlan.ts must compute the same digest in inspect and apply mode; find what differs between the two branches',
    )
    check(
      'reduction accounting matches across modes',
      inspected.reductions.timeBasedCleared === applied.reductions.timeBasedCleared,
      '',
      'buildRequestContextPlan in src/engine/run/requestContextPlan.ts must report the same reductions.timeBasedCleared in inspect and apply mode',
    )
    check(
      'the applied plan is cached by owner',
      planMod.getLastAppliedPlan(owner)?.digest === applied.digest,
      '',
      'buildRequestContextPlan in apply mode (src/engine/run/requestContextPlan.ts) must store the plan so getLastAppliedPlan(owner) returns it',
    )
  }

  section('2. inspect is side-effect-free')
  {
    const messages = toolTurn(0, 1000)
    const before = planMod.getLastAppliedPlan(owner)?.digest
    const state = { seenIds: new Set<string>(), replacements: new Map<string, string>() }
    await planMod.buildRequestContextPlan(
      {
        messages: messages as never,
        owner,
        querySource: 'main_thread' as never,
        contentReplacementState: state as never,
        skipToolNames: skip,
      },
      'inspect',
    )
    check('inspect never becomes the applied plan', planMod.getLastAppliedPlan(owner)?.digest === before, '', 'inspect mode in buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must not store the last applied plan')
    check('inspect never consumes the replacement state', state.seenIds.size === 0, '', 'inspect mode in buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must work on a clone of the content replacement state')
  }

  section('3. normal + tool-heavy turns are digest-stable across modes')
  {
    for (const [label, msgs] of [
      ['normal', toolTurn(0, 1000)],
      ['tool-heavy', [0, 1, 2, 3, 4].flatMap(i => toolTurn(i, 1000 + i))],
    ] as const) {
      const a = await planMod.buildRequestContextPlan(
        { messages: msgs as never, owner, querySource: 'main_thread' as never, contentReplacementState: undefined, skipToolNames: skip },
        'apply',
      )
      const b = await planMod.buildRequestContextPlan(
        { messages: msgs as never, owner, querySource: 'main_thread' as never, contentReplacementState: undefined, skipToolNames: skip },
        'inspect',
      )
      check(`${label} turn: apply/inspect digests match`, a.digest === b.digest, '', 'buildRequestContextPlan in src/engine/run/requestContextPlan.ts must compute the same digest in apply and inspect mode')
    }
  }

  section('4. Cleared results stay identical on later queries and reconstruction')
  {
    const { createContentReplacementState, reconstructContentReplacementState } =
      await import('../../src/engine/tool-dispatch/toolResultStorage.js')
    for (const pressure of [false, true]) {
      const label = pressure ? 'pressure' : 'time'
      const messages = Array.from({ length: 13 }, (_, i) => toolTurn(i, pressure ? 1000 : 90 * 60_000)).flat()
      const original = JSON.stringify(messages)
      const state = createContentReplacementState()
      const records: import('../../src/engine/tool-dispatch/toolResultStorage.js').ToolResultReplacementRecord[] = []
      const input = {
        messages: messages as never,
        owner,
        querySource: 'main_thread' as const,
        contentReplacementState: state,
        persistReplacements: (rows: typeof records) => { records.push(...rows) },
        skipToolNames: skip,
        ...(pressure ? { pressurePrune: true as const } : {}),
      }
      const pruned = await planMod.buildRequestContextPlan(input, 'apply')
      check(label + ': exactly three replacements recorded', records.length === 3 && state.replacements.size === 3, '', 'the apply path of buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must record exactly the three eligible results through persistReplacements and the replacement state')
      check(label + ': each stored byte matches the applied result', records.every(record =>
        pruned.messages.some(message => message.type === 'user' && Array.isArray(message.message.content) &&
          message.message.content.some(block => block.type === 'tool_result' &&
            block.tool_use_id === record.toolUseId && block.content === record.replacement))), '', 'the replacement written by the apply path of buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must be the same text it records for persistence')
      check(label + ': pressure accounting remains conditional', Boolean(pruned.reductions.pressurePruned) === pressure, '', 'reductions.pressurePruned in buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must be set only when pressurePrune is requested')
      const fresh: AnyMessage = {
        type: 'assistant', uuid: 'fresh-' + label, timestamp: new Date().toISOString(),
        message: { role: 'assistant', id: 'reply-' + label, content: [
          { type: 'thinking', thinking: 'New reasoning after clearing.', signature: 'test-signature' },
          { type: 'text', text: 'Ready.' },
        ] },
      }
      const nextMessages = [...messages, fresh]
      const expected = planMod.digestOfMessages([...pruned.messages, fresh] as never)
      const nextInput = { ...input, messages: nextMessages as never, pressurePrune: undefined }
      const inspected = await planMod.buildRequestContextPlan(nextInput, 'inspect')
      const next = await planMod.buildRequestContextPlan(nextInput, 'apply')
      check(label + ': next query preserves the projected prefix', next.digest === expected, '', 'a later buildRequestContextPlan call (src/engine/run/requestContextPlan.ts) must replay the stored replacements so the cleared prefix stays byte-identical')
      check(label + ': inspection and application agree after clearing', inspected.digest === next.digest, '', 'buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must give inspect and apply the same digest once replacements exist')
      check(label + ': the new reasoning survives', next.messages.includes(fresh as never), '', 'buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must pass messages after the cleared turns through untouched')
      check(label + ': later query does not persist duplicate records', records.length === 3, '', 'a repeat apply in buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must not hand already-recorded replacements to persistReplacements again')
      const rebuilt = reconstructContentReplacementState(nextMessages as never, records)
      const resumed = await planMod.buildRequestContextPlan({ ...nextInput, contentReplacementState: rebuilt }, 'apply')
      check(label + ': reconstruction preserves every replacement byte', resumed.digest === expected, '', 'reconstructContentReplacementState in src/engine/tool-dispatch/toolResultStorage.ts must rebuild the same replacements from the transcript and the records')
      check(label + ': transcript input was not mutated', JSON.stringify(messages) === original, '', 'buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must return new message objects and never edit the input transcript')
    }
  }

  section('5. Uncapped output still replays replacements and waits for persistence')
  {
    const { createContentReplacementState, cloneContentReplacementState, enforceToolResultBudget, reconstructForSubagentResume } =
      await import('../../src/engine/tool-dispatch/toolResultStorage.js')
    const messages = toolTurn(0, 1000) as any[]
    messages[1].message.content[0].content = 'unchanged output '.repeat(20_000)
    const state = { ...createContentReplacementState(), budgetChars: Infinity }
    const first = await enforceToolResultBudget(messages, state)
    check('uncapped output has no new aggregate replacement', first.messages === messages && first.replacements.length === 0, '', 'enforceToolResultBudget in src/engine/tool-dispatch/toolResultStorage.ts must return the same messages and no replacements when budgetChars is Infinity')
    state.replacements.set('tu-0', '[stale tool result recorded earlier]')
    const replayed = await enforceToolResultBudget(messages, state)
    check('an uncapped caller still reapplies recorded content', (replayed.messages[1] as any).message.content[0].content === state.replacements.get('tu-0'), '', 'enforceToolResultBudget in src/engine/tool-dispatch/toolResultStorage.ts must still reapply recorded replacements when budgetChars is Infinity')
    check('inspection preserves the output policy', cloneContentReplacementState(state).budgetChars === Infinity, '', 'cloneContentReplacementState in src/engine/tool-dispatch/toolResultStorage.ts must copy budgetChars')
    check('resumed agents preserve the inherited output policy', reconstructForSubagentResume(state, messages, [])?.budgetChars === Infinity, '', 'reconstructForSubagentResume in src/engine/tool-dispatch/toolResultStorage.ts must carry budgetChars from the inherited state')
    let release!: () => void
    const persisted = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const persistenceStarted = new Promise<void>(resolve => { started = resolve })
    let settled = false
    const pending = planMod.buildRequestContextPlan({
      messages: Array.from({ length: 13 }, (_, i) => toolTurn(i, 1000)).flat() as never,
      owner,
      querySource: 'sdk',
      contentReplacementState: { ...createContentReplacementState(), budgetChars: Infinity },
      persistReplacements: () => { started(); return persisted },
      skipToolNames: skip,
      pressurePrune: true,
    }, 'apply').then(result => { settled = true; return result })
    const persistenceAsked = await Promise.race([
      persistenceStarted.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000)),
    ])
    check('the applied projection asks for persistence instead of finishing silently', persistenceAsked, '', 'buildRequestContextPlan in apply mode (src/engine/run/requestContextPlan.ts) must call persistReplacements when it clears results, even with budgetChars Infinity')
    await new Promise<void>(resolve => setImmediate(resolve))
    check('the applied projection cannot finish before its records persist', persistenceAsked && !settled, '', 'buildRequestContextPlan in apply mode (src/engine/run/requestContextPlan.ts) must await the promise returned by persistReplacements before it resolves')
    release()
    const applied = await pending
    check('the persisted projection then finishes with three clearings', settled && applied.reductions.pressurePruned?.cleared === 3, '', 'the pressure prune in buildRequestContextPlan (src/engine/run/requestContextPlan.ts) must clear three of the thirteen results once persistence finishes')
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
