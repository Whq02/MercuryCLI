#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
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
const HOME = process.env.CREW_FILE_CLAIMS_PROOF_HOME ?? mkdtempSync(join(tmpdir(), 'crew-file-claims-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const key of ['MERCURY_CREW', 'MERCURY_CREW_AGENT', 'MERCURY_CREW_DIR', 'MERCURY_CREWS_DIR', 'MERCURY_TASK_LIST_ID']) delete process.env[key]

const ROOT = join(import.meta.dir, '..', '..')
const CHILD_HOLDER = 'gamma'
const CHILD_FILE = 'src/claims/gamma.ts'

if (process.argv.includes('--child-claim')) {
  const crew = (await import('../../src/services/crew/claims.js')) as typeof import('../../src/services/crew/claims.js')
  const result = await crew.claimCrewFiles([CHILD_FILE], { holder: { name: CHILD_HOLDER, kind: 'seat', id: `${CHILD_HOLDER}@crew` } })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))

console.log('============================================================')
console.log(' Crew file claims — a claim marks a file as one crewmate\'s')
console.log(` home ${HOME}`)
console.log('============================================================')

const { getProjectRoot } = await import('../../src/bootstrap/state.js')
const leaseGlob = (await import('../../src/utils/crew/leaseGlob.js')) as typeof import('../../src/utils/crew/leaseGlob.js')
const crewmate = (await import('../../src/utils/crewmate.js')) as typeof import('../../src/utils/crewmate.js')
const agentContext = (await import('../../src/utils/agentContext.js')) as typeof import('../../src/utils/agentContext.js')
const guard = (await import('../../src/utils/crew/leaseGuard.js')) as typeof import('../../src/utils/crew/leaseGuard.js')
const { CREW_LEAD_NAME } = await import('../../src/utils/crew/constants.js')

type ClaimsModule = typeof import('../../src/services/crew/claims.js')
let crew: ClaimsModule | null = null
let crewImportError = ''
try {
  crew = (await import('../../src/services/crew/claims.js')) as ClaimsModule
} catch (error) {
  crewImportError = String(error).split('\n')[0] ?? String(error)
}

section('§1 the claim record is the crew\'s, not a crew file\'s')
const storePath = leaseGlob.getLeaseStorePath('crew')
const relStore = relative(HOME, storePath)
check('the claim store lives under the crew store root (<home>/crew/), not under crews/<crew>/leases', relStore.startsWith('crew/') && !relStore.includes('crews/'), relStore)
check('the crew claim module exists (src/services/crew/claims.ts)', crew !== null, crewImportError)

section('§2 the lead claims with no crew at all')
if (crew) {
  const lead = crew.resolveClaimHolder()
  check(`the lead's claim identity is ${CREW_LEAD_NAME}, kind lead`, lead.name === CREW_LEAD_NAME && lead.kind === 'lead', JSON.stringify(lead))
  const claimed = await crew.claimCrewFiles(['src/claims/lead.ts'])
  check('claimCrewFiles by the lead answers ok with no crew context', claimed.ok === true, JSON.stringify(claimed))
  const rows = await crew.listCrewClaims()
  const mine = rows.find(r => r.holder.name === CREW_LEAD_NAME)
  check('the record names the lead as holder with kind lead', mine !== undefined && mine.holder.kind === 'lead' && mine.globs.includes('src/claims/lead.ts'), JSON.stringify(rows))
  check('the record file is on disk under the crew root', existsSync(storePath) && readFileSync(storePath, 'utf8').includes('"kind"'), storePath)
} else {
  check('the lead can claim with no crew (needs the crew claim module)', false, crewImportError)
}

section('§3 crewmate alpha claims src/a.ts; its own edit passes')
{
  const alpha = crewmate.createCrewmateContext({
    agentId: 'alpha@crew',
    agentName: 'alpha',
    crewName: 'crew',
    parentSessionId: 'parent',
    abortController: new AbortController(),
  })
  const inAlpha = <T,>(fn: () => T): T => crewmate.runWithCrewmateContext(alpha, fn)
  if (crew) {
    const holder = inAlpha(() => crew!.resolveClaimHolder())
    check('alpha resolves as holder {alpha, crewmate}', holder.name === 'alpha' && holder.kind === 'crewmate', JSON.stringify(holder))
    const claimed = await inAlpha(() => crew!.claimCrewFiles(['src/a.ts']))
    check('alpha claims src/a.ts', claimed.ok === true, JSON.stringify(claimed))
    const rows = await crew.listCrewClaims()
    const row = rows.find(r => r.holder.name === 'alpha')
    check('the claim is on the crew store with alpha\'s name and kind crewmate', row !== undefined && row.holder.kind === 'crewmate' && row.globs.includes('src/a.ts'), JSON.stringify(rows))
  }
  const ownEdit = await inAlpha(() => guard.checkLeaseGuard('Edit', { file_path: join(getProjectRoot(), 'src/a.ts') }))
  check('alpha\'s own Edit of src/a.ts passes the guard', ownEdit === null, String(ownEdit))
}

section('§4 a sub-agent claims under its own identity (not the lead\'s)')
{
  const sub = { agentType: 'subagent' as const, agentId: 'a1b2c3d4e', subagentName: 'mercury-crew', isBuiltIn: true }
  const inSub = <T,>(fn: () => T): T => agentContext.runWithAgentContext(sub, fn)
  const coordId = inSub(() => crewmate.resolveCoordAgentId())
  check('resolveCoordAgentId inside a sub-agent context is the sub-agent\'s id, not the lead\'s', coordId === 'a1b2c3d4e', `got ${JSON.stringify(coordId)}`)
  if (crew) {
    const holder = inSub(() => crew!.resolveClaimHolder())
    check('the sub-agent resolves as holder {a1b2c3d4e, subagent}', holder.name === 'a1b2c3d4e' && holder.kind === 'subagent', JSON.stringify(holder))
    const claimed = await inSub(() => crew!.claimCrewFiles(['src/b.ts']))
    check('the sub-agent claims src/b.ts', claimed.ok === true, JSON.stringify(claimed))
    const rows = await crew.listCrewClaims()
    check('the record names the sub-agent, and the lead\'s own record is untouched', rows.some(r => r.holder.name === 'a1b2c3d4e' && r.holder.kind === 'subagent') && rows.some(r => r.holder.name === CREW_LEAD_NAME && r.globs.includes('src/claims/lead.ts')), JSON.stringify(rows))
  }
  const ownEdit = await inSub(() => guard.checkLeaseGuard('Edit', { file_path: join(getProjectRoot(), 'src/b.ts') }, { crewName: 'crew' }))
  check('the sub-agent\'s own Edit of src/b.ts passes the guard', ownEdit === null, String(ownEdit))
}

section('§5 a daemon seat claims under its name with kind seat')
{
  process.env.MERCURY_CREW = '1'
  process.env.MERCURY_CREW_AGENT = 'beta'
  const stamped = crewmate.resolveCoordAgentId()
  check('a crew child with only the daemon\'s env stamp (the print road\'s shape) resolves its own name', stamped === 'beta', `got ${JSON.stringify(stamped)}`)
  if (crew) {
    const holder = crew.resolveClaimHolder()
    check('a seat resolves as holder {beta, seat}', holder.name === 'beta' && holder.kind === 'seat', JSON.stringify(holder))
    const claimed = await crew.claimCrewFiles(['src/seat/**'])
    check('the seat claims src/seat/**', claimed.ok === true, JSON.stringify(claimed))
  }
  crewmate.setDynamicCrewContext({ agentId: 'beta@crew', agentName: 'beta', crewName: 'crew' })
  if (crew) {
    const holder = crew.resolveClaimHolder()
    check('with the identity args published too, the seat is still {beta, seat, beta@crew}', holder.name === 'beta' && holder.kind === 'seat' && holder.id === 'beta@crew', JSON.stringify(holder))
  }
  delete process.env.MERCURY_CREW
  delete process.env.MERCURY_CREW_AGENT
  crewmate.clearDynamicCrewContext()
}

section('§6 a claim written by another process is read live')
if (crew) {
  let fired = 0
  const stop = crew.subscribeCrewClaims(() => { fired++ })
  const child = spawnSync(process.execPath, ['run', join(ROOT, 'scripts/crew/prove-crew-file-claims.ts'), '--child-claim'], {
    env: { ...process.env, CREW_FILE_CLAIMS_PROOF_HOME: HOME },
    encoding: 'utf8',
    cwd: process.cwd(),
  })
  check('the child process claimed as gamma (a seat in another process)', child.status === 0, (child.stdout + child.stderr).trim().split('\n').slice(-3).join(' | '))
  const rows = await crew.listCrewClaims()
  check('the parent reads gamma\'s claim on the next read, no restart', rows.some(r => r.holder.name === CHILD_HOLDER && r.holder.kind === 'seat' && r.globs.includes(CHILD_FILE)), JSON.stringify(rows))
  const deadline = Date.now() + 8000
  while (fired === 0 && Date.now() < deadline) await sleep(100)
  stop()
  check('the live subscription fired on the other process\'s write', fired > 0, `fired ${fired}`)
} else {
  check('a claim by another process is visible live (needs the crew claim module)', false, crewImportError)
}

section('§7 the coordination service\'s road lands in the same crew store')
{
  const legacy = await leaseGlob.claimLease('crew', 'delta', ['src/d.ts'])
  check('claimLease (the coordinationService delegate) still answers ok', legacy.ok === true, JSON.stringify(legacy))
  if (crew) {
    const rows = await crew.listCrewClaims()
    check('delta\'s claim is on the crew store beside the others', rows.some(r => r.holder.name === 'delta' && r.globs.includes('src/d.ts')), JSON.stringify(rows))
    const conflict = await crew.crewClaimConflict('src/d.ts', { name: 'alpha', kind: 'crewmate' })
    check('crewClaimConflict names delta as the holder of src/d.ts for alpha', conflict !== null && conflict.holder.name === 'delta', JSON.stringify(conflict))
  }
  const listed = await leaseGlob.listLeases('crew')
  check('listLeases lists every crew claim (lead, alpha, the sub-agent, beta, gamma, delta)', ['crew-lead', 'alpha', 'a1b2c3d4e', 'beta', 'gamma', 'delta'].every(n => listed.some(l => l.agentId === n)), listed.map(l => l.agentId).join(','))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CREW FILE-CLAIM PROOFS PASS')
else console.log(`❌ ${failures} CREW FILE-CLAIM PROOF(S) FAILED`)
console.log('═'.repeat(76))
if (process.env.CREW_FILE_CLAIMS_PROOF_HOME === undefined) rmSync(HOME, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
