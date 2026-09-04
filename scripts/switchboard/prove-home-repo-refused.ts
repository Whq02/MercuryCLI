#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'home-repo-refused-')))
const HOME_FX = join(SCRATCH, 'home')
const DESKTOP = join(HOME_FX, 'Desktop')
const PROJ = join(DESKTOP, 'proj')
const BULK = join(SCRATCH, 'bulk')
const CFG = join(SCRATCH, 'cfg')
const DAEMON_DIR = join(CFG, 'daemon')
for (const d of [PROJ, join(PROJ, 'src'), BULK, DAEMON_DIR]) mkdirSync(d, { recursive: true })
writeFileSync(join(HOME_FX, 'notes.txt'), 'home\n')
writeFileSync(join(DESKTOP, 'todo.txt'), 'desk\n')
writeFileSync(join(PROJ, 'README.md'), '# proj\n')
writeFileSync(join(PROJ, 'src', 'a.txt'), 'hello\n')
const BULK_FILES = Number(process.env.MERCURY_HOMEREPO_BULK_FILES ?? '20500')
{
  const perDir = 500
  const dirs = Math.ceil(BULK_FILES / perDir)
  for (let d = 0; d < dirs; d++) {
    const dd = join(BULK, `d${String(d).padStart(4, '0')}`)
    mkdirSync(dd)
    for (let f = 0; f < perDir; f++) writeFileSync(join(dd, `f${String(f).padStart(4, '0')}`), '')
  }
}
let homeLink: string | null = null
try {
  homeLink = join(SCRATCH, 'home-link')
  symlinkSync(HOME_FX, homeLink, 'dir')
} catch {
  homeLink = null
}
process.env.HOME = HOME_FX
process.env.USERPROFILE = HOME_FX
process.env.MERCURY_CONFIG_DIR = CFG
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.GIT_AUTHOR_NAME = 'proof'
process.env.GIT_AUTHOR_EMAIL = 'proof@example.invalid'
process.env.GIT_COMMITTER_NAME = 'proof'
process.env.GIT_COMMITTER_EMAIL = 'proof@example.invalid'
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const boundary = await import('../../src/utils/projectBoundary.js')
const asks = await import('../../src/daemon/permissionAsks.js')
const wt = await import('../../src/daemon/concourseWorktrees.js')
const sup = await import('../../src/daemon/concourseSupervisor.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { listObligations } = await import('../../src/services/crew/obligations.js')

const FS_ROOT = parse(process.cwd()).root

console.log('R1 gitInitRefusal — the boundary owner refuses the wrong folders')
{
  const home = boundary.gitInitRefusal(HOME_FX)
  check('the home directory is refused as home', home?.kind === 'home' && home.words === 'this is your home folder', JSON.stringify(home))
  if (homeLink !== null) {
    const linked = boundary.gitInitRefusal(homeLink)
    check('a symlinked spelling of the home is refused as home', linked?.kind === 'home', JSON.stringify(linked))
  }
  const root = boundary.gitInitRefusal(FS_ROOT)
  check(`the filesystem root (${FS_ROOT}) is refused as a drive root`, root?.kind === 'filesystem-root' && root.words.includes('drive root'), JSON.stringify(root))
  const desk = boundary.gitInitRefusal(DESKTOP)
  check('Desktop under the home is refused as a well-known user folder', desk?.kind === 'user-root' && desk.words.includes('Desktop'), JSON.stringify(desk))
  const bulk = boundary.gitInitRefusal(BULK)
  check(
    `a marker-less folder past the ceiling (${BULK_FILES} files) is refused as not a project, with the count words`,
    bulk?.kind === 'not-a-project' && bulk.words.includes(`over ${boundary.PROJECT_ENTRY_CEILING.toLocaleString('en-US')} entries`) && bulk.words.includes('no project files'),
    JSON.stringify(bulk),
  )
  check('a plain project folder (README + src) is NOT refused', boundary.gitInitRefusal(PROJ) === null)
  check('the marker owner names src as the marker', boundary.projectMarkerOf(PROJ) === 'src')
  const count = boundary.countEntriesBounded(BULK)
  check('the bounded walk stops at the ceiling', count.ceilingReached && count.count === boundary.PROJECT_ENTRY_CEILING + 1, JSON.stringify(count))
  check('the count words for a small folder are exact', boundary.entryCountWords(boundary.countEntriesBounded(PROJ)) === '3 entries', boundary.entryCountWords(boundary.countEntriesBounded(PROJ)))
}

console.log('\nR2 mintGitInitAsk — no ask for a refused folder; the allowed ask names the folder and the count')
{
  const sidecar = join(DAEMON_DIR, 'git-init-asks.json')
  for (const [label, folder] of [['the home', HOME_FX], ['Desktop', DESKTOP], ['the bulk folder', BULK]] as const) {
    const r = asks.mintGitInitAsk(folder)
    check(`${label}: the mint answers refused (no requestId)`, 'refused' in r && !('requestId' in r), JSON.stringify(r))
    check(`${label}: no pending git-init ask names it`, !asks.listPendingPermissionAsks().some(a => a.requestId.startsWith('git-init:') && a.workspaceId === folder))
  }
  const sidecarRows = existsSync(sidecar) ? (JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, string>) : {}
  check('no sidecar row names a refused folder', !Object.values(sidecarRows).some(f => [HOME_FX, DESKTOP, BULK].includes(f)), JSON.stringify(sidecarRows))
  const allowed = asks.mintGitInitAsk(PROJ)
  check('the plain project folder still gets its ask', 'requestId' in allowed && allowed.requestId.startsWith('git-init:'), JSON.stringify(allowed))
  await new Promise(r => setTimeout(r, 300))
  const rows = await listObligations({ scope: 'switchboard' })
  const askRow = rows.find(o => 'requestId' in allowed && o.ref === `permission:${allowed.requestId}`)
  check('the ask row landed', askRow !== undefined)
  check('the ask text carries the absolute path', askRow?.question.includes(PROJ) === true, askRow?.question)
  check('the ask text carries the entry count', askRow?.question.includes('(3 entries)') === true, askRow?.question)
  check('no obligation row was written for a refused folder', !rows.some(o => o.ref.startsWith('permission:git-init:') && (o.question.includes(HOME_FX + ' ') || o.question.includes(DESKTOP + ' ') || o.question.includes(BULK + ' '))))
}

console.log('\nR3 initGitRepository — the refusal at the apply door; the plain project still gets git')
{
  for (const [label, folder, needle] of [
    ['the home', HOME_FX, 'this is your home folder'],
    ['Desktop', DESKTOP, 'Desktop'],
    ['the bulk folder', BULK, 'does not look like a project'],
  ] as const) {
    const r = wt.initGitRepository(folder)
    check(`${label}: refused with the reason words`, r.ok === false && (r.error ?? '').includes(needle) && (r.error ?? '').includes(folder), r.error)
    check(`${label}: no .git was created`, !existsSync(join(folder, '.git')))
  }
  const r = wt.initGitRepository(PROJ)
  check('the plain project folder gets its repository', r.ok === true && existsSync(join(PROJ, '.git')), r.error)
  const { spawnSync } = await import('node:child_process')
  const log = spawnSync('git', ['-C', PROJ, 'log', '--format=%s'], { encoding: 'utf8', env: { ...process.env } })
  check('… with the base commit', log.stdout.trim() === wt.FORK_BASE_COMMIT_SUBJECT, log.stdout.trim())
}

console.log('\nR4 resolveDefaultedAdmission — a refused plain folder never offers')
{
  const PLAIN = join(SCRATCH, 'plain')
  mkdirSync(PLAIN)
  writeFileSync(join(PLAIN, 'README.md'), '# plain\n')
  const live = (ws: string) => [{ workspaceId: ws, isolation: 'shared' as const }]
  const refused = sup.resolveDefaultedAdmission(live(HOME_FX), { workspaceId: HOME_FX }, 5)
  check(
    'the home: a plain repo-held wait carrying the refusal (never a git-offer)',
    refused.kind === 'decision' && !refused.decision.admit && refused.decision.code === 'workspace-collision' && refused.gitOfferRefused?.kind === 'home',
    JSON.stringify(refused),
  )
  check(
    "the home: the wait's reason names the folder and says kept without git",
    refused.kind === 'decision' && !refused.decision.admit && refused.decision.reason.includes(HOME_FX) && refused.decision.reason.includes('kept without git'),
    refused.kind === 'decision' && !refused.decision.admit ? refused.decision.reason : '',
  )
  const offered = sup.resolveDefaultedAdmission(live(PLAIN), { workspaceId: PLAIN }, 5)
  check('an allowed plain folder: the git-offer, as ever', offered.kind === 'git-offer' && offered.code === 'no-repository', JSON.stringify(offered))
  const explicit = sup.resolveDefaultedAdmission(live(HOME_FX), { workspaceId: HOME_FX, isolation: 'exclusive' }, 5)
  check('an explicit isolation choice on the home is the plain collision (no refusal field)', explicit.kind === 'decision' && !explicit.decision.admit && explicit.gitOfferRefused === undefined)
  const free = sup.resolveDefaultedAdmission([], { workspaceId: HOME_FX }, 5)
  check('a free home admits (the refusal only ever replaces the offer)', free.kind === 'decision' && free.decision.admit)
}

console.log('\nR5 ensureWorkerWorktree — a refused plain folder refuses terminally')
{
  const r = await wt.ensureWorkerWorktree(HOME_FX, 'concourse-w9', DAEMON_DIR)
  check('the home: terminal (not the held no-repository), with the reason', !r.ok && r.code === 'worktree-create-failed' && r.error.includes('this is your home folder'), JSON.stringify(r))
  const PLAIN2 = join(SCRATCH, 'plain2')
  mkdirSync(PLAIN2)
  const held = await wt.ensureWorkerWorktree(PLAIN2, 'concourse-w9', DAEMON_DIR)
  check('an allowed plain folder: held on no-repository, as ever', !held.ok && held.code === 'no-repository', JSON.stringify(held))
}

console.log('\nR6 mintGitRefusedReceipt — the rail receipt bound to the queued launch')
{
  const refusal = boundary.gitInitRefusal(HOME_FX)
  asks.mintGitRefusedReceipt('cm-refused-1', HOME_FX, refusal as NonNullable<typeof refusal>)
  await new Promise(r => setTimeout(r, 300))
  const rows = await listObligations({ scope: 'switchboard' })
  const receipt = rows.find(o => o.ref === 'git-refused:cm-refused-1')
  check('the receipt row exists, bound to dispatch:<id>', receipt !== undefined && receipt.sessionId === 'dispatch:cm-refused-1' && receipt.status === 'open', JSON.stringify(receipt))
  check('… naming the folder, the reason and kept without git', receipt?.question.includes(HOME_FX) === true && receipt?.question.includes('this is your home folder') === true && receipt?.question.includes('kept without git') === true, receipt?.question)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-home-repo-refused: ALL LAWS HOLD' : `\nprove-home-repo-refused: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
