#!/usr/bin/env bun
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'connector-contract-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const where = 'the doors and the focused slot are NoSessionConnector in src/engine/connector/noSessionConnector.ts, DaemonSessionConnector in src/engine/connector/daemonConnector.ts and src/engine/connector/focusedConnector.ts: add or change the door there, or update DOORS in this file if the connector contract moved'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ` — ${where}`}`)
}

const DOORS = [
  'sessionId',
  'sendWords',
  'records',
  'subscribeRecords',
  'turnActive',
  'asks',
  'subscribeAsks',
  'answerAsk',
  'settleAsk',
  'interrupt',
  'modelFacts',
  'subscribeModel',
  'setModel',
  'setEffort',
  'usage',
  'identity',
  'skillsRoster',
  'mcpRoster',
  'mcpAction',
  'mcpTools',
  'workRoster',
  'subscribeWork',
  'permissionMode',
  'subscribePermissionMode',
  'setPermissionMode',
  'workspace',
  'dispatchSlash',
  'sendAgentNote',
  'stopAgent',
  'resumeAgent',
  'backgroundShell',
  'sendNow',
  'queuedSendCount',
  'pauseGate',
  'postBoard',
  'leave',
  'setKit',
  'checkpointFacts',
  'subscribeCheckpoints',
  'rewind',
  'spawnSwitches',
  'setSpawnSwitch',
  'recallableSend',
  'withdrawSend',
  'advisorFacts',
] as const


{
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
  const { getFocusedSessionConnector, hasFocusedSession, releaseFocusedSessionConnector, setFocusedSessionConnector } = await import(
    '../../src/engine/connector/focusedConnector.ts'
  )
  const resting = new NoSessionConnector()
  const seat = new DaemonSessionConnector({
    sessionId: '00000000-0000-4000-8000-000000000001',
    runnerId: 'concourse-w1',
    title: 'census',
    projectLabel: 'scratch',
    workspaceId: '/scratch/nowhere',
    home: process.env.MERCURY_CONFIG_DIR!,
  })
  for (const door of DOORS) {
    check(`the resting slot answers ${door}`, typeof (resting as unknown as Record<string, unknown>)[door] === 'function')
    check(`the daemon-hosted session answers ${door}`, typeof (seat as unknown as Record<string, unknown>)[door] === 'function')
  }
  check("both carriers read 'daemon' — one kind of session", resting.carrier === 'daemon' && seat.carrier === 'daemon')
  const restingTools = await resting.mcpTools('runpod')
  const { NO_CHAT_OPEN } = await import('../../src/engine/connector/noSessionConnector.ts')
  check('the resting MCP tools door says why it lists nothing (unavailable, the one no-chat sentence)', restingTools.state === 'unavailable' && restingTools.detail === NO_CHAT_OPEN)
  const boot = getFocusedSessionConnector()
  check('the focused slot rests on no session (no chat behind the boot menu)', !hasFocusedSession() && boot instanceof NoSessionConnector && boot.sessionId() === '')
  check('the resting slot owns no records and no turn', boot.records().length === 0 && boot.turnActive() === false)
  setFocusedSessionConnector(seat)
  check('handing the slot a session re-points it', getFocusedSessionConnector() === seat && hasFocusedSession())
  releaseFocusedSessionConnector()
  check('closing the chat rests the slot', !hasFocusedSession() && getFocusedSessionConnector() instanceof NoSessionConnector)
}

console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
