#!/usr/bin/env bun
// gate-watch: src/sessions/mneme/mnemeHandover.ts src/sessions/mneme/mnemeMaintenance.ts src/sessions/mneme/mnemeBuffer.ts
// gate-watch: src/sessions/mneme/memoryVerbs.ts src/sessions/mneme/mnemeConsolidate.ts src/screen/status-notices/statusNoticeDefinitions.tsx
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-memory-intake-'))
const home = join(scratch, 'home')
process.env.MERCURY_CONFIG_DIR = home

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

let intake: typeof import('../../src/sessions/mneme/mnemeHandover.js') | null = null
try {
  intake = await import('../../src/sessions/mneme/mnemeHandover.js')
} catch {
  intake = null
}
check('the intake module exists', intake !== null)
if (!intake) {
  console.log('\n❌ INTAKE: the module is absent — nothing more can be checked')
  process.exit(1)
}
const { handoverIfDue, handoverMemoryDir, handoverDue, readHandoverReceipt, listOldNotes, chunkNote, renderHandoverReceipt } = intake
const { listTopicDocs, listArchiveDocs } = await import('../../src/sessions/mneme/mnemeConsolidate.js')
const { readPins, pinFact } = await import('../../src/sessions/mneme/mnemeUsage.js')
const { readFrontPage, readPinnedStatus } = await import('../../src/sessions/mneme/mnemeFrontPage.js')
const { readBuffer } = await import('../../src/sessions/mneme/mnemeBuffer.js')
const { seqCensus } = await import('../../src/sessions/mneme/mnemeArchive.js')

function note(name: string, type: string | null, body: string, extraHead = ''): [string, string] {
  const head = type ? `---\nname: ${name}\ndescription: ${name.replace(/-/g, ' ')}\ntype: ${type}\n${extraHead}---\n\n` : ''
  return [`${name}.md`, `${head}${body}\n`]
}

const projectMem = join(home, 'projects', '-Users-someone-code-app', 'memory')
mkdirSync(projectMem, { recursive: true })
const longBody = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of a long project note that carries detail worth keeping.`).join(' ')
const files: Array<[string, string]> = [
  ['MEMORY.md', '# MEMORY.md\n- [Owner names models](feedback-owner-names-models.md) — use the named model\n- [Deploy](project-deploy.md) — deploy from working\n'],
  note('feedback-owner-names-models', 'feedback', 'Use the model the owner names for every lane.\n\n**Why:** the owner rules on models.\n**How to apply:** never substitute.'),
  note('feedback-ask-before-lanes', 'feedback', 'Ask before launching new lanes; do ordered work now.'),
  note('feedback-plain-words', 'feedback', 'Report to the owner in plain words: what happened, the release effect, then his part.'),
  note('user-role', 'user', 'The user is a layman in the technical part and wants layman briefs.'),
  note('project-deploy', 'project', 'The runtime is deployed from the mercury-working checkout after the gate, never from a worktree.'),
  note('project-release', 'project', 'The release page carries Added and Fixed lines only, in the register of the previous page.'),
  note('reference-handbook', 'reference', 'The handbook lives at /Users/someone/handbook and holds the lane briefs.'),
  note('card-flaky-clock', null, `---\nname: card-flaky-clock\ndescription: a proof clock lesson\nmetadata:\n  type: experience-card\n  approved: false\n---\n\nA proof that reads red under load has a clock defect: scale the budget, never shrink it.`),
  note('project-long', 'project', longBody),
  note('untyped-note', null, 'A note with no header at all.'),
  note('feedback-header-only', 'feedback', ''),
  ['empty-note.md', ''],
  ['feedback-old.superseded.20260901.md', '---\nname: feedback-old\ntype: feedback\n---\n\nAn audit copy that must never be taken.\n'],
  ['TASTE.md', '# TASTE\n- a promoted lesson mirror\n'],
]
for (const [name, body] of files) writeFileSync(join(projectMem, name), body)
mkdirSync(join(projectMem, 'logs', '2026', '09'), { recursive: true })
writeFileSync(join(projectMem, 'logs', '2026', '09', '2026-09-30.md'), '# daily log\n')
const before = new Map(readdirSync(projectMem).map(n => [n, statSync(join(projectMem, n)).isFile() ? readFileSync(join(projectMem, n), 'utf8') : '']))
const mtimes = new Map(readdirSync(projectMem).map(n => [n, statSync(join(projectMem, n)).mtimeMs]))

section('the first open of a project with old notes hands every note to memory through retain, once')
check('the intake is due on a project with old notes and no marker', handoverDue(projectMem) === true, '', 'handoverDue in src/sessions/mneme/mnemeHandover.ts must report due when the memory folder holds old notes and no marker')
check('the index, the audit copy and the taste mirror are not notes', !listOldNotes(projectMem).some(n => n === 'MEMORY.md' || n.includes('.superseded.') || n === 'TASTE.md'), '', 'listOldNotes in src/sessions/mneme/mnemeHandover.ts must leave out the index, audit copies and the taste mirror')
const T0 = new Date('2026-10-02T09:00:00.000Z')
const receipt = handoverIfDue(projectMem, T0)
check('a receipt comes back', receipt !== null, JSON.stringify(receipt), 'handoverIfDue in src/sessions/mneme/mnemeHandover.ts must return a receipt on the first open of a folder with old notes')
check('eleven notes were taken (the empty one skipped, the index/audit copy/taste mirror never counted)', receipt?.notes === 11, JSON.stringify(receipt), 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must take every note except empty ones, the index, audit copies and the taste mirror (listOldNotes in the same file)')
const longChunks = chunkNote(longBody).length
check('a long note is kept whole as numbered parts, nothing dropped for size', longChunks > 1 && receipt?.facts === 10 + longChunks, `${longChunks} parts, ${receipt?.facts} facts`, 'chunkNote in src/sessions/mneme/mnemeHandover.ts must keep a long note whole as numbered parts, and handoverMemoryDir must count each part as a fact')
check('the five rulings and preferences landed pinned', receipt?.pinned === 5 && receipt.pages['preferences'] === 5, JSON.stringify(receipt?.pages), 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must pin feedback and user notes onto the preferences page')
check('project facts landed on the project page', receipt?.pages['project'] === 2 + longChunks, '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must send project notes to the project page')
check('the reference landed on the references page', receipt?.pages['references'] === 1, '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must send reference notes to the references page')
check('the lesson landed on the lessons page', receipt?.pages['lessons'] === 1, '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must send experience cards to the lessons page')
check('the untyped note landed on the notes page', receipt?.pages['notes'] === 1, '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must send a note with no type to the notes page')
check('the empty note is named in the receipt as skipped', receipt?.skipped.some(s => s.file === 'empty-note.md' && s.reason === 'empty') === true, '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must list an empty note in the receipt skipped list with reason empty')
check('the facts were consolidated into pages at once', receipt?.consolidated === true, '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must run the consolidation after retaining the notes')

const lib = join(projectMem, 'library')
const pages = listTopicDocs(lib)
check('the library holds the five pages', ['preferences', 'project', 'references', 'lessons', 'notes'].every(slug => pages.some(p => p.slug === slug)), pages.map(p => p.slug).join(','))
check('a page carries the summary memory gave it', pages.find(p => p.slug === 'preferences')?.summary.includes('standing rules and preferences') === true, '', 'the intake in src/sessions/mneme/mnemeHandover.ts must give the preferences page its summary')
const pinned = readPins(lib)
check('the pinned tier holds exactly the five rulings', pinned.length === 5, '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must pin only the feedback and user notes')
check('the header-only note landed as its description, pinned', pages.find(p => p.slug === 'preferences')?.sections.some(s => s.entries.some(e => e.text === 'feedback header only' && e.source === 'handover:feedback-header-only')) === true && pinned.some(p => pages.find(d => d.slug === 'preferences')?.sections.some(s => s.entries.some(e => e.seq === p.seq && e.text === 'feedback header only'))), '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must take the description of a header-only note as its text and pin it')
const front = readFrontPage(lib) ?? ''
check('the pinned rules are in front of the model word for word, behind the plain-pin grade (an intake pin is not an owner-asked rule)', front.includes('- [pinned · owner intent unverified] Use the model the owner names for every lane. **Why:** the owner rules on models. **How to apply:** never substitute. <seq='), front.split('\n').find(l => l.includes('Use the model the owner names')) ?? '(no pinned line)', 'the intake in src/sessions/mneme/mnemeHandover.ts must pin through the retain path without the asked mark so the front page shows the plain-pin grade')
check('the index names the pages, never the facts', /^- project — ongoing project facts/m.test(front) && !front.includes('mercury-working checkout'), '', 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must list pages in the index and keep fact text off it')
check('the index pointer lines were not taken as facts', !front.includes('[Owner names models]') && !pages.some(p => p.sections.some(s => s.entries.some(e => e.text.includes('[Owner names models]')))), '', 'listOldNotes in src/sessions/mneme/mnemeHandover.ts must not hand the MEMORY.md index pointer lines to memory as facts')
check('every fact carries the note it came from as its source', pages.every(p => p.sections.every(s => s.entries.every(e => e.source.startsWith('handover:')))), '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must give every retained fact the source handover: followed by the note name')

section('once, and nothing of anyone\'s is deleted')
check('a marker records that the intake ran', readHandoverReceipt(lib)?.ranAt === T0.toISOString(), '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must write the receipt marker with ranAt set to the run time')
check('the intake is no longer due', handoverDue(projectMem) === false, '', 'handoverDue in src/sessions/mneme/mnemeHandover.ts must report not due once the receipt marker exists')
const again = handoverIfDue(projectMem, new Date(T0.getTime() + 1000))
check('a second open takes nothing more', again === null && readBuffer(lib).length === 0 && seqCensus(listTopicDocs(lib)).split(',').length === receipt?.facts, '', 'handoverIfDue in src/sessions/mneme/mnemeHandover.ts must return null and retain nothing once the marker exists')
const forced = handoverMemoryDir(projectMem, new Date(T0.getTime() + 2000))
check('calling the intake again returns the same receipt without re-reading', forced.ranAt === T0.toISOString(), '', 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must return the stored receipt when the marker already exists')
const after = new Map(readdirSync(projectMem).filter(n => n !== 'library').map(n => [n, statSync(join(projectMem, n)).isFile() ? readFileSync(join(projectMem, n), 'utf8') : '']))
check('every old file is still on disk with the same bytes', [...before.entries()].every(([n, body]) => after.get(n) === body) && after.size === before.size, '', 'the intake in src/sessions/mneme/mnemeHandover.ts must only read the old notes and never write into or delete them')
check('no old file was rewritten', [...mtimes.entries()].every(([n, m]) => statSync(join(projectMem, n)).mtimeMs === m), '', 'the intake in src/sessions/mneme/mnemeHandover.ts must not touch the old note files')
check('the receipt renders for the memory centre', renderHandoverReceipt(receipt!)[0]!.startsWith('11 notes → ') && renderHandoverReceipt(receipt!)[1]!.startsWith('pages:'), '', 'renderHandoverReceipt in src/sessions/mneme/mnemeHandover.ts must print the notes line first and the pages line second')
check('no archive page was made of fresh facts', listArchiveDocs(lib).length === 0, '', 'the consolidation run by the intake must not archive facts that were just retained')

section('a first intake past the pinned limit keeps every rule loaded and says so once per session')
const bigMem = join(home, 'projects', '-Users-someone-code-big', 'memory')
mkdirSync(bigMem, { recursive: true })
const BIG = 40
for (let i = 0; i < BIG; i++) {
  const [name, body] = note(`feedback-rule-${String(i).padStart(2, '0')}`, 'feedback', `Standing rule ${i}: do the thing ${i} this way, every time, with the long explanation of why that fills the shelf with text (${'x'.repeat(200)}).`)
  writeFileSync(join(bigMem, name), body)
}
const bigReceipt = handoverIfDue(bigMem, T0)
check(`all ${BIG} rules landed pinned`, bigReceipt?.pinned === BIG, JSON.stringify(bigReceipt), 'handoverMemoryDir in src/sessions/mneme/mnemeHandover.ts must pin every feedback note however much pinned text results')
const bigLib = join(bigMem, 'library')
const bigStatus = readPinnedStatus(bigLib)
check('every rule is loaded and the shelf is over its text limit', bigStatus?.loaded.length === BIG && bigStatus.over === true && bigStatus.used > bigStatus.limit, JSON.stringify(bigStatus), 'renderFrontPage in src/sessions/mneme/mnemeFrontPage.ts must load every pinned rule and set status.over when the pinned text passes the limit')
check('the front page carries all of them', (readFrontPage(bigLib) ?? '').includes(`Standing rule ${BIG - 1}:`))
check('an intake pin is not marked as asked for by the user', bigStatus?.asked.length === 0, '', 'the intake in src/sessions/mneme/mnemeHandover.ts must not set asked on the pins it makes')
const extraSeq = listTopicDocs(bigLib)[0]!.sections[0]!.entries[0]!.seq
check('a later pin is still never refused', pinFact(extraSeq, bigLib).ok === true, '', 'pinFact in src/sessions/mneme/mnemeUsage.ts must accept a pin past the text limit')
const { pinnedOverLimitLine } = await import('../../src/screen/status-notices/statusNoticeDefinitions.js')
check('the calm line names the count, the fill, the limit, that all are loaded, and both ways out',
  pinnedOverLimitLine({ pinned: bigStatus?.pinned ?? 0, used: bigStatus?.used ?? 0, limit: bigStatus?.limit ?? 0 }).startsWith(`Pinned memory: ${BIG} rules, `) &&
    pinnedOverLimitLine({ pinned: 1, used: 9600, limit: 8000 }) === 'Pinned memory: 1 rule, 9.6k of the 8k limit — all still loaded. Trim in /memory or raise the limit in /config.')


console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ THE INTAKE HANDS EVERY NOTE TO MEMORY ONCE' : `❌ ${failures} INTAKE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
