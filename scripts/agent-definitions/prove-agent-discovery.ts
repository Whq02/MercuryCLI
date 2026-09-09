import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'foundry-discovery-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

const { getAgentDefinitionsWithOverrides, clearAgentDefinitionsCache } =
  await import('../../src/tools/AgentTool/loadAgentsDir.js')
const { revisionDigest } = await import('../../src/services/agents/contracts.js')
const { readFileSync } = await import('node:fs')

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function agentFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\nYou are ${name} (${description}).\n`
}

const project = join(scratch, 'project')
const sub = join(project, 'packages', 'app')
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(sub, { recursive: true })
mkdirSync(join(sub, '.mercury', 'agents'), { recursive: true })

mkdirSync(join(project, '.mercury', 'agents'), { recursive: true })
writeFileSync(join(project, '.mercury', 'agents', 'nest.md'), agentFile('foundry-nest', 'root-copy'))
writeFileSync(join(sub, '.mercury', 'agents', 'nest.md'), agentFile('foundry-nest', 'near-copy'))

writeFileSync(join(sub, '.mercury', 'agents', 'dup.md'), agentFile('foundry-dup', 'mercury-copy'))

writeFileSync(
  join(sub, '.mercury', 'agents', 'broken.md'),
  '---\nname: foundry-broken\n---\n\nNo description.\n',
)

mkdirSync(join(home, 'agents'), { recursive: true })
writeFileSync(join(home, 'agents', 'crossscope.md'), agentFile('foundry-cross', 'user-copy'))
writeFileSync(
  join(sub, '.mercury', 'agents', 'crossscope.md'),
  agentFile('foundry-cross', 'project-copy'),
)

writeFileSync(
  join(sub, '.mercury', 'agents', 'oddly-named-file.md'),
  agentFile('foundry-declared', 'declared-copy'),
)

writeFileSync(join(sub, '.mercury', 'agents', 'zz-twin.md'), agentFile('foundry-twin', 'zz-copy'))
writeFileSync(join(sub, '.mercury', 'agents', 'aa-twin.md'), agentFile('foundry-twin', 'aa-copy'))

writeFileSync(
  join(sub, '.mercury', 'agents', 'ruled.md'),
  '---\nname: foundry-ruled\ndescription: "carries the rule"\nstandingRule: "Verify before you claim."\n---\n\nYou verify.\n',
)
writeFileSync(
  join(sub, '.mercury', 'agents', 'ruled-old.md'),
  '---\nname: foundry-ruled-old\ndescription: "carries the old spelling"\ncriticalSystemReminder_EXPERIMENTAL: "Verify before you claim."\n---\n\nYou verify.\n',
)
writeFileSync(
  join(sub, '.mercury', 'agents', 'ruled-both.md'),
  '---\nname: foundry-ruled-both\ndescription: "carries both"\nstandingRule: "The current word."\ncriticalSystemReminder_EXPERIMENTAL: "The old word."\n---\n\nYou verify.\n',
)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
clearAgentDefinitionsCache()
const result = await getAgentDefinitionsWithOverrides(sub)
const active = new Map(result.activeAgents.map(a => [a.agentType, a]))

console.log('D2: nearest-directory precedence')
{
  const winner = active.get('foundry-nest')
  check(
    'cwd-adjacent copy wins over the ancestor',
    winner?.whenToUse === 'near-copy',
    `winner description: ${winner?.whenToUse}`,
  )
  const both = result.allAgents.filter(a => a.agentType === 'foundry-nest')
  check('both candidates retained in allAgents', both.length === 2, String(both.length))
}

console.log('D3: exact discovered identity')
{
  const winner = active.get('foundry-dup')
  const expectPath = join(sub, '.mercury', 'agents', 'dup.md')
  const filePath = (winner as { filePath?: string } | undefined)?.filePath
  const revision = (winner as { revision?: string } | undefined)?.revision
  check('filePath is the discovered path', filePath === expectPath, String(filePath))
  const bytes = filePath ? readFileSync(filePath, 'utf-8') : ''
  check(
    'revision digests the discovered bytes',
    revision !== undefined && revision === revisionDigest(bytes),
    String(revision),
  )
}

console.log('D4: invalid files stay visible')
{
  const brokenPath = join(sub, '.mercury', 'agents', 'broken.md')
  check(
    'failedFiles carries the broken file',
    (result.failedFiles ?? []).some(f => f.path === brokenPath),
    JSON.stringify(result.failedFiles),
  )
}

console.log('D8: a same-dir twin resolves deterministically (the sorted walk)')
{
  const winner = active.get('foundry-twin')
  const filePath = (winner as { filePath?: string } | undefined)?.filePath
  check(
    'the lexicographically first file wins by construction (aa-twin.md, never filesystem order)',
    filePath === join(sub, '.mercury', 'agents', 'aa-twin.md'),
    String(filePath),
  )
  check(
    'both twins stay visible in allAgents',
    result.allAgents.filter(a => a.agentType === 'foundry-twin').length === 2,
  )
  const printer = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'handlers', 'agents.ts'), 'utf-8')
  check(
    "the `mercury agents` shadow line names the same-source winner's file",
    printer.includes("winner.source === agent.source") && printer.includes('filePath'),
  )
}

console.log('D5: cross-scope precedence unchanged (project > user)')
{
  const winner = active.get('foundry-cross')
  check(
    'project copy wins',
    winner?.whenToUse === 'project-copy',
    `winner description: ${winner?.whenToUse}`,
  )
}

console.log('D9: the standing rule loads under its name and under the retired spelling')
{
  const rule = (name: string): string | undefined => (active.get(name) as { standingRule?: string } | undefined)?.standingRule
  check('standingRule is read from the agent file', rule('foundry-ruled') === 'Verify before you claim.', String(rule('foundry-ruled')))
  check('a file still spelling criticalSystemReminder_EXPERIMENTAL is read as standingRule this release', rule('foundry-ruled-old') === 'Verify before you claim.', String(rule('foundry-ruled-old')))
  check('when both keys are present the current spelling wins', rule('foundry-ruled-both') === 'The current word.', String(rule('foundry-ruled-both')))
  const loaded = active.get('foundry-ruled-old') as Record<string, unknown> | undefined
  check('the definition carries no retired key of its own', loaded !== undefined && !('criticalSystemReminder_EXPERIMENTAL' in loaded))
  const { parseAgentsFromJson } = await import('../../src/tools/AgentTool/loadAgentsDir.js')
  const viaJson = parseAgentsFromJson({
    'json-new': { description: 'd', prompt: 'p', standingRule: 'new key' },
    'json-old': { description: 'd', prompt: 'p', criticalSystemReminder_EXPERIMENTAL: 'old key' },
  })
  const jsonRule = (name: string): string | undefined => (viaJson.find(a => a.agentType === name) as { standingRule?: string } | undefined)?.standingRule
  check('the SDK/CLI JSON route reads standingRule', jsonRule('json-new') === 'new key', String(jsonRule('json-new')))
  check('the SDK/CLI JSON route still accepts the retired spelling', jsonRule('json-old') === 'old key', String(jsonRule('json-old')))
}

console.log('D6: filename vs declared name')
{
  const agent = active.get('foundry-declared')
  check('declared name is the identity', agent !== undefined)
  check(
    'filename recorded separately',
    (agent as { filename?: string } | undefined)?.filename === 'oddly-named-file',
    String((agent as { filename?: string } | undefined)?.filename),
  )
  check(
    'exact path recorded',
    (agent as { filePath?: string } | undefined)?.filePath ===
      join(sub, '.mercury', 'agents', 'oddly-named-file.md'),
  )
}

{
  console.log('D7: worktree isolation — each carved checkout reads its OWN project scope (AGENTVERIFY A5)')
  const isoHome = join(scratch, 'iso-home')
  mkdirSync(join(isoHome, 'agents'), { recursive: true })
  const priorHome = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = isoHome
  try {
    writeFileSync(join(isoHome, 'agents', 'shared.md'), agentFile('iso-user-shared', 'shared'))
    const mainRepo = join(scratch, 'iso-main')
    const carved = join(scratch, 'iso-worktree-a')
    for (const [root, agent] of [[mainRepo, 'iso-main-only'], [carved, 'iso-carved-only']] as const) {
      mkdirSync(join(root, '.git'), { recursive: true })
      mkdirSync(join(root, '.mercury', 'agents'), { recursive: true })
      writeFileSync(join(root, '.mercury', 'agents', `${agent}.md`), agentFile(agent, 'scoped'))
    }
    clearAgentDefinitionsCache()
    const atMain = await getAgentDefinitionsWithOverrides(mainRepo)
    clearAgentDefinitionsCache()
    const atCarved = await getAgentDefinitionsWithOverrides(carved)
    const names = (r: typeof atMain): string[] => r.activeAgents.map(a => a.agentType)
    check(
      'the main checkout sees its own project agent + user scope, never the sibling checkout',
      names(atMain).includes('iso-main-only') && names(atMain).includes('iso-user-shared') && !names(atMain).includes('iso-carved-only'),
      names(atMain).join(','),
    )
    check(
      'the carved checkout sees its own project agent + user scope, never the main checkout',
      names(atCarved).includes('iso-carved-only') && names(atCarved).includes('iso-user-shared') && !names(atCarved).includes('iso-main-only'),
      names(atCarved).join(','),
    )
  } finally {
    process.env.MERCURY_CONFIG_DIR = priorHome
    clearAgentDefinitionsCache()
  }
}

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} discovery check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll discovery checks pass.')
