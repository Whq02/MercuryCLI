#!/usr/bin/env bun
import { plugin } from 'bun'
plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listExperienceCards,
  promoteExperienceCard,
} from '../../src/memdir/experienceCards.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

function card(name: string, summary: string, problemClass: string, approved: boolean): string {
  return `---
name: ${name}
description: ${summary}
metadata:
  type: experience-card
  problemClass: ${problemClass}
  confidence: likely
  freshness: fresh
  scope: general
  approved: ${approved}
---
The transferable lesson body for ${name}.
`
}

const dir = mkdtempSync(join(tmpdir(), 'hermes-cards-'))
writeFileSync(join(dir, 'zebra-candidate.md'), card('zebra-candidate', 'A candidate lesson', 'testing-z', false))
writeFileSync(join(dir, 'alpha-approved.md'), card('alpha-approved', 'An approved lesson', 'testing-a', true))
writeFileSync(join(dir, 'old.superseded.1718.md'), card('old', 'superseded copy', 'testing-z', false))
writeFileSync(join(dir, 'project-note.md'), '---\nname: project-note\nmetadata:\n  type: project\n---\nnot a card\n')
writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [x](zebra-candidate.md) — experience-card (candidate): A candidate lesson\n')

console.log('============================================================')
console.log(' /cards browser — experience-card list + promote wire')
console.log('============================================================')

section('listExperienceCards: only real cards, candidates first')
{
  const cards = await listExperienceCards(dir)
  check('exactly 2 cards (superseded / non-card / MEMORY.md skipped)', cards.length === 2, `${cards.length}`)
  check('candidate sorts FIRST', cards[0]?.name === 'zebra-candidate' && cards[0]?.meta.approved === false)
  check('approved sorts after', cards[1]?.name === 'alpha-approved' && cards[1]?.meta.approved === true)
  check('title read from frontmatter description', cards[0]?.title === 'A candidate lesson')
  check('meta carries problemClass/confidence/freshness/scope', cards[0]?.meta.problemClass === 'testing-z' && cards[0]?.meta.confidence === 'likely' && cards[0]?.meta.freshness === 'fresh' && cards[0]?.meta.scope === 'general')
  check('no superseded/non-card leaked in', !cards.some(c => c.name === 'old' || c.name === 'project-note' || c.name === 'MEMORY'))
}

section('promote round-trip: candidate → approved (gate off ⇒ deterministic flip)')
{
  process.env.MERCURY_CARD_PROMOTE_GATE = '0'
  const res = await promoteExperienceCard(dir, 'zebra-candidate')
  check('promote ok', res.ok === true, JSON.stringify(res))
  check('was a real flip (not already-approved)', res.ok === true && res.alreadyApproved === false)
  const after = await listExperienceCards(dir)
  const z = after.find(c => c.name === 'zebra-candidate')
  check('re-list shows it APPROVED now', z?.meta.approved === true)
  const again = await promoteExperienceCard(dir, 'zebra-candidate')
  check('idempotent re-promote ⇒ ok + alreadyApproved', again.ok === true && again.alreadyApproved === true)
  delete process.env.MERCURY_CARD_PROMOTE_GATE
}

section('not-found is honest (never throws, never fabricates)')
{
  const res = await promoteExperienceCard(dir, 'does-not-exist')
  check("blocked 'not-found'", res.ok === false && res.blocked === 'not-found')
}

section('wiring: the view calls list+promote via ↵/p, command gated + registered')
{
  const view = src('components', 'CardsView.tsx')
  const engine = src('components', 'mercury-ui', 'useFlatList.ts')
  check('CardsView reads listExperienceCards(getAutoMemPath())', /listExperienceCards\(getAutoMemPath\(\)\)/.test(view))
  check('CardsView promotes via promoteExperienceCard', /promoteExperienceCard\(getAutoMemPath\(\), card\.name\)/.test(view))
  check(
    "↵/p trigger promote (onPrimary: promote, primaryChar p, engine binds activate+letter)",
    /onPrimary: promote/.test(view) &&
      /primaryChar: 'p'/.test(view) &&
      /action === 'activate' \|\| \(charKeys && primaryChar && input === primaryChar\)/.test(engine),
  )
  check('only writes on an explicit promote (no delete/edit)', !/unlink|rmSync|writeFile/.test(view))
  const idx = src('commands', 'cards', 'index.ts')
  check('command fork+card gated (experienceCardsEnabled + non-ant)', /isEnabled: \(\) => experienceCardsEnabled\(\)/.test(idx) && !/process\.env\.USER_TYPE/.test(idx))
  const reg = src('commands.ts')
  check('cards imported + in the command array', /import cards from '\.\/commands\/cards\/index\.js'/.test(reg) && /\n\s+cards,\n/.test(reg))
}

rmSync(dir, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CARDS-BROWSER PROOFS PASS')
else console.log(`❌ ${failures} CARDS-BROWSER PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
