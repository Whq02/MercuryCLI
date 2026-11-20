#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../../src')
const BUN = process.env.BUN ?? (process.execPath.includes('bun') ? process.execPath : 'bun')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSub(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn09-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const SRC = ${JSON.stringify(SRC)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', NODE_ENV: '' },
    })
    if (res.status !== 0) throw new Error(`sub failed (rc=${res.status}): ${res.stderr.slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    try {
      chmodSync(home, 0o700)
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nconcourseEnabled — unreadable global config throws instead of reporting concourse on')
if (!POSIX_MODES) {
  skip('concourseEnabled-unreadable-config', 'needs non-root POSIX chmod')
} else {
  const r = runSub(`
    const envMod = await import(path.join(SRC, 'utils/env.ts'))
    const cfgMod = await import(path.join(SRC, 'utils/config/globalConfig.ts'))
    const concourseMod = await import(path.join(SRC, 'services/concourse/concourseEnabled.ts'))
    out.beforeEnable = concourseMod.concourseEnabled()
    const file = envMod.getGlobalMercuryFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ concourseEnabled: false }), { mode: 0o600 })
    cfgMod.enableConfigs()
    out.whenReadableOff = concourseMod.concourseEnabled()
    cfgMod._setGlobalConfigCacheForTesting(null)
    fs.chmodSync(file, 0o200)
    try {
      out.unreadableValue = concourseMod.concourseEnabled()
      out.threw = null
    } catch (e) {
      out.threw = { name: e?.name ?? null, code: e?.code ?? null, message: String(e?.message ?? e) }
    } finally {
      fs.chmodSync(file, 0o600)
    }
  `)
  const threw = r.threw as { name: string | null; code: string | null; message: string } | null
  check('concourseEnabled-unreadable-config: before enableConfigs stays true and readable false stays false', r.beforeEnable === true && r.whenReadableOff === false, JSON.stringify(r))
  check('concourseEnabled-unreadable-config: unreadable config throws ConfigReadError', threw !== null && threw.name === 'ConfigReadError', JSON.stringify(r))
}

console.log('\nchangeSetPlan — unreadable source and move destination refuse instead of failing open or claiming missing')
if (!POSIX_MODES) {
  skip('changeSetPlan-unreadable-paths', 'needs non-root POSIX chmod')
} else {
  const r = runSub(`
    const { planChangeSet } = await import(path.join(SRC, 'services/changeTransaction/changeSetPlan.ts'))
    const { mintFileAnchor } = await import(path.join(SRC, 'services/changeTransaction/snapshotAnchor.ts'))
    const srcFile = path.join(PROJECT, 'src.txt')
    fs.writeFileSync(srcFile, 'hello\\n')
    const anchor = mintFileAnchor('hello\\n')
    const ctx = {
      ownerKey: 'test-owner',
      exactEdit: () => ({ ok: false, message: 'unused' }),
    }

    const lockedSrcDir = path.join(PROJECT, 'locked-src')
    fs.mkdirSync(lockedSrcDir)
    const lockedSrc = path.join(lockedSrcDir, 'a.txt')
    fs.writeFileSync(lockedSrc, 'hello\\n')
    fs.chmodSync(lockedSrcDir, 0o000)
    try {
      out.lockedSource = planChangeSet([{ file_path: lockedSrc, expected_anchor: anchor, hunks: [{ lines: '1', replace: 'hi' }] }], ctx)
    } finally {
      fs.chmodSync(lockedSrcDir, 0o700)
    }

    const loopA = path.join(PROJECT, 'loopA')
    const loopB = path.join(PROJECT, 'loopB')
    fs.symlinkSync(loopB, loopA)
    fs.symlinkSync(loopA, loopB)
    out.loopDest = planChangeSet([{ file_path: srcFile, expected_anchor: anchor, op: 'move', new_path: path.join(loopA, 'dest.txt') }], ctx)

    const noExecDestDir = path.join(PROJECT, 'no-exec-dest')
    fs.mkdirSync(noExecDestDir)
    const existingDest = path.join(noExecDestDir, 'exists.txt')
    fs.writeFileSync(existingDest, 'precious\\n')
    fs.chmodSync(noExecDestDir, 0o400)
    try {
      out.unstatDest = planChangeSet([{ file_path: srcFile, expected_anchor: anchor, op: 'move', new_path: existingDest }], ctx)
    } finally {
      fs.chmodSync(noExecDestDir, 0o700)
    }

    out.missingDestDir = planChangeSet([{ file_path: srcFile, expected_anchor: anchor, op: 'move', new_path: path.join(PROJECT, 'new-subdir', 'moved.txt') }], ctx)
  `)
  const lockedSource = r.lockedSource as { ok: boolean; code?: string }
  const loopDest = r.loopDest as { ok: boolean; code?: string }
  const unstatDest = r.unstatDest as { ok: boolean; code?: string }
  const missingDestDir = r.missingDestDir as { ok: boolean }
  check('changeSetPlan-canonicalize-eacces: unreadable source directory refuses with io instead of missing', lockedSource.ok === false && lockedSource.code === 'io', JSON.stringify(lockedSource))
  check('changeSetPlan-dest-realpath-eloop: symlink-loop move destination refuses instead of leaving unresolved path', loopDest.ok === false && loopDest.code === 'destination', JSON.stringify(loopDest))
  check('changeSetPlan-dest-lstat-eacces: unreadable destination directory refuses instead of treating destination free', unstatDest.ok === false && unstatDest.code === 'destination', JSON.stringify(unstatDest))
  check('changeSetPlan-dest-enoent-control: missing move destination directory still plans ok', missingDestDir.ok === true, JSON.stringify(missingDestDir))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
