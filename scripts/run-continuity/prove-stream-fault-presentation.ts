#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const ROOT = new URL('../../', import.meta.url).pathname

console.log('recovered stream-fault presentation ──')

{
  const t = await import('../core-runtime/turnScenarios.ts')
  const owner = await import('../../src/services/api/errors.ts')
  type Row = Record<string, unknown>
  const PARTIAL = 'first the schema swap, then the '
  const RULE = 'the stream_fault_recovery rule (src/run-core/turn/noToolReply.ts)'
  const cutTwice = await t.runScripted({
    script: [
      t.fixtures.yields(t.fixtures.says(PARTIAL, 'stop_sequence'), t.fixtures.faulted()),
      t.fixtures.yields(t.fixtures.says('index rebuild, and last the ', 'stop_sequence'), t.fixtures.faulted()),
    ],
  })
  const asked = (cutTwice.requests[0]?.messages ?? []) as Row[]
  const continuation = (cutTwice.requests[1]?.messages ?? []) as Row[]
  const added = continuation.slice(asked.length)
  const nudge = added.at(-1)
  const rowsOf = (rows: Row[]): string => rows.map(row => `${String(row.type)}${row.isMeta === true ? ' (meta)' : ''}${row.isApiErrorMessage === true ? ' (API error)' : ''}`).join(', ') || 'no row'
  check(
    'turn machine composes the nudge through the owner',
    nudge?.type === 'user' && nudge.isMeta === true && JSON.stringify((nudge.message as Row).content) === JSON.stringify(owner.streamFaultRecoveryContent(PARTIAL)),
    `${RULE} must close the continuation request with a meta user row whose content is streamFaultRecoveryContent(the settled reply's text); the request closes with ${JSON.stringify((nudge?.message as Row | undefined)?.content)}`,
  )
  check(
    'no inline nudge prose rides the continuation: the request adds the settled reply and the owner\'s nudge, nothing more, and the retired sentence is nowhere in it',
    added.length === 2 && added[0]?.type === 'assistant' && added[0].isApiErrorMessage !== true && added[1] === nudge && !JSON.stringify(continuation).includes('Continue exactly where you left off'),
    `${RULE} must add to the continuation request the settled reply and the owner's nudge alone, with no prose of its own; the request adds ${rowsOf(added)}`,
  )
  const faultText = owner.streamFaultAfterPartialText('OpenAI', 'openai-stream-error', 'terminated')
  const notices = cutTwice.events.filter(event => event.kind === 'notice').map(event => event.message as Row)
  const [cutRow, exhausted] = notices
  check(
    'the continue branch mints the typed row, the exhausted branch keeps the warning',
    notices.length === 2 &&
      cutRow?.subtype === 'stream_cut' && cutRow.count === 1 && cutRow.road === 'OpenAI' && cutRow.sent === 'terminated' && cutRow.code === 'openai-stream-error' &&
      cutRow.content === owner.streamFaultNoticeLine(faultText, 'asked the model to continue from where it stopped (continuation 1 of 1)') &&
      exhausted?.subtype !== 'stream_cut' && exhausted?.level === 'warning' && exhausted.content === owner.streamFaultNoticeLine(faultText, 'stopped after 1 continuation; the reply so far stands'),
    `${RULE} must yield createStreamCutMessage({ count, content, road, sent, code }) when it continues and a warning system row saying the reply stands when its one continuation is spent; a run cut twice yielded ${JSON.stringify(notices.map(row => ({ subtype: row.subtype, level: row.level, count: row.count, road: row.road, sent: row.sent, code: row.code, content: row.content })))}`,
  )
}

{
  const { buildMessageLookups } = await import('../../src/services/messages/lookups.ts')
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
