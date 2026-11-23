import React from 'react'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { Message, TurnReceiptMessage } from '../../src/engine/message-shapes/message.js'
import { pinScratchHome, pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('resume-receipt-order')
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
delete process.env.MERCURY_TURN_RECEIPT
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { renderToString } = await import('../../src/screen/renderer/staticRender.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { composeTranscript } = await import('../../src/screen/messages/Messages.js')
const { MessageRow } = await import('../../src/screen/messages/MessageRow.js')
const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.js')
const { isNotEmptyMessage } = await import('../../src/engine/message-shapes/text.js')
const { createUserMessage } = await import('../../src/engine/messages/messages.js')

const timestamp = new Date().toISOString()
const reply = (text: string, inputTokens: number): Message => ({
  type: 'assistant', uuid: randomUUID(), timestamp,
  message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: inputTokens, output_tokens: 40 } },
} as Message)
const call = (name: string): Message[] => {
  const id = randomUUID()
  return [
    { type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: 'ledger.py', pattern: '*.py' } }] } } as Message,
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }),
  ]
}
const recap = (): Message => ({
  type: 'system', subtype: 'away_summary', uuid: randomUUID(), timestamp,
  content: 'The last turn is complete.',
  recapMetadata: { endedOnError: false, turns: 1, filesTouched: 3, lastActiveGapMs: 13 * 60_000 },
})
const prompt = createUserMessage({ content: 'What does this project do?' })
const answer = reply('The ledger records shifts and weekly hours.', 34_400)
const oldTurn = [prompt, ...call('Read'), ...call('Read'), ...call('Read'), ...call('Glob'), answer]
const resume = recap()
const compose = (messages: Message[]) => composeTranscript({
  normalized: normalizeMessages(messages).filter(isNotEmptyMessage), syntheticStreamingRows: [],
  verbose: false, fullscreen: true, isTranscriptMode: false, truncateTranscript: false,
  tools: [], inProgressToolUseIDs: new Set(),
})
const receipts = (messages: Message[]): TurnReceiptMessage[] => compose(messages).collapsed.filter((row): row is TurnReceiptMessage => row.type === 'turn_receipt')
let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}

try {
  const before = receipts(oldTurn)
  const resumed = [...oldTurn, resume]
  const after = receipts(resumed)
  check('resume keeps the last turn receipt identity and counts', JSON.stringify(before) === JSON.stringify(after), `before ${JSON.stringify(before)} after ${JSON.stringify(after)}; injectTurnReceipts in src/screen/cockpit/turnReceipt.ts must treat an away_summary row as a turn boundary that leaves the earlier receipt unchanged`)
  check('the receipt still counts three reads, one search and ctx +34.4k', after.length === 1 && after[0]?.counts.reads === 3 && after[0]?.counts.searches === 1 && after[0]?.contextDelta === 34_400, JSON.stringify(after[0]) + '; check the counting in walkTurnReceipts in src/screen/cockpit/turnReceipt.ts')
  for (const columns of [80, 110]) {
    const composition = compose(resumed)
    const frame = await renderToString(React.createElement(AppStateProvider, { children:
      React.createElement(Box, { flexDirection: 'column' },
        ...composition.collapsed.map((message, index) => React.createElement(MessageRow, {
          key: message.uuid, message, isUserContinuation: false,
          hasContentAfter: index < composition.collapsed.length - 1, tools: [], verbose: false,
          inProgressToolUseIDs: new Set<string>(), streamingToolUseIDs: new Set<string>(),
          screen: 'prompt', canAnimate: false, lastThinkingBlockId: null, latestBashOutputUUID: null,
          columns, isLoading: false, lookups: composition.lookups,
        }))),
    }), columns)
    console.log(`FRAME ${columns}\n${frame}`)
    const answerAt = frame.indexOf('The ledger records shifts')
    const receiptAt = frame.indexOf('3 reads · 1 search · ctx +34.4k')
    const recapAt = frame.indexOf('resumed clean')
    check(`${columns}: the real row renderer paints answer, receipt, then resume card`, answerAt >= 0 && receiptAt > answerAt && recapAt > receiptAt, `${answerAt}, ${receiptAt}, ${recapAt}; a -1 means that text never painted, otherwise the receipt must sit between the answer and the recap, which injectTurnReceipts in src/screen/cockpit/turnReceipt.ts decides`)
    check(`${columns}: exactly one turn summary and one resume card`, frame.split('ctx +34.4k').length === 2 && frame.split('resumed clean').length === 2, 'a turn receipt or resume card painted twice or not at all; see injectTurnReceipts in src/screen/cockpit/turnReceipt.ts and the FRAME dump above')
  }
  const nextPrompt = createUserMessage({ content: 'And the exports?' })
  const next = [...resumed, nextPrompt, ...call('Read'), reply('Exports are CSV files.', 35_600)]
  const nextReceipts = receipts(next)
  check('a new turn after resume gets its own counts and context delta', nextReceipts.length === 2 && nextReceipts[1]?.counts.reads === 1 && nextReceipts[1]?.contextDelta === 1200, `${nextReceipts.length} receipts; the second turn's counts and context delta come from walkTurnReceipts in src/screen/cockpit/turnReceipt.ts`)
  check('a second resume does not duplicate the previous receipt', JSON.stringify(receipts([...resumed, recap()])) === JSON.stringify(after), 'a second away_summary row must not emit another receipt; see injectTurnReceipts in src/screen/cockpit/turnReceipt.ts')
  check('a recap without a prior turn adds no receipt', receipts([recap()]).length === 0, 'injectTurnReceipts in src/screen/cockpit/turnReceipt.ts emitted a receipt for a recap with no turn before it')
  const noTools = compose([prompt, reply('An answer with no tools.', 100), recap()]).collapsed
  check('a zero-tool answer also keeps its receipt before the recap', noTools.findIndex(row => row.type === 'turn_receipt') < noTools.findIndex(row => row.type === 'system' && row.subtype === 'away_summary'), 'the receipt must come before the away_summary row; see injectTurnReceipts in src/screen/cockpit/turnReceipt.ts')
  process.env.MERCURY_TURN_RECEIPT = '0'
  check('the receipt toggle still removes the summary without dropping the recap', receipts(resumed).length === 0 && compose(resumed).collapsed.some(row => row.type === 'system' && row.subtype === 'away_summary'), 'with MERCURY_TURN_RECEIPT=0 isTurnReceiptEnabled in src/screen/cockpit/turnReceipt.ts must return the input rows unchanged, keeping the recap row')
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} resume receipt order: ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
