#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-checkpoint-rewind.ts — the checkpoint/rewind agent
//  verbs (spec 07-C4): the transcript-scan state model, the tools' typed
//  refusals, the record, the projection, and the machine wiring pins.
//
//    §A  the scan — no store: active checkpoint reconstructed from messages
//        (resume rehydration IS the scan); one-active-max; a refused or
//        recordless call never counts
//    §B  the tools — Checkpoint nesting refusal; Rewind empty-report and
//        no-checkpoint/double-rewind refusals; both context-only
//    §C  the record + projection — exploration leaves the provider view,
//        checkpoint round and record stay, report text survives; identity
//        return when nothing applies; pairing never splits; root-fallback
//        excludes from the view start
//    §D  the machine + registry pins (structural) — the settle guard sits
//        before the completed terminal, the record appends before the
//        brief gate, the Continue union carries the guard reason, the
//        catalogue offers the pair behind the default-on flag, and both
//        provider-bound projections consult projectRewoundWindows
//
//  Run: ~/.bun/bin/bun run scripts/compact/prove-checkpoint-rewind.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const cr = await import('../../src/services/compact/checkpointRewind.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { CheckpointTool } = await import('../../src/tools/CheckpointTool/CheckpointTool.tsx')
const { RewindTool } = await import('../../src/tools/RewindTool/RewindTool.tsx')
type Message = import('../../src/types/message.ts').Message

const asst = (blocks: unknown[]): Message => createAssistantMessage({ content: blocks as never }) as Message
const user = (content: unknown): Message => createUserMessage({ content: content as never }) as Message
const text = (v: unknown): string => JSON.stringify(v) ?? ''

/** A transcript with a settled checkpoint, an exploration, no rewind yet. */
function liveCheckpointHistory(): Message[] {
  return [
    user('map the auth estate'),
    asst([
      { type: 'text', text: 'Taking a checkpoint first.', citations: null },
      { type: 'tool_use', id: 'cp_1', name: cr.CHECKPOINT_TOOL_NAME, input: { goal: 'probe the session store' } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 'cp_1', content: 'Checkpoint taken (2 messages).' }]),
    asst([
      { type: 'text', text: 'Exploring.', citations: null },
      { type: 'tool_use', id: 'ex_1', name: 'Bash', input: { command: 'grep -r sessionStore' } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 'ex_1', content: '412 matches' }]),
    asst([{ type: 'text', text: 'Deep in the weeds now.', citations: null }]),
  ]
}

// ============================================================================
section('§A the scan — stateless reconstruction, one-active-max')
// ============================================================================
{
  const history = liveCheckpointHistory()
  const active = cr.findActiveCheckpoint(history)
  check('a settled checkpoint scans ACTIVE with its goal and boundary', active?.id === 'cp_1' && active.goal === 'probe the session store' && active.boundaryIndex === 2, text(active))
  check('resume rehydration IS the scan: a re-parsed copy answers identically', text(cr.findActiveCheckpoint(JSON.parse(JSON.stringify(history)) as Message[])) === text(active))
  const refused = [
    history[0]!,
    asst([{ type: 'tool_use', id: 'cp_r', name: cr.CHECKPOINT_TOOL_NAME, input: { goal: 'x' } }]),
    user([{ type: 'tool_result', tool_use_id: 'cp_r', content: 'refused: a checkpoint is already active', is_error: true }]),
  ]
  check('a REFUSED checkpoint never scans active', cr.findActiveCheckpoint(refused) === null)
  const resultless = [history[0]!, asst([{ type: 'tool_use', id: 'cp_n', name: cr.CHECKPOINT_TOOL_NAME, input: { goal: 'x' } }])]
  check('a checkpoint whose result never settled never scans active', cr.findActiveCheckpoint(resultless) === null)
  const rewound = [
    ...history,
    asst([{ type: 'tool_use', id: 'rw_1', name: cr.REWIND_TOOL_NAME, input: { report: 'found it' } }]),
    user([{ type: 'tool_result', tool_use_id: 'rw_1', content: 'Rewind accepted' }]),
    cr.createRewindRecordMessage({ checkpointId: 'cp_1', goal: 'probe', report: 'found it', abandonedMessageCount: 3, rootFallback: false }),
  ]
  check('after the record lands, NO checkpoint is active (double-rewind sees none)', cr.findActiveCheckpoint(rewound) === null)
  const newAfter = [...rewound, asst([{ type: 'tool_use', id: 'cp_2', name: cr.CHECKPOINT_TOOL_NAME, input: { goal: 'second dig' } }]), user([{ type: 'tool_result', tool_use_id: 'cp_2', content: 'Checkpoint taken' }])]
  check('a FRESH checkpoint after a rewind is active again', cr.findActiveCheckpoint(newAfter)?.id === 'cp_2')
}

// ============================================================================
section('§B the tools — typed refusals, context-only contract')
// ============================================================================
{
  const context = (messages: Message[]): never => ({ messages }) as never
  const nested = await CheckpointTool.call({ goal: 'again' } as never, context(liveCheckpointHistory())).then(
    () => null,
    (e: Error) => e.message,
  )
  check('Checkpoint refuses NESTING typed (one active max)', typeof nested === 'string' && nested.includes('refused') && nested.includes('already active'), String(nested))
  const fresh = await CheckpointTool.call({ goal: 'first' } as never, context([user('hi')]))
  const freshData = (fresh as { data?: { message?: string; messageCount?: number } }).data
  check('Checkpoint on a clean run settles with the count and the files-untouched word', freshData?.messageCount === 1 && (freshData.message ?? '').includes('never touched'), text(freshData))

  const empty = await RewindTool.call({ report: '   ' } as never, context(liveCheckpointHistory())).then(
    () => null,
    (e: Error) => e.message,
  )
  check('Rewind refuses an EMPTY report typed', typeof empty === 'string' && empty.includes('report is empty'), String(empty))
  const orphan = await RewindTool.call({ report: 'findings' } as never, context([user('hi')])).then(
    () => null,
    (e: Error) => e.message,
  )
  check('Rewind with no active checkpoint refuses typed (covers double-rewind)', typeof orphan === 'string' && orphan.includes('no active checkpoint'), String(orphan))
  const ok = await RewindTool.call({ report: 'the store lives in sessionStorage/' } as never, context(liveCheckpointHistory()))
  const okData = (ok as { data?: { abandonedMessages?: number; message?: string } }).data
  check('Rewind on a live checkpoint reports the abandoned count + turn-end application', okData?.abandonedMessages === 3 && (okData.message ?? '').includes('end of this turn'), text(okData))
}

// ============================================================================
section('§C the record + the projection')
// ============================================================================
{
  const history = liveCheckpointHistory()
  const record = cr.buildRewindRecordIfSettled(
    [
      ...history,
      asst([{ type: 'tool_use', id: 'rw_1', name: cr.REWIND_TOOL_NAME, input: { report: 'auth lives in services/auth; use the wallet facade' } }]),
      user([{ type: 'tool_result', tool_use_id: 'rw_1', content: 'Rewind accepted' }]),
    ],
    [{ name: cr.REWIND_TOOL_NAME, id: 'rw_1', input: { report: 'auth lives in services/auth; use the wallet facade' } }],
    [user([{ type: 'tool_result', tool_use_id: 'rw_1', content: 'Rewind accepted' }])],
  )
  check('a settled Rewind mints the record (isMeta, tagged, report inside)', record !== null && (record as { isMeta?: boolean }).isMeta === true && text(record).includes(cr.REWIND_RECORD_TAG) && text(record).includes('wallet facade'), text(record).slice(0, 200))
  check('an ERRORED Rewind mints NO record', cr.buildRewindRecordIfSettled(history, [{ name: cr.REWIND_TOOL_NAME, id: 'rw_x', input: {} }], [user([{ type: 'tool_result', tool_use_id: 'rw_x', content: 'refused', is_error: true }])]) === null)

  const full = [
    ...liveCheckpointHistory(),
    asst([{ type: 'tool_use', id: 'rw_1', name: cr.REWIND_TOOL_NAME, input: { report: 'r' } }]),
    user([{ type: 'tool_result', tool_use_id: 'rw_1', content: 'Rewind accepted' }]),
    record!,
    user('continue please'),
  ]
  const projected = cr.projectRewoundWindows(full)
  check('the exploration leaves the provider view; checkpoint round + record + later turns stay', projected.length === full.length - 5 && text(projected).includes('cp_1') && text(projected).includes(cr.REWIND_RECORD_TAG) && !text(projected).includes('412 matches') && text(projected).includes('continue please'), `${full.length}→${projected.length}`)
  check('the Rewind call itself is part of the excluded exploration', !text(projected).includes('rw_1'))
  const pairSafe = projected.every((m, i) => {
    if ((m as { type?: string }).type !== 'assistant') return true
    const uses = (((m as { message?: { content?: unknown } }).message?.content ?? []) as Array<{ type?: string; id?: string }>).filter(b => b.type === 'tool_use')
    if (uses.length === 0) return true
    const next = projected[i + 1]
    const nextText = text(next)
    return uses.every(u => nextText.includes(u.id ?? '∅'))
  })
  check('the projection never splits a tool_use from its result (pairing law)', pairSafe)
  const untouched = [user('a'), asst([{ type: 'text', text: 'b', citations: null }])]
  check('identity return when nothing applies (render-bail parity)', cr.projectRewoundWindows(untouched) === untouched)

  const rootRecord = cr.createRewindRecordMessage({ checkpointId: 'cp_gone', goal: '', report: 'kept', abandonedMessageCount: 2, rootFallback: true })
  const rootHistory = [user('old'), asst([{ type: 'text', text: 'older', citations: null }]), rootRecord, user('after')]
  const rootProjected = cr.projectRewoundWindows(rootHistory)
  check('root-fallback: a record whose checkpoint vanished excludes from the view start', rootProjected.length === 2 && text(rootProjected).includes('kept') && text(rootProjected).includes('after'), `${rootHistory.length}→${rootProjected.length}`)
  const strayRecord = cr.createRewindRecordMessage({ checkpointId: 'cp_gone2', goal: '', report: 'kept2', abandonedMessageCount: 0, rootFallback: false })
  const stray = [user('x'), strayRecord, user('y')]
  check('a non-root record with no boundary excludes NOTHING (stands alone)', cr.projectRewoundWindows(stray).length === 3)
}

// ============================================================================
section('§D the machine + registry pins (structural)')
// ============================================================================
{
  const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  const guardAt = machine.indexOf('── the checkpoint settle guard')
  const completedAfterGuard = machine.indexOf("reason: 'completed' }", guardAt)
  check('the settle guard sits BEFORE the natural-end completed terminal', guardAt !== -1 && completedAfterGuard !== -1 && machine.slice(guardAt, completedAfterGuard).includes('findActiveCheckpoint'))
  check('the guard warns ONCE per run (the warned latch)', machine.includes('checkpointSettleWarned = true'))
  const recordAt = machine.indexOf('buildRewindRecordIfSettled')
  const briefGateAt = machine.indexOf('the Brief-terminal gate')
  check('the rewind record appends BEFORE the brief-terminal gate', recordAt !== -1 && briefGateAt !== -1 && recordAt < briefGateAt)
  const transitions = readFileSync(join(ROOT, 'src/query/transitions.ts'), 'utf8')
  check("the Continue union carries 'checkpoint_settle_guard'", transitions.includes("'checkpoint_settle_guard'"))
  const tools = readFileSync(join(ROOT, 'src/tools.ts'), 'utf8')
  check('the catalogue offers the pair behind the default-on flag', tools.includes('checkpointRewindEnabled') && tools.includes('CheckpointTool, RewindTool'))
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  check('MERCURY_CHECKPOINT_REWIND carries its registry row', registry.includes('MERCURY_CHECKPOINT_REWIND'))
  const plan = readFileSync(join(ROOT, 'src/services/run/requestContextPlan.ts'), 'utf8')
  const compact = readFileSync(join(ROOT, 'src/services/compact/compact.ts'), 'utf8')
  check('both provider-bound projections consult projectRewoundWindows', plan.includes('projectRewoundWindows') && compact.includes('projectRewoundWindows'))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
