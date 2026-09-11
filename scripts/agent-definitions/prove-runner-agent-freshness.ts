import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'runner-freshness-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

const { setAgentWatchTimingForTests } = await import('../../src/services/agents/watch.js')
const { clearAgentDefinitionsCache } = await import('../../src/tools/AgentTool/loadAgentsDir.js')
const { armRunnerAgentFreshness } = await import('../../src/cli/agentFreshness.js')
type AgentDefinition = import('../../src/tools/AgentTool/loadAgentsDir.js').AgentDefinition

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

setAgentWatchTimingForTests({
  stabilityThreshold: 80,
  pollInterval: 20,
  reloadDebounce: 60,
  chokidarInterval: 60,
  selfWriteWindowMs: 2500,
})

const project = join(scratch, 'project')
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(join(project, '.mercury', 'agents'), { recursive: true })

const agentFile = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: "${description}"\n---\n\nYou are ${name}.\n`

async function waitFor(cond: () => boolean, deadlineMs = 8000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if (cond()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return cond()
}

const flagAgent = {
  agentType: 'sdk-injected',
  whenToUse: 'Injected via --agents; never file-backed.',
  getSystemPrompt: () => 'You are the SDK-injected fixture.',
  source: 'flagSettings',
} as unknown as AgentDefinition
let activeAgents: AgentDefinition[] = [flagAgent]
const rosterNames = (): string[] => activeAgents.map(a => a.agentType)

console.log('R1: disease-then-cure')
{
  writeFileSync(
    join(project, '.mercury', 'agents', 'pre-arm-scout.md'),
    agentFile('pre-arm-scout', 'Landed before the freshness seam armed.'),
  )
  await new Promise(resolve => setTimeout(resolve, 400))
  check(
    'before the arm, the landed file changes nothing (the boot-snapshot disease)',
    !rosterNames().includes('pre-arm-scout'),
    rosterNames().join(','),
  )
}

const disarm = armRunnerAgentFreshness({
  cwd: () => project,
  getActive: () => activeAgents,
  setActive: next => {
    activeAgents = next
  },
  armDelayMs: 0,
})
await new Promise(resolve => setTimeout(resolve, 500))

{
  clearAgentDefinitionsCache()
  writeFileSync(
    join(project, '.mercury', 'agents', 'post-arm-scout.md'),
    agentFile('post-arm-scout', 'Created mid-session from the Boot face.'),
  )
  const seen = await waitFor(() => rosterNames().includes('post-arm-scout'))
  check('after the arm, a foreign write reaches the roster (the round-trip law)', seen, rosterNames().join(','))
  check('the pre-arm agent rides the same fresh read', rosterNames().includes('pre-arm-scout'), rosterNames().join(','))
}

console.log('R2: flag-settings preservation')
{
  check(
    "the 'flagSettings' agent survives the refresh (never file-backed, never re-read)",
    rosterNames().includes('sdk-injected'),
    rosterNames().join(','),
  )
}

console.log('R3: disarm')
{
  disarm()
  await new Promise(resolve => setTimeout(resolve, 300))
  const before = rosterNames()
  writeFileSync(
    join(project, '.mercury', 'agents', 'after-disarm-scout.md'),
    agentFile('after-disarm-scout', 'Landed after the seam disposed.'),
  )
  await new Promise(resolve => setTimeout(resolve, 600))
  check(
    'after disarm, a later write changes nothing (subscription dropped, watcher closed)',
    JSON.stringify(rosterNames()) === JSON.stringify(before) && !rosterNames().includes('after-disarm-scout'),
    rosterNames().join(','),
  )
}

console.log('R4: the host wiring (structural)')
{
  const printSrc = readFileSync(join(import.meta.dirname, '../../src/cli/print.ts'), 'utf-8')
  check(
    'print.ts arms the seam over the live roster binding',
    printSrc.includes('armRunnerAgentFreshness({') && printSrc.includes('setActive: next => {'),
  )
  check(
    'print.ts disarms beside the skills detector dispose (the session-end road)',
    printSrc.includes('skillChangeDetector.dispose()\n      disarmAgentFreshness()'),
  )
  const hookSrc = readFileSync(join(import.meta.dirname, '../../src/hooks/useAgentsChange.ts'), 'utf-8')
  check(
    'the cockpit reload replaces the roster with a fresh array (in-flight work keeps the objects it captured)',
    hookSrc.includes('const allAgents = [...fresh.allAgents, ...flagAgents]') &&
      hookSrc.includes('activeAgents: computeActiveAgents(allAgents)'),
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll runner-freshness checks pass.')
