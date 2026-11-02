#!/usr/bin/env bun
// gate-watch: src/daemon/concourseWorkers.ts src/daemon/warmRunner.ts src/utils/projectStoreIdentity.ts src/utils/directoryIdentity.ts
// gate-watch: src/services/concourse/projectActivity.ts src/utils/bootCardFacts.ts src/utils/config/globalConfig.ts scripts/lib/seatDoor.ts
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'workspace-identity-')))
const HOME = join(ROOT, 'home')
const recordsDir = join(ROOT, 'daemon')
const project = join(ROOT, 'MixedProject')
for (const path of [HOME, recordsDir, project]) mkdirSync(path)
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_WARM_RUNNER
writeFileSync(join(HOME, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }))
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const workers = await import('../../src/daemon/concourseWorkers.ts')
const warm = await import('../../src/daemon/warmRunner.ts')
const { projectActivity } = await import('../../src/services/concourse/projectActivity.ts')
const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
type Spec = ReturnType<typeof workers.buildConcourseWorkerSpec>
class Roster {
  registered: Array<{ short: string; spec: Spec }> = []
  stands = new Map<string, ReturnType<typeof standInRunner>>()
  claims: Record<string, unknown>[] = []
  has(short: string) { return { present: this.stands.has(short), alive: this.stands.has(short), ready: this.stands.has(short) } }
  list() { return [...this.stands.keys()].map(short => ({ short })) }
  registerLongLived(short: string, spec: Spec) {
    this.registered.push({ short, spec })
    this.stands.set(short, standInRunner({ sessionId: null, autoAnswer: { 'session/claim': (params: unknown) => {
      const claim = params as Record<string, unknown>
      this.claims.push(claim)
      return { session_id: String(claim.session_id) }
    } } }))
    return { ok: true, pid: process.pid }
  }
  door(short: string) { return this.stands.get(short)?.connection }
  kill(short: string) { this.stands.get(short)?.close('fixture done'); return this.stands.delete(short) }
  patchSeatClaim(short: string, patch: { model: string; effort: string; respawnExtraArgv: readonly string[] }) {
    const reg = this.registered.find(row => row.short === short)
    return reg ? { ...reg.spec, ...patch, respawnExtraArgv: [...patch.respawnExtraArgv] } : null
  }
}
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const roster = new Roster()
const deps = { roster: () => roster, dir: recordsDir }
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
try {
  const link = join(ROOT, 'other-door')
  symlinkSync(project, link, process.platform === 'win32' ? 'junction' : 'dir')
  let other = project.toUpperCase()
  try { if (statSync(other).ino !== statSync(project).ino) other = link } catch { other = link }
  const canonical = realpathSync.native(project).normalize('NFC')
  check('A1 two spellings of one native directory have one workspace id', workers.canonicalWorkspaceId(project) === workers.canonicalWorkspaceId(other) && workers.canonicalWorkspaceId(other) === canonical)
  check('A2 a symlink uses that same id, still a usable working directory', workers.canonicalWorkspaceId(link) === canonical && statSync(workers.canonicalWorkspaceId(link)).isDirectory())
  const missing = join(ROOT, 'missing', 'folder')
  check('A3 failed realpath degrades to raw spelling, never throws', workers.canonicalWorkspaceId(missing) === missing)

  const file = workers.concourseWorkersPath(recordsDir)
  const row = (n: number, workspaceId: string) => ({ schema: 1, runnerId: `concourse-w${n}`, sessionId: id(n), workspaceId, isolation: 'shared', modelKey: 'fixture', spawnedAt: n, lastLiveAt: n, pid: process.pid })
  const saved = JSON.stringify({ version: 1, workers: { 'concourse-w1': row(1, other), 'concourse-w2': row(2, link) } })
  writeFileSync(file, saved)
  const read = workers.readSessionWorkers(recordsDir)
  const listed = workers.listConcourseWorkers(null, recordsDir)
  check('B1 existing records project the same native workspace id', Object.values(read).every(rec => rec.workspaceId === canonical) && new Set(listed.map(rec => rec.workspaceId)).size === 1)
  const elsewhere = join(ROOT, 'Elsewhere')
  mkdirSync(elsewhere)
  const activity = projectActivity(listed.map(rec => ({ sessionId: rec.sessionId, workspaceDir: rec.workspaceId, state: 'working' as const })), { current: projectIdentity(elsewhere) })
  check('B2 the switchboard lists one native workspace with both running sessions', activity.length === 1 && activity[0]?.running === 2 && activity[0]?.dir === canonical)
  check('B3 every identity and switchboard read leaves the record bytes untouched', readFileSync(file, 'utf8') === saved)
  workers.updateConcourseWorkers(() => {}, recordsDir)
  const adopted = JSON.parse(readFileSync(file, 'utf8')) as { workers: Record<string, { workspaceId: string }> }
  check('B4 only the existing writer persists the projected identity', Object.values(adopted.workers).every(rec => rec.workspaceId === canonical))
  workers.updateConcourseWorkers(rows => { for (const key of Object.keys(rows)) delete rows[key] }, recordsDir)

  const ensured = await warm.ensureWarmRunner({ workspaceDir: other }, deps)
  check('C1 a runner is pre-spawned for the other spelling', ensured.state === 'warmed' && roster.registered.length === 1, JSON.stringify(ensured))
  const kept = await warm.ensureWarmRunner({ workspaceDir: project }, deps)
  check('C2 ensuring through the native spelling keeps that one runner', kept.state === 'kept' && roster.registered.length === 1, JSON.stringify(kept))
  const admit = workers.makeConcourseAdmitHandler({ ...deps, claimWarm: args => warm.claimWarmRunner({ ...args, answerDeadlineMs: 1500 }, deps) })
  const admitted = await admit({ workspaceDir: project, by: 'operator', effort: 'max', title: 'identity fixture' })
  check('C3 admission through the native spelling claims the pre-spawned runner, with no second spawn', admitted.ok && admitted.runnerId === ensured.short && roster.registered.length === 1, JSON.stringify(admitted))
  check('C4 exactly one claim keeps max effort and the same workspace id', roster.claims.length === 1 && roster.claims[0]?.effort === 'max' && admitted.ok && admitted.workspaceId === canonical && warm.warmRunnerCount() === 0)
  const rec = admitted.ok ? workers.readSessionWorkers(recordsDir)[admitted.runnerId] : undefined
  check('C5 the persisted session uses that native workspace id', rec?.workspaceId === canonical && rec.effort === 'max')

  const sibling = join(ROOT, 'Sibling')
  mkdirSync(sibling)
  check('D1 different directories remain different workspaces', workers.canonicalWorkspaceId(sibling) !== canonical)
  const ino = statSync(sibling).ino
  const siblingId = workers.canonicalWorkspaceId(sibling)
  rmSync(sibling, { recursive: true, force: true })
  const recreated = join(ROOT, 'Recreated')
  mkdirSync(recreated)
  console.log(`  recreated root ${statSync(recreated).ino === ino ? 'reused' : 'did not reuse'} the removed root's inode`)
  check('D2 Linux inode reuse cannot inherit the removed workspace id', workers.canonicalWorkspaceId(recreated) !== siblingId && workers.canonicalWorkspaceId(recreated) === realpathSync.native(recreated))
} finally {
  for (const short of [...roster.stands.keys()]) roster.kill(short)
  warm.resetWarmRunnersForTesting()
  rmSync(ROOT, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-workspace-directory-identity: ALL LAWS HOLD' : `\nprove-workspace-directory-identity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
