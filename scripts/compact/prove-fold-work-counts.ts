;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import type { Message, RenderableMessage, TurnReceiptMessage } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-work-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
process.env.MERCURY_TURN_RECEIPT = '1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compactConversation, partialCompactConversation, buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const { injectTurnReceipts } = await import('../../src/utils/cockpit/turnReceipt.ts')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { buildAwayRecap } = await import('../../src/utils/cockpit/awaySummary.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { readTranscriptChainSince } = await import('../../src/utils/sessionStorage/transcriptReader.ts')

let failures = 0
let checks = 0
const check = (label: string, condition: boolean, detail = '') => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || !detail ? '' : `: ${detail}`}`)
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
let clock = Date.UTC(2026, 9, 7)
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { id: randomUUID(), role: 'assistant', content } }) as Message
function round(name: string, input: Record<string, unknown> = {}, lines?: string[], error = false): Message[] {
  const id = randomUUID()
  const call = assistant([{ type: 'tool_use', id, name, input }])
  const result = user([{ type: 'tool_result', tool_use_id: id, content: 'done', ...(error ? { is_error: true } : {}) }])
  if (lines) Object.assign(result, { toolUseResult: { filePath: input.file_path, structuredPatch: [{ lines }] } })
  return [call, result]
}
const history: Message[] = [user('Repair the inventory reader and prove it.')]
for (const [name, input, lines] of [
  ['Read', { file_path: '/repo/inventory.py' }],
  ['Read', { file_path: '/repo/stock.csv' }],
  ['Bash', { command: 'python inventory.py stock.csv' }],
  ['Grep', { pattern: 'qty' }],
  ['Edit', { file_path: '/repo/inventory.py' }, ['+a1', '+a2', '+a3', '+a4', '-d1']],
  ['Bash', { command: 'python inventory.py stock.csv' }],
  ['Write', { file_path: '/repo/test_inventory.py' }, ['+t1', '+t2', '+t3', '+t4', '+t5', '+t6']],
  ['Bash', { command: 'python -m unittest' }],
  ['Bash', { command: 'python inventory.py stock.csv' }],
  ['Bash', { command: 'python -m unittest' }],
  ['Bash', { command: 'git status' }],
  ['Edit', { file_path: '/repo/inventory.py' }, ['+b1', '+b2', '+b3', '+b4', '-d2']],
  ['Read', { file_path: '/repo/test_inventory.py' }],
  ['Bash', { command: 'pyright inventory.py test_inventory.py' }],
] as Array<[string, Record<string, unknown>, string[]?]>) history.push(...round(name, input, lines))
history.push(assistant([{ type: 'text', text: 'The reader is repaired and the checks pass.' }]))
const receipts = (messages: readonly Message[]) => injectTurnReceipts([...messages] as RenderableMessage[], tmpdir()).filter((m): m is TurnReceiptMessage => m.type === 'turn_receipt')
const counts = (messages: readonly Message[]) => receipts(messages).map(row => row.counts)
const recap = (messages: readonly Message[]) => {
  const value = buildAwayRecap([...messages], clock + 600_000)
  return value && { turns: value.turns, filesTouched: value.filesTouched, topTools: value.topTools, toolFailures: value.toolFailures }
}
const makeContext = () => {
  const appState = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} } }
  return { abortController: new AbortController(), getAppState: () => appState, setAppState: () => {}, messages: [], readFileState: new Map(), options: { tools: [], mcpClients: [], engineModel: getEngineModel(), thinkingConfig: { type: 'adaptive' as const }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } } as never
}
const api = await startFixtureApi(Array.from({ length: 16 }, () => ({ kind: 'text' as const, text: 'The inventory reader was repaired and its tests passed. Preserve the completed work and continue with the next operator request.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const fold = (messages: Message[]) => compactConversation(messages, makeContext(), { systemPrompt: ['fixture posture'] } as never, true)
let diskIndex = 0
async function resumed(original: Message[], result: Awaited<ReturnType<typeof fold>>, oldShape = false): Promise<readonly Message[]> {
  const copy = structuredClone(result)
  if (oldShape) delete (copy.boundaryMarker.compactMetadata as Record<string, unknown>).work
  const sessionId = randomUUID()
  let parentUuid: string | null = null
  const rows: Record<string, unknown>[] = []
  const append = (message: Message, boundary = false) => {
    if (boundary) parentUuid = null
    const entry = { ...message, parentUuid, cwd: home, sessionId, version: '1.0.0-beta.28', isSidechain: false }
    parentUuid = message.uuid
    rows.push(entry)
  }
  for (const message of original) append(message)
  for (const message of buildPostCompactMessages(copy).filter(m => !(copy.messagesToKeep ?? []).some(kept => kept.uuid === m.uuid))) append(message, message === copy.boundaryMarker)
  const path = join(home, `session-${diskIndex++}.jsonl`)
  writeFileSync(path, encodeSeedTranscript(rows, sessionId, new Date(clock).toISOString()))
  const read = await readTranscriptChainSince(path, null)
  check('saved boundary and kept chain load without refusal', read.view.refusal === null, String(read.view.refusal))
  return read.rows
}
try {
  const before = counts(history)
  check('fixture is the full reported turn', before[0]?.fileEdits === 3 && before[0]?.adds === 14 && before[0]?.dels === 2 && before[0]?.reads === 3 && before[0]?.searches === 1 && before[0]?.commands === 7, JSON.stringify(before))
  const result = await fold(history)
  const after = buildPostCompactMessages(result)
  check('fold prunes part of the turn', (result.messagesToKeep?.length ?? 0) > 0 && result.messagesToKeep!.length < history.length)
  check('work line retains the full turn after the fold', equal(counts(after), before), JSON.stringify(counts(after)))
  check('resume card retains the full work after the fold', equal(recap(after), recap(history)), JSON.stringify(recap(after)))
  const cold = await resumed(history, result)
  check('work line retains the full turn after cold resume', equal(counts(cold), before), JSON.stringify(counts(cold)))
  check('resume card retains the full work after cold resume', equal(recap(cold), recap(history)), JSON.stringify(recap(cold)))
  const legacy = structuredClone(after)
  delete (legacy[0] as { compactMetadata: Record<string, unknown> }).compactMetadata.work
  const legacyCold = await resumed(history, result, true)
  check('old-shape sessions keep their existing receipt fallback', equal(counts(legacyCold), counts(legacy)))
  check('old-shape sessions keep their existing recap fallback', equal(recap(legacyCold), recap(legacy)))
  check('old-shape fallback remains the kept-tail counts', counts(legacy)[0]?.fileEdits === 1 && counts(legacy)[0]?.reads === 1 && counts(legacy)[0]?.commands === 3, JSON.stringify(counts(legacy)))
  check('the original receipt identity survives folding and resume', receipts(after)[0]?.uuid === receipts(history)[0]?.uuid && receipts(cold)[0]?.uuid === receipts(history)[0]?.uuid)
  const grouped = buildPostCompactMessages({ ...result, messagesToKeep: [] }) as RenderableMessage[]
  grouped.push({ type: 'grouped_tool_use', uuid: randomUUID(), messages: result.messagesToKeep!.filter(m => m.type === 'assistant'), results: result.messagesToKeep!.filter(m => m.type === 'user') } as RenderableMessage)
  check('a grouped retained tail receives its folded counts once', equal(injectTurnReceipts(grouped, tmpdir()).filter(m => m.type === 'turn_receipt').map(m => m.counts), before))

  const splitRows = structuredClone(after)
  const firstKept = splitRows.find(m => m.uuid === result.messagesToKeep![0]!.uuid)!
  if (firstKept.type === 'assistant') firstKept.message.content.unshift({ type: 'text', text: 'Checking once more.' })
  const normalized = normalizeMessages(splitRows)
  check('normalized split message identities still receive the carry', equal(counts(normalized), before), JSON.stringify(counts(normalized)))

  const extra = [...round('Bash'), assistant([{ type: 'text', text: 'One more check passed.' }])]
  const continued = [...after, ...extra]
  const repeated = await fold(continued)
  check('a repeated fold carries earlier counts and new work exactly once', equal(counts(buildPostCompactMessages(repeated)), counts([...history, ...extra])))
  check('a repeated fold retains the cumulative recap', equal(recap(buildPostCompactMessages(repeated)), recap([...history, ...extra])))
  const repeatedCold = await resumed(continued, repeated)
  check('a repeated fold remains exact after disk replay', equal(counts(repeatedCold), counts([...history, ...extra])) && equal(recap(repeatedCold), recap([...history, ...extra])))

  const secondTurn = [user('Read the tests once more.'), ...round('Read', { file_path: '/repo/test_inventory.py' }), assistant([{ type: 'text', text: 'The tests still cover the fix.' }])]
  const multiple = [...history, ...secondTurn]
  const multipleFold = await fold(multiple)
  check('retained prompts keep adjacent turn counts separate', equal(counts(buildPostCompactMessages(multipleFold)), counts(multiple)), JSON.stringify(counts(buildPostCompactMessages(multipleFold))))
  check('retained prompts do not double-count recap turns or files', equal(recap(buildPostCompactMessages(multipleFold)), recap(multiple)))
  const multipleCold = await resumed(multiple, multipleFold)
  check('multiple kept turns remain separate on cold resume', equal(counts(multipleCold), counts(multiple)))

  for (const direction of ['up_to', 'from'] as const) {
    const partial = await partialCompactConversation(history, 11, makeContext(), { systemPrompt: ['fixture posture'] } as never, undefined, direction)
    const partialMessages = buildPostCompactMessages(partial)
    check(`${direction} partial fold retains the straddling turn's receipt`, equal(counts(partialMessages), before), JSON.stringify(counts(partialMessages)))
    check(`${direction} partial fold retains the complete recap`, equal(recap(partialMessages), recap(history)))
    const partialCold = await resumed(history, partial)
    check(`${direction} partial fold retains both counters on disk`, equal(counts(partialCold), before) && equal(recap(partialCold), recap(history)), JSON.stringify({ counts: counts(partialCold), recap: recap(partialCold) }))
    const foldedAgain = await fold(partialMessages)
    check(`${direction} followed by a full fold does not duplicate counts`, equal(counts(buildPostCompactMessages(foldedAgain)), before) && equal(recap(buildPostCompactMessages(foldedAgain)), recap(history)))
  }

  const failed = [user('Try a denied write.'), ...round('Edit', { file_path: '/repo/denied.py' }, undefined, true), ...round('Read', { file_path: '/repo/allowed.py' }), assistant([{ type: 'text', text: 'The write was denied.' }])]
  for (const direction of ['up_to', 'from'] as const) {
    const cut = await partialCompactConversation(failed, 2, makeContext(), { systemPrompt: ['fixture posture'] } as never, undefined, direction)
    check(`${direction} split failure keeps its count and excludes the denied file`, equal(recap(buildPostCompactMessages(cut)), recap(failed)))
  }

  process.env.MERCURY_COMPACT_KEEP_TAIL = '0'
  process.env.MERCURY_TURN_RECEIPT = '0'
  const noTail = await fold(history)
  process.env.MERCURY_TURN_RECEIPT = '1'
  process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
  check('a tail-free fold still records work while receipt display is disabled', equal(counts(buildPostCompactMessages(noTail)), before) && equal(recap(buildPostCompactMessages(noTail)), recap(history)))
  const noTailCold = await resumed(history, noTail)
  check('a tail-free fold restores its counts on resume', equal(counts(noTailCold), before) && equal(recap(noTailCold), recap(history)))
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold work counts (${checks} checks, ${failures} failures)`)
process.exit(failures ? 1 : 0)
