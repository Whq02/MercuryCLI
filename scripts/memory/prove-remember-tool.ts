#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-remember-tool.ts
//  PROOF: the RememberLesson TOOL closes the experience-card write loop for the AGENT
//  (the /remember command closed it for the operator). A deferred, stamp-gated tool that
//  drives writeExperienceCard with the agent's STRUCTURED input — so the daemon Implementer
//  (and any agent) can bank a VERIFIED transferable lesson mid-run, born a candidate.
//
//  Exercises the descriptor + fork gating + the call() floor on its NO-WRITE skip paths
//  (greenGatePassed:false ⇒ not-high-signal; too-short ⇒ skipped) so it never pollutes the
//  real memory dir; the positive write is the same writeExperienceCard path proven elsewhere.
//  Run: ~/.bun/bin/bun run scripts/memory/prove-remember-tool.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RememberLessonTool } from '../../src/tools/RememberLessonTool/RememberLessonTool.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const setStamp = (on: boolean) => ((globalThis as Record<string, unknown>)['MACRO'] = { VERSION: on ? '1.0.0' : '0.0.0-src' })

console.log('============================================================')
console.log(' RememberLesson TOOL — agent-facing experience-card write')
console.log('============================================================')

section('descriptor + gating (stamp-independent )')
check('name=RememberLesson, deferred (searchable)', RememberLessonTool.name === 'RememberLesson' && RememberLessonTool.shouldDefer === true)
setStamp(true)
check('isEnabled() TRUE on fork + auto-memory', RememberLessonTool.isEnabled?.() === true)
// availability is stamp-independent.
setStamp(false)
check('isEnabled() TRUE under a bare stamp (stamp-independence)', RememberLessonTool.isEnabled?.() === true)
setStamp(true)

section('call() honors the distill floor WITHOUT writing (the {signal} gate)')
const r1 = await RememberLessonTool.call({ problemClass: 'proof', lesson: 'A transferable lesson long enough to clear the length floor here.', title: 't', summary: 's', greenGatePassed: false } as never)
check('greenGatePassed:false ⇒ NOT banked (only verified lessons)', r1.data.banked === false && /skipped|high-signal/.test(r1.data.reason ?? ''))
const r2 = await RememberLessonTool.call({ problemClass: 'proof', lesson: 'short', title: 't', summary: 's', greenGatePassed: true } as never)
check('too-short lesson ⇒ NOT banked (skipped, no write)', r2.data.banked === false)

section('registered + stamp-gated require + the finer runtime gate (structural)')
const t = src('tools.ts')
check('RememberLessonTool resolves absence-tolerantly', /const REMEMBER_LESSON_TOOL = cycleTolerant\(\(\) => RememberLessonTool\)/.test(t))
check('added to the tools array (falsy rows filter out)', /\n\s+REMEMBER_LESSON_TOOL,\n/.test(t))
const p = src('tools', 'RememberLessonTool', 'prompt.ts')
check('isEnabled gates on experienceCardsEnabled() && isAutoMemoryEnabled()', /experienceCardsEnabled\(\) && isAutoMemoryEnabled\(\)/.test(p))
check('born a candidate (approved:false) in the tool call', /approved:\s*false/.test(src('tools', 'RememberLessonTool', 'RememberLessonTool.ts')))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REMEMBER-TOOL PROOFS PASS')
else console.log(`❌ ${failures} REMEMBER-TOOL PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
