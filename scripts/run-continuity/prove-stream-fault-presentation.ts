#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const ROOT = new URL('../../', import.meta.url).pathname
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

console.log('recovered stream-fault presentation ──')

{
  const errors = src('src/services/api/errors.ts')
  check('the nudge is owned beside the marker', errors.includes('export const STREAM_FAULT_RECOVERY_NUDGE'))
  check('the text-level classifier exists', errors.includes('export function isContinuableStreamFaultText'))
  const tm = src('src/run-core/turn-machine.ts')
  check('turn machine composes the nudge through the owner', tm.includes('content: STREAM_FAULT_RECOVERY_NUDGE'))
  check('no inline nudge prose survives in the turn machine', !tm.includes('Continue exactly where you left off'))
  const lk = src('src/utils/messages/lookups.ts')
  check('lookups compute the recovered set', lk.includes('recoveredStreamFaultUuids'))
  const atm = src('src/components/messages/AssistantTextMessage.tsx')
  check(
    'renderer: a recovered continuable fault paints nothing in the default view',
    atm.includes('if (streamFaultRecovered && isContinuableStreamFaultText(text) && !verbose) return null') &&
      atm.includes('recovered={streamFaultRecovered}'),
  )
  check('renderer: the expansion paints the recovered fault whole, quietly', /recovered && isContinuableStreamFaultText\(text\)\) \{\s*return <Text dimColor>\{text\}<\/Text>/.test(atm))
  const stm = src('src/components/messages/SystemTextMessage.tsx')
  check('the calm line is the stream_cut row, in the collapsed tool row\u2019s tokens', /case 'stream_cut':[\s\S]{0,600}<Text color="subtle">[\s\S]{0,200}Continued after <Text bold>\{message\.count\}<\/Text> \{plural\(message\.count, 'stream cut'\)\} · context sent again/.test(stm))
  check('the calm line carries no glyph and no warning colour', !/case 'stream_cut':[\s\S]{0,900}GLYPH\./.test(stm.slice(stm.indexOf("case 'stream_cut':"), stm.indexOf("case 'thinking_note':"))) && !stm.slice(stm.indexOf("case 'stream_cut':"), stm.indexOf("case 'thinking_note':")).includes('warning'))
  const tm2 = src('src/run-core/turn-machine.ts')
  const qe = src('src/QueryEngine.ts')
  check('the headless engine records the stream_cut row (the daemon-hosted cockpit paints from the transcript file)', /systemMessage\.subtype === 'thinking_note' \|\|\s*systemMessage\.subtype === 'stream_cut'/.test(qe))
  const recordRule = /if \(\s*\(systemMessage as \{ level\?: string \}\)\.level === 'warning' \|\|\s*\(systemMessage as \{ level\?: string \}\)\.level === 'error' \|\|\s*systemMessage\.subtype === 'thinking_note' \|\|\s*systemMessage\.subtype === 'stream_cut'\s*\) \{\s*turnMessages\.push\(systemMessage\)\s*await recordDelta\(\)\s*\}/
  check('the record rule is bounded: a warning or error level, the thinking receipt, the stream_cut row — an info row of any other kind still never leaves the runner', recordRule.test(qe))
  check('the continue branch mints the typed row, the exhausted branch keeps the warning', tm2.includes('message: createStreamCutMessage({') && tm2.includes("`stopped after ${streamFaultRecoveryCount} continuation"))
  const msg = src('src/components/Message.tsx')
  check(
    'Message.tsx threads the lookup by normalized uuid',
    msg.includes('lookups.recoveredStreamFaultUuids.has(message.uuid)'),
  )
}

{
  const { buildMessageLookups } = await import('../../src/utils/messages/lookups.ts')
  const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
  const { STREAM_FAULT_RECOVERY_NUDGE, streamFaultAfterPartialText } = await import(
    '../../src/services/api/errors.ts'
  )
  const faultText = streamFaultAfterPartialText('OpenAI', 'server_error', 'stream died')
  const mk = {
    user: (uuid: string, content: unknown, isMeta = false) =>
      ({ type: 'user', uuid, isMeta, timestamp: 't', message: { role: 'user', content } }) as never,
    assistant: (uuid: string, text: string, isApiErrorMessage = false) =>
      ({
        type: 'assistant', uuid, timestamp: 't', isApiErrorMessage,
        message: { id: `id-${uuid}`, role: 'assistant', model: 'm', content: [{ type: 'text', text }] },
      }) as never,
  }
  {
    const messages = [
      mk.user('u1', 'summarize'),
      mk.assistant('a1', 'partial half —'),
      mk.assistant('a2', faultText, true),
      mk.user('u2', STREAM_FAULT_RECOVERY_NUDGE, true),
      mk.assistant('a3', '— finished.'),
    ]
    const lookups = buildMessageLookups(normalizeMessages(messages), messages)
    check('recovered fault lands in the set', lookups.recoveredStreamFaultUuids.has('a2'))
    check('the set holds ONLY the fault', lookups.recoveredStreamFaultUuids.size === 1)
  }
  {
    const messages = [
      mk.user('u1', 'summarize'),
      mk.assistant('a1', 'partial half —'),
      mk.assistant('a2', faultText, true),
    ]
    const lookups = buildMessageLookups(normalizeMessages(messages), messages)
    check('a TERMINAL fault (no nudge after) stays out', lookups.recoveredStreamFaultUuids.size === 0)
  }
  {
    const { createStreamCutMessage, createSystemMessage } = await import('../../src/utils/messages/systemMessages.ts')
    const row = createStreamCutMessage({ count: 1, content: 'OpenAI ended the stream after partial content — stream died (server_error); asked the model to continue from where it stopped (continuation 1 of 1)', road: 'OpenAI', sent: 'stream died', code: 'server_error' })
    const messages = [
      mk.user('u1', 'summarize'),
      mk.assistant('a1', 'partial half —'),
      mk.assistant('a2', faultText, true),
      row as never,
      mk.assistant('a3', '— finished.'),
    ]
    const lookups = buildMessageLookups(normalizeMessages(messages), messages)
    check('the typed stream_cut row after a fault marks it recovered without the nudge (the live road)', lookups.recoveredStreamFaultUuids.has('a2') && lookups.recoveredStreamFaultUuids.size === 1)
    const warning = createSystemMessage('OpenAI ended the stream after partial content — stream died (server_error); stopped after 1 continuation; the reply so far stands', 'warning')
    const exhausted = [
      mk.user('u1', 'summarize'),
      mk.assistant('a1', 'partial half —'),
      mk.assistant('a2', faultText, true),
      warning as never,
    ]
    const exhaustedLookups = buildMessageLookups(normalizeMessages(exhausted), exhausted)
    check('the exhausted branch\u2019s warning row never marks the fault recovered', exhaustedLookups.recoveredStreamFaultUuids.size === 0)
  }
  {
    const messages = [
      mk.user('u1', 'go'),
      mk.assistant('a1', 'API Error: 529 overloaded.', true),
      mk.user('u2', 'some unrelated meta note', true),
    ]
    const lookups = buildMessageLookups(normalizeMessages(messages), messages)
    check('a non-continuable error never enters the set', lookups.recoveredStreamFaultUuids.size === 0)
  }
  {
    const messages = [
      mk.user('u1', 'go'),
      mk.assistant('a1', 'half —'),
      mk.assistant('faultA', faultText, true),
      mk.user('n1', STREAM_FAULT_RECOVERY_NUDGE, true),
      mk.assistant('a2', 'resuming —'),
      mk.assistant('faultB', faultText, true),
      mk.user('u2', 'try again'),
      mk.assistant('a3', 'part —'),
      mk.assistant('faultC', faultText, true),
      mk.user('n2', STREAM_FAULT_RECOVERY_NUDGE, true),
      mk.assistant('a4', 'done.'),
    ]
    const lookups = buildMessageLookups(normalizeMessages(messages), messages)
    check('run 1 recovered fault stays in', lookups.recoveredStreamFaultUuids.has('faultA'))
    check(
      'a TERMINAL fault is never repainted by a later run’s nudge',
      !lookups.recoveredStreamFaultUuids.has('faultB'),
    )
    check('the later run’s own recovered fault lands', lookups.recoveredStreamFaultUuids.has('faultC'))
  }
}

for (const cols of [80, 120]) {
  const res = spawnSync(
    process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`,
    ['run', 'scripts/ui/render-tui.ts', '--scenario', 'stream-fault-recovered',
      '--cols', String(cols), '--rows', cols === 80 ? '24' : '40',
      '--out', `/tmp/afterglow-sf-${cols}.png`],
    {
      encoding: 'utf-8',
      cwd: ROOT,
      timeout: 150_000,
      env: { ...process.env, MERCURY_AWAY_SUMMARY: '0' },
    },
  )
  if (res.status !== 0) {
    check(`render @${cols} completed`, false, (res.stderr || '').slice(-300))
    continue
  }
  const grid = JSON.parse(readFileSync(`/tmp/grid-${cols}.json`, 'utf8')) as {
    grid: Array<Array<{ c: string }>>
  }
  const text = grid.grid.map(row => row.map(cell => cell.c).join('')).join('\n')
  check(`@${cols}: the one calm line paints`, text.includes('Continued after 1 stream cut · context sent again'))
  check(`@${cols}: no warning triangle names the cut`, !text.split('\n').some(line => line.includes('▲') && /stream|continu/i.test(line)))
  check(`@${cols}: NO terminal API-error card in the default view`, !text.includes('API Error:'))
  check(`@${cols}: the partial prose stands above`, text.includes('first the schema swap'))
  check(`@${cols}: the continuation prose renders beneath`, text.includes('completing the summary'))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
