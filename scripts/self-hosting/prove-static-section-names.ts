#!/usr/bin/env bun
// ============================================================================
//  scripts/self-hosting/prove-static-section-names.ts — the static head
//  sections carry their own names on every provenance surface (FN-017
//  rank 11: the name table was one entry short).
//
//  prompts.ts supplies EIGHT static sections in order; STATIC_SECTION_NAMES
//  held seven, and buildBehaviourContract indexes positionally — so the
//  project-instruction-estate section was labelled "using-tools", the
//  using-your-tools section "tone-style", the tone section
//  "output-efficiency" and the communication section fell through to
//  "static-7" on /provenance and the /health request-context row. An
//  operator trimming the prompt attributed characters to the wrong owner.
//
//   §1 the ratchet: the table's length IS the static section count
//   §2 DRIVEN: a real composition's provenance names every static section
//      from the table — no positional fallback
//
//  Run:  ~/.bun/bin/bun run scripts/self-hosting/prove-static-section-names.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_SIMPLE']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-static-names-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const { STATIC_SECTION_NAMES } = await import('../../src/prompt/behaviourContract.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

console.log('the static head sections carry their own names')

section('§1 the ratchet: one name per static section')
{
  const prompts = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
  const literal = prompts.slice(prompts.indexOf('const staticSections: Array<string | null> = ['), prompts.indexOf('].map(section => (section === \'\' ? null : section))'))
  const entries = literal.split('\n').filter(line => /^\s+\w+Section\(/.test(line)).length
  check('the composer supplies eight static sections (the fixture reads the real list)', entries === 8, String(entries))
  check('THE NAME TABLE HAS ONE ENTRY PER SECTION (the base had seven for eight)', STATIC_SECTION_NAMES.length === entries, `${STATIC_SECTION_NAMES.length} vs ${entries}`)
  check('the instruction-estate section has its own name at its own index', STATIC_SECTION_NAMES[4] === 'instruction-estate' && STATIC_SECTION_NAMES[5] === 'using-tools' && STATIC_SECTION_NAMES[6] === 'tone-style' && STATIC_SECTION_NAMES[7] === 'output-efficiency', STATIC_SECTION_NAMES.join(','))
}

section('§2 a real composition names every static section from the table')
{
  const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
  const provenance = await import('../../src/utils/cockpit/promptProvenance.ts')
  await getSystemPrompt([], 'claude-fable-5-1')
  const recorded = provenance.readPromptProvenance()
  const statics = (recorded?.sections ?? []).filter(s => s.group === 'static').map(s => s.name)
  check('the composition recorded static sections', statics.length > 0, JSON.stringify(recorded?.sections?.length))
  check('no static section wears the positional fallback name (static-N)', statics.every(n => !/^static-\d+$/.test(n)), statics.join(','))
  check('every static name is from the table', statics.every(n => STATIC_SECTION_NAMES.includes(n)), statics.join(','))
  check('the instruction-estate section is named on the surface', statics.includes('instruction-estate'), statics.join(','))
  check('the communication section wears its own name, not its neighbour\'s', statics[statics.length - 1] === 'output-efficiency', statics.join(','))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-static-section-names${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
