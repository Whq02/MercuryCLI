#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-fm-crlf-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { parseFrontmatter } = await import('../../src/utils/frontmatterParser.ts')
const { parseFrontmatterPaths } = await import('../../src/services/instructions/sourceText.ts')
const skillsMod = await import('../../src/skills/loadSkillsDir.ts')
const agentsMod = await import('../../src/tools/AgentTool/loadAgentsDir.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const crlf = (text: string): string => text.replaceAll('\n', '\r\n')
const endings: Array<[string, (text: string) => string]> = [
  ['LF', text => text],
  ['CRLF', crlf],
  ['BOM+CRLF', text => `\uFEFF${crlf(text)}`],
]

const DESCRIPTION = 'Use when: the operator asks for a probe'
const SKILL = `---\nname: probe\ndescription: ${DESCRIPTION}\nallowed-tools: Read, Grep\n---\n\nBody.\n`
const RULE = '---\npaths: **/*.ts\n---\n\nUse tabs in TypeScript.\n'
const BROKEN = '---\nname: probe\ndescription: Author forbids model invocation.\ndisable-model-invocation: true\n  stray: indent\n---\n\nBody.\n'
const AGENT_NAME = 'crlf-probe-agent'
const AGENT = `---\nname: ${AGENT_NAME}\ndescription: ${DESCRIPTION}\n---\n\nPrompt.\n`

let projectSeq = 0
function freshProject(): string {
  const cwd = join(scratch, `proj-${projectSeq++}`)
  mkdirSync(cwd, { recursive: true })
  return cwd
}
function writeProjectSkill(cwd: string, bytes: string): string {
  const dir = join(cwd, '.mercury', 'skills', 'probe')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, bytes)
  return file
}
async function loadProjectSkills(cwd: string): Promise<Awaited<ReturnType<typeof skillsMod.getSkillDirCommands>>> {
  skillsMod.clearSkillCaches()
  const prev = process.cwd()
  process.chdir(cwd)
  try {
    return await skillsMod.getSkillDirCommands(cwd)
  } finally {
    process.chdir(prev)
  }
}
function writeAgent(cwd: string, name: string, bytes: string): string {
  const dir = join(cwd, '.mercury', 'agents')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.md`)
  writeFileSync(file, bytes)
  return file
}
async function loadAgents(cwd: string): Promise<Awaited<ReturnType<typeof agentsMod.getAgentDefinitionsWithOverrides>>> {
  agentsMod.clearAgentDefinitionsCache()
  return agentsMod.getAgentDefinitionsWithOverrides(cwd)
}

console.log('============================================================')
console.log(' frontmatter fallback — the same reading on LF, CRLF and BOM+CRLF')
console.log('============================================================')

console.log('[1] parseFrontmatter: the quoteSpecialValues fallback reads a value holding ": "')
for (const [label, shape] of endings) {
  const parsed = parseFrontmatter(shape(SKILL))
  check(`${label}: no parse error`, parsed.parseError === undefined, parsed.parseError?.message ?? '')
  check(
    `${label}: name, description and allowed-tools match the LF reading`,
    parsed.frontmatter.name === 'probe' &&
      parsed.frontmatter.description === DESCRIPTION &&
      parsed.frontmatter['allowed-tools'] === 'Read, Grep',
    JSON.stringify(parsed.frontmatter),
  )
}

console.log('[2] parseFrontmatterPaths: a rule glob that starts with * keeps its paths')
for (const [label, shape] of endings) {
  const rule = parseFrontmatterPaths(shape(RULE))
  check(`${label}: paths is ["**/*.ts"]`, JSON.stringify(rule.paths) === JSON.stringify(['**/*.ts']), JSON.stringify(rule))
}

console.log('[3] broken YAML still fails closed on every line ending')
for (const [label, shape] of endings) {
  const parsed = parseFrontmatter(shape(BROKEN))
  check(
    `${label}: the parse error stands and no field is read`,
    parsed.parseError !== undefined && Object.keys(parsed.frontmatter).length === 0,
    JSON.stringify(parsed.frontmatter),
  )
}

console.log('[4] skills-dir: the skill loads on every line ending')
for (const [label, shape] of endings) {
  const cwd = freshProject()
  const file = writeProjectSkill(cwd, shape(SKILL))
  const commands = await loadProjectSkills(cwd)
  check(`${label}: the skill is offered`, commands.some(c => c.name === 'probe'), commands.map(c => c.name).join(' '))
  const row = skillsMod.getSkillLoadRefusals().find(r => r.path === file)
  check(`${label}: no refusal names the file`, row === undefined, row?.error ?? '')
}

console.log('[5] agents: the agent is active on every line ending')
for (const [label, shape] of endings) {
  const cwd = freshProject()
  const file = writeAgent(cwd, AGENT_NAME, shape(AGENT))
  const result = await loadAgents(cwd)
  check(`${label}: the agent is active`, result.activeAgents.some(a => a.agentType === AGENT_NAME))
  const row = (result.failedFiles ?? []).find(r => r.path === file)
  check(`${label}: failedFiles carries no row for the file`, row === undefined, row?.error ?? '')
}

try {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? `\nALL ${checks} FRONTMATTER LINE-ENDING CHECKS PASS` : `\n${failures} OF ${checks} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
