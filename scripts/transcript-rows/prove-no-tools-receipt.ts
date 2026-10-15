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
const { NO_TOOLS_RAN_WORDS, hasActivity } = await import('../../src/utils/cockpit/turnReceipt.ts')

const timestamp = new Date().toISOString()
const reply = (text: string): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }] } } as Message)
const toolRound = (name: string): Message[] => {
  const id = randomUUID()
  return [
    { type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command: 'npx vitest run' } }] } } as Message,
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

  console.log('§4 the gate and the live row')
  process.env.MERCURY_TURN_RECEIPT = '0'
  check('MERCURY_TURN_RECEIPT=0: no receipt, the stream untouched', receiptsOf(claimed).length === 0)
  delete process.env.MERCURY_TURN_RECEIPT
  const messagesSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'Messages.tsx'), 'utf8')
  check('while the turn is in flight the live receipt paints counts only — the no-tools mark waits for the turn to settle', messagesSrc.includes('liveReceipt: hasActivity(last.counts) ? last : null'))
  const rowSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'messages', 'TurnReceiptRow.tsx'), 'utf8')
  check('the row prints the derive owner\'s words', rowSrc.includes('NO_TOOLS_RAN_WORDS'))
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} no-tools receipt (${failures} failures)`)
process.exit(failures ? 1 : 0)
