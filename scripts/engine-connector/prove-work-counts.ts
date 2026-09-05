#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { runnerRecordAlive, workChipLine, workCounts, workRowRuns, workWaitingWords } from '../../src/services/engine-connector/workCounts.ts'
import { rosterRowsOf } from '../../src/components/tasks/BackgroundTasksDialog.tsx'
import { projectWorkRoster } from '../../src/utils/task/workRoster.ts'
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
      agentId: 'ag1', prompt: 'p', agentType: 'general-purpose', isBackgrounded: true,
      startTime: t0 + 2, outputFile: '/n', outputOffset: 0, notified: false,
    },
    ag2: {
      id: 'ag2', type: 'local_agent', status: 'running', description: 'the helper\'s nested spawn',
      agentId: 'ag2', prompt: 'p', agentType: 'general-purpose', isBackgrounded: true,
      startTime: t0 + 3, outputFile: '/n', outputOffset: 0, notified: false,
    },
    ag3: {
      id: 'ag3', type: 'local_agent', status: 'completed', description: 'yesterday\'s helper',
      agentId: 'ag3', prompt: 'p', agentType: 'general-purpose', isBackgrounded: true,
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

console.log(failures === 0 ? '\nprove-work-counts: ALL LAWS HOLD' : `\nprove-work-counts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
