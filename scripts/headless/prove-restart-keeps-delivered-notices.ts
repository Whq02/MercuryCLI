#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, SCRATCH_ROOT, makeTally, removeWorld, sleep } from '../daemon/dupline-world.ts'

const tally = makeTally('prove-restart-keeps-delivered-notices')
console.log('build under proof: src, in this process (the carry and the reconciliation run in the order the runner runs them)')
console.log(' red on the base: C2, C4-C7, C10, R1-R4, R6, R9, S1 and P1 (an agent whose notice was the second of two in one input is delivered again from its receipt; one whose notice was drained mid-turn as an attachment is counted stopped and gets the stop notice)')

const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'restart-delivered-notices-')))
const home = join(root, 'home')
mkdirSync(join(home, 'projects', 'proof'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { carryRunnerAcrossRestart } = await import('../../src/cli/headless/restartCarry.ts')
const lr = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const queue = await import('../../src/input-core/command-queue.ts')

type Msg = Record<string, unknown>
type Launch = { toolUseId: string; agentId: string; description: string }

const SESSION = randomUUID()
const LINE = 'restart probe: the line typed during the turn that died with the runner'
const LINE_UUID = '00000000-0000-4000-8000-00000000d1e5'
const BASH: Launch = { toolUseId: 'toolu_bash', agentId: 'bq4k9w2xe', description: 'build the fixture' }
const COMBINED: Launch = { toolUseId: 'toolu_combined', agentId: 'a7m3k2p9d', description: 'Review calc.js edge cases' }
const ATTACHED: Launch = { toolUseId: 'toolu_attached', agentId: 'aj5n8c4rt', description: 'Echo agent' }
const HELD: Launch = { toolUseId: 'toolu_held', agentId: 'ah2v6x9fq', description: 'Count the lanterns' }
const GHOST: Launch = { toolUseId: 'toolu_ghost', agentId: 'ag8t1y3zw', description: 'Chart the harbour' }
const CRASH_ROW = 'runner restarted after a crash: 0 background agents relaunched, 1 delivered from their receipts, 1 stopped'
const STOP_ROW = 'runner restarted after a stop: 0 background agents relaunched, 1 delivered from their receipts, 1 stopped'
const PLAIN_WORDS = "the session's runner restarted before it finished, so nothing it started will be delivered"
const CRASH_WORDS = "the session's runner restarted after a crash before it finished, so nothing it started will be delivered"

let tick = 0
const stamp = (): string => new Date(Date.UTC(2026, 9, 4, 19, 0, 0) + ++tick * 1000).toISOString()

const noticeOf = (launch: Launch, status: string, summary: string, withToolUse = true): string =>
  [
    '<task-notification>',
    `<task-id>${launch.agentId}</task-id>`,
    ...(withToolUse ? [`<tool-use-id>${launch.toolUseId}</tool-use-id>`] : []),
    `<output-file>${join(root, 'tasks', `${launch.agentId}.output`)}</output-file>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    ...(status === 'completed' ? [`<result>${launch.description}: done</result>`, '<usage><total_tokens>48</total_tokens><tool_uses>0</tool_uses><duration_ms>1200</duration_ms></usage>'] : []),
    '</task-notification>',
  ].join('\n')
const completed = (launch: Launch): string => noticeOf(launch, 'completed', `Agent "${launch.description}" completed`)
const talked = (launch: Launch): string => noticeOf(launch, 'message', `Agent "${launch.description}" sent a message`, false)
const bashDone = (launch: Launch): string => noticeOf(launch, 'completed', `Background command "${launch.description}" completed (exit code 0)`)
const resumed = (launch: Launch): string => noticeOf(launch, 'resumed', `Agent "${launch.description}" resumed by itself`, false)

const assistant = (content: unknown[]): Msg => ({ type: 'assistant', uuid: randomUUID(), timestamp: stamp(), requestId: undefined, message: { id: `msg_${tick}`, model: 'fixture', role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' } })
const user = (content: unknown): Msg => ({ type: 'user', uuid: randomUUID(), timestamp: stamp(), message: { role: 'user', content } })
const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })
const launchesOf = (launches: Launch[]): Msg =>
  assistant([text('launching the helpers'), ...launches.map(l => ({ type: 'tool_use', id: l.toolUseId, name: 'Agent', input: { description: l.description, prompt: `${l.description}: go`, subagent_type: 'mercury-crew', run_in_background: true } }))])
const receiptsOf = (launches: Launch[]): Msg =>
  user(launches.map(l => ({ type: 'tool_result', tool_use_id: l.toolUseId, content: [text(`${lr.BACKGROUND_LAUNCH_LINE}\nagentId: ${l.agentId} (internal — do not mention it to the user). To continue this agent, use SendMessage addressed to that id.\nThe agent is working in the background — you will be notified automatically when it completes.`)] })))
const drained = (prompt: string | unknown[]): Msg => ({
  type: 'attachment',
  uuid: randomUUID(),
  timestamp: stamp(),
  attachment: { type: 'queued_command', prompt, commandMode: 'task-notification', sentAt: stamp(), deliveredAt: stamp() },
})

const settledBy = (...messages: Msg[]): Set<string> => lr.settledLaunchIds(messages as never)
const has = (set: Set<string>, ...ids: string[]): boolean => ids.every(id => set.has(id))
const none = (set: Set<string>, ...ids: string[]): boolean => ids.every(id => !set.has(id))

tally.section('C1-C11 the settled set, pure: a launch is settled by every notice that reached the model, wherever it rode')
{
  const alone = settledBy(user(completed(COMBINED)))
  tally.check('C1 a notice that is the whole input settles its launch by tool-use id and by task id (the road that was always right)', has(alone, COMBINED.toolUseId, COMBINED.agentId) && none(alone, ATTACHED.agentId), JSON.stringify([...alone]))

  const second = settledBy(user([text(bashDone(BASH)), text(completed(COMBINED))]))
  tally.check('C2 two notices folded into one input (a shell first, an agent second): the agent is settled too', has(second, COMBINED.toolUseId, COMBINED.agentId), JSON.stringify([...second]))
  tally.check('C3 …and the notice in first position is settled as before', has(second, BASH.toolUseId, BASH.agentId), JSON.stringify([...second]))

  const three = settledBy(user([text(completed(COMBINED)), text(bashDone(BASH)), text(completed(ATTACHED))]))
  tally.check('C4 three notices in one input: the first, the second and the third are all settled', has(three, COMBINED.agentId, BASH.agentId, ATTACHED.agentId, ATTACHED.toolUseId), JSON.stringify([...three]))

  const oneText = settledBy(user(`${bashDone(BASH)}\n${completed(COMBINED)}`))
  tally.check('C5 two notices joined in one text block settle both', has(oneText, BASH.agentId, COMBINED.agentId, COMBINED.toolUseId), JSON.stringify([...oneText]))

  const asString = settledBy(drained(completed(ATTACHED)))
  tally.check('C6 a notice drained mid-turn as a queued_command attachment settles its launch', has(asString, ATTACHED.toolUseId, ATTACHED.agentId), JSON.stringify([...asString]))
  const asBlocks = settledBy(drained([text(completed(ATTACHED)), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]))
  tally.check('C7 …whether its prompt is a string or content blocks', has(asBlocks, ATTACHED.toolUseId, ATTACHED.agentId), JSON.stringify([...asBlocks]))

  const notNotice = settledBy(drained(LINE), { type: 'attachment', uuid: randomUUID(), timestamp: stamp(), attachment: { type: 'file', filename: 'notes.txt', content: completed(GHOST) } })
  tally.check("C8 an operator's queued line, or any other attachment, settles nothing", none(notNotice, GHOST.agentId, GHOST.toolUseId), JSON.stringify([...notNotice]))

  const receiptOnly = settledBy(user(resumed(HELD)), drained(resumed(GHOST)))
  tally.check('C9 a resume receipt settles no launch, as an input or as an attachment', none(receiptOnly, HELD.agentId, GHOST.agentId), JSON.stringify([...receiptOnly]))
  const mixedA = settledBy(user([text(resumed(HELD)), text(completed(COMBINED))]))
  const mixedB = settledBy(user([text(completed(ATTACHED)), text(resumed(GHOST))]))
  tally.check('C10 a resume receipt beside a completion in one input settles the completion only, in either order', has(mixedA, COMBINED.agentId) && none(mixedA, HELD.agentId) && has(mixedB, ATTACHED.agentId) && none(mixedB, GHOST.agentId), JSON.stringify([...mixedA, '|', ...mixedB]))

  const talkedAttached = settledBy(drained(talked(HELD)))
  const talkedLater = settledBy(user([text(completed(COMBINED)), text(talked(GHOST))]))
  tally.check('C11 an agent\'s message to the main thread ends nothing: as an attachment, or after another notice in an input, it settles no launch (the road that was never changed)', none(talkedAttached, HELD.agentId) && has(talkedLater, COMBINED.agentId) && none(talkedLater, GHOST.agentId), JSON.stringify([...talkedAttached, '|', ...talkedLater]))
}

const sessionFile = join(home, 'projects', 'proof', `${SESSION}.jsonl`)
let ordinal = 0
const journal = (operation: string, fields: Record<string, unknown> = {}): string => {
  const at = stamp()
  return JSON.stringify({
    schemaVersion: 1,
    recordId: randomUUID(),
    sessionId: SESSION,
    threadId: 'main',
    creationOrdinal: String(++ordinal),
    updateOrdinal: String(ordinal),
    occurredAt: at,
    actor: { role: 'system' },
    source: { channel: 'sdk' },
    payload: { kind: 'session-meta', metaKind: 'queue-operation', fields: { operation, timestamp: at, sessionId: SESSION, ...fields } },
  })
}
const heldNotice = completed(HELD)
writeFileSync(
  sessionFile,
  [
    journal('enqueue', { content: bashDone(BASH), mode: 'task-notification', sentAt: stamp() }),
    journal('enqueue', { content: completed(COMBINED), mode: 'task-notification', sentAt: stamp() }),
    journal('dequeue'),
    journal('dequeue'),
    journal('enqueue', { content: completed(ATTACHED), mode: 'task-notification', sentAt: stamp() }),
    journal('dequeue'),
    journal('enqueue', { content: heldNotice, mode: 'task-notification', sentAt: stamp() }),
    journal('enqueue', { content: LINE, commandUuid: LINE_UUID, mode: 'prompt', sentAt: stamp() }),
  ].join('\n') + '\n',
)

const conversation: Msg[] = [
  launchesOf([COMBINED, ATTACHED, HELD, GHOST]),
  receiptsOf([COMBINED, ATTACHED, HELD, GHOST]),
  assistant([text('four helpers are running')]),
  user([text(bashDone(BASH)), text(completed(COMBINED))]),
  assistant([text('the build and the review are done')]),
  assistant([{ type: 'tool_use', id: 'toolu_foreground', name: 'Bash', input: { command: 'sleep 4', description: 'hold the turn' } }]),
  drained(completed(ATTACHED)),
  user([{ type: 'tool_result', tool_use_id: 'toolu_foreground', content: [text('done')] }]),
  assistant([text('the echo agent is done too')]),
]

type Restart = { outcome: Awaited<ReturnType<typeof carryRunnerAcrossRestart>> | null; settled: Array<{ agentId: string }>; queued: Array<{ value: string; uuid: string | undefined }> }
async function restart(reason: 'crash' | 'stop' | undefined): Promise<Restart> {
  queue.resetCommandQueue()
  let state: { tasks: Record<string, unknown> } = { tasks: {} }
  const getAppState = (): never => state as never
  const setAppState = (updater: (prev: never) => never): void => {
    state = updater(state as never) as never
  }
  const outcome =
    reason === undefined
      ? null
      : await carryRunnerAcrossRestart({
          reason,
          messages: conversation as never,
          getAppState,
          setAppState,
          canUseTool: (async () => ({ behavior: 'deny' })) as never,
          relaunchContext: async () => {
            throw new Error('this proof relaunches nothing')
          },
          transcriptPath: sessionFile,
        })
  const settled = lr.reconcileBackgroundLaunchesOnResume(conversation as never, getAppState, setAppState, Date.now(), reason)
  return { outcome, settled, queued: queue.getCommandQueue().map(c => ({ value: typeof c.value === 'string' ? c.value : JSON.stringify(c.value), uuid: c.uuid === undefined ? undefined : String(c.uuid) })) }
}
const about = (r: Restart, launch: Launch, status?: string): Array<{ value: string }> =>
  r.queued.filter(c => c.value.includes(`<task-id>${launch.agentId}</task-id>`) && (status === undefined || c.value.includes(`<status>${status}</status>`)))
const brief = (value: string): string => {
  const id = /<task-id>([^<]*)<\/task-id>/.exec(value)?.[1]
  return id === undefined ? value.slice(0, 48) : `${id}:${/<status>([^<]*)<\/status>/.exec(value)?.[1] ?? ''}`
}
const told = (r: Restart): string => JSON.stringify(r.queued.map(c => brief(c.value)))

tally.section('R1-R9 a runner restarted after a crash: the carry and the reconciliation that follows it, over a conversation where two agents were already told')
const crash = await restart('crash')
{
  const out = crash.outcome
  tally.check('R1 the agent whose notice was the second of two in one input is not delivered again from its receipt', about(crash, COMBINED).length === 0, told(crash))
  tally.check('R2 the agent whose notice was drained mid-turn as an attachment gets no stop notice', about(crash, ATTACHED).length === 0, told(crash))
  tally.check('R3 …and neither is in the counts: one delivered, one stopped, none relaunched', out !== null && out.relaunched === 0 && out.delivered === 1 && out.stopped === 1, JSON.stringify(out))
  tally.check(`R4 one row tells what the restart carried, in the ruled words: ${CRASH_ROW}`, out !== null && out.row === CRASH_ROW && crash.queued.filter(c => c.value === CRASH_ROW).length === 1, JSON.stringify(out?.row))
  tally.check("R5 the finished agent the model was never told about is still delivered from its receipt: its held notice, byte for byte", about(crash, HELD).length === 1 && about(crash, HELD)[0]!.value === heldNotice, told(crash))
  tally.check("R6 the launch nothing knows about is still reported stopped, in the crash words, once", about(crash, GHOST, 'killed').length === 1 && about(crash, GHOST, 'killed')[0]!.value.includes(CRASH_WORDS) && crash.settled.map(s => s.agentId).join() === GHOST.agentId, JSON.stringify(crash.settled.map(s => s.agentId)))
  tally.check("R7 the operator's line that died with the runner is queued again under its own identity", out !== null && out.requeued === 1 && crash.queued.some(c => c.value === LINE && c.uuid === LINE_UUID), JSON.stringify(crash.queued.map(c => [c.value.slice(0, 40), c.uuid])))
  tally.check('R8 the model is told each agent at most once: no task id sits in two queued notices', [COMBINED, ATTACHED, HELD, GHOST].every(l => about(crash, l).length <= 1), told(crash))
  tally.check('R9 nothing else is queued: the line, the row, the held notice and the one stop notice', crash.queued.length === 4, told(crash))
}

tally.section('S1-S2 a restart after a stop carries the same, and its row says the stop')
const stopped = await restart('stop')
{
  const out = stopped.outcome
  tally.check(`S1 the agents already told stay untouched and the row is ruled: ${STOP_ROW}`, about(stopped, COMBINED).length === 0 && about(stopped, ATTACHED).length === 0 && out !== null && out.row === STOP_ROW, JSON.stringify(out))
  tally.check('S2 the unnotified one is delivered, the unknown one stopped in the stop words', about(stopped, HELD).length === 1 && about(stopped, GHOST, 'killed').length === 1 && about(stopped, GHOST, 'killed')[0]!.value.includes("the session's runner restarted after a stop before it finished"), told(stopped))
}

tally.section('P1-P3 a plain resume keeps its words: the stop notice goes to the agents nobody told, and to no other')
const plain = await restart(undefined)
{
  tally.check('P1 the two agents the model was told about get no stop notice', about(plain, COMBINED).length === 0 && about(plain, ATTACHED).length === 0, told(plain))
  tally.check('P2 the finished one never told and the unknown one each get the stop notice in the plain words, and the held completion is not delivered', about(plain, HELD, 'killed').length === 1 && about(plain, GHOST, 'killed').length === 1 && about(plain, HELD, 'killed')[0]!.value.includes(PLAIN_WORDS) && about(plain, GHOST, 'killed')[0]!.value.includes(PLAIN_WORDS) && !plain.queued.some(c => c.value === heldNotice), told(plain))
  tally.check('P3 no row on a plain resume, and the operator\'s line is not queued again', plain.outcome === null && !plain.queued.some(c => c.value.startsWith('runner restarted') || c.value === LINE), told(plain))
}

tally.section('O1 the runner runs the carry before the reconciliation, inside the one resume closure')
{
  const run = readFileSync(join(REPO, 'src', 'cli', 'run.ts'), 'utf8')
  const carryAt = run.indexOf('await carryRunnerAcrossRestart({')
  const reconcileAt = run.indexOf('reconcileBackgroundLaunchesOnResume(messages, getAppState, setAppState, Date.now(), coerceRestartReason(runnerRestartReason))')
  const closureAt = run.indexOf('const hydrateResumedRun = async')
  const callAt = run.indexOf('if (options.continue || options.resume) await hydrateResumedRun()')
  tally.check('O1 both calls sit in hydrateResumedRun, the carry first (the order this proof drives them in)', closureAt > 0 && carryAt > closureAt && reconcileAt > carryAt && reconcileAt < callAt, JSON.stringify({ closureAt, carryAt, reconcileAt, callAt }))
}

await sleep(300)
await removeWorld(root)
tally.finish()
