#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
let where = ''
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  const failText = [detail, where].filter(Boolean).join(' — ')
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && failText ? ` — ${failText}` : ''}`)
}
const section = (t: string, fix = ''): void => {
  where = fix
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const cr = await import('../../src/engine/compaction/checkpointRewind.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
const { CheckpointTool } = await import('../../src/tools/checkpoint/CheckpointTool.tsx')
const { RewindTool } = await import('../../src/tools/rewind/RewindTool.tsx')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
type Message = import('../../src/engine/message-shapes/message.ts').Message

const asst = (blocks: unknown[]): Message => createAssistantMessage({ content: blocks as never }) as Message
const user = (content: unknown): Message => createUserMessage({ content: content as never }) as Message
const text = (v: unknown): string => JSON.stringify(v) ?? ''

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

section('§A the scan — stateless reconstruction, one-active-max', 'fix findActiveCheckpoint in src/engine/compaction/checkpointRewind.ts')
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

section('§B the tools — typed refusals, context-only contract', 'fix the call of CheckpointTool in src/tools/checkpoint/CheckpointTool.tsx or of RewindTool in src/tools/rewind/RewindTool.tsx (their refusal and accepted texts)')
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

section('§C the record + the projection', 'fix buildRewindRecordIfSettled, createRewindRecordMessage or projectRewoundWindows in src/engine/compaction/checkpointRewind.ts')
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

section('§D the machine, called + registry pins (structural)', '')
{
  const t = await import('../core-runtime/turnScenarios.ts')
  const { noToolReply } = await import('../../src/engine/loop/turn/noToolReply.ts')
  const { runToolCalls } = await import('../../src/engine/loop/turn/runToolCalls.ts')
  const { afterTools } = await import('../../src/engine/loop/turn/afterTools.ts')
  const queue = await import('../../src/daemon/runner/messageQueueManager.ts')
  const f = t.fixtures
  const rowsOf = (decision: unknown): unknown[] => (decision as { next?: { messages?: unknown[] } } | undefined)?.next?.messages ?? []
  const isGuardWarning = (row: unknown): boolean => text(row).includes('A checkpoint is still active')

  const open = await t.plantReply({ tools: [{ name: cr.CHECKPOINT_TOOL_NAME }], seed: f.liveCheckpoint(), script: [f.yields(f.says('the store lives in sessionStorage.'))] })
  const guarded = await t.drain(noToolReply(open.run as never, open.iter as never))
  open.close()
  const settled = await t.plantReply({ script: [f.yields(f.says('nothing was left open.'))] })
  const ended = await t.drain(noToolReply(settled.run as never, settled.iter as never))
  settled.close()
  const warning = guarded.events.find(event => event.kind === 'attachment')?.message
  check(
    'the settle guard sits BEFORE the natural-end completed terminal',
    t.reasonOf(guarded.decision) === 'hand_over checkpoint_settle_guard' && isGuardWarning(warning) && rowsOf(guarded.decision).at(-1) === warning && t.reasonOf(ended.decision) === 'end completed',
    `a reply with no tool call while a checkpoint is live: ${t.reasonOf(guarded.decision)}; with none live: ${t.reasonOf(ended.decision)} — the checkpoint_settle_guard rule of src/engine/loop/turn/noToolReply.ts decides before the reply is left to stand, and hands over with its warning as the last row of the next turn`,
  )

  const twice = await t.runScripted({ tools: [{ name: cr.CHECKPOINT_TOOL_NAME }], seed: f.liveCheckpoint(), script: [f.yields(f.says('the store lives in sessionStorage.')), f.yields(f.says('still digging.'))] })
  const warnings = twice.events.filter(event => event.kind === 'attachment' && isGuardWarning(event.message)).length
  check(
    'the guard warns ONCE per run (the warned latch)',
    JSON.stringify(twice.transitions) === JSON.stringify(['checkpoint_settle_guard']) && warnings === 1 && twice.requests.length === 2 && isGuardWarning(twice.requests[1]?.messages.at(-1)) && twice.terminal.reason === 'completed',
    `a run whose two replies both leave the checkpoint open: transitions ${JSON.stringify(twice.transitions)}, ${warnings} warning(s), ${twice.requests.length} model call(s), ended ${String(twice.terminal.reason)} — the rule warns once in a run (checkpointSettleWarned on the run context) and the second natural end completes`,
  )

  const STEER = 'a line the operator sent during the exploration'
  const rewound = await t.plantReply({
    tools: [{ name: cr.CHECKPOINT_TOOL_NAME }, { name: cr.REWIND_TOOL_NAME }],
    seed: f.liveCheckpoint(),
    before: () => {
      queue.enqueue({ value: STEER, mode: 'prompt', uuid: '11111111-1111-4111-8111-111111111111' } as never)
    },
    script: [f.yields(f.calls('rw_1', cr.REWIND_TOOL_NAME, { report: 'the store lives in sessionStorage/' }))],
  })
  await t.drain(runToolCalls(rewound.run as never, rewound.iter as never))
  const closed = await t.drain(afterTools(rewound.run as never, rewound.iter as never))
  rewound.close()
  const round = rowsOf(closed.decision)
  const recordAt = round.findIndex(row => text(row).includes(cr.REWIND_RECORD_TAG))
  const steerAt = round.findIndex(row => text(row).includes(STEER))
  const keptForTheModel = text(cr.projectRewoundWindows(round as Message[])).includes(STEER)
  check(
    'the rewind record appends BEFORE the steering drain closes the round',
    t.reasonOf(closed.decision) === 'hand_over next_turn' && recordAt !== -1 && steerAt !== -1 && recordAt < steerAt && keptForTheModel,
    `after a settled Rewind with a line queued: ${t.reasonOf(closed.decision)}, the record at row ${recordAt}, the operator's line at row ${steerAt} of ${round.length}, the line in the model's view: ${keptForTheModel} — afterTools of src/engine/loop/turn/afterTools.ts adds the rewind record to the round before it drains the queue, so the line stands after the record and outside the rewound window`,
  )
  check('MERCURY_CHECKPOINT_REWIND carries its registry row', getFlagSpec('MERCURY_CHECKPOINT_REWIND') !== undefined, 'add the MERCURY_CHECKPOINT_REWIND row to the flag list in FLAG_REGISTRY')
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
