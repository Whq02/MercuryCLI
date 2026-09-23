#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'send-plain-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the plain-string SendMessage proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const { DERIVED_SUMMARY_MAX_CHARS, derivedMessageSummary, plainMessageSummary } = await import('../../src/tools/SendMessageTool/summary.ts')
const { getPrompt } = await import('../../src/tools/SendMessageTool/prompt.ts')
const { readMailbox } = await import('../../src/utils/teammateMailbox.ts')
const { setDynamicTeamContext } = await import('../../src/utils/teammate.ts')
const { TEAM_LEAD_NAME } = await import('../../src/utils/swarm/constants.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

type Verdict = { result: boolean; message?: string; errorCode?: number }
const validate = (input: Record<string, unknown>): Promise<Verdict> => (SendMessageTool as { validateInput: (i: unknown) => Promise<Verdict> }).validateInput(input)
const TEAM = 'plain-string-fixture-team'
const makeContext = (): unknown => ({
  options: { tools: [], commands: [], mcpClients: [], mainLoopModel: 'fixture-model' },
  abortController: new AbortController(),
  readFileState: new Map(),
  messages: [],
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), tasks: {}, teamContext: { teamName: TEAM, leadAgentId: 'lead-fixture' } }),
  setAppState: () => {},
})
const LONG_WORDS = 'A ruling from the owner that changes row two and row four of your brief — read the new last section of the lane page before you cut the size switch; in short the switch stays and gains a slash form and the frames add two states'
const THREE_LINES = 'first line of the message\nsecond line with more detail\nthird line'

section('§1 VALIDATION — a plain string without a summary is accepted (RED on the base: "A summary is required for plain string messages.")')
{
  const bare = await validate({ to: 'critter', message: THREE_LINES })
  check('a plain string message with no summary validates', bare.result === true, `${bare.message ?? ''} (errorCode ${bare.errorCode ?? '-'})`)
  const blank = await validate({ to: 'critter', message: THREE_LINES, summary: '   ' })
  check('a blank summary validates too', blank.result === true, blank.message ?? '')
  const given = await validate({ to: 'critter', message: THREE_LINES, summary: 'the owner ruling' })
  check('an explicit summary validates as before', given.result === true, given.message ?? '')
  const empty = await validate({ to: '', message: 'x' })
  check('the recipient law is untouched: an empty "to" still refuses', empty.result === false && /must not be empty/.test(empty.message ?? ''), empty.message ?? '')
  const suffixed = await validate({ to: 'critter@team', message: 'x' })
  check('the @team suffix still refuses', suffixed.result === false, suffixed.message ?? '')
  const broadcastEnvelope = await validate({ to: '*', message: { type: 'question', content: 'x' } })
  check('a structured broadcast still refuses', broadcastEnvelope.result === false && /cannot be broadcast/.test(broadcastEnvelope.message ?? ''), broadcastEnvelope.message ?? '')
}

section('§2 THE DERIVED SUMMARY — the first non-empty line, cut at the preview bound; an explicit summary wins')
{
  check('the first line is the summary', derivedMessageSummary(THREE_LINES) === 'first line of the message', derivedMessageSummary(THREE_LINES))
  check('leading blank lines and inner runs of space are skipped and folded', derivedMessageSummary('\n\n   a   spaced   line  \nnext') === 'a spaced line', derivedMessageSummary('\n\n   a   spaced   line  \nnext'))
  const long = derivedMessageSummary(LONG_WORDS) ?? ''
  check(`a long first line is cut at ${DERIVED_SUMMARY_MAX_CHARS} characters on a word boundary with an ellipsis`, long.length <= DERIVED_SUMMARY_MAX_CHARS && long.endsWith('…') && LONG_WORDS.startsWith(long.slice(0, -1)) && !long.slice(0, -1).endsWith(' '), long)
  check('an empty message derives no summary', derivedMessageSummary('') === undefined && derivedMessageSummary(' \n ') === undefined)
  check('an explicit summary wins over the derivation', plainMessageSummary('given words', THREE_LINES) === 'given words' && plainMessageSummary('  ', THREE_LINES) === 'first line of the message' && plainMessageSummary(undefined, THREE_LINES) === 'first line of the message')
}

section('§3 DELIVERY — a plain string to a teammate lands in the mailbox with the derived summary (RED on the base: validation refused it first)')
{
  setDynamicTeamContext({ agentId: 'critter-fixture', agentName: 'critter', teamName: TEAM, planModeRequired: false })
  const ctx = makeContext()
  const verdict = await validate({ to: TEAM_LEAD_NAME, message: THREE_LINES })
  check('the send validates', verdict.result === true, verdict.message ?? '')
  const call = (SendMessageTool as { call: (i: unknown, c: unknown, u: unknown, m: unknown) => Promise<{ data: { success: boolean; message: string; routing?: { summary?: string; content?: string } } }> }).call
  const sent = await call({ to: TEAM_LEAD_NAME, message: THREE_LINES }, ctx, undefined, { requestId: 'req_plain' })
  check('the message is delivered to the team lead inbox', sent.data.success === true && /delivered/.test(sent.data.message), sent.data.message)
  check('the routing receipt carries the derived summary', sent.data.routing?.summary === 'first line of the message' && sent.data.routing?.content === THREE_LINES, JSON.stringify(sent.data.routing))
  const inbox = await readMailbox(TEAM_LEAD_NAME, TEAM)
  const landed = inbox.find(message => message.text === THREE_LINES)
  check('the mailbox row carries the derived summary', landed !== undefined && landed.summary === 'first line of the message', JSON.stringify(landed))
  const explicit = await call({ to: TEAM_LEAD_NAME, message: THREE_LINES, summary: 'the owner ruling' }, ctx, undefined, { requestId: 'req_explicit' })
  check('an explicit summary still rides as given', explicit.data.success === true && explicit.data.routing?.summary === 'the owner ruling', JSON.stringify(explicit.data.routing))
}

section('§4 THE WORDS — the description and the prompt name the summary as optional and derived')
{
  const schema = (SendMessageTool as { inputSchema: { shape: { summary: { description?: string } } } }).inputSchema
  const description = schema.shape.summary.description ?? ''
  check('the summary field says optional and names the derivation', /optional/.test(description) && /first line/.test(description) && !/required/.test(description), description)
  const prompt = getPrompt()
  check('the prompt says the summary is optional and previewed by the first line', /summary: optional/.test(prompt) && /first line/.test(prompt), prompt.split('\n').find(line => line.startsWith('- summary')) ?? '')
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
