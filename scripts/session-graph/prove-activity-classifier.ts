#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const activity = await import('../../src/services/crew/activity.ts')
type ActivityInput = import('../../src/services/crew/activity.ts').ActivityInput

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`scripts/session-graph/fixtures/${name}.fixture.json`, 'utf8'))

const AGENT = 'cw-000000000fff' as never
let seq = 0
const input = (payload: unknown, kind: string, adapterKind = 'opencode', sessionId = 'fx-session'): ActivityInput => ({
  event: { sourceEventId: `fx-${++seq}`, kind, payload, atMs: 1_000_000 + seq },
  agentId: AGENT,
  sessionId,
  adapterKind,
})
const toolCall = (toolCallId: string, fields: Record<string, unknown> = {}): ActivityInput =>
  input({ sessionId: 'fx-session', update: { sessionUpdate: 'tool_call', toolCallId, title: `call ${toolCallId}`, status: 'in_progress', kind: 'execute', ...fields } }, 'session/update')
const toolCallUpdate = (toolCallId: string, status: string): ActivityInput =>
  input({ sessionId: 'fx-session', update: { sessionUpdate: 'tool_call_update', toolCallId, status } }, 'session/update')
const chunk = (text: string): ActivityInput => input({ update: { sessionUpdate: 'agent_message_chunk', content: { text } } }, 'session/update')

t.section('§1 — registry determinism')
{
  const order = activity.activityClassifierOrder()
  const sorted = [...order].sort((a, b) => a.precedence - b.precedence || (a.name < b.name ? -1 : 1))
  t.check('the registry is precedence-ordered', JSON.stringify(order) === JSON.stringify(sorted))
  t.check('the unknown fallback is LAST and cannot be outranked', order.at(-1)?.name === 'unknown-raw')
  t.check(
    'ACTIVITY_CLASSES is exactly the twelve Mercury classes',
    activity.ACTIVITY_CLASSES.length === 12 && activity.ACTIVITY_CLASSES.at(-1) === 'unknown',
  )
  const names = order.map(c => c.name)
  t.check(
    'every registered arm reads a dialect a seat produces: the ACP arms, the review artifact, the unknown fallback (no arm for a frame nobody emits)',
    JSON.stringify(names) === JSON.stringify(['acp-tool-call', 'acp-plan', 'acp-message-chunk', 'mercury-review-artifact', 'unknown-raw']),
    names.join(','),
  )
  const src = readFileSync('src/services/crew/activity.ts', 'utf8')
  t.check('the owner reads no message-block or system-subtype frame', !/message\.content|subtype|tool_use|tool_result/.test(src))
}

t.section('§2 — stable source ids')
{
  const start = toolCall('tc-x', { kind: 'edit', title: 'edit src/a.ts' })
  const end = toolCallUpdate('tc-x', 'completed')
  t.check(
    'tool start and terminal frames share ONE row key (the tool-call id)',
    activity.activityIdOf(start) === activity.activityIdOf(end),
    `${activity.activityIdOf(start)} vs ${activity.activityIdOf(end)}`,
  )
  const textA = input({ update: { sessionUpdate: 'plan', entries: [{ content: 'same words' }] } }, 'session/update')
  const textB = input({ update: { sessionUpdate: 'plan', entries: [{ content: 'same words' }] } }, 'session/update')
  t.check(
    'identical rendered text still keys DIFFERENT rows (ids, never text)',
    activity.activityIdOf(textA) !== activity.activityIdOf(textB),
  )
}

t.section('§3 — ACP shapes (opencode/goose fixtures)')
{
  for (const name of ['opencode', 'goose'] as const) {
    const events = fixture(name).events as Array<Record<string, unknown>>
    const rows = events.map(e =>
      activity.classifyActivity(input(e.params, String(e.method), name)),
    )
    t.check(`${name}: tool_call (kind read) → tool/read`, rows[0]!.class === 'tool' && rows[0]!.verb === 'read')
    t.check(`${name}: tool_call_update shares the row key with its start`,
      activity.activityIdOf(input(events[0]!.params, 'session/update', name)) ===
      activity.activityIdOf(input(events[1]!.params, 'session/update', name)))
    t.check(`${name}: agent_message_chunk → message/said`, rows[2]!.class === 'message' && rows[2]!.verb === 'said')
  }
  const derived: Array<[kind: string, cls: string, verb: string]> = [
    ['edit', 'file-change', 'edited'],
    ['delete', 'file-change', 'deleted'],
    ['move', 'file-change', 'moved'],
    ['execute', 'command', 'ran'],
    ['search', 'tool', 'searched'],
    ['fetch', 'tool', 'fetched'],
    ['think', 'tool', 'thought about'],
    ['something-new', 'tool', 'used'],
  ]
  for (const [kind, cls, verb] of derived) {
    const row = activity.classifyActivity(toolCall(`tc-${kind}`, { kind, title: `${kind} src/x.ts` }))
    t.check(`ACP kind ${kind} derives ${cls}/${verb}`, row.class === cls && row.verb === verb, `${row.class}/${row.verb}`)
  }
  const phases: Array<[status: string, phase: string, outcome: string | undefined]> = [
    ['pending', 'queued', undefined],
    ['in_progress', 'running', undefined],
    ['completed', 'succeeded', 'completed'],
    ['failed', 'failed', 'failed'],
  ]
  for (const [status, phase, outcome] of phases) {
    const row = activity.classifyActivity(toolCall(`tc-${status}`, { status }))
    t.check(`ACP status ${status} → phase ${phase}${outcome ? ` with the outcome ${outcome}` : ' and no outcome yet'}`, row.phase === phase && row.outcomeLabel === outcome, `${row.phase}/${String(row.outcomeLabel)}`)
  }
  const titled = activity.classifyActivity(toolCall('tc-title', { title: 'x'.repeat(80) }))
  t.check('the title is the object label, clamped to 60', titled.objectLabel.length === 60)
  const plan = activity.classifyActivity(input({ update: { sessionUpdate: 'plan', entries: [] } }, 'session/update'))
  t.check('an ACP plan update → plan/updated → the plan', plan.class === 'plan' && plan.verb === 'updated' && plan.objectLabel === 'the plan' && plan.phase === 'running')
}

t.section('§4 — truthful unknown')
{
  const codexEvents = fixture('codex').events as Array<Record<string, unknown>>
  t.check('the codex fixture carries at least one replayable notification', codexEvents.length > 0, String(codexEvents.length))
  if (codexEvents.length > 0) {
    const row = activity.classifyActivity(
      input(codexEvents[0]!.params ?? codexEvents[0], String(codexEvents[0]!.method ?? 'notification'), 'codex'),
    )
    t.check(
      'an unrecognized codex notification lands as unknown (never guessed)',
      row.class === 'unknown' && /unclassified/.test(row.outcomeLabel ?? ''),
      `${row.class}`,
    )
  }
  const future = activity.classifyActivity(
    input({ totally: 'novel', shape: { with: ['nested', 'stuff'] } }, 'future/adapter-event', 'future-adapter'),
  )
  t.check('a future unknown adapter event stays one truthful generic row', future.class === 'unknown')
  t.check('the raw payload stays reachable behind refs (no discard)', future.rawRefs.length === 1)
  const messageFrame = activity.classifyActivity(
    input({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: 'src/a.ts' } }] } }, 'assistant', 'nobody'),
  )
  t.check(
    'a message-block frame — a dialect no seat produces — is an unknown row, never a guessed tool row',
    messageFrame.class === 'unknown' && messageFrame.activityId.endsWith(`:evt:${messageFrame.rawRefs[0]!.split(':').at(-1)}`),
    `${messageFrame.class} ${messageFrame.activityId}`,
  )
  const systemFrame = activity.classifyActivity(input({ type: 'system', subtype: 'init', model: 'm' }, 'system.init', 'nobody'))
  t.check('a system-subtype frame is an unknown row too', systemFrame.class === 'unknown' && systemFrame.objectLabel === 'system.init')
}

t.section('§5 — in-place collapse preserves identity facts')
{
  let feed = activity.emptyActivityFeed()
  const start = activity.classifyActivity(toolCall('tc-c', { kind: 'edit', title: 'src/collapse.ts' }))
  feed = activity.foldActivity(feed, start)
  const midOrder = [...feed.order]
  const terminal = activity.classifyActivity(toolCallUpdate('tc-c', 'completed'))
  feed = activity.foldActivity(feed, terminal)
  t.check('one row, not two (the running row became its outcome)', feed.rows.size === 1)
  const row = activity.activityRows(feed)[0]!
  t.check('identity facts preserved (still edited → src/collapse.ts)', row.class === 'file-change' && row.objectLabel === 'src/collapse.ts')
  t.check('the phase advanced to the terminal outcome', row.phase === 'succeeded' && row.outcomeLabel === 'completed')
  t.check('order is stable across the update (no scroll-jump material)', JSON.stringify(feed.order) === JSON.stringify(midOrder))
  t.check('both raw frames remain referenced (no source-event discard)', row.rawRefs.length === 2)
  const failed = activity.foldActivity(activity.foldActivity(activity.emptyActivityFeed(), activity.classifyActivity(toolCall('tc-f'))), activity.classifyActivity(toolCallUpdate('tc-f', 'failed')))
  t.check('a failed terminal lands failed in the same row', failed.rows.size === 1 && activity.activityRows(failed)[0]!.phase === 'failed')
}

t.section('§6 — the bounded feed drops oldest TERMINAL rows first')
{
  let feed = activity.emptyActivityFeed()
  const live = activity.classifyActivity(toolCall('tc-live', { kind: 'edit', title: 'src/live.ts' }))
  feed = activity.foldActivity(feed, live)
  for (let i = 0; i < activity.ACTIVITY_FEED_CAP + 5; i++) {
    feed = activity.foldActivity(feed, activity.classifyActivity(toolCall(`tc-done-${i}`, { status: 'completed' })))
  }
  t.check('the window stays bounded', feed.order.length <= activity.ACTIVITY_FEED_CAP)
  t.check('the LIVE row survived the flood (terminal rows dropped first)', feed.rows.has(live.activityId))

  let allLive = activity.emptyActivityFeed()
  for (let i = 0; i < activity.ACTIVITY_FEED_CAP + 3; i++) {
    allLive = activity.foldActivity(allLive, activity.classifyActivity(toolCall(`tc-open-${i}`)))
  }
  t.check(
    'an all-live flood evicts NOTHING (the stated law, not the silent fallback)',
    allLive.order.length === activity.ACTIVITY_FEED_CAP + 3 && activity.activityRows(allLive).every(r => r.phase === 'running'),
    String(allLive.order.length),
  )
}

t.section('§7 — ingest + the line form')
{
  activity._resetActivityFeedForTesting()
  let pings = 0
  const unsub = activity.subscribeActivityFeed(() => pings++)
  const rows = activity.ingestActivity(toolCall('tc-i', { kind: 'execute', title: 'bun run typecheck' }))
  t.check('ingest folds into the live feed and notifies once', pings === 1 && rows.length === 1 && activity.cachedActivityFeed().rows.size === 1)
  t.check(
    'the line reads verb → object → outcome',
    activity.activityLineOf(rows[0]!, 'Atlas') === 'Atlas · ran → bun run typecheck → running',
    activity.activityLineOf(rows[0]!, 'Atlas'),
  )
  const settled = activity.ingestActivity(toolCallUpdate('tc-i', 'completed'))
  t.check('the terminal folds into ITS row and notifies once more', settled.length === 1 && pings === 2 && activity.cachedActivityFeed().rows.size === 1)
  t.check('the settled line names the outcome', activity.activityLineOf(activity.activityRows(activity.cachedActivityFeed())[0]!) === 'ran → bun run typecheck → completed')
  unsub()
  activity._resetActivityFeedForTesting()
}

t.section('§8 — seat-scoped keys and chunk coalescing')
{
  const seatA: ActivityInput = {
    event: { sourceEventId: 'sA-1', kind: 'session/update', payload: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'read', status: 'completed' } }, atMs: 1 },
    agentId: 'cw-00000000000a' as never,
    sessionId: 'session-A',
    adapterKind: 'goose',
  }
  const seatB: ActivityInput = { ...seatA, agentId: 'cw-00000000000b' as never, sessionId: 'session-B' }
  t.check(
    'the same tool-call id in two sessions keys two DIFFERENT rows',
    activity.activityIdOf(seatA) !== activity.activityIdOf(seatB),
    `${activity.activityIdOf(seatA)} vs ${activity.activityIdOf(seatB)}`,
  )

  let chunkFeed = activity.emptyActivityFeed()
  chunkFeed = activity.foldActivity(chunkFeed, activity.classifyActivity(chunk('The fix ')))
  chunkFeed = activity.foldActivity(chunkFeed, activity.classifyActivity(chunk('is in foo.ts')))
  const chunkRow = activity.activityRows(chunkFeed)[0]!
  t.check(
    'two chunks fold into ONE row with the label extended (no per-chunk flood)',
    chunkFeed.rows.size === 1 && chunkRow.objectLabel === 'The fix is in foo.ts' && chunkRow.rawRefs.length === 2,
    `${String(chunkFeed.rows.size)} rows · '${chunkRow.objectLabel}'`,
  )
  const otherSeat = activity.foldActivity(chunkFeed, activity.classifyActivity({ ...chunk('elsewhere'), sessionId: 'another-session' }))
  t.check("another seat's chunks open their own row", otherSeat.rows.size === 2)
}

t.finish('prove-activity-classifier')
