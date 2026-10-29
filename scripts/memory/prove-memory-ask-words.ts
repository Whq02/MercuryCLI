#!/usr/bin/env bun

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchRoot = process.env.TMPDIR ?? tmpdir()
const home = realpathSync(mkdtempSync(join(scratchRoot, 'memory-ask-words-')))
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
const pinIntent = (await import('../../src/mneme/memoryPinIntent.ts')) as Record<string, unknown>
const memoryAskRefusal = pinIntent.memoryAskRefusal as (messages: unknown[], agentId?: string) => string | null
const asksForMemory = (pinIntent.asksForMemory ?? (() => false)) as (text: string) => boolean
const { _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const dir = mnemeLibraryDir()

let n = 0
const user = (text: string) => ({ type: 'user', uuid: `u-${++n}`, timestamp: '2026-10-19T11:00:00.000Z', message: { role: 'user', content: text } }) as never
function contextOf(messages: unknown[], agentId?: string) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(),
    messages,
    readFileState: new Map(),
    toolUseId: `toolu_words_${n}`,
    getAppState: () => state,
    setAppState: () => undefined,
    ...(agentId ? { agentId } : {}),
  } as never
}
const assistant = { type: 'assistant', uuid: 'ask-words', message: { id: 'msg_ask_words', role: 'assistant', content: [] } } as never
const door = (async () => ({ behavior: 'allow', updatedInput: {} })) as never
type Outcome = { index: number; status: string; reason?: string; id?: string }
type Data = { outcomes: Outcome[]; stored: number; refused: number }
const retain = async (message: string, content: string, agentId?: string): Promise<{ data: Data; text: string; isError: boolean }> => {
  _resetMemoryVerbSessionStateForTesting()
  const result = (await RetainTool.call({ items: [{ content }] } as never, contextOf([user(message)], agentId), door, assistant)) as { data: Data }
  const block = RetainTool.mapToolResultToToolResultBlockParam(result.data as never, 'toolu_words') as { content?: unknown; is_error?: boolean }
  return { data: result.data, text: String(block.content ?? ''), isError: block.is_error === true }
}

type Verdict = 'ask' | 'not an ask'
const PHRASINGS: ReadonlyArray<readonly [string, Verdict, string]> = [
  ['remember: the deploy box is the mini', 'ask', 'remember'],
  ['note this down: the db is heron', 'ask', 'note this down'],
  ['Please save this to memory: the db is heron', 'ask', 'save … to memory'],
  ['Save to memory: the db is heron', 'ask', 'save to memory, no pronoun'],
  ['Add this to memory: the db is heron', 'ask', 'add … to memory'],
  ['Add to memory: the db is heron', 'ask', 'add to memory, no pronoun'],
  ['Store in memory: the db is heron', 'ask', 'store in memory'],
  ['Store this fact: the db is heron', 'ask', 'store this fact'],
  ['Save this fact to memory: the db is heron', 'ask', 'save this fact to memory'],
  ['Make a note: the db is heron', 'ask', 'make a note'],
  ['Make a note that the db is heron', 'ask', 'make a note'],
  ['Note: the db is heron', 'ask', 'note:'],
  ['Jot down that the db is heron', 'ask', 'jot down'],
  ['Write down that the db is heron', 'ask', 'write down'],
  ['Log this: the db is heron', 'ask', 'log this'],
  ['Keep track of this: the db is heron', 'ask', 'keep track of'],
  ['Remind me next session that the db is heron', 'ask', 'remind me'],
  ['Next time, the db is heron', 'ask', 'next time'],
  ['Memorize this: the db is heron', 'ask', 'memorize'],
  ['Keep a note of this: the db is heron', 'ask', 'keep a note of'],
  ['Record this in memory: the db is heron', 'ask', 'record … in memory'],
  ['Use the Retain tool to store: the db is heron', 'ask', 'use the Retain tool'],
  ['Merke dir: die Datenbank heisst heron', 'ask', 'merke dir (German)'],
  ['N’oublie pas : la base s’appelle heron', 'ask', "n'oublie pas (French)"],
  ['Recuerda: la base de datos se llama heron', 'ask', 'recuerda (Spanish)'],
  ['By the way, the db is heron. What files are here?', 'not an ask', 'a passing detail: no asking words'],
  ['I can never remember this, but the db is heron. What files are here?', 'not an ask', '"never remember" is the opposite of an ask'],
  ['Do not remember this: the db is heron. What files are here?', 'not an ask', '"do not remember" is the opposite of an ask'],
  ['Do you remember what the db is called?', 'not an ask', '"do you remember" is a question, not an ask'],
  ['Remember to run the tests. The db is heron.', 'ask', 'a reminder is an instruction to remember: any "remember" asks, bar the negated forms'],
  ['For future reference the db is heron... no wait, ignore that. What files are here?', 'not an ask', 'an ask withdrawn by "no wait" stands withdrawn'],
]

try {
  section('§1 the thirty-one phrasings of the field read, each with its verdict (twenty-five that ask, six that do not)')
  for (const [words, verdict, why] of PHRASINGS) {
    const refusal = memoryAskRefusal([user(words)])
    const got: Verdict = refusal === null ? 'ask' : 'not an ask'
    check(`${verdict === 'ask' ? 'asks     ' : 'no ask   '} "${words}" (${why})`, got === verdict, refusal ?? 'allowed')
  }
  check('the judge is one function on the message text (asksForMemory), shared by Retain and Correct', asksForMemory('Save to memory: x') && !asksForMemory('By the way, x'))

  section('§2 more of the words people use, and their opposites')
  for (const words of [
    'note to self: the db is heron',
    'for next time: the db is heron',
    'for future sessions the db is heron',
    'keep it: the db is heron',
    'write it down, the db is heron',
    'please remember that the db is heron',
    'you should remember that the db is heron',
    'do not forget: the db is heron',
    'Never forget: the db is heron',
    'put this in memory: the db is heron',
    'memorise this: the db is heron',
    "I'd like this remembered: the build box is called kestrel.",
    'this should be memorized: the db is heron',
    'keep remembering that the db is heron',
  ]) check(`asks: "${words}"`, memoryAskRefusal([user(words)]) === null, memoryAskRefusal([user(words)]) ?? '')
  for (const words of [
    "don't remember this: the db is heron",
    'forget it, the db is heron',
    'forget that: the db is heron',
    'remember the db is heron. Actually never mind.',
    'remember the db is heron — scratch that. What files are here?',
    'Did you remember to run the tests?',
    'he never remembers this, but the db is heron. What files are here?',
    'What files are here?',
    'By the way, the staging database is called osprey now, not heron. What files are in this folder?',
  ]) check(`not an ask: "${words}"`, memoryAskRefusal([user(words)]) !== null)
  check('"no wait" before the ask does not withdraw it: the ask that follows stands', memoryAskRefusal([user('no wait, remember: the db is heron')]) === null)

  section('§3 the refusal quotes the message the gate read, so the model cannot invent a cause')
  const byTheWay = 'By the way, the db is heron. What files are here?'
  check(
    'the refusal carries the message verbatim between the dashes, then the road words',
    memoryAskRefusal([user(byTheWay)]) === `Retain is refused: your latest message — "${byTheWay}" — does not ask to remember anything; say "remember: …" (or "note this down: …", "save to memory: …") for a memory.`,
    memoryAskRefusal([user(byTheWay)]) ?? '',
  )
  const long = `By the way, ${'the build server is in the basement and '.repeat(6)}the db is heron.`
  const quoted = /— "([^"]*)" —/.exec(memoryAskRefusal([user(long)]) ?? '')?.[1] ?? ''
  check('a long message is clipped to 120 characters, the last of them an ellipsis', quoted.length === 120 && quoted.endsWith('…') && long.startsWith(quoted.slice(0, 119)), `${quoted.length}: ${quoted}`)
  const multiline = memoryAskRefusal([user('By the way,\nthe db is heron.\n\nWhat files are here?')]) ?? ''
  check('a multi-line message is quoted on one line', multiline.includes('"By the way, the db is heron. What files are here?"'), multiline)
  const silent = memoryAskRefusal([]) ?? ''
  check('with no typed message the refusal says so instead of quoting nothing', silent.startsWith('Retain is refused: no typed message of yours precedes this call') && silent.endsWith('for a memory.'), silent)

  section('§4 through the tool: the field case and its opposite')
  const kestrel = await retain('Save to memory: the build server is called kestrel', 'The build server is called kestrel.')
  check('"Save to memory: the build server is called kestrel" stores the fact', kestrel.data.stored === 1 && pendingRows(dir).some(row => row.text === 'The build server is called kestrel.'), JSON.stringify(kestrel.data))
  const denied = await retain('Do not remember this: the db is heron. What files are here?', 'The db is heron.')
  check('"Do not remember this: …" is refused whole, nothing stored', denied.data.stored === 0 && denied.data.refused === 1 && !pendingRows(dir).some(row => row.text === 'The db is heron.'), JSON.stringify(denied.data))
  check('…and the tool result quotes the message and names the road', denied.isError && denied.text.includes('your latest message — "Do not remember this: the db is heron. What files are here?" — does not ask to remember anything; say "remember: …"'), denied.text)
  const crew = await retain('Save to memory: the build server is called kestrel', 'The crewmate found the cache dir.', 'child-1')
  check('a crewmate is refused always, whatever the words', crew.data.refused === 1 && (crew.data.outcomes[0]?.reason ?? '').startsWith('Retain is refused: a crewmate never writes memory'), JSON.stringify(crew.data))
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ THE GATE READS THE WORDS PEOPLE USE, AND A REFUSAL QUOTES WHAT IT READ' : `\n❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
