#!/usr/bin/env bun
import { MonitorTool } from '../../src/tools/MonitorTool/MonitorTool.ts'
import {
  deadWatchLine,
  monitorNoticeBlock,
  orphanedWatches,
  reconcileWatchesOnResume,
  settledWatchIds,
  WATCH_STARTED_LINE,
  watchReceipts,
} from '../../src/tools/MonitorTool/watchReceipts.ts'
import { getCommandQueue, resetCommandQueue } from '../../src/utils/messageQueueManager.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const STAMP = '2026-09-22T12:00:00.000Z'
const DESC = 'the appended log'
const COMMAND = 'tail -n0 -F /watched.log'
type Msg = Record<string, unknown>
const armed = (id: string, input: Record<string, unknown>): Msg => ({ type: 'assistant', uuid: `${id}-a`, timestamp: STAMP, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Monitor', input }] } })
const answered = (id: string, text: string): Msg => ({ type: 'user', uuid: `${id}-u`, timestamp: STAMP, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })
const said = (text: string): Msg => ({ type: 'user', uuid: `u-${Math.random()}`, timestamp: STAMP, message: { role: 'user', content: text } })
const stopped = (id: string, input: Record<string, unknown>): Msg => ({ type: 'assistant', uuid: `${id}-stop`, timestamp: STAMP, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'TaskStop', input }] } })
const startedText = (taskId: string, persistent: boolean): string => {
  const block = MonitorTool.mapToolResultToToolResultBlockParam({ taskId, timeoutMs: persistent ? 0 : 300_000, persistent }, 'tu-x') as { content: string }
  return block.content
}
const messages = (...m: Msg[]): never => m as never

{
  const started = startedText('t1', true)
  check("the tool's own launch result opens with the receipt line the reader keys on", started.startsWith(WATCH_STARTED_LINE), started.slice(0, 60))
  const receipts = watchReceipts(messages(armed('tu1', { description: DESC, command: COMMAND, persistent: true }), answered('tu1', started)))
  check('one receipt, with the task id, the description, the command and the persistence', receipts.length === 1 && receipts[0]!.taskId === 't1' && receipts[0]!.toolUseId === 'tu1' && receipts[0]!.description === DESC && receipts[0]!.command === COMMAND && receipts[0]!.persistent === true, JSON.stringify(receipts))
  const timed = watchReceipts(messages(armed('tu2', { description: DESC, command: COMMAND }), answered('tu2', startedText('t2', false))))
  check('a timed watch is a receipt too, not persistent', timed.length === 1 && timed[0]!.taskId === 't2' && timed[0]!.persistent === false, JSON.stringify(timed))
  const refused = watchReceipts(messages(armed('tu3', { description: DESC, command: COMMAND }), answered('tu3', 'Error: the command was refused')))
  check('a launch whose result is not the started line is no receipt', refused.length === 0)
}

{
  const base = [armed('tu1', { description: DESC, command: COMMAND, persistent: true }), answered('tu1', startedText('t1', true))]
  check('an unsettled receipt is an orphan when no task is live', orphanedWatches(messages(...base), new Set()).length === 1)
  check('a live task of that id settles it', orphanedWatches(messages(...base), new Set(['t1'])).length === 0)
  const byNotification = [...base, said('<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Background command "the appended log" completed</summary>\n</task-notification>')]
  check("the shell's own end notice settles it", settledWatchIds(messages(...byNotification)).has('t1') && orphanedWatches(messages(...byNotification), new Set()).length === 0)
  const byExpiry = [...base, said(monitorNoticeBlock('t1', DESC, '[Monitor "the appended log" (task t1) expired after 300s with 2 events. Re-arm it by calling Monitor again with the same command if the watch is still wanted; set persistent: true for a watch that must outlive the deadline.]'))]
  check('the expiry notice settles it', orphanedWatches(messages(...byExpiry), new Set()).length === 0)
  const byFlood = [...base, said(monitorNoticeBlock('t1', DESC, '[Monitor stopped: your script produced too much output (30 events suppressed over 11s). Start a new monitor with a tighter filter, such as grep --line-buffered or a wrapper script that emits only the events you need.]'))]
  check('the flood stop settles it', orphanedWatches(messages(...byFlood), new Set()).length === 0)
  const byEvent = [...base, said(monitorNoticeBlock('t1', DESC, 'a plain line the watch reported'))]
  check('a plain event of the watch settles nothing — the watch is still armed', orphanedWatches(messages(...byEvent), new Set()).length === 1)
  const byStop = [...base, stopped('tu9', { task_id: 't1' })]
  check('a TaskStop naming the task settles it', orphanedWatches(messages(...byStop), new Set()).length === 0)
  const byShellStop = [...base, stopped('tu9', { shell_id: 't1' })]
  check('a TaskStop by the older shell_id spelling settles it too', orphanedWatches(messages(...byShellStop), new Set()).length === 0)
  const otherStop = [...base, stopped('tu9', { task_id: 't-other' })]
  check('a TaskStop of another task settles nothing', orphanedWatches(messages(...otherStop), new Set()).length === 1)
  const byDead = [...base, said(monitorNoticeBlock('t1', DESC, deadWatchLine({ toolUseId: 'tu1', taskId: 't1', description: DESC, command: COMMAND, persistent: true, armedAt: 0 })))]
  check('the dead-watch line itself settles it: a later resume repeats nothing', orphanedWatches(messages(...byDead), new Set()).length === 0)
  const two = [...base, armed('tu2', { description: 'the other log', command: 'tail -F /other.log', persistent: true }), answered('tu2', startedText('t2', true)), said('<task-notification>\n<task-id>t2</task-id>\n<status>completed</status>\n<summary>x</summary>\n</task-notification>')]
  const orphans = orphanedWatches(messages(...two), new Set())
  check('of two watches, only the unsettled one is an orphan', orphans.length === 1 && orphans[0]!.taskId === 't1', JSON.stringify(orphans.map(o => o.taskId)))
}

{
  const receipt = { toolUseId: 'tu1', taskId: 't1', description: DESC, command: COMMAND, persistent: true, armedAt: 0 }
  const line = deadWatchLine(receipt)
  check('the line names the watch, its task, that it did not survive the pause, and the re-arm', line.startsWith(`[Monitor "${DESC}" (task t1) did not survive the session's pause`) && line.includes('Start it again by calling Monitor with the same command') && line.endsWith(']'), line)
  check("a crash restart names the crash", deadWatchLine(receipt, 'crash').includes("did not survive the session's restart after a crash"), deadWatchLine(receipt, 'crash'))
  check('a settings restart names the settings change', deadWatchLine(receipt, 'settings').includes("did not survive the session's restart after a settings change"))
  check('a relaunch names the relaunch', deadWatchLine(receipt, 'relaunch').includes("did not survive the session's restart after a relaunch"))
  check('a stop names the stop, never a crash (red on the base: the reason was unknown there)', deadWatchLine(receipt, 'stop').includes("did not survive the session's restart after a stop") && !deadWatchLine(receipt, 'stop').includes('crash'))
  check('the line is one line', !line.includes('\n'))
  const block = monitorNoticeBlock('t1', DESC, 'x')
  check("the block is the tool's own notification shape", block === `<monitor task="t1" name="${DESC}">\nx\n</monitor>`, block)
}

{
  resetCommandQueue()
  const base = [armed('tu1', { description: DESC, command: COMMAND, persistent: true }), answered('tu1', startedText('t1', true))]
  const told = reconcileWatchesOnResume(messages(...base), new Set(), 'crash')
  const queued = getCommandQueue()
  check('the resume road queues ONE task-notification for the orphan, in the watch\'s own block, with the restart words', told.length === 1 && queued.length === 1 && queued[0]!.mode === 'task-notification' && String(queued[0]!.value).startsWith(`<monitor task="t1" name="${DESC}">`) && String(queued[0]!.value).includes('after a crash'), JSON.stringify(queued.map(c => [c.mode, String(c.value).slice(0, 80)])))
  resetCommandQueue()
  const none = reconcileWatchesOnResume(messages(...base), new Set(['t1']))
  check('a live watch queues nothing', none.length === 0 && getCommandQueue().length === 0)
  resetCommandQueue()
}

{
  const { createWatchMailbox } = await import('../../src/tools/MonitorTool/watchMailbox.ts')
  const { wrappedNoticeBlocks } = await import('../../src/utils/messages/noticeRows.ts')
  const { UserNoticeMessage } = await import('../../src/components/messages/UserNoticeMessage.tsx')
  const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const React = await import('react')
  let now = 0
  type Timer = { at: number; call: () => void; live: boolean }
  const timers: Timer[] = []
  const delivered: Array<{ at: number; body: string; count?: number; last?: string }> = []
  const mailbox = createWatchMailbox({
    now: () => now, wall: () => ({ closed: false }),
    deliver: (body, summary) => delivered.push({ at: now, body, ...summary }),
    setTimer: (call, ms) => { const timer = { at: now + ms, call, live: true }; timers.push(timer); return timer },
    clearTimer: handle => { (handle as Timer).live = false },
  })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = timers.filter(t => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at; next.live = false; next.call()
    }
    now = end
  }
  for (let i = 1; i <= 600; i++) { mailbox.push('tick' + i + '\n'); advance(1000) }
  advance(30_000)
  check('one line per second over ten minutes yields at most 21 deliveries, not 600 wakes', delivered.length > 1 && delivered.length <= 21, String(delivered.length))
  check('no two deliveries are less than 30 seconds apart', delivered.every((row, i) => i === 0 || row.at - delivered[i - 1]!.at >= 30_000))
  check('batch counts preserve all 600 lines and the last observed line', delivered.reduce((n, row) => n + (row.count ?? 0), 0) === 600 && delivered.at(-1)?.last === 'tick600', JSON.stringify(delivered.at(-1)))
  const burst: Array<{ body: string; summary: unknown }> = []
  const many = createWatchMailbox({ now: () => now, wall: () => ({ closed: false }), deliver: (body, summary) => burst.push({ body, summary }), setTimer: (call, ms) => { const timer = { at: now + ms, call, live: true }; timers.push(timer); return timer }, clearTimer: handle => { (handle as Timer).live = false } })
  many.push(Array.from({ length: 600 }, (_, i) => 'tick' + (i + 1)).join('\n'))
  advance(1000)
  const block = monitorNoticeBlock('ticks', 'Tick watch', burst[0]?.body ?? '', burst[0]?.summary as never)
  const parsed = wrappedNoticeBlocks(block)
  const frame = await renderToAnsiString(React.createElement(UserNoticeMessage, { blocks: parsed ?? [], fold: true }), 100)
  check('a folded 600-line row names the actual count and final line', frame.includes('600 lines') && frame.includes('last: tick600'), frame)
  mailbox.dispose(); many.dispose()
}

process.exit(failures)
