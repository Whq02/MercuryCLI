/**
 * the Studio data layer (pure projections).
 *
 * Rows: winners first, shadowed flagged, invalid files never vanish; scope
 * tabs and status filters compose; fuzzy search ranks across name +
 * description + source + model.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'foundry-studio-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'

await import('../../src/tools/AgentTool/AgentTool.js')
const { buildStudioRows } = await import(
  '../../src/components/agents/studio/studioData.js'
)
const { clearAgentDefinitionsCache, getAgentDefinitionsWithOverrides } =
  await import('../../src/tools/AgentTool/loadAgentsDir.js')

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// The shadow pair rides scope precedence: the project's `.mercury` copy of
// studio-alpha wins over the user-scope copy under the config home.
const project = join(scratch, 'project')
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(join(project, '.mercury', 'agents'), { recursive: true })
mkdirSync(join(home, 'agents'), { recursive: true })
const agentMd = (name: string, description: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: "${description}"\n${extra}\n---\n\nBody of ${name}.\n`
writeFileSync(join(project, '.mercury', 'agents', 'alpha.md'), agentMd('studio-alpha', 'reviews security issues', 'model: opus'))
writeFileSync(join(home, 'agents', 'alpha.md'), agentMd('studio-alpha', 'user-scope copy'))
writeFileSync(join(project, '.mercury', 'agents', 'beta.md'), agentMd('studio-beta', 'writes documentation pages'))
writeFileSync(join(project, '.mercury', 'agents', 'broken.md'), '---\nname: studio-broken\n---\n\nNo description.\n')

clearAgentDefinitionsCache()
const result = await getAgentDefinitionsWithOverrides(project)

{
  console.log('SD1: baseline rows')
  const { rows, counts } = buildStudioRows(result, { tab: 'all', filter: 'all', query: '' })
  const alphaRows = rows.filter(r => r.agent?.agentType === 'studio-alpha')
  check('both alpha candidates present', alphaRows.length === 2, String(alphaRows.length))
  check('winner not flagged shadowed', alphaRows.some(r => r.shadowed !== true))
  check('loser flagged shadowed', alphaRows.some(r => r.shadowed === true))
  check('the project copy is the winner', alphaRows.some(r => r.shadowed !== true && r.agent?.source === 'projectSettings'))
  check('invalid row present', rows.some(r => r.kind === 'invalid'))
  check('winners sort before shadowed/invalid',
    rows.findIndex(r => r.shadowed === true) > rows.findIndex(r => r.agent?.agentType === 'studio-alpha' && !r.shadowed))
  check('issue count = shadowed + invalid', counts.issues >= 2, String(counts.issues))
}

{
  console.log('SD2: filters')
  const issues = buildStudioRows(result, { tab: 'all', filter: 'issues', query: '' })
  check('issues filter keeps only shadowed+invalid',
    issues.rows.every(r => r.kind === 'invalid' || r.shadowed === true) && issues.rows.length >= 2)
  const builtins = buildStudioRows(result, { tab: 'built-in', filter: 'all', query: '' })
  check('scope tab narrows', builtins.rows.every(r => r.agent?.source === 'built-in'))
  const projectTab = buildStudioRows(result, { tab: 'project', filter: 'all', query: '' })
  check('project tab keeps the project rows and the invalid file',
    projectTab.rows.some(r => r.agent?.agentType === 'studio-beta') && projectTab.rows.some(r => r.kind === 'invalid'))
}

{
  console.log('SD3: fuzzy search')
  const byName = buildStudioRows(result, { tab: 'all', filter: 'all', query: 'alpha' })
  check('name query hits', byName.rows.some(r => r.agent?.agentType === 'studio-alpha'))
  const byDescription = buildStudioRows(result, { tab: 'all', filter: 'all', query: 'documentation' })
  check('description query hits', byDescription.rows[0]?.agent?.agentType === 'studio-beta',
    byDescription.rows[0]?.agent?.agentType)
  const nothing = buildStudioRows(result, { tab: 'all', filter: 'all', query: 'zzzzqqqq' })
  check('no-match query yields empty', nothing.rows.length === 0)
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} studio-data check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll studio-data checks pass.')
