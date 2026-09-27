#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  API_ERROR_MESSAGE_PREFIX,
  STREAM_FAULT_AFTER_PARTIAL_MARKER,
  isContinuableStreamFaultMessage,
  streamFaultAfterPartialText,
} from '../../src/services/api/errors.js'
import { createAssistantAPIErrorMessage } from '../../src/utils/messages.js'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

{
  const text = streamFaultAfterPartialText('OpenAI', 'openai-stream-error', 'terminated')
  check('composer carries the API error prefix', text.startsWith(API_ERROR_MESSAGE_PREFIX))
  check('composer carries the marker', text.includes(STREAM_FAULT_AFTER_PARTIAL_MARKER))
  const faultTail = createAssistantAPIErrorMessage({ content: text, error: 'unknown' })
  check('classifier accepts the composed tail', isContinuableStreamFaultMessage(faultTail))
  const rateLimit = createAssistantAPIErrorMessage({
    content: `${API_ERROR_MESSAGE_PREFIX}: rate limited`,
    error: 'unknown',
  })
  check('classifier rejects other API errors', !isContinuableStreamFaultMessage(rateLimit))
  const nonError = createAssistantAPIErrorMessage({ content: text, error: 'unknown' })
  nonError.isApiErrorMessage = false
  check('classifier requires the API-error flag', !isContinuableStreamFaultMessage(nonError))
}

{
  for (const file of [
    'src/services/providers/openai/openaiCallModel.ts',
    'src/services/providers/zai/zaiCallModel.ts',
  ]) {
    const source = readFileSync(resolve(repoRoot, file), 'utf8')
    check(file + ' composes via streamFaultAfterPartialText', source.includes('streamFaultAfterPartialText('))
    check(
      file + ' has no hand-rolled after-partial tail left',
      !source.includes("stream fault after partial content ("),
    )
  }
}

{
  const { decideStreamFaultRecovery } = await import('../../src/run-core/turn-machine.js')
  const first = decideStreamFaultRecovery({ continuableTail: true, recoveryCount: 0 })
  check('first fault continues (attempt 1)', first.kind === 'continue' && first.attempt === 1)
  const second = decideStreamFaultRecovery({ continuableTail: true, recoveryCount: 1 })
  check('second fault surfaces (bound = 1 per run)', second.kind === 'surface')
  const other = decideStreamFaultRecovery({ continuableTail: false, recoveryCount: 0 })
  check('non-continuable tails never continue', other.kind === 'surface')
}

{
  const source = readFileSync(resolve(repoRoot, 'src/run-core/turn-machine.ts'), 'utf8')
  const continuation = source.indexOf('isContinuableStreamFaultMessage(lastMessage)')
  const terminal = source.indexOf('if (lastMessage?.isApiErrorMessage) {')
  check('continuation branch sits BEFORE the terminal API-error branch', continuation > 0 && terminal > continuation)
  check('the nudge is meta (never rendered as operator input)', /content: streamFaultRecoveryContent\(replyTextOf\(assistantMessages\)\)[\s\S]{0,200}isMeta: true/.test(source))
  check('the continuation carries the settled reply and never the fault row (the partial is the assistant\'s own last message before the marker)', /messages: \[\.\.\.messagesForQuery, \.\.\.assistantMessages\.filter\(m => m\.isApiErrorMessage !== true\), recoveryMessage\]/.test(source))
  const errorsSource = readFileSync(resolve(repoRoot, 'src/services/api/errors.ts'), 'utf8')
  check('the nudge prose lives at its owner', errorsSource.includes("'The provider stream dropped mid-response after partial content. '"))
  check('the owner composes the marker: the identity nudge first, the settled tail named beside it', errorsSource.includes('export function streamFaultRecoveryContent') && errorsSource.includes('export function streamFaultRecoveryTailLine'))
  const { streamFaultRecoveryContent, streamFaultRecoveryTailLine, STREAM_FAULT_RECOVERY_NUDGE, isStreamFaultRecoveryNudgeText } = await import('../../src/services/api/errors.js')
  check('a cut before any text ⇒ the plain nudge, as a string, as today', streamFaultRecoveryContent('') === STREAM_FAULT_RECOVERY_NUDGE && streamFaultRecoveryContent('   ') === STREAM_FAULT_RECOVERY_NUDGE && streamFaultRecoveryTailLine('') === null)
  const composed = streamFaultRecoveryContent('first the schema swap, then the ')
  check('a cut after settled text ⇒ two text blocks: the identity nudge (the lookups key on it) and the tail line', Array.isArray(composed) && composed.length === 2 && composed[0]?.type === 'text' && isStreamFaultRecoveryNudgeText((composed[0] as { text: string }).text) && composed[1]?.type === 'text' && (composed[1] as { text: string }).text.includes('“first the schema swap, then the”'), JSON.stringify(composed))
  const long = 'x'.repeat(500) + ' the very last words'
  const tailLine = streamFaultRecoveryTailLine(long) ?? ''
  check('a long reply names its last 160 characters, marked as a tail', tailLine.includes('…') && tailLine.includes(' the very last words”') && !tailLine.includes('x'.repeat(200)), tailLine.slice(0, 80))
  check('the bound increments into the next state', source.includes('streamFaultRecoveryCount: streamFaultRecoveryCount + 1'))
  const transitions = readFileSync(resolve(repoRoot, 'src/query/transitions.ts'), 'utf8')
  check('the transition reason is typed', transitions.includes("reason: 'stream_fault_recovery'; attempt: number"))
}

if (failures > 0) {
  console.error('prove-stream-fault-recovery: RED (' + failures + ')')
  process.exit(1)
}
console.log('prove-stream-fault-recovery: green')
