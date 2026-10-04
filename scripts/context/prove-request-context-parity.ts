#!/usr/bin/env bun

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
            content: resultText(i),
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
  const { PROTECT_NEWEST_TOOL_OUTPUT_TOKENS } = await import('../../src/services/compact/pruneProtections.js')
  const { getTimeBasedMCConfig } = await import('../../src/services/compact/timeBasedMCConfig.js')
  const { MAX_TOOL_RESULTS_PER_MESSAGE_CHARS } = await import('../../src/constants/toolLimits.js')
  const { roughTokenCountEstimation } = await import('../../src/services/tokenEstimation.js')

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'parity', lane: 'main' })
  const skip = new Set<string>()

  section('0. the eight-turn fixture is sized so the five-result window decides')
  {
    const resultTokens = roughTokenCountEstimation(resultText(0))
    const keepRecent = getTimeBasedMCConfig().keepRecent
    check(
      'six results outweigh the newest-output protection, so the five-result window decides and exactly three of eight are eligible',
      keepRecent === 5 && resultTokens * (keepRecent + 1) > PROTECT_NEWEST_TOOL_OUTPUT_TOKENS,
      `${resultTokens} tokens per result, keep ${keepRecent}, protection ${PROTECT_NEWEST_TOOL_OUTPUT_TOKENS}`,
    )
    check(
      'each turn is its own response group under the aggregate tool-result budget',
      resultText(0).length < MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
      `${resultText(0).length} chars per result, budget ${MAX_TOOL_RESULTS_PER_MESSAGE_CHARS}`,
    )
  }

  section('1. apply/inspect parity — stale-cache turn (time-based clear fires)')
  {
    const NINETY_MIN = 90 * 60_000
    const messages: AnyMessage[] = []
    for (let i = 0; i < 8; i++) messages.push(...toolTurn(i, NINETY_MIN + (8 - i) * 60_000))

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
        { messages: msgs as never, owner, querySource: 'main_thread' as never, contentReplacementState: undefined, skipToolNames: skip },
        'apply',
      )
      const b = await planMod.buildRequestContextPlan(
        { messages: msgs as never, owner, querySource: 'main_thread' as never, contentReplacementState: undefined, skipToolNames: skip },
        'inspect',
      )
      check(`${label} turn: apply/inspect digests match`, a.digest === b.digest)
    }
  }

  section('4. Cleared results stay identical on later queries and reconstruction')
  {
    const { createContentReplacementState, reconstructContentReplacementState } =
      await import('../../src/utils/toolResultStorage.js')
    for (const pressure of [false, true]) {
      const label = pressure ? 'pressure' : 'time'
      const messages = Array.from({ length: 8 }, (_, i) => toolTurn(i, pressure ? 1000 : 90 * 60_000)).flat()
      const original = JSON.stringify(messages)
      const state = createContentReplacementState()
      const records: import('../../src/utils/toolResultStorage.js').ToolResultReplacementRecord[] = []
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
      check(label + ': exactly three replacements recorded', records.length === 3 && state.replacements.size === 3)
      check(label + ': each stored byte matches the applied result', records.every(record =>
        pruned.messages.some(message => message.type === 'user' && Array.isArray(message.message.content) &&
          message.message.content.some(block => block.type === 'tool_result' &&
            block.tool_use_id === record.toolUseId && block.content === record.replacement))))
      check(label + ': pressure accounting remains conditional', Boolean(pruned.reductions.pressurePruned) === pressure)
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
      check(label + ': next query preserves the projected prefix', next.digest === expected)
      check(label + ': inspection and application agree after clearing', inspected.digest === next.digest)
      check(label + ': the new reasoning survives', next.messages.includes(fresh as never))
      check(label + ': later query does not persist duplicate records', records.length === 3)
      const rebuilt = reconstructContentReplacementState(nextMessages as never, records)
      const resumed = await planMod.buildRequestContextPlan({ ...nextInput, contentReplacementState: rebuilt }, 'apply')
      check(label + ': reconstruction preserves every replacement byte', resumed.digest === expected)
      check(label + ': transcript input was not mutated', JSON.stringify(messages) === original)
    }
  }

  section('5. Uncapped output still replays replacements and waits for persistence')
  {
    const { createContentReplacementState, cloneContentReplacementState, enforceToolResultBudget, reconstructForSubagentResume } =
      await import('../../src/utils/toolResultStorage.js')
    const messages = toolTurn(0, 1000) as any[]
    messages[1].message.content[0].content = 'unchanged output '.repeat(20_000)
    const state = { ...createContentReplacementState(), budgetChars: Infinity }
    const first = await enforceToolResultBudget(messages, state)
    check('uncapped output has no new aggregate replacement', first.messages === messages && first.replacements.length === 0)
    state.replacements.set('tu-0', '[stale tool result recorded earlier]')
    const replayed = await enforceToolResultBudget(messages, state)
    check('an uncapped caller still reapplies recorded content', (replayed.messages[1] as any).message.content[0].content === state.replacements.get('tu-0'))
    check('inspection preserves the output policy', cloneContentReplacementState(state).budgetChars === Infinity)
    check('resumed agents preserve the inherited output policy', reconstructForSubagentResume(state, messages, [])?.budgetChars === Infinity)
    const ts = await import('typescript')
    const { readFileSync } = await import('node:fs')
    const source = ts.createSourceFile('inProcessRunner.ts', readFileSync(new URL('../../src/utils/crew/inProcessRunner.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    let initial: import('typescript').Expression | undefined
    let resetState: import('typescript').Expression | undefined
    const visit = (node: import('typescript').Node): void => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'contentReplacementState') initial = node.initializer
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(source) === 'contentReplacementState') resetState = node.right
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (!initial || !resetState) throw new Error('The crewmate initialization and compaction state expressions must exist')
    type ReplacementState = ReturnType<typeof createContentReplacementState>
    const make = (expression: import('typescript').Expression, parent: ReplacementState | undefined, current?: ReplacementState, resume?: { contentReplacementState?: ReplacementState }) =>
      new Function('createContentReplacementState', 'toolUseContext', 'contentReplacementState', 'config', `return (${expression.getText(source)})`)(createContentReplacementState, { contentReplacementState: parent }, current, resume === undefined ? {} : { resume })
    check('crewmates leave a disabled replacement policy disabled', make(initial, undefined) === undefined)
    for (const budgetChars of [Infinity, 4096]) {
      const parent = { ...createContentReplacementState(), budgetChars }
      const child = make(initial, parent)
      check(`crewmate initialization preserves budget ${budgetChars}`, child.budgetChars === budgetChars)
      child.seenIds.add('old-call')
      child.replacements.set('old-call', 'old-content')
      const compacted = make(resetState, parent, child)
      check(`crewmate compaction preserves budget ${budgetChars} and clears old ids`, compacted.budgetChars === budgetChars && compacted.seenIds.size === 0 && compacted.replacements.size === 0)
      const rebuilt = reconstructForSubagentResume(parent, messages, [{ kind: 'tool-result', toolUseId: 'tu-0', replacement: '[stale tool result recorded earlier]' }])
      check(`a resumed crewmate carries the state its transcript rebuilt at budget ${budgetChars}`, rebuilt !== undefined && make(initial, parent, undefined, { contentReplacementState: rebuilt }) === rebuilt && rebuilt.replacements.get('tu-0') === '[stale tool result recorded earlier]')
      check(`a resume that rebuilt no state falls to the parent's policy at budget ${budgetChars}`, make(initial, parent, undefined, {}).budgetChars === budgetChars && make(initial, undefined, undefined, {}) === undefined)
    }

    let release!: () => void
    const persisted = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const persistenceStarted = new Promise<void>(resolve => { started = resolve })
    let settled = false
    const pending = planMod.buildRequestContextPlan({
      messages: Array.from({ length: 8 }, (_, i) => toolTurn(i, 1000)).flat() as never,
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
    check('the applied projection asks for persistence instead of finishing silently', persistenceAsked)
    await new Promise<void>(resolve => setImmediate(resolve))
    check('the applied projection cannot finish before its records persist', persistenceAsked && !settled)
    release()
    const applied = await pending
    check('the persisted projection then finishes with three clearings', settled && applied.reductions.pressurePruned?.cleared === 3)
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
