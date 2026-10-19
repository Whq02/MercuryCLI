#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'notice-rows-operator-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let count = 0
function check(label: string, cond: boolean, detail = ''): void {
  count++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { isOperatorTurn, countOperatorTurns } = await import('../../src/utils/messages/operatorTurns.ts')
const { selectOperatorMessages, operatorTextOf } = await import('../../src/services/compact/operatorMessages.ts')
type AnyMsg = Parameters<typeof selectOperatorMessages>[0][number]

const NOTICE = `<task-notification>\n<task-id>a1b2c3</task-id>\n<status>completed</status>\n<summary>Crewmate "builder" completed</summary>\n</task-notification>`
const HIS = 'carry on with the lane; fold the reviewed waves and ask me before any push'
const OPENING = 'start the .39 lanes: field fixes first'

section('§1 a notice row is never an operator turn, whichever way it was written (the field row M39-07)')
{
  const olderBuild = createUserMessage({ content: NOTICE }) as unknown as AnyMsg
  const currentBuild = createUserMessage({ content: `<system-reminder>\n${NOTICE}\n</system-reminder>`, origin: { kind: 'task-notification' } as never, isMeta: true }) as unknown as AnyMsg
  const originOnly = createUserMessage({ content: NOTICE, origin: { kind: 'task-notification' } as never }) as unknown as AnyMsg
  const his = createUserMessage({ content: HIS }) as unknown as AnyMsg
  check('an origin-less notice row (the shape an older build wrote into the transcript) is not an operator turn', !isOperatorTurn(olderBuild) && operatorTextOf(olderBuild) === null)
  check('a notice carrying its origin is not an operator turn even when it is not meta', !isOperatorTurn(originOnly) && operatorTextOf(originOnly) === null)
  check("the current build's wrapped notice is not an operator turn", !isOperatorTurn(currentBuild) && operatorTextOf(currentBuild) === null)
  check("the operator's own words are", isOperatorTurn(his) && operatorTextOf(his) === HIS)
  check('the turn counter counts his words only', countOperatorTurns([olderBuild, his, originOnly, currentBuild]) === 1)
}

section('§2 the fold carries his words, never a notice, and the budget is his')
{
  const assistant = (text: string): AnyMsg => createAssistantMessage({ content: text }) as unknown as AnyMsg
  const notices = Array.from({ length: 9 }, (_, i) => createUserMessage({ content: NOTICE.replace('a1b2c3', `crew-${i}`) + '\n' + 'x'.repeat(8_000) }) as unknown as AnyMsg)
  const history: AnyMsg[] = [createUserMessage({ content: OPENING }) as unknown as AnyMsg, assistant('started'), ...notices.flatMap(n => [n, assistant('noted')]), createUserMessage({ content: HIS }) as unknown as AnyMsg, assistant('ok')]
  const selected = selectOperatorMessages(history, { tokenBudget: 20_000 })
  const texts = selected?.messages.map(entry => entry.text) ?? []
  check('the attachment carries exactly his two messages', texts.length === 2 && texts.includes(OPENING) && texts.includes(HIS) && selected?.omitted === 0, j(selected))
  check('no notice text rides the carry', texts.every(text => !text.includes('<task-notification>')), j(texts.map(t => t.slice(0, 40))))
}

section('§4 a carry written before the move is filtered on read: the first fold after the move re-admits his words only (the field row 2B-03)')
{
  const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
  const { OPERATOR_MESSAGES_ATTACHMENT_TYPE } = await import('../../src/services/compact/operatorMessages.ts')
  const assistant = (text: string): AnyMsg => createAssistantMessage({ content: text }) as unknown as AnyMsg
  const olderCarry = createAttachmentMessage({
    type: OPERATOR_MESSAGES_ATTACHMENT_TYPE,
    messages: [
      { ordinal: 3, text: NOTICE.replace('a1b2c3', 'older-build-2') },
      { ordinal: 2, text: `<system-reminder>\n${NOTICE.replace('a1b2c3', 'older-build-1')}\n</system-reminder>` },
      { ordinal: 1, text: OPENING },
    ],
    omitted: 0,
  } as never) as unknown as AnyMsg
  const summary = createUserMessage({ content: 'the fold summary', isCompactSummary: true } as never) as unknown as AnyMsg
  const history: AnyMsg[] = [summary, olderCarry, createUserMessage({ content: HIS }) as unknown as AnyMsg, assistant('ok')]
  const selected = selectOperatorMessages(history, { tokenBudget: 20_000 })
  const texts = selected?.messages.map(entry => entry.text) ?? []
  check("the next fold's carry holds his opening words and his new words", texts.includes(OPENING) && texts.includes(HIS), j(texts.map(t => t.slice(0, 40))))
  check('the two notices the older build carried are not re-admitted', texts.every(text => !text.includes('<task-notification>') && !text.includes('<system-reminder>')), j(texts.map(t => t.slice(0, 40))))
  check('the ordinals keep their places: his new words are message 4, the notices are counted among the earlier folds and not carried', selected !== null && selected.messages.some(entry => entry.ordinal === 4 && entry.text === HIS) && selected.messages.length === 2 && selected.omitted === 2, j(selected))
}

section('§3 the run objective reads the same predicate: never a queued notice')
{
  const observer = readFileSync(join(ROOT, 'src/services/run/runTurnObserver.ts'), 'utf8')
  check("the run's root user message is the operator's turn", observer.includes("import { isOperatorTurn } from '../../utils/messages/operatorTurns.js'") && observer.includes('!isOperatorTurn(messages[i]!)'))
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('NOTICE ROWS NEVER OPERATOR RED')
  process.exit(1)
}
console.log('NOTICE ROWS NEVER OPERATOR GREEN')
