#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildExperienceCard,
  promoteExperienceCard,
  writeExperienceCard,
} from '../../src/memdir/experienceCards.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' experience-card supersede-lineage edge — proof')
console.log('============================================================')

delete process.env.MERCURY_EXPERIENCE_CARDS
delete process.env.MERCURY_CARD_SUPERSEDE

const memoryDir = mkdtempSync(join(tmpdir(), 'mercury-card-lineage-'))
const NAME = 'lineage-proof-card'
const FILENAME = `${NAME}.md`

const cardInput = (lesson: string, createdAt: string) => ({
  name: NAME,
  title: 'Lineage proof card',
  summary: 'proves the supersede lineage edge round-trips',
  problemClass: 'proof-harness',
  lesson,
  sourceRefs: ['scripts/memory/prove-card-lineage.ts'],
  createdAt,
  scope: 'regime-specific' as const,
  appliesWhen: 'running the lineage proof',
})

const auditCopies = () =>
  readdirSync(memoryDir)
    .filter(f => f.startsWith(`${NAME}.superseded.`) && f.endsWith('.md'))
    .sort()

const fmOf = (file: string): string => {
  const md = readFileSync(join(memoryDir, file), 'utf-8')
  const m = md.match(/^---\n[\s\S]*?\n---/)
  return m ? m[0] : ''
}

section('1. first write — no lineage edge')
{
  const r = await writeExperienceCard(memoryDir, cardInput('v1 lesson body', '2026-07-03T01:00:00.000Z'))
  check('v1 write ok', r.ok === true, JSON.stringify(r))
  const fm = fmOf(FILENAME)
  check('v1 has no supersedes edge', !/\bsupersedes:/.test(fm))
  check('v1 has no supersededBy edge', !/\bsupersededBy:/.test(fm))
}

section('2. rewrite — both edges stamped')
{
  const r = await writeExperienceCard(memoryDir, cardInput('v2 lesson body (rewrite)', '2026-07-03T02:00:00.000Z'))
  check('v2 write ok', r.ok === true, JSON.stringify(r))
  const copies = auditCopies()
  check('one audit copy exists', copies.length === 1, copies.join())
  const auditFm = fmOf(copies[0]!)
  check('audit copy freshness flipped to superseded', /\n\s*freshness:\s*superseded/.test(auditFm))
  check(
    'audit copy carries supersededBy → canonical',
    new RegExp(`\\n\\s*supersededBy:\\s*['"]?${FILENAME}`).test(auditFm),
    auditFm.split('\n').filter(l => /superseded/i.test(l)).join(' | '),
  )
  const canonFm = fmOf(FILENAME)
  check(
    'canonical carries supersedes → audit copy',
    new RegExp(`\\n\\s*supersedes:\\s*['"]?${copies[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(canonFm),
    canonFm.split('\n').filter(l => /supersede/i.test(l)).join(' | '),
  )
  check('canonical does NOT carry supersededBy (it is the live card)', !/\bsupersededBy:/.test(canonFm))
}

section('3. promote path — same edges around the pre-promote copy')
{
  const before = auditCopies()
  const p = await promoteExperienceCard(memoryDir, NAME, { now: '2026-07-03T03:00:00.000Z' })
  check('promote ok', (p as { ok?: boolean }).ok === true, JSON.stringify(p))
  const after = auditCopies()
  check('promote preserved a new audit copy', after.length === before.length + 1, `${before.length}→${after.length}`)
  const newest = after.find(f => !before.includes(f))!
  const auditFm = fmOf(newest)
  check(
    'pre-promote copy carries supersededBy → canonical',
    new RegExp(`\\n\\s*supersededBy:\\s*['"]?${FILENAME}`).test(auditFm),
  )
  const canonFm = fmOf(FILENAME)
  check(
    'promoted canonical supersedes → pre-promote copy',
    new RegExp(`\\n\\s*supersedes:\\s*['"]?${newest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(canonFm),
  )
  check('promoted canonical is approved', /\n\s*approved:\s*true/.test(canonFm))
}

section('4. chain walkability across generations')
{
  const copies = auditCopies()
  const newest = copies[copies.length - 1]!
  const oldest = copies[0]!
  const newestFm = fmOf(newest)
  check(
    'newest audit copy still carries ITS OWN supersedes edge (chain intact)',
    new RegExp(`\\n\\s*supersedes:\\s*['"]?${oldest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(newestFm),
    newestFm.split('\n').filter(l => /supersede/i.test(l)).join(' | '),
  )
}

section('5. parse-compat — stamped canonical still builds/parses clean')
{
  const rebuilt = buildExperienceCard(cardInput('v3 shape check', '2026-07-03T04:00:00.000Z'))
  check('builder unaffected', rebuilt.ok === true)
  const canonFm = fmOf(FILENAME)
  check('canonical retains type/problemClass/approved fields', /type: experience-card/.test(canonFm) && /problemClass:/.test(canonFm) && /approved:/.test(canonFm))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` RESULT: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
