#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'static-sections-home-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_BARE

const j = (v: unknown): string => JSON.stringify(v)
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function firstDifference(a: string, b: string): string {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  return `differ at char ${at}: ${j(a.slice(Math.max(0, at - 60), at + 120))} vs ${j(b.slice(Math.max(0, at - 60), at + 120))}`
}
const linesOf = (block: string): string => block.split('\n').map(line => line.trimEnd()).join('\n').trim()
function blockOf(prompt: string, heading: string, nextHeading: string): string {
  const start = prompt.indexOf(heading)
  const end = prompt.indexOf(nextHeading)
  if (start === -1 || end === -1) return ''
  return linesOf(prompt.slice(start, end))
}

const ROOT = join(import.meta.dir, '..', '..')
const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { clearSystemPromptSections } = await import('../../src/engine/system-prompt/systemPromptSections.ts')
const { getOriginalCwd, setOriginalCwd, setCwdState, getSystemPromptSectionCache } = await import('../../src/boot/process-state/processState.ts')
const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore } = await import('../../src/models/roads/toolEconomy.ts')
const { boundPrefixRecordToEmit, restoreBoundPrefixFromMessages, resetBoundPrefixEmitted } = await import('../../src/models/roads/anthropic/boundPrefixRecord.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { TASK_CREATE_TOOL_NAME } = await import('../../src/tools/kit/names/taskCreate.ts')
const { RECORD_CONVENTION_TOOL_NAME } = await import('../../src/tools/record-convention/prompt.ts')
const { RETAIN_TOOL_NAME } = await import('../../src/tools/kit/names/memory.ts')

const scratch = mkdtempSync(join(tmpdir(), 'static-sections-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)

const MODEL = 'claude-fable-5-1'
const ESTATE = '# The project estate'
const MEMORY = '# Memory'
const ESTATE_TOOL_WORDS = `the ${RECORD_CONVENTION_TOOL_NAME} tool writes it there`
const tool = (name: string): { name: string } => ({ name })
const firstPool = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Crewmate', 'Skill', 'AskUserQuestion', RECORD_CONVENTION_TOOL_NAME, RETAIN_TOOL_NAME].map(tool)
const taskTools = [TASK_CREATE_TOOL_NAME, 'TaskGet', 'TaskList', 'TaskUpdate'].map(tool)
const grownPool = [...firstPool, ...taskTools]
const shrunkPool = firstPool.filter(t => t.name !== RECORD_CONVENTION_TOOL_NAME)
const owner = 'static-sections'
const messages = [{ type: 'user', uuid: 'u-static-sections', message: { role: 'user', content: 'first' } }]
const text = (parts: string[]): string => parts.join('\n\n')
const build = async (pool: Array<{ name: string }>): Promise<string> => text(await getSystemPrompt(pool as never, MODEL))
const freshProcess = (): void => {
  clearSystemPromptSections()
  clearToolRosterLatches()
  clearToolRosterRestore()
  resetBoundPrefixEmitted()
}
type SectionRow = { name: string; key: string | null; value: string | null }

try {
  section('§1 the first process — a pool without the task tools builds, plans and writes the first exchange record')
  freshProcess()
  const first = await build(firstPool)
  check('the control: the first build names the convention tool in the estate section', first.includes(ESTATE_TOOL_WORDS), 'projectEstateSection in src/engine/system-prompt/defaultSystemPrompt.ts must name the convention tool when the tool pool holds it')
  const snapshot = readFileSync(join(ROOT, 'scripts/agent-experience/baselines/mechanical/prompts/anthropic.system.txt'), 'utf8')
  check('a first build renders the estate section line for line as the recorded first request (no first-build change)', blockOf(first, ESTATE, MEMORY) !== '' && blockOf(first, ESTATE, MEMORY) === blockOf(snapshot, ESTATE, MEMORY), `${firstDifference(blockOf(first, ESTATE, MEMORY), blockOf(snapshot, ESTATE, MEMORY))}; keep projectEstateSection in src/engine/system-prompt/defaultSystemPrompt.ts as the recorded text, or re-record scripts/agent-experience/baselines/mechanical/prompts/anthropic.system.txt if the change is wanted`)
  check('a second build in the same process is byte-identical (the frozen conversation)', (await build(firstPool)) === first, 'a section in src/engine/system-prompt/defaultSystemPrompt.ts renders differently on a second getSystemPrompt call; cache it with systemPromptSection in src/engine/system-prompt/systemPromptSections.ts')
  await planToolPayload({ model: MODEL, tools: firstPool as never, messages: messages as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
  const row = await boundPrefixRecordToEmit(owner, messages as never, MODEL)
  check('the first exchange emits its record', row !== null && row.attachment.type === 'bound_prefix', 'boundPrefixRecordToEmit in src/models/roads/anthropic/boundPrefixRecord.ts must return a bound_prefix row for the first exchange after planToolPayload')
  const persisted = JSON.parse(j(row)) as { attachment: { sections: SectionRow[] } }
  const sections = persisted.attachment.sections
  const named = (name: string): SectionRow | undefined => sections.find(s => s.name === name)
  check('every recorded section keeps the record\'s row shape (name, key, value)', sections.length > 0 && sections.every(s => typeof s.name === 'string' && 'key' in s && 'value' in s), `${j(sections.map(s => s.name))}; the record built by boundPrefixRecordToEmit in src/models/roads/anthropic/boundPrefixRecord.ts must give every section name, key and value`)
  check('RED ON A TREE THAT RENDERS THE TOOL-NAMING SECTIONS LIVE: the record carries the estate section beside the other cached sections', named('project_estate')?.value?.startsWith(ESTATE) === true, `recorded sections: ${sections.map(s => s.name).join(', ')}; the project_estate section from projectEstateSection in src/engine/system-prompt/defaultSystemPrompt.ts must be recorded with the cached sections`)

  section('§2 a new process — the task tools joined the pool; the resumed build must re-send the bytes first sent')
  freshProcess()
  check('a new process starts with an empty section cache', getSystemPromptSectionCache().size === 0, 'clearSystemPromptSections in src/engine/system-prompt/systemPromptSections.ts must empty the section cache')
  restoreBoundPrefixFromMessages([persisted as never])
  const resumed = await build(grownPool)
  check('the resumed build is byte-identical to the first although the task tools joined the pool (no section names them)', resumed === first, `${firstDifference(first, resumed)}; restoreBoundPrefixFromMessages in src/models/roads/anthropic/boundPrefixRecord.ts must restore the recorded sections so a changed tool pool does not change the prompt, and no section in src/engine/system-prompt/defaultSystemPrompt.ts may name the task tools`)

  section('§3 a new process — the convention tool left the pool; the estate section still names it as first sent')
  freshProcess()
  restoreBoundPrefixFromMessages([persisted as never])
  const shrunk = await build(shrunkPool)
  check('RED ON A TREE THAT RENDERS THE TOOL-NAMING SECTIONS LIVE: the resumed build is byte-identical to the first although the convention tool left the pool', shrunk === first && shrunk.includes(ESTATE_TOOL_WORDS), `${firstDifference(first, shrunk)}; the project_estate section must be restored from the record by restoreBoundPrefixFromMessages in src/models/roads/anthropic/boundPrefixRecord.ts, not rendered live from the pool in projectEstateSection in src/engine/system-prompt/defaultSystemPrompt.ts`)

  section('§4 the controls — the pool\'s truth returns at the lawful boundary and on a first build')
  clearSystemPromptSections()
  const cleared = await build(shrunkPool)
  check('after a lawful clear (the /clear and /compact boundary) the estate section stops naming the departed convention tool: the pool\'s truth after the boundary', cleared !== first && !cleared.includes(ESTATE_TOOL_WORDS), 'clearSystemPromptSections in src/engine/system-prompt/systemPromptSections.ts must drop the cached estate section so the next build renders from the current pool')
  freshProcess()
  const shrunkFirst = await build(shrunkPool)
  check('a first build without the convention tool in the pool names it nowhere (the record freezes nothing on a first build)', !shrunkFirst.includes(ESTATE_TOOL_WORDS) && shrunkFirst === cleared, 'projectEstateSection in src/engine/system-prompt/defaultSystemPrompt.ts must name the convention tool only when the pool holds it, and a first build must not restore any record')
  const shrunkGrown = await build(grownPool)
  check('RED ON A TREE THAT RENDERS THE TOOL-NAMING SECTIONS LIVE: within one process the estate section holds as first built when the pool moves (the same law as every cached section: a moved pool reaches the model on a new row, never in the prefix)', shrunkGrown === shrunkFirst, `${firstDifference(shrunkFirst, shrunkGrown)}; the project_estate section must stay cached in src/engine/system-prompt/systemPromptSections.ts (systemPromptSection) when the pool changes inside one process`)
} finally {
  freshProcess()
  process.chdir(cwd)
  setOriginalCwd(originalCwd)
  setCwdState(cwd)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} static sections recorded: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
