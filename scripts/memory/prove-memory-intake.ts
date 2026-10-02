#!/usr/bin/env bun
// gate-watch: src/memdir/mnemeHandover.ts src/memdir/mnemeMaintenance.ts src/memdir/mnemeBuffer.ts
// gate-watch: src/memdir/memoryVerbs.ts src/memdir/mnemeConsolidate.ts src/utils/statusNoticeDefinitions.tsx
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-memory-intake-'))
const home = join(scratch, 'home')
process.env.MERCURY_CONFIG_DIR = home

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

let intake: typeof import('../../src/memdir/mnemeHandover.js') | null = null
try {
  intake = await import('../../src/memdir/mnemeHandover.js')
} catch {
  intake = null
}
check('the intake module exists', intake !== null)
if (!intake) {
  console.log('\n❌ INTAKE: the module is absent — nothing more can be checked')
  process.exit(1)
}
const { handoverIfDue, handoverMemoryDir, handoverDue, readHandoverReceipt, handoverHome, listOldNotes, chunkNote, renderHandoverReceipt } = intake
const { listTopicDocs, listArchiveDocs } = await import('../../src/memdir/mnemeConsolidate.js')
const { readPins, pinFact } = await import('../../src/memdir/mnemeUsage.js')
const { readFrontPage, readPinnedStatus } = await import('../../src/memdir/mnemeFrontPage.js')
const { readBuffer } = await import('../../src/memdir/mnemeBuffer.js')
const { seqCensus } = await import('../../src/memdir/mnemeArchive.js')

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
  note('empty-note', 'project', ''),
  ['feedback-old.superseded.20260901.md', '---\nname: feedback-old\ntype: feedback\n---\n\nAn audit copy that must never be taken.\n'],
  ['TASTE.md', '# TASTE\n- a promoted lesson mirror\n'],
]
for (const [name, body] of files) writeFileSync(join(projectMem, name), body)
mkdirSync(join(projectMem, 'logs', '2026', '09'), { recursive: true })
writeFileSync(join(projectMem, 'logs', '2026', '09', '2026-09-30.md'), '# daily log\n')
const before = new Map(readdirSync(projectMem).map(n => [n, statSync(join(projectMem, n)).isFile() ? readFileSync(join(projectMem, n), 'utf8') : '']))
const mtimes = new Map(readdirSync(projectMem).map(n => [n, statSync(join(projectMem, n)).mtimeMs]))

section('the first open of a project with old notes hands every note to memory through retain, once')
check('the intake is due on a project with old notes and no marker', handoverDue(projectMem) === true)
check('the index, the audit copy and the taste mirror are not notes', !listOldNotes(projectMem).some(n => n === 'MEMORY.md' || n.includes('.superseded.') || n === 'TASTE.md'))
const T0 = new Date('2026-10-02T09:00:00.000Z')
const receipt = handoverIfDue(projectMem, T0)
check('a receipt comes back', receipt !== null, JSON.stringify(receipt))
check('ten notes were taken (the empty one skipped, the index/audit copy/taste mirror never counted)', receipt?.notes === 10, JSON.stringify(receipt))
const longChunks = chunkNote(longBody).length
check('a long note is kept whole as numbered parts, nothing dropped for size', longChunks > 1 && receipt?.facts === 9 + longChunks, `${longChunks} parts, ${receipt?.facts} facts`)
check('the four rulings and preferences landed pinned', receipt?.pinned === 4 && receipt.pages['preferences'] === 4, JSON.stringify(receipt?.pages))
check('project facts landed on the project page', receipt?.pages['project'] === 2 + longChunks)
check('the reference landed on the references page', receipt?.pages['references'] === 1)
check('the lesson landed on the lessons page', receipt?.pages['lessons'] === 1)
check('the untyped note landed on the notes page', receipt?.pages['notes'] === 1)
check('the empty note is named in the receipt as skipped', receipt?.skipped.some(s => s.file === 'empty-note.md' && s.reason === 'empty') === true)
check('the facts were consolidated into pages at once', receipt?.consolidated === true)

const lib = join(projectMem, 'library')
const pages = listTopicDocs(lib)
check('the library holds the five pages', ['preferences', 'project', 'references', 'lessons', 'notes'].every(slug => pages.some(p => p.slug === slug)), pages.map(p => p.slug).join(','))
check('a page carries the summary memory gave it', pages.find(p => p.slug === 'preferences')?.summary.includes('standing rules and preferences') === true)
const pinned = readPins(lib)
check('the pinned tier holds exactly the four rulings', pinned.length === 4)
const front = readFrontPage(lib) ?? ''
check('the pinned rules are in front of the model word for word', front.includes('- Use the model the owner names for every lane. **Why:** the owner rules on models. **How to apply:** never substitute. <seq='))
check('the index names the pages, never the facts', /^- project — ongoing project facts/m.test(front) && !front.includes('mercury-working checkout'))
check('the index pointer lines were not taken as facts', !front.includes('[Owner names models]') && !pages.some(p => p.sections.some(s => s.entries.some(e => e.text.includes('[Owner names models]')))))
check('every fact carries the note it came from as its source', pages.every(p => p.sections.every(s => s.entries.every(e => e.source.startsWith('handover:')))))

section('once, and nothing of anyone\'s is deleted')
check('a marker records that the intake ran', readHandoverReceipt(lib)?.ranAt === T0.toISOString())
check('the intake is no longer due', handoverDue(projectMem) === false)
const again = handoverIfDue(projectMem, new Date(T0.getTime() + 1000))
check('a second open takes nothing more', again === null && readBuffer(lib).length === 0 && seqCensus(listTopicDocs(lib)).split(',').length === receipt?.facts)
const forced = handoverMemoryDir(projectMem, new Date(T0.getTime() + 2000))
check('calling the intake again returns the same receipt without re-reading', forced.ranAt === T0.toISOString())
const after = new Map(readdirSync(projectMem).filter(n => n !== 'library').map(n => [n, statSync(join(projectMem, n)).isFile() ? readFileSync(join(projectMem, n), 'utf8') : '']))
check('every old file is still on disk with the same bytes', [...before.entries()].every(([n, body]) => after.get(n) === body) && after.size === before.size)
check('no old file was rewritten', [...mtimes.entries()].every(([n, m]) => statSync(join(projectMem, n)).mtimeMs === m))
check('the receipt renders for the memory centre', renderHandoverReceipt(receipt!)[0]!.startsWith('10 notes → ') && renderHandoverReceipt(receipt!)[1]!.startsWith('pages:'))
check('no archive page was made of fresh facts', listArchiveDocs(lib).length === 0)

section('a first intake past the pinned limit keeps every rule loaded and says so once per session')
const bigMem = join(home, 'projects', '-Users-someone-code-big', 'memory')
mkdirSync(bigMem, { recursive: true })
const BIG = 40
for (let i = 0; i < BIG; i++) {
  const [name, body] = note(`feedback-rule-${String(i).padStart(2, '0')}`, 'feedback', `Standing rule ${i}: do the thing ${i} this way, every time, with the long explanation of why that fills the shelf with text (${'x'.repeat(200)}).`)
  writeFileSync(join(bigMem, name), body)
}
const bigReceipt = handoverIfDue(bigMem, T0)
check(`all ${BIG} rules landed pinned`, bigReceipt?.pinned === BIG, JSON.stringify(bigReceipt))
const bigLib = join(bigMem, 'library')
const bigStatus = readPinnedStatus(bigLib)
check('every rule is loaded and the shelf is over its text limit', bigStatus?.loaded.length === BIG && bigStatus.over === true && bigStatus.used > bigStatus.limit, JSON.stringify(bigStatus))
check('the front page carries all of them', (readFrontPage(bigLib) ?? '').includes(`Standing rule ${BIG - 1}:`))
check('an intake pin is not marked as asked for by the user', bigStatus?.asked.length === 0)
const extraSeq = listTopicDocs(bigLib)[0]!.sections[0]!.entries[0]!.seq
check('a later pin is still never refused', pinFact(extraSeq, bigLib).ok === true)
const { pinnedOverLimitLine } = await import('../../src/utils/statusNoticeDefinitions.js')
check('the calm line names the count, the fill, the limit, that all are loaded, and both ways out',
  pinnedOverLimitLine({ pinned: bigStatus?.pinned ?? 0, used: bigStatus?.used ?? 0, limit: bigStatus?.limit ?? 0 }).startsWith(`Pinned memory: ${BIG} rules, `) &&
    pinnedOverLimitLine({ pinned: 1, used: 9600, limit: 8000 }) === 'Pinned memory: 1 rule, 9.6k of the 8k limit — all still loaded. Trim in /memory or raise the limit in /config.')
const notices = readFileSync(join(ROOT, 'src/utils/statusNoticeDefinitions.tsx'), 'utf8')
check('the line is a start-of-session notice row, not a composer line', notices.includes("id: 'pinned-over-limit'") && notices.includes("type: 'info'"))
check('the line never shows in a headless run', notices.includes("process.env.MERCURY_ENTRYPOINT === 'headless') return null"))
check('the composer carries no pinned line', !/pinned.*limit/i.test(readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')))

section('a whole home at once, and the boot wiring')
const summary = handoverHome(home, T0)
check('the sweep sees both projects and finds both already done', summary.projects === 2 && summary.alreadyDone === 2 && summary.withNotes === 0, JSON.stringify({ ...summary, receipts: summary.receipts.length }))
const maintenance = readFileSync(join(ROOT, 'src/memdir/mnemeMaintenance.ts'), 'utf8')
check('the boot maintenance pass runs the intake first', /trigger === 'boot'[\s\S]*mnemeHandover\.js[\s\S]*handoverIfDue\(\)/.test(maintenance))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ THE INTAKE HANDS EVERY NOTE TO MEMORY ONCE' : `❌ ${failures} INTAKE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
