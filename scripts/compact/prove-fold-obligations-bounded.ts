;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-obligations-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { compactConversation, buildPostCompactMessages, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD } = await import('../../src/services/compact/compact.ts')
const { renderFoldLedger } = await import('../../src/services/compact/foldLedger.ts')
const { operatorMessagesBlockText } = await import('../../src/services/compact/operatorMessages.ts')
const { roughTokenCountEstimation } = await import('../../src/services/tokenEstimation.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')

let checks = 0
let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || !detail ? '' : `: ${detail}`}`)
}

let clock = Date.UTC(2026, 9, 16)
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content } }) as Message
function stretch(rounds: number, askChars: number, label: string): Message[] {
  const rows: Message[] = []
  for (let index = 0; index < rounds; index++) {
    rows.push(user(`${label} ask ${index}: ${'keep every operator word whole '.repeat(Math.ceil(askChars / 31))}`))
    const id = randomUUID()
    rows.push(assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: `${label}-command-${index} --check` } }]))
    rows.push({ ...user([{ type: 'tool_result', tool_use_id: id, content: `${label} result ${index} `.repeat(200) }]), toolUseResult: { code: 0 } } as Message)
    rows.push({ ...assistant([{ type: 'text', text: `${label} reply ${index}: done.` }]), message: { id: randomUUID(), role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `${label} reply ${index}: done.` }] } } as Message)
  }
  return rows
}
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'The stretch was folded; the operator asks are carried whole in the block and the summary names what was done about each.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'fold-obligations-proof', lane: 'main' })
type Progress = { type: string; stage?: string; hookType?: string }
const context = (events: Progress[] = [], abort = new AbortController()) => ({
  owner,
  abortController: abort,
  readFileState: createFileStateCacheWithSizeLimit(20),
  loadedNestedMemoryPaths: new Set<string>(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { tools: [], clients: [], commands: [], resources: {} } }),
  options: { tools: [], mcpClients: [], commands: [], agentDefinitions: { activeAgents: [] }, engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true },
  onCompactProgress: (event: Progress) => { events.push(event) },
}) as never
const fold = (messages: Message[], ctx: unknown, ceiling?: number) =>
  compactConversation(messages, ctx as never, { systemPrompt: ['fixture'], userContext: {}, systemContext: {}, toolUseContext: ctx as never, forkContextMessages: [] }, true, undefined, true, ceiling === undefined ? undefined : { autoCompactThreshold: ceiling } as never)
const indexOf = (result: Awaited<ReturnType<typeof fold>>) => renderFoldLedger(result.boundaryMarker.compactMetadata.ledger!)
const indexJson = (result: Awaited<ReturnType<typeof fold>>) => JSON.parse(indexOf(result).split('\n\n')[1]!) as Record<string, any>
const blockOf = (result: Awaited<ReturnType<typeof fold>>) => (result.operatorMessages?.attachment as { messages: Array<{ ordinal: number; text: string }>; omitted: number } | undefined)
const postCompactHooks = (events: Progress[]) => events.filter(event => event.type === 'hooks_start' && event.hookType === 'post_compact').length
const keptAsks = (result: Awaited<ReturnType<typeof fold>>, label: string) => (result.messagesToKeep ?? []).filter(row => row.type === 'user' && typeof row.message.content === 'string' && row.message.content.startsWith(`${label} ask `)).length

try {
  const first = await fold([...stretch(14, 1_200, 'one')], context())
  const firstIndex = indexJson(first)
  const firstBlock = blockOf(first)
  check('fold 1: the index covers its own stretch (14 tools) with nothing earlier', firstIndex.tools.length === 14 && firstIndex.earlierFolds.tools === 0 && firstIndex.earlierFolds.operatorMessages === 0 && firstIndex.earlierFolds.records === 0, JSON.stringify(firstIndex.earlierFolds))
  const keptOne = keptAsks(first, 'one')
  check(`fold 1: the operator block carries whole every ask that leaves the context (${14 - keptOne}; the ${keptOne} in the kept rounds ride in the tail)`, firstBlock !== undefined && keptOne > 0 && firstBlock.messages.length === 14 - keptOne && firstBlock.omitted === 0 && firstBlock.messages.every(entry => entry.text.startsWith('one ask ')), JSON.stringify(firstBlock?.messages.map(m => m.ordinal)))
  check('fold 1: the index carries no per-message open-ask rows', !('openAsks' in firstIndex))

  const second = await fold([...buildPostCompactMessages(first), ...stretch(14, 1_200, 'two')], context())
  const secondIndex = indexJson(second)
  const secondBlock = blockOf(second)
  const secondLedger = second.boundaryMarker.compactMetadata.ledger!
  check('fold 2: the index covers only the second stretch (14 new tools) and counts the earlier fold', secondIndex.tools.length === 14 && secondIndex.tools.every((tool: { command?: string }) => tool.command?.startsWith('two-command-')) && secondIndex.earlierFolds.tools === 14, JSON.stringify({ tools: secondIndex.tools.length, earlier: secondIndex.earlierFolds }))
  check('fold 2: the earlier operator messages are counted, not repeated, and the boundary record carries every receipt whole', secondIndex.earlierFolds.operatorMessages === 14 && secondLedger.tools.length === 28 && secondLedger.operator.length === 28 && secondIndex.witnessesInBoundary.argumentHashes === 28, JSON.stringify(secondIndex.witnessesInBoundary))
  const keptTwo = keptAsks(second, 'two')
  check(`fold 2: the operator block carries whole every ask leaving the context now (the ${keptOne} that rode in fold 1's tail and the ${14 - keptTwo} new ones) and fold 1's ${14 - keptOne} with them, within the budget — each ask once, nothing omitted`, secondBlock !== undefined && secondBlock.messages.length === 28 - keptTwo && secondBlock.omitted === 0 && secondBlock.messages.filter(entry => entry.text.startsWith('one ask ')).length === 14 && secondBlock.messages.filter(entry => entry.text.startsWith('two ask ')).length === 14 - keptTwo && secondBlock.messages[0]!.ordinal === 28 - keptTwo && secondBlock.messages.at(-1)!.ordinal === 1 && operatorMessagesBlockText(secondBlock as never).includes(`(all ${28 - keptTwo} of them)`), JSON.stringify({ omitted: secondBlock?.omitted, ordinals: secondBlock?.messages.map(m => m.ordinal) }))
  const indexBytes = [Buffer.byteLength(indexOf(first)), Buffer.byteLength(indexOf(second))]
  const blockBytes = [Buffer.byteLength(operatorMessagesBlockText(firstBlock as never)), Buffer.byteLength(operatorMessagesBlockText(secondBlock as never))]
  check(`the index stays bounded per fold (${indexBytes[0]} → ${indexBytes[1]} bytes) and the block grows only to the session's asks within its 20k-token budget (${blockBytes[0]} → ${blockBytes[1]} bytes)`, indexBytes[1] < indexBytes[0] * 1.5 && blockBytes[1] <= 20_000 * 4 + 2_000)
  const second2 = (first.summaryMessages[0]!.message.content as string)
  check('the summary message opens with the summary and ends with the stretch\'s index', second2.startsWith('The context window turned over') && second2.includes('## Fold ledger'))

  const paged = await fold(stretch(50, 300, 'paged'), context())
  const pagedIndex = indexJson(paged)
  check('a stretch of fifty tool calls: the index pages the newest forty receipts whole, counts the ten older ones and every call by tool, and the boundary record carries all fifty', pagedIndex.tools.length === 40 && pagedIndex.page.olderToolsOmitted === 10 && pagedIndex.stretch.tools === 50 && pagedIndex.stretch.byTool.Bash.calls === 50 && pagedIndex.tools[39].command === 'paged-command-49 --check' && paged.boundaryMarker.compactMetadata.ledger!.tools.length === 50, JSON.stringify(pagedIndex.page))

  const smallWindow = 40_000
  const bigAsks = stretch(12, 6_000, 'wide')
  const third = await fold(bigAsks, context(), smallWindow)
  const thirdBlock = blockOf(third)
  const thirdBlockTokens = thirdBlock ? thirdBlock.messages.reduce((n, m) => n + roughTokenCountEstimation(m.text), 0) : 0
  check(`a small window: fold 1 of a wide stretch lands under ${smallWindow} tokens with its block whole`, third.truePostCompactTokenCount !== undefined && third.truePostCompactTokenCount < smallWindow && thirdBlock !== undefined && thirdBlock.omitted === 0, String(third.truePostCompactTokenCount))
  const fourthInput = [...buildPostCompactMessages(third), ...stretch(12, 6_000, 'wider')]
  const fourth = await fold(fourthInput, context(), smallWindow)
  const fourthBlock = blockOf(fourth)
  const fourthBlockTokens = fourthBlock ? fourthBlock.messages.reduce((n, m) => n + roughTokenCountEstimation(m.text), 0) : 0
  const keptWide = keptAsks(third, 'wide')
  const keptWider = keptAsks(fourth, 'wider')
  const currentAsks = fourthBlock?.messages.filter(entry => entry.text.startsWith('wider ask ')) ?? []
  const earlierAsks = fourthBlock?.messages.filter(entry => entry.text.startsWith('wide ask ')) ?? []
  check(`fold 46ao: fold 2 lands under ${smallWindow}, keeps every retiring ask whole and carries earlier asks within the 20k budget`, fourth.truePostCompactTokenCount !== undefined && fourth.truePostCompactTokenCount < smallWindow && fourthBlock !== undefined && fourthBlock.omitted === 24 - keptWider - fourthBlock.messages.length && currentAsks.length === 12 - keptWider && earlierAsks.length >= keptWide && fourthBlockTokens <= 20_000 && fourthBlock.messages.every(entry => fourthInput.some(row => row.type === 'user' && row.message.content === entry.text) || thirdBlock?.messages.some(prior => prior.text === entry.text)) && (fourth.boundaryMarker.compactMetadata.recentRounds?.kept ?? 0) >= 1 && thirdBlockTokens > 0, JSON.stringify({ rounds: fourth.boundaryMarker.compactMetadata.recentRounds, omitted: fourthBlock?.omitted, current: currentAsks.length, earlier: earlierAsks.length }))

  const paidBefore = api.messageRequests().length
  const events: Progress[] = []
  const heavy = stretch(12, 20_000, 'heavy')
  const before = JSON.stringify(heavy)
  const ctxHeavy = context(events)
  ;(ctxHeavy as { readFileState: Map<string, unknown> }).readFileState.set('kept.ts', { content: 'original', timestamp: 1 } as never)
  let refusal = ''
  try { await fold(heavy, ctxHeavy, 10_000) } catch (error) { refusal = error instanceof Error ? error.message : String(error) }
  check('obligations over the ceiling: the fold refuses BEFORE any summary request, with the threshold key so the prune rung opens', refusal.startsWith(ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD) && refusal.includes('no summary was requested') && api.messageRequests().length === paidBefore, `${refusal.slice(0, 120)} requests=${api.messageRequests().length - paidBefore}`)
  check('…the original context is byte-identical, the read state kept, and no compaction.after hook fired', JSON.stringify(heavy) === before && (ctxHeavy as { readFileState: Map<string, { content: string }> }).readFileState.get('kept.ts')?.content === 'original' && postCompactHooks(events) === 0, JSON.stringify(events.map(e => e.hookType ?? e.stage ?? e.type)))

  const events2: Progress[] = []
  const giantId = randomUUID()
  const oneGiantRound = [user('fold me'), assistant([{ type: 'text', text: 'ready' }]), ...stretch(1, 100, 'small'), user('giant ask'), assistant([{ type: 'tool_use', id: giantId, name: 'Bash', input: { command: 'giant --dump' } }]), user([{ type: 'tool_result', tool_use_id: giantId, content: 'x'.repeat(200_000) }])]
  const paid2 = api.messageRequests().length
  let tailRefusal = ''
  let giant: Awaited<ReturnType<typeof fold>> | undefined
  try { giant = await fold(oneGiantRound, context(events2), 20_000) } catch (error) { tailRefusal = error instanceof Error ? error.message : String(error) }
  const giantRounds = giant?.boundaryMarker.compactMetadata.recentRounds
  const giantResults = (giant?.messagesToKeep ?? []).flatMap(row => row.type === 'user' && Array.isArray(row.message.content) ? row.message.content.filter(block => block.type === 'tool_result').map(block => String(block.content)) : [])
  check('a stretch whose latest complete round cannot fit whole: the round is kept with its giant result folded into the summary (one summary paid) and the fold lands under the threshold — no refusal, no prune rung', tailRefusal === '' && giant !== undefined && (giantRounds?.kept ?? 0) >= 1 && giantRounds?.folded === 1 && giantResults.filter(text => text.startsWith('[result folded into the summary above')).length === 1 && (giant.truePostCompactTokenCount ?? Infinity) < 20_000 && api.messageRequests().length === paid2 + 1, `${tailRefusal.slice(0, 140)} rounds=${JSON.stringify(giantRounds)} requests=${api.messageRequests().length - paid2}`)
  check('…and compaction.after fired once for the landed fold', postCompactHooks(events2) === 1, JSON.stringify(events2.map(e => e.hookType ?? e.stage ?? e.type)))

  const events3: Progress[] = []
  const landed = await fold(stretch(6, 400, 'hooks'), context(events3), 200_000)
  const order = events3.map(e => e.hookType ?? e.stage ?? e.type)
  check('a landed fold fires compaction.after exactly once, after the restore stage', postCompactHooks(events3) === 1 && order.includes('restoring') && order.indexOf('post_compact') > order.indexOf('restoring') && landed.summaryMessages.length === 1, JSON.stringify(order))
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold obligations bounded (${checks} checks, ${failures} failures)`)
process.exit(failures ? 1 : 0)
