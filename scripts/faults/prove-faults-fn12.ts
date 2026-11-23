#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn12-')))
const configHome = join(scratch, 'home')
mkdirSync(configHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
const faultHints: Array<[string, string]> = [
  ['conflictRegionStore-', 'change readConflictRegions in src/platform/git-graph/conflictRegionStore.ts to treat only ENOENT as an empty result and rethrow other read errors'],
  ['observe-config-', 'change commitIdentityLine in src/platform/git-graph/observe.ts to report unset only when git config reads cleanly and let a corrupt config throw'],
  ['plan-headsha-', 'change applyPlan in src/platform/git-graph/plan.ts to treat only an unborn HEAD (rev-parse exit 1) as empty and refuse with code io on any other rev-parse error'],
  ['idle-sweep-', 'change sweepHostIdle in src/models/hosting/idle.ts to emit one unread-use notice per run of failing rounds and never release on an unreadable last use'],
  ['idle-', 'change hostIdleVerdict in src/models/hosting/idle.ts to return undefined when the last-turn mark or activity.json cannot be read, and idle only when the mark is absent'],
  ['repoFolder-', 'change resolveRepoFolder in src/platform/git-graph/repoFolder.ts to refuse with the EACCES note when the folder cannot be statted or listed'],
  ['reliability-', 'change noteHostLink in src/models/hosting/reliability.ts to start fresh on corrupt JSON but keep an unreadable history file untouched'],
  ['bankManifest-', 'change bankManifest in src/models/hosting/bankManifest.ts to report the bank cannot be read on EACCES and not banked only when the folder is absent'],
  ['bank-', 'change the matching function in src/models/hosting/bank.ts (bankFiles, bankFolder, bankModelPath, bankState, verifyBank or sealBank, named in the label) to throw or answer as the label says on a corrupt or unreadable file'],
]
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = cond ? '' : (faultHints.find(([prefix]) => label.startsWith(prefix))?.[1] ?? '')
  const said = [detail, hint].filter(Boolean).join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && said ? ` — ${said}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

async function run(): Promise<void> {
  {
    const { readConflictRegions } = await import('../../src/platform/git-graph/conflictRegionStore.ts')
    const root = join(scratch, 'conflict-regions')
    mkdirSync(root, { recursive: true })
    const owner = 'session:fn12-conflict' as import('../../src/engine/run-owner/ownerKey.ts').OwnerKey
    const absent = readConflictRegions(owner, root, 'missing.txt')
    check('conflictRegionStore-enoent: absent file returns empty regions', absent.length === 0)
    if (!POSIX_MODES) skip('conflictRegionStore-eacces', 'needs non-root POSIX')
    else {
      const locked = join(root, 'locked.txt')
      writeFileSync(locked, '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n')
      chmodSync(locked, 0o000)
      let threw: NodeJS.ErrnoException | null = null
      try { readConflictRegions(owner, root, 'locked.txt') } catch (error) { threw = error as NodeJS.ErrnoException }
      finally { chmodSync(locked, 0o600) }
      check('conflictRegionStore-eacces: unreadable file throws EACCES instead of returning empty regions', threw?.code === 'EACCES', String(threw))
    }
  }

  {
    const { commitIdentityLine } = await import('../../src/platform/git-graph/observe.ts')
    const root = join(scratch, 'observe-config')
    const gitHome = join(scratch, 'observe-git-home')
    mkdirSync(root, { recursive: true })
    mkdirSync(gitHome, { recursive: true })
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
    Object.assign(process.env, { HOME: gitHome, XDG_CONFIG_HOME: join(gitHome, '.config'), GIT_CONFIG_GLOBAL: join(gitHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
    try {
      execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, env: process.env })
      const unset = commitIdentityLine(root)
      check('observe-config-unset: unset user.name/email returns unset line', Boolean(unset?.includes('user.name and user.email unset')), String(unset))
      writeFileSync(join(root, '.git', 'config'), '[broken\n')
      let threw: unknown = null
      try { commitIdentityLine(root) } catch (error) { threw = error }
      check('observe-config-corrupt: corrupt .git/config throws instead of reporting identity unset', threw !== null, 'returned without throwing')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  {
    const root = join(scratch, 'plan-headsha')
    const unbornRoot = join(scratch, 'plan-unborn')
    mkdirSync(root, { recursive: true })
    mkdirSync(unbornRoot, { recursive: true })
    const gitEnv = { ...process.env, HOME: configHome, XDG_CONFIG_HOME: join(configHome, '.config'), GIT_CONFIG_GLOBAL: join(configHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, env: gitEnv })
    execFileSync('git', ['config', 'user.name', 'proof'], { cwd: root, env: gitEnv })
    execFileSync('git', ['config', 'user.email', 'proof@local'], { cwd: root, env: gitEnv })
    writeFileSync(join(root, 'base.txt'), 'base\n')
    execFileSync('git', ['add', 'base.txt'], { cwd: root, env: gitEnv })
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: root, env: gitEnv })
    writeFileSync(join(root, 'a.txt'), 'change\n')

    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: unbornRoot, env: gitEnv })
    execFileSync('git', ['config', 'user.name', 'proof'], { cwd: unbornRoot, env: gitEnv })
    execFileSync('git', ['config', 'user.email', 'proof@local'], { cwd: unbornRoot, env: gitEnv })
    writeFileSync(join(unbornRoot, 'first.txt'), 'hello\n')

    const { preparePlan, applyPlan } = await import('../../src/platform/git-graph/plan.ts')
    const owner = 'session:fn12-plan' as import('../../src/engine/run-owner/ownerKey.ts').OwnerKey
    if (process.platform === 'win32') {
      console.log('  not read on Windows: the row plants a shell-script git on PATH, which Windows does not start')
    } else {
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      const fakeBin = join(scratch, 'fake-git-bin')
      mkdirSync(fakeBin, { recursive: true })
      const fakeGit = join(fakeBin, 'git')
      writeFileSync(fakeGit, `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--verify" ]; then\n    echo "fatal: bad HEAD" >&2\n    exit 128\n  fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`)
      chmodSync(fakeGit, 0o755)
      const p1 = preparePlan(owner, root, [{ message: 'add a', files: ['a.txt'] }])
      const savedPath = process.env.PATH
      process.env.PATH = `${fakeBin}:${savedPath ?? ''}`
      let r1: ReturnType<typeof applyPlan> | typeof p1
      try { r1 = 'id' in p1 ? applyPlan(owner, p1.id) : p1 } finally { process.env.PATH = savedPath }
      check('plan-headsha-error: non-1 rev-parse error refuses apply instead of building empty index', r1.state === 'refused' && 'code' in r1 && r1.code === 'io' && r1.reason.includes('bad HEAD'), JSON.stringify(r1))
    }
    const p2 = preparePlan(owner, unbornRoot, [{ message: 'initial', files: ['first.txt'] }])
    const r2 = 'id' in p2 ? applyPlan(owner, p2.id) : p2
    check('plan-headsha-unborn: unborn HEAD (exit 1) still commits cleanly', r2.state === 'applied', JSON.stringify(r2))
  }

  {
    const { HOST_IDLE_LIMIT_MS, hostIdleVerdict } = await import('../../src/models/hosting/idle.ts')
    const readyAt = 1_700_000_000_000
    const now = readyAt + HOST_IDLE_LIMIT_MS + 60_000
    const baseRecord: import('../../src/models/hosting/store.ts').HostRecord = {
      id: 'fn12-idle-pod',
      name: 'fn12-idle-pod',
      recipe: 'test',
      price: 1,
      startedAt: new Date(readyAt).toISOString(),
      status: 'RUNNING',
      jobState: 'ready',
      advancedAt: readyAt,
      steps: [{ step: 'ready', at: readyAt }],
    }
    const absent = hostIdleVerdict(baseRecord, now, { lastTurnAt: () => undefined })
    check('idle-absent-mark: absent marks still yield idle verdict after limit', absent?.kind === 'idle', JSON.stringify(absent))

    let threwOut = false
    let threwVerdict: ReturnType<typeof hostIdleVerdict>
    try {
      threwVerdict = hostIdleVerdict(baseRecord, now, { lastTurnAt: () => { throw Object.assign(new Error('EACCES: mark unreadable'), { code: 'EACCES' }) } })
    } catch { threwOut = true }
    check('idle-last-turn-throw: throwing lastTurnAt yields undefined verdict instead of idle', !threwOut && threwVerdict === undefined, JSON.stringify({ threwOut, threwVerdict }))

    const mediaDir = join(configHome, 'host', 'media', 'fn12-media-corrupt')
    mkdirSync(mediaDir, { recursive: true })
    writeFileSync(join(mediaDir, 'activity.json'), '{ torn json')
    const corruptMedia = hostIdleVerdict({ ...baseRecord, id: 'fn12-media-corrupt' }, now, { lastTurnAt: () => undefined })
    check('idle-media-corrupt: corrupt activity.json yields undefined verdict instead of idle', corruptMedia === undefined, JSON.stringify(corruptMedia))

    if (!POSIX_MODES) skip('idle-media-eacces', 'needs non-root POSIX')
    else {
      const lockedDir = join(configHome, 'host', 'media', 'fn12-media-locked')
      mkdirSync(lockedDir, { recursive: true })
      const activity = join(lockedDir, 'activity.json')
      writeFileSync(activity, JSON.stringify({ at: now - 1000 }))
      chmodSync(activity, 0o000)
      let lockedVerdict: ReturnType<typeof hostIdleVerdict>
      try { lockedVerdict = hostIdleVerdict({ ...baseRecord, id: 'fn12-media-locked' }, now, { lastTurnAt: () => undefined }) }
      finally { chmodSync(activity, 0o600) }
      check('idle-media-eacces: unreadable activity.json yields undefined verdict instead of idle', lockedVerdict === undefined, JSON.stringify(lockedVerdict))
    }

    const { existsSync, readdirSync, readFileSync } = await import('node:fs')
    const { sweepHostIdle } = await import('../../src/models/hosting/idle.ts')
    const { hostDirectory, removeHostRecord, writeHostRecord } = await import('../../src/models/hosting/store.ts')
    const sweepRecord: import('../../src/models/hosting/store.ts').HostRecord = {
      ...baseRecord,
      id: 'fn12-sweep-unread',
      name: 'fn12-sweep-unread',
      vendor: 'runpod',
      price: 2.5,
      generation: 'gen-1',
      sessionId: 'session-fn12-idle',
    }
    writeHostRecord(sweepRecord)
    const noticeDir = join(hostDirectory(), 'notices')
    const readNotices = (): string[] => existsSync(noticeDir)
      ? readdirSync(noticeDir).filter(name => name.endsWith('.json')).map(name => (JSON.parse(readFileSync(join(noticeDir, name), 'utf8')) as { words: string }).words)
      : []
    let releases = 0
    const throwing = (): number | undefined => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }
    try {
      const r1 = await sweepHostIdle({ now, records: [sweepRecord], lastTurnAt: throwing, release: async () => { releases++ } })
      const after1 = readNotices()
      const r2 = await sweepHostIdle({ now: now + 300_000, records: [sweepRecord], lastTurnAt: throwing, release: async () => { releases++ } })
      const after2 = readNotices()
      const expected = 'fn12-sweep-unread · Runpod pod fn12-sweep-unread is still running and bills $2.50/hr because its last use could not be read (EACCES: permission denied) · /llmhost → Machines I’m paying for → Terminate stops it'
      check('idle-sweep-unread-once: two consecutive failing rounds emit the notice once and terminate nothing', r1.length === 0 && r2.length === 0 && releases === 0 && after1.length === 1 && after2.length === 1 && after1[0]!.includes(expected), JSON.stringify({ r1: r1.length, r2: r2.length, releases, n1: after1.length, n2: after2.length, first: after1[0] }))

      await sweepHostIdle({ now: now + 600_000, records: [sweepRecord], lastTurnAt: () => now + 590_000, release: async () => { releases++ } })
      await sweepHostIdle({ now: now + 900_000, records: [sweepRecord], lastTurnAt: throwing, release: async () => { releases++ } })
      const after4 = readNotices()
      check('idle-sweep-unread-again-after-ok: a failing round after a succeeding round emits one new notice and terminates nothing', releases === 0 && after4.length === 2, JSON.stringify({ releases, n4: after4.length }))
    } finally {
      removeHostRecord(sweepRecord.id)
    }
  }

  {
    const { resolveRepoFolder } = await import('../../src/platform/git-graph/repoFolder.ts')
    const emptyDir = join(scratch, 'repo-folder-empty')
    mkdirSync(emptyDir, { recursive: true })
    const absent = resolveRepoFolder(emptyDir)
    check('repoFolder-empty: readable non-repo returns no git repository refusal', absent.state === 'refused' && absent.note.includes('no git repository at '), JSON.stringify(absent))
    if (!POSIX_MODES) skip('repoFolder-eacces', 'needs non-root POSIX')
    else {
      const noStatDir = join(scratch, 'repo-folder-nostat')
      mkdirSync(noStatDir, { recursive: true })
      chmodSync(noStatDir, 0o000)
      let statRes: ReturnType<typeof resolveRepoFolder>
      try { statRes = resolveRepoFolder(noStatDir) } finally { chmodSync(noStatDir, 0o700) }
      check('repoFolder-stat-eacces: unsearchable folder refuses with EACCES instead of no git repository', statRes.state === 'refused' && !statRes.note.includes('no git repository') && statRes.note.includes('EACCES'), JSON.stringify(statRes))

      const noListDir = join(scratch, 'repo-folder-nolist')
      mkdirSync(noListDir, { recursive: true })
      chmodSync(noListDir, 0o111)
      let listRes: ReturnType<typeof resolveRepoFolder>
      try { listRes = resolveRepoFolder(noListDir) } finally { chmodSync(noListDir, 0o700) }
      check('repoFolder-readdir-eacces: unreadable folder refuses with EACCES instead of no git repository', listRes.state === 'refused' && !listRes.note.includes('no git repository') && listRes.note.includes('EACCES'), JSON.stringify(listRes))
    }
  }

  {
    const { readFileSync } = await import('node:fs')
    const { noteHostLink, readHostLinkObservation } = await import('../../src/models/hosting/reliability.ts')
    const { hostDirectory } = await import('../../src/models/hosting/store.ts')
    const relDir = join(hostDirectory(), 'reliability')
    mkdirSync(relDir, { recursive: true })
    const corruptPath = join(relDir, 'vast-fn12corrupt.json')
    writeFileSync(corruptPath, '{ torn json')
    const afterCorrupt = noteHostLink({ vendor: 'vast', id: 'fn12corrupt', machineId: '8801' }, { outcome: 'reconnecting', attempt: 1, why: 'link down' }, 1_700_000_000_000)
    check('reliability-corrupt-control: corrupt JSON still starts a fresh observation', afterCorrupt.outages.length === 1 && readHostLinkObservation('vast', 'fn12corrupt')?.machineId === '8801')

    if (!POSIX_MODES) skip('reliability-unreadable-kept', 'needs non-root POSIX')
    else {
      noteHostLink({ vendor: 'vast', id: 'fn12locked', machineId: '8802' }, { outcome: 'lost', attempt: 5, why: 'prior outage' }, 1_700_000_000_000)
      const lockedPath = join(relDir, 'vast-fn12locked.json')
      const beforeBytes = readFileSync(lockedPath, 'utf8')
      chmodSync(lockedPath, 0o000)
      let returned: ReturnType<typeof noteHostLink> | null = null
      try {
        returned = noteHostLink({ vendor: 'vast', id: 'fn12locked', machineId: '8802' }, { outcome: 'reconnecting', attempt: 1, why: 'new drop' }, 1_700_000_060_000)
      } finally {
        chmodSync(lockedPath, 0o600)
      }
      const afterBytes = readFileSync(lockedPath, 'utf8')
      check('reliability-unreadable-kept: unreadable history file is byte-identical after noteHostLink and returns valid observation', returned !== null && returned.outages.length === 1 && afterBytes === beforeBytes, afterBytes === beforeBytes ? '' : 'file was overwritten')
    }
  }

  {
    const { bankManifest } = await import('../../src/models/hosting/bankManifest.ts')
    const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
    const recipe = HOST_RECIPES[0]!
    const missing = bankManifest(recipe, join(scratch, 'no-such-bank-dir'))
    check('bankManifest-enoent: absent bank folder returns not banked', missing.reason === 'not banked · b banks the weights', JSON.stringify(missing))

    if (!POSIX_MODES) skip('bankManifest-eacces', 'needs non-root POSIX')
    else {
      const lockedParent = join(scratch, 'bm-locked-parent')
      const childBank = join(lockedParent, 'model')
      mkdirSync(childBank, { recursive: true })
      chmodSync(lockedParent, 0o000)
      let parentRes: ReturnType<typeof bankManifest>
      try { parentRes = bankManifest(recipe, childBank) } finally { chmodSync(lockedParent, 0o700) }
      check('bankManifest-lstat-eacces: unsearchable bank parent reports bank cannot be read instead of not banked', Boolean(parentRes.reason?.startsWith('the bank cannot be read:')), JSON.stringify(parentRes))

      const sumsBank = join(scratch, 'bm-locked-sums')
      mkdirSync(sumsBank, { recursive: true })
      const sumsFile = join(sumsBank, 'SHA256SUMS')
      writeFileSync(sumsFile, 'a'.repeat(64) + '  weights.gguf\n')
      chmodSync(sumsFile, 0o000)
      let sumsRes: ReturnType<typeof bankManifest>
      try { sumsRes = bankManifest(recipe, sumsBank) } finally { chmodSync(sumsFile, 0o600) }
      check('bankManifest-sums-eacces: unreadable SHA256SUMS reports cannot be read instead of no SHA256SUMS', Boolean(sumsRes.reason?.includes('cannot be read:')), JSON.stringify(sumsRes))

      const subdirBank = join(scratch, 'bm-locked-subdir')
      const lockedSub = join(subdirBank, 'sub')
      mkdirSync(lockedSub, { recursive: true })
      writeFileSync(join(subdirBank, 'SHA256SUMS'), 'a'.repeat(64) + '  sub/weights.gguf\n')
      chmodSync(lockedSub, 0o000)
      let subRes: ReturnType<typeof bankManifest>
      try { subRes = bankManifest(recipe, subdirBank) } finally { chmodSync(lockedSub, 0o700) }
      check('bankManifest-subdir-eacces: unreadable subdir inside bank reports bank cannot be read instead of missing file', Boolean(subRes.reason?.startsWith('the bank cannot be read:')), JSON.stringify(subRes))
    }
  }

  {
    const { bankFiles, bankFolder, bankModelPath, bankState, sealBank, verifyBank, writeBankRegistry } = await import('../../src/models/hosting/bank.ts')
    const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
    const safetensorsRecipe = { ...HOST_RECIPES[0]!, id: 'fn12-st', model: 'fn12/st-model', weightFile: undefined, weightManifest: undefined, include: undefined }
    const stDir = join(scratch, 'bank-st-corrupt')
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, 'model.safetensors.index.json'), '{ torn json')
    let stErr: unknown = null
    try { bankFiles(safetensorsRecipe, stDir) } catch (error) { stErr = error }
    check('bank-safetensors-index-corrupt: corrupt model.safetensors.index.json throws instead of omitting shards', stErr instanceof SyntaxError, String(stErr))

    const stAbsent = bankFiles(safetensorsRecipe, join(scratch, 'bank-st-absent'))
    check('bank-safetensors-index-absent: absent index falls back to config and index names', stAbsent.files.length === 2, JSON.stringify(stAbsent.files))

    if (!POSIX_MODES) skip('bank-eacces', 'needs non-root POSIX')
    else {
      const parentLocked = join(scratch, 'bank-dir-locked-parent')
      const remembered = join(parentLocked, 'mybank')
      mkdirSync(remembered, { recursive: true })
      writeBankRegistry({ folder: remembered, models: {} })
      chmodSync(parentLocked, 0o000)
      let folderThrew = false
      let probed: string | undefined
      try { probed = bankFolder() } catch { folderThrew = true } finally { chmodSync(parentLocked, 0o700) }
      check('bank-folder-eacces-no-throw: unsearchable remembered bank makes bankFolder answer as if not remembered without throwing', !folderThrew && probed !== remembered, JSON.stringify({ folderThrew, probed }))

      const lockedBank = join(scratch, 'bank-locked-explicit')
      mkdirSync(lockedBank, { recursive: true })
      chmodSync(lockedBank, 0o000)
      let dirErr: NodeJS.ErrnoException | null = null
      try { bankModelPath(lockedBank, safetensorsRecipe) } catch (error) { dirErr = error as NodeJS.ErrnoException } finally { chmodSync(lockedBank, 0o700) }
      check('bank-isDirectory-eacces: unsearchable explicit bank folder throws EACCES in bankModelPath', dirErr?.code === 'EACCES', String(dirErr))

      const noListBank = join(scratch, 'bank-nolist')
      mkdirSync(noListBank, { recursive: true })
      chmodSync(noListBank, 0o111)
      let readdirErr: NodeJS.ErrnoException | null = null
      try { bankModelPath(noListBank, safetensorsRecipe) } catch (error) { readdirErr = error as NodeJS.ErrnoException } finally { chmodSync(noListBank, 0o700) }
      check('bank-readdir-eacces: unreadable bank folder throws EACCES instead of returning canonical path', readdirErr?.code === 'EACCES', String(readdirErr))

      const fileBank = join(scratch, 'bank-filesize')
      const ggufRecipe = { ...HOST_RECIPES[0]!, id: 'fn12-gguf', model: 'fn12/gguf-model', weightFile: 'sub/weights.gguf', weightManifest: undefined, include: undefined }
      const modelDir = join(fileBank, 'fn12--gguf-model')
      const subDir = join(modelDir, 'sub')
      mkdirSync(subDir, { recursive: true })
      writeFileSync(join(subDir, 'weights.gguf'), 'data')
      writeFileSync(join(modelDir, 'SHA256SUMS'), 'a'.repeat(64) + '  sub/weights.gguf\n')
      chmodSync(subDir, 0o000)
      let stateErr: NodeJS.ErrnoException | null = null
      try { bankState(ggufRecipe, fileBank) } catch (error) { stateErr = error as NodeJS.ErrnoException }
      let verifyErr: NodeJS.ErrnoException | null = null
      try { await verifyBank(ggufRecipe, fileBank, new AbortController().signal) } catch (error) { verifyErr = error as NodeJS.ErrnoException }
      finally { chmodSync(subDir, 0o700) }
      check('bank-fileSize-eacces: unsearchable weight subdir throws EACCES in bankState and verifyBank instead of missing', stateErr?.code === 'EACCES' && verifyErr?.code === 'EACCES', JSON.stringify({ state: stateErr?.code ?? stateErr?.message, verify: verifyErr?.code ?? verifyErr?.message }))

      const sumsPath = join(modelDir, 'SHA256SUMS')
      chmodSync(sumsPath, 0o000)
      let sealErr: NodeJS.ErrnoException | null = null
      try { await sealBank(ggufRecipe, fileBank, new AbortController().signal) } catch (error) { sealErr = error as NodeJS.ErrnoException }
      finally { chmodSync(sumsPath, 0o644) }
      check('bank-seal-sums-eacces: unreadable SHA256SUMS throws EACCES in sealBank instead of clearing prior entries', sealErr?.code === 'EACCES', String(sealErr))
    }
  }
}

try {
  await run()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
