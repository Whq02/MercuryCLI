#!/usr/bin/env bun
// gate-watch: src/tools/MemoryTools/MemoryTools.ts src/mneme/memoryPinIntent.ts src/mneme/memoryVerbs.ts src/mneme/mnemeCorrect.ts src/mneme/mnemeBuffer.ts src/tools/MemoryTools/prompt.ts docs/MNEME.md
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchRoot = process.env.TMPDIR ?? tmpdir()
const home = realpathSync(mkdtempSync(join(scratchRoot, 'correct-asks-first-')))
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

const { RetainTool, CorrectTool, RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
const { CORRECT_PROMPT } = await import('../../src/tools/MemoryTools/prompt.ts')
const pinIntent = (await import('../../src/mneme/memoryPinIntent.ts')) as Record<string, unknown>
const correctAskRefusal = (pinIntent.correctAskRefusal ?? (() => 'absent on this base')) as (messages: unknown[], agentId?: string) => string | null
const CREWMATE_CORRECT_REFUSAL = (pinIntent.CREWMATE_CORRECT_REFUSAL ?? 'absent on this base') as string
const { _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const dir = mnemeLibraryDir()
const REPO = join(import.meta.dir, '..', '..')

let n = 0
const user = (text: string) => ({ type: 'user', uuid: `u-${++n}`, timestamp: '2026-10-19T11:30:00.000Z', message: { role: 'user', content: text } }) as never
function contextOf(messages: unknown[], agentId?: string) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(),
    messages,
    readFileState: new Map(),
    toolUseId: `toolu_correct_${n}`,
    getAppState: () => state,
    setAppState: () => undefined,
    ...(agentId ? { agentId } : {}),
  } as never
}
const assistant = { type: 'assistant', uuid: 'correct-asks', message: { id: 'msg_correct_asks', role: 'assistant', content: [] } } as never
const door = (async () => ({ behavior: 'allow', updatedInput: {} })) as never
type Row = { ts: string; text: string; source: string; history?: { ts: string; text: string } }
type CorrectData = { ok: boolean; op: string; code?: string; message?: string; targetId?: string; newId?: string | null; draft?: true }
const correct = async (message: string, input: Record<string, unknown>, agentId?: string): Promise<{ data: CorrectData; text: string; isError: boolean }> => {
  const result = (await CorrectTool.call(input as never, contextOf([user(message)], agentId), door, assistant)) as { data: CorrectData }
  const block = CorrectTool.mapToolResultToToolResultBlockParam(result.data as never, 'toolu_correct') as { content?: unknown; is_error?: boolean }
  return { data: result.data, text: String(block.content ?? ''), isError: block.is_error === true }
}
const rows = (): Row[] => pendingRows(dir) as Row[]
const rowWith = (text: string): Row | undefined => rows().find(row => row.text === text)
const OLD = 'The staging database is called heron.'
const NEW = 'The staging database is called osprey.'

try {
  section('§0 the operator asks for a fact; it waits in the buffer as a pending draft')
  _resetMemoryVerbSessionStateForTesting()
  const retained = (await RetainTool.call({ items: [{ content: OLD, topic: 'project' }] } as never, contextOf([user(`remember: ${OLD}`)]), door, assistant)) as { data: { stored: number } }
  const draft = rowWith(OLD)
  check('the fact is a pending row', retained.data.stored === 1 && draft !== undefined, JSON.stringify(retained.data))
  const draftId = `pending:${draft?.ts ?? ''}`

  section('§1 a crewmate cannot change memory through Correct, whatever the main lane said')
  const crew = await correct(`remember: ${OLD}`, { op: 'supersede', id: draftId, content: 'The deploy box is the studio.', reason: 'product test of the crewmate road' }, 'child-1')
  check('the crewmate supersede is refused', !crew.data.ok && crew.data.code === 'crewmate' && crew.data.message === CREWMATE_CORRECT_REFUSAL, JSON.stringify(crew.data))
  check('the result is an error result that sends the finding to the report', crew.isError && crew.text === CREWMATE_CORRECT_REFUSAL, crew.text)
  check("the operator's draft is untouched", rowWith(OLD)?.ts === draft?.ts && !rowWith('The deploy box is the studio.'), rows().map(row => row.text).join(' | '))
  for (const op of ['amend', 'retract'] as const) {
    const out = await correct(`remember: ${OLD}`, { op, id: draftId, ...(op === 'amend' ? { content: 'x' } : {}), reason: 'crewmate' }, 'child-2')
    check(`a crewmate ${op} is refused the same way`, !out.data.ok && out.data.code === 'crewmate', JSON.stringify(out.data))
  }

  section('§2 a change said in passing does not change memory: Correct is refused with the words it read')
  const byTheWay = 'By the way, the staging database is called osprey now, not heron. What files are in this folder?'
  const passing = await correct(byTheWay, { op: 'supersede', id: draftId, content: 'The staging database is called osprey (previously heron).', reason: 'User said the staging database is now called osprey, not heron.' })
  check('the by-the-way supersede is refused', !passing.data.ok && passing.data.code === 'not-asked', JSON.stringify(passing.data))
  check(
    'the refusal quotes the message and names the road',
    passing.text === `Correct is refused: your latest message — "${byTheWay}" — does not ask to change a memory; say "remember: … instead of …" or correct it in /memory.` && passing.isError,
    passing.text,
  )
  check('the draft is untouched: the old words stand, nothing new in the buffer', rowWith(OLD)?.ts === draft?.ts && rows().length === 1, rows().map(row => row.text).join(' | '))
  const retract = await correct('What files are in this folder?', { op: 'retract', id: draftId, reason: 'tidying' })
  check('a retract of a pending draft is behind the same gate', !retract.data.ok && retract.data.code === 'not-asked' && rowWith(OLD) !== undefined, JSON.stringify(retract.data))
  const amend = await correct('What files are in this folder?', { op: 'amend', id: draftId, content: 'The staging database is called Heron.', reason: 'capital' })
  check('an amend is behind the same gate', !amend.data.ok && amend.data.code === 'not-asked', JSON.stringify(amend.data))
  const consolidated = await correct('What files are in this folder?', { op: 'supersede', id: 'seq:1', content: 'x', reason: 'y' })
  check('the gate comes before any lookup: a consolidated id is refused the same way, not answered with unknown-target', !consolidated.data.ok && consolidated.data.code === 'not-asked', JSON.stringify(consolidated.data))
  check('the judge is the one asking rule: no typed message ⇒ refused, a crewmate ⇒ refused, "remember: …" ⇒ allowed', correctAskRefusal([]) !== null && correctAskRefusal([user('remember: x')], 'c') === CREWMATE_CORRECT_REFUSAL && correctAskRefusal([user('remember: x')]) === null)

  section('§3 the operator asks for the change: the supersede lands and the old draft is kept as history')
  const asked = await correct('remember: the staging database is osprey now, not heron', { op: 'supersede', id: draftId, content: NEW, reason: 'the operator renamed it' })
  const replacement = rowWith(`${NEW} (why: the operator renamed it)`) ?? rowWith(NEW)
  check('the supersede lands on the pending row and names the new draft', asked.data.ok && asked.data.draft === true && asked.data.targetId === draftId && asked.data.newId === `pending:${replacement?.ts ?? ''}`, JSON.stringify(asked.data))
  check('the old draft left the buffer', rowWith(OLD) === undefined, rows().map(row => row.text).join(' | '))
  check('the new draft carries the old words as its history, with the old row id', replacement?.history?.ts === draft?.ts && replacement?.history?.text === OLD, JSON.stringify(replacement))
  check('the result says the history is kept, not that it leaves none', asked.text.includes("keeps the old draft's words as its history") && !asked.text.includes('leaves no history'), asked.text)
  const read = (await RecallTool.call({ read: asked.data.newId } as never, contextOf([user('what did I say?')]), door, assistant)) as { data: { content?: string } }
  check('Recall read of the new draft shows the history line with the old words', (read.data.content ?? '').includes(`history: replaced ${draftId} — ${OLD}`), JSON.stringify(read.data).slice(0, 400))
  const rowOnDisk = readFileSync(join(dir, 'current.jsonl'), 'utf8').split('\n').find(line => line.includes(NEW)) ?? ''
  check('the history rides on the row on disk', rowOnDisk.includes(`"history":{"ts":"${draft?.ts}","text":"${OLD}"}`), rowOnDisk)

  section('§4 the words say so')
  check('the Correct prompt tells the model the tool refuses an unasked change and a crewmate always', CORRECT_PROMPT.includes("The tool refuses a change when the user's latest message does not ask for a memory to be remembered or changed") && CORRECT_PROMPT.includes("a crewmate's always"), CORRECT_PROMPT)
  check('the Correct prompt says a replaced draft keeps the old words as history', CORRECT_PROMPT.includes('the new row keeps the old words as its history'), CORRECT_PROMPT)
  const mneme = readFileSync(join(REPO, 'docs', 'MNEME.md'), 'utf8')
  check('docs/MNEME.md says the rule covers Retain and Correct, and a crewmate\'s either is refused', /The model writes or changes memory only when you ask it to/.test(mneme) && /crewmate's Retain or Correct is refused always/.test(mneme), mneme.split('\n').find(l => l.includes('writes or changes memory')) ?? '')
  check('docs/MNEME.md says a superseded pending draft keeps the old words as its history', /A superseded or amended pending draft\s+\(`pending:<ts>`\) is replaced by a new draft that keeps the old words as its\s+history/.test(mneme), mneme.split('\n').find(l => l.includes('superseded or amended pending')) ?? '')
  const findings = readFileSync(join(REPO, 'docs', 'MEMORY-FINDINGS.md'), 'utf8')
  check('docs/MEMORY-FINDINGS.md says the rule covers Retain and Correct and links it to the four verbs', findings.includes('The model writes or changes memory only when you ask it to, through Retain or Correct') && findings.includes('(MNEME.md#the-four-verbs)'), findings.split('\n').find(l => l.includes('Two later rules')) ?? '')
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ CORRECT CHANGES MEMORY ONLY WHEN THE OPERATOR ASKS; A CREWMATE NEVER; A REPLACED DRAFT KEEPS ITS HISTORY' : `\n❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
