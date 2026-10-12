#!/usr/bin/env bun
// gate-watch: src/mneme/mnemeBuffer.ts src/mneme/memoryVerbs.ts src/tools/MemoryTools/MemoryTools.ts src/tools/MemoryTools/prompt.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-retain-whole-'))
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

const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.js')
const { appendObservation, pendingRows, currentBufferPath } = await import('../../src/mneme/mnemeBuffer.js')
const { RetainTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')
const { RETAIN_PROMPT } = await import('../../src/tools/MemoryTools/prompt.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')

const dir = mnemeLibraryDir()
const diskText = (): string => (existsSync(currentBufferPath(dir)) ? readFileSync(currentBufferPath(dir), 'utf8') : '')
const fingerprints = (count: number): string => Array.from({ length: count }, (_, i) => `K${String(i + 1).padStart(3, '0')}=${(i * 2654435761 % 4294967296).toString(16).padStart(8, '0')}${'0123456789abcdef'.slice(i % 16).padEnd(16, 'a')}`).join(' ')
const padTo = (head: string, length: number, tail: string): string => `${head} ${'x'.repeat(Math.max(0, length - head.length - tail.length - 2))} ${tail}`

section('§1 the field case: a 2,920-character fact is refused whole, with its count and the limit; the disk holds none of it')
const marker = 'END-MARKER-LIVE-RND'
const long = padTo(`signing key fingerprints for the release machines: ${fingerprints(60)}`, 2920, marker)
check('the fixture is 2,920 characters and ends with the marker', long.length === 2920 && long.endsWith(marker), String(long.length))
const before = pendingRows(dir).length
const refused = retainItems([{ content: long, topic: 'release-signing-keys' }], { session: 'whole-or-refused' }, dir)
check('the outcome is a typed refusal, not "stored"', refused[0]?.status === 'refused', JSON.stringify(refused[0]).slice(0, 300))
const reason = refused[0]?.status === 'refused' ? refused[0].reason : ''
check('the reason carries the count and the limit', reason.includes('2,920 characters') && reason.includes('the limit is 2,000'), reason)
check('no row landed in the buffer', pendingRows(dir).length === before, `${before} → ${pendingRows(dir).length}`)
check('the disk holds no piece of the text — not even a cut one', !diskText().includes('signing key fingerprints') && !diskText().includes('…'), diskText().slice(0, 200))

section('§2 a fact at the limit is stored whole — the last character included, no ellipsis')
_resetMemoryVerbSessionStateForTesting()
const exact = padTo('the release checklist in full:', 2000, 'END-MARKER-AT-CAP')
check('the fixture is exactly 2,000 characters', exact.length === 2000, String(exact.length))
const stored = retainItems([{ content: exact }], { session: 'whole-or-refused' }, dir)
check('the outcome is stored', stored[0]?.status === 'stored', JSON.stringify(stored[0]).slice(0, 200))
const row = pendingRows(dir).at(-1)
check('the row on disk is the text word for word, ending with the marker', row?.text === exact && row.text.endsWith('END-MARKER-AT-CAP') && !row.text.includes('…'), `${row?.text.length} chars, tail ${JSON.stringify(row?.text.slice(-30))}`)

section('§3 the context counts toward the limit: content under it, content and context over it, refused with the whole count')
_resetMemoryVerbSessionStateForTesting()
const nearly = padTo('a decision:', 1990, 'END-NEARLY')
const storedForm = `${nearly} (context: said in the planning call)`
check('the stored form runs over the limit', storedForm.length === 2027, String(storedForm.length))
const withContext = retainItems([{ content: nearly, context: 'said in the planning call' }], { session: 'whole-or-refused' }, dir)
check('refused, the count naming the stored form (content and its context)', withContext[0]?.status === 'refused' && withContext[0].reason.includes('2,027 characters with its context') && withContext[0].reason.includes('the limit is 2,000'), JSON.stringify(withContext[0]).slice(0, 300))
const batch = retainItems([{ content: long }, { content: 'a short fact beside the long one' }], { session: 'whole-or-refused' }, dir)
check('a batch keeps its honest siblings: the long item refused, the short one stored', batch[0]?.status === 'refused' && batch[1]?.status === 'stored', JSON.stringify(batch).slice(0, 300))

section('§4 the tool answer the model reads agrees with the disk')
const block = RetainTool.mapToolResultToToolResultBlockParam({ outcomes: refused, stored: refused.filter(o => o.status === 'stored').length, refused: refused.filter(o => o.status === 'refused').length }, 'tid')
const content = String(block.content)
check('the result is an error block that says 0 stored · 1 refused', (block as { is_error?: boolean }).is_error === true && content.startsWith('0 stored · 1 refused'), content.slice(0, 120))
check('the result names the count, the limit and that the fact was NOT stored', content.includes('2,920 characters') && content.includes('the limit is 2,000') && content.includes('NOT stored'), content)
check('the Retain prompt tells the model the limit and that nothing is ever cut', RETAIN_PROMPT.includes('2,000 characters') && /never cut/.test(RETAIN_PROMPT), RETAIN_PROMPT.split('\n').find(l => l.includes('2,000')) ?? '(no limit line)')

section('§5 the buffer law for every caller: an over-limit observation is not written, cut or whole')
const direct = appendObservation({ text: long, source: 'proof' }, dir)
check('appendObservation answers false for over-limit text', direct === false)
check('and writes nothing', !diskText().includes('signing key fingerprints'))
const nearlyDirect = appendObservation({ text: `line one\nline two ${'y'.repeat(1980)}`, source: 'proof' }, dir)
check('text that fits once its newlines are flattened is written whole', nearlyDirect === true && pendingRows(dir).at(-1)?.text.startsWith('line one line two') === true)

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL RETAIN-WHOLE-OR-REFUSED PROOFS PASS' : `❌ ${failures} RETAIN-WHOLE-OR-REFUSED PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
