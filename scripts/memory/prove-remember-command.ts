#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-remember-command.ts
//  PROOF (next-leap-discovery #1): /remember closes the SEVERED experience-card
//  write loop. The lifecycle (candidate→approved, distill-on-green-gate) was hardened
//  + green but writeExperienceCard had ZERO runtime callers — the agent was told to
//  bank lessons + could recall them, yet nothing could write one mid-session. /remember
//  drives the EXISTING production path (operatorSignal trigger), writing a CANDIDATE
//  (approved:false) the operator promotes later.
//
//  Round-trips into a TEMP dir via the injectable bankLesson(memoryDir, …) — never
//  touches the real auto-memory. Run: ~/.bun/bin/bun run scripts/memory/prove-remember-command.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { bankLesson, buildRememberInput, deriveSlug } from '../../src/commands/remember/remember.js'
import { remember } from '../../src/commands/remember/index.js'
import { isExperienceCardMarkdown } from '../../src/memdir/experienceCards.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

console.log('============================================================')
console.log(' /remember — runtime experience-card write loop')
console.log('============================================================')

section('deriveSlug + buildRememberInput (pure)')
check('deriveSlug(prose) is a valid kebab slug', SLUG_RE.test(deriveSlug('Use flock for the cross-process lock')))
check('deriveSlug(punctuation-only) still valid', SLUG_RE.test(deriveSlug('!!! ???')))
const inp = buildRememberInput('A transferable lesson about gating that is long enough to count.', '2026-06-19T00:00:00.000Z')
check('input is born a CANDIDATE (approved:false)', inp.approved === false)
check('problemClass = operator-note', inp.problemClass === 'operator-note')
check('lesson preserved + slug valid', inp.lesson.includes('transferable lesson') && SLUG_RE.test(inp.name))

section('bankLesson round-trips into a TEMP dir (no real-memory pollution)')
const dir = await mkdtemp(join(tmpdir(), 'remember-proof-'))
try {
  const lesson = 'When wiring a stamp-only command, gate isEnabled on experienceCardsEnabled so OFF folds byte-identical.'
  const r = await bankLesson(dir, lesson)
  check('ok ⇒ a card was written', r.ok === true, r.ok ? '' : `blocked=${(r as { blocked: string }).blocked}`)
  if (r.ok) {
    const files = await readdir(dir)
    check('a .md experience card landed', files.some(f => f.endsWith('.md') && f !== 'MEMORY.md'))
    check('MEMORY.md index was written', files.includes('MEMORY.md'))
    const card = await readFile(r.path, 'utf-8')
    check('the written file is a valid experience card carrying the lesson', isExperienceCardMarkdown(card) && card.includes('gate isEnabled'))
  }
  const rShort = await bankLesson(dir, 'too short')
  check('a too-short lesson ⇒ skipped (not banked)', rShort.ok === false && (rShort as { blocked: string }).blocked === 'skipped')
  // Deterministic slug (was Date.now()): re-banking the SAME lesson collides on the SAME
  // filename and supersedes in place — ONE canonical card, never an accumulating duplicate.
  const rDup = await bankLesson(dir, lesson)
  check('re-banking the SAME lesson ⇒ ok (same-name supersede, not a new file)', rDup.ok === true, rDup.ok ? '' : `blocked=${(rDup as { blocked: string }).blocked}`)
  if (r.ok && rDup.ok) check('the re-bank reused the SAME stable path (deterministic slug)', r.path === rDup.path)
  const canon = (await readdir(dir)).filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && !f.includes('.superseded.'))
  check('exactly ONE canonical card after two identical banks (no accumulation)', canon.length === 1, `got ${canon.length}`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

section('deriveSlug is DETERMINISTIC (identical lesson ⇒ identical slug, no Date.now drift)')
const slugA = deriveSlug('Use flock for the cross-process lock', 'k')
await new Promise(r => setTimeout(r, 5))
check('same (seed, disambiguator) across time ⇒ same slug', slugA === deriveSlug('Use flock for the cross-process lock', 'k'))
check('different disambiguator ⇒ different slug', deriveSlug('x', 'aaa') !== deriveSlug('x', 'bbb'))

section('/remember preview + leading <problemClass>: override (work-item 2)')
const over = buildRememberInput('fork-gating: gate isEnabled on experienceCardsEnabled so OFF folds byte-identical.', '2026-06-19T00:00:00.000Z')
check('leading kebab `<class>:` overrides operator-note', over.problemClass === 'fork-gating')
check('the class prefix is stripped from the body + title', !over.lesson.startsWith('fork-gating:') && !over.title.startsWith('fork-gating:'))
const prose = buildRememberInput('Note: always verify the gate folds OFF to byte-identical before shipping.', '2026-06-19T00:00:00.000Z')
check('capitalized `Note:` is NOT mis-parsed as a class (prose-safe)', prose.problemClass === 'operator-note' && prose.lesson.startsWith('Note:'))
check('command result echoes the derived title + problemClass', /Banked "\$\{title\}" \[\$\{problemClass\}\]/.test(src('commands', 'remember', 'remember.ts')))

section('command descriptor: fork + non-ant gated (mutual exclusion with the ant `remember` skill)')
// The runtime USER_TYPE!=='ant' read
// folded at source (the ant-skill mutual exclusion was decided at BUILD time in
// every dist; the env flip below could only ever flip the un-built source).
// Residual invariant: isEnabled is card-gated and carries NO runtime USER_TYPE
// read that could resurrect the ant branch.
check('type:local, name:remember', remember.type === 'local' && remember.name === 'remember')
check('isEnabled() TRUE on fork + non-ant', remember.isEnabled?.() === true)
check(
  'isEnabled() FALSE for ant (the ant skill owns the name there)',
  !/process\.env\.USER_TYPE/.test(src('commands', 'remember', 'index.ts')),
)
const cmds = src('commands.ts')
check('registered in commands.ts (import + array)', /import remember from '\.\/commands\/remember\/index\.js'/.test(cmds) && /\n\s*remember,/.test(cmds))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REMEMBER-COMMAND PROOFS PASS')
else console.log(`❌ ${failures} REMEMBER-COMMAND PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
