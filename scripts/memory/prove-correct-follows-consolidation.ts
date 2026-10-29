#!/usr/bin/env bun
// gate-watch: src/tools/MemoryTools/MemoryTools.ts src/tools/MemoryTools/UI.tsx src/mneme/memoryVerbs.ts src/mneme/mnemeCorrect.ts src/mneme/mnemeContradiction.ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-correct-follows')
Object.assign(process.env, {
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_HOME', 'MERCURY_MODEL', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'NODE_ENV']) delete process.env[key]

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (v: unknown): string => JSON.stringify(v)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { journal: false } }))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()

const { retainItems, consolidatedIdOf, readMemoryRecord, hasSeenFullRow, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { CorrectTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
const { renderCorrectResult } = await import('../../src/tools/MemoryTools/UI.tsx')
const { conflictReason } = await import('../../src/mneme/mnemeContradiction.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

const dir = mnemeLibraryDir()
const context = (): never => {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(),
    messages: [{ type: 'user', uuid: 'follow-ask', timestamp: '2026-10-19T09:00:00.000Z', message: { role: 'user', content: 'remember: the deploy moved to Thursday; drop the Wednesday note' } }],
    readFileState: new Map(),
    toolUseId: 'toolu_follow',
    getAppState: () => state,
    setAppState: () => undefined,
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
  } as never
}
const liveEntries = (): Array<{ seq: number; text: string; time: string }> => listTopicDocs(dir).flatMap(d => d.sections.flatMap(s => s.entries))
const historyEntries = (): Array<{ seq: number; text: string; supersededBy?: number }> => listTopicDocs(dir).flatMap(d => d.history)
const resultOf = (data: unknown): { content: string; is_error?: boolean } => {
  const block = CorrectTool.mapToolResultToToolResultBlockParam(data as never, 'toolu_follow') as { content?: unknown; is_error?: boolean }
  return { content: String(block.content ?? ''), ...(block.is_error === undefined ? {} : { is_error: block.is_error }) }
}

section('§1 a pending fact consolidates; the pending id the model still holds follows the consolidation to its seq')
const FACT = 'the deploy runs from the release branch every Friday afternoon'
const stored = retainItems([{ content: FACT, topic: 'deployment' }], { session: 'follow-seed' }, dir)
check('the fact is staged as a pending draft', stored[0]?.status === 'stored' && stored[0].id.startsWith('pending:'), j(stored))
const pendingId = stored[0]?.status === 'stored' ? stored[0].id : ''
check('before consolidation the pending id is its own target: nothing to follow', consolidatedIdOf(pendingId, dir) === null)
check('consolidation lands the fact on a topic page', maybeConsolidate({ force: true, dir }).consolidated === true && pendingRows(dir).length === 0, j(pendingRows(dir)))
const seq = liveEntries().find(e => e.text === FACT)?.seq ?? -1
check('the live entry keeps the pending row\'s time as its own', seq > 0 && liveEntries().find(e => e.seq === seq)?.time === pendingId.slice('pending:'.length), j(liveEntries()))
check('the consolidation map answers the seq for the stale pending id', consolidatedIdOf(pendingId, dir) === `seq:${seq}`, String(consolidatedIdOf(pendingId, dir)))
check('an id that never existed follows nowhere', consolidatedIdOf('pending:2026-01-01T00:00:00.000Z', dir) === null && consolidatedIdOf('seq:1', dir) === null)
_resetMemoryVerbSessionStateForTesting()
const followedRead = readMemoryRecord(pendingId, dir)
check('Recall(read) of the stale pending id follows it to the consolidated row', followedRead.found === true && followedRead.id === `seq:${seq}` && followedRead.content?.includes(FACT) === true, j(followedRead))
check('its note names the follow and that amend is unlocked for the seq', followedRead.note?.startsWith(`followed ${pendingId} → seq:${seq}; full record read — amend is now unlocked`) === true, String(followedRead.note))
check('the followed row counts as read in full (an amend on it will not be refused as unseen)', hasSeenFullRow(seq))
const gone = readMemoryRecord('pending:2026-01-01T00:00:00.000Z', dir)
check('a pending id that never existed still reads as gone', gone.found === false && gone.note?.includes('gone') === true, j(gone))
_resetMemoryVerbSessionStateForTesting()
const retracted = await CorrectTool.call({ op: 'retract', id: pendingId, reason: 'the deploy moved to Thursday' }, context(), undefined, undefined)
const retractedData = (retracted as { data: { ok: boolean; targetSeq?: number; newSeq?: number; followed?: string; code?: string } }).data
check('retract aimed at the stale pending id lands on the consolidated fact, with history', retractedData.ok === true && retractedData.targetSeq === seq && typeof retractedData.newSeq === 'number', j(retractedData))
check('the outcome says what it followed', retractedData.followed === `${pendingId} had consolidated as seq:${seq}; the correction followed it`, j(retractedData))
check('the old record went to history, never deleted', historyEntries().some(e => e.seq === seq && e.text === FACT), j(historyEntries()))
const historyRead = readMemoryRecord(`seq:${seq}`, dir)
check('Recall(read) of the superseded seq shows the row but says it is history, naming the current seq', historyRead.found === true && historyRead.note?.startsWith(`this row is history, not the current record — superseded by seq:${retractedData.newSeq}; read or correct seq:${retractedData.newSeq} instead`) === true && !historyRead.note.includes('amend is now unlocked'), String(historyRead.note))
const tombstoneRead = readMemoryRecord(`seq:${retractedData.newSeq}`, dir)
check('the retire tombstone reads as history too, with no current seq to point at', tombstoneRead.found === true && tombstoneRead.note === 'this row is history, not the current record; doc:deployment › history', String(tombstoneRead.note))
const SECOND = 'the staging deploy runs from main every weekday morning'
const second = retainItems([{ content: SECOND, topic: 'deployment' }], { session: 'follow-seed' }, dir)
check('a second fact consolidates onto the same page', second[0]?.status === 'stored' && maybeConsolidate({ force: true, dir }).consolidated === true, j(second))
const liveSeq = liveEntries().find(e => e.text === SECOND)?.seq ?? -1
const liveRead = readMemoryRecord(`seq:${liveSeq}`, dir)
check('a live row still reads with amend unlocked', liveSeq > 0 && liveRead.found === true && liveRead.note?.startsWith('full record read — amend is now unlocked') === true, String(liveRead.note))
const words = resultOf(retractedData)
check('the tool result tells the model the correction followed the consolidation', words.content.includes(`retract landed: seq ${seq} →`) && words.content.includes(`(${pendingId} had consolidated as seq:${seq}; the correction followed it)`) && words.is_error !== true, words.content)
_resetMemoryVerbSessionStateForTesting()
const unknown = await CorrectTool.call({ op: 'retract', id: 'pending:2026-01-01T00:00:00.000Z', reason: 'tidying' }, context(), undefined, undefined)
const unknownData = (unknown as { data: { ok: boolean; code?: string; followed?: string } }).data
check('a pending id that never existed is still refused as unknown-target, nothing followed', unknownData.ok === false && unknownData.code === 'unknown-target' && unknownData.followed === undefined, j(unknownData))

section('§2 the user\'s No on the rule card is a plain result, never an error')
const kept = { ok: false as const, op: 'retract' as const, code: 'user-kept-rule', message: 'the user kept the rule — seq 2 stays as it is, word for word; nothing changed' }
const keptWords = resultOf(kept)
check('the model reads "the user kept the rule" as an ordinary result', keptWords.content === kept.message && keptWords.is_error === undefined, j(keptWords))
const drawn = renderCorrectResult(kept)
const drawnText = JSON.stringify(drawn)
check('the chat row says you kept the rule and carries no refusal or error words', drawnText.includes('rule kept') && drawnText.includes('you kept the rule; nothing changed') && !drawnText.includes('refused') && !drawnText.includes('warning'), drawnText.slice(0, 400))
const refused = resultOf({ ok: false, op: 'retract', code: 'unknown-target', message: 'no pending row' })
check('every other refusal still reaches the model as an error', refused.content.startsWith('retract refused (unknown-target)') && refused.is_error === true, j(refused))

section('§3 the contradiction advice makes the call the user\'s')
const reason = conflictReason({ entry: { id: 'pending:1', kind: 'pending', asked: false, text: 'we test with pytest here' }, overlap: 1, flip: 'a negation' })
check('the refusal asks the user which is true and names the two roads on their word', reason === 'conflicts with a pending fact: "we test with pytest here": ask the user which is true; on their word, Correct pending:1 with their reason, or retain both with the difference stated (when, where, which)', reason)
check('the advice never tells the model to act on the evidence alone', !reason.includes('evidence') && !reason.includes('supersede'))

releaseScratchHome(HOME)
console.log(`\ncorrect follows consolidation: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
