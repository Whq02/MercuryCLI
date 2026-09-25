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
  check("the abandon settle reads its words from turnCut for the signal's reason and names the tool", /ToolCallAbandonedError\) \{[\s\S]{0,400}?turnCutResultText\(turnCutOf\(signal\.reason\), tool\.name\)/.test(src))
  check('the facts are minted in turnCut.ts and nowhere in toolExecution.ts', !PARTIAL.test(src) && PARTIAL.test(readFileSync(join(ROOT, 'src/utils/messages/turnCut.ts'), 'utf8')))
  check('the three never-started gates still settle through the shared shape with its default words', (src.match(/push\(interruptResultUpdate\(toolUseID, sourceUUID\)\)/g) ?? []).length === 3)
  check('CANCEL_MESSAGE is minted in rejectionText.ts and is the stop block factory\'s content', /export const CANCEL_MESSAGE =/.test(readFileSync(join(ROOT, 'src/utils/messages/rejectionText.ts'), 'utf8')) && /content: CANCEL_MESSAGE,/.test(readFileSync(join(ROOT, 'src/utils/messages/factories.ts'), 'utf8')))
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
console.log(failures === 0 ? 'CANCEL RESULT GREEN' : `${failures} CANCEL RESULT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
