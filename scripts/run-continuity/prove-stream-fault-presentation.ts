#!/usr/bin/env bun
// ============================================================================
//  scripts/run-continuity/prove-stream-fault-presentation.ts — R1: a
//  RECOVERED continuable stream fault is a handled event, not a terminal
//  failure.
//
//  The 07-22 turn-machine repair (decideStreamFaultRecovery) resumes the run
//  after a fault-after-partial-content, but the fault message still wore the
//  CRIMSON-bold `API Error:` terminal card forever. R1:
//    · the recovery nudge is OWNED in services/api/errors.ts beside the fault
//      marker (STREAM_FAULT_RECOVERY_NUDGE) — the turn machine composes
//      through it, producers can never drift;
//    · buildMessageLookups computes recoveredStreamFaultUuids (fault message
//      followed by the owned nudge);
//    · AssistantTextMessage renders a recovered fault as the restrained
//      ▲ AMBER one-liner (full provider text stays under ctrl+o); a fault
//      with NO recovery after it keeps the exact loud card.
//
//  Legs: source locks · behavioral lookups (recovered vs terminal) · a
//  BUILT-BINARY render of the stream-fault-recovered scenario (needs dist at
//  HEAD — the gate prebuilds; run `bun run build.ts` first when local).
//
//  Run:  ~/.bun/bin/bun run scripts/run-continuity/prove-stream-fault-presentation.ts
// ============================================================================
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

// ── source locks ────────────────────────────────────────────────────────────
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
    'renderer: recovered+continuable+collapsed → restrained row',
    atm.includes('recovered && isContinuableStreamFaultText(text) && !verbose') &&
      atm.includes('recovered={streamFaultRecovered}'),
  )
  check('renderer: the restrained row keeps ctrl+o truth', /recovered && isContinuableStreamFaultText\(text\) && !verbose[\s\S]{0,400}CtrlOToExpand/.test(atm))
  const msg = src('src/components/Message.tsx')
  check(
    'Message.tsx threads the lookup by normalized uuid',
    msg.includes('lookups.recoveredStreamFaultUuids.has(message.uuid)'),
  )
}

// ── behavioral: the lookup law over real normalization ─────────────────────
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
    // A plain (non-marker) API error followed by unrelated meta stays out.
    const messages = [
      mk.user('u1', 'go'),
      mk.assistant('a1', 'API Error: 529 overloaded.', true),
      mk.user('u2', 'some unrelated meta note', true),
    ]
    const lookups = buildMessageLookups(normalizeMessages(messages), messages)
    check('a non-continuable error never enters the set', lookups.recoveredStreamFaultUuids.size === 0)
  }
  {
    // Cross-run boundary: a fault that surfaced TERMINALLY
    // (its run ended; the next user message is a fresh prompt, not the
    // nudge) must never be repainted "resumed" by a LATER run's recovery.
    const messages = [
      mk.user('u1', 'go'),
      mk.assistant('a1', 'half —'),
      mk.assistant('faultA', faultText, true),
      mk.user('n1', STREAM_FAULT_RECOVERY_NUDGE, true),
      mk.assistant('a2', 'resuming —'),
      mk.assistant('faultB', faultText, true), // recovery limit reached — TERMINAL
      mk.user('u2', 'try again'), // run 2
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

// ── the built-binary render (80 + 120, the UI law) ──────────────────────────
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
      // The resume-recap card is the transcript's lawful TAIL — at 80x24 it
      // (plus the keyless revival notices, the capture law's own world)
      // fills the whole viewport and the fault rows can never be in view.
      // The card is its own estate's proof; THIS scene pins it off so the
      // fault presentation is the tail (the gaze prover's exact pin).
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
  check(`@${cols}: the restrained ▲ resumed row paints`, text.includes('stream dropped mid-response'))
  check(`@${cols}: NO terminal API-error card in the default view`, !text.includes('API Error:'))
  check(`@${cols}: the continuation prose renders beneath`, text.includes('completing the summary'))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
