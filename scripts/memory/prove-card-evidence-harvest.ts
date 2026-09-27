#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { buildExperienceCard } from '../../src/memdir/experienceCards.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' card evidence block — proof')
console.log('============================================================')

const sha = '0123abc'

section('3. builder — block rendering, clamps, secret refusal')
{
  const base = {
    name: 'harvest-proof-card',
    title: 'Harvest proof',
    summary: 'harvest block render',
    problemClass: 'proof-harness',
    lesson: 'the lesson body',
    sourceRefs: [sha],
    createdAt: '2026-07-03T12:00:00.000Z',
    greenGate: true,
  }
  const withOut = buildExperienceCard(base)
  check('no harvested lines ⇒ no evidence block', withOut.ok && !withOut.markdown.includes('Evidence (harvested)'))
  const withLines = buildExperienceCard({ ...base, harvestedEvidence: ['commit abc 2 files changed', 'trace tail (host-wide, ≤6h): Bash ×2'] })
  check('harvested lines ⇒ evidence block rendered', withLines.ok && withLines.markdown.includes('**Evidence (harvested):**') && /- commit abc/.test(withLines.markdown))
  const many = buildExperienceCard({ ...base, harvestedEvidence: Array.from({ length: 12 }, (_, i) => `line ${i} ` + 'x'.repeat(400)) })
  check('clamped to ≤6 lines, ≤300 chars each', many.ok && (many.markdown.match(/^- line /gm) ?? []).length === 6 && !/x{301}/.test(many.markdown))
  const secret = buildExperienceCard({ ...base, harvestedEvidence: ['harvested from AKIAIOSFODNN7EXAMPLE credentials'] })
  check('secret-bearing harvested line ⇒ whole card refused', !secret.ok && (secret as { blocked?: string }).blocked === 'secret-bearing')
}

section('3b. dedup identity EXCLUDES the harvested block (counts differ run-to-run)')
{
  const { normalizedLesson } = await import('../../src/memdir/experienceCards.ts')
  const mk = (evidence: string[]) => {
    const r = buildExperienceCard({
      name: 'dedup-identity-card',
      title: 'Dedup identity',
      summary: 'identity check',
      problemClass: 'proof-harness',
      lesson: 'the same transferable lesson\n- with a real lesson bullet',
      sourceRefs: [],
      createdAt: '2026-07-03T12:00:00.000Z',
      harvestedEvidence: evidence,
    })
    if (!r.ok) throw new Error('build failed')
    return r.markdown
  }
  const a = normalizedLesson(mk(['trace tail (host-wide, ≤6h): Bash ×2']))
  const b = normalizedLesson(mk(['trace tail (host-wide, ≤6h): Bash ×7 (1 fail)', 'commit abc123 (2 files changed)']))
  const c = normalizedLesson(mk([]))
  check('differing harvests ⇒ SAME identity', a === b)
  check('harvested vs none ⇒ SAME identity', a === c)
  check('the real lesson bullet survives in the identity', /with a real lesson bullet/.test(a))

  const mkEmbedded = (embedded: string) => {
    const r = buildExperienceCard({
      name: 'embedded-lookalike-card',
      title: 'Embedded lookalike',
      summary: 'embed check',
      problemClass: 'proof-harness',
      lesson: `distinct lesson prose\n**Evidence (harvested):**\n- ${embedded}\nand more prose after`,
      sourceRefs: [],
      createdAt: '2026-07-03T12:00:00.000Z',
      harvestedEvidence: ['trace tail (host-wide, ≤6h): Bash ×3'],
    })
    if (!r.ok) throw new Error('build failed')
    return normalizedLesson(r.markdown)
  }
  const e1 = mkEmbedded('model-written-alpha')
  const e2 = mkEmbedded('model-written-beta')
  check('lesson-embedded lookalike SURVIVES (not stripped mid-body)', /model-written-alpha/.test(e1))
  check('two lessons differing only in the embedded lookalike ⇒ DISTINCT identity (no false dup)', e1 !== e2)
  check('the trailing harness block is still stripped from the embedded case', !/bash ×3/.test(e1))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` RESULT: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
