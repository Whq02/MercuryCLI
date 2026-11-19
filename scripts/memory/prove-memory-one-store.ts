#!/usr/bin/env bun
// gate-watch: src/mneme/** src/constants/prompts.ts src/constants/subagentDoctrine.ts src/commands.ts
// gate-watch: src/services/instructions/engine.ts src/services/instructions/sourceText.ts src/utils/memory/types.ts
// gate-watch: src/substrate/flagRegistry.ts src/tools/AgentTool/agentMemory.ts src/utils/attachments/orchestrator.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-memory-one-store-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
section('an old index on disk is an ordinary file nobody opens')
const { loadMemoryPrompt } = await import('../../src/mneme/mnemeFrontPage.js')
const { getMnemeHome } = await import('../../src/mneme/paths.js')
const memoryDir = getMnemeHome()
mkdirSync(memoryDir, { recursive: true })
writeFileSync(join(memoryDir, 'MEMORY.md'), '# index\n- [ZEBRAFROST](zebrafrost.md) — a pointer the prompt must never carry\n')
writeFileSync(join(memoryDir, 'zebrafrost.md'), '---\nname: zebrafrost\ndescription: a one-fact file\ntype: project\n---\n\nZEBRAFROST_BODY\n')
const prompt = loadMemoryPrompt() ?? ''
check('the memory prompt carries nothing from the index or the files', !prompt.includes('ZEBRAFROST') && prompt.includes('# Memory'))
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getInstructionFiles } = await import('../../src/services/instructions/engine.js')
const entries = await getInstructionFiles()
check('the instruction bundle holds no entry for the index', !entries.some(e => e.path.endsWith('MEMORY.md')), entries.map(e => e.path).join(', '))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ONE MEMORY: THE RETIRED STORE IS GONE' : `❌ ${failures} ONE-STORE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
