#!/usr/bin/env bun
// gate-watch: src/mneme/memoryVerbs.ts src/mneme/mnemeCorrect.ts src/mneme/mnemeBuffer.ts src/mneme/mnemeSecretGuard.ts src/tools/MemoryTools/MemoryTools.ts src/tools/MemoryTools/prompt.ts src/utils/detectSecrets.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-secret-draft-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { retainItems, correctMemory, readMemoryRecord, recallQuery, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.js')
const { appendObservation, pendingRows, currentBufferPath } = await import('../../src/mneme/mnemeBuffer.js')
const { correctFact } = await import('../../src/mneme/mnemeCorrect.js')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.js')
const { RetainTool, CorrectTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')
const { CORRECT_PROMPT, RETAIN_PROMPT } = await import('../../src/tools/MemoryTools/prompt.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')

const dir = mnemeLibraryDir()
const libraryBytes = (): string => {
  if (!existsSync(dir)) return ''
  return readdirSync(dir).filter(name => name.endsWith('.jsonl') || name.endsWith('.md')).map(name => readFileSync(join(dir, name), 'utf8')).join('\n')
}
const GITHUB = 'ghp_LiveTestFake0000000000000000000000ZZ'
const AWS_ID = 'AKIAIOSFODNN7EXAMPLE'

section('§1 a secret-shaped value is refused with a plain reason; the disk never holds it')
const secret = retainItems([{ content: `the CI token is ${GITHUB}`, context: 'User-supplied throwaway test token, session 9' }], { session: 'secret-draft' }, dir)
check('the GitHub-shaped token is refused, not stored', secret[0]?.status === 'refused', JSON.stringify(secret[0]).slice(0, 300))
const why = secret[0]?.status === 'refused' ? secret[0].reason : ''
check('the reason says it looks like a secret and names the kind, in plain words', /looks like a secret/.test(why) && why.includes('github-token') && /plain-text record/.test(why), why)
check('the reason never echoes the token', !why.includes(GITHUB) && !why.includes('LiveTestFake'), why)
const aws = retainItems([{ content: `the deploy user's access key id is ${AWS_ID}` }, { content: 'the deploy user is called deploy-bot' }], { session: 'secret-draft' }, dir)
check('an AWS access key id is refused while the plain sibling in the same batch is stored', aws[0]?.status === 'refused' && aws[1]?.status === 'stored', JSON.stringify(aws).slice(0, 300))
check('no library file holds either secret', !libraryBytes().includes('ghp_') && !libraryBytes().includes(AWS_ID), libraryBytes().slice(0, 200))
const { detectSecrets } = await import('../../src/utils/detectSecrets.js')
const kinds = (text: string): string => detectSecrets(text).map(hit => hit.kind).join(',')
check('an Anthropic key is reported only as anthropic-key, never also as an OpenAI key (F43A-C5-23)', kinds('key sk-ant-api03-LiveTestFake00000000000000000000') === 'anthropic-key', kinds('key sk-ant-api03-LiveTestFake00000000000000000000'))
check('…while an OpenAI key, a short sk-ant- prefix and a text carrying both keep their kinds', kinds('key sk-proj-LiveTestFake0000000000000000000') === 'openai-key' && kinds('key sk-ant-LiveTestFake0000') === 'openai-key' && kinds('a sk-ant-api03-LiveTestFake00000000000000000000 and b sk-proj-LiveTestFake0000000000000000000') === 'anthropic-key,openai-key', [kinds('key sk-proj-LiveTestFake0000000000000000000'), kinds('key sk-ant-LiveTestFake0000')].join(' | '))
const block = RetainTool.mapToolResultToToolResultBlockParam({ outcomes: secret, stored: 0, refused: 1 }, 'tid')
check('the tool answer is an error that says the fact was NOT stored and why', (block as { is_error?: boolean }).is_error === true && String(block.content).includes('looks like a secret') && String(block.content).includes('NOT stored'), String(block.content))
check('the Retain prompt names the refusal so the model never promises a store it cannot make', /looks like a key, a token or a password is refused by the tool itself/.test(RETAIN_PROMPT), RETAIN_PROMPT.split('\n').find(l => /secret/.test(l)) ?? '')

section('§2 "forget it" strikes a pending row: a draft leaves no history and no bytes')
_resetMemoryVerbSessionStateForTesting()
const draft = retainItems([{ content: 'the staging server is called stagebox-1', topic: 'servers' }], { session: 'secret-draft' }, dir)
const draftId = draft[0]?.status === 'stored' ? draft[0].id : ''
check('a plain fact lands as a pending row', draftId.startsWith('pending:'), JSON.stringify(draft[0]))
const struck = correctMemory({ op: 'retract', id: draftId, reason: 'the user asked to forget it', session: 'secret-draft' }, dir)
check('retract on the pending id lands as a strike', struck.ok === true && struck.op === 'retract' && (struck as { draft?: boolean }).draft === true, JSON.stringify(struck))
check('the row is gone from the pending rows', !pendingRows(dir).some(r => r.text.includes('stagebox-1')), JSON.stringify(pendingRows(dir).map(r => r.text)))
check('its bytes are gone from the buffer file', !readFileSync(currentBufferPath(dir), 'utf8').includes('stagebox-1'))
check('a read of the struck id says it is gone', readMemoryRecord(draftId, dir).found === false)
const struckBlock = CorrectTool.mapToolResultToToolResultBlockParam(struck, 'tid')
check('the tool answer says the draft was struck and leaves no history', String(struckBlock.content).includes('struck') && /no history/.test(String(struckBlock.content)), String(struckBlock.content))
const other = pendingRows(dir).find(r => r.text.includes('deploy-bot'))
check('the other pending rows survive the strike', other !== undefined, JSON.stringify(pendingRows(dir).map(r => r.text)))

section('§3 a plain-words correction of a pending row: the draft is replaced, and consolidation lands ONE fact')
_resetMemoryVerbSessionStateForTesting()
const v1 = retainItems([{ content: 'the hunt API lives at https://api.hunt-verbs.example/v1', topic: 'api' }], { session: 'secret-draft' }, dir)
const v1Id = v1[0]?.status === 'stored' ? v1[0].id : ''
const fixed = correctMemory({ op: 'supersede', id: v1Id, content: 'the hunt API lives at https://api.hunt-verbs.example/v2', reason: 'the user said v1 was wrong', session: 'secret-draft' }, dir)
check('supersede on the pending id lands with a new pending id', fixed.ok === true && (fixed as { newId?: string | null }).newId?.startsWith('pending:') === true, JSON.stringify(fixed))
check('the old draft is gone, the new one carries the topic', !pendingRows(dir).some(r => r.text.includes('/v1')) && pendingRows(dir).some(r => r.text.includes('/v2') && r.topicHint === 'api'), JSON.stringify(pendingRows(dir)))
check('the old words stay on disk only as the new draft\'s history pointer', libraryBytes().includes('example/v1') && pendingRows(dir).find(r => r.text.includes('/v2'))?.history?.text.includes('example/v1') === true && pendingRows(dir).find(r => r.text.includes('/v2'))?.history?.ts === v1Id.slice('pending:'.length), JSON.stringify(pendingRows(dir)))
maybeConsolidate({ force: true, dir })
const apiDoc = listTopicDocs(dir).find(d => d.slug === 'api')
const live = apiDoc ? apiDoc.sections.flatMap(s => s.entries) : []
check('after consolidation the topic holds one current fact (v2) and no history', live.length === 1 && live[0]!.text.includes('/v2') && (apiDoc?.history.length ?? 0) === 0, JSON.stringify({ live: live.map(e => e.text), history: apiDoc?.history.length }))
check('after consolidation nothing on disk says /v1 any more', !libraryBytes().includes('example/v1'))
check('recall finds v2 and not v1', recallQuery('hunt API', { dir }).hits.some(h => h.preview.includes('/v2')) && !recallQuery('hunt API', { dir }).hits.some(h => h.preview.includes('/v1')))

section('§4 amend on a draft keeps the evidence law: read the full row first')
_resetMemoryVerbSessionStateForTesting()
const note = retainItems([{ content: 'the build runs on bun one point three', topic: 'build' }], { session: 'secret-draft' }, dir)
const noteId = note[0]?.status === 'stored' ? note[0].id : ''
const blind = correctMemory({ op: 'amend', id: noteId, content: 'the build runs on bun 1.3', reason: 'wording', session: 'secret-draft' }, dir)
check('amend without the read refuses with the unseen-evidence code and names the read', blind.ok === false && blind.code === 'unseen-evidence' && blind.message.includes(`read:"${noteId}"`), JSON.stringify(blind))
readMemoryRecord(noteId, dir)
const amended = correctMemory({ op: 'amend', id: noteId, content: 'the build runs on bun 1.3', reason: 'wording', session: 'secret-draft' }, dir)
check('after the read the same amend lands as a replaced draft', amended.ok === true && pendingRows(dir).some(r => r.text.includes('bun 1.3')) && !pendingRows(dir).some(r => r.text.includes('one point three')), JSON.stringify(amended))

section('§5 the secret guard holds at every write door: Correct content and the memory centre\'s correction')
const viaCorrect = correctMemory({ op: 'supersede', id: amended.ok ? (amended as { newId?: string | null }).newId ?? '' : '', content: `the build token is ${GITHUB}`, reason: 'x', session: 'secret-draft' }, dir)
check('a secret in Correct content is refused, typed', viaCorrect.ok === false && viaCorrect.code === 'secret' && /looks like a secret/.test(viaCorrect.message), JSON.stringify(viaCorrect))
const seq = live[0]?.seq ?? 0
const viaCentre = correctFact({ targetSeq: seq, text: `the API key is ${AWS_ID}`, source: 'operator', byUser: true, dir })
check('a secret typed into the centre\'s correction is refused, typed', viaCentre.ok === false && viaCentre.code === 'secret', JSON.stringify(viaCentre))
check('still nothing on disk carries a secret', !libraryBytes().includes('ghp_') && !libraryBytes().includes(AWS_ID))

section('§6 a pending rule the user asked for stays the user\'s; a pending id naming no row is typed')
appendObservation({ text: 'always answer in British English', source: 'tool:Retain s:user', pin: true, asked: true }, dir)
const askedRow = pendingRows(dir).find(r => r.asked === true)!
const askedRefusal = correctMemory({ op: 'retract', id: `pending:${askedRow.ts}`, reason: 'x', session: 'secret-draft' }, dir)
check('the model\'s strike of a pending asked-for rule is refused and names /memory', askedRefusal.ok === false && askedRefusal.code === 'user-asked-rule' && askedRefusal.message.includes('/memory'), JSON.stringify(askedRefusal))
const unknown = correctMemory({ op: 'retract', id: 'pending:2026-01-01T00:00:00.000Z', reason: 'x', session: 'secret-draft' }, dir)
check('an unknown pending id is a typed unknown-target that says to recall again', unknown.ok === false && unknown.code === 'unknown-target', JSON.stringify(unknown))

section('§7 a strike reaches a row stranded in a consuming-* file and spares every other row')
appendObservation({ text: 'row kept one', source: 'proof' }, dir)
writeFileSync(join(dir, 'consuming-9999-zz.jsonl'), `${JSON.stringify({ ts: '2026-10-12T00:00:00.000Z', source: 'proof', text: 'stranded secretless row to strike' })}\n${JSON.stringify({ ts: '2026-10-12T00:00:01.000Z', source: 'proof', text: 'stranded row kept' })}\n`)
appendObservation({ text: 'row kept two', source: 'proof' }, dir)
const stranded = correctMemory({ op: 'retract', id: 'pending:2026-10-12T00:00:00.000Z', reason: 'x', session: 'secret-draft' }, dir)
const texts = pendingRows(dir).map(r => r.text)
check('the stranded row is struck', stranded.ok === true && !texts.includes('stranded secretless row to strike'), JSON.stringify(texts))
check('every other row, in the consuming file and the buffer, survives', texts.includes('stranded row kept') && texts.includes('row kept one') && texts.includes('row kept two'), JSON.stringify(texts))

section('§7b every pending id names exactly one row: back-to-back appends carry distinct times; a hand-made duplicate is refused, nothing struck')
const burst = retainItems(Array.from({ length: 6 }, (_, i) => ({ content: `burst fact number ${i}` })), { session: 'secret-draft' }, dir)
const burstIds = burst.map(o => (o.status === 'stored' ? o.id : ''))
check('six facts stored in one call carry six distinct pending ids', burstIds.every(id => id.startsWith('pending:')) && new Set(burstIds).size === 6, JSON.stringify(burstIds))
const twin = '2026-10-12T00:00:02.000Z'
appendFileSync(currentBufferPath(dir), `${JSON.stringify({ ts: twin, source: 'proof', text: 'twin row one' })}\n${JSON.stringify({ ts: twin, source: 'proof', text: 'twin row two' })}\n`, 'utf8')
const ambiguous = correctMemory({ op: 'retract', id: `pending:${twin}`, reason: 'x', session: 'secret-draft' }, dir)
check('a pending id two rows share is refused as ambiguous and nothing is struck', ambiguous.ok === false && ambiguous.code === 'invalid' && /share the time/.test(ambiguous.message) && pendingRows(dir).filter(r => r.ts === twin).length === 2, JSON.stringify(ambiguous))

section('§8 the Correct prompt tells the model the draft road')
check('the prompt says a pending row is a draft: retract strikes it, supersede or amend replaces it, history is for consolidated rows', /pending:<ts>/.test(CORRECT_PROMPT) && /draft/.test(CORRECT_PROMPT) && /struck/.test(CORRECT_PROMPT), CORRECT_PROMPT.split('\n').find(l => /pending/.test(l)) ?? '')

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL SECRET-AND-DRAFT PROOFS PASS' : `❌ ${failures} SECRET-AND-DRAFT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
