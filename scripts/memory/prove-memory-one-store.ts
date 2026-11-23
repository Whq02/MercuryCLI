#!/usr/bin/env bun
// gate-watch: src/sessions/mneme/** src/engine/system-prompt/defaultSystemPrompt.ts src/tools/crewmate/subagentDoctrine.ts src/commands/catalogue/commands.ts
// gate-watch: src/sessions/instructions/instructionFiles.ts src/sessions/instructions/sourceText.ts src/sessions/memory-shapes/types.ts
// gate-watch: src/platform/substrate/flagRegistry.ts src/crew/agents/agentMemory.ts src/engine/attachments/turnAttachments.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-memory-one-store-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
const ONE_STORE_FIX_HINT = 'stop loadMemoryPrompt in src/sessions/mneme/mnemeFrontPage.ts and getInstructionFiles in src/sessions/instructions/instructionFiles.ts from reading the old MEMORY.md index or its pointer files; the library under the mneme home is the only memory store'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ` | fix: ${ONE_STORE_FIX_HINT}`}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
section('an old index on disk is an ordinary file nobody opens')
const { loadMemoryPrompt } = await import('../../src/sessions/mneme/mnemeFrontPage.js')
const { getMnemeHome } = await import('../../src/sessions/mneme/paths.js')
const memoryDir = getMnemeHome()
mkdirSync(memoryDir, { recursive: true })
writeFileSync(join(memoryDir, 'MEMORY.md'), '# index\n- [ZEBRAFROST](zebrafrost.md) — a pointer the prompt must never carry\n')
writeFileSync(join(memoryDir, 'zebrafrost.md'), '---\nname: zebrafrost\ndescription: a one-fact file\ntype: project\n---\n\nZEBRAFROST_BODY\n')
const prompt = loadMemoryPrompt() ?? ''
check('the memory prompt carries nothing from the index or the files', !prompt.includes('ZEBRAFROST') && prompt.includes('# Memory'))
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { getInstructionFiles } = await import('../../src/sessions/instructions/instructionFiles.js')
const entries = await getInstructionFiles()
check('the instruction bundle holds no entry for the index', !entries.some(e => e.path.endsWith('MEMORY.md')), entries.map(e => e.path).join(', '))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ONE MEMORY: THE RETIRED STORE IS GONE' : `❌ ${failures} ONE-STORE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
