import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordToEntry } from '../../src/sessions/fabric/entryCodec.ts'
import { historyLines } from '../../src/sessions/transcripts/historyParts.ts'
import { withInactivityDeadline } from '../../src/platform/async/deadline.ts'
import { SendsPart } from '../../src/engine/connector/daemon/sends.ts'
import { liveFactsOf, withFixtureRunner, withLiveRunner } from '../lib/builtProduct.ts'
import { countTokensFixtureFigure, renderTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
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

async function drive(fails: boolean, commands: string[], early = false): Promise<void> {
  const trigger = early ? 'manual' : 'auto'
  const home = mkdtempSync(join(tmpdir(), 'queued-compact-'))
  const session = randomUUID()
  const ids = commands.map(() => randomUUID())
  const other = randomUUID()
  const stepId = randomUUID()
  const stop = randomUUID()
  const env = { MERCURY_CONFIG_DIR: home, MERCURY_SESSION_KIND: 'oculus', MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '50' }
  const turn = (index: number, tokens: number): ScriptedTurn => ({ kind: 'tool_use', name: 'Read', input: { file_path: join(home, `note-${index}`) }, usage: { input_tokens: tokens }, model: 'claude-opus-4-6' })
  const summary: ScriptedTurn = fails ? { kind: 'error', status: 400, errorType: 'invalid_request_error', message: early ? 'The fixture refused this summary.' : 'No tool output found for function call fixture.' } : { kind: 'text', text: SUMMARY }
  try {
    writeFileSync(join(home, '.mercury.json'), JSON.stringify({ autoCompactWindow: 200000 }))
    for (const index of [1, 2]) writeFileSync(join(home, `note-${index}`), 'a fixture line')
    await withFixtureRunner([
      { kind: 'text', text: history }, turn(1, early ? 25000 : 150000), { ...summary, whenBody: FOLD }, ...(fails ? [{ ...summary, whenBody: FOLD }] : []), turn(2, 25), { kind: 'text', text: 'continued the same turn' }, { kind: 'text', text: SUMMARY, whenBody: FOLD }, { kind: 'text', text: 'next turn' },
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
      check('runner and window have every queued /compact before the fold', ids.every(id => before.queue.some(q => q.uuid === id)) && sends.queuedSendCount() === ids.length, { hint: 'the runner queue must list every queued /compact and SendsPart.reconcileQueuedSends (src/engine/connector/daemon/sends.ts) must count them as queued sends', queue: before.queue })
      runner.answerAsk(first.id, { outcome: 'allow' })
      const second = await runner.waitForAsk('the turn continues after the fold check')
      const after = await liveFactsOf(runner)
      sends.reconcileQueuedSends({ ...after, ...stamp })
      const afterIds = after.queue.map(q => q.uuid)
      const folds = runner.rows.slice(start).filter(row => row.type === 'compaction' && row.state === 'ended')
      const requests = api.messageRequests().filter(req => !req.path.includes('count_tokens') && req.raw.includes(FOLD))
      check('the still-open turn requests its summary, including both refused attempts on failure', requests.length === (fails ? 2 : 1), { hint: 'the fold must send its summary request once, and twice when the first attempt is refused', requests: requests.length })
      check(`the ${trigger} fold reports its exit before the turn ends`, folds.length === 1 && folds[0]?.trigger === trigger && (fails ? folds[0]?.exit !== 'landed' : folds[0]?.exit === 'landed'), { hint: 'exactly one ended compaction row with this trigger must appear before the turn ends, exit landed only when the summary succeeded', folds })
      if (commands.some(text => text.includes(NEW))) check('only the newest nonempty instructions reach the summary request', requests[0]?.raw.includes(NEW) === true && !requests[0].raw.includes(OLD))
      check(fails ? 'a failed fold leaves all waiting lines' : 'a landed fold takes every /compact but no other command', JSON.stringify(afterIds) === JSON.stringify(fails ? [...ids, other] : [other]), { hint: 'a landed fold must take every queued /compact and leave other commands; a failed fold must leave all lines', afterIds })
      check('the window settles the queued rows exactly when the fold lands', sends.queuedSendCount() === (fails ? ids.length : 0), { hint: 'SendsPart.reconcileQueuedSends (src/engine/connector/daemon/sends.ts) must settle the window queued rows exactly when the fold lands', queuedSendCount: sends.queuedSendCount() })
      runner.answerAsk(second.id, { outcome: 'allow' })
      const end = await runner.waitFor('the original turn finishes', r => r.type === 'outcome' && r.answer === 'continued the same turn')
      if (early && fails) check('the waiting line does not trigger another attempt at the following step', runner.rows.slice(start, runner.rows.indexOf(end)).filter(row => row.type === 'compaction' && row.state === 'ended').length === 1)
      await runner.prompt('mark the next turn', { id: stop })
      await runner.waitFor('a subsequent turn has started', r => r.type === 'turn' && r.state === 'started' && (r.message_ids as string[])?.includes(stop))
      const starts = runner.rows.slice(start).filter(r => r.type === 'turn' && r.state === 'started').map(r => r.message_ids)
      check('no second /compact turn after a landed fold; ordinary end-of-turn dispatch after failure', JSON.stringify(starts) === JSON.stringify([stepId, ...(fails ? ids : []), other, stop].map(id => [id])), { hint: 'after a landed fold no extra /compact turn may start; after a failure the waiting lines dispatch at end of turn in order', starts })
      await runner.stop()
    }, { model: 'claude-opus-4-6', argv: ['--session-id', session], env })
    const file = transcriptFiles(join(home, 'projects')).find(path => path.endsWith(`${session}.jsonl`))!
    const entries = Array.from(historyLines(file), line => recordToEntry(JSON.parse(line.toString('utf8'))))
    const boundaries = entries.filter(row => row.type === 'system' && row.subtype === 'compact_boundary')
    if (!fails) check('one persisted fold boundary with its original trigger', boundaries.length === 1 && (boundaries[0]?.compactMetadata as { trigger?: string })?.trigger === trigger, boundaries.map(b => b.compactMetadata))
    if (!fails) {
      const receipts = entries.filter(row => row.type === 'system' && row.subtype === 'local_command' && String(row.content).includes('<local-command-stdout>') && String(row.content).includes('Compacted — '))
      const receipt = String(receipts[0]?.content ?? '')
      const kept = (boundaries[0]?.compactMetadata as { preservedSegment?: unknown } | undefined)?.preservedSegment !== undefined
      check('only the early manual fold prints one chat receipt with its folded count, token change and surviving tail', early ? receipts.length === 1 && /Compacted — folded \d+ messages? into the summary · context \S+ → \S+ tokens/.test(receipt) && / · last \d+ messages? kept verbatim/.test(receipt) === kept : receipts.length === 0, receipts.map(row => row.content))
    }
    check('each request has one enqueue and one completion in the queue journal', ids.every(id => {
      const ops = entries.filter(row => row.type === 'queue-operation' && row.commandUuid === id).map(row => row.operation)
      return ops.length === 2 && ops[0] === 'enqueue' && (ops[1] === 'dequeue' || ops[1] === 'remove')
    }))
  } finally { rmSync(home, { recursive: true, force: true }) }
}

async function lateArrival(duringFold: boolean): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'compact-arrival-'))
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const rawFolds: string[] = []
  const read = (index: number): ScriptedTurn => ({ kind: 'tool_use', name: 'Read', input: { file_path: join(home, `note-${index}`) }, usage: { input_tokens: index === 1 ? 150000 : 25 }, model: 'claude-opus-4-6' })
  const ordinary: ScriptedTurn[] = [{ kind: 'text', text: history }, ...(duringFold ? [read(1), read(2)] : []), { kind: 'text', text: 'turn finished' }]
  let seq = 0
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
    const path = new URL(req.url).pathname
    const body = await req.text()
    if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: countTokensFixtureFigure(body) })
    if (!path.endsWith('/messages')) return Response.json({})
    const index = ++seq
    const fold = body.includes(FOLD)
    if ((duringFold && fold) || (!duringFold && index === 2)) { ready.resolve(); await release.promise }
    if (fold) rawFolds.push(body)
    const reply = fold ? { kind: 'text' as const, text: SUMMARY } : ordinary.shift() ?? { kind: 'text' as const, text: 'done' }
    return new Response(renderTurn(reply, index), { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  try {
    writeFileSync(join(home, '.mercury.json'), JSON.stringify({ autoCompactWindow: 200000 }))
    for (const index of [1, 2]) writeFileSync(join(home, `note-${index}`), 'a fixture line')
    await withLiveRunner(async runner => {
      await runner.prompt('record the notes')
      await runner.waitFor('history recorded', r => r.type === 'outcome')
      const start = runner.rows.length
      await runner.prompt(duringFold ? 'read both notes' : 'finish the turn')
      if (duringFold) runner.answerAsk((await runner.waitForAsk('first read')).id, { outcome: 'allow' })
      await withInactivityDeadline({ seam: 'the fixture receives the in-flight request', limitMs: 60000 }, () => ready.promise)
      const bare = randomUUID(), instructed = randomUUID()
      if (duringFold) await runner.prompt('/compact', { id: bare })
      await runner.prompt(`/compact ${NEW}`, { id: instructed })
      release.resolve()
      if (duringFold) {
        const second = await runner.waitForAsk('next read after the fold lands')
        const ids = (await liveFactsOf(runner)).queue.map(line => line.uuid)
        check('a bare line arriving during a fold settles when it lands', !ids.includes(bare) && rawFolds.length === 1, ids)
        check('a late instruction not used in the summary remains queued', ids.includes(instructed) && !rawFolds[0]?.includes(NEW), ids)
        await runner.request('queue/withdraw', { id: instructed })
        runner.answerAsk(second.id, { outcome: 'allow' })
      }
      const end = await runner.waitFor('original turn finishes', r => r.type === 'outcome' && r.answer === 'turn finished')
      if (!duringFold) {
        const taken = await runner.waitFor('turn end takes the waiting /compact', r => r.type === 'turn' && r.state === 'started' && (r.message_ids as string[])?.includes(instructed))
        const folded = await runner.waitFor('manual fold at turn end', r => r.type === 'compaction' && r.state === 'ended')
        const rows = runner.rows.slice(start)
        const endIndex = rows.indexOf(end), takenIndex = rows.indexOf(taken), foldedIndex = rows.indexOf(folded)
        check('without another step the command runs once at turn end using its instructions', endIndex >= 0 && takenIndex >= 0 && foldedIndex >= 0 && endIndex < takenIndex && takenIndex < foldedIndex && folded.trigger === 'manual' && folded.exit === 'landed' && rawFolds.length === 1 && rawFolds[0]!.includes(NEW), folded)
      }
    }, { argv: ['--model', 'claude-opus-4-6'], env: { MERCURY_CONFIG_DIR: home, MERCURY_SESSION_KIND: 'oculus', MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '50', ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url.origin } })
  } finally { release.resolve(); api.stop(true); rmSync(home, { recursive: true, force: true }) }
}
async function checkScope(): Promise<void> {
  const q = await import('../../src/screen/composer/input-core/command-queue.ts')
  const { makeOwnerKey, MAIN_LANE, agentLane } = await import('../../src/engine/run-owner/ownerKey.ts')
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
  check('neither a different session nor a crewmate owns the waiting request', q.beginQueuedFold(owner(randomUUID(), MAIN_LANE)) === undefined && q.beginQueuedFold(owner(session, agentLane('other'))) === undefined, { hint: 'beginQueuedCompact (src/screen/composer/input-core/command-queue.ts) must return nothing for another session or a crewmate lane' })
  const request = q.beginQueuedFold(owner(session, MAIN_LANE))
  check('the main conversation selects its own instructions', request?.instructions === 'genuine', { hint: 'beginQueuedCompact (src/screen/composer/input-core/command-queue.ts) must pick the main conversation /compact line and return its instructions', got: request?.instructions })
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
await drive(false, [`/compact ${NEW}`], true)
await drive(true, [`/compact ${NEW}`], true)
await lateArrival(false)
await lateArrival(true)
await checkScope()
process.exitCode = failures ? 1 : 0
