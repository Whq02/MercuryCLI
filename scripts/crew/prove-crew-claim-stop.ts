#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plugin } from 'bun'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'crew-claim-stop-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const key of ['MERCURY_CREW', 'MERCURY_CREW_AGENT', 'MERCURY_CREW_DIR', 'MERCURY_CREWS_DIR', 'MERCURY_TASK_LIST_ID']) delete process.env[key]

const ROOT = join(import.meta.dir, '..', '..')
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)

let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Crew file claims — a second crewmate is stopped and told who holds it')
console.log(` home ${HOME}`)
console.log('============================================================')

const { getProjectRoot } = await import('../../src/bootstrap/state.js')
const leaseGlob = (await import('../../src/utils/swarm/leaseGlob.js')) as typeof import('../../src/utils/swarm/leaseGlob.js')
const crewmate = (await import('../../src/utils/crewmate.js')) as typeof import('../../src/utils/crewmate.js')
const agentContext = (await import('../../src/utils/agentContext.js')) as typeof import('../../src/utils/agentContext.js')
const guard = (await import('../../src/utils/swarm/leaseGuard.js')) as typeof import('../../src/utils/swarm/leaseGuard.js')
const events = (await import('../../src/utils/hooks/events.js')) as typeof import('../../src/utils/hooks/events.js')
const { CREW_LEAD_NAME } = await import('../../src/utils/swarm/constants.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')

check('the project root is the scratch project (the claim namespace is anchored there)', getProjectRoot() === PROJECT, `${getProjectRoot()} vs ${PROJECT}`)
const scratchDir = join(PROJECT, 'src')
mkdirSync(scratchDir, { recursive: true })
const CLAIMED_REL = 'src/x.ts'
const CLAIMED_ABS = join(PROJECT, CLAIMED_REL)
writeFileSync(CLAIMED_ABS, 'const word = "alpha"\n')
const ORIGINAL = readFileSync(CLAIMED_ABS, 'utf8')
const WORDS = `${CLAIMED_REL} is claimed by alpha; ask alpha or wait for the release.`

const ctxOf = (name: string) =>
  crewmate.createCrewmateContext({
    agentId: `${name}@crew`,
    agentName: name,
    crewName: 'crew',
    parentSessionId: 'parent',
    abortController: new AbortController(),
  })
const alpha = ctxOf('alpha')
const beta = ctxOf('beta')
const as = <T,>(ctx: ReturnType<typeof ctxOf>, fn: () => T): T => crewmate.runWithCrewmateContext(ctx, fn)
const editInput = { file_path: CLAIMED_ABS, old_string: 'alpha', new_string: 'beta' }

const fakeToolUseContext = {
  getAppState: () => getDefaultAppState(),
  messages: [],
  options: { tools: [], mainLoopModel: 'proof', mcpClients: [] },
} as unknown as import('../../src/Tool.js').ToolUseContext

async function preToolDecision(ctx: ReturnType<typeof ctxOf> | null, toolName: string, input: Record<string, unknown>): Promise<{ behavior?: string; reason?: string; source?: string } | null> {
  const run = async () => {
    for await (const result of events.executePreToolHooks(toolName, 'toolu_proof', input, fakeToolUseContext)) {
      const r = result as { permissionBehavior?: string; hookPermissionDecisionReason?: string; hookSource?: string }
      if (r.permissionBehavior !== undefined) return { behavior: r.permissionBehavior, reason: r.hookPermissionDecisionReason, source: r.hookSource }
    }
    return null
  }
  return ctx ? as(ctx, run) : run()
}

section('§1 alpha claims x.ts; beta\'s Edit is refused before the write, and told who holds it')
const claimed = await as(alpha, () => leaseGlob.claimLease('crew', 'alpha', [CLAIMED_REL]))
check('alpha holds x.ts', claimed.ok === true, JSON.stringify(claimed))
const betaGuard = await as(beta, () => guard.checkLeaseGuard('Edit', editInput, { crewName: 'crew' }))
check('the guard refuses beta with exactly the crew words', betaGuard === WORDS, `got ${JSON.stringify(betaGuard)}`)
const betaDecision = await preToolDecision(beta, 'Edit', editInput)
check('the PreToolUse road yields a deny for beta before any tool runs, from the lease guard', betaDecision?.behavior === 'deny' && betaDecision.source === 'lease-guard', JSON.stringify(betaDecision))
check('the deny reason names alpha in the crew words', betaDecision?.reason === WORDS, `got ${JSON.stringify(betaDecision?.reason)}`)
check('x.ts is unchanged', readFileSync(CLAIMED_ABS, 'utf8') === ORIGINAL)
const betaWrite = await as(beta, () => guard.checkLeaseGuard('Write', { file_path: CLAIMED_ABS, content: 'x' }, { crewName: 'crew' }))
check('beta\'s Write of x.ts is refused too', betaWrite === WORDS, `got ${JSON.stringify(betaWrite)}`)
const betaAst = await as(beta, () => guard.checkLeaseGuard('AstEdit', { path: CLAIMED_ABS, pattern: 'a', rewrite: 'b' }, { crewName: 'crew' }))
check('beta\'s AstEdit aimed at x.ts is refused too', betaAst === WORDS, `got ${JSON.stringify(betaAst)}`)
const betaAstDir = await as(beta, () => guard.checkLeaseGuard('AstEdit', { path: scratchDir, pattern: 'a', rewrite: 'b' }, { crewName: 'crew' }))
check('beta\'s AstEdit over the folder holding x.ts is refused, naming alpha', typeof betaAstDir === 'string' && betaAstDir.includes('is claimed by alpha'), `got ${JSON.stringify(betaAstDir)}`)
const alphaOwn = await as(alpha, () => guard.checkLeaseGuard('Edit', editInput, { crewName: 'crew' }))
check('alpha\'s own Edit passes', alphaOwn === null, String(alphaOwn))

section('§2 the lead follows the same law with no crew at all')
crewmate.clearDynamicCrewContext()
const leadGuard = await guard.checkLeaseGuard('Edit', editInput)
check('the lead\'s Edit of alpha\'s file is refused with no crew context', leadGuard === WORDS, `got ${JSON.stringify(leadGuard)}`)
const leadDecision = await preToolDecision(null, 'Edit', editInput)
check('the PreToolUse road denies the lead too (appState carries no crew)', leadDecision?.behavior === 'deny' && leadDecision.reason === WORDS, JSON.stringify(leadDecision))
check('x.ts is still unchanged', readFileSync(CLAIMED_ABS, 'utf8') === ORIGINAL)

section('§3 a sub-agent follows the same law')
const sub = { agentType: 'subagent' as const, agentId: 'a1b2c3d4e', subagentName: 'mercury-crew', isBuiltIn: true }
const subGuard = await agentContext.runWithAgentContext(sub, () => guard.checkLeaseGuard('Edit', editInput))
check('a sub-agent\'s Edit of alpha\'s file is refused, naming alpha', subGuard === WORDS, `got ${JSON.stringify(subGuard)}`)

section('§4 the lead\'s own claim binds the crewmates and not the lead')
const leadFile = join(scratchDir, 'lead.ts').slice(PROJECT.length + 1)
const leadClaim = await leaseGlob.claimLease('crew', CREW_LEAD_NAME, [leadFile])
check('the lead claims lead.ts with no crew', leadClaim.ok === true, JSON.stringify(leadClaim))
const leadOwn = await guard.checkLeaseGuard('Edit', { file_path: join(PROJECT, leadFile) })
check('the lead\'s own Edit of lead.ts passes', leadOwn === null, String(leadOwn))
const betaOnLead = await as(beta, () => guard.checkLeaseGuard('Edit', { file_path: join(PROJECT, leadFile) }, { crewName: 'crew' }))
check(`beta's Edit of lead.ts is refused naming ${CREW_LEAD_NAME}`, betaOnLead === `${leadFile} is claimed by ${CREW_LEAD_NAME}; ask ${CREW_LEAD_NAME} or wait for the release.`, `got ${JSON.stringify(betaOnLead)}`)

section('§5 a release by alpha frees x.ts')
check('alpha releases', (await leaseGlob.releaseLease('crew', 'alpha')) === true)
const betaAfterRelease = await as(beta, () => guard.checkLeaseGuard('Edit', editInput, { crewName: 'crew' }))
check('beta\'s Edit passes after the release', betaAfterRelease === null, String(betaAfterRelease))

section('§6 alpha\'s end frees x.ts (the in-process crewmate cleanup releases under alpha\'s name)')
const reclaimed = await as(alpha, () => leaseGlob.claimLease('crew', 'alpha', [CLAIMED_REL]))
check('alpha holds x.ts again', reclaimed.ok === true)
const byAgentId = await leaseGlob.releaseAllForAgent('crew', 'alpha@crew')
check('a release under the agent id (name@crew) frees nothing — the claim is under the name', byAgentId === false)
const spawnSource = readFileSync(join(ROOT, 'src', 'utils', 'swarm', 'spawnInProcess.ts'), 'utf8')
check('the spawn cleanup releases by the crewmate\'s NAME (config.name), the identity the claim is under', /releaseAllForAgent\(config\.crewName,\s*config\.name\)/.test(spawnSource), 'spawnInProcess.ts releases by another id')
const byName = await leaseGlob.releaseAllForAgent('crew', 'alpha')
check('a release under alpha\'s name frees the claim', byName === true)
const betaAfterEnd = await as(beta, () => guard.checkLeaseGuard('Edit', editInput, { crewName: 'crew' }))
check('beta\'s Edit passes once alpha has ended', betaAfterEnd === null, String(betaAfterEnd))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CREW CLAIM-STOP PROOFS PASS')
else console.log(`❌ ${failures} CREW CLAIM-STOP PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.chdir(ROOT)
rmSync(HOME, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
