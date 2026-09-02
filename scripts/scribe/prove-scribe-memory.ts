#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-scribe-memory.ts
//  PROOF: the SEPARATE scribe memory the operator asked for — "maintained when
//  activated, a truncated/efficient version to avoid poisoning memory."
//  The `scribe/` scope (recall-excluded) + promote already existed; this proves
//  the missing WRITE-IN (stageScribeNote): compact (hard-capped), secret-refusing,
//  idempotent-by-name, and round-trips through promoteScribeCandidate (ratify).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-scribe-memory.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const m = (await import('../../src/memdir/scribePromote.js')) as typeof import('../../src/memdir/scribePromote.js')

console.log('============================================================')
console.log(' Separate scribe memory (stage → ratify) — proof')
console.log('============================================================')

section('capScribeNote — TRUNCATED/efficient (the anti-bloat cap)')
const short = m.capScribeNote('a tidy little note')
check('under cap ⇒ unchanged, not truncated', short.text === 'a tidy little note' && short.truncated === false)
const long = m.capScribeNote('x'.repeat(5000))
check('over cap ⇒ truncated', long.truncated === true)
check('over cap ⇒ length bounded near the cap', long.text.length <= m.SCRIBE_NOTE_MAX_CHARS + 80)
check('truncation is marked honestly', /truncated/.test(long.text))

section('scribeNoteFilename — safe, stable, .md (re-stage overwrites the same file)')
check('slugifies + .md', m.scribeNoteFilename('Parser Task!! notes') === 'parser-task-notes.md')
check('already-.md is not doubled', m.scribeNoteFilename('foo.md') === 'foo.md')
check('empty-ish ⇒ note.md', m.scribeNoteFilename('!!!') === 'note.md')
check('stable (idempotent)', m.scribeNoteFilename('A B') === m.scribeNoteFilename('a-b'))

section('stageScribeNote — writes a compact, unratified candidate into scribe/')
const scribeDir = mkdtempSync(join(tmpdir(), 'scribe-mem-'))
const r1 = await m.stageScribeNote('session focus', 'Refining the parser error-handling task; Implementer mid-dispatch.', { scribeDir })
check('ok', r1.ok === true)
if (r1.ok) {
  check('wrote into the scribe scope dir', r1.path.startsWith(scribeDir))
  const doc = readFileSync(r1.path, 'utf-8')
  check('frontmatter: approved:false (stays unratified ⇒ recall-excluded)', /approved: false/.test(doc))
  check('frontmatter: metadata.type scribe-candidate', /type: scribe-candidate/.test(doc))
  check('body present', /Refining the parser/.test(doc))
}
// idempotent maintenance: re-stage same name ⇒ overwrite (not a second file)
await m.stageScribeNote('session focus', 'UPDATED: parser task merged green.', { scribeDir })
const reread = readFileSync(join(scribeDir, 'session-focus.md'), 'utf-8')
check('re-stage OVERWRITES (maintenance, not accumulation)', /UPDATED: parser task merged green/.test(reread) && !/Refining the parser/.test(reread))

section('refusals — empty + secret (the write floor)')
const empty = await m.stageScribeNote('x', '   ', { scribeDir })
check('empty body refused', empty.ok === false && empty.reason === 'empty')
const secret = await m.stageScribeNote('leak', 'token sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL', { scribeDir })
check('secret-bearing note refused', secret.ok === false && (secret as { reason: string }).reason === 'secret')

section('round-trip — stage → promoteScribeCandidate ratifies (flips approved, moves OUT)')
const rootDir = mkdtempSync(join(tmpdir(), 'scribe-root-'))
await m.stageScribeNote('ratify me', 'A lesson worth keeping.', { scribeDir })
const promoted = await m.promoteScribeCandidate('ratify-me.md', 'private', { scribeDir, rootDir })
check('promote ok', promoted.ok === true)
if (promoted.ok) {
  check('candidate moved OUT of scribe/', !existsSync(join(scribeDir, 'ratify-me.md')))
  check('candidate now in root memory', existsSync(join(rootDir, 'ratify-me.md')))
  check('approved flipped true on ratify', promoted.approvedFlipped === true && /approved: true/.test(readFileSync(join(rootDir, 'ratify-me.md'), 'utf-8')))
  check('indexed in root MEMORY.md', existsSync(join(rootDir, 'MEMORY.md')) && /ratify-me\.md/.test(readFileSync(join(rootDir, 'MEMORY.md'), 'utf-8')))
}

section('anti-poisoning wiring — scribe scope is recall-excluded')
const scanSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'memdir', 'memoryScan.ts'), 'utf-8')
check('memoryScan excludes the scribe scope from recall', /excludeScopes[\s\S]{0,60}\['scribe'\]/.test(scanSrc))

section('frontmatter shape (#3) — approved nests UNDER metadata: (one coherent block)')
const shapeRes = await m.stageScribeNote('shape check', 'A note to inspect the frontmatter shape.', { scribeDir })
if (shapeRes.ok) {
  const doc = readFileSync(shapeRes.path, 'utf-8')
  const fm = (doc.match(/^---\n[\s\S]*?\n---/) ?? [''])[0]
  check('approved is indented under metadata: (not top-level)', / {2}approved: false\b/.test(fm) && !/^approved:/m.test(fm))
  check('type + approved are siblings in the same metadata block', /metadata:\n {2}type: scribe-candidate\n {2}approved: false/.test(fm))
}

section('promote flips ONLY the frontmatter key (#2) — body "approved: false" is never corrupted')
// Old code: content.replace('approved: false', …) hit the FIRST match ANYWHERE. A
// candidate with NO frontmatter approved but the string in its BODY got its body
// rewritten (and was never actually ratified). The anchored frontmatter flip fixes it.
const bugDir = mkdtempSync(join(tmpdir(), 'scribe-bug-'))
const bugRoot = mkdtempSync(join(tmpdir(), 'scribe-bug-root-'))
mkdirSync(bugDir, { recursive: true })
writeFileSync(
  join(bugDir, 'bodymention.md'),
  '---\nname: bodymention\ndescription: body mentions the field\n---\n\nWe set approved: false earlier; do not touch this line.\n',
)
const bug = await m.promoteScribeCandidate('bodymention.md', 'private', { scribeDir: bugDir, rootDir: bugRoot })
check('promote ok (moved out of scribe/)', bug.ok === true)
if (bug.ok) {
  const out = readFileSync(join(bugRoot, 'bodymention.md'), 'utf-8')
  check('no frontmatter approved ⇒ approvedFlipped is FALSE (honest, not a phantom ratify)', bug.approvedFlipped === false)
  check('BODY "approved: false" PRESERVED (not corrupted to true)', /approved: false earlier/.test(out))
}
// And a candidate WITH a frontmatter approved + the SAME string in the body: only the
// frontmatter flips; the body copy stays verbatim.
const bothDir = mkdtempSync(join(tmpdir(), 'scribe-both-'))
const bothRoot = mkdtempSync(join(tmpdir(), 'scribe-both-root-'))
mkdirSync(bothDir, { recursive: true })
writeFileSync(
  join(bothDir, 'both.md'),
  '---\nname: both\nmetadata:\n  type: scribe-candidate\n  approved: false\n---\n\nNote: approved: false stays here verbatim.\n',
)
const both = await m.promoteScribeCandidate('both.md', 'private', { scribeDir: bothDir, rootDir: bothRoot })
check('promote ok', both.ok === true)
if (both.ok) {
  const out = readFileSync(join(bothRoot, 'both.md'), 'utf-8')
  check('frontmatter flipped to approved: true (nested key, anchored)', /metadata:\n {2}type: scribe-candidate\n {2}approved: true/.test(out))
  check('BODY "approved: false" still present (only the frontmatter flipped)', /approved: false stays here verbatim/.test(out))
  check('approvedFlipped reports true', both.approvedFlipped === true)
}

section('RememberLesson scope:"scribe" (#1) — the agent-facing write-IN route is WIRED')
const tool = (await import('../../src/tools/RememberLessonTool/RememberLessonTool.js')).RememberLessonTool
// Route reaches the staging FLOOR without writing: empty + secret bodies are refused
// BEFORE any mkdir/write, so this never touches real memory (mirrors prove-remember-tool).
const emptyVia = await tool.call({ scope: 'scribe', problemClass: 'route', lesson: '   ', title: 't', summary: 's', greenGatePassed: false } as never)
check('scope:scribe + empty ⇒ routed to stageScribeNote and refused (banked:false, scope echoed)', emptyVia.data.banked === false && emptyVia.data.scope === 'scribe')
const secretVia = await tool.call({ scope: 'scribe', problemClass: 'route', lesson: 'token sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL', title: 't', summary: 's', greenGatePassed: false } as never)
check('scope:scribe + secret ⇒ refused by the staging floor (no write)', secretVia.data.banked === false && /secret/.test(secretVia.data.reason ?? ''))
const toolSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'RememberLessonTool', 'RememberLessonTool.ts'), 'utf-8')
check('the tool imports stageScribeNote (the severed loop is now wired)', /import \{ stageScribeNote \} from '\.\.\/\.\.\/memdir\/scribePromote\.js'/.test(toolSrc))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCRIBE-MEMORY PROOFS PASS')
else console.log(`❌ ${failures} SCRIBE-MEMORY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
