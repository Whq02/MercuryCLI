#!/usr/bin/env bun
// ============================================================================
//  scripts/agents/prove-identifier-gate.ts — the ONE identifier law runs at
//  every loading door, not just the writer.
//
//  E008-39/41/55: validateAgentIdentifier existed (the writer refuses to
//  save an illegal name) but the LOADERS took names raw: `../../pwned`
//  activated as an agent (agentType is a filesystem path segment
//  downstream), a raw-ANSI name reached stdout unfiltered and a newline
//  name forged a second "Built-in agents:" section on the inventory — the
//  one audit surface; an extension skill named `../../pwned` sat on the
//  approval card's "reaches the model" roster.
//
//  §1 agents dir: hostile names are refused typed into failedFiles, never
//     activated (the memory-dir derivation is unreachable for a name that
//     never loads).
//  §2 agents dir: legal names still load (guard).
//  §3 extension agents: the same gate at the contributions door — defect
//     line, agent absent.
//  §4 extension skills: a hostile frontmatter name is a typed defect, the
//     skill absent; a legal name and the folder-name fallback still load.
//  §5 the inventory render escapes C0 and newlines — defense in depth on
//     the audit surface even for a definition constructed hostile.
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-id-gate-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const agentsMod = await import('../../src/tools/AgentTool/loadAgentsDir.ts')
const contributionsMod = await import('../../src/extensions/load/contributions.ts')
const handlerMod = await import('../../src/cli/handlers/agents.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

let projectSeq = 0
function freshProject(): string {
  const cwd = join(scratch, `proj-${projectSeq++}`)
  mkdirSync(cwd, { recursive: true })
  return cwd
}
function writeAgent(cwd: string, fileBase: string, name: string): string {
  const dir = join(cwd, '.mercury', 'agents')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${fileBase}.md`)
  writeFileSync(file, `---\nname: ${JSON.stringify(name)}\ndescription: An agent.\n---\n\nPrompt.\n`)
  return file
}
async function loadAgents(cwd: string): Promise<Awaited<ReturnType<typeof agentsMod.getAgentDefinitionsWithOverrides>>> {
  agentsMod.clearAgentDefinitionsCache()
  return agentsMod.getAgentDefinitionsWithOverrides(cwd)
}

console.log('============================================================')
console.log(' the identifier gate — one law at every loading door')
console.log('============================================================')

console.log('[1] agents dir: hostile names are refused typed, never activated')
{
  const hostile: Array<[string, string]> = [
    ['traversal', '../../pwned'],
    ['spaces', 'My Agent With Spaces'],
    ['onechar', 'q'],
    ['overlong', 'z'.repeat(81)],
    ['ansi', 'evil\x1b[31mRED'],
    ['forger', 'a\nBuilt-in agents:\n  totally-legit-builtin'],
  ]
  for (const [fileBase, name] of hostile) {
    const cwd = freshProject()
    const file = writeAgent(cwd, fileBase, name)
    const result = await loadAgents(cwd)
    const active = result.activeAgents.some(a => a.agentType === name)
    const row = (result.failedFiles ?? []).find(r => r.path === file)
    check(`${fileBase}: not activated`, !active)
    check(`${fileBase}: typed row`, row !== undefined && /identifier/i.test(row.error), row?.error ?? 'no row')
  }
}

console.log('[2] agents dir: legal names still load')
{
  const cwd = freshProject()
  writeAgent(cwd, 'valid-agent', 'valid-agent')
  writeAgent(cwd, 'a1-b2', 'a1-b2')
  const result = await loadAgents(cwd)
  check('valid-agent loads', result.activeAgents.some(a => a.agentType === 'valid-agent'))
  check('a1-b2 loads', result.activeAgents.some(a => a.agentType === 'a1-b2'))
  check('no failed rows', (result.failedFiles ?? []).length === 0, (result.failedFiles ?? []).map(r => r.error).join(' | '))
}

function resolveExt(root: string): ReturnType<typeof contributionsMod.resolveContributions> {
  return contributionsMod.resolveContributions(
    { name: 'kit', version: '1.0.0', description: 'fixture', contributes: { agents: ['./agents'], skills: ['./skills'] } } as Parameters<typeof contributionsMod.resolveContributions>[0],
    root,
    'kit@probe',
    contributionsMod.realProbes({ optionSet: () => false }),
  )
}

console.log('[3] extension agents: the same gate at the contributions door')
{
  const root = join(scratch, 'ext-agents')
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'skills', 'good-skill'), { recursive: true })
  writeFileSync(join(root, 'skills', 'good-skill', 'SKILL.md'), '---\nname: good-skill\ndescription: fine\n---\nBody.\n')
  writeFileSync(join(root, 'agents', 'trav.md'), '---\nname: "../../pwned"\ndescription: An agent.\n---\n\nPrompt.\n')
  writeFileSync(join(root, 'agents', 'good.md'), '---\nname: good-agent\ndescription: An agent.\n---\n\nPrompt.\n')
  const resolution = resolveExt(root)
  check('the hostile agent is absent', !resolution.agents.some(a => a.agentType.includes('pwned')), resolution.agents.map(a => a.agentType).join(' '))
  check('the defect names the door', resolution.defects.some(d => /agents\/trav\.md/.test(d) && /identifier/i.test(d)), resolution.defects.join(' | '))
  check('the legal agent loads namespaced', resolution.agents.some(a => a.agentType === 'kit:good-agent'))
}

console.log('[4] extension skills: a hostile frontmatter name is a typed defect')
{
  const root = join(scratch, 'ext-skills')
  const cases: Array<[string, string]> = [
    ['trav', '../../pwned'],
    ['spacey', 'a b'],
    ['dotted', '.hidden'],
    ['ansi', 'x\x1by'],
    ['sep', 'a/b'],
  ]
  for (const [dirName] of cases) mkdirSync(join(root, 'skills', dirName), { recursive: true })
  for (const [dirName, name] of cases) {
    writeFileSync(join(root, 'skills', dirName, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: fixture\n---\nBody.\n`)
  }
  mkdirSync(join(root, 'skills', 'legal'), { recursive: true })
  writeFileSync(join(root, 'skills', 'legal', 'SKILL.md'), '---\nname: legal-name\ndescription: fixture\n---\nBody.\n')
  mkdirSync(join(root, 'skills', 'fallback'), { recursive: true })
  writeFileSync(join(root, 'skills', 'fallback', 'SKILL.md'), '---\ndescription: no name key\n---\nBody.\n')
  const resolution = resolveExt(root)
  for (const [dirName, name] of cases) {
    check(`${dirName}: the skill is absent`, !resolution.skills.some(s => s.skillName === name))
    check(`${dirName}: typed defect`, resolution.defects.some(d => d.includes(`skills/${dirName}/SKILL.md`) && /legal skill name/i.test(d)), resolution.defects.filter(d => d.includes(dirName)).join(' | ') || 'no defect')
  }
  check('a legal declared name loads', resolution.skills.some(s => s.skillName === 'legal-name'))
  check('the folder-name fallback still loads', resolution.skills.some(s => s.skillName === 'fallback'))
  check('no hostile name reaches the roster shape', resolution.skills.every(s => !/[\u0000-\u001f\u007f \\/]/.test(s.name)), resolution.skills.map(s => s.name).join(' '))
}

console.log('[5] the inventory render escapes C0 and newlines')
{
  const render = (handlerMod as { renderAgentLine?: (entry: { definition: { agentType: string }; shadowedBy: string | undefined }) => string }).renderAgentLine
  check('renderAgentLine is exported for this pin', typeof render === 'function')
  if (typeof render === 'function') {
    const line = render({ definition: { agentType: 'evil\x1b[31mRED\nBuilt-in agents:\n  fake' }, shadowedBy: undefined })
    check('no raw ESC byte in the rendered line', !line.includes('\x1b'), JSON.stringify(line))
    check('no raw newline in the rendered line', !line.includes('\n'), JSON.stringify(line))
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ IDENTIFIER GATE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
