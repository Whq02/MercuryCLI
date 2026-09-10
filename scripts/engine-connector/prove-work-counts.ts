#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { runnerRecordAlive, workChipLine, workCounts, workRowRuns, workWaitingWords } from '../../src/services/engine-connector/workCounts.ts'
import { rosterRowsOf } from '../../src/components/tasks/BackgroundTasksDialog.tsx'
import { projectWorkRoster } from '../../src/utils/task/workRoster.ts'
import { compactWorkCounts, compactWorkSummaryText } from '../../src/components/tasks/useFocusedWork.ts'
import type { WorkRowV1 } from '../../src/services/engine-connector/types.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const t0 = 1_000_000_000_000

console.log('— C1 the counting law —')
{
  check('C1 running counts', workRowRuns({ id: 'x', kind: 'agent', name: 'a', status: 'running', startTime: t0 }))
  check('C1 pending counts (queued motion)', workRowRuns({ id: 'x', kind: 'workflow', name: 'w', status: 'pending', startTime: t0 }))
  check('C1 paused never counts (spins nothing)', !workRowRuns({ id: 'x', kind: 'workflow', name: 'w', status: 'paused', startTime: t0 }))
  check('C1 settled never counts', !workRowRuns({ id: 'x', kind: 'agent', name: 'a', status: 'completed', startTime: t0 }))
}

console.log('— C2/C3 one fixture, three surfaces, zero diffs —')
{
  const store = {
    wf1: {
      id: 'wf1', type: 'local_workflow', status: 'running', description: 'live run',
      startTime: t0, outputFile: '/n', outputOffset: 0, notified: false,
      script: 's', prompt: 's', workflowName: 'live-run', workflowRunId: 'r1',
      workflowProgress: [], progressVersion: 0, agentCount: 1, totalTokens: 0,
      totalToolCalls: 0, logs: [], retain: false,
      pendingPermissions: new Map([['tu', {} as never]]),
    },
    wf2: {
      id: 'wf2', type: 'local_workflow', status: 'paused', description: 'paused run',
      startTime: t0 + 1, outputFile: '/n', outputOffset: 0, notified: false,
      script: 's', prompt: 's', workflowName: 'paused-run', workflowRunId: 'r2',
      workflowProgress: [], progressVersion: 0, agentCount: 0, totalTokens: 0,
      totalToolCalls: 0, logs: [], retain: false,
    },
    ag1: {
      id: 'ag1', type: 'local_agent', status: 'running', description: 'the dispatched helper',
      agentId: 'ag1', prompt: 'p', agentType: 'mercury-general', isBackgrounded: true,
      startTime: t0 + 2, outputFile: '/n', outputOffset: 0, notified: false,
    },
    ag2: {
      id: 'ag2', type: 'local_agent', status: 'running', description: 'the helper\'s nested spawn',
      agentId: 'ag2', prompt: 'p', agentType: 'mercury-general', isBackgrounded: true,
      startTime: t0 + 3, outputFile: '/n', outputOffset: 0, notified: false,
    },
    ag3: {
      id: 'ag3', type: 'local_agent', status: 'completed', description: 'yesterday\'s helper',
      agentId: 'ag3', prompt: 'p', agentType: 'mercury-general', isBackgrounded: true,
      startTime: t0 + 4, outputFile: '/n', outputOffset: 0, notified: false,
    },
    main1: {
      id: 'main1', type: 'local_agent', status: 'running', description: 'the session itself',
      agentId: 'main1', prompt: 'p', agentType: 'main-session', isBackgrounded: true,
      startTime: t0 + 5, outputFile: '/n', outputOffset: 0, notified: false,
    },
    tm1: {
      id: 'tm1', type: 'in_process_teammate', status: 'running', description: 't',
      identity: { agentId: 'scout@crew', agentName: 'scout', teamName: 'crew' },
      prompt: 'p', awaitingPlanApproval: false,
      startTime: t0 + 6, outputFile: '/n', outputOffset: 0, notified: false,
    },
    sh1: {
      id: 'sh1', type: 'local_bash', status: 'running', description: 'sh',
      command: 'sleep 1', completionStatusSentInAttachment: false, shellCommand: null,
      lastReportedTotalLines: 0, startTime: t0 + 7, outputFile: '/n', outputOffset: 0, notified: false,
    },
  } as never

  const rows: WorkRowV1[] = projectWorkRoster(store)

  const counts = workCounts(rows)
  const chip = workChipLine(counts)

  const boardAgentsRunning = rosterRowsOf(rows, 'agent').filter(workRowRuns).length
  const boardWorkflowsRunning = rosterRowsOf(rows, 'workflow').filter(workRowRuns).length
  const boardTeammatesRunning = rosterRowsOf(rows, 'teammate').filter(workRowRuns).length

  const agentsViewRows = rosterRowsOf(rows, 'agent').filter(workRowRuns)

  check('C3 nested included: BOTH agent rows count (and the main-thread row never)', counts.agents === 2, `agents=${counts.agents}`)
  check('C2 chip == /tasks (agents)', counts.agents === boardAgentsRunning, `${counts.agents} vs ${boardAgentsRunning}`)
  check('C2 chip == agents view', counts.agents === agentsViewRows.length, `${counts.agents} vs ${agentsViewRows.length}`)
  check('C2 chip == /tasks (workflows) — the paused run never counts', counts.workflows === 1 && counts.workflows === boardWorkflowsRunning, `${counts.workflows} vs ${boardWorkflowsRunning}`)
  check('C2 chip == /tasks (teammates)', counts.teammates === 1 && counts.teammates === boardTeammatesRunning, `${counts.teammates} vs ${boardTeammatesRunning}`)
  check('C2 the shells count', counts.shells === 1, `shells=${counts.shells}`)
  check('C2 the parked ask rides the counts', counts.asks === 1, `asks=${counts.asks}`)
  check(
    'C2 the chip line speaks the board vocabulary',
    chip === '1 workflow · 2 agents · 1 named agent · 1 shell · 1 ask',
    chip ?? 'null',
  )
  check('C3 the settled agent is LISTED by the board but never counted', rosterRowsOf(rows, 'agent').length === 3 && boardAgentsRunning === 2)
}

console.log('— C4 zero-work honesty —')
{
  const counts = workCounts([])
  check('C4 an idle roster counts zero everywhere', counts.workflows === 0 && counts.agents === 0 && counts.teammates === 0 && counts.shells === 0 && counts.asks === 0)
  check('C4 the idle chip is NULL — no chip, no noise', workChipLine(counts) === null)
}

console.log('— C5 the runner-liveness law —')
{
  const deadPids = (): boolean => false
  const livePids = (): boolean => true
  check('C5 an ended record is never live', !runnerRecordAlive({ endedAt: 1, pid: 4242 }, livePids))
  check('C5 a crash-kept record (un-ended, its pid dead) is NOT live — the board keeps the row, the engine is gone', !runnerRecordAlive({ pid: 4242 }, deadPids))
  check('C5 an attached record is live though its child died by design', runnerRecordAlive({ attachedAt: 1, pid: 4242 }, deadPids))
  check('C5 an un-ended record with a live pid is live', runnerRecordAlive({ pid: 4242 }, livePids))
  check('C5 an un-ended record with no pid yet is not live', !runnerRecordAlive({}, livePids))
}

console.log('— C6 one spelling —')
{
  const seat = readFileSync('src/daemon/sessionSeat.ts', 'utf8')
  check("C6 the seat's work poll rides workRowRuns", seat.includes('.some(workRowRuns)'))
  check('C6 …and keeps no private running/pending test', !seat.includes("r => r.status === 'running' || r.status === 'pending'"))
}

console.log('\nC7 the held turn\'s wait words name the KINDS over the same counts')
{
  const counts = (over: Partial<ReturnType<typeof workCounts>>): ReturnType<typeof workCounts> => ({ workflows: 0, agents: 0, teammates: 0, shells: 0, asks: 0, ...over })
  check('C7 a workflow is a workflow, never an agent', workWaitingWords(counts({ workflows: 1 })) === 'waiting on 1 workflow')
  check('C7 a workflow beside two agents', workWaitingWords(counts({ workflows: 1, agents: 2 })) === 'waiting on 1 workflow · 2 agents')
  check('C7 a background shell is a shell', workWaitingWords(counts({ shells: 1 })) === 'waiting on 1 shell')
  check('C7 a parked ask rides the words', workWaitingWords(counts({ agents: 1, asks: 1 })) === 'waiting on 1 agent · 1 ask')
  check('C7 nothing running answers null (the count\'s own words stand)', workWaitingWords(counts({})) === null)
  const read = (rel: string): string => readFileSync(rel, 'utf8')
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check("C7 the connector counts the wait's kinds over the runner's roster (the same facts read)", connector.includes("phase === 'waiting' ? workCounts(this.facts?.work ?? [])"))
  const tagBar = read('src/components/SwitchboardTagBar.tsx')
  const repl = read('src/screens/REPL.tsx')
  check('C7 the status strip and the working strip spell the kinds first, the bare count second', tagBar.includes('workWaitingWords(live.waitingOn)') && tagBar.includes('crewWaitingWords(live.agentsWaiting)') && repl.includes('workWaitingWords(seatLive.waitingOn)') && repl.includes('crewWaitingWords(seatLive.agentsWaiting)'))
  const views = readFileSync('src/components/tasks/useFocusedWork.ts', 'utf8')
  check("C6 the work views' presence rides the runner-liveness law", views.includes('runnerRecordAlive(rec, pidAlive)'))
  check('C6 …and trusts endedAt alone nowhere', !views.includes('rec.sessionId === sessionId && rec.endedAt === undefined'))
}

console.log('C8 compact counts use current identities and honest availability')
{
  const active = { sessionId: 'focused', live: true, paused: false, parked: false, stopped: false }
  const sessions = { state: 'known' as const, rows: [active, active, { ...active, sessionId: 'paused', paused: true }, { ...active, sessionId: 'parked', parked: true }, { ...active, sessionId: 'dead', live: false }] }
  const tasks = {
    monitor: { id: 'monitor', type: 'local_bash', kind: 'monitor', command: 'fixture-monitor', status: 'running', startTime: t0 },
    shell: { id: 'shell', type: 'local_bash', command: 'fixture-shell', status: 'running', startTime: t0 },
    agent: { id: 'task-agent', agentId: 'child-one', type: 'local_agent', agentType: 'mercury-general', description: 'same name', status: 'running', startTime: t0 },
    paused: { id: 'paused-agent', agentId: 'paused-agent', type: 'local_agent', agentType: 'mercury-general', description: 'same name', status: 'running', startTime: t0, paused: { why: 'usage-window', words: 'paused' } },
    workflow: { id: 'workflow', type: 'local_workflow', status: 'running', startTime: t0, workflowRunId: 'run', agentCount: 20, totalTokens: 0, workflowProgress: [
      { type: 'workflow_agent', index: 0, label: 'same name', state: 'progress', agentId: 'child-one' },
      { type: 'workflow_agent', index: 1, label: 'same name', state: 'progress', agentId: 'child-two' },
      { type: 'workflow_agent', index: 2, label: 'pause', state: 'progress', agentId: 'child-three', waiting: 'operator', pausedBy: 'operator' },
      { type: 'workflow_agent', index: 3, label: 'done', state: 'done', agentId: 'child-four' },
    ] },
  } as never
  const rows = projectWorkRoster(tasks)
  const roster = { rows, mission: [], reported: true }
  const input = { sessions, focusedSessionId: 'focused', carrier: 'daemon' as const, roster, tasks }
  const counts = compactWorkCounts(input)
  check('C8 session records are deduplicated and dead/paused/parked sessions excluded', counts.sessionsOn === 1, JSON.stringify(counts))
  check('C8 the actual monitor subtype counts but an ordinary shell does not', counts.monitorsHere === 1 && rows.find(r => r.id === 'monitor')?.kind === 'monitor' && workCounts(rows).shells === 2)
  check('C8 two current workflow children count once each, not lifetime twenty or a duplicate top-level alias', counts.agentsHere === 2, JSON.stringify(counts))
  const children = rows.find(r => r.kind === 'workflow')?.phases?.flatMap(p => p.agents) ?? []
  check('C8 the projection preserves identity and explicit pause/wait absence', children.some(c => c.agentId === 'child-one' && c.waiting === null && c.pausedBy === null) && children.some(c => c.agentId === 'child-three' && c.waiting === 'operator'))
  check('C8 a hosted chat does not inherit the screen process task store', compactWorkCounts({ ...input, roster: { rows: [], mission: [], reported: true } }).agentsHere === 0)
  check('C8 an unreported live roster is unknown, not zero', compactWorkCounts({ ...input, roster: { rows: [], mission: [], reported: false } }).agentsHere === null)
  check('C8 unavailable session data stays unknown', compactWorkCounts({ ...input, sessions: { state: 'unavailable' } }).sessionsOn === null)
  check('C8 known dormant work is history, not active work', compactWorkCounts({ ...input, sessions: { state: 'known', rows: [{ ...active, live: false }] } }).agentsHere === 0)
  check('C8 a newly focused session absent from an older snapshot is not an observed idle roster', compactWorkCounts({ ...input, sessions: { state: 'known', rows: [] } }).agentsHere === null)
  check('C8 an in-process focused session counts once without a daemon row', compactWorkCounts({ ...input, carrier: 'in-process', sessions: { state: 'known', rows: [] } }).sessionsOn === 1)
  const legacyRows: WorkRowV1[] = [{ id: 'old', kind: 'workflow', name: 'old', status: 'running', startTime: t0, phases: [{ title: 'old', planned: false, agents: [{ index: 0, label: 'old', state: 'progress' }] }] }]
  check('C8 an old child projection without pause truth is unknown', compactWorkCounts({ ...input, roster: { ...roster, rows: legacyRows } }).agentsHere === null)
  const full = compactWorkSummaryText(counts, 120)
  check('C8 full words retain scope and count truth', full === '1 session on · 1 monitor here · 2 agents here', full)
  check('C8 no partial integer can turn twelve into one', !compactWorkSummaryText({ sessionsOn: 12, agentsHere: 12, monitorsHere: 12 }, 3).includes('1'))
  check('C8 unavailable counts are explicitly unavailable, never question marks or invented zero', compactWorkSummaryText({ sessionsOn: null, agentsHere: null, monitorsHere: null }, 120) === 'counts unavailable')
  check('C8 known numeric counts remain visible beside unavailable data', compactWorkSummaryText({ sessionsOn: 1, agentsHere: null, monitorsHere: null }, 120) === '1 session on · counts unavailable')
  check('C8 an observed empty focused roster renders actual zeros', compactWorkSummaryText(compactWorkCounts({ ...input, roster: { rows: [], mission: [], reported: true } }), 80) === '1 session on · 0 monitors here · 0 agents here')
}

console.log(failures === 0 ? '\nprove-work-counts: ALL LAWS HOLD' : `\nprove-work-counts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
