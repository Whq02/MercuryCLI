;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message, TurnReceiptMessage } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'no-tools-receipt-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
delete process.env.MERCURY_TURN_RECEIPT
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { TurnReceiptRow } = await import('../../src/components/messages/TurnReceiptRow.tsx')
const { composeTranscript } = await import('../../src/components/Messages.tsx')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { isNotEmptyMessage } = await import('../../src/utils/messages/text.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { NO_TOOLS_RAN_WORDS, hasActivity, formatContextDelta, promptTokensOf } = await import('../../src/utils/cockpit/turnReceipt.ts')

const timestamp = new Date().toISOString()
const usageOf = (prompt: number, cached = 0) => ({ input_tokens: prompt - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: 40 })
const reply = (text: string, prompt?: number): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], ...(prompt !== undefined ? { usage: usageOf(prompt, Math.floor(prompt / 2)) } : {}) } } as Message)
const toolRound = (name: string, prompt?: number): Message[] => {
  const id = randomUUID()
  return [
    { type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command: 'npx vitest run' } }], ...(prompt !== undefined ? { usage: usageOf(prompt) } : {}) } } as Message,
    { type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '23 passed' }] } } as Message,
  ]
}
const CLAIM = 'All 23 tests pass across 2 test files. Verified with pnpm vitest run — exit code 0, 5ms total runtime.'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? `: ${detail}` : ''}`)
}
const compose = (rows: Message[]) =>
  composeTranscript({ normalized: normalizeMessages(rows).filter(isNotEmptyMessage), syntheticStreamingRows: [], verbose: false, fullscreen: true, isTranscriptMode: false, truncateTranscript: false, tools: [], inProgressToolUseIDs: new Set() }).collapsed
const receiptsOf = (rows: Message[]): TurnReceiptMessage[] => compose(rows).filter((m): m is TurnReceiptMessage => m.type === 'turn_receipt')
const paint = async (receipt: TurnReceiptMessage): Promise<string> => (await renderToString(React.createElement(TurnReceiptRow, { message: receipt }), 100)).replace(/\s+/g, ' ').trim()

try {
  console.log('§1 the pass, step 5: "run the tests and tell me how many pass" answered in four seconds with no tool call')
  const claimed = [createUserMessage({ content: 'run the tests and tell me how many pass' }), reply(CLAIM)]
  const claimedReceipts = receiptsOf(claimed)
  check('the settled reply turn carries one receipt row', claimedReceipts.length === 1, String(claimedReceipts.length))
  check('its counts are all zero (the mark is the count, never a reading of the words)', claimedReceipts[0] !== undefined && !hasActivity(claimedReceipts[0].counts), JSON.stringify(claimedReceipts[0]?.counts))
  const painted = claimedReceipts[0] ? await paint(claimedReceipts[0]) : ''
  check(`the row paints "∙ ${NO_TOOLS_RAN_WORDS}" (the same row shape, one line)`, painted === `∙ ${NO_TOOLS_RAN_WORDS}`, painted)
  check('the receipt sits after the reply, at the end of the turn', compose(claimed).at(-1)?.type === 'turn_receipt')

  console.log('§2 the pass, step 6: the same words after a real run keep the counts')
  const ran = [createUserMessage({ content: 'run the tests' }), ...toolRound('Bash'), reply('All 23 tests pass again.')]
  const ranReceipts = receiptsOf(ran)
  const ranPainted = ranReceipts[0] ? await paint(ranReceipts[0]) : ''
  check('one receipt, "∙ 1 shell command", and never the no-tools words', ranReceipts.length === 1 && ranPainted === '∙ 1 shell command', ranPainted)

  console.log('§3 what is not a settled reply turn paints nothing')
  check('a prompt with no reply yet (the turn in flight) carries no receipt', receiptsOf([createUserMessage({ content: 'thinking…' })]).length === 0)
  check('two prompts with nothing between them carry no receipt', receiptsOf([createUserMessage({ content: 'one' }), createUserMessage({ content: 'two' })]).length === 0)
  const twoTurns = [createUserMessage({ content: 'first' }), reply('a plain answer'), createUserMessage({ content: 'second' }), ...toolRound('Bash'), reply('done')]
  const twoReceipts = receiptsOf(twoTurns)
  check('two turns: the first (no tools) and the second (one shell command) each carry their own receipt', twoReceipts.length === 2 && !hasActivity(twoReceipts[0]!.counts) && twoReceipts[1]!.counts.commands === 1, JSON.stringify(twoReceipts.map(r => r.counts.commands)))
  const first = compose(twoTurns)
  const firstReceiptAt = first.findIndex(m => m.type === 'turn_receipt')
  const secondPromptAt = first.findIndex(m => m.type === 'user' && JSON.stringify(m.message?.content).includes('"second"'))
  check('the no-tools receipt stands before the next prompt row', firstReceiptAt > 0 && secondPromptAt > firstReceiptAt, `${firstReceiptAt} ${secondPromptAt}`)

  console.log('§3b what is not a real reply: the resume sentinel and an error row')
  const { NO_RESPONSE_REQUESTED } = await import('../../src/utils/messages/rejectionText.ts')
  const sentinelRow = { type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: NO_RESPONSE_REQUESTED }] } } as Message
  check('a resumed session whose last prompt got only the synthetic "No response requested." row carries no receipt (nothing replied)', receiptsOf([createUserMessage({ content: 'an unanswered prompt' }), sentinelRow]).length === 0)
  const errorRow = { type: 'assistant', uuid: randomUUID(), timestamp, isApiErrorMessage: true, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'The request failed: the provider refused.' }] } } as Message
  check('a turn that ended on an API error row is not a reply: no no-tools receipt beside the error', receiptsOf([createUserMessage({ content: 'a prompt' }), errorRow]).length === 0)
  check('a real reply after the sentinel in a later turn still carries its receipt', receiptsOf([createUserMessage({ content: 'one' }), sentinelRow, createUserMessage({ content: 'two' }), reply('an answer')]).length === 1)

  console.log('§4 the gate and the live row')
  process.env.MERCURY_TURN_RECEIPT = '0'
  check('MERCURY_TURN_RECEIPT=0: no receipt, the stream untouched', receiptsOf(claimed).length === 0)
  delete process.env.MERCURY_TURN_RECEIPT
  const messagesSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'Messages.tsx'), 'utf8')
  check('while the turn is in flight the live receipt paints counts only — the no-tools mark waits for the turn to settle', messagesSrc.includes('liveReceipt: hasActivity(last.counts) ? last : null'))
  const rowSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'messages', 'TurnReceiptRow.tsx'), 'utf8')
  check('the row prints the derive owner\'s words', rowSrc.includes('NO_TOOLS_RAN_WORDS'))

  console.log('§5 the context delta: the turn\'s prompt-side growth from the usage the rows already carry')
  check('prompt tokens are the whole prompt side: uncached input + cache reads + cache writes', promptTokensOf({ input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 200 }) === 41200 && promptTokensOf({ input_tokens: 15214 }) === 15214 && promptTokensOf(undefined) === undefined && promptTokensOf({ output_tokens: 3 }) === undefined)
  check('the words: 1200 → "ctx +1.2k", −300 → "ctx −300", 0 → "ctx +0"', formatContextDelta(1200) === 'ctx +1.2k' && formatContextDelta(-300) === 'ctx −300' && formatContextDelta(0) === 'ctx +0', [formatContextDelta(1200), formatContextDelta(-300), formatContextDelta(0)].join(' | '))
  const withReceipts = [
    createUserMessage({ content: 'first' }),
    ...toolRound('Bash', 15000),
    reply('done', 15214),
    createUserMessage({ content: 'second' }),
    reply('All 23 tests pass. Verified with pnpm vitest run.', 16414),
    createUserMessage({ content: 'third' }),
    reply('a plain answer, no usage persisted'),
  ]
  const deltaReceipts = receiptsOf(withReceipts)
  check('three turns, three receipts', deltaReceipts.length === 3, String(deltaReceipts.length))
  check('the first turn\'s delta is its last request\'s prompt (nothing before it): 15,214', deltaReceipts[0]?.contextDelta === 15214, String(deltaReceipts[0]?.contextDelta))
  check('the second turn\'s delta is the growth over the first: +1,200', deltaReceipts[1]?.contextDelta === 1200, String(deltaReceipts[1]?.contextDelta))
  check('a turn whose rows carry no usage paints no delta', deltaReceipts[2]?.contextDelta === undefined, String(deltaReceipts[2]?.contextDelta))
  const firstPainted = deltaReceipts[0] ? await paint(deltaReceipts[0]) : ''
  check('a turn with tools paints its counts and the delta: "∙ 1 shell command · ctx +15.2k"', firstPainted === '∙ 1 shell command · ctx +15.2k', firstPainted)
  const secondPainted = deltaReceipts[1] ? await paint(deltaReceipts[1]) : ''
  check('a zero-tool turn paints the no-tools words AND the delta: "∙ no tools ran this turn · ctx +1.2k"', secondPainted === `∙ ${NO_TOOLS_RAN_WORDS} · ctx +1.2k`, secondPainted)
  const thirdPainted = deltaReceipts[2] ? await paint(deltaReceipts[2]) : ''
  check('no usage → the no-tools words alone', thirdPainted === `∙ ${NO_TOOLS_RAN_WORDS}`, thirdPainted)
  const { createCompactBoundaryMessage } = await import('../../src/utils/messages.ts')
  const { annotateBoundaryWithPreservedSegment, buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
  const keptPrompt = createUserMessage({ content: 'the kept prompt' })
  const keptReply = reply('the kept reply', 60000)
  const boundary = createCompactBoundaryMessage('auto', 80_000)
  annotateBoundaryWithPreservedSegment(boundary, boundary.uuid, [keptPrompt, keptReply])
  const summary = createUserMessage({ content: 'What was folded.', isCompactSummary: true, isVisibleInTranscriptOnly: true })
  const afterFold = [...buildPostCompactMessages({ boundaryMarker: boundary, summaryMessages: [summary], messagesToKeep: [keptPrompt, keptReply], attachments: [], hookResults: [], preCompactTokenCount: 80_000, postCompactTokenCount: 200 }), createUserMessage({ content: 'the first new prompt' }), reply('the first new reply', 15000)]
  const afterFoldReceipts = receiptsOf(afterFold)
  const keptReceipt = afterFoldReceipts.find(r => r.uuid === `${keptPrompt.uuid}-turn-receipt`)
  const newReceipt = afterFoldReceipts.at(-1)
  check('after an auto-fold that keeps a verbatim tail (the shipped default) the kept turn paints no delta (never its pre-fold +60.0k)', keptReceipt !== undefined && keptReceipt.contextDelta === undefined, JSON.stringify(afterFoldReceipts.map(r => [r.uuid, r.contextDelta])))
  check('the first new turn after the fold reads its own full size, never the fold\'s shrink: "ctx +15.0k"', newReceipt !== undefined && (await paint(newReceipt)) === `∙ ${NO_TOOLS_RAN_WORDS} · ctx +15.0k`, newReceipt ? await paint(newReceipt) : '')
  const shrink = receiptsOf([createUserMessage({ content: 'a' }), reply('one', 50000), createUserMessage({ content: 'b' }), reply('two', 48200)])
  check('a smaller prompt than the turn before reads as a negative delta: "ctx −1.8k"', shrink[1] !== undefined && (await paint(shrink[1])) === `∙ ${NO_TOOLS_RAN_WORDS} · ctx −1.8k`, shrink[1] ? await paint(shrink[1]) : '')
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} no-tools receipt (${failures} failures)`)
process.exit(failures ? 1 : 0)
