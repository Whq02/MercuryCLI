#!/usr/bin/env bun

import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildExperienceCard,
  cardPromoteGate,
  promoteCardMarkdown,
  promoteExperienceCard,
  readCardMeta,
  writeExperienceCard,
  type BuildCardInput,
} from '../../src/memdir/experienceCards.js'
import { parseFrontmatter } from '../../src/utils/frontmatterParser.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
function clearEnv(): void {
  delete process.env.MERCURY_CARD_PROMOTE_GATE
  delete process.env.MERCURY_CARD_SUPERSEDE
}

function md(input: Partial<BuildCardInput>): string {
  const base: BuildCardInput = {
    name: 'gate-demo',
    title: 'Gate demo',
    summary: 'a demo candidate for the promote-gate proof',
    problemClass: 'harness-recon',
    lesson: 'When promoting a learned lesson, gate it deterministically at the accept boundary.',
    sourceRefs: ['commit:deadbeef'],
    createdAt: '2026-06-17T05:30:00.000Z',
    greenGate: true,
    approved: false,
    ...input,
  }
  const built = buildExperienceCard(base)
  if (!built.ok) throw new Error('build failed: ' + JSON.stringify(built))
  return built.markdown
}

setStamp(true)
clearEnv()

console.log('============================================================')
console.log(' promote-gate (a-evolve accept-boundary) — proof')
console.log('============================================================')

section('cardPromoteGate — structural accept criterion (pure)')
{
  check('clean general candidate, no siblings ⇒ PASS', cardPromoteGate(md({ scope: 'general' }), []).ok === true)

  const withSecret = md({ scope: 'general' }).replace(
    '**Source refs:**',
    'leftover creds AKIA1234567890ABCDEF\n\n**Source refs:**',
  )
  const sd = cardPromoteGate(withSecret, [])
  check('(a) secret-bearing candidate ⇒ refused', sd.ok === false && /secret/.test((sd as { reason: string }).reason))

  const stale = cardPromoteGate(md({ scope: 'general', freshness: 'stale' }), [])
  check('(b) freshness=stale ⇒ refused', stale.ok === false && /stale/.test((stale as { reason: string }).reason))
  check('(b) freshness=superseded ⇒ refused', cardPromoteGate(md({ scope: 'general', freshness: 'superseded' }), []).ok === false)

  const noApplies = cardPromoteGate(md({ scope: 'regime-specific' }), [])
  check('(c) regime-specific w/o Applies-when ⇒ refused', noApplies.ok === false && /Applies when/.test((noApplies as { reason: string }).reason))
  const withApplies = cardPromoteGate(md({ scope: 'regime-specific', appliesWhen: 'inside the orchard project' }), [])
  check('(c) regime-specific WITH Applies-when ⇒ PASS', withApplies.ok === true)

  const cand = md({ scope: 'general', problemClass: 'dup-class', lesson: 'the exact same transferable lesson body, verbatim and identical.' })
  const sibling = { problemClass: 'dup-class', markdown: md({ name: 'sib', scope: 'general', approved: true, problemClass: 'dup-class', lesson: 'the exact same transferable lesson body, verbatim and identical.' }) }
  const dup = cardPromoteGate(cand, [sibling])
  check('(d) approved sibling, same class + same lesson ⇒ refused (no-op)', dup.ok === false && /already covered/.test((dup as { reason: string }).reason))
  const distinct = cardPromoteGate(md({ scope: 'general', problemClass: 'dup-class', lesson: 'a genuinely different lesson about a different aspect entirely here.' }), [sibling])
  check('(d) same class but DIFFERENT lesson ⇒ PASS (not a dup)', distinct.ok === true)
  const otherClass = cardPromoteGate(md({ scope: 'general', problemClass: 'other-class', lesson: 'the exact same transferable lesson body, verbatim and identical.' }), [sibling])
  check('(d) different problemClass ⇒ PASS (dedup is per-class)', otherClass.ok === true)
}

section('promoteCardMarkdown — surgical candidate→approved flip')
{
  const cand = md({ scope: 'general' })
  check('candidate frontmatter is approved: false', /approved:\s*false/.test(cand))
  const promoted = promoteCardMarkdown(cand)
  check('frontmatter flips to approved: true', /approved:\s*true/.test(promoted) && !/approved:\s*false/.test(promoted))
  check('inline Status banner flips to approved wording', promoted.includes('**Status:** approved experience card'))
  const meta = readCardMeta(parseFrontmatter(promoted).frontmatter as Record<string, unknown>)
  check('readCardMeta now reports approved: true', meta?.approved === true)
  check('promoting an already-approved card is identity', promoteCardMarkdown(promoted) === promoted)
}

section('promoteExperienceCard — end-to-end, gate ON')
{
  const dir = mkdtempSync(join(tmpdir(), 'mercury-promote-'))
  const candPath = join(dir, 'live-demo.md')
  writeFileSync(candPath, md({ name: 'live-demo', scope: 'general', problemClass: 'live-class', lesson: 'a clean, fresh, transferable lesson ready for promotion in this proof.' }))
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n\n- [Live demo](live-demo.md) — experience-card (candidate): a clean lesson\n')

  const ok = await promoteExperienceCard(dir, 'live-demo', { now: '2026-06-17T06-00-00' })
  check('clean candidate ⇒ promoted ok', ok.ok === true)
  if (ok.ok) {
    const onDisk = readFileSync(candPath, 'utf-8')
    check('on-disk card is now approved: true', /approved:\s*true/.test(onDisk))
    check('MEMORY.md index line refreshed to (approved)', readFileSync(join(dir, 'MEMORY.md'), 'utf-8').includes('experience-card (approved)'))
    check('pre-promote copy preserved as .superseded.*', ok.supersededPath !== undefined && existsSync(ok.supersededPath))
    const supersededFiles = readdirSync(dir).filter(f => f.includes('.superseded.'))
    check('exactly one superseded audit copy written', supersededFiles.length === 1)
  }

  writeFileSync(join(dir, 'bad.md'), md({ name: 'bad', scope: 'regime-specific' }))
  const refused = await promoteExperienceCard(dir, 'bad')
  check('regime-specific w/o Applies-when ⇒ refused by gate', refused.ok === false && refused.blocked === 'gate')
  check('refused card stays approved: false on disk', /approved:\s*false/.test(readFileSync(join(dir, 'bad.md'), 'utf-8')))
}

section('OFF (MERCURY_CARD_PROMOTE_GATE=0) — bare flip, gate never consulted')
{
  process.env.MERCURY_CARD_PROMOTE_GATE = '0'
  const dir = mkdtempSync(join(tmpdir(), 'mercury-promote-off-'))
  writeFileSync(join(dir, 'off.md'), md({ name: 'off', scope: 'regime-specific' }))
  const off = await promoteExperienceCard(dir, 'off')
  check('OFF ⇒ a would-be-refused card still flips (bare promote)', off.ok === true)
  check('OFF ⇒ on-disk card is approved: true', /approved:\s*true/.test(readFileSync(join(dir, 'off.md'), 'utf-8')))
  delete process.env.MERCURY_CARD_PROMOTE_GATE
}

section('writeExperienceCard — distill-time dedup (refuse near-duplicate cards)')
{
  delete process.env.MERCURY_CARD_DEDUP
  const dir = mkdtempSync(join(tmpdir(), 'mercury-dedup-'))
  const lessonA = 'a specific transferable lesson about wiring a gated substrate live with an opt-out.'
  const card = (name: string, problemClass: string, lesson: string): BuildCardInput => ({
    name, title: `T ${name}`, summary: `s ${name}`, problemClass, lesson,
    sourceRefs: ['commit:abc'], createdAt: '2026-06-17T05:30:00.000Z', greenGate: true,
  })

  const first = await writeExperienceCard(dir, card('dd-1', 'dedup-class', lessonA))
  check('first card writes ok', first.ok === true)

  const dup = await writeExperienceCard(dir, card('dd-2', 'dedup-class', lessonA))
  check('different-named card, same class + same lesson ⇒ blocked duplicate', dup.ok === false && dup.blocked === 'duplicate')

  const diff = await writeExperienceCard(dir, card('dd-3', 'dedup-class', 'a genuinely different lesson on an unrelated topic, distinct wording entirely.'))
  check('same class but DIFFERENT lesson ⇒ writes ok', diff.ok === true)

  const otherClass = await writeExperienceCard(dir, card('dd-4', 'other-class', lessonA))
  check('different class, same lesson ⇒ writes ok (dedup is per-class)', otherClass.ok === true)

  const rewrite = await writeExperienceCard(dir, card('dd-1', 'dedup-class', lessonA + ' (now revised with extra detail).'))
  check('same-name rewrite ⇒ not blocked as duplicate (supersede path)', rewrite.ok === true)

  process.env.MERCURY_CARD_DEDUP = '0'
  const offDir = mkdtempSync(join(tmpdir(), 'mercury-dedup-off-'))
  await writeExperienceCard(offDir, card('od-1', 'c', lessonA))
  const offDup = await writeExperienceCard(offDir, card('od-2', 'c', lessonA))
  check('OFF ⇒ duplicate is allowed (byte-identical to before)', offDup.ok === true)
  delete process.env.MERCURY_CARD_DEDUP
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PROMOTE-GATE PROOFS PASS')
else console.log(`❌ ${failures} PROMOTE-GATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
