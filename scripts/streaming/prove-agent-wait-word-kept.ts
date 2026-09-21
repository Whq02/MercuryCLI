#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'agent-wait-word-'))
const CONFIG = join(HOME, 'config')
const DAEMON_DIR = join(HOME, 'daemon')
const PROJECT = join(HOME, 'project')
mkdirSync(CONFIG, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
process.env.MERCURY_CONFIG_DIR = CONFIG
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { publishSessionFacts, publishSessionTail, readSessionFacts, readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')

const SID = '00000000-aaaa-bbbb-cccc-000000000601'
const base = (extra: Record<string, unknown>) => ({
  isSidechain: false, entrypoint: 'cli',
  cwd: PROJECT, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})
const rows = [
  base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000021',
    message: { role: 'user', content: 'spawn an agent and wait for it' },
    timestamp: '2026-06-19T12:00:01.000Z' }),
  base({ parentUuid: '00000000-0000-4000-8000-000000000021', type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000022', requestId: 'req_wait_1',
    message: { id: 'msg_wait_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'the agent is running; I will wait for it.' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    timestamp: '2026-06-19T12:00:02.000Z' }),
]
writeFileSync(join(PROJECT, `${SID}.jsonl`), encodeSeedTranscript(rows, SID))
const record = { sessionId: SID, runnerId: 'concourse-w1', title: 'agent-wait', projectLabel: 'scratch', workspaceId: PROJECT, home: PROJECT }

const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return cond()
}
const facts = (busy: boolean) => ({
  schema: 1 as const, sessionId: SID, atMs: Date.now(),
  model: { effective: 'claude-opus-4-8', setting: null },
  usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [], mcp: [], permissionMode: 'default' as const,
  workspace: { cwd: PROJECT, originalCwd: PROJECT, projectRoot: PROJECT, instructionRoots: [] },
  queue: [], pendingModel: null, busy,
})
const tail = (word: 'waiting-on-agents' | null, atMs: number) => ({
  schema: 1 as const, sessionId: SID, atMs, text: null,
  ...(word !== null ? { stateWord: word, waitingOnAgents: 1 } : {}),
})

section('§1 the wait word read AHEAD of the busy edge is kept: the turn paints the wait, never the thinking dress')
{
  publishSessionFacts(facts(false) as never, DAEMON_DIR)
  await until(() => (readSessionFacts(SID, DAEMON_DIR) as { busy?: boolean } | null)?.busy === false)
  const seat = new DaemonSessionConnector(record as never)
  await seat.attach()
  check('the seat opens idle (the control)', seat.live().inFlight === false && seat.live().phase === 'idle', j(seat.live()))
  const t1 = Date.now()
  publishSessionTail(tail('waiting-on-agents', t1) as never, DAEMON_DIR)
  const tailRead = await until(() => (readSessionTail(SID, DAEMON_DIR) as { atMs?: number } | null)?.atMs === t1)
  check('the tail projection landed with the wait word (fixture plumbing)', tailRead)
  await new Promise(r => setTimeout(r, 400))
  check('the word arriving on an idle read paints nothing yet (the facts have not said busy)', seat.live().inFlight === false, j(seat.live()))
  publishSessionFacts(facts(true) as never, DAEMON_DIR)
  const waiting = await until(() => seat.live().inFlight === true && seat.live().phase === 'waiting')
  check('THE DEFECT PIN: once the facts say busy the phase is the wait, with its count — the word read a moment early was not thrown away', waiting && seat.live().agentsWaiting === 1, j({ inFlight: seat.live().inFlight, phase: seat.live().phase, agentsWaiting: seat.live().agentsWaiting }))
  seat.detach()
}

section('§2 the word still rests with the turn: the runner clearing it, or the turn settling, ends the wait')
{
  const seat = new DaemonSessionConnector(record as never)
  await seat.attach()
  const waiting = await until(() => seat.live().inFlight === true && seat.live().phase === 'waiting')
  check('a fresh attach over a busy seat with the word reads the wait', waiting, j(seat.live()))
  const t2 = Date.now() + 1
  publishSessionTail(tail(null, t2) as never, DAEMON_DIR)
  const cleared = await until(() => seat.live().inFlight === true && seat.live().phase !== 'waiting')
  check('the runner clearing the word ends the wait while the turn runs on', cleared, j(seat.live()))
  const t3 = Date.now() + 2
  publishSessionTail(tail('waiting-on-agents', t3) as never, DAEMON_DIR)
  const again = await until(() => seat.live().phase === 'waiting')
  check('the word said again while busy paints the wait again', again, j(seat.live()))
  publishSessionFacts(facts(false) as never, DAEMON_DIR)
  const idle = await until(() => seat.live().inFlight === false)
  check('the turn settling rests the live view', idle && seat.live().phase === 'idle' && seat.live().agentsWaiting === 0, j(seat.live()))
  publishSessionFacts(facts(true) as never, DAEMON_DIR)
  const next = await until(() => seat.live().inFlight === true)
  check('the next turn opens without the settled turn\'s word (it was cleared on the settle)', next && seat.live().phase !== 'waiting', j(seat.live()))
  seat.detach()
}

console.log(failures === 0 ? '\nprove-agent-wait-word-kept: ALL LAWS HOLD' : `\nprove-agent-wait-word-kept: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
