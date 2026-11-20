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
  const { assessDeployedAssets } = await import('../../src/utils/healthDeployedAssets.ts')
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
  const fsOps = await import('../../src/utils/fsOperations.ts')
  const { detectManagedSettingsWarnings, managedPolicyPath, managedPolicyPresent } = await import('../../src/utils/healthDiagnostic.ts')
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
  const { gateVerdictPath } = await import('../../src/utils/healthReport.ts')
  const { _resetBootPreflightForTesting, runAndRecordPreflight } = await import('../../src/utils/healthPreflight.ts')
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
  const { homeRepositoryCheck } = await import('../../src/utils/healthReport.ts')
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
    mock.module(${JSON.stringify(join(SRC, 'utils/model/model.ts'))}, () => ({ getUserSpecifiedModelSetting: () => { throw new Error('routing boom') } }))
    const { unresolvedDefaultRow } = await import(${JSON.stringify(join(SRC, 'utils/healthReport.ts'))})
    try {
      out.val = unresolvedDefaultRow()
    } catch (e) {
      out.err = e instanceof Error ? e.message : String(e)
    }
  `)
  check('healthReport: unresolvedDefaultRow lets routing bugs throw instead of returning null', rDefault.err === 'routing boom', JSON.stringify(rDefault))

  const rTf = runIsolated(`
    const { mock } = await import('bun:test')
    mock.module(${JSON.stringify(join(SRC, 'services/providers/local/tensorfoldHealth.ts'))}, () => ({
      TENSORFOLD_HEALTH_LABEL: 'TensorFold',
      TENSORFOLD_SUPPORT_LABEL: 'support',
      HELPER_HEALTH_LABEL: 'Helper model',
      readTensorFoldHealth: async () => { throw new Error('tf read boom') },
    }))
    const { tensorFoldHealthChecks } = await import(${JSON.stringify(join(SRC, 'utils/healthReport.ts'))})
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
    mock.module(${JSON.stringify(join(SRC, 'skills/loadSkillsDir.ts'))}, () => ({
      getSkillDirCommands: async () => { throw new Error('skills boom') },
      getSkillLoadRefusals: () => [],
    }))
    const { skillsRefusedEvidence } = await import(${JSON.stringify(join(SRC, 'utils/healthReport.ts'))})
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
        const { getImageFromClipboard } = await import(${JSON.stringify(join(SRC, 'utils/imagePaste.ts'))})
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
    const { cleanupOldImageCaches } = await import(${JSON.stringify(join(SRC, 'utils/imageStore.ts'))})
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
    const { cleanupOldImageCaches } = await import(${JSON.stringify(join(SRC, 'utils/imageStore.ts'))})
    await cleanupOldImageCaches(new Date(Date.now() - 86400_000))
    out.stillExists = fs.existsSync(cacheDir)
  `)
  check('imageStore: cleanupOldImageCaches keeps cache dir when child stat fails in newestMtime', rStat.stillExists === true, JSON.stringify(rStat))
}

{
  const { addItemToJSONCArray } = await import('../../src/utils/json.ts')
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

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
