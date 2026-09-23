#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'overload-relay-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_OVERLOAD_PROBE_SCALE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const overload = await import('../../src/tasks/LocalAgentTask/agentOverload.ts')
const pause = await import('../../src/tasks/LocalAgentTask/agentPause.ts')
const lane = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { createAssistantAPIErrorMessage } = await import('../../src/utils/messages/factories.ts')
import type { Message } from '../../src/types/message.ts'

const OVERLOADED_ROW = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CfHZrdNJLUZnN5a6wrGCM"}'
const WINDOW = 60 * 60_000

section('§1 the relay: ten deaths of one lane in one episode tell the parent once')
{
  const episode = overload.openOverloadEpisode(0, 1)
  let notices = 0
  const firsts: boolean[] = []
  for (let death = 1; death <= 10; death++) {
    firsts.push(overload.noteOverloadDeath(episode).first)
    if (overload.overloadDeathNotifies(episode)) notices++
  }
  check('ten deaths counted on the one episode', episode.deaths === 10, `${episode.deaths}`)
  check('only the first death is first', firsts[0] === true && firsts.slice(1).every(f => f === false), JSON.stringify(firsts))
  check("the parent hears the episode once: one notice for ten deaths", notices === 1, `${notices} notices`)
  const later = overload.openOverloadEpisode(WINDOW + 1, 1)
  overload.noteOverloadDeath(later)
  check('a death after the window is a new episode and speaks again', overload.overloadDeathNotifies(later) && later.deaths === 1)
}

section('§2 the probe cadence: slow, bounded, scaled')
{
  const episode = overload.openOverloadEpisode(0, 1)
  check('the first probe follows a death after 30 s', overload.nextOverloadProbeDelayMs(episode, 0, true) === 30_000)
  check('inside the first ten minutes the probes come every minute', overload.nextOverloadProbeDelayMs(episode, 60_000, false) === 60_000 && overload.nextOverloadProbeDelayMs(episode, 9 * 60_000, false) === 60_000)
  check('after ten minutes every five minutes', overload.nextOverloadProbeDelayMs(episode, 11 * 60_000, false) === 5 * 60_000)
  check('the last probe is clipped to the window and none follows it', overload.nextOverloadProbeDelayMs(episode, WINDOW - 1_000, false) === 1_000 && overload.nextOverloadProbeDelayMs(episode, WINDOW, false) === null && overload.nextOverloadProbeDelayMs(episode, WINDOW + 60_000, true) === null)
  check('the window is one hour, the probe request bounded to 30 s', episode.untilMs === WINDOW && overload.overloadProbeRequestMs(1) === 30_000)
  check('the spent retry budget on a 529 storm reads as an overload answer', overload.isOverloadAnswerText('the provider refused 7 times in a row (HTTP 529, overloaded) — the 6s retry budget is spent') && !overload.isOverloadAnswerText('the provider refused 7 times in a row (HTTP 429, busy) — the 6s retry budget is spent'))
  const scaled = overload.openOverloadEpisode(0, 0.01)
  check('the scale seam shrinks the first wait, both cadences, the request bound and the window alike', overload.nextOverloadProbeDelayMs(scaled, 0, true) === 300 && overload.nextOverloadProbeDelayMs(scaled, 1_000, false) === 600 && overload.nextOverloadProbeDelayMs(scaled, 7_000, false) === 3_000 && scaled.untilMs === WINDOW / 100 && overload.overloadProbeRequestMs(0.01) === 300)
  check('unset, empty, zero and negative scales read as 1', overload.overloadProbeScale() === 1 && (process.env.MERCURY_OVERLOAD_PROBE_SCALE = '') === '' && overload.overloadProbeScale() === 1 && (process.env.MERCURY_OVERLOAD_PROBE_SCALE = '0') === '0' && overload.overloadProbeScale() === 1 && (process.env.MERCURY_OVERLOAD_PROBE_SCALE = '-3') === '-3' && overload.overloadProbeScale() === 1)
  delete process.env.MERCURY_OVERLOAD_PROBE_SCALE
}

section("§3 the overload answer, read off the lane's last row")
{
  check("the wire's 529 row, the overloaded_error body and the repeated-overload line are overload answers", overload.isOverloadAnswerText(OVERLOADED_ROW) && overload.isOverloadAnswerText('{"type":"overloaded_error"}') && overload.isOverloadAnswerText('API Error: Repeated API overload errors (529). The provider is under sustained load; try again shortly.'))
  check('a 429 row, a plain fault and a request id that happens to hold 529 are not', !overload.isOverloadAnswerText('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}') && !overload.isOverloadAnswerText('API Error: connection lost') && !overload.isOverloadAnswerText('API Error: 500 {"request_id":"req_529abc"}'))
  const dead: Message[] = [createAssistantAPIErrorMessage({ content: OVERLOADED_ROW, error: 'unknown' }) as Message]
  const read = lane.overloadPauseOf(dead, 'claude-fable-5-1')
  check("a lane whose last row is the 529 answer pauses as 'provider overloaded' with the model named and no reset", read !== null && read.pause.why === 'provider overloaded' && read.pause.resumesAtMs === undefined && read.pause.words.startsWith(`${read.who} is overloaded (HTTP 529) — Mercury probes it for up to 1h and resumes the agent when it answers`), JSON.stringify(read))
  const asked = { ...(createAssistantAPIErrorMessage({ content: OVERLOADED_ROW, error: 'unknown' }) as Message), providerWaitEndsAtMs: Date.now() + 60_000 } as Message
  check('a 529 that states its wait keeps the stated-wait road (no overload pause)', lane.overloadPauseOf([asked], 'claude-fable-5-1') === null)
  const limited: Message[] = [createAssistantAPIErrorMessage({ content: 'API Error: 429 the window is spent', error: 'rate_limit' }) as Message]
  check('a rate-limit row and a real reply are not overload pauses', lane.overloadPauseOf(limited, 'claude-fable-5-1') === null && lane.overloadPauseOf([], 'claude-fable-5-1') === null)
}

section('§4 the words: calm, one spelling')
{
  const words = overload.overloadPauseWords('Fable 5.1', 1)
  const line = overload.overloadNoticeWords('lane', 'Fable 5.1', 1)
  const row: import('../../src/tasks/LocalAgentTask/agentPause.ts').AgentPauseV1 = { why: 'provider overloaded', words }
  check("the row's status cell", pause.pauseStatusWords(row, 0) === 'paused — provider overloaded · resumes by itself when the provider answers', pause.pauseStatusWords(row, 0))
  check('the pause decodes off the wire with its new reason', pause.decodeAgentPause({ why: 'provider overloaded', words }) !== null && pause.decodeAgentPause({ why: 'provider jammed', words }) === null)
  check("the parent's line names the pause, the provider, the kept work and the probing, and shouts no error", line === 'Agent "lane" paused — Fable 5.1 is overloaded (HTTP 529); its work so far is kept and rides below; Mercury probes the provider for up to 1h and resumes the agent by itself when it answers — a message resumes it sooner; the crew view stops it' && !/error|failed/i.test(line.replace('HTTP 529', '')), line)
  check('the resume note tells the agent why it is back and what stands', overload.AGENT_OVERLOAD_RESUME_NOTE.includes('resumed by yourself after it was overloaded') && overload.AGENT_OVERLOAD_RESUME_NOTE.includes('do not redo it'))
}

section('§5 the seams, by their text')
{
  const utils = readFileSync('src/tools/AgentTool/agentToolUtils.ts', 'utf8')
  const task = readFileSync('src/tasks/LocalAgentTask/LocalAgentTask.tsx', 'utf8')
  check("the lifecycle's notice is gated on the episode's relay rule and a paused lane's notice carries the word paused", utils.includes('const notifies = overloadEpisode === null || overloadDeathNotifies(overloadEpisode)') && utils.includes("statusWord: 'paused'"))
  check('the notice writes the caller\'s status word into the status element', task.includes('${args.statusWord ?? args.status}'))
  check('the probe-driven resume writes no receipt row of its own', !utils.includes('the provider is answering again after its overload; its partial work carried forward'))
  check("the completed and the stopped exits close the lane's episode", utils.split('closeOverloadEpisode(taskId)').length >= 3)
}

section('§6 a typed overload budget cut takes the probe road without reading its words')
{
  const utils = await import('../../src/tools/AgentTool/agentToolUtils.ts')
  const classify = (utils as Record<string, unknown>).overloadBudgetCutOf as undefined | ((error: unknown, model: string) => { pause: { why: string } } | null)
  const cut = { recoveryBudgetSpent: true, message: 'arbitrary refusal words', lastStatus: 529, lastCause: 'a typed provider refusal', resumeAfterMs: 0, capMs: 1200, waits: 6 }
  check('a thrown 529 cut takes the overload pause independent of its text', classify?.(cut, 'claude-fable-5-1')?.pause.why === 'provider overloaded')
  check('529 in words alone does not turn another failure into an overload', classify !== undefined && classify({ ...cut, lastStatus: 429, message: 'API Error: 529' }, 'claude-fable-5-1') === null && classify(new Error('API Error: 529'), 'claude-fable-5-1') === null)
}

section('§7 a paused agent survives eviction until its probe can resume it')
{
  const framework = await import('../../src/utils/task/framework.ts')
  const utils = await import('../../src/tools/AgentTool/agentToolUtils.ts')
  const { resetCommandQueue } = await import('../../src/utils/messageQueueManager.ts')
  const store = { state: { tasks: {} as Record<string, Record<string, unknown>>, speculation: { status: 'idle' }, agentNameRegistry: new Map() } }
  const set = (update: (state: typeof store.state) => typeof store.state) => { store.state = update(store.state) }
  const sweep = async () => {
    const batch = await framework.generateTaskAttachments(store.state as never)
    framework.applyTaskOffsetsAndEvictions(set as never, batch.updatedTaskOffsets, batch.evictedTaskIds)
  }
  const paused = { why: 'provider overloaded', words: 'fixture paused' } as const
  const id = 'paused-sweep-background'
  const registered = lane.registerAsyncAgent({ agentId: id, description: 'paused fixture', prompt: 'work', setAppState: set as never })
  lane.failAgentTask(id, OVERLOADED_ROW, set as never, registered.abortController)
  lane.enqueueAgentNotification({ taskId: id, description: 'paused fixture', status: 'failed', statusWord: 'paused', summary: 'fixture paused', setAppState: set as never, controller: registered.abortController })
  process.env.MERCURY_OVERLOAD_PROBE_SCALE = '0.001'
  let probes = 0
  let resumed = 0
  let signalResume!: () => void
  const resumeReady = new Promise<void>(resolve => { signalResume = resolve })
  utils.armOverloadProbe({ taskId: id, description: 'paused fixture', registration: registered.abortController, rootSetAppState: set as never, toolUseContext: { options: { tools: [] } } as never, model: 'claude-fable-5-1', pause: paused, afterDeath: true, probe: async () => ++probes >= 2, resume: async () => { resumed++; signalResume() } })
  store.state.tasks[id]!.evictAfter = Date.now() - 1
  await sweep()
  check('the attachment sweep keeps the notified paused row past its old deadline', store.state.tasks[id]?.paused !== undefined)
  framework.evictTerminalTask(id, set as never)
  check('eager eviction also keeps the paused row', store.state.tasks[id]?.paused !== undefined)
  let wait!: ReturnType<typeof setTimeout>
  await Promise.race([resumeReady, new Promise<void>(resolve => { wait = setTimeout(resolve, 2000) })])
  clearTimeout(wait)
  check('the kept row reaches a second probe and resumes exactly once', probes === 2 && resumed === 1, JSON.stringify({ probes, resumed }))
  lane.unpauseAgentTask(id, set as never, registered.abortController)
  framework.evictTerminalTask(id, set as never)
  check('unpausing restores ordinary deadline eviction', store.state.tasks[id] === undefined)
  utils.closeOverloadEpisode(id)
  delete process.env.MERCURY_OVERLOAD_PROBE_SCALE

  const foregroundId = 'paused-sweep-foreground'
  const foreground = lane.registerAgentForeground({ agentId: foregroundId, description: 'handover fixture', prompt: 'work', setAppState: set as never })
  lane.failAgentTask(foregroundId, OVERLOADED_ROW, set as never, foreground.abortController)
  lane.enqueueAgentNotification({ taskId: foregroundId, description: 'handover fixture', status: 'failed', statusWord: 'paused', summary: 'fixture paused', setAppState: set as never, controller: foreground.abortController })
  lane.pauseAgentTask(foregroundId, paused, set as never, foreground.abortController)
  check('the handover fixture has no retain field', !('retain' in store.state.tasks[foregroundId]!))
  await sweep()
  check('a paused row with no retain field survives the sweep', store.state.tasks[foregroundId]?.paused !== undefined)
  lane.unpauseAgentTask(foregroundId, set as never, foreground.abortController)
  await sweep()
  check('the same unpaused retain-less row is evicted', store.state.tasks[foregroundId] === undefined)
  resetCommandQueue()
}

console.log(failures === 0 ? '\n✅ overload-episode-relay GREEN' : `\n❌ overload-episode-relay RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
