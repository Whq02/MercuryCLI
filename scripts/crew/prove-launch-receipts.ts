#!/usr/bin/env bun
// ============================================================================
//  scripts/crew/prove-launch-receipts.ts — a background agent's launch
//  receipt never stands alone: at a resume the runner pairs every receipt in
//  the transcript with a notice or a live record, and writes the death
//  notice for every orphan (the settled record the rail, the Crew view and
//  mercury://agent read, and the typed <task-notification> the model reads).
//
//    R1  the receipts: the Agent tool's background-launch results, by
//        tool-use id, with the agent id the receipt names
//    R2  the settled set: every id a <task-notification> row names
//    R3  the orphans: receipts with neither a notice nor a live record
//    R4  the reconciliation writes ONE settled (stopped) record and ONE
//        notice per orphan — idempotent against its own notice and against
//        a live record
//    R5  the notice's words: the tool-use id, the task id, the stop status,
//        the restart named
//    R6  the Inspect adapter's tail read is bounded by its cap, never by
//        the file
//    R7  the seams in source: both resume roads reconcile; the footer's
//        window owner is the focused chat's model; the receipt line is the
//        Agent tool's own
//
//  Run:  ~/.bun/bin/bun run scripts/crew/prove-launch-receipts.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'launch-receipts-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const lr = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const queue = await import('../../src/input-core/command-queue.ts')
const { readTailWindow, AGENT_TAIL_READ_CAP_BYTES } = await import('../../src/services/resources/adapters/agent.ts')
type Message = import('../../src/types/message.ts').Message
type AppState = import('../../src/state/AppStateStore.ts').AppState

// ── a transcript with two background launches, one of them settled ─────────
let n = 0
const stamp = (): string => new Date(1_700_000_000_000 + ++n * 1000).toISOString()
const assistantLaunch = (): Message =>
  ({
    type: 'assistant',
    uuid: `a-${++n}`,
    timestamp: stamp(),
    requestId: undefined,
    message: {
      id: 'msg_launch',
      model: 'claude-fable-5-1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'launching two' },
        { type: 'tool_use', id: 'toolu_one', name: 'Agent', input: { description: 'harbour-count', prompt: 'switch-seat: count the harbour', subagent_type: 'general-purpose', run_in_background: true } },
        { type: 'tool_use', id: 'toolu_two', name: 'Agent', input: { description: 'lantern-index', prompt: 'switch-seat: index the lanterns', subagent_type: 'general-purpose', run_in_background: true } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'tool_use',
    },
  }) as unknown as Message
const receiptText = (agentId: string): string =>
  `${lr.BACKGROUND_LAUNCH_LINE}\nagentId: ${agentId} (internal — do not mention it to the user). To continue this agent, use SendMessage addressed to that id.\nThe agent is working in the background — you will be notified automatically when it completes.`
const userReceipts = (): Message =>
  ({
    type: 'user',
    uuid: `u-${++n}`,
    timestamp: stamp(),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_one', content: [{ type: 'text', text: receiptText('agent-one') }] },
        { type: 'tool_result', tool_use_id: 'toolu_two', content: [{ type: 'text', text: receiptText('agent-two') }] },
      ],
    },
  }) as unknown as Message
const noticeRow = (toolUseId: string, taskId: string, status: string): Message =>
  ({
    type: 'user',
    uuid: `u-${++n}`,
    timestamp: stamp(),
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>Agent "x" ${status}</summary>\n</task-notification>`,
    },
  }) as unknown as Message
const foregroundPair = (): Message[] => [
  {
    type: 'assistant',
    uuid: `a-${++n}`,
    timestamp: stamp(),
    requestId: undefined,
    message: { id: 'msg_fg', model: 'claude-fable-5-1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'foreground-walk', prompt: 'walk', subagent_type: 'general-purpose' } }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'tool_use' },
  } as unknown as Message,
  {
    type: 'user',
    uuid: `u-${++n}`,
    timestamp: stamp(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: [{ type: 'text', text: 'the walk is done: three lanterns' }] }] },
  } as unknown as Message,
]

const transcript: Message[] = [assistantLaunch(), userReceipts(), ...foregroundPair(), noticeRow('toolu_two', 'agent-two', 'completed')]

console.log('============================================================')
console.log(' launch receipts — a receipt never stands without a record or a notice')
console.log('============================================================')

section('R1 · the receipts')
const receipts = lr.backgroundLaunchReceipts(transcript)
check('two background launches carry receipts, in order', receipts.length === 2 && receipts[0]!.toolUseId === 'toolu_one' && receipts[1]!.toolUseId === 'toolu_two', JSON.stringify(receipts))
check('each receipt names the agent id the tool result carried', receipts[0]?.agentId === 'agent-one' && receipts[1]?.agentId === 'agent-two')
check('each receipt carries the launch words: description, prompt, agent type, the launch clock', receipts[0]?.description === 'harbour-count' && receipts[0]?.prompt === 'switch-seat: count the harbour' && receipts[0]?.agentType === 'general-purpose' && Number.isFinite(receipts[0]?.launchedAt))
check('a foreground Agent result is not a launch receipt', !receipts.some(r => r.toolUseId === 'toolu_fg'))

section('R2 · the settled set')
const settled = lr.settledLaunchIds(transcript)
check('the notice settles its tool-use id and its task id', settled.has('toolu_two') && settled.has('agent-two') && !settled.has('toolu_one') && !settled.has('agent-one'))

section('R3 · the orphans')
const orphans = lr.orphanedBackgroundLaunches(transcript, new Set())
check('the launch without a notice or a record is the one orphan', orphans.length === 1 && orphans[0]!.agentId === 'agent-one', JSON.stringify(orphans))
check('a live record clears it', lr.orphanedBackgroundLaunches(transcript, new Set(['agent-one'])).length === 0)
check('a live record under the tool-use id clears it too', lr.orphanedBackgroundLaunches(transcript, new Set(['toolu_one'])).length === 0)

section('R4 · the reconciliation: one record, one notice, once')
let state: AppState = getDefaultAppState()
const getAppState = (): AppState => state
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}
queue.resetCommandQueue()
const before = Date.now()
const settledNow = lr.reconcileBackgroundLaunchesOnResume(transcript, getAppState, setAppState)
check('the orphan is settled', settledNow.length === 1 && settledNow[0]!.agentId === 'agent-one')
const record = (state.tasks as Record<string, { type?: string; status?: string; toolUseId?: string; isBackgrounded?: boolean; evictAfter?: number; notified?: boolean; description?: string; endTime?: number; agentType?: string; error?: string; retain?: boolean }>)['agent-one']
check('a settled record stands in the store under the agent id: local_agent · killed · backgrounded · its tool-use id', record !== undefined && record.type === 'local_agent' && record.status === 'killed' && record.toolUseId === 'toolu_one' && record.isBackgrounded === true && record.description === 'harbour-count', JSON.stringify(record))
check('the record settles through the panel grace (an eviction deadline in the future, the retain gate present) and names the restart', record !== undefined && (record.evictAfter ?? 0) > before && (record.endTime ?? 0) >= before && record.retain === false && record.error === 'stopped by a runner restart')
check('the record is marked notified — its notice went out', record?.notified === true)
check('the settled launch that already carried a notice got nothing', (state.tasks as Record<string, unknown>)['agent-two'] === undefined)
const queued = queue.getCommandQueue()
const notice = queued.find(cmd => cmd.mode === 'task-notification')
check('exactly one task-notification is queued for the model', queued.length === 1 && notice !== undefined, JSON.stringify(queued.map(c => c.mode)))

section('R5 · the notice the model reads')
const noticeText = typeof notice?.value === 'string' ? notice.value : ''
check('it carries the launch\'s tool-use id and the task id', noticeText.includes('<tool-use-id>toolu_one</tool-use-id>') && noticeText.includes('<task-id>agent-one</task-id>'))
check('its status is the stop word', noticeText.includes('<status>killed</status>'))
check('its summary names the agent, the stop and the restart, and asks for a relaunch only if wanted', noticeText.includes(`<summary>${lr.restartStopSummary('harbour-count')}</summary>`) && /runner restarted before it finished/.test(noticeText) && /relaunch it if the result is still wanted/.test(noticeText))

section('R4b · idempotence')
const again = lr.reconcileBackgroundLaunchesOnResume(transcript, getAppState, setAppState)
check('a second pass with the record live settles nothing more', again.length === 0 && queue.getCommandQueue().length === 1)
queue.resetCommandQueue()
let fresh: AppState = getDefaultAppState()
const withNotice = [...transcript, noticeRow('toolu_one', 'agent-one', 'killed')]
const afterNotice = lr.reconcileBackgroundLaunchesOnResume(withNotice, () => fresh, u => { fresh = u(fresh) })
check('a later resume that finds the notice in the transcript settles nothing (the notice is the pairing)', afterNotice.length === 0 && queue.getCommandQueue().length === 0 && Object.keys(fresh.tasks).length === 0)

section('R6 · the Inspect adapter reads a bounded tail')
const small = join(scratch, 'small.output')
writeFileSync(small, 'one\ntwo\nthree\n')
const whole = readTailWindow(small)
check('a file under the cap is read whole', whole.text === 'one\ntwo\nthree\n' && whole.cut === false && whole.total === 14)
const big = join(scratch, 'big.output')
const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`)
writeFileSync(big, lines.join('\n') + '\n')
const tail = readTailWindow(big, 500)
check('a file over the cap is cut to the tail window, at a line boundary, with the total named', tail.cut === true && tail.total === lines.join('\n').length + 1 && tail.text.length <= 500 && tail.text.startsWith('line ') && tail.text.endsWith('\n'), JSON.stringify({ len: tail.text.length, head: tail.text.slice(0, 12) }))
check('the tail window ends with the stream\'s last line', tail.text.trimEnd().endsWith(lines[lines.length - 1]!))
check('the cap is half a megabyte', AGENT_TAIL_READ_CAP_BYTES === 512 * 1024)

section('R7 · the seams in source')
const print = src('src/cli/print.ts')
check('the runner reconciles inside the one resume closure both roads share', /const \{ reconcileBackgroundLaunchesOnResume \} = await import\('\.\.\/tasks\/LocalAgentTask\/launchReceipts\.js'\)/.test(print) && /reconcileBackgroundLaunchesOnResume\(messages, getAppState, setAppState\)/.test(print))
check('…the cold road (--continue/--resume) and the warm claim (resume: true) both run it', /if \(options\.continue \|\| options\.resume\) await hydrateResumedRun\(\)/.test(print) && /if \(request\.resume === true\) await hydrateResumedRun\(\)/.test(print))
const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
check('the receipt line is the Agent tool\'s own first line', agentTool.includes(`'${lr.BACKGROUND_LAUNCH_LINE}',`))
const adapter = src('src/services/resources/adapters/agent.ts')
check('the detail view reads through the bounded tail window, never the whole file', /const window = readTailWindow\(contentPath\)/.test(adapter) && !/readFileSync\(contentPath/.test(adapter))
const footer = src('src/components/PromptInput/Notifications.tsx')
check('the footer\'s model is the focused chat\'s effective model (the band\'s window owner), never the screen\'s own slot', /getFocusedSessionConnector\(\)\.modelFacts\(\)\.effective/.test(footer) && /useSyncExternalStore\(subscribeFocusedModel, getFocusedModel, getFocusedModel\)/.test(footer) && !/state\.mainLoopModel/.test(footer))
const local = src('src/tasks/LocalAgentTask/LocalAgentTask.tsx')
check('the notification owner accepts the caller\'s truer summary', /summary\?: string/.test(local) && /args\.summary \?\?/.test(local))

console.log(failures === 0 ? '\nprove-launch-receipts: ALL LAWS HOLD' : `\nprove-launch-receipts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
