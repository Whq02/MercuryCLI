#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-idle-tool-rows-rest.ts — in-progress tool-use ids
//  rest on the idle edge (FN-016 R5).
//
//  THE DEFECT: recomputeLive rested every other live artifact when the turn
//  went idle — the tail store, the live char count, the state word, the
//  ephemeral progress store — and passed inProgressToolUseIDs through RAW
//  from the records fold. That set comes from the transcript alone (every
//  unanswered tool_use id), so a session whose log ends in a tool_use with
//  no tool_result — a runner killed mid-tool, a quit or machine sleep
//  during a call, an interrupt whose synthetic settlement never reached
//  disk — resumed with a PERMANENTLY RUNNING tool row: loader animating,
//  elapsed tail counting up from the paint (not the tool's real start),
//  refusing to fold into its collapsed group, on a chat whose composer is
//  idle and whose working strip is gone.
//
//  THE LAW: the published live view's in-progress set is EMPTY whenever the
//  turn is idle (facts not busy, no send in flight), whatever the
//  transcript's last row looks like; a RUNNING turn's set flows through
//  untouched; and the records fold itself (liveTurnStateOf — the pulse's
//  driver) keeps its contract: it still reports the unresolved id raw. The
//  gate lives at the ONE publish point, beside the four artifacts that
//  already rest there.
//
//   §1 idle edge: unanswered tool_use in the log + no busy facts ⇒
//      live().inFlight false AND live().inProgressToolUseIDs EMPTY;
//   §2 running turn: busy facts ⇒ the same transcript's id FLOWS;
//   §3 the fold's own contract is untouched: liveTurnStateOf reports the
//      unresolved id (the gate is at the publish, not in the driver).
//
//  Run: ~/.bun/bin/bun run scripts/streaming/prove-idle-tool-rows-rest.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
void ROOT
const HOME = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'idle-tool-rest-'))
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
const { publishSessionFacts, readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
const { liveTurnStateOf } = await import('../../src/utils/conversationRecovery.ts')

// ── the transcript: a turn CUT MID-TOOL (tool_use, no tool_result) ─────────
const SID = '00000000-aaaa-bbbb-cccc-000000000501'
const HUNG_ID = 'toolu_hung_mid_run'
const base = (extra: Record<string, unknown>) => ({
  isSidechain: false, userType: 'external', entrypoint: 'cli',
  cwd: PROJECT, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})
const rows = [
  base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000011',
    message: { role: 'user', content: 'run the long tool' },
    timestamp: '2026-06-19T12:00:01.000Z' }),
  base({ parentUuid: '00000000-0000-4000-8000-000000000011', type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000012', requestId: 'req_hung_1',
    message: { id: 'msg_hung_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id: HUNG_ID, name: 'Bash', input: { command: 'sleep 9999' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    timestamp: '2026-06-19T12:00:02.000Z' }),
]
writeFileSync(join(PROJECT, `${SID}.jsonl`), encodeSeedTranscript(rows, SID))

const record = { sessionId: SID, runnerId: 'concourse-w1', title: 'idle-rest', projectLabel: 'scratch', workspaceId: PROJECT, home: PROJECT }

const until = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return cond()
}

section('§1 the idle edge rests the set — a resume onto a cut-mid-tool log is IDLE, tool rows included')
{
  const seat = new DaemonSessionConnector(record as never)
  await seat.attach()
  const live = seat.live()
  check('the fold alone opens no turn (the standing idle-on-resume law — the control)', live.inFlight === false, j({ inFlight: live.inFlight }))
  check('the published in-progress set is EMPTY on the idle edge (THE DEFECT PIN: the raw pass-through kept a permanently running tool row)', live.inProgressToolUseIDs.size === 0, j([...live.inProgressToolUseIDs]))
  check('the tail rests with it (the four-artifact company the set now joins)', seat.tail().read() === null)
  seat.detach()
}

section('§2 a RUNNING turn keeps its tool truth — the gate never blinds the live half')
{
  const facts = {
    schema: 1 as const, sessionId: SID, atMs: Date.now(),
    model: { effective: 'claude-opus-4-8', setting: null },
    usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [], mcp: [], permissionMode: 'default' as const,
    workspace: { cwd: PROJECT, originalCwd: PROJECT, projectRoot: PROJECT, instructionRoots: [] },
    queue: [], pendingModel: null, busy: true,
  }
  publishSessionFacts(facts as never, DAEMON_DIR)
  const published = await until(() => (readSessionFacts(SID, DAEMON_DIR) as { busy?: boolean } | null)?.busy === true)
  check('the busy facts projection landed (fixture plumbing)', published)
  const seat = new DaemonSessionConnector(record as never)
  await seat.attach()
  const flowed = await until(() => seat.live().inFlight === true && seat.live().inProgressToolUseIDs.has(HUNG_ID))
  check('busy facts lift the live view and the unanswered id FLOWS to the running dress', flowed, j({ inFlight: seat.live().inFlight, ids: [...seat.live().inProgressToolUseIDs] }))
  seat.detach()
}

section('§3 the records fold keeps its contract — the gate is at the publish, not in the driver')
{
  const folded = liveTurnStateOf(rows.map(r => r as never))
  check('liveTurnStateOf still reports the unresolved id raw (the pulse driver is untouched)', folded.inProgressToolUseIDs.has(HUNG_ID), j([...folded.inProgressToolUseIDs]))
}

console.log(failures === 0 ? '\nprove-idle-tool-rows-rest: ALL LAWS HOLD' : `\nprove-idle-tool-rows-rest: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
