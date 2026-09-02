// ============================================================================
//  prove-session-class — daemon-crew transcripts are classed distinctly from
//  operator sessions (the session manager must not show seat transcripts as
//  the operator's own work).
//
//  Seat transcripts (real prompts, large files — they PASS the substance
//  filter) would otherwise fill the switcher + the tab strip. isCrewSession
//  classifies by the spawn stamps (teamName/isTeammate — every daemon seat
//  spawns with the --team-name triplet) plus one belt heuristic for
//  pre-stamp logs: the bus-bridge first-prompt shapes.
//  Consumers: SessionManagerView (CREW section) + SessionTabs (the strip
//  ring/count exclude crew).
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
check(isCrewSession(base({ teamName: 'crew', agentName: 'scout' })), 'crew seat via teamName stamp')
check(isCrewSession(base({ teamName: 'crew' })), 'teamName stamp alone')
check(isCrewSession(base({ isTeammate: true })), 'isTeammate stamp alone')

// ---- crew: the belt heuristic ----------------------------------------------
check(
  isCrewSession(base({ firstPrompt: `${DISPATCH_REPORT_BACK_FRAMING}\n\nsmoke: count files` })),
  'framed-dispatch first prompt (the daemon-seat stdin shape)',
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
check(crewTagOf(base({ teamName: 'crew', agentName: 'scout' })) === 'crew · scout', 'tag crew · scout')
check(crewTagOf(base({ teamName: 'crew' })) === 'crew', 'tag crew (no agent)')
check(crewTagOf(base({ isTeammate: true })) === 'crew', 'stamp-only fallback tag')

console.log(failures === 0 ? '✅ session class GREEN' : `❌ session class RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
