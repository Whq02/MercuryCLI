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
check('the transactional store is in', dist.includes('agent-trash'))

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


if (failures > 0) {
  console.error(`\n${failures} regression check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll regression checks pass.')
