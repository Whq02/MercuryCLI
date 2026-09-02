/**
 * §19 regression — the built artifact carries the Agent Studio and
 * none of the stale specimen product; the estate keeps zero literal
 * `.claude` agent-path joins outside the projectConfig owner.
 *
 * dist greps ride `includes` on the raw bundle (host-harness law: rg -F
 * semantics, no regex surprises).
 */
import { readFileSync } from 'node:fs'

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dist = readFileSync('dist/mercury.mjs', 'utf-8')

check('built artifact carries the Agent Studio', dist.includes('agent studio'))
check(
  'stale specimen copy is gone from the build',
  !dist.includes('no in-terminal form input in the repo today') &&
    !dist.includes('create agents as .md files under .claude/agents today'),
)
check(
  'the old truncating serializer is gone',
  !dist.includes('Cannot get directory path for'),
)
check('the transactional store is in', dist.includes('agent-trash'))

// Source law: no literal '.claude' agent-dir join outside the projectConfig
// owner + the sanctioned compat contracts (managed path, markdownConfigLoader
// constants ride the seam).
const agentSources = [
  'src/components/agents/studio/AgentStudio.tsx',
  'src/components/agents/studio/StudioEditor.tsx',
  'src/components/agents/studio/studioData.ts',
  'src/services/agents/store.ts',
  'src/services/agents/watch.ts',
  'src/services/agents/overrides.ts',
  'src/services/agents/resolver.ts',
  'src/tools/AgentTool/loadAgentsDir.ts',
]
for (const p of agentSources) {
  const src = readFileSync(p, 'utf-8')
  const violations = src
    .split('\n')
    .map((l, i) => ({ l, i }))
    .filter(
      ({ l }) =>
        /['"`]\.claude['"`]/.test(l) &&
        !l.includes('COMPAT_PROJECT_DIR') &&
        !l.trim().startsWith('//') &&
        !l.trim().startsWith('*') &&
        !l.trim().startsWith('/*'),
    )
  check(
    `${p}: no literal '.claude' join`,
    violations.length === 0,
    violations.map(v => `line ${v.i + 1}`).join(', '),
  )
}

// studioData's compat DETECTION reads baseDir shapes — it may test for the
// substring but never JOIN a path with it. (The regex above already allows
// the detection form since it matches quoted bare '.claude' only.)

if (failures > 0) {
  console.error(`\n${failures} regression check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll regression checks pass.')
