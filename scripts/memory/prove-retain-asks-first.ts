#!/usr/bin/env bun
// gate-watch: src/tools/MemoryTools/MemoryTools.ts src/mneme/memoryPinIntent.ts src/mneme/memoryVerbs.ts src/tools/MemoryTools/prompt.ts docs/MNEME.md
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchRoot = process.env.TMPDIR ?? tmpdir()
const home = realpathSync(mkdtempSync(join(scratchRoot, 'retain-asks-first-')))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_EMBED_ENGINE = 'off'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const { RetainTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
const { RETAIN_PROMPT } = await import('../../src/tools/MemoryTools/prompt.ts')
const pinIntentModule = await import('../../src/mneme/memoryPinIntent.ts') as Record<string, unknown>
const retainAskRefusal = (pinIntentModule.retainAskRefusal ?? (() => 'absent on this base')) as (latest: string | undefined) => string
const CREWMATE_RETAIN_REFUSAL = (pinIntentModule.CREWMATE_RETAIN_REFUSAL ?? 'absent on this base') as string
const memoryAskRefusal = (pinIntentModule.memoryAskRefusal ?? (() => 'absent on this base')) as (messages: unknown[], agentId?: string) => string | null
const { _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { listTopicDocs } = await import('../../src/mneme/mnemeLibrary.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const dir = mnemeLibraryDir()

const REPO = join(import.meta.dir, '..', '..')
let n = 0
const user = (text: string) => ({ type: 'user', uuid: `u-${++n}`, timestamp: '2026-10-19T09:00:00.000Z', message: { role: 'user', content: text } }) as never
const assistantSaid = (text: string) => ({ type: 'assistant', uuid: `a-${++n}`, timestamp: '2026-10-19T09:00:00.000Z', message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text }] } }) as never
function contextOf(messages: unknown[], agentId?: string) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(),
    messages,
    readFileState: new Map(),
    toolUseId: `toolu_asks_${n}`,
    getAppState: () => state,
    setAppState: () => undefined,
    ...(agentId ? { agentId } : {}),
  } as never
}
const assistant = { type: 'assistant', uuid: 'asks-first', message: { id: 'msg_asks_first', role: 'assistant', content: [] } } as never
const door = (async () => ({ behavior: 'allow', updatedInput: {} })) as never
type Outcome = { index: number; status: string; reason?: string; id?: string }
type Data = { outcomes: Outcome[]; stored: number; refused: number }
const retain = async (messages: unknown[], items: Array<{ content: string; pin?: boolean; topic?: string }>, agentId?: string): Promise<{ data: Data; text: string; isError: boolean }> => {
  _resetMemoryVerbSessionStateForTesting()
  const result = (await RetainTool.call({ items } as never, contextOf(messages, agentId), door, assistant)) as { data: Data }
  const block = RetainTool.mapToolResultToToolResultBlockParam(result.data as never, 'toolu_asks') as { content?: unknown; is_error?: boolean }
  return { data: result.data, text: String(block.content ?? ''), isError: block.is_error === true }
}
const stored = (): string[] => pendingRows(dir).map(row => row.text)

try {
  section('§1 the field case: a fact mentioned in passing, no ask — refused whole, nothing stored, the refusal says why')
  const byTheWay = await retain([user('By the way, the staging database is called heron. What files are in this folder?')], [{ content: 'The staging database is called heron.', topic: 'project' }])
  check('the one item is refused and nothing is stored', byTheWay.data.stored === 0 && byTheWay.data.refused === 1 && byTheWay.data.outcomes[0]?.status === 'refused', JSON.stringify(byTheWay.data))
  check("the refusal quotes the operator's latest message, says it does not ask to remember anything, and names the words that do", byTheWay.data.outcomes[0]?.reason === retainAskRefusal('By the way, the staging database is called heron. What files are in this folder?') && byTheWay.text.includes('your latest message — "By the way, the staging database is called heron. What files are in this folder?" — does not ask to remember anything; say "remember: …"'), byTheWay.text)
  check('the tool result is an error result (0 stored · 1 refused)', byTheWay.isError && byTheWay.text.startsWith('0 stored · 1 refused'), byTheWay.text)
  check('the library holds no pending row', stored().length === 0, stored().join(' | '))
  const later = await retain([user('remember the bridge is closed on Sundays'), assistantSaid('Noted.'), user('what files are in this folder?')], [{ content: 'The bridge is closed on Sundays.' }])
  check('the LATEST operator message is the one read: an earlier ask does not carry a later turn', later.data.stored === 0 && later.data.refused === 1 && later.data.outcomes[0]?.reason === retainAskRefusal('what files are in this folder?'), JSON.stringify(later.data))

  section('§2 the asking words: a plain "remember:" is a fact, stored without pin; the generous forms pass')
  const plain = await retain([user('remember: the deploy box is the mini')], [{ content: 'The deploy box is the mini.', topic: 'project' }])
  check('"remember: <a fact>" is stored', plain.data.stored === 1 && plain.data.outcomes[0]?.status === 'stored' && stored().includes('The deploy box is the mini.'), JSON.stringify(plain.data))
  check('…without a pin (a plain remember is a fact, not a rule)', !pendingRows(dir).some(row => row.text === 'The deploy box is the mini.' && row.pin === true))
  for (const [words, fact] of [
    ['note this down: the cron runs at four', 'The cron runs at four.'],
    ["don't forget the staging box is called heron", 'The staging box is called heron.'],
    ['Please memorise this for later sessions: the API lives on port 7000', 'The API lives on port 7000.'],
    ['Keep this in mind, the release train leaves on Fridays', 'The release train leaves on Fridays.'],
    ['Jot it down — the lab printer is on the third floor. Thanks', 'The lab printer is on the third floor.'],
    ['Can you take a note that the mirror syncs hourly', 'The mirror syncs hourly.'],
    ['I keep forgetting; please remember the proxy port is 3128', 'The proxy port is 3128.'],
  ] as const) {
    const out = await retain([user(words)], [{ content: fact }])
    check(`"${words}" asks: the fact is stored`, out.data.stored === 1, JSON.stringify(out.data))
  }

  section('§3 the pin road is unchanged behind the gate')
  const pinned = await retain([user('From now on, answer every question in British English. Pin this.')], [{ content: 'Answer every question in British English.', pin: true, topic: 'user-preferences' }])
  const onShelf = (text: string): boolean => {
    const seq = listTopicDocs(dir).flatMap(doc => doc.sections.flatMap(section => section.entries)).find(entry => entry.text === text)?.seq
    return (seq !== undefined && readPins(dir).some(pin => pin.seq === seq && pin.asked === true)) || pendingRows(dir).some(row => row.text === text && row.pin === true)
  }
  check('a standing rule the user asked for is stored pinned, marked as asked for', pinned.data.stored === 1 && onShelf('Answer every question in British English.'), JSON.stringify(pinned.data))
  const unasked = await retain([user('remember: the deploy box is the mini')], [{ content: 'Always run the suite twice.', pin: true }])
  check('a pin without rule-asking words keeps its own refusal (the gate let the ask through; the pin law judged the words)', unasked.data.refused === 1 && (unasked.data.outcomes[0]?.reason ?? '').startsWith('pin needs the originating owner message'), JSON.stringify(unasked.data))

  section('§4 a crewmate never writes memory')
  const crew = await retain([user('remember: the deploy box is the mini')], [{ content: 'The crewmate found the cache dir.' }], 'child-1')
  check('a crewmate Retain is refused whole, with the asking message present in the main lane', crew.data.stored === 0 && crew.data.refused === 1 && crew.data.outcomes[0]?.reason === CREWMATE_RETAIN_REFUSAL, JSON.stringify(crew.data))
  check('the crewmate refusal sends the finding to the report', crew.text.includes('put the finding in your report'), crew.text)
  check('nothing of the crewmate\'s landed', !stored().includes('The crewmate found the cache dir.'))

  section('§5 the words: the gate is stated once, where the model reads it')
  check('memoryAskRefusal is the one judge: no window ⇒ refused, an asking window ⇒ allowed, a crewmate ⇒ refused', memoryAskRefusal([]) === retainAskRefusal(undefined) && memoryAskRefusal([user('remember this')]) === null && memoryAskRefusal([user('remember this')], 'c') === CREWMATE_RETAIN_REFUSAL)
  check('the Retain prompt tells the model the tool refuses an unasked write', RETAIN_PROMPT.includes('The tool refuses a write when the user\'s latest message does not ask for something to be remembered'), RETAIN_PROMPT.split('\n').at(-1) ?? '')
  const mneme = readFileSync(join(REPO, 'docs', 'MNEME.md'), 'utf8')
  check('docs/MNEME.md says the refusal is the tool\'s, not guidance, and names the words that ask', /Retain and Correct read your latest typed\s+message for the asking words and refuse otherwise, quoting the message they\s+read/.test(mneme) && /crewmate's Retain or Correct is refused always/.test(mneme) && !/and the like/.test(mneme) && /"save", "add", "store",\s+"put" or "record" something "to memory"/.test(mneme), mneme.split('\n').find(l => l.includes('Retain and Correct')) ?? '')
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ RETAIN WRITES ONLY WHEN THE OPERATOR\'S LATEST MESSAGE ASKS; A CREWMATE NEVER' : `\n❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
