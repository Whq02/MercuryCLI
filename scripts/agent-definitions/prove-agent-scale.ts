/**
 * scale and responsiveness over deterministic libraries.
 *
 * 10 / 100 / 1000 / 5000 definitions: cold discovery, warm (memoized)
 * re-read, fuzzy filter, estate resolution + one effective projection.
 * Thresholds are ALGORITHMIC guards with cross-machine headroom (a loaded
 * CI box must pass), not vanity milliseconds; the measured numbers print
 * for the ledger.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'foundry-scale-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'

await import('../../src/tools/AgentTool/AgentTool.js')
const { buildStudioRows } = await import(
  '../../src/components/agents/studio/studioData.js'
)
const { resolveAgentEstate, resolveEffectiveAgentRuntime } = await import(
  '../../src/services/agents/resolver.js'
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

const SIZES = [10, 100, 1000, 5000]
// Generous cross-machine ceilings (ms). Cold scales with file IO; warm and
// filter must stay interactive-flat.
const COLD_CEILING: Record<number, number> = { 10: 3000, 100: 5000, 1000: 20000, 5000: 60000 }
const WARM_CEILING = 50
const FILTER_CEILING: Record<number, number> = { 10: 50, 100: 100, 1000: 600, 5000: 2500 }

for (const n of SIZES) {
  const project = join(scratch, `p${n}`)
  mkdirSync(join(project, '.git'), { recursive: true })
  const dir = join(project, '.mercury', 'agents')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(dir, `gen-${i}.md`),
      `---\nname: scale-agent-${i}\ndescription: "Use for scale case ${i} — ${i % 7 === 0 ? 'security review' : 'general work'}."\nmodel: ${i % 3 === 0 ? 'opus' : 'sonnet'}\n---\n\nYou are scale agent ${i}.\n`,
    )
  }

  clearAgentDefinitionsCache()
  const t0 = performance.now()
  const result = await getAgentDefinitionsWithOverrides(project)
  const cold = performance.now() - t0
  check(
    `${n}: cold discovery loads all (${cold.toFixed(0)}ms)`,
    result.allAgents.filter(a => a.agentType.startsWith('scale-agent-')).length === n &&
      cold < COLD_CEILING[n]!,
    `${cold.toFixed(0)}ms`,
  )

  const t1 = performance.now()
  await getAgentDefinitionsWithOverrides(project)
  const warm = performance.now() - t1
  check(`${n}: warm re-read is memoized (${warm.toFixed(2)}ms)`, warm < WARM_CEILING, `${warm.toFixed(2)}ms`)

  const t2 = performance.now()
  const filtered = buildStudioRows(result, { tab: 'all', filter: 'all', query: 'security review' })
  const filterMs = performance.now() - t2
  check(
    `${n}: fuzzy filter interactive (${filterMs.toFixed(1)}ms)`,
    filterMs < FILTER_CEILING[n]! && filtered.rows.length > 0,
    `${filterMs.toFixed(1)}ms`,
  )

  const t3 = performance.now()
  const estate = resolveAgentEstate(result)
  const one = result.activeAgents.find(a => a.agentType === 'scale-agent-1')!
  resolveEffectiveAgentRuntime(one, { parentModel: 'claude-opus-4-8', sessionEffort: undefined })
  const resolveMs = performance.now() - t3
  check(
    `${n}: estate + effective resolution (${resolveMs.toFixed(1)}ms)`,
    estate.size >= n && resolveMs < FILTER_CEILING[n]!,
    `${resolveMs.toFixed(1)}ms`,
  )
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} scale check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll scale checks pass.')
