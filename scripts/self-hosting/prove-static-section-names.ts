#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_BARE']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-static-names-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const namesHint = ' | change STATIC_SECTION_NAMES in src/engine/system-prompt/behaviourContract.ts, or where getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts names its static sections'
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { STATIC_SECTION_NAMES } = await import('../../src/engine/system-prompt/behaviourContract.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

console.log('the static head sections carry their own names')

section('§1 one name per static section')
{
  check('the head and the constitution have their own names at their own indices', STATIC_SECTION_NAMES[0] === 'head' && STATIC_SECTION_NAMES[1] === 'constitution', STATIC_SECTION_NAMES.join(',') + namesHint)
}

section('§2 a real composition names every static section from the table')
{
  const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
  const provenance = await import('../../src/screen/cockpit/promptProvenance.ts')
  await getSystemPrompt([], 'claude-fable-5-1')
  const recorded = provenance.readPromptProvenance()
  const statics = (recorded?.sections ?? []).filter(s => s.group === 'static').map(s => s.name)
  check('the composition recorded static sections', statics.length > 0, JSON.stringify(recorded?.sections?.length) + namesHint)
  check('no static section wears the positional fallback name (static-N)', statics.every(n => !/^static-\d+$/.test(n)), statics.join(',') + namesHint)
  check('every static name is from the table', statics.every(n => STATIC_SECTION_NAMES.includes(n)), statics.join(',') + namesHint)
  check('the constitution is named on the surface', statics.includes('constitution'), statics.join(',') + namesHint)
  check('the constitution wears its own name, after the head', statics.join(',') === 'head,constitution', statics.join(',') + namesHint)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-static-section-names${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
