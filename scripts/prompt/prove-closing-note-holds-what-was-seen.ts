#!/usr/bin/env bun
import '../lib/hermetic.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_BARE

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { noteSessionEngine, _resetLineageSessionForTesting } = await import('../../src/sessions/mneme/lineageSession.ts')
const { askForHandoff, handoffAskText, _resetHandoffAskForTesting } = await import('../../src/sessions/mneme/handoffAsk.ts')
const { registerSessionCloseAsk, _resetSessionClosersForTesting } = await import('../../src/sessions/mneme/sessionClose.ts')
const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { HANDOFF_ASK_MARK } = await import('../lib/fixtureApi.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HINT = 'update HANDOFF_ASK (returned by handoffAskText) in src/sessions/mneme/handoffAsk.ts'

const sessionId = '00000000-0000-4000-8000-00000000c001'
_resetSessionClosersForTesting()
_resetHandoffAskForTesting()
_resetLineageSessionForTesting()

const built = handoffAskText(sessionId).text

check(
  'keeps the opening orient sentence and fixture mark',
  built.startsWith("The session is ending. Leave one note for the next session to orient itself just enough for the next session to know the repo's workings, nothing else.") && built.includes(HANDOFF_ASK_MARK),
  `${HINT} to keep the opening sentences and "${HANDOFF_ASK_MARK}"; got: ${built}`,
)

check(
  'states that the note holds only what this session did or saw',
  /only what this session (?:itself )?did or saw/i.test(built),
  `${HINT} to state that the note holds only what this session did or saw; got: ${built}`,
)

check(
  'omits any file or git claim not shown by a tool call of this session (never guessed or copied from an earlier note)',
  /file/i.test(built) && /git/i.test(built) && /tool call of this session/i.test(built) && /guess/i.test(built) && /earlier note/i.test(built),
  `${HINT} to state that any statement about a file or about git that no tool call of this session showed is left out (not guessed, not copied from an earlier note); got: ${built}`,
)

check(
  'tells a session that did and saw nothing to say so in one line',
  /did and saw nothing/i.test(built) && /\b(?:one|a) line\b/i.test(built),
  `${HINT} to tell a session that did and saw nothing to say so in one line; got: ${built}`,
)

check(
  'keeps the conciseness and verbatim-cap trailer intact',
  built.includes('Keep prose concise, effective, and short.') && built.endsWith('Reply with the note alone; it is stored exactly as written, up to 8,000 characters.'),
  `${HINT} to keep the conciseness sentence and verbatim-cap trailer; got: ${built}`,
)

const unregister = registerSessionCloseAsk(() => ({ line: 'Extra close line.' }))
try {
  const withExtra = handoffAskText(sessionId).text
  check(
    'preserves the closing-note instruction ahead of registered session-close lines',
    withExtra === `${built}\nExtra close line.`,
    `${HINT} so handoffAskText keeps HANDOFF_ASK ahead of extra session-close lines; got: ${withExtra}`,
  )
} finally {
  unregister()
}

noteSessionEngine('fixture')
let sentPrompt = ''
await askForHandoff({
  sessionId,
  cacheSafeParams: { systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] },
  run: async params => {
    const content = params.promptMessages[0]?.message.content
    sentPrompt = typeof content === 'string' ? content : ''
    return { messages: [createAssistantMessage({ content: 'This session did and saw nothing.' })], terminal: { reason: 'completed' } }
  },
})

check(
  'askForHandoff sends the built instruction verbatim to the runner',
  sentPrompt === built,
  `check askForHandoff and handoffAskText in src/sessions/mneme/handoffAsk.ts; sent: ${sentPrompt}`,
)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} closing note holds what was seen: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
