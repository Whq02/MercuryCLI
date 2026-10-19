#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crewmate-tool-name-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.ANTHROPIC_BASE_URL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const TOOL = 'Crewmate'
const RESUME = 'ResumeCrewmate'
const FIELD = 'crewmate_type'
const OLD_TOOL = J('Ag', 'ent')
const OLD_RESUME = J('Resume', 'Ag', 'ent')
const OLD_FIELD = J('sub', 'agent_type')
const OLD_GLOSS = J('sub-', 'agent')
const OLD_GLOSS_JOINED = J('sub', 'agent')

const WORDS: Array<[string, RegExp]> = [
  ['the old tool name in quotes', new RegExp(`(["'\`])${OLD_TOOL}\\1`)],
  ['the old tool name before "tool"', new RegExp(`(?<![\\w$.\\-/])${OLD_TOOL}(?:\\s+tool|-tool)(?![\\w$-])`)],
  ['the old tool name before "call", "launch" or "launched"', new RegExp(`(?<![\\w$.\\-/])${OLD_TOOL} (?:call|launch|launched)(?![\\w$-])`)],
  ['the old tool name beside the Workflow tool', new RegExp(`(?<![\\w$.\\-/])${OLD_TOOL} (?:and|or) Workflow`)],
  ['the old tool name in a permission rule', new RegExp(`(?<!new )(?<![\\w$.\\-/])${OLD_TOOL}\\((?=[A-Za-z*_-])`)],
  ['the old resume verb', new RegExp(`(?<![\\w$.\\-/])${OLD_RESUME}(?![\\w$])`)],
  ['the old launch field', new RegExp(`(?<![\\w$])${OLD_FIELD}(?![\\w$])`)],
]

const MODEL_FACING: Array<[string, RegExp]> = [
  ['the old tool name as a word', new RegExp(`(?<![\\w$.\\-/])${OLD_TOOL}(?![\\w$])`)],
  ['the old resume verb', new RegExp(`(?<![\\w$.\\-/])${OLD_RESUME}(?![\\w$])`)],
  ['the old launch field', new RegExp(`(?<![\\w$])${OLD_FIELD}(?![\\w$])`)],
  ['the old gloss', new RegExp(`(?<![\\w-])${OLD_GLOSS}s?(?![\\w-])`, 'i')],
  ['the old gloss joined', new RegExp(`(?<![\\w-])${OLD_GLOSS_JOINED}s?(?![\\w-])`, 'i')],
]

const EXCLUDED_AREAS: Array<[string, string]> = [
  ['docs/releases/', 'published release pages are history'],
  ['src/constants/changelog.ts', 'past release notes stay as published'],
  ['scripts/interview/baselines/', 'frozen journey capture records'],
  ['scripts/visual-contract/baselines/', 'frozen capture records of earlier screens'],
  ['scripts/agent-experience/baselines/', 'frozen mechanical baselines of earlier prompts: the tool names a past run offered'],
  ['scripts/mission-runner/corpus/', 'fixture repositories of foreign source'],
  ['scripts/search/fixtures/', 'recorded web pages and search answers of other sites'],
]

const PINS: Array<[string, string]> = [
  ['scripts/identity/prove-crewmate-tool-name.ts', 'this census composes the names it hunts'],
  ['scripts/dev/rename-agent-tool-to-crewmate.ts', 'the rename script carries both spellings by design'],
  ['scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', "an older build's transcript rows, unedited by design"],
  ['scripts/bash/parser-corpus-parity.json', 'a parser corpus: a recorded command text parsed again against its recorded tree'],
  ['scripts/crew/prove-old-tool-name-rows.ts', 'the pin that drives an old transcript row under the old name'],
  ['scripts/tools/prove-tool-name-recovery.ts', 'the proof that the retired spelling fails as an unknown input and the refusal names the current tools'],
]

const NOT_THE_TOOL: Array<[string, string, string]> = [
  ['src/utils/hooks/hooksSettings.ts', `return '${OLD_TOOL}'`, "the short word for a hook that came from an agent definition's frontmatter, beside Extension and Skill"],
  ['src/utils/model/agentModelPicker.ts', `group: '${OLD_TOOL}'`, "the agent model picker's group label for the agent definition being edited"],
  ['scripts/api/node-transport-lane.mjs', `=== '${OLD_TOOL}'`, "undici's dispatcher class, compared by its constructor name"],
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(` the tool that launches a crewmate is named ${TOOL}: the model sees no other name for it, and no tracked file spells the old one outside the pins`)
console.log('============================================================')

section('§1 the live roster')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { findToolByName, getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { AGENT_TOOL_NAME } = await import('../../src/tools/AgentTool/constants.ts')
const { RESUME_AGENT_TOOL_NAME } = await import('../../src/tools/ResumeAgentTool/constants.ts')
const tools = getAllBaseTools()
const names = tools.map(tool => tool.name)
check(`the launch tool is named ${TOOL} and the resume verb ${RESUME}`, AGENT_TOOL_NAME === TOOL && RESUME_AGENT_TOOL_NAME === RESUME, `${AGENT_TOOL_NAME} · ${RESUME_AGENT_TOOL_NAME}`)
check('both are in the base roster', names.includes(TOOL) && names.includes(RESUME), names.join(', '))
check('no tool bears an old name', !names.includes(OLD_TOOL) && !names.includes(OLD_RESUME))
check('no tool answers to an old name through an alias', findToolByName(tools, OLD_TOOL) === undefined && findToolByName(tools, OLD_RESUME) === undefined && tools.every(tool => !(tool.aliases ?? []).some(alias => alias === OLD_TOOL || alias === OLD_RESUME)))
const launch = tools.find(tool => tool.name === TOOL)
const permissionContext = getEmptyToolPermissionContext()
const render = async (tool: (typeof tools)[number]): Promise<string> => JSON.stringify(await toolToAPISchema(tool, { getToolPermissionContext: async () => permissionContext, tools, agents: [], model: 'claude-fable-5-1' }))
const launchBytes = launch === undefined ? '' : await render(launch)
check(`the launch tool's schema carries ${FIELD}`, launchBytes.includes(`"${FIELD}"`), launch === undefined ? `no tool named ${TOOL}` : '')
check(`the launch tool's description says crewmate and no old gloss`, /crewmate/.test(launchBytes) && !MODEL_FACING.some(([, re]) => re.test(launchBytes)), launchBytes.slice(0, 200))

section('§2 every model-facing text of every tool: the name, the description, the prompt, the schema, the search hint')
const offenders: string[] = []
for (const tool of tools) {
  const bytes = [await render(tool), (tool as { searchHint?: string }).searchHint ?? ''].join('\n')
  for (const [label, re] of MODEL_FACING) {
    const hit = re.exec(bytes)
    if (hit !== null) offenders.push(`${tool.name}: ${label} — ${JSON.stringify(bytes.slice(Math.max(0, hit.index - 40), hit.index + 60))}`)
  }
}
check(`no tool's model-facing text names the old tool, the old verb, the old field or the old gloss (${tools.length} tools)`, offenders.length === 0, offenders.join(' | '))
const { TOOL_CAPABILITY_DECLARATIONS } = await import('../../src/utils/capability/declarations.ts')
const declared = TOOL_CAPABILITY_DECLARATIONS as Record<string, { intents?: string[] }>
check(`the capability declarations are keyed by ${TOOL} and ${RESUME}, and their intents say crewmate without the old gloss`, declared[TOOL] !== undefined && declared[RESUME] !== undefined && declared[OLD_TOOL] === undefined && declared[OLD_RESUME] === undefined && !MODEL_FACING.some(([, re]) => re.test(JSON.stringify(declared[TOOL]))), JSON.stringify(declared[TOOL]))

section('§3 the tree: no tracked file spells the old tool name, verb or field outside the pins')
const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
const scoped = files.filter(f => /^(src|scripts|docs|design-system|assets|integrations|sdk)\//.test(f) || ['README.md', 'AGENTS.md', 'MERCURY.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md'].includes(f))
const textual = (f: string): boolean => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonl|md|txt|tsv|csv|sh|bash|py|yml|yaml|toml|sed|html|css|svg|xml|plist|ps1|cfg|ini)$/.test(f)
const code = (f: string): boolean => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(f)
const hashed = (f: string): boolean => /\.(sh|bash|py|yml|yaml|toml|sed|ps1)$/.test(f)
const commentLine = (f: string, line: string): boolean => (code(f) && /^\s*(\/\/|\*|\/\*)/.test(line)) || (hashed(f) && /^\s*#/.test(line))

type Hit = { file: string; line: number; word: string; text: string }
const hits: Hit[] = []
const pinned = new Map<string, number>()
const notTheTool = new Map<string, number>()
let scanned = 0
for (const rel of scoped) {
  if (!textual(rel)) continue
  if (EXCLUDED_AREAS.some(([p]) => rel === p || rel.startsWith(p))) continue
  const text = readFileSync(join(ROOT, rel), 'utf8')
  scanned++
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (commentLine(rel, line)) continue
    for (const [word, re] of WORDS) {
      if (!re.test(line)) continue
      const pin = PINS.find(([p]) => p === rel)
      if (pin !== undefined) {
        pinned.set(rel, (pinned.get(rel) ?? 0) + 1)
        continue
      }
      const label = NOT_THE_TOOL.find(([p, needle]) => p === rel && line.includes(needle))
      if (label !== undefined) {
        notTheTool.set(`${rel}: ${label[1]}`, (notTheTool.get(`${rel}: ${label[1]}`) ?? 0) + 1)
        continue
      }
      hits.push({ file: rel, line: i + 1, word, text: line.trim().slice(0, 140) })
    }
  }
}
check(`no tracked file outside the pins spells the old tool name, verb or field (${scanned} files scanned, ${hits.length} hits)`, hits.length === 0)
if (hits.length > 0 || REPORT) for (const h of hits.slice(0, 80)) console.log(`    ${h.file}:${h.line} [${h.word}] ${h.text}`)
const unusedPins = PINS.filter(([p]) => files.includes(p) && !pinned.has(p) && p !== 'scripts/identity/prove-crewmate-tool-name.ts')
const unusedLabels = NOT_THE_TOOL.filter(([p, needle]) => !notTheTool.has(`${p}: ${needle}`))
check('every pin that is allowed to spell the old name still does (an unused allowance is listed, never kept silently)', unusedPins.length === 0 && unusedLabels.length === 0, [...unusedPins.map(([p]) => p), ...unusedLabels.map(([p, needle]) => `${p}: ${needle}`)].join(', '))
if (REPORT) {
  console.log('\n  excluded areas:')
  for (const [p, why] of EXCLUDED_AREAS) console.log(`    ${p} — ${why}`)
  console.log('  pins:')
  for (const [p, why] of PINS) console.log(`    ${p} (${pinned.get(p) ?? 0} lines) — ${why}`)
  console.log('  the same word, not the tool:')
  for (const [p, needle, why] of NOT_THE_TOOL) console.log(`    ${p}: ${needle} (${notTheTool.get(`${p}: ${needle}`) ?? 0} lines) — ${why}`)
}

console.log(`\ncrewmate-tool-name: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
