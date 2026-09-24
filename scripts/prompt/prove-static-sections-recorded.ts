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
const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
const { getOriginalCwd, setOriginalCwd, setCwdState, getSystemPromptSectionCache } = await import('../../src/bootstrap/state.ts')
const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore } = await import('../../src/services/providers/toolEconomy.ts')
const { boundPrefixRecordToEmit, restoreBoundPrefixFromMessages, resetBoundPrefixEmitted } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { TASK_CREATE_TOOL_NAME } = await import('../../src/tools/TaskCreateTool/constants.ts')
const { RECORD_CONVENTION_TOOL_NAME } = await import('../../src/tools/RecordConventionTool/prompt.ts')
const { REMEMBER_LESSON_TOOL_NAME } = await import('../../src/tools/RememberLessonTool/prompt.ts')

const scratch = mkdtempSync(join(tmpdir(), 'static-sections-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)

const MODEL = 'claude-fable-5-1'
const USING_TOOLS = '# Using your tools'
const ESTATE = '# The project instruction estate'
const TONE = '# Tone and style'
const BULLET = 'Break down and manage work with the'
const ESTATE_TOOL_WORDS = `with the ${RECORD_CONVENTION_TOOL_NAME} tool`
const tool = (name: string): { name: string } => ({ name })
const firstPool = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent', 'Skill', 'AskUserQuestion', RECORD_CONVENTION_TOOL_NAME, REMEMBER_LESSON_TOOL_NAME].map(tool)
const taskTools = [TASK_CREATE_TOOL_NAME, 'TaskGet', 'TaskList', 'TaskUpdate'].map(tool)
const grownPool = [...firstPool, ...taskTools]
const shrunkPool = firstPool.filter(t => t.name !== RECORD_CONVENTION_TOOL_NAME && t.name !== REMEMBER_LESSON_TOOL_NAME)
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
  check('the control: the first build names no work-breakdown bullet (no task tool in the pool) and names the convention tool in the estate section', !first.includes(BULLET) && first.includes(USING_TOOLS) && first.includes(ESTATE_TOOL_WORDS))
  const snapshot = readFileSync(join(ROOT, 'scripts/agent-experience/baselines/mechanical/prompts/anthropic.system.txt'), 'utf8')
  check('a first build renders the "Using your tools" section line for line as the recorded first request (no first-build change)', blockOf(first, USING_TOOLS, TONE) !== '' && blockOf(first, USING_TOOLS, TONE) === blockOf(snapshot, USING_TOOLS, TONE), firstDifference(blockOf(first, USING_TOOLS, TONE), blockOf(snapshot, USING_TOOLS, TONE)))
  check('a first build renders the instruction-estate section line for line as the recorded first request (no first-build change)', blockOf(first, ESTATE, USING_TOOLS) !== '' && blockOf(first, ESTATE, USING_TOOLS) === blockOf(snapshot, ESTATE, USING_TOOLS), firstDifference(blockOf(first, ESTATE, USING_TOOLS), blockOf(snapshot, ESTATE, USING_TOOLS)))
  check('a second build in the same process is byte-identical (the frozen conversation)', (await build(firstPool)) === first)
  await planToolPayload({ model: MODEL, tools: firstPool as never, messages: messages as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
  const row = await boundPrefixRecordToEmit(owner, messages as never, MODEL)
  check('the first exchange emits its record', row !== null && row.attachment.type === 'bound_prefix')
  const persisted = JSON.parse(j(row)) as { attachment: { sections: SectionRow[] } }
  const sections = persisted.attachment.sections
  const named = (name: string): SectionRow | undefined => sections.find(s => s.name === name)
  check('every recorded section keeps the record\'s row shape (name, key, value)', sections.length > 0 && sections.every(s => typeof s.name === 'string' && 'key' in s && 'value' in s), j(sections.map(s => s.name)))
  check('RED ON A TREE THAT RENDERS THE TOOL-NAMING SECTIONS LIVE: the record carries the "Using your tools" section and the instruction-estate section beside the dynamic ones', named('using_tools')?.value?.startsWith(USING_TOOLS) === true && named('instruction_estate')?.value?.startsWith(ESTATE) === true, `recorded sections: ${sections.map(s => s.name).join(', ')}`)

  section('§2 a new process — the task tools joined the pool; the resumed build must re-send the bytes first sent')
  freshProcess()
  check('a new process starts with an empty section cache', getSystemPromptSectionCache().size === 0)
  restoreBoundPrefixFromMessages([persisted as never])
  const resumed = await build(grownPool)
  check('RED ON A TREE THAT RENDERS THE TOOL-NAMING SECTIONS LIVE: the resumed build is byte-identical to the first although the task tools joined the pool — no work-breakdown bullet appears', resumed === first && !resumed.includes(BULLET), firstDifference(first, resumed))

  section('§3 a new process — the convention and lesson tools left the pool; the estate section still names them as first sent')
  freshProcess()
  restoreBoundPrefixFromMessages([persisted as never])
  const shrunk = await build(shrunkPool)
  check('RED ON A TREE THAT RENDERS THE TOOL-NAMING SECTIONS LIVE: the resumed build is byte-identical to the first although the convention and lesson tools left the pool', shrunk === first && shrunk.includes(ESTATE_TOOL_WORDS), firstDifference(first, shrunk))

  section('§4 the controls — the pool\'s truth returns at the lawful boundary and on a first build')
  clearSystemPromptSections()
  const cleared = await build(grownPool)
  check('after a lawful clear (the /clear and /compact boundary) the work-breakdown bullet appears: the pool\'s truth after the boundary', cleared !== first && cleared.includes(BULLET) && blockOf(cleared, USING_TOOLS, TONE).endsWith('do not batch completions.'))
  freshProcess()
  const grownFirst = await build(grownPool)
  check('a first build with the task tools in the pool carries the bullet (the record freezes nothing on a first build)', grownFirst.includes(BULLET) && grownFirst === cleared)
  const grownShrunk = await build(shrunkPool)
  check('RED ON A TREE THAT RENDERS THE TOOL-NAMING SECTIONS LIVE: within one process the two sections hold as first built when the pool moves (the same law as every cached section: a moved pool reaches the model on a new row, never in the prefix)', grownShrunk === grownFirst, firstDifference(grownFirst, grownShrunk))
} finally {
  freshProcess()
  process.chdir(cwd)
  setOriginalCwd(originalCwd)
  setCwdState(cwd)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} static sections recorded: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
