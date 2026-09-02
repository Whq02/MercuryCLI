/**
 * discovery, precedence, and exact identity.
 *
 * Asserts the documented law:
 *   D2  the directory closest to cwd beats an ancestor directory.
 *   D3  every file-backed agent carries its EXACT discovered identity
 *       (filePath + revision digest of the discovered bytes).
 *   D4  invalid agent files stay visible (failedFiles), never vanish.
 *   D5  cross-scope precedence is unchanged: project beats user.
 *   D6  filename ≠ declared name: identity comes from `name:`, the exact
 *       file path is still recorded.
 *
 * The guarded classes:
 * a getActiveAgentsFromList that is last-write-wins over a most-specific-first
 * list (the least-specific dir wins), and a missing filePath/revision record.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'foundry-discovery-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
// Source-run provers have no dist-sibling vendored rg — the loader falls
// back to its native walker.

// Import AFTER the env pin (modules memoize over env).
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

// Project fixture: a git root with a nested working directory.
const project = join(scratch, 'project')
const sub = join(project, 'packages', 'app')
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(sub, { recursive: true })
mkdirSync(join(sub, '.mercury', 'agents'), { recursive: true })

// D2: same name at the git root and in the nested cwd.
mkdirSync(join(project, '.mercury', 'agents'), { recursive: true })
writeFileSync(join(project, '.mercury', 'agents', 'nest.md'), agentFile('foundry-nest', 'root-copy'))
writeFileSync(join(sub, '.mercury', 'agents', 'nest.md'), agentFile('foundry-nest', 'near-copy'))

// D3: a plain project agent whose identity is the discovered file.
writeFileSync(join(sub, '.mercury', 'agents', 'dup.md'), agentFile('foundry-dup', 'mercury-copy'))

// D4: invalid file (name present, description missing).
writeFileSync(
  join(sub, '.mercury', 'agents', 'broken.md'),
  '---\nname: foundry-broken\n---\n\nNo description.\n',
)

// D5: user-scope agent shadowed by a project agent of the same name.
mkdirSync(join(home, 'agents'), { recursive: true })
writeFileSync(join(home, 'agents', 'crossscope.md'), agentFile('foundry-cross', 'user-copy'))
writeFileSync(
  join(sub, '.mercury', 'agents', 'crossscope.md'),
  agentFile('foundry-cross', 'project-copy'),
)

// D6: filename differs from the declared name.
writeFileSync(
  join(sub, '.mercury', 'agents', 'oddly-named-file.md'),
  agentFile('foundry-declared', 'declared-copy'),
)

// D8 (C15, order-is-a-fingerprint): two files in ONE dir declare one name.
// The discovery listing is sorted (rg's parallel walk and the native readdir
// are both filesystem-ordered), so the winner is the lexicographically
// first file BY CONSTRUCTION — before the sort, whichever file the
// filesystem listed first won, differently across boots and platforms.
writeFileSync(join(sub, '.mercury', 'agents', 'zz-twin.md'), agentFile('foundry-twin', 'zz-copy'))
writeFileSync(join(sub, '.mercury', 'agents', 'aa-twin.md'), agentFile('foundry-twin', 'aa-copy'))

// The loader gates every scope on the enabled setting sources — armed here
// exactly as the product arms them at boot (an unarmed read finds no scope).
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
  // The inventory printer names the same-source winner BY FILE — 'shadowed
  // by project' (its own source) named nothing (C15).
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
  // The round-trip law's named boundary: a worktree-isolated session reads
  // its carved checkout for project-scope agents; user scope reaches every
  // ground. Two sibling checkouts, one agent each, one shared user agent.
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
