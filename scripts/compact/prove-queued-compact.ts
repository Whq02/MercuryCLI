import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordToEntry } from '../../src/fabric/entryCodec.ts'
import { SendsPart } from '../../src/services/engine-connector/daemon/sends.ts'
import { liveFactsOf, withFixtureRunner } from '../lib/builtProduct.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { transcriptFiles } from '../daemon/dupline-world.ts'

const FOLD = 'Write the running record of this conversation'
const OLD = 'keep the copper label'
const NEW = 'keep the silver label'
const SUMMARY = '<summary>The notes have been recorded. The next step is to finish the open request.</summary>'
const history = Array.from({ length: 700 }, (_, i) => `Note ${i + 1}: module ${(i * 7919) % 1000} changed and its ${(i * 31) % 97} checks pass.`).join(' ')
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${JSON.stringify(detail)}`}`)
}

async function drive(fails: boolean, commands: string[]): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'queued-compact-'))
  const session = randomUUID()
  const ids = commands.map(() => randomUUID())
  const other = randomUUID()
  const stepId = randomUUID()
  const stop = randomUUID()
  const env = { MERCURY_CONFIG_DIR: home, MERCURY_SESSION_KIND: 'oculus', MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '50' }
  const turn = (index: number, tokens: number): ScriptedTurn => ({ kind: 'tool_use', name: 'Read', input: { file_path: join(home, `note-${index}`) }, usage: { input_tokens: tokens }, model: 'claude-opus-4-6' })
  const summary: ScriptedTurn = fails ? { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'No tool output found for function call fixture.' } : { kind: 'text', text: SUMMARY }
  try {
    writeFileSync(join(home, '.mercury.json'), JSON.stringify({ autoCompactWindow: 200000 }))
    for (const index of [1, 2]) writeFileSync(join(home, `note-${index}`), 'a fixture line')
    await withFixtureRunner([
      { kind: 'text', text: history }, turn(1, 150000), { ...summary, whenBody: FOLD }, ...(fails ? [{ ...summary, whenBody: FOLD }] : []), turn(2, 25), { kind: 'text', text: 'continued the same turn' }, { kind: 'text', text: SUMMARY, whenBody: FOLD }, { kind: 'text', text: 'next turn' },
    ], async (runner, api) => {
      await runner.prompt('record the notes')
      await runner.waitFor('seed history', r => r.type === 'outcome')
      const start = runner.rows.length
      await runner.prompt('read both fixture notes', { id: stepId })
      const first = await runner.waitForAsk('the first read holds the turn open')
      for (const [i, text] of commands.entries()) await runner.prompt(text, { id: ids[i] })
      await runner.prompt('/context', { id: other })
      const sends = new SendsPart({ sessionId: () => session, rows: () => [], paint: () => {}, compacting: () => false, wakeLive: () => {}, arrivalSeqFor: () => 0, noticeSeqAt: () => 0, retireTextRowsWithRunner: () => {}, noteSendDemoted: () => {}, noteSendTaken: () => {}, lostWithRunnerLine: lines => lines.join('\n') })
      const before = await liveFactsOf(runner)
      for (const [i, id] of ids.entries()) sends.enlist({ clientMessageId: id, text: commands[i]!, sentAtMs: Date.now(), state: 'delivered', mode: 'prompt' })
      const stamp = { schema: 1 as const, sessionId: session, atMs: Date.now(), pendingModel: null, busy: true }
      sends.reconcileQueuedSends({ ...before, ...stamp })
      check('runner and window have every queued /compact before the fold', ids.every(id => before.queue.some(q => q.uuid === id)) && sends.queuedSendCount() === ids.length, before.queue)
      runner.answerAsk(first.id, { outcome: 'allow' })
      const second = await runner.waitForAsk('the turn continues after the fold check')
      const after = await liveFactsOf(runner)
      sends.reconcileQueuedSends({ ...after, ...stamp })
      const afterIds = after.queue.map(q => q.uuid)
      const folds = runner.rows.slice(start).filter(row => row.type === 'compaction' && row.state === 'ended')
      const requests = api.messageRequests().filter(req => !req.path.includes('count_tokens') && req.raw.includes(FOLD))
      check('the still-open turn requests its summary, including both refused attempts on failure', requests.length === (fails ? 2 : 1), requests.length)
      check('the fold reports its exit as automatic before the turn ends', folds.length === 1 && folds[0]?.trigger === 'auto' && (fails ? folds[0]?.exit !== 'landed' : folds[0]?.exit === 'landed'), folds)
      if (commands.some(text => text.includes(NEW))) check('only the newest nonempty instructions reach the summary request', requests[0]?.raw.includes(NEW) === true && !requests[0].raw.includes(OLD))
      check(fails ? 'a failed fold leaves all waiting lines' : 'a landed fold takes every /compact but no other command', JSON.stringify(afterIds) === JSON.stringify(fails ? [...ids, other] : [other]), afterIds)
      check('the window settles the queued rows exactly when the fold lands', sends.queuedSendCount() === (fails ? ids.length : 0), sends.queuedSendCount())
      runner.answerAsk(second.id, { outcome: 'allow' })
      await runner.waitFor('the original turn finishes', r => r.type === 'outcome' && r.answer === 'continued the same turn')
      await runner.prompt('mark the next turn', { id: stop })
      await runner.waitFor('a subsequent turn has started', r => r.type === 'turn' && r.state === 'started' && (r.message_ids as string[])?.includes(stop))
      const starts = runner.rows.slice(start).filter(r => r.type === 'turn' && r.state === 'started').map(r => r.message_ids)
      check('no second /compact turn after a landed fold; ordinary end-of-turn dispatch after failure', JSON.stringify(starts) === JSON.stringify([stepId, ...(fails ? ids : []), other, stop].map(id => [id])), starts)
      await runner.stop()
    }, { model: 'claude-opus-4-6', argv: ['--session-id', session], env })
    const file = transcriptFiles(join(home, 'projects')).find(path => path.endsWith(`${session}.jsonl`))!
    const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => recordToEntry(JSON.parse(line)))
    const boundaries = entries.filter(row => row.type === 'system' && row.subtype === 'compact_boundary')
    if (!fails) check('one persisted fold boundary with its original trigger', boundaries.length === 1 && (boundaries[0]?.compactMetadata as { trigger?: string })?.trigger === 'auto', boundaries.length)
    check('each request has one enqueue and one completion in the queue journal', ids.every(id => {
      const ops = entries.filter(row => row.type === 'queue-operation' && row.commandUuid === id).map(row => row.operation)
      return ops.length === 2 && ops[0] === 'enqueue' && (ops[1] === 'dequeue' || ops[1] === 'remove')
    }))
  } finally { rmSync(home, { recursive: true, force: true }) }
}

async function checkScope(): Promise<void> {
  const q = await import('../../src/input-core/command-queue.ts')
  const { makeOwnerKey, MAIN_LANE, agentLane } = await import('../../src/utils/run/ownerKey.ts')
  const session = randomUUID()
  const owner = (sessionId: string, lane: string) => makeOwnerKey({ workspace: 'project', sessionId, lane })
  q.rekeyCommandQueueToSession(session)
  q.holdQueuedWordsForTurnEnd(true)
  const queued = (value: string, extra = {}) => q.enqueue({ value, mode: 'prompt', localCommand: true, ...extra })
  const recalled = randomUUID()
  queued('/compact before recall', { uuid: recalled })
  queued('/compact for crew', { agentId: 'other' })
  queued('/compact literal text', { skipSlashCommands: true })
  queued(' /compact not a slash command')
  queued('/compact bash', { mode: 'bash' })
  queued('/compact genuine')
  check('neither a different session nor a crewmate owns the waiting request', q.queuedCompactRequest(owner(randomUUID(), MAIN_LANE)) === undefined && q.queuedCompactRequest(owner(session, agentLane('other'))) === undefined)
  const request = q.queuedCompactRequest(owner(session, MAIN_LANE))
  check('the main conversation selects its own instructions', request?.instructions === 'genuine')
  q.popById(recalled)
  queued('/compact before recall')
  q.releaseQueuedWordsToTurn()
  request?.complete()
  check('completion takes only the original queue identities, not a resend, literal or crewmate line', JSON.stringify(q.getCommandQueue().map(c => c.value)) === JSON.stringify(['/compact for crew', '/compact literal text', ' /compact not a slash command', '/compact bash', '/compact before recall']))
  q.resetCommandQueue()
}

await drive(false, ['/compact'])
await drive(false, [`/compact ${OLD}`, `/compact ${NEW}`, '/compact'])
await drive(true, [`/compact ${NEW}`])
await checkScope()
process.exitCode = failures ? 1 : 0
