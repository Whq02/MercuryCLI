#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cancel-result-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

import { z } from 'zod/v4'

const ROOT = resolve(import.meta.dir, '..', '..')
const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { runTools } = await import('../../src/services/tools/toolOrchestration.ts')
const { subscribeToolStart, subscribeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { abortWithCut, CANCEL_MESSAGE, isDenialResultText, isInterruptedResultText, turnCutOf, turnCutResultText } = await import('../../src/utils/messages/rejectionText.ts')
const { buildMessageLookups } = await import('../../src/utils/messages/lookups.ts')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { createAssistantMessage } = await import('../../src/utils/messages.ts')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail !== '' ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the cancel-result proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

type Block = { type: string; content?: unknown; is_error?: boolean; tool_use_id?: string }
type Yielded = { message?: { type?: string; message?: { content?: Block[] }; toolUseResult?: unknown } }
type Settled = { id: string; text: string; isError: boolean; toolUseResult: unknown }
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ text?: string }>).map(b => b.text ?? '').join('') : ''
const resultsOf = (updates: Yielded[]): Settled[] =>
  updates.flatMap(u =>
    (u.message?.message?.content ?? [])
      .filter(b => b.type === 'tool_result')
      .map(b => ({ id: String(b.tool_use_id), text: textOf(b.content), isError: b.is_error === true, toolUseResult: u.message?.toolUseResult })),
  )

function makeTool(name: string, call: (...args: unknown[]) => Promise<unknown>): Record<string, unknown> {
  return {
    name,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => false,
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: undefined }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', content: typeof data === 'string' ? data : JSON.stringify(data), tool_use_id: id }),
    call,
  }
}
function makeContext(tools: unknown[]): { abortController: AbortController } & Record<string, unknown> {
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' },
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map(),
    options: { tools, mcpClients: [], isNonInteractiveSession: true },
  }
}
const ALLOW = (async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
const ASSISTANT = { uuid: 'uuid-cancel-result', requestId: 'req_cancel_result', message: { id: 'msg_cancel_result' } } as never
const starts: Array<{ toolUseId?: string }> = []
const terminals: Array<{ toolUseId?: string; ok: boolean }> = []
subscribeToolStart(e => starts.push(e as never))
subscribeToolTerminal(e => terminals.push(e as never))
const resetTaps = (): void => {
  starts.length = 0
  terminals.length = 0
}
const waitFor = async (flag: () => boolean): Promise<void> => {
  const by = Date.now() + 5_000
  while (!flag() && Date.now() < by) await sleep(10)
}
const driveOne = async (tool: Record<string, unknown>, id: string, ctx: Record<string, unknown>, updates: Yielded[]): Promise<void> => {
  for await (const update of runToolUse({ type: 'tool_use', id, name: tool.name as string, input: {} } as never, ASSISTANT, ALLOW, ctx as never)) {
    updates.push(update as Yielded)
  }
}
const PARTIAL = /partially executed/
const BACKGROUND = /background task or process .*keeps running/
const NEVER_RAN = /before it ran|nothing was changed/

console.log('============================================================')
console.log(" a cancelled call's result tells the truth about whether it ran")
console.log('============================================================')

section('A the real abandon road: a call that started and recorded a side effect, and the sibling queued behind it')
{
  resetTaps()
  const dir = mkdtempSync(join(tmpdir(), 'cancel-result-effects-'))
  const wrote = join(dir, 'the-started-call-wrote-this')
  const neverWrote = join(dir, 'the-sibling-would-write-this')
  let started = false
  let settleLate: (value: unknown) => void = () => {}
  const hung = new Promise<unknown>(resolve => {
    settleLate = resolve
  })
  const startedTool = makeTool('Writes', () => {
    writeFileSync(wrote, 'the call ran this far before the interrupt')
    started = true
    return hung
  })
  const siblingTool = makeTool('Follows', async () => {
    writeFileSync(neverWrote, 'must never run')
    return { data: 'must never run' }
  })
  const ctx = makeContext([startedTool, siblingTool])
  const assistant = createAssistantMessage({
    content: [
      { type: 'tool_use', id: 'toolu_started', name: 'Writes', input: {} },
      { type: 'tool_use', id: 'toolu_sibling', name: 'Follows', input: {} },
    ] as never,
  })
  const blocks = (assistant.message.content as Array<{ type: string }>).filter(b => b.type === 'tool_use')
  const updates: Yielded[] = []
  let ended = false
  const run = (async () => {
    for await (const update of runTools(blocks as never, [assistant] as never, ALLOW, ctx as never)) {
      updates.push(update as Yielded)
    }
    ended = true
  })()
  await waitFor(() => started)
  check('the first call started and recorded a side effect before the interrupt', started && existsSync(wrote))
  const abortedAt = Date.now()
  ctx.abortController.abort()
  await Promise.race([run, sleep(8_000)])
  const settledIn = Date.now() - abortedAt
  const results = resultsOf(updates)
  const startedResult = results.find(r => r.id === 'toolu_started')
  const siblingResult = results.find(r => r.id === 'toolu_sibling')
  const startedText = startedResult?.text ?? ''
  check('both calls settled once each within the grace and the run ended', ended && results.length === 2 && startedResult !== undefined && siblingResult !== undefined && settledIn < 2_500, `${results.length} result(s), ended=${ended}, ${settledIn}ms`)
  check('the side effect is on disk when the result settles: "nothing was changed" would be untrue of this call', existsSync(wrote))
  check('the started call does not settle with "before it ran; nothing was changed"', !NEVER_RAN.test(startedText), JSON.stringify(startedText))
  check("the started call settles with the interrupt result's shape (isInterruptedResultText)", isInterruptedResultText(startedText), JSON.stringify(startedText))
  check('it says an aborted command may have partially executed and asks for a check before re-running', PARTIAL.test(startedText) && /check before re-running/.test(startedText), JSON.stringify(startedText))
  check('it says a background task or process the call launched keeps running', BACKGROUND.test(startedText), JSON.stringify(startedText))
  check('it names the tool that had started', /this Writes call/.test(startedText), JSON.stringify(startedText))
  check("its words are turnCut's own for the signal's reason: one grammar, the turn machine's", startedText === turnCutResultText(turnCutOf(ctx.abortController.signal.reason), 'Writes'), JSON.stringify(startedText))
  check('the started result is an error block whose non-model-visible field carries the same words', startedResult?.isError === true && startedResult.toolUseResult === startedText, JSON.stringify(startedResult))
  check('the reader classifies the started result a stop, not an ordinary failure', isDenialResultText(startedText) && isDenialResultText(`<tool_use_error>${startedText}</tool_use_error>`))
  check('the sibling never started: no side effect', !existsSync(neverWrote))
  check("the sibling keeps today's sentence exactly: stopped before it ran, nothing changed", siblingResult?.text === CANCEL_MESSAGE && siblingResult.isError === true, JSON.stringify(siblingResult?.text))
  check('the started call was observed once as started and once as terminal ok:false; the sibling never', starts.length === 1 && starts[0]?.toolUseId === 'toolu_started' && terminals.length === 1 && terminals[0]?.toolUseId === 'toolu_started' && terminals[0]?.ok === false, JSON.stringify({ starts, terminals }))
  settleLate({ data: 'the late answer nobody asked for' })
  await sleep(50)
  check('a late answer from the abandoned call is dropped: no second result, no second terminal', resultsOf(updates).length === 2 && terminals.length === 1, JSON.stringify({ results: resultsOf(updates).length, terminals: terminals.length }))
  const raw = [assistant, ...updates.map(u => u.message).filter(m => m !== undefined)] as never[]
  const lookups = buildMessageLookups(normalizeMessages(raw as never) as never, raw as never)
  check('buildMessageLookups: both calls are resolved errors wearing the stop glyph set', ['toolu_started', 'toolu_sibling'].every(id => lookups.resolvedToolUseIDs.has(id) && lookups.erroredToolUseIDs.has(id) && lookups.deniedToolUseIDs.has(id)), [...lookups.deniedToolUseIDs].join(','))
  rmSync(dir, { recursive: true, force: true })
}

section("B a typed cut on a started call speaks the cut's own words, the same the turn machine gives an orphaned call")
{
  resetTaps()
  let started = false
  const tool = makeTool('Stalls', () => {
    started = true
    return new Promise<unknown>(() => {})
  })
  const ctx = makeContext([tool])
  const updates: Yielded[] = []
  const run = driveOne(tool, 'toolu_stalled', ctx, updates)
  await waitFor(() => started)
  abortWithCut(ctx.abortController, 'stalled')
  await Promise.race([run, sleep(8_000)])
  const text = resultsOf(updates)[0]?.text ?? ''
  check("a watchdog's cut on a started call: the cut's own words, from the one table", text === turnCutResultText(turnCutOf('stalled')) && text === 'Cut off by a no-progress timeout (the provider went quiet)', JSON.stringify(text))
  check('never the "before it ran" sentence: the call had started', !NEVER_RAN.test(text), JSON.stringify(text))
  check('still a stop for the reader, observed once as terminal ok:false', isDenialResultText(text) && terminals.length === 1 && terminals[0]?.ok === false)
}

section("C the never-started doors keep today's sentence")
{
  resetTaps()
  const tool = makeTool('NeverRuns', async () => ({ data: 'must never run' }))
  const preAborted = makeContext([tool])
  preAborted.abortController.abort()
  const before: Yielded[] = []
  await driveOne(tool, 'toolu_before', preAborted, before)
  const beforeText = resultsOf(before)[0]?.text ?? ''
  check('a call whose signal was aborted before it was resolved settles with CANCEL_MESSAGE exactly', beforeText === CANCEL_MESSAGE && resultsOf(before)[0]?.isError === true, JSON.stringify(beforeText))
  const decided = makeContext([tool])
  const abortingAllow = (async (_t: unknown, input: unknown) => {
    decided.abortController.abort()
    return { behavior: 'allow', updatedInput: input }
  }) as never
  const during: Yielded[] = []
  for await (const update of runToolUse({ type: 'tool_use', id: 'toolu_decision', name: 'NeverRuns', input: {} } as never, ASSISTANT, abortingAllow, decided as never)) {
    during.push(update as Yielded)
  }
  const duringText = resultsOf(during)[0]?.text ?? ''
  check('a call aborted while its permission was decided settles with CANCEL_MESSAGE exactly', duringText === CANCEL_MESSAGE, JSON.stringify(duringText))
  check('neither call ran, neither was observed', !before.some(u => resultsOf([u]).some(r => r.text.includes('must never run'))) && !during.some(u => resultsOf([u]).some(r => r.text.includes('must never run'))) && starts.length === 0 && terminals.length === 0, JSON.stringify({ starts, terminals }))
  check('the sentence itself still says before it ran; nothing was changed', /before it ran; nothing was changed/.test(CANCEL_MESSAGE))
}

section('D the source census: the settle sites in toolExecution.ts')
{
  const src = readFileSync(join(ROOT, 'src/services/tools/toolExecution.ts'), 'utf8')
  check("the abandon settle reads its words from turnCut for the signal's reason and names the tool", /const abandoned = error instanceof ToolCallAbandonedError[\s\S]{0,400}?const cutText = cutByTurn \? turnCutResultText\(turnCutOf\(signal\.reason\), tool\.name\) : undefined/.test(src))
  check('the facts are minted in turnCut.ts and nowhere in toolExecution.ts', !PARTIAL.test(src) && PARTIAL.test(readFileSync(join(ROOT, 'src/utils/messages/turnCut.ts'), 'utf8')))
  check('the three never-started gates still settle through the shared shape with its default words', (src.match(/push\(interruptResultUpdate\(toolUseID, sourceUUID\)\)/g) ?? []).length === 3)
  check('CANCEL_MESSAGE is minted in rejectionText.ts and is the stop block factory\'s content', /export const CANCEL_MESSAGE =/.test(readFileSync(join(ROOT, 'src/utils/messages/rejectionText.ts'), 'utf8')) && /content: CANCEL_MESSAGE,/.test(readFileSync(join(ROOT, 'src/utils/messages/factories.ts'), 'utf8')))
  check("the answered-abort settle keys on the turn's signal, runs the failure hooks, and reads the same words for the signal's reason", /const cutByTurn = isInterrupt && signal\.aborted[\s\S]*?if \(cutText !== undefined\) push\(interruptResultUpdate\(toolUseID, sourceUUID, cutText\)\)[\s\S]*?runPostToolUseFailureHooks\(/.test(src))
  check('one arm for a cut, whichever road: the abandoned call and the answered call are one isInterrupt, one cutByTurn, one settle', /const isInterrupt = abandoned \|\| isAbortError\(error\)/.test(src) && (src.match(/push\(interruptResultUpdate\(toolUseID, sourceUUID, cutText\)\)/g) ?? []).length === 1 && !/ToolCallAbandonedError\) \{/.test(src))
  check("the cut's hooks run under a signal of their own (the turn's is dead, and the engine drops any batch under an aborted signal) with the cut's words as the failure text and is_interrupt keyed on the cut", /cutText === undefined \? signal : undefined,\s*hookSeam,/.test(src) && /const message = cutText \?\? \(error instanceof Error \? error\.message : String\(error\)\)/.test(src) && /observableInput,\s*message,\s*cutByTurn,\s*toolUseContext,/.test(src) && /if \(signal\?\.aborted\) \{\s*return\s*\}/.test(readFileSync(join(ROOT, 'src/utils/hooks/engine.ts'), 'utf8')))
}

const abortNamed = (words: string): Error => Object.assign(new Error(words), { name: 'AbortError' })
const answersAbortWith = (name: string, words: string, onStart: () => void): Record<string, unknown> =>
  makeTool(name, (...args: unknown[]) => {
    const callContext = args[1] as { abortController: AbortController }
    onStart()
    return new Promise<unknown>((_resolve, reject) => {
      callContext.abortController.signal.addEventListener('abort', () => reject(abortNamed(words)), { once: true })
    })
  })

section("E a started call that answers the interrupt with a bare AbortError settles as the cut; a tool's own AbortError stays an error")
{
  const OWN_WORDS = 'The search was interrupted before it finished.'
  {
    resetTaps()
    let started = false
    const tool = answersAbortWith('Walks', OWN_WORDS, () => {
      started = true
    })
    const ctx = makeContext([tool])
    const updates: Yielded[] = []
    const run = driveOne(tool, 'toolu_walk', ctx, updates)
    await waitFor(() => started)
    const abortedAt = Date.now()
    ctx.abortController.abort()
    await Promise.race([run, sleep(8_000)])
    const settledIn = Date.now() - abortedAt
    const result = resultsOf(updates)[0]
    const text = result?.text ?? ''
    check("the call answered the operator's interrupt with an AbortError in its own words and settled once, inside the grace (the answer road, not the abandon road)", resultsOf(updates).length === 1 && settledIn < 700, `${resultsOf(updates).length} result(s), ${settledIn}ms`)
    check("the started call settles with the interrupt result's shape, in turnCut's words for the signal's reason, naming the tool", isInterruptedResultText(text) && text === turnCutResultText(turnCutOf(ctx.abortController.signal.reason), 'Walks'), JSON.stringify(text))
    check("never the AbortError's own words wrapped as an ordinary error", !text.includes(OWN_WORDS) && !/<tool_use_error>/.test(text), JSON.stringify(text))
    check('the reader classifies it a stop, not an ordinary failure', isDenialResultText(text), JSON.stringify(text))
    check('an error block whose non-model-visible field carries the same words', result?.isError === true && result.toolUseResult === text, JSON.stringify(result))
    check('observed once as started and once as terminal ok:false', starts.length === 1 && terminals.length === 1 && terminals[0]?.ok === false, JSON.stringify({ starts, terminals }))
  }
  {
    resetTaps()
    let started = false
    const tool = answersAbortWith('Listens', 'The request was interrupted.', () => {
      started = true
    })
    const ctx = makeContext([tool])
    const updates: Yielded[] = []
    const run = driveOne(tool, 'toolu_listen', ctx, updates)
    await waitFor(() => started)
    abortWithCut(ctx.abortController, 'stalled')
    await Promise.race([run, sleep(8_000)])
    const text = resultsOf(updates)[0]?.text ?? ''
    check("a watchdog's cut answered with an AbortError: the cut's own words, from the one table", text === turnCutResultText(turnCutOf('stalled'), 'Listens') && text === 'Cut off by a no-progress timeout (the provider went quiet)', JSON.stringify(text))
    check('still a stop for the reader, observed once as terminal ok:false', isDenialResultText(text) && terminals.length === 1 && terminals[0]?.ok === false, JSON.stringify({ text, terminals }))
  }
  {
    resetTaps()
    const OWN_DEADLINE = 'The walk was cancelled by its own deadline.'
    const tool = makeTool('Deadlines', async () => {
      await sleep(20)
      throw abortNamed(OWN_DEADLINE)
    })
    const ctx = makeContext([tool])
    const updates: Yielded[] = []
    await driveOne(tool, 'toolu_deadline', ctx, updates)
    const result = resultsOf(updates)[0]
    const text = result?.text ?? ''
    check("a tool's own AbortError while the turn's signal never aborted stays an error in the tool's own words — the signal tells the two apart", !ctx.abortController.signal.aborted && result?.isError === true && text === `<tool_use_error>${OWN_DEADLINE}</tool_use_error>` && result.toolUseResult === `Error: ${OWN_DEADLINE}`, JSON.stringify(result))
    check('the reader classifies it an ordinary failure, not a stop', !isDenialResultText(text), JSON.stringify(text))
    check('observed once as terminal ok:false', terminals.length === 1 && terminals[0]?.ok === false, JSON.stringify(terminals))
  }
}

section("F a cut is a failure for hooks: PostToolUseFailure fires once for a cut call on both roads, is_interrupt true, the cut's words as the failure text")
{
  const { addSessionHook } = await import('../../src/utils/hooks/sessionHooks.ts')
  const { getSessionId, setIsInteractive } = await import('../../src/bootstrap/state.ts')
  setIsInteractive(false)
  const hookDir = mkdtempSync(join(tmpdir(), 'cancel-result-hooks-'))
  const recorder = (name: string): string => join(hookDir, `${name}.jsonl`)
  type Fire = { hook_event_name?: string; tool_name?: string; tool_use_id?: string; error?: string; is_interrupt?: boolean }
  const fires = (name: string): Fire[] => (existsSync(recorder(name)) ? readFileSync(recorder(name), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Fire) : [])
  const hooked = (tool: Record<string, unknown>): { abortController: AbortController } & Record<string, unknown> => {
    const ctx = makeContext([tool])
    const setAppState = (f: (s: unknown) => unknown): void => {
      f((ctx.getAppState as () => unknown)())
    }
    ctx.setAppState = setAppState
    addSessionHook(setAppState as never, getSessionId(), 'PostToolUseFailure', tool.name as string, { type: 'command', command: `cat >> ${recorder(tool.name as string)}; echo >> ${recorder(tool.name as string)}` })
    return ctx
  }
  const RED_ABANDON = 'RED WHERE THE ABANDON ROAD SKIPS THE HOOKS'
  const RED_ANSWER = 'RED WHERE THE ANSWERED ROAD HANDS THE HOOKS THE DEAD SIGNAL'
  {
    resetTaps()
    let started = false
    const tool = makeTool('Hangs', () => {
      started = true
      return new Promise<unknown>(() => {})
    })
    const ctx = hooked(tool)
    const updates: Yielded[] = []
    const run = driveOne(tool, 'toolu_hangs', ctx, updates)
    await waitFor(() => started)
    ctx.abortController.abort()
    await Promise.race([run, sleep(8_000)])
    const text = resultsOf(updates)[0]?.text ?? ''
    const fired = fires('Hangs')
    check(`${RED_ABANDON}: the abandoned call fires PostToolUseFailure exactly once`, fired.length === 1, `${fired.length} fire(s)`)
    check(`${RED_ABANDON}: the hook reads is_interrupt true and the call's name and id`, fired[0]?.is_interrupt === true && fired[0]?.tool_name === 'Hangs' && fired[0]?.tool_use_id === 'toolu_hangs' && fired[0]?.hook_event_name === 'PostToolUseFailure', JSON.stringify(fired[0]))
    check(`${RED_ABANDON}: the hook's failure text is the cut's own words, the text the model reads`, fired[0]?.error === text && text === turnCutResultText(turnCutOf(ctx.abortController.signal.reason), 'Hangs'), JSON.stringify({ error: fired[0]?.error, text }))
    check('the abandoned call still settles once as the interrupt result, observed once as terminal ok:false', resultsOf(updates).length === 1 && isInterruptedResultText(text) && terminals.length === 1 && terminals[0]?.ok === false, JSON.stringify({ results: resultsOf(updates).length, text, terminals }))
  }
  {
    resetTaps()
    let started = false
    const tool = answersAbortWith('Answers', 'The operation was aborted.', () => {
      started = true
    })
    const ctx = hooked(tool)
    const updates: Yielded[] = []
    const run = driveOne(tool, 'toolu_answers', ctx, updates)
    await waitFor(() => started)
    ctx.abortController.abort()
    await Promise.race([run, sleep(8_000)])
    const text = resultsOf(updates)[0]?.text ?? ''
    const fired = fires('Answers')
    check(`${RED_ANSWER}: the answered call fires PostToolUseFailure exactly once`, fired.length === 1, `${fired.length} fire(s)`)
    check(`${RED_ANSWER}: the hook reads is_interrupt true, the cut's own words as the failure text, never the AbortError's own words`, fired[0]?.is_interrupt === true && fired[0]?.tool_use_id === 'toolu_answers' && fired[0]?.error === text && text === turnCutResultText(turnCutOf(ctx.abortController.signal.reason), 'Answers'), JSON.stringify({ fired: fired[0], text }))
    check('the two roads agree: one event, one flag, one grammar', fires('Hangs').length === 1 && fired.length === 1 && fires('Hangs')[0]?.is_interrupt === true && fired[0]?.is_interrupt === true && fires('Hangs')[0]?.error?.replace('Hangs', 'Answers') === fired[0]?.error, JSON.stringify({ abandon: fires('Hangs')[0]?.error, answered: fired[0]?.error }))
    check('the answered call still settles once as the interrupt result, observed once as terminal ok:false', resultsOf(updates).length === 1 && isInterruptedResultText(text) && terminals.length === 1 && terminals[0]?.ok === false, JSON.stringify({ results: resultsOf(updates).length, text, terminals }))
  }
  {
    resetTaps()
    const tool = makeTool('Breaks', async () => {
      throw new Error('the disk is full')
    })
    const ctx = hooked(tool)
    const updates: Yielded[] = []
    await driveOne(tool, 'toolu_breaks', ctx, updates)
    const fired = fires('Breaks')
    check('the control: an ordinary failure fires once with is_interrupt false and its own words, as before', fired.length === 1 && fired[0]?.is_interrupt === false && fired[0]?.error === 'the disk is full' && resultsOf(updates)[0]?.text === '<tool_use_error>the disk is full</tool_use_error>', JSON.stringify({ fired, text: resultsOf(updates)[0]?.text }))
  }
  {
    resetTaps()
    const tool = makeTool('Deadlines', async () => {
      await sleep(20)
      throw abortNamed('The walk was cancelled by its own deadline.')
    })
    const ctx = hooked(tool)
    const updates: Yielded[] = []
    await driveOne(tool, 'toolu_own_deadline', ctx, updates)
    const fired = fires('Deadlines')
    check("the control: a tool's own AbortError while the turn's signal is live is no user interrupt — the hook fires once with is_interrupt false and the tool's own words", !ctx.abortController.signal.aborted && fired.length === 1 && fired[0]?.is_interrupt === false && fired[0]?.error === 'The walk was cancelled by its own deadline.', JSON.stringify({ fired, aborted: ctx.abortController.signal.aborted }))
  }
  const docs = readFileSync(join(ROOT, 'docs/HOOKS.md'), 'utf8')
  check('the docs promise the event for a cut: PostToolUseFailure carries is_interrupt, and the SDK schema says when it is true', /`PostToolUseFailure` \| after a tool call fails \| .*`is_interrupt`/.test(docs) && /is_interrupt: z\.boolean\(\)\.optional\(\)\.describe\('True when the failure was a user interrupt'\)/.test(readFileSync(join(ROOT, 'src/entrypoints/sdk/coreSchemas.ts'), 'utf8')))
  rmSync(hookDir, { recursive: true, force: true })
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
console.log(failures === 0 ? 'CANCEL RESULT GREEN' : `${failures} CANCEL RESULT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
