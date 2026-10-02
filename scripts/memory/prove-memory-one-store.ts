#!/usr/bin/env bun
// gate-watch: src/memdir/** src/constants/prompts.ts src/constants/subagentDoctrine.ts src/commands.ts
// gate-watch: src/services/instructions/engine.ts src/services/instructions/sourceText.ts src/utils/memory/types.ts
// gate-watch: src/substrate/flagRegistry.ts src/tools/AgentTool/agentMemory.ts src/utils/attachments/orchestrator.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
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
function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
}
const files: string[] = []
walk(join(ROOT, 'src'), files)
const rel = (p: string): string => p.slice(ROOT.length + 1)
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

section('the modules of the retired store are gone')
for (const name of ['memdir', 'memoryTypes', 'memoryScan', 'findRelevantMemories', 'experienceCards', 'curationLoop', 'tasteLoop', 'promoteRungate', 'memoryAge', 'memoryReferents']) {
  check(`src/memdir/${name}.ts is absent`, !existsSync(join(ROOT, 'src/memdir', `${name}.ts`)))
}
for (const dir of ['src/commands/remember', 'src/commands/cards', 'src/commands/meh', 'src/commands/good', 'src/commands/taste', 'src/services/memoryUpkeep', 'src/tasks/DreamTask']) {
  check(`${dir} is absent`, !existsSync(join(ROOT, dir)))
}
check('the cards view is absent', !existsSync(join(ROOT, 'src/components/CardsView.tsx')))

section('the words of the retired store are not in the product')
const INTAKE = 'src/memdir/mnemeHandover.ts'
const carriers = (re: RegExp, except: string[] = []): string[] =>
  files.filter(p => !except.includes(rel(p))).filter(p => re.test(readFileSync(p, 'utf8'))).map(rel)
check('no source names the index file (the intake, which skips it, is the one reader of the name)', carriers(/MEMORY\.md/, [INTAKE]).length === 0, carriers(/MEMORY\.md/, [INTAKE]).join(', '))
check('no source carries the four kinds as a memory taxonomy', carriers(/'user', 'feedback', 'project', 'reference'|## Memory types|Saving a memory takes two steps/).length === 0)
check('no source names experience cards (the intake recognises the old header, nothing else)', carriers(/experience[- ]card|experienceCard/i, [INTAKE]).length === 0, carriers(/experience[- ]card|experienceCard/i, [INTAKE]).join(', '))
const SETTINGS_LANE = ['src/utils/settings/types.ts', 'src/migrations/migrateSettingsSpellings.ts']
check('no source names the taste loop, the notes upkeep or the dream task (the settings key and its spelling row are the settings lane\'s queue row)', carriers(/tasteLoop|taste_recall|memoryUpkeep|DreamTask|'dream'/, SETTINGS_LANE).length === 0, carriers(/tasteLoop|taste_recall|memoryUpkeep|DreamTask|'dream'/, SETTINGS_LANE).join(', '))
check("no source reads an 'AutoMem' instruction entry", carriers(/'AutoMem'|'TeamMem'/).length === 0, carriers(/'AutoMem'|'TeamMem'/).join(', '))
check('no command is registered for the retired surfaces', !/remember|\bcards\b|\bmeh\b|\bgood\b/.test(read('src/commands.ts').split('\n').filter(l => /^import .* from '\.\/commands\//.test(l)).join('\n')))
const registry = read('src/substrate/flagRegistry.ts')
for (const flag of ['MERCURY_EXPERIENCE_CARDS', 'MERCURY_TASTE_LOOP', 'MERCURY_RELEVANT_RECALL', 'MERCURY_CARD_DEDUP', 'MERCURY_CARD_PROMOTE_GATE', 'MERCURY_CARD_PROMOTE_RUNGATE', 'MERCURY_CARD_RECALL_PRECISION', 'MERCURY_CARD_SUPERSEDE', 'MERCURY_CARD_TRACE_GROUND']) {
  check(`the registry has no ${flag} row`, !registry.includes(`env: '${flag}'`))
}
check('the registry remembers no retired memory flag in its retired table', !/RETIRED_FLAGS[\s\S]*MERCURY_(MNEME|EXPERIENCE_CARDS|TASTE_LOOP|RELEVANT_RECALL|CARD_)/.test(registry))
const types = read('src/utils/memory/types.ts')
check('the instruction-file type union is the four instruction kinds only', /\['User', 'Project', 'Local', 'Managed'\]/.test(types) && !types.includes('AutoMem'))

section('the model is told about one memory only')
const prompts = read('src/constants/prompts.ts')
check('the system prompt has no memory-file pointer line', !prompts.includes('pointer line') && !prompts.includes('memory file'))
check("the system prompt's memory section is the front page", prompts.includes("from '../memdir/mnemeFrontPage.js'") && !prompts.includes('memdir/memdir.js'))
const doctrine = read('src/constants/subagentDoctrine.ts')
check('the sub-agent doctrine carries no card doctrine', !/cardDoctrine|experienceCardDoctrineLines/.test(doctrine))
const agentMemory = read('src/tools/AgentTool/agentMemory.ts')
check('a memory-enabled agent is pointed at the shared memory through the tools', agentMemory.includes('Retain saves a durable fact') && !agentMemory.includes('buildMemoryPrompt'))
const orchestrator = read('src/utils/attachments/orchestrator.ts')
check('the lookup rides the input lane of the attachment orchestrator', orchestrator.includes("'relevant_memories'") && orchestrator.includes('getRelevantMemoryAttachments(input, messages, toolUseContext)'))
check('no taste attachment is produced', !orchestrator.includes('taste_recall'))

section('an old index on disk is an ordinary file nobody opens')
const { loadMemoryPrompt } = await import('../../src/memdir/mnemeFrontPage.js')
const { getAutoMemPath } = await import('../../src/memdir/paths.js')
const memDir = getAutoMemPath()
mkdirSync(memDir, { recursive: true })
writeFileSync(join(memDir, 'MEMORY.md'), '# index\n- [ZEBRAFROST](zebrafrost.md) — a pointer the prompt must never carry\n')
writeFileSync(join(memDir, 'zebrafrost.md'), '---\nname: zebrafrost\ndescription: a one-fact file\ntype: project\n---\n\nZEBRAFROST_BODY\n')
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
