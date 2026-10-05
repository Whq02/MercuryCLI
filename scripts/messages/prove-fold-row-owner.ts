#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'fold-row-owner-home-'))
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import(join(ROOT, 'src/utils/staticRender.tsx'))
const { Messages } = await import(join(ROOT, 'src/components/Messages.tsx'))
const { CrewmatePlateContext } = await import(join(ROOT, 'src/components/messages/TranscriptNameplate.tsx'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const slot = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
const { noSessionConnector } = await import(join(ROOT, 'src/services/engine-connector/noSessionConnector.ts'))
const { IDLE_LIVE } = await import(join(ROOT, 'src/services/engine-connector/seatLive.ts'))
const { beginFoldStatus, FOLD_ROW_HEAD } = await import(join(ROOT, 'src/services/compact/foldStatus.ts'))

const T0 = 1_760_000_000_000
const iso = (at: number): string => new Date(at).toISOString()
const fold = beginFoldStatus({ trigger: 'manual', startedAtMs: Date.now() - 4_000, sessionMemory: false, microcompaction: true })
const STATUS = { title: 'a chat', projectLabel: 'mercury', interrupting: false, hardStopping: false, wait: null, quietMs: 1_000, watchdogMs: 90_000, phaseMs: 110_000, toolBudgetMs: 120_000, stuck: false }
const seat = Object.assign(Object.create(noSessionConnector()), {
  sessionId: () => 'lead-session',
  live: () => ({ ...IDLE_LIVE, inFlight: true, phase: 'compacting', turnStartedAtMs: Date.now() - 4_000 }),
  subscribeLive: () => () => {},
  status: () => STATUS,
  tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
  fold: () => fold,
  subscribeFold: () => () => {},
})
slot.setFocusedSessionConnector(seat)

const rows = [
  { type: 'user', uuid: 'u-1', timestamp: iso(T0), message: { role: 'user', content: 'summarise the plan' } },
  {
    type: 'assistant',
    uuid: 'a-1',
    timestamp: iso(T0 + 1_000),
    requestId: 'req_fixture_1',
    message: { id: 'msg_fixture_1', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'The plan has three steps.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  },
]

const common = {
  messages: rows,
  tools: [],
  commands: [],
  verbose: true,
  toolJSX: null,
  toolUseConfirmQueue: [],
  inProgressToolUseIDs: new Set<string>(),
  isMessageSelectorVisible: false,
  screen: 'prompt',
  streamingToolUses: [],
  isLoading: false,
  streamingThinking: null,
  hidePastReasoning: true,
  streamingTail: null,
  suppressLogo: true,
  disableRenderCap: true,
}

const paint = async (props: Record<string, unknown>, plates: { agent: string; user: string } | null): Promise<string> => {
  const list = React.createElement(Messages as never, { ...common, ...props } as never)
  const body = plates === null ? list : React.createElement(CrewmatePlateContext.Provider, { value: plates }, list)
  const text = await renderToString(React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() }, body))
  return text.replace(/\s+/g, ' ')
}

section('§1 the focused session\'s own transcript paints its fold row (the guard)')
const own = await paint({ conversationId: 'lead-session' }, null)
check('the lead\'s rows paint', own.includes('summarise the plan') && own.includes('The plan has three steps.'), own.slice(0, 200))
check(`the fold row "${FOLD_ROW_HEAD}" stands under the lead\'s rows while the focused connector reports a live fold`, own.includes(FOLD_ROW_HEAD), own.slice(0, 300))

section('§2 a crewmate\'s transcript paints no fold row of the focused session (RED on the base)')
const viewed = await paint({ conversationId: 'crewmate:task-1', suppressNotices: true }, { agent: 'scout', user: 'you → scout' })
check('the crewmate\'s rows paint under the crewmate plates', viewed.includes('[scout]') && viewed.includes('The plan has three steps.'), viewed.slice(0, 200))
check(`RED ON THE BASE: no "${FOLD_ROW_HEAD}" row rides a crewmate\'s transcript while the LEAD folds`, !viewed.includes(FOLD_ROW_HEAD), viewed.slice(0, 300))

section('§3 the fold row follows the session identity, not a mount flag')
const foreign = await paint({ conversationId: 'some-other-session' }, null)
check('a transcript of another conversation paints no fold row even with every notice allowed (RED on the base)', foreign.includes('The plan has three steps.') && !foreign.includes(FOLD_ROW_HEAD), foreign.slice(0, 300))
const exported = await paint({ conversationId: 'export', renderRange: [0, 2] }, null)
check('an export slice paints no fold row (RED on the base)', exported.includes('The plan has three steps.') && !exported.includes(FOLD_ROW_HEAD), exported.slice(0, 300))
const ownQuiet = await paint({ conversationId: 'lead-session', suppressNotices: true }, null)
check('the focused session\'s own transcript keeps its fold row whatever its notice strip does', ownQuiet.includes(FOLD_ROW_HEAD), ownQuiet.slice(0, 300))

slot.releaseFocusedSessionConnector()
console.log(`\n${'─'.repeat(76)}`)
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
