#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const SCRATCH = mkdtempSync(join(tmpdir(), 'chat-birth-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_WARM_RUNNER
delete process.env.MERCURY_DAEMON_NO_SELF_WARM
delete process.env.MERCURY_CONCOURSE_WORKER
const gitConfig = join(SCRATCH, 'gitconfig')
writeFileSync(gitConfig, '[user]\n\tname = prover\n\temail = prover@example.invalid\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = gitConfig
process.env.GIT_CONFIG_NOSYSTEM = '1'

mkdirSync(join(SCRATCH, 'home'), { recursive: true })
writeFileSync(
  join(SCRATCH, 'home', '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const { makeConcourseAdmitHandler, readSessionWorkers, concourseTranscriptPath } = await import('../../src/daemon/concourseWorkers.ts')
const { ensureWorkerWorktree, workerWorktreeRoot } = await import('../../src/daemon/concourseWorktrees.ts')
const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseWorkers.ts'
import type { RunnerChildSpec } from '../../src/daemon/headlessRun.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const recordsDir = join(SCRATCH, 'daemon')
mkdirSync(recordsDir, { recursive: true })

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env } })
  return { ok: r.status === 0, stdout: r.stdout ?? '' }
}
function mkrepo(name: string): string {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', dir], { encoding: 'utf8', env: { ...process.env } })
  git(dir, 'commit', '--allow-empty', '-m', 'base')
  return dir
}
function mercuryBranches(ws: string): string[] {
  return git(ws, 'branch', '--list', 'mercury/*', '--format=%(refname:short)')
    .stdout.split('\n')
    .map(s => s.trim())
    .filter(Boolean)
}

class FakeRoster {
  registered: Array<{ short: string; spec: RunnerChildSpec }> = []
  present = new Map<string, { alive: boolean; ready: boolean }>()
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const p = this.present.get(short)
    return p ? { present: true, alive: p.alive, ready: p.ready } : { present: false, alive: false, ready: false }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present.keys()].map(short => ({ short }))
  }
  kill(_short: string): boolean {
    return true
  }
  registerLongLived(short: string, spec: RunnerChildSpec): { ok: boolean; pid?: number; error?: string } {
    this.registered.push({ short, spec })
    this.present.set(short, { alive: true, ready: true })
    return { ok: true, pid: 40_000 + this.registered.length }
  }
}
const roster = new FakeRoster()
const admit = makeConcourseAdmitHandler({ roster: () => roster, dir: recordsDir })
const specOf = (runnerId: string): RunnerChildSpec | undefined => roster.registered.findLast(r => r.short === runnerId)?.spec
const argvOf = (spec: RunnerChildSpec | undefined): string[] => [...(spec?.extraArgv ?? [])]

const resolvedModel = await validateWorkerModelChoice(undefined, 'session')
if (!resolvedModel.ok) {
  console.log(`  [FAIL] the registry resolves a default model — ${resolvedModel.reason}`)
  process.exit(1)
}
const modelKey = resolvedModel.entry.modelId

function seedLiveShared(ws: string, runnerId: string, sessionId: string): void {
  const workers = ((): Record<string, ConcourseWorkerRecordV1> => {
    try {
      return (JSON.parse(readFileSync(join(recordsDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, ConcourseWorkerRecordV1> }).workers
    } catch {
      return {}
    }
  })()
  workers[runnerId] = {
    schema: 1,
    runnerId,
    sessionId,
    workspaceId: ws,
    isolation: 'shared',
    modelKey,
    spawnedAt: Date.now() - 60_000,
    lastLiveAt: Date.now(),
    pid: process.pid,
  } as ConcourseWorkerRecordV1
  writeFileSync(join(recordsDir, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
  roster.present.set(runnerId, { alive: true, ready: true })
}

console.log('============================================================')
console.log(' chat-birth — the solo in-place law on the real policy (L19)')
console.log('============================================================')

console.log('\n── A1: a solo birth beside a live sibling admits IN PLACE ──')
const ws1 = mkrepo('ws1')
{
  seedLiveShared(ws1, 'concourse-w1', randomUUID())
  const born = await admit({ workspaceDir: ws1, isolation: 'shared', bornBlank: true, modelKey })
  check('A1 the shared birth admits beside the live shared sibling', born.ok, born.ok ? '' : born.error)
  if (born.ok) {
    const rec = readSessionWorkers(recordsDir)[born.runnerId]
    check('A1 the record claims the solo in-place kind', rec?.isolation === 'shared', String(rec?.isolation))
    check('A1 no worktree was carved (no path on the record)', rec?.worktreePath === undefined && rec?.branchName === undefined)
    check('A1 the ground is the cwd (in place, the claim root)', specOf(born.runnerId)?.cwd === rec?.workspaceId, String(specOf(born.runnerId)?.cwd))
    check('A1 bornBlankAt stamps the newborn', rec?.bornBlankAt !== undefined)
  }
  check('A1 the worktree estate stayed untouched (no worktrees/ dir)', !existsSync(workerWorktreeRoot(recordsDir)))
  check('A1 no mercury/* branch exists in the repo', mercuryBranches(ws1).length === 0, mercuryBranches(ws1).join(','))
  const defaulted = await admit({ workspaceDir: ws1, modelKey })
  check('A1c the defaulted admission still folds to the worktree estate', defaulted.ok, defaulted.ok ? '' : defaulted.error)
  if (defaulted.ok) {
    const rec = readSessionWorkers(recordsDir)[defaulted.runnerId]
    check('A1c the folded record is worktree-isolated with a branch', rec?.isolation === 'worktree-isolated' && rec?.branchName !== undefined)
    check('A1c the fork exists on disk', rec?.worktreePath !== undefined && existsSync(rec.worktreePath))
    check('A1c the branch is session-keyed, never the runner short', rec?.branchName !== undefined && !rec.branchName.includes(rec.runnerId))
  }
}

console.log('\n── A2: the carve survives a fully-burned ladder ──')
{
  const ws2 = mkrepo('ws2')
  for (const name of ['mercury/seedx', ...[2, 3, 4, 5, 6].map(n => `mercury/seedx-${n}`)]) git(ws2, 'branch', name)
  const carved = await ensureWorkerWorktree(ws2, 'wt-exhausted', recordsDir, { branchName: 'mercury/seedx' })
  check('A2 an exhausted ladder still carves', carved.ok, carved.ok ? '' : carved.error)
  if (carved.ok) {
    const taken = new Set(['mercury/seedx', ...[2, 3, 4, 5, 6].map(n => `mercury/seedx-${n}`)])
    check('A2 the minted name is fresh (time-tailed past the ladder)', carved.branchName !== undefined && !taken.has(carved.branchName), String(carved.branchName))
    check('A2 the fork exists on its fresh branch', existsSync(carved.path))
  }
  const partial = await ensureWorkerWorktree(ws2, 'wt-partial', recordsDir, { branchName: 'mercury/lonely' })
  git(ws2, 'branch', 'mercury/taken')
  const suffixed = await ensureWorkerWorktree(ws2, 'wt-suffixed', recordsDir, { branchName: 'mercury/taken' })
  check('A2 a free base name lands unsuffixed', partial.ok && partial.branchName === 'mercury/lonely')
  check('A2 a taken base steps to -2 (the ladder still ladders)', suffixed.ok && suffixed.branchName === 'mercury/taken-2', suffixed.ok ? String(suffixed.branchName) : suffixed.error)
}

console.log('\n── A3/A4: continue → menu → New Session → a clean second session ──')
{
  const ws4 = mkrepo('ws4')
  const resumeId = randomUUID()
  const resumed = await admit({ workspaceDir: ws4, isolation: 'shared', resumeSessionId: resumeId, modelKey })
  check('A3 the record-less resume admits in place', resumed.ok, resumed.ok ? '' : resumed.error)
  const resumedRec = resumed.ok ? readSessionWorkers(recordsDir)[resumed.runnerId] : undefined
  check('A3 the resume claims shared, carves nothing', resumedRec?.isolation === 'shared' && resumedRec?.worktreePath === undefined)
  check('A3 the resume continues the SAME durable session', resumed.ok && resumed.sessionId === resumeId)
  check('A3 the runner boots with --resume (a revival, not a birth)', resumed.ok && argvOf(specOf(resumed.runnerId)).includes('--resume'))
  const born = await admit({ workspaceDir: ws4, isolation: 'shared', bornBlank: true, modelKey })
  check('A3 New Session admits a clean SECOND session beside the continue', born.ok, born.ok ? '' : born.error)
  const bornRec = born.ok ? readSessionWorkers(recordsDir)[born.runnerId] : undefined
  check('A3 both live in place — distinct ids, zero carves, no branches', born.ok && resumed.ok && born.sessionId !== resumed.sessionId && born.runnerId !== resumed.runnerId && bornRec?.worktreePath === undefined && mercuryBranches(ws4).length === 0)
  check('A4 the born id is fresh (∉ every prior session)', born.ok && born.sessionId !== resumeId && !Object.values(readSessionWorkers(recordsDir)).some(r => r.sessionId === born.sessionId && r.runnerId !== born.runnerId))
  const bornArgv = born.ok ? argvOf(specOf(born.runnerId)) : []
  check('A4 the birth boots --session-id, never --resume', bornArgv.includes('--session-id') && !bornArgv.includes('--resume'))
}

console.log('\n── A4: the solo doors carry the claim in source ──')
{
  const bornDoor = read('src/services/switchboard/bornSession.ts')
  const admitAt = bornDoor.indexOf("op: 'sessionAdmit'")
  check("A4 the birth door claims 'shared' explicitly", admitAt !== -1 && bornDoor.slice(admitAt, bornDoor.indexOf('{ timeoutMs: 60_000 }', admitAt)).includes("isolation: 'shared'"))
  check('A4 the birth door never names resumeSessionId (new ≠ replay)', !bornDoor.includes('resumeSessionId'))
  const resumeDoor = read('src/services/switchboard/hopIntoSession.ts')
  check("A4 the resume door claims 'shared' beside its resumeSessionId", /resumeSessionId: sessionId, isolation: 'shared'/.test(resumeDoor))
}

console.log('\n── A5: an old exclusive record reactivates as shared ──')
{
  const ws5 = mkrepo('ws5')
  seedLiveShared(ws5, 'concourse-w8', randomUUID())
  const oldId = randomUUID()
  const workers = (JSON.parse(readFileSync(join(recordsDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, ConcourseWorkerRecordV1> }).workers
  workers['concourse-w9'] = {
    schema: 1,
    runnerId: 'concourse-w9',
    sessionId: oldId,
    workspaceId: ws5,
    isolation: 'exclusive',
    modelKey,
    spawnedAt: Date.now() - 3_600_000,
    lastLiveAt: Date.now() - 3_600_000,
    parkedAt: Date.now() - 1_800_000,
  } as ConcourseWorkerRecordV1
  writeFileSync(join(recordsDir, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
  const oldTranscript = concourseTranscriptPath(workers['concourse-w9']!)
  mkdirSync(join(oldTranscript, '..'), { recursive: true })
  writeFileSync(oldTranscript, `${JSON.stringify({ type: 'user', uuid: `${oldId}-u1`, message: { role: 'user', content: 'seeded turn' } })}\n`)
  const reactivated = await admit({ workspaceDir: ws5, isolation: 'shared', resumeSessionId: oldId, modelKey })
  check('A5 the reactivate admits beside the live shared sibling', reactivated.ok, reactivated.ok ? '' : reactivated.error)
  const rec = Object.values(readSessionWorkers(recordsDir)).find(r => r.sessionId === oldId && r.endedAt === undefined)
  check("A5 the standing record re-claims 'shared' (the ground never re-fences)", rec?.isolation === 'shared', String(rec?.isolation))
}

console.log('\n── A6 a chat on a local model nothing serves: the screen\'s own chat is admitted on it with a note, and nothing else is ──')
{
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const UNSERVED = 'local/qwen3.5-2b'
  const NEVER = `${UNSERVED} is not being served — start a local server, or set MERCURY_LOCAL_BASE_URL · /model chooses another`
  const AGAIN = `${UNSERVED} is not being served — /tensorfold serves it again · /model chooses another`
  const seats = new FakeRoster()
  const unservedDir = join(SCRATCH, 'daemon-unserved')
  mkdirSync(unservedDir, { recursive: true })
  const admitUnserved = makeConcourseAdmitHandler({ roster: () => seats, dir: unservedDir })
  const modelOf = (runnerId: string): string | undefined => seats.registered.findLast(r => r.short === runnerId)?.spec.model
  const verdict = await validateWorkerModelChoice(UNSERVED, 'session')
  check('A6 the model is one the admission\'s own reading refuses as unreachable:local (holds on the parent too)', !verdict.ok && verdict.reason === 'unreachable:local', JSON.stringify(verdict))
  const chat = await admitUnserved({ workspaceDir: mkrepo('ws-unserved'), isolation: 'shared', bornBlank: true, modelKey: UNSERVED, by: 'operator' })
  check('A6 the screen\'s own chat is admitted on that model', chat.ok && chat.modelId === UNSERVED, JSON.stringify(chat))
  check('A6 its note names the model and the two ways on, in the words of a machine that never served it', chat.ok && chat.note === NEVER, chat.ok ? String(chat.note) : chat.error)
  check('A6 one runner is registered for it, on that model, and nothing else is started', seats.registered.length === 1 && chat.ok && modelOf(chat.runnerId) === UNSERVED, `${seats.registered.length} registered: ${chat.ok ? modelOf(chat.runnerId) : ''}`)
  mkdirSync(join(SCRATCH, 'home', 'local-setup'), { recursive: true })
  writeFileSync(join(SCRATCH, 'home', 'local-setup', 'tensorfold-hosts.json'), JSON.stringify({ version: 1, hosts: [], ports: [], windows: { 'mlx-community/qwen3.5-2b-mlx-4bit': 32768 } }))
  const again = await admitUnserved({ workspaceDir: mkrepo('ws-unserved-again'), isolation: 'shared', bornBlank: true, modelKey: UNSERVED, by: 'operator:screen' })
  check('A6 where Mercury\'s engine has served that model on this machine the note names /tensorfold', again.ok && again.note === AGAIN, again.ok ? String(again.note) : again.error)
  const held = seats.registered.length
  for (const [who, by] of [['an asker that is no screen', 'session:a-crew-lead'], ['an admission that names no asker', undefined]] as const) {
    const other = await admitUnserved({ workspaceDir: mkrepo(`ws-unserved-${by === undefined ? 'unnamed' : 'crew'}`), isolation: 'shared', modelKey: UNSERVED, ...(by !== undefined ? { by } : {}) })
    check(`A6 ${who} is refused as it was, in the refusal's own words (holds on the parent too)`, !other.ok && other.error.startsWith('model refused (unreachable:local) · ask the operator to start a local server, or set MERCURY_LOCAL_BASE_URL — no local server is discovered on this box'), JSON.stringify(other))
  }
  const family = await admitUnserved({ workspaceDir: mkrepo('ws-unserved-family'), isolation: 'shared', bornBlank: true, modelKey: 'local', by: 'operator' })
  check('A6 the family word with no server is refused as it was, for the screen too (holds on the parent too)', !family.ok && family.error.startsWith('model refused (unreachable:local)'), JSON.stringify(family))
  check('A6 none of the three refusals registered a runner', seats.registered.length === held, String(seats.registered.length - held))
}

console.log(`\n${failures === 0 ? 'ALL PINS HOLD' : `${failures} PIN(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
