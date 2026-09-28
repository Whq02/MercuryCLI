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
const COLD_CEILING: Record<number, number> = { 10: 3000, 100: 5000, 1000: 20000, 5000: 60000 }
const WARM_CEILING = 50
const FILTER_CEILING: Record<number, number> = { 10: 50, 100: 100, 1000: 600, 5000: 2500 }
const SAMPLES = 3
function bestOf<T>(run: () => T): { value: T; bestMs: number; samplesMs: string } {
  const samples: number[] = []
  let value!: T
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now()
    value = run()
    samples.push(performance.now() - t)
  }
  return { value, bestMs: Math.min(...samples), samplesMs: samples.map(ms => ms.toFixed(1)).join('/') }
}
const COLD_ROAD_NOTE = 'the first sample pays the road\'s one-time settings and catalogue read plus JIT, which a two-core runner prices above the ceiling and which is not the estate\'s cost; the floor is the algorithm'

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

  const filter = bestOf(() => buildStudioRows(result, { tab: 'all', filter: 'all', query: 'security review' }))
  check(
    `${n}: fuzzy filter interactive (best ${filter.bestMs.toFixed(1)}ms of ${filter.samplesMs}ms — one sample on a shared runner carries the box's stalls; the floor is the algorithm)`,
    filter.bestMs < FILTER_CEILING[n]! && filter.value.rows.length > 0,
    `${filter.samplesMs}ms`,
  )

  const one = result.activeAgents.find(a => a.agentType === 'scale-agent-1')!
  const resolved = bestOf(() => {
    const estate = resolveAgentEstate(result)
    resolveEffectiveAgentRuntime(one, { parentModel: 'claude-opus-4-8', sessionEffort: undefined })
    return estate
  })
  check(
    `${n}: estate + effective resolution (best ${resolved.bestMs.toFixed(1)}ms of ${resolved.samplesMs}ms — ${COLD_ROAD_NOTE})`,
    resolved.value.size >= n && resolved.bestMs < FILTER_CEILING[n]!,
    `${resolved.samplesMs}ms`,
  )
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} scale check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll scale checks pass.')
