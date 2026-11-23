#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import type { AssistantMessage, Message } from '../../src/engine/message-shapes/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|MERCURY_)/.test(name) && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE'].includes(name)) delete process.env[name]
}
process.env.MERCURY_CONFIG_DIR = proofHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

const HINT = 'to fix, change THINKING_READ_BY_ALL, THINKING_READ_BY or readsThinkingOf in src/models/roads/anthropic/thinkingBinding.ts to say what platform.claude.com/docs/en/build-with-claude/preserved-thinking says (read 2026-11-22), and give a new model row its place in NAMES and READS here'
let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail ?? ''} — ${HINT}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const NAMES = {
  fable52: ['claude-fable-5-2', 'claude-mythos-5-2'],
  fable51: ['claude-fable-5-1', 'claude-mythos-5-1'],
  fable5: ['claude-fable-5', 'claude-mythos-5'],
  opus55: ['claude-opus-5-5'],
  opus5: ['claude-opus-5'],
  sonnet55: ['claude-sonnet-5-5'],
  haiku55: ['claude-haiku-5-5'],
  earlier: [
    'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5-20251101', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514',
    'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022',
    'claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022',
  ],
} as const
type Name = keyof typeof NAMES
const READS: Record<Name, readonly Name[]> = {
  fable52: ['haiku55', 'sonnet55', 'opus5', 'opus55', 'fable5', 'fable51', 'fable52', 'earlier'],
  fable51: ['opus5', 'opus55', 'fable5', 'fable51', 'earlier'],
  opus55: ['haiku55', 'sonnet55', 'opus5', 'opus55', 'earlier'],
  sonnet55: ['haiku55', 'sonnet55', 'earlier'],
  haiku55: ['haiku55', 'earlier'],
  opus5: ['opus5', 'earlier'],
  fable5: ['fable5', 'opus5', 'earlier'],
  earlier: ['earlier'],
}
const names = Object.keys(NAMES) as Name[]
const nameOf = (id: string): Name => names.find(name => (NAMES[name] as readonly string[]).includes(id))!
const every = names.flatMap(name => [...NAMES[name]] as string[])

const turns: ScriptedTurn[] = [
  { kind: 'text', text: '60', thinking: 'Count the sevens.', model: 'claude-sonnet-5', whenModel: 'claude-sonnet-5' },
  { kind: 'text', text: '104', thinking: 'Count the multiples.', model: 'claude-sonnet-5-5', whenModel: 'claude-sonnet-5-5', whenBody: 'Count them.' },
  ...Array.from({ length: 12 }, () => ({ kind: 'text', text: 'OK' }) as ScriptedTurn),
]
const fixture = await startFixtureApi(turns, { apiChecks: true, captureAllHeaders: true })
const nativeFetch = globalThis.fetch
const leftTheMachine: string[] = []
const fixtureFetch: typeof fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.host === 'api.anthropic.com') return nativeFetch(new URL(`${url.pathname}${url.search}`, fixture.url), init)
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return nativeFetch(input, init)
  leftTheMachine.push(url.host)
  return Promise.reject(new Error(`the proof lets no request leave the machine: ${url.host}`))
}
globalThis.fetch = fixtureFetch

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { asSessionId } = await import('../../src/sessions/transcripts/ids.ts')
switchSession(asSessionId('33333333-3333-4333-8333-333333333333'))
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { readsThinkingOf } = await import('../../src/models/roads/anthropic/thinkingBinding.ts')
const { ALL_MODEL_CONFIGS } = await import('../../src/models/facts/builtInModelTable.ts')

const j = (value: unknown): string => JSON.stringify(value)
type Sent = { roles: string[]; thinkingBlocks: number; settled: AssistantMessage[]; failed: string | null }
async function send(model: string, history: Message[], posture = 'You answer in one word.'): Promise<Sent> {
  const from = fixture.messageRequests().length
  const settled: AssistantMessage[] = []
  let failed: string | null = null
  for await (const event of routedCallModel({
    messages: history, systemPrompt: asSystemPrompt([posture]),
    thinkingConfig: { type: 'adaptive' }, tools: [], signal: new AbortController().signal,
    options: {
      model, querySource: 'sdk', isNonInteractiveSession: true,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      agents: [], mcpTools: [], hasAppendSystemPrompt: false, enablePromptCaching: true,
      effortValue: 'high', fetchOverride: fixtureFetch,
    },
  })) {
    if (event.type !== 'assistant') continue
    if (event.isApiErrorMessage) failed = j(event.message.content).slice(0, 300)
    else settled.push(event)
  }
  const request = fixture.messageRequests()[from]
  const messages = ((request?.body ?? {}) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
  const thinkingBlocks = messages.reduce((total, row) => total + (Array.isArray(row.content) ? row.content.filter(block => (block as { type?: string }).type === 'thinking').length : 0), 0)
  return { roles: messages.map(row => row.role), thinkingBlocks, settled, failed: request === undefined ? 'no request reached the stand-in' : failed }
}
const shown = (sent: Sent): string => j({ roles: sent.roles, thinkingBlocks: sent.thinkingBlocks, failed: sent.failed })

try {
  section('§1 the table covers every model on the road, and each pair answers as the page states it')
  const offered = (Object.values(ALL_MODEL_CONFIGS) as Array<{ firstParty: string }>).map(row => row.firstParty)
  const unplaced = offered.filter(id => !every.includes(id))
  check('every model row of the road has its place in the page\'s table here', unplaced.length === 0 && every.every(id => offered.includes(id)), `no place for: ${unplaced.join(', ')}; not a row of the road: ${every.filter(id => !offered.includes(id)).join(', ')}`)
  for (const target of names) {
    const wrong: string[] = []
    for (const to of NAMES[target]) {
      for (const from of every) {
        const stated = READS[target].includes(nameOf(from))
        if (readsThinkingOf(to, from) !== stated) wrong.push(`${from} → ${to} should be ${stated ? 'read' : 'unreadable'}`)
        if (readsThinkingOf(`${to}[1m]`, from) !== stated) wrong.push(`${from} → ${to}[1m] should be ${stated ? 'read' : 'unreadable'}`)
      }
    }
    check(`into ${NAMES[target].join(' and ')}: read from ${READS[target].join(', ')} and from no other row`, wrong.length === 0, wrong.slice(0, 6).join('; '))
  }
  check('a model the road does not offer is read by none and reads none but itself', !readsThinkingOf('claude-sonnet-5-5', 'claude-mythos-preview') && !readsThinkingOf('claude-fable-5', 'claude-mythos-preview') && !readsThinkingOf('claude-opus-6', 'claude-sonnet-5') && !readsThinkingOf('claude-sonnet-5-7', 'claude-haiku-5-5') && readsThinkingOf('claude-opus-6', 'claude-opus-6'))
  const named = (to: string, from: string): string => {
    try {
      return String(readsThinkingOf(to, from))
    } catch (error) {
      return `threw ${String(error).slice(0, 80)}`
    }
  }
  const odd = [['constructor', 'claude-sonnet-5'], ['constructor', 'claude-opus-5-5'], ['toString', 'claude-haiku-5-5'], ['claude-opus-5-5', 'constructor'], ['__proto__', 'claude-opus-5']].map(([to, from]) => `${from} → ${to}: ${named(to!, from!)}`)
  check('a model id that is also the name of a built-in property reads nothing and ends no request', odd.every(row => row.endsWith(': false')), odd.join('; '))

  section('§2 on the wire: an earlier model\'s thinking rides into a newer reader, and only where the page says so')
  const question = createUserMessage({ content: 'How many sevens from 1 to 300?' })
  const wrote = await send('claude-sonnet-5', [question])
  const signed = wrote.settled.some(row => Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'thinking'))
  check('Sonnet 5 answers with a signed thinking block', wrote.failed === null && signed, shown(wrote))
  const next = createUserMessage({ content: 'Say OK.' })
  const carried = await send('claude-sonnet-5-5', [question, ...wrote.settled, next])
  check('the next request, to Sonnet 5.5, carries that block', carried.failed === null && carried.thinkingBlocks === 1, shown(carried))
  const moved = await send('claude-sonnet-5-5', [question, ...wrote.settled, next], 'You answer in two words.')
  check('where the standing prompt moved since the block was written, it stays out as it did', moved.failed === null && moved.thinkingBlocks === 0, shown(moved))
  const ask = createUserMessage({ content: 'Count them.' })
  const own = await send('claude-sonnet-5-5', [question, ...wrote.settled, next, ...carried.settled, ask])
  check('Sonnet 5.5 answers with a block of its own', own.failed === null && own.settled.some(row => Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'thinking')), shown(own))
  const whole = [question, ...wrote.settled, next, ...carried.settled, ask, ...own.settled, createUserMessage({ content: 'Say OK again.' })]
  const same = await send('claude-sonnet-5-5', whole)
  check('the same model reads both blocks back', same.failed === null && same.thinkingBlocks === 2, shown(same))
  const back = await send('claude-sonnet-5', whole)
  check('back on Sonnet 5 its own block rides and the Sonnet 5.5 block stays out (the page states no such pair)', back.failed === null && back.thinkingBlocks === 1, shown(back))
  const opus = await send('claude-opus-5', whole)
  check('Opus 5 reads the Sonnet 5 block and not the Sonnet 5.5 one', opus.failed === null && opus.thinkingBlocks === 1, shown(opus))

  section('§3 nothing left the machine')
  check('every request went to the stand-in', leftTheMachine.length === 0, leftTheMachine.join(', '))
} finally {
  await fixture.close()
  removeScratch(proofHome)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} thinking read-by table check(s) failed`)
  process.exit(1)
}
console.log(' ALL THINKING READ-BY TABLE PROOFS PASS')
process.exit(0)
