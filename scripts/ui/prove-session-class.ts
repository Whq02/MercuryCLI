// ============================================================================
//  prove-session-class — router-crew transcripts are classed distinctly from
//  operator sessions (task #73/#75 operator ask: "the session
//  manager only shows the dps sessions … proper separation so routers are
//  classed distinctly from sessions + repo-session classification").
//
//  After one live party run, five seat transcripts (real prompts, large
//  files — they PASS the substance filter) flooded the switcher + the tab
//  strip as if they were the operator's work. isCrewSession classifies by
//  the spawn stamps (teamName/isTeammate — every daemon seat spawns with the
//  --team-name triplet) plus two belt heuristics for pre-stamp logs: the
//  executor lane worktree path and the bus-bridge first-prompt shapes.
//  Consumers: SessionManagerView (ROUTER CREWS section) + SessionTabs (the
//  strip ring/count exclude crew).
// ============================================================================
import { isCrewSession, crewTagOf } from '../../src/utils/sessionClass.ts'
import { DISPATCH_REPORT_BACK_FRAMING } from '../../src/daemon/scribeDispatchBridge.ts'
import type { LogOption } from '../../src/types/logs.ts'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

const base = (extra: Partial<LogOption>): LogOption =>
  ({
    date: '2026-07-04',
    messages: [],
    value: 0,
    created: new Date(),
    modified: new Date(),
    firstPrompt: 'a real operator question about the build',
    messageCount: 10,
    fileSize: 100_000,
    isSidechain: false,
    ...extra,
  }) as LogOption

// ---- crew: the stamps (the deterministic path) -----------------------------
check(isCrewSession(base({ teamName: 'party', agentName: 'dps1' })), 'party seat via teamName stamp')
check(isCrewSession(base({ teamName: 'scribe', agentName: 'implementer' })), 'implementer via teamName stamp')
check(isCrewSession(base({ isTeammate: true })), 'isTeammate stamp alone')

// ---- crew: the belt heuristics ---------------------------------------------
check(
  isCrewSession(base({ fullPath: '/repo/.claude/party/lanes/party_dps2/x.jsonl' })),
  'executor lane worktree path',
)
check(
  isCrewSession(base({ firstPrompt: `${DISPATCH_REPORT_BACK_FRAMING}\n\nsmoke: count files` })),
  'framed-dispatch first prompt (the tank/implementer stdin shape)',
)
check(isCrewSession(base({ firstPrompt: '[control ack] settled' })), '[control …] first prompt')
check(isCrewSession(base({ firstPrompt: '[progress done] lane green (ref d-1)' })), '[progress …] first prompt')
check(isCrewSession(base({ firstPrompt: '[operator note] context for the crew' })), 'operator-note first prompt')

// ---- operator sessions stay operator ---------------------------------------
check(!isCrewSession(base({})), 'a plain operator session is NOT crew')
check(
  !isCrewSession(base({ customTitle: 'my refactor', firstPrompt: 'fix the build' })),
  'titled operator work is NOT crew',
)
check(
  !isCrewSession(base({ firstPrompt: 'please ack the [control] semantics in the docs' })),
  'mentioning bus vocabulary mid-prompt is NOT crew (anchored match only)',
)

// ---- display tags -----------------------------------------------------------
check(crewTagOf(base({ teamName: 'party', agentName: 'dps1' })) === 'party · dps1', 'tag party · dps1')
check(crewTagOf(base({ teamName: 'scribe' })) === 'scribe', 'tag scribe (no agent)')
check(
  crewTagOf(base({ fullPath: '/r/.claude/party/lanes/party_dps3/s.jsonl' })) === 'party · dps3',
  'lane-path fallback tag',
)

console.log(failures === 0 ? '✅ session class GREEN' : `❌ session class RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
