#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_HOME', 'GOOGLE_API_KEY']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-roster-pure-'))

const ROOT = join(import.meta.dir, '..', '..')
const FIXTURE_PORT = Number(process.env.COMPACT_ROSTER_PURE_PORT ?? 34123)

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — compact roster proofs exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getAgentRosterAttachment, queuedNoticeTaskIds } = await import('../../src/utils/attachments/agentRoster.ts')
const { createTaskStateBase } = await import('../../src/Task.ts')
const { getTaskOutputPath } = await import('../../src/utils/task/diskOutput.ts')
const { seatWaitWords } = await import('../../src/services/capacity/seatWords.ts')
const { buildResumePrompt } = await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { NULL_RENDERING_ATTACHMENT_TYPES, isNullRenderingAttachment } = await import('../../src/components/messages/nullRenderingAttachments.ts')
const { getCompactPrompt, getPartialCompactPrompt } = await import('../../src/services/compact/prompt.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')

type AnyTask = Record<string, unknown>
const now = Date.now()
const base = (id: string, type: string, description: string, over: AnyTask = {}): AnyTask => ({
  ...createTaskStateBase(id, type as never, description),
  status: 'running',
  startTime: now - 10_000,
  ...over,
})

const SEAT_SENTENCE = seatWaitWords({ width: 2, holders: ['the chat', 'plain-survey'], narrowing: null })
const OWN_ID = 'aownfold1'
const WF_RUNNING = 'local_workflow_run1'
const WF_PAUSED = 'local_workflow_run2'
const workflowEvents = [
  { type: 'workflow_phase', index: 0, title: 'Survey' },
  { type: 'workflow_agent', index: 0, label: 'wf-one', state: 'progress', phaseIndex: 0, phaseTitle: 'Survey', startedAt: now - 8000, lastProgressAt: now - 1000, lastToolName: 'Read', lastToolSummary: 'notes.txt' },
  { type: 'workflow_agent', index: 1, label: 'wf-two', state: 'start', phaseIndex: 0, phaseTitle: 'Survey', queuedAt: now - 8000, waitWords: SEAT_SENTENCE },
]
const store: Record<string, AnyTask> = {
  [WF_RUNNING]: base(WF_RUNNING, 'local_workflow', 'two agents survey the stations', {
    script: 'x', prompt: 'x', workflowName: 'roster-survey', summary: 'two agents survey the stations', workflowRunId: 'run1', workflowProgress: workflowEvents, progressVersion: 3, agentCount: 2, totalTokens: 0, totalToolCalls: 0, logs: [], retain: false, scriptPath: '/w/roster-survey.js', pendingPermissions: new Map([['tu1', {}]]),
  }),
  [WF_PAUSED]: base(WF_PAUSED, 'local_workflow', 'a paused survey', {
    status: 'paused', script: 'x', prompt: 'x', workflowName: 'paused-survey', workflowRunId: 'run2', workflowProgress: [], progressVersion: 0, agentCount: 1, totalTokens: 0, totalToolCalls: 0, logs: [], retain: false, scriptPath: '/w/paused-survey.js', args: { n: 1 },
  }),
  aplain001: base('aplain001', 'local_agent', 'plain-survey', {
    agentId: 'aplain001', prompt: 'read the notes', agentType: 'general-purpose', isBackgrounded: true, pendingMessages: ['one', 'two'],
    progress: { toolUseCount: 3, tokenCount: 0, recentActivities: [], lastActivity: { toolName: 'Read', activityDescription: 'Read notes.txt' } },
  }),
  awaitseat: base('awaitseat', 'local_agent', 'seat-survey', {
    status: 'pending', agentId: 'awaitseat', prompt: 'x', agentType: 'general-purpose', isBackgrounded: true, wait: SEAT_SENTENCE,
  }),
  ascout001: base('ascout001', 'local_agent', 'scout the tree', {
    agentId: 'ascout001', prompt: 'x', agentType: 'Explore', isBackgrounded: true,
  }),
  adonequeued: base('adonequeued', 'local_agent', 'done-survey', {
    status: 'completed', agentId: 'adonequeued', prompt: 'x', agentType: 'general-purpose', isBackgrounded: true, notified: true, endTime: now - 2000,
  }),
  adonesent: base('adonesent', 'local_agent', 'delivered-survey', {
    status: 'completed', agentId: 'adonesent', prompt: 'x', agentType: 'general-purpose', isBackgrounded: true, notified: true, endTime: now - 60_000,
  }),
  afailed01: base('afailed01', 'local_agent', 'failed-survey', {
    status: 'failed', agentId: 'afailed01', prompt: 'x', agentType: 'general-purpose', isBackgrounded: true, notified: true, error: 'the seat declined', endTime: now - 3000,
  }),
  [OWN_ID]: base(OWN_ID, 'local_agent', 'the compacting agent itself', {
    agentId: OWN_ID, prompt: 'x', agentType: 'general-purpose', isBackgrounded: true,
  }),
  smain0001: base('smain0001', 'local_agent', 'the session itself', {
    agentId: 'smain0001', prompt: 'x', agentType: 'main-session', isBackgrounded: true,
  }),
  'harper@crew': base('harper@crew', 'in_process_teammate', 'harper', {
    identity: { agentId: 'harper@crew', agentName: 'harper', teamName: 'crew' }, prompt: 'x', awaitingPlanApproval: false, isIdle: false, shutdownRequested: false, pendingUserMessages: ['ping'],
  }),
  bshell001: base('bshell001', 'local_bash', 'roster-shell sleeps', {
    command: 'sleep 20', completionStatusSentInAttachment: false, shellCommand: null, lastReportedTotalLines: 0, isBackgrounded: true,
  }),
  mmon0001: base('mmon0001', 'monitor_mcp', 'watch the build server'),
}
const registry = new Map<string, string>([['scout', 'ascout001']])
const queue = [
  { mode: 'prompt', value: 'hello <task-id>notatask</task-id>' },
  { mode: 'task-notification', value: `<task-notification>\n<task-id>adonequeued</task-id>\n<status>completed</status>\n</task-notification>` },
  { mode: 'task-notification', value: [{ type: 'text', text: 'a block-array notice never carries a tag' }] },
]

section('§1 the builder — every kind rides ONE attachment, in the product\'s words')
const queuedIds = queuedNoticeTaskIds(queue as never)
const out = getAgentRosterAttachment({ tasks: store as never, agentNameRegistry: registry, excludeAgentId: OWN_ID, queuedNoticeIds: queuedIds, nowMs: now })
check('one attachment for the whole store', out.length === 1 && out[0]!.type === 'agent_roster', j(out.map(a => a.type)))
const rows = out[0]?.rows ?? []
const byId = new Map(rows.map(r => [r.taskId, r]))
console.log(`  rows: ${rows.map(r => `${r.taskType}:${r.name}:${r.status}`).join(' | ')}`)
check('every kind rides: the two workflows, six agents, the teammate, the shell, the monitor (11 rows)', rows.length === 11, String(rows.length))
check("the compacting agent's own row never rides", !byId.has(OWN_ID))
check("the session's own main thread never rides (the projector's law)", !byId.has('smain0001'))
check('running rows come first', rows.findIndex(r => !['running', 'waiting', 'pending'].includes(r.status)) > rows.filter(r => ['running', 'waiting', 'pending'].includes(r.status)).length - 1)

const wf = byId.get(WF_RUNNING)
check('the running workflow: its kind word, its name, the status word, its phase', wf?.taskType === 'local_workflow' && wf.name === 'roster-survey' && wf.status === 'running' && wf.phase === 'Survey', j(wf))
check("…its agents carry the run view's own pulse words (a working agent's tool line, a queued agent's seat sentence)", j(wf?.agents) === j([{ label: 'wf-one', state: 'Read(notes.txt)' }, { label: 'wf-two', state: SEAT_SENTENCE }]), j(wf?.agents))
check('…owed: its completion notification, and the parked ask', wf?.owed !== null && wf!.owed!.includes('task notification') && wf!.owed!.includes('1 permission ask parked'), wf?.owed ?? 'null')
check('…no message address (a workflow is reached by its task id), the output path', wf?.address === null && wf.outputFilePath === getTaskOutputPath(WF_RUNNING))
const paused = byId.get(WF_PAUSED)
check('the paused workflow reads paused and carries the pause road\'s own resume sentence', paused?.status === 'paused' && paused.owed === buildResumePrompt({ args: { n: 1 }, scriptPath: '/w/paused-survey.js', workflowRunId: 'run2' }), paused?.owed ?? 'null')

const plain = byId.get('aplain001')
check('the running sub-agent: kind local_agent, the crew word running, its id as the address, asked = its description', plain?.taskType === 'local_agent' && plain.status === 'running' && plain.address === 'aplain001' && plain.description === 'plain-survey', j(plain))
check('…owed: the notification law and its two queued messages', plain?.owed === 'its completion reaches you as a task notification — never re-spawn it; 2 messages queued for its next tool round', plain?.owed ?? 'null')
const waiting = byId.get('awaitseat')
check('a sub-agent queued for a seat reads waiting (the crew word) with the seat sentence', waiting?.status === 'waiting' && waiting.wait === SEAT_SENTENCE, j(waiting))
const scout = byId.get('ascout001')
check('a named launch answers to its name', scout?.address === 'scout' && scout.name === 'scout the tree')
const doneQueued = byId.get('adonequeued')
check('a landed agent whose notice sits in the queue reads landed and owed: the queued notice', doneQueued?.status === 'landed' && (doneQueued.owed ?? '').includes('already queued') && (doneQueued.owed ?? '').includes('never re-derive'), j(doneQueued))
const doneSent = byId.get('adonesent')
check('a landed agent whose notice was delivered owes nothing (its output path stands)', doneSent?.status === 'landed' && doneSent.owed === null && doneSent.outputFilePath === getTaskOutputPath('adonesent'))
const failed = byId.get('afailed01')
check('a failed agent reads failed with its error', failed?.status === 'failed' && failed.error === 'the seat declined')
const harper = byId.get('harper@crew')
check('a named agent (teammate): its name is its address, kind in_process_teammate, one pending message', harper?.taskType === 'in_process_teammate' && harper.address === 'harper' && harper.status === 'running' && harper.owed?.includes('1 message pending delivery') === true, j(harper))
const shell = byId.get('bshell001')
check('the background shell: kind local_bash, the command as its name, the description as what it was asked, no message address', shell?.taskType === 'local_bash' && shell.name === 'sleep 20' && shell.description === 'roster-shell sleeps' && shell.address === null && shell.status === 'running', j(shell))
const monitor = byId.get('mmon0001')
check('the monitor rides as monitor_mcp, running', monitor?.taskType === 'monitor_mcp' && monitor.status === 'running')
check('an empty store yields no attachment', getAgentRosterAttachment({ tasks: {}, nowMs: now }).length === 0)
check('a store holding only the compacting agent yields no attachment', getAgentRosterAttachment({ tasks: { [OWN_ID]: store[OWN_ID] } as never, excludeAgentId: OWN_ID, nowMs: now }).length === 0)

section('§2 the queued-notice census reads the notification road\'s own tag')
check('the task ids named by queued task notifications, and only those', j([...queuedIds]) === j(['adonequeued']), j([...queuedIds]))
check('an empty queue names nothing', queuedNoticeTaskIds([]).size === 0)

section('§3 the model-facing text and the null rendering')
const projected = normalizeAttachmentForAPI(out[0] as never)
check('the roster projects to ONE meta user row', projected.length === 1 && (projected[0] as { isMeta?: boolean }).isMeta === true, String(projected.length))
const text = typeof projected[0]?.message.content === 'string' ? projected[0].message.content : j(projected[0]?.message.content)
console.log(text.split('\n').map(l => `  │ ${l.slice(0, 160)}`).join('\n'))
check('…inside a system reminder, headed Agents in flight', text.startsWith('<system-reminder>') && text.includes('Agents in flight at the context turnover'))
check('…one line per row (11 lines)', text.split('\n').filter(l => l.startsWith('- ')).length === 11)
check('…the workflow line carries its phase and its agents with their pulse words', text.includes('local_workflow "roster-survey" [local_workflow_run1]: running · phase: Survey · agents: wf-one — Read(notes.txt), wf-two — ' + SEAT_SENTENCE))
check('…the sub-agent line names the SendMessage address and the output path', text.includes('reach it: SendMessage to "aplain001"') && text.includes(`output: ${getTaskOutputPath('aplain001')}`))
check('…the waiting row carries the seat sentence beside the word waiting', text.includes(`[awaitseat]: waiting · ${SEAT_SENTENCE}`))
check('…the shell line names TaskOutput and TaskStop as its doors', text.includes('local_bash "sleep 20" [bshell001]: running · asked: roster-shell sleeps') && text.includes('reach it: TaskOutput and TaskStop by its id'))
check('…the two laws close the roster', text.includes('A running agent is never re-spawned') && text.includes('never re-derived'))
check('an empty roster projects nothing', normalizeAttachmentForAPI({ type: 'agent_roster', rows: [] } as never).length === 0)
check('the roster is registered null-rendering (transcript-only, never painted)', (NULL_RENDERING_ATTACHMENT_TYPES as readonly string[]).includes('agent_roster') && isNullRenderingAttachment(createAttachmentMessage(out[0] as never) as never))

section('§4 the summary template carries the tenth section')
const NINE = [
  '1. Operator Intent: every explicit request, in detail.',
  '2. Technical Ground: technologies, patterns and frameworks in play.',
  '3. Files and Code Touched: files examined, modified or created — with particular attention to the most recent messages, full code snippets where applicable, and a note on why each file matters.',
  '4. Errors and Corrections: every error hit, how it was fixed, and any operator feedback about it.',
  '5. Problems Worked: problems solved and any ongoing troubleshooting.',
  '6. Operator Messages: every message the operator sent that is not a tool result.',
  '7. Open Work: work the operator explicitly asked for that is not yet done.',
  '8. Where Work Stands: precisely what was being worked on most recently, with file names and code snippets.',
  "9. Next Move (optional): the next step directly in line with the operator's most recent explicit request and the task in flight. Do not start tangential or already-completed work without confirming first. Include verbatim quotes from the most recent conversation showing exactly what task was in hand and where it stopped.",
]
const full = getCompactPrompt()
check('the full prompt asks for ten numbered sections', full.includes('these ten numbered sections'))
check('…the nine sections before the tenth are byte-identical', NINE.every(line => full.includes(line)))
check('…the tenth is Agents in flight: the address, what it was asked, what is owed', /10\. Agents in flight: every agent still running or owed a result at the turnover/.test(full) && full.includes('the SendMessage address') && full.includes('what is owed back'))
check('…with the two laws', full.includes('A running agent is never re-spawned; a pending result is collected, not re-derived.'))
check('…and the output example shows it', full.includes('10. Agents in flight:\n   [...]'))
const fromPrompt = getPartialCompactPrompt(undefined, 'from')
const upToPrompt = getPartialCompactPrompt(undefined, 'up_to')
check('the partial prompts carry the tenth section too (from, up_to)', /10\. Agents in flight/.test(fromPrompt) && /10\. Agents in flight/.test(upToPrompt) && upToPrompt.includes('these ten numbered sections'))
check('the from-prompt keeps its recent-messages scope', fromPrompt.includes('Summarise ONLY the recent portion'))

section('§5 every fold road hands the roster its context')
const smc = readFileSync(join(ROOT, 'src/services/compact/sessionMemoryCompact.ts'), 'utf8')
check('the session-memory strategy folds the roster in when its caller hands the context', smc.includes('createAsyncAgentAttachmentsIfNeeded(rosterContext'))
const autoSrc = readFileSync(join(ROOT, 'src/services/compact/autoCompact.ts'), 'utf8')
const cmdSrc = readFileSync(join(ROOT, 'src/commands/compact/compact.ts'), 'utf8')
const ladderSrc = readFileSync(join(ROOT, 'src/services/compact/maintenanceLadder.ts'), 'utf8')
check('the automatic road hands it', autoSrc.includes('trySessionMemoryCompaction(messages, toolUseContext.agentId, threshold, toolUseContext)'))
check('the /compact command hands it', cmdSrc.includes('trySessionMemoryCompaction(projected, context.agentId, undefined, context)'))
check("the ladder's notes rung hands it", /trySessionMemoryCompaction\)\(\n\s+input\.messages,\n\s+input\.toolUseContext\.agentId,\n\s+input\.recompactionInfo\.autoCompactThreshold,\n\s+input\.toolUseContext,/.test(ladderSrc))
const compactSrc = readFileSync(join(ROOT, 'src/services/compact/compact.ts'), 'utf8')
check('the summary fold assembles the roster through the one owner (assembleAttachments → createAsyncAgentAttachmentsIfNeeded → the roster builder)', compactSrc.includes('createAsyncAgentAttachmentsIfNeeded(context),') && compactSrc.includes('getAgentRosterAttachment({'))
check('no second announcer: the old per-task task_status road is gone from the fold', !compactSrc.includes("type: 'task_status'"))

section('§6 the direct lane — a real fold on an engine family carries the roster')
{
  const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
  const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT })
  Object.assign(process.env, fixture.env)
  const { compactConversation } = await import('../../src/services/compact/compact.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    denialTracking: undefined,
    tasks: { aplain001: store.aplain001, bshell001: store.bshell001, [WF_RUNNING]: store[WF_RUNNING] },
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
    options: {
      tools: [],
      mcpClients: [],
      mainLoopModel: 'gpt-5.5',
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
  const messages = [
    createUserMessage({ content: 'launch the survey' }),
    { type: 'assistant', uuid: '00000000-0000-4000-a000-00000000d0de', requestId: 'req_r1', message: { id: 'msg_r1', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'launched the survey and the shell' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } } },
    createUserMessage({ content: 'now wait for them' }),
  ]
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(messages as never, ctx as never, { systemPrompt: asSystemPrompt(['You are a fixture-driven session posture.']) } as never, true)) as never
  } catch (err) {
    error = err as Error
  }
  await fixture.close()
  const hits = fixture.captured.filter(h => h.path.endsWith('/responses'))
  check('the fold rode the OpenAI wire (the direct lane by admission)', hits.length >= 1 && fixture.captured.every(h => h.lane === 'openai-seat'), fixture.captured.map(h => `${h.lane} ${h.path}`).join(' | '))
  check('compactConversation resolved', result !== undefined && error === undefined, (error?.stack ?? '').slice(0, 400))
  const attachments = ((result?.attachments ?? []) as Array<{ attachment: { type: string; rows?: Array<{ name: string }> } }>)
  const rosters = attachments.filter(a => a.attachment.type === 'agent_roster')
  check("the result's attachments carry ONE roster", rosters.length === 1, j(attachments.map(a => a.attachment.type)))
  check('…naming the workflow, the sub-agent and the shell', j(rosters[0]?.attachment.rows?.map(r => r.name).sort()) === j(['plain-survey', 'roster-survey', 'sleep 20'].sort()), j(rosters[0]?.attachment.rows?.map(r => r.name)))
  check('…and no task_status row beside it (one announcer)', !attachments.some(a => a.attachment.type === 'task_status'))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ COMPACT ROSTER GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} COMPACT ROSTER FAILURE(S) (${checks} checks)`)
process.exit(1)
