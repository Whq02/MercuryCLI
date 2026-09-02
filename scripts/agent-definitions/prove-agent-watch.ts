/**
 * live reload + revision semantics.
 *
 * W1 add/W2 change/W3 remove in a watched root notify (coalesced).
 * W4 a scope's FIRST agents directory (created after the watch started)
 *    becomes watched without restart.
 * W5 self-writes (store commits announced via noteSelfWrite) do not
 *    re-notify.
 * W6 in-flight pinning: the definition object captured before an edit keeps
 *    its revision while a fresh load sees the new one.
 *
 * Observed-ready: every wait polls for the observed outcome under a hard
 * deadline (never a bare sleep-and-hope).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'foundry-watch-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

const {
  noteSelfWrite,
  setAgentWatchTimingForTests,
  startAgentWatch,
  stopAgentWatch,
  subscribeAgentsChanged,
} = await import('../../src/services/agents/watch.js')
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

setAgentWatchTimingForTests({
  stabilityThreshold: 80,
  pollInterval: 20,
  reloadDebounce: 60,
  chokidarInterval: 60,
  selfWriteWindowMs: 2500,
  rootProbeIntervalMs: 120,
})

const project = join(scratch, 'project')
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(join(project, '.mercury', 'agents'), { recursive: true })

let notifications = 0
const unsubscribe = subscribeAgentsChanged(() => {
  notifications++
})

const agentFile = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: "${description}"\n---\n\nYou are ${name}.\n`

async function waitFor(
  what: string,
  cond: () => boolean,
  deadlineMs = 8000,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if (cond()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  console.error(`  (deadline waiting for: ${what})`)
  return cond()
}

await startAgentWatch(project)
// Give the poller one interval to arm before mutating.
await new Promise(resolve => setTimeout(resolve, 200))

{
  console.log('W1: foreign add notifies')
  const before = notifications
  writeFileSync(
    join(project, '.mercury', 'agents', 'w1.md'),
    agentFile('foundry-w1', 'v1'),
  )
  check('notification fired', await waitFor('w1 add', () => notifications > before))
  const result = await getAgentDefinitionsWithOverrides(project)
  check(
    'fresh load sees the agent',
    result.activeAgents.some(a => a.agentType === 'foundry-w1'),
  )
}

{
  console.log('W2: foreign change notifies + revision moves')
  const beforeLoad = await getAgentDefinitionsWithOverrides(project)
  const beforeAgent = beforeLoad.activeAgents.find(
    a => a.agentType === 'foundry-w1',
  ) as { revision?: string } | undefined
  const before = notifications
  writeFileSync(
    join(project, '.mercury', 'agents', 'w1.md'),
    agentFile('foundry-w1', 'v2-changed'),
  )
  check('notification fired', await waitFor('w1 change', () => notifications > before))
  const afterLoad = await getAgentDefinitionsWithOverrides(project)
  const afterAgent = afterLoad.activeAgents.find(
    a => a.agentType === 'foundry-w1',
  ) as { revision?: string; whenToUse?: string } | undefined
  check('fresh load sees new content', afterAgent?.whenToUse === 'v2-changed')
  check(
    'revision moved',
    beforeAgent?.revision !== undefined &&
      afterAgent?.revision !== undefined &&
      beforeAgent.revision !== afterAgent.revision,
  )
  // W6 riding the same data: the object captured BEFORE the edit is pinned.
  console.log('W6: in-flight object pinned to its start revision')
  check(
    'captured object untouched',
    (beforeAgent as { whenToUse?: string } | undefined)?.whenToUse === 'v1',
  )
}

{
  // Honesty relabel (AGENTVERIFY A6): this block re-mkdirs a directory that
  // EXISTED at startAgentWatch (created above before the arm) — it drives a
  // plain add in an already-armed native root, NOT the first-root probe.
  // The real absent-at-arm probe road is W7 below.
  console.log('W4: an add in the (already-armed) native root notifies')
  const before = notifications
  mkdirSync(join(project, '.mercury', 'agents'), { recursive: true })
  writeFileSync(
    join(project, '.mercury', 'agents', 'w4.md'),
    agentFile('foundry-w4', 'native-first'),
  )
  check(
    'creation inside the new root notifies',
    await waitFor('w4 first-native-dir', () => notifications > before, 12000),
  )
  const result = await getAgentDefinitionsWithOverrides(project)
  check(
    'fresh load sees the native agent',
    result.activeAgents.some(a => a.agentType === 'foundry-w4'),
  )
}

{
  console.log('W3: foreign remove notifies')
  const before = notifications
  rmSync(join(project, '.mercury', 'agents', 'w1.md'))
  check('notification fired', await waitFor('w1 unlink', () => notifications > before))
  const result = await getAgentDefinitionsWithOverrides(project)
  check(
    'fresh load no longer lists it',
    !result.activeAgents.some(a => a.agentType === 'foundry-w1'),
  )
}

{
  console.log('W5: self-writes do not re-notify')
  const path = join(project, '.mercury', 'agents', 'w5.md')
  const before = notifications
  noteSelfWrite(path)
  writeFileSync(path, agentFile('foundry-w5', 'self'))
  // Wait long enough that a notification WOULD have fired (W1 latency ×3).
  await new Promise(resolve => setTimeout(resolve, 900))
  check('no notification for the self-write', notifications === before, String(notifications - before))
  // …but the caches were still invalidated: a fresh read sees it.
  const result = await getAgentDefinitionsWithOverrides(project)
  check(
    'cache still invalidated (fresh read sees it)',
    result.activeAgents.some(a => a.agentType === 'foundry-w5'),
  )
}

{
  console.log('W7: the REAL first-root probe — the scope\'s agents dir is ABSENT at arm time (AGENTVERIFY A6)')
  // The operator's first boot-menu create in a fresh project rides exactly
  // this road: the watch armed over a would-be root, the directory born
  // later, the file inside it reaching every subscriber without a restart.
  const project2 = join(scratch, 'project2')
  mkdirSync(join(project2, '.git'), { recursive: true })
  await startAgentWatch(project2) // cwd change restarts the singleton
  await new Promise(resolve => setTimeout(resolve, 250))
  const before = notifications
  mkdirSync(join(project2, '.mercury', 'agents'), { recursive: true })
  writeFileSync(join(project2, '.mercury', 'agents', 'born.md'), agentFile('foundry-born', 'first-ever'))
  check(
    'the first-ever agents dir + file notifies without a restart',
    await waitFor('first-root probe', () => notifications > before, 12000),
  )
  const result = await getAgentDefinitionsWithOverrides(project2)
  check(
    'fresh load sees the born agent',
    result.activeAgents.some(a => a.agentType === 'foundry-born'),
  )
}

{
  console.log('W8: atomic rename-replace (the plain-editor save shape) notifies')
  const project2 = join(scratch, 'project2')
  const before = notifications
  const tmp = join(project2, '.mercury', 'agents', '.born.md.tmp')
  writeFileSync(tmp, agentFile('foundry-born', 'v2-atomic'))
  const { renameSync } = await import('node:fs')
  renameSync(tmp, join(project2, '.mercury', 'agents', 'born.md'))
  check('the replace notifies', await waitFor('atomic replace', () => notifications > before))
}

{
  console.log('W9: a burst COALESCES (five files, one reload signal — the coalescing law)')
  const project2 = join(scratch, 'project2')
  await new Promise(resolve => setTimeout(resolve, 300))
  const before = notifications
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(project2, '.mercury', 'agents', `burst-${i}.md`), agentFile(`foundry-burst-${i}`, 'burst'))
  }
  await waitFor('burst signal', () => notifications > before)
  await new Promise(resolve => setTimeout(resolve, 500))
  // ≤2 tolerates one polling straggler past the debounce window; the law's
  // teeth are "nowhere near five".
  check('five writes coalesce', notifications - before <= 2, `delta=${notifications - before}`)
}

{
  console.log('W10: self-write suppression folds SPELLINGS (relative + symlink-divergent — the A6 ring fix)')
  const project2 = join(scratch, 'project2')
  await new Promise(resolve => setTimeout(resolve, 300))
  // Relative spelling: noted from the project cwd, evented absolute.
  let before = notifications
  const prevCwd = process.cwd()
  process.chdir(project2)
  noteSelfWrite(join('.mercury', 'agents', 'self-rel.md'))
  process.chdir(prevCwd)
  writeFileSync(join(project2, '.mercury', 'agents', 'self-rel.md'), agentFile('foundry-self-rel', 'self'))
  await new Promise(resolve => setTimeout(resolve, 900))
  check('a relative-spelled note suppresses its echo', notifications === before, `delta=${notifications - before}`)
  // Symlink-divergent spelling (macOS /var vs /private/var): note the
  // realpathed spelling while the event wears the watch root's own.
  before = notifications
  const { realpathSync } = await import('node:fs')
  const realSpelled = join(realpathSync(join(project2, '.mercury', 'agents')), 'self-real.md')
  noteSelfWrite(realSpelled)
  writeFileSync(join(project2, '.mercury', 'agents', 'self-real.md'), agentFile('foundry-self-real', 'self'))
  await new Promise(resolve => setTimeout(resolve, 900))
  check('a realpath-spelled note suppresses the symlink-spelled echo', notifications === before, `delta=${notifications - before}`)
}

unsubscribe()
await stopAgentWatch()
setAgentWatchTimingForTests(null)
clearAgentDefinitionsCache()
rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} watch check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll watch checks pass.')
