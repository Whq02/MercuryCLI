#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = join(import.meta.dir, '../../src')

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn32-')))
const CFG = join(SCRATCH, 'cfg')
mkdirSync(CFG, { recursive: true })
process.on('exit', () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {}
})

process.env.MERCURY_CONFIG_DIR = CFG
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

{
  const { assessDeployedAssets } = await import('../../src/platform/health/healthDeployedAssets.ts')
  const label = 'healthDeployedAssets: unreadable deployed file throws instead of reporting drift'
  if (!POSIX_MODES) skip(label, 'needs non-root POSIX chmod')
  else {
    const repo = join(SCRATCH, 'hda-repo')
    const home = join(SCRATCH, 'hda-home')
    mkdirSync(join(repo, 'scripts', 'ops'), { recursive: true })
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(join(repo, 'scripts/ops/launcher-mercury.sh'), '#!/bin/sh\necho ok\n')
    const deployed = join(home, 'bin/mercury')
    writeFileSync(deployed, '#!/bin/sh\necho ok\n')
    chmodSync(deployed, 0o000)
    let threw: unknown = null
    try {
      assessDeployedAssets(repo, home)
    } catch (error) {
      threw = error
    } finally {
      chmodSync(deployed, 0o600)
    }
    check(label, threw !== null && (threw as NodeJS.ErrnoException).code === 'EACCES', String(threw))
  }
}

{
  const fsOps = await import('../../src/platform/files/fsOperations.ts')
  const { detectManagedSettingsWarnings, managedPolicyPath, managedPolicyPresent } = await import('../../src/platform/health/healthDiagnostic.ts')
  const real = fsOps.getFsImplementation()
  const policyPath = managedPolicyPath()
  try {
    fsOps.setFsImplementation({
      ...real,
      existsSync: ((p: string) => {
        if (p === policyPath) throw new Error('fs probe bug')
        return real.existsSync(p)
      }) as never,
    } as never)
    let threw: unknown = null
    try {
      managedPolicyPresent()
    } catch (error) {
      threw = error
    }
    check('healthDiagnostic: managedPolicyPresent lets unexpected fs error throw instead of returning false', threw instanceof Error && threw.message === 'fs probe bug', String(threw))

    fsOps.setFsImplementation({
      ...real,
      readFileSync: ((p: string, opts?: unknown) => (p === policyPath ? '{bad json' : (real.readFileSync as (a: string, b?: unknown) => unknown)(p, opts))) as never,
    } as never)
    let parseThrew: unknown = null
    try {
      detectManagedSettingsWarnings()
    } catch (error) {
      parseThrew = error
    }
    check('healthDiagnostic: detectManagedSettingsWarnings throws on invalid JSON instead of returning no warnings', parseThrew instanceof SyntaxError, String(parseThrew))
  } finally {
    fsOps.setFsImplementation(real)
  }
}

{
  const { gateVerdictPath } = await import('../../src/platform/health/healthReport.ts')
  const { _resetBootPreflightForTesting, runAndRecordPreflight } = await import('../../src/platform/health/healthPreflight.ts')
  const prevState = process.env.MERCURY_HEALTH_STATE_DIR
  const stateDir = join(SCRATCH, 'hp-state')
  mkdirSync(stateDir, { recursive: true })
  process.env.MERCURY_HEALTH_STATE_DIR = stateDir
  try {
    const verdictFile = gateVerdictPath()
    mkdirSync(join(verdictFile, '..'), { recursive: true })
    writeFileSync(verdictFile, '{broken json')
    _resetBootPreflightForTesting()
    const summary = await runAndRecordPreflight()
    const gate = summary.degraded.find(d => d.id === 'gate')
    check('healthPreflight: corrupt gate verdict yields unknown instead of no-verdict info', gate?.status === 'unknown', JSON.stringify(summary.degraded))
  } finally {
    _resetBootPreflightForTesting()
    if (prevState === undefined) delete process.env.MERCURY_HEALTH_STATE_DIR
    else process.env.MERCURY_HEALTH_STATE_DIR = prevState
  }
}

function runIsolated(code: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const subCfg = join(SCRATCH, `sub-${Math.random().toString(36).slice(2)}`)
  mkdirSync(subCfg, { recursive: true })
  const body = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(subCfg)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const out = {}
    ${code}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', body], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: subCfg, MERCURY_HOME: '', ...extraEnv } })
  if (res.status !== 0) throw new Error(`isolated probe failed: ${res.stderr.slice(-800)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

{
  const { homeRepositoryCheck } = await import('../../src/platform/health/healthReport.ts')
  if (!POSIX_MODES) {
    skip('healthReport: unreadable home dir throws in homeRepositoryCheck', 'needs non-root POSIX chmod')
    skip('healthReport: unreadable user folder throws on .git stat in homeRepositoryCheck', 'needs non-root POSIX chmod')
  } else {
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    const fakeHome = join(SCRATCH, 'hr-home-unreadable')
    mkdirSync(fakeHome, { recursive: true })
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    chmodSync(fakeHome, 0o000)
    let threwHome: unknown = null
    try {
      await homeRepositoryCheck()
    } catch (error) {
      threwHome = error
    } finally {
      chmodSync(fakeHome, 0o700)
    }
    check('healthReport: unreadable home dir throws in homeRepositoryCheck', threwHome !== null && (threwHome as NodeJS.ErrnoException).code === 'EACCES', String(threwHome))

    const fakeHome2 = join(SCRATCH, 'hr-home-desktop-unreadable')
    const desktop = join(fakeHome2, 'Desktop')
    mkdirSync(desktop, { recursive: true })
    process.env.HOME = fakeHome2
    process.env.USERPROFILE = fakeHome2
    chmodSync(desktop, 0o000)
    let threwGit: unknown = null
    try {
      await homeRepositoryCheck()
    } catch (error) {
      threwGit = error
    } finally {
      chmodSync(desktop, 0o700)
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevProfile
    }
    check('healthReport: unreadable user folder throws on .git stat in homeRepositoryCheck', threwGit !== null && (threwGit as NodeJS.ErrnoException).code === 'EACCES', String(threwGit))
  }

  const rDefault = runIsolated(`
    const { mock } = await import('bun:test')
    mock.module(${JSON.stringify(join(SRC, 'models/catalogue/engineModel.ts'))}, () => ({ getUserSpecifiedModelSetting: () => { throw new Error('routing boom') } }))
    const { unresolvedDefaultRow } = await import(${JSON.stringify(join(SRC, 'platform/health/healthReport.ts'))})
    try {
      out.val = unresolvedDefaultRow()
    } catch (e) {
      out.err = e instanceof Error ? e.message : String(e)
    }
  `)
  check('healthReport: unresolvedDefaultRow lets routing bugs throw instead of returning null', rDefault.err === 'routing boom', JSON.stringify(rDefault))

  const rTf = runIsolated(`
    const { mock } = await import('bun:test')
    mock.module(${JSON.stringify(join(SRC, 'models/roads/local/tensorfoldHealth.ts'))}, () => ({
      TENSORFOLD_HEALTH_LABEL: 'TensorFold',
      TENSORFOLD_SUPPORT_LABEL: 'support',
      HELPER_HEALTH_LABEL: 'Helper model',
      readTensorFoldHealth: async () => { throw new Error('tf read boom') },
    }))
    const { tensorFoldHealthChecks } = await import(${JSON.stringify(join(SRC, 'platform/health/healthReport.ts'))})
    const specs = await tensorFoldHealthChecks()
    out.count = specs.length
    out.id = specs[0]?.id ?? null
    if (specs[0]) {
      try {
        await specs[0].run()
      } catch (e) {
        out.runErr = e instanceof Error ? e.message : String(e)
      }
    }
  `)
  check('healthReport: tensorFoldHealthChecks returns failing check spec instead of empty list', rTf.count === 1 && rTf.id === 'tensorfold' && rTf.runErr === 'tf read boom', JSON.stringify(rTf))

  const rSkills = runIsolated(`
    const { mock } = await import('bun:test')
    mock.module(${JSON.stringify(join(SRC, 'integrations/skills/loadSkillsDir.ts'))}, () => ({
      getSkillDirCommands: async () => { throw new Error('skills boom') },
      getSkillLoadRefusals: () => [],
    }))
    const { skillsRefusedEvidence } = await import(${JSON.stringify(join(SRC, 'platform/health/healthReport.ts'))})
    try {
      out.val = await skillsRefusedEvidence('/tmp')
    } catch (e) {
      out.err = e instanceof Error ? e.message : String(e)
    }
  `)
  check('healthReport: skillsRefusedEvidence rejects when skill loading fails instead of reporting all loaded', rSkills.err === 'skills boom', JSON.stringify(rSkills))
}

{
  const label = 'imagePaste: getImageFromClipboard rejects when artifact dir cannot be created instead of returning null'
  if (!POSIX_MODES) skip(label, 'needs non-root POSIX chmod')
  else {
    const fixture = join(SCRATCH, 'clip.png')
    const roTmp = join(SCRATCH, 'clip-ro-tmp')
    writeFileSync(fixture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    mkdirSync(roTmp, { recursive: true })
    chmodSync(roTmp, 0o500)
    try {
      const r = runIsolated(`
        const { getImageFromClipboard } = await import(${JSON.stringify(join(SRC, 'screen/composer/imagePaste.ts'))})
        try {
          out.val = await getImageFromClipboard()
        } catch (e) {
          out.code = e && typeof e === 'object' ? e.code : null
        }
      `, { MERCURY_CLIPBOARD_IMAGE_FILE: fixture, MERCURY_TMPDIR: roTmp })
      check(label, r.code === 'EACCES', JSON.stringify(r))
    } finally {
      chmodSync(roTmp, 0o700)
    }
  }
}

{
  const rReaddir = runIsolated(`
    const fs = await import('node:fs')
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const cacheDir = path.join(process.env.MERCURY_CONFIG_DIR, 'image-cache', 'other-session-readdir')
    fs.mkdirSync(cacheDir, { recursive: true })
    const old = new Date(Date.now() - 86400_000 * 10)
    fs.utimesSync(cacheDir, old, old)
    const realReaddir = fsp.readdir
    mock.module('node:fs/promises', () => ({
      ...fsp,
      readdir: async (p, ...rest) => {
        if (p === cacheDir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return realReaddir(p, ...rest)
      },
    }))
    const { cleanupOldImageCaches } = await import(${JSON.stringify(join(SRC, 'platform/images/imageStore.ts'))})
    await cleanupOldImageCaches(new Date(Date.now() - 86400_000))
    out.stillExists = fs.existsSync(cacheDir)
  `)
  check('imageStore: cleanupOldImageCaches keeps cache dir when readdir fails in newestMtime', rReaddir.stillExists === true, JSON.stringify(rReaddir))

  const rStat = runIsolated(`
    const fs = await import('node:fs')
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const cacheDir = path.join(process.env.MERCURY_CONFIG_DIR, 'image-cache', 'other-session-stat')
    const child = path.join(cacheDir, '1.png')
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(child, 'abc')
    const old = new Date(Date.now() - 86400_000 * 10)
    fs.utimesSync(cacheDir, old, old)
    const realStat = fsp.stat
    mock.module('node:fs/promises', () => ({
      ...fsp,
      stat: async (p, ...rest) => {
        if (p === child) throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return realStat(p, ...rest)
      },
    }))
    const { cleanupOldImageCaches } = await import(${JSON.stringify(join(SRC, 'platform/images/imageStore.ts'))})
    await cleanupOldImageCaches(new Date(Date.now() - 86400_000))
    out.stillExists = fs.existsSync(cacheDir)
  `)
  check('imageStore: cleanupOldImageCaches keeps cache dir when child stat fails in newestMtime', rStat.stillExists === true, JSON.stringify(rStat))
}

{
  const { addItemToJSONCArray } = await import('../../src/platform/storage/json.ts')
  let calls = 0
  const item = {
    toJSON() {
      calls++
      if (calls > 1) throw new Error('serialize boom')
      return { ok: true }
    },
  }
  let threw: unknown = null
  try {
    addItemToJSONCArray('[{"keep": 1}]', item)
  } catch (error) {
    threw = error
  }
  check('json: addItemToJSONCArray rethrows edit error instead of wiping array to single item', threw instanceof Error && threw.message === 'serialize boom', String(threw))
}

{
  const { classifyHarnessHome } = await import('../../src/platform/environment/knownAgentClis.ts')
  if (!POSIX_MODES) {
    skip('knownAgentClis: unreadable daemon log rejects instead of reporting clean', 'needs non-root POSIX chmod')
    skip('knownAgentClis: unreadable daemon roster rejects instead of reporting clean', 'needs non-root POSIX chmod')
    skip('knownAgentClis: unreadable daemon record rejects instead of reporting clean', 'needs non-root POSIX chmod')
  } else {
    for (const [tag, rel, label] of [
      ['log', 'daemon/daemon.log', 'knownAgentClis: unreadable daemon log rejects instead of reporting clean'],
      ['roster', 'daemon/roster.json', 'knownAgentClis: unreadable daemon roster rejects instead of reporting clean'],
      ['record', 'daemon/daemon.json', 'knownAgentClis: unreadable daemon record rejects instead of reporting clean'],
    ] as const) {
      const home = join(SCRATCH, `kac-${tag}`)
      mkdirSync(join(home, 'daemon'), { recursive: true })
      const target = join(home, rel)
      writeFileSync(target, 'foreign')
      chmodSync(target, 0o000)
      let threw: unknown = null
      try {
        await classifyHarnessHome(home)
      } catch (error) {
        threw = error
      } finally {
        chmodSync(target, 0o600)
      }
      check(label, threw !== null && (threw as NodeJS.ErrnoException).code === 'EACCES', String(threw))
    }
  }
}

{
  const rRoot = runIsolated(`
    const fs = await import('node:fs')
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const projectsRoot = path.join(process.env.MERCURY_CONFIG_DIR, 'projects')
    fs.mkdirSync(projectsRoot, { recursive: true })
    const realReaddir = fsp.readdir
    mock.module('node:fs/promises', () => ({
      ...fsp,
      readdir: async (p, ...rest) => {
        if (p === projectsRoot) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return realReaddir(p, ...rest)
      },
    }))
    const { listSessionsImpl } = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/listSessions.ts'))})
    try {
      out.val = await listSessionsImpl({ limit: 50 })
    } catch (e) {
      out.code = e && typeof e === 'object' ? e.code : null
    }
  `)
  check('listSessionsImpl: unreadable projects root rejects instead of returning empty list', rRoot.code === 'EACCES', JSON.stringify(rRoot))

  const rEntry = runIsolated(`
    const fs = await import('node:fs')
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const proj = path.join(process.env.MERCURY_CONFIG_DIR, 'projects', 'proj-a')
    fs.mkdirSync(proj, { recursive: true })
    const realStat = fsp.stat
    mock.module('node:fs/promises', () => ({
      ...fsp,
      stat: async (p, ...rest) => {
        if (p === proj) throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return realStat(p, ...rest)
      },
    }))
    const { listSessionsImpl } = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/listSessions.ts'))})
    try {
      out.val = await listSessionsImpl({ limit: 50 })
    } catch (e) {
      out.code = e && typeof e === 'object' ? e.code : null
    }
  `)
  check('listSessionsImpl: project stat EIO rejects instead of silently dropping project', rEntry.code === 'EIO', JSON.stringify(rEntry))
}

{
  const rMcp = runIsolated(`
    const { mock } = await import('bun:test')
    const te = await import(${JSON.stringify(join(SRC, 'models/facts/tokenEstimation.ts'))})
    mock.module(${JSON.stringify(join(SRC, 'models/facts/tokenEstimation.ts'))}, () => ({
      ...te,
      countMessagesTokensWithAPI: async () => { throw new Error('token count api down') },
    }))
    const { mcpContentNeedsTruncation } = await import(${JSON.stringify(join(SRC, 'integrations/mcp/mcpOutputTruncation.ts'))})
    const huge = 'x'.repeat(200_000)
    out.needs = await mcpContentNeedsTruncation(huge)
  `)
  check('mcpValidation: mcpContentNeedsTruncation fails closed using local estimate when API count throws', rMcp.needs === true, JSON.stringify(rMcp))
}

{
  const rWs = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const fakeHome = path.join(process.env.MERCURY_CONFIG_DIR, 'hr-ws-home')
    fs.mkdirSync(path.join(fakeHome, '.git', 'objects'), { recursive: true })
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    const blockedWs = path.join(fakeHome, 'blocked-ws')
    mock.module(${JSON.stringify(join(SRC, 'daemon/concourse-workers/concourseWorkers.ts'))}, () => ({
      readSessionWorkers: () => ({ r1: { runnerId: 'r1', workspaceId: blockedWs, pid: process.pid } }),
    }))
    const realRealpathSync = fs.realpathSync
    mock.module('node:fs', () => ({
      ...fs,
      realpathSync: (p, ...rest) => {
        if (p === blockedWs) throw Object.assign(new Error('permission denied on ws'), { code: 'EACCES' })
        return realRealpathSync(p, ...rest)
      },
    }))
    const { homeRepositoryCheck } = await import(${JSON.stringify(join(SRC, 'platform/health/healthReport.ts'))})
    out.res = await homeRepositoryCheck()
  `)
  const evWs = String((rWs.res as { evidence?: string })?.evidence ?? '')
  check(
    'healthReport: homeRepositoryCheck reports unreadable live session workspace instead of no Mercury process holds it',
    evWs.includes('could not check whether Mercury holds it now') && evWs.includes('permission denied on ws') && !evWs.includes('no Mercury process holds it now'),
    evWs,
  )

  const rWorkers = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const fakeHome = path.join(process.env.MERCURY_CONFIG_DIR, 'hr-workers-home')
    fs.mkdirSync(path.join(fakeHome, '.git', 'objects'), { recursive: true })
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    mock.module(${JSON.stringify(join(SRC, 'daemon/concourse-workers/concourseWorkers.ts'))}, () => ({
      readSessionWorkers: () => { throw new Error('workers file corrupt') },
    }))
    const { homeRepositoryCheck } = await import(${JSON.stringify(join(SRC, 'platform/health/healthReport.ts'))})
    out.res = await homeRepositoryCheck()
  `)
  const evWorkers = String((rWorkers.res as { evidence?: string })?.evidence ?? '')
  check(
    'healthReport: homeRepositoryCheck reports readSessionWorkers failure instead of no Mercury process holds it',
    evWorkers.includes('could not check whether Mercury holds it now') && evWorkers.includes('workers file corrupt') && !evWorkers.includes('no Mercury process holds it now'),
    evWorkers,
  )

  const rLock = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const fakeHome = path.join(process.env.MERCURY_CONFIG_DIR, 'hr-lock-home')
    fs.mkdirSync(path.join(fakeHome, '.git', 'objects'), { recursive: true })
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    const lockPath = path.join(fakeHome, '.git', 'index.lock')
    const realStatSync = fs.statSync
    mock.module('node:fs', () => ({
      ...fs,
      statSync: (p, ...rest) => {
        if (p === lockPath) throw Object.assign(new Error('lock stat denied'), { code: 'EACCES' })
        return realStatSync(p, ...rest)
      },
    }))
    const { homeRepositoryCheck } = await import(${JSON.stringify(join(SRC, 'platform/health/healthReport.ts'))})
    out.res = await homeRepositoryCheck()
  `)
  const evLock = String((rLock.res as { evidence?: string })?.evidence ?? '')
  check(
    'healthReport: homeRepositoryCheck reports unreadable .git/index.lock instead of no Mercury process holds it',
    evLock.includes('could not check whether Mercury holds it now') && evLock.includes('lock stat denied') && !evLock.includes('no Mercury process holds it now'),
    evLock,
  )

  const rObj = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const fakeHome = path.join(process.env.MERCURY_CONFIG_DIR, 'hr-obj-home')
    const objectsDir = path.join(fakeHome, '.git', 'objects')
    fs.mkdirSync(objectsDir, { recursive: true })
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    const realReaddirSync = fs.readdirSync
    mock.module('node:fs', () => ({
      ...fs,
      readdirSync: (p, ...rest) => {
        if (p === objectsDir) throw Object.assign(new Error('objects dir denied'), { code: 'EACCES' })
        return realReaddirSync(p, ...rest)
      },
    }))
    const { homeRepositoryCheck } = await import(${JSON.stringify(join(SRC, 'platform/health/healthReport.ts'))})
    out.res = await homeRepositoryCheck()
  `)
  const evObj = String((rObj.res as { evidence?: string })?.evidence ?? '')
  check(
    'healthReport: homeRepositoryCheck reports unreadable .git/objects instead of no Mercury process holds it',
    evObj.includes('could not check whether Mercury holds it now') && evObj.includes('objects dir denied') && !evObj.includes('no Mercury process holds it now'),
    evObj,
  )

  const rEstate = runIsolated(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cp = await import('node:child_process')
    const { mock } = await import('bun:test')
    const repo = path.join(process.env.MERCURY_CONFIG_DIR, 'hr-estate-repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.mercury', 'health'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.mercury', 'health', 'last-cert.json'), '{}')
    process.env.MERCURY_HEALTH_STATE_DIR = repo
    const realExecFile = cp.execFile
    mock.module('node:child_process', () => ({
      ...cp,
      execFile: (cmd, args, opts, cb) => {
        if (cmd === 'git' && Array.isArray(args) && args[0] === 'ls-files') {
          const done = typeof opts === 'function' ? opts : cb
          done(new Error('git ls-files timed out'), '', '')
          return {}
        }
        return realExecFile(cmd, args, opts, cb)
      },
    }))
    const { projectEstateCheck } = await import(${JSON.stringify(join(SRC, 'platform/health/healthReport.ts'))})
    out.res = await projectEstateCheck()
  `)
  const fixEstate = String((rEstate.res as { fix?: string })?.fix ?? '')
  check(
    'healthReport: projectEstateCheck reports git ls-files failure instead of claiming folders are not tracked by git',
    fixEstate.includes('could not check whether git tracks them') && fixEstate.includes('git ls-files timed out') && !fixEstate.includes('they are not tracked by git'),
    fixEstate,
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
