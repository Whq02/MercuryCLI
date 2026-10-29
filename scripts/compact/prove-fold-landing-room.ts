;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-landing-room-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { compactConversation, buildPostCompactMessages, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD } = await import('../../src/services/compact/compact.ts')
const tailModule = await import('../../src/services/compact/verbatimTail.ts') as Record<string, unknown>
const { foldReceipt, foldReceiptWords } = await import('../../src/services/compact/foldReceipt.ts')
const { estimateContextTokens } = await import('../../src/services/compact/microCompact.ts')
const { groupMessagesByApiRound } = await import('../../src/services/compact/grouping.ts')
const LANDING_ROOM_FLOOR_TOKENS = (tailModule.LANDING_ROOM_FLOOR_TOKENS as number | undefined) ?? 20_000
const LANDING_ROOM_MAX_SHARE = (tailModule.LANDING_ROOM_MAX_SHARE as number | undefined) ?? 2
const FOLDED_RESULT_KEY = (tailModule.FOLDED_RESULT_KEY as string | undefined) ?? '[result folded into the summary above'
const foldLandingCeiling = (tailModule.foldLandingCeiling as ((threshold: number, messages: readonly Message[], ratio?: number, residuals?: readonly number[]) => number) | undefined) ?? ((threshold: number, messages: readonly Message[], ratio = 1): number => {
  const largest = Math.max(0, ...groupMessagesByApiRound([...messages]).map(group => estimateContextTokens(group)))
  return Math.max(1, threshold - Math.min(Math.max(Math.ceil(largest * ratio), LANDING_ROOM_FLOOR_TOKENS), Math.floor(threshold / LANDING_ROOM_MAX_SHARE)))
})
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')

let checks = 0
let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || !detail ? '' : `: ${detail}`}`)
}

let clock = Date.UTC(2026, 9, 17)
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content } }) as Message
function stretch(rounds: number, resultChars: number, label: string, askChars = 60): Message[] {
  const rows: Message[] = []
  for (let index = 0; index < rounds; index++) {
    rows.push(user(`${label} ask ${index}: ${'read the next file '.repeat(Math.ceil(askChars / 19))}`))
    const id = randomUUID()
    rows.push(assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: `/notes/${label}-${index}.txt` } }]))
    rows.push({ ...user([{ type: 'tool_result', tool_use_id: id, content: `${label} notes ${index} line `.repeat(Math.ceil(resultChars / 20)) }]), toolUseResult: { code: 0 } } as Message)
  }
  return rows
}
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'The notes files were read one by one and summarised; the operator asks are carried whole in the block beside this summary.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'fold-landing-room-proof', lane: 'main' })
const context = () => ({
  owner,
  abortController: new AbortController(),
  readFileState: createFileStateCacheWithSizeLimit(20),
  contentReplacementState: createContentReplacementState(),
  loadedNestedMemoryPaths: new Set<string>(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { tools: [], clients: [], commands: [], resources: {} } }),
  options: { tools: [], mcpClients: [], commands: [], agentDefinitions: { activeAgents: [] }, engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true },
}) as never
const fold = (messages: Message[], ctx: unknown, threshold: number) =>
  compactConversation(messages, ctx as never, { systemPrompt: ['fixture'], userContext: {}, systemContext: {}, toolUseContext: ctx as never, forkContextMessages: [] }, true, undefined, true, { autoCompactThreshold: threshold, isRecompaction: false, turnsSincePreviousCompact: -1, querySource: 'sdk' })
const roundsOf = (result: Awaited<ReturnType<typeof fold>>) => result.boundaryMarker.compactMetadata.recentRounds!
const wordsOf = (result: Awaited<ReturnType<typeof fold>>) => foldReceiptWords(foldReceipt(result.boundaryMarker.compactMetadata))
const keptResults = (result: Awaited<ReturnType<typeof fold>>): string[] => (result.messagesToKeep ?? []).flatMap(row => row.type === 'user' && Array.isArray(row.message.content) ? row.message.content.filter(block => block.type === 'tool_result').map(block => typeof block.content === 'string' ? block.content : JSON.stringify(block.content)) : [])

try {
  console.log('L1 a fold leaves room for the next turn: the kept rounds stop at the landing line, not at the threshold')
  {
    const threshold = 60_000
    const history = stretch(12, 24_000, 'tidy')
    const landing = foldLandingCeiling(threshold, history)
    const largest = Math.max(...history.filter(row => row.type === 'user').map(row => estimateContextTokens([row])))
    check(`the landing line sits a turn under the threshold: ${landing} = ${threshold} − max(the largest round ≈${largest}, ${LANDING_ROOM_FLOOR_TOKENS}), capped at a ${LANDING_ROOM_MAX_SHARE}th of the threshold`, landing === threshold - Math.min(Math.max(largest, LANDING_ROOM_FLOOR_TOKENS), Math.floor(threshold / LANDING_ROOM_MAX_SHARE)) && landing < threshold - LANDING_ROOM_FLOOR_TOKENS + 1, String(landing))
    const result = await fold(history, context(), threshold)
    const post = result.truePostCompactTokenCount ?? Infinity
    const rounds = roundsOf(result)
    check(`the fold lands under the landing line (${post} < ${landing}), keeping ${rounds.kept} of ${rounds.requested} rounds whole (red on the base: it kept as many as fit under ${threshold})`, post < landing && rounds.kept >= 1 && rounds.kept < 10 && (rounds.folded ?? 0) === 0, JSON.stringify({ post, rounds }))
    check(`the next turn has at least a turn of room: ${threshold - post} ≥ ${Math.max(largest, LANDING_ROOM_FLOOR_TOKENS)}`, threshold - post >= Math.max(largest, LANDING_ROOM_FLOOR_TOKENS), String(threshold - post))
    check('every kept result rides whole — no placeholder when whole rounds fit', keptResults(result).every(text => !text.startsWith(FOLDED_RESULT_KEY)) && keptResults(result).length === rounds.kept)
    check('the receipt names the kept count and the request budget', wordsOf(result)[0] === `last ${rounds.kept} of 10 rounds kept whole (the request budget)`, wordsOf(result)[0])
    const again = await fold([...buildPostCompactMessages(result), ...stretch(3, 24_000, 'next')], context(), threshold)
    check('a second fold over the post-fold context lands under its own landing line too (the refill law holds fold after fold)', (again.truePostCompactTokenCount ?? Infinity) < foldLandingCeiling(threshold, [...buildPostCompactMessages(result), ...stretch(3, 24_000, 'next')]), String(again.truePostCompactTokenCount))
  }

  console.log('L2 one round larger than the room: its large result is folded into the summary, the round stays complete, the fold lands under the landing line')
  {
    const threshold = 60_000
    const history = [...stretch(2, 2_000, 'small'), ...stretch(1, 140_000, 'giant')]
    const landing = foldLandingCeiling(threshold, history)
    const ctx = context() as { contentReplacementState: { replacements: Map<string, string>; seenIds: Set<string> } }
    const result = await fold(history, ctx, threshold)
    const post = result.truePostCompactTokenCount ?? Infinity
    const rounds = roundsOf(result)
    const folded = keptResults(result).filter(text => text.startsWith(FOLDED_RESULT_KEY))
    check(`the fold lands under the landing line (${post} < ${landing}) with the latest round kept and its giant result folded (red on the base: the giant round rode whole, ${rounds.kept} kept)`, post < landing && rounds.kept === 1 && rounds.folded === 1 && folded.length === 1, JSON.stringify({ post, landing, rounds, folded: folded.length }))
    check('the placeholder names the tool, the file and the bytes, and points at the summary and the tool', folded[0] !== undefined && /^\[result folded into the summary above: [\d,]+ bytes from Read \/notes\/giant-0\.txt; the summary carries what it said — run the tool again for the content\]$/.test(folded[0]), folded[0] ?? '')
    const giantId = history.find(row => row.type === 'assistant' && Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'tool_use' && String((block as { input?: { file_path?: string } }).input?.file_path).includes('giant')))
    const toolUseId = giantId !== undefined && giantId.type === 'assistant' && Array.isArray(giantId.message.content) ? String((giantId.message.content[0] as { id?: string }).id) : ''
    check('the replacement is registered on the live context so every later request and a resume read the placeholder, never the bytes', ctx.contentReplacementState.replacements.get(toolUseId) === folded[0] && ctx.contentReplacementState.seenIds.has(toolUseId), JSON.stringify([...ctx.contentReplacementState.replacements.keys()]))
    check('the receipt says a large result was folded', wordsOf(result)[0] === 'last 1 of 10 rounds kept, 1 large result folded into the summary (the request budget)', wordsOf(result)[0])
    check("the folded Read's file leaves the read ledger: an edit needs a fresh read", ![...(ctx as unknown as { readFileState: Map<string, unknown> }).readFileState.keys()].some(path => path.includes('giant')))
  }

  console.log('L3 fold 46ao: the content-counted core alone is over the landing line but under the threshold: no room left for a turn')
  {
    const threshold = 60_000
    const history = [...stretch(2, 400, 'head', 80_000), ...stretch(10, 400, 'wide')]
    const landing = foldLandingCeiling(threshold, history)
    const result = await fold(history, context(), threshold)
    const post = result.truePostCompactTokenCount ?? Infinity
    const rounds = roundsOf(result)
    check(`the fold lands between the landing line and the threshold (${landing} ≤ ${post} < ${threshold}) with the widest tail that fits under the threshold, nothing narrowed or folded for nothing, and the reason no-room`, post >= landing && post < threshold && rounds.kept === 10 && (rounds.folded ?? 0) === 0 && rounds.reason === 'no-room', JSON.stringify({ post, landing, rounds }))
    check('the receipt says it once', wordsOf(result)[0] === 'last 10 rounds kept whole (no room left for a turn)', wordsOf(result)[0])
  }

  console.log('L5 the room is in the gauge\'s units: with a learned density ratio above 1 the landing line leaves room for the largest round AS THE GAUGE COUNTS IT')
  {
    const { calibrationKeyFor } = await import('../../src/services/run/contextCalibration.ts')
    const { readRequestGauge } = await import('../../src/services/run/requestGauge.ts')
    const { roughTokenCountEstimationForMessages } = await import('../../src/services/tokenEstimation.ts')
    const ratio = 1.4
    const threshold = 126_000
    const history = stretch(8, 96_000, 'dense')
    const at = history.length - 2
    const last = history[at] as Message & { type: 'assistant'; message: { stop_reason: string } }
    const anchored = { ...last, message: { ...last.message, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, contextGauge: { version: 1 as const, key: calibrationKeyFor('anthropic', 'claude-opus-4-8'), epoch: 7, digest: 'proof', rawTokens: 0, fixed: { digest: 'proof-fixed', tokens: 0 }, density: { ratio, samples: 1, residuals: [] }, sample: { eligible: false, denominator: 0, measured: 0, reason: 'proof' } } } as Message
    const gauged = [...history.slice(0, at), anchored, ...history.slice(at + 1)]
    const gauge = readRequestGauge(gauged, 'claude-opus-4-8')
    const largestRaw = Math.max(...groupMessagesByApiRound([...gauged]).map(group => roughTokenCountEstimationForMessages(group)))
    const largestGauge = Math.ceil(largestRaw * ratio)
    check(`the rig binds a gauge whose density ratio is ${ratio} (the largest round: ${largestRaw} raw tokens, ${largestGauge} as the gauge counts it)`, gauge !== null && gauge.density.ratio === ratio && largestRaw > LANDING_ROOM_FLOOR_TOKENS, JSON.stringify(gauge?.density))
    const landing = foldLandingCeiling(threshold, gauged, ratio)
    check(`the landing line takes the room in the gauge's units: ${landing} = ${threshold} − ${largestGauge} (red before: the room was the raw ${largestRaw})`, landing === threshold - Math.min(Math.max(largestGauge, LANDING_ROOM_FLOOR_TOKENS), Math.floor(threshold / LANDING_ROOM_MAX_SHARE)), String(landing))
    const guarded = foldLandingCeiling(threshold, gauged, ratio, [585, 225, -80, Number.NaN])
    check('the room includes the largest measured positive underestimate', guarded === threshold - Math.ceil(largestRaw * ratio + 585), String(guarded))
    check('negative or invalid residuals never reduce the existing room', foldLandingCeiling(threshold, gauged, ratio, [-80, Number.NaN]) === landing)
    const result = await fold(gauged, context(), threshold)
    const post = result.truePostCompactTokenCount ?? Infinity
    const rounds = roundsOf(result)
    check(`the fold lands with room for the largest round as the gauge counts it: ${threshold} − ${post} ≥ ${largestGauge} (red before: the fold kept one round more and left ${threshold} − post < ${largestGauge})`, threshold - post >= largestGauge && post < landing, JSON.stringify({ post, landing, rounds }))
    check('the kept rounds ride whole (the gauge changes the count, never the content)', keptResults(result).every(text => !text.startsWith(FOLDED_RESULT_KEY)) && (rounds.folded ?? 0) === 0 && rounds.kept >= 1, JSON.stringify(rounds))
  }

  console.log('L6 the fourth road: a latest round whose folded form fits under the threshold but not under the landing line is kept with its result folded and the row says no room')
  {
    const threshold = 60_000
    const history = [...stretch(2, 400, 'core', 76_000), ...stretch(1, 400, 'small'), ...stretch(1, 100_000, 'giant')]
    const landing = foldLandingCeiling(threshold, history)
    let refusal = ''
    let result: Awaited<ReturnType<typeof fold>> | undefined
    try { result = await fold(history, context(), threshold) } catch (error) { refusal = error instanceof Error ? error.message : String(error) }
    const post = result?.truePostCompactTokenCount ?? Infinity
    const rounds = result === undefined ? undefined : roundsOf(result)
    const folded = result === undefined ? [] : keptResults(result).filter(text => text.startsWith(FOLDED_RESULT_KEY))
    check(`the fold lands between the line and the threshold (${landing} ≤ ${post} < ${threshold}) with the latest rounds kept, the giant result folded and the reason no-room (red before: refused — "the latest complete round does not fit")`, refusal === '' && post >= landing && post < threshold && (rounds?.kept ?? 0) >= 1 && rounds?.folded === 1 && folded.length === 1 && rounds?.reason === 'no-room', `${refusal.slice(0, 120)} ${JSON.stringify({ post, landing, rounds, folded: folded.length })}`)
    check('the small result beside it rides whole (the folding stops at the threshold, largest first)', result !== undefined && keptResults(result).some(text => text.startsWith('small notes 0 line')), JSON.stringify(result === undefined ? [] : keptResults(result).map(t => t.slice(0, 30))))
    check('the receipt says it', result !== undefined && wordsOf(result)[0] === `last ${rounds?.kept} of 10 rounds kept, 1 large result folded into the summary (no room left for a turn)`, result === undefined ? refusal.slice(0, 80) : wordsOf(result)[0])
  }

  console.log('L4 the threshold law stands: a core over the threshold itself still refuses before any summary')
  {
    let refusal = ''
    const paid = api.messageRequests().length
    try { await fold([...stretch(2, 400, 'over', 76_000), ...stretch(10, 400, 'tail')], context(), 10_000) } catch (error) { refusal = error instanceof Error ? error.message : String(error) }
    check('the obligations over the threshold refuse with the threshold key and no summary request', refusal.startsWith(ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD) && api.messageRequests().length === paid, refusal.slice(0, 120))
  }
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold landing room (${checks} checks, ${failures} failures)`)
process.exit(failures ? 1 : 0)
