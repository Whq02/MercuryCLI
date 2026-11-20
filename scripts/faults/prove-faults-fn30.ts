#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn30-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.XDG_CACHE_HOME = join(scratch, 'cache')
process.env.LOCALAPPDATA = join(scratch, 'cache')
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME

const cleanupTasks: Array<() => void> = []

try {
  {
    const crashReport = await import('../../src/utils/crashReport.js')
    const dir = crashReport.crashReportDir()
    check('crashReport.listCrashReports absent dir returns empty', crashReport.listCrashReports().length === 0)
    check('crashReport.unnoticedCrashReports absent dir returns empty', crashReport.unnoticedCrashReports().length === 0)
    if (!POSIX_MODES) {
      skip('crashReport.listCrashReports unreadable dir', 'needs non-root POSIX')
      skip('crashReport.unnoticedCrashReports unreadable dir', 'needs non-root POSIX')
    } else {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'crash-1-app-root.json'), JSON.stringify({ origin: 'app-root', at: '2026-11-20T00:00:00.000Z', message: 'boom' }))
      chmodSync(dir, 0o000)
      cleanupTasks.push(() => { try { chmodSync(dir, 0o700) } catch {} })
      let listed: unknown[] = []
      let listCode: string | null = null
      try {
        listed = crashReport.listCrashReports()
      } catch (err) {
        listCode = (err as NodeJS.ErrnoException | null)?.code ?? 'THREW'
      }
      let unnoticedCode: string | null = null
      try {
        crashReport.unnoticedCrashReports()
      } catch (err) {
        unnoticedCode = (err as NodeJS.ErrnoException | null)?.code ?? 'THREW'
      }
      chmodSync(dir, 0o700)
      check('crashReport.listCrashReports unreadable dir keeps empty answer', listCode === null && listed.length === 0, `code=${String(listCode)} len=${listed.length}`)
      check('crashReport.unnoticedCrashReports unreadable dir throws EACCES', unnoticedCode === 'EACCES', `got ${String(unnoticedCode)}`)
    }
  }

  {
    const extPkg = await import('../../src/utils/editorExtensionPackage.js')
    check('editorExtensionPackage absent home returns empty', extPkg.installedEditorExtensions(join(scratch, 'no-such-home')).length === 0)
    if (!POSIX_MODES) {
      skip('editorExtensionPackage unreadable extensions dir', 'needs non-root POSIX')
    } else {
      const edHome = join(scratch, 'editor-home')
      const extDir = join(edHome, '.vscode', 'extensions')
      mkdirSync(extDir, { recursive: true })
      chmodSync(extDir, 0o000)
      cleanupTasks.push(() => { try { chmodSync(extDir, 0o700) } catch {} })
      let code: string | null = null
      try {
        extPkg.installedEditorExtensions(edHome)
      } catch (err) {
        code = (err as NodeJS.ErrnoException | null)?.code ?? 'THREW'
      }
      chmodSync(extDir, 0o700)
      check('editorExtensionPackage unreadable extensions dir throws EACCES', code === 'EACCES', `got ${String(code)}`)
    }
  }

  {
    const envUtils = await import('../../src/utils/envUtils.js')
    if (!POSIX_MODES) {
      skip('envUtils.ensurePrivateConfigHome unreadable parent throws', 'needs non-root POSIX')
    } else {
      const lockedParent = join(scratch, 'locked-parent')
      const blockedHome = join(lockedParent, 'mercury-home')
      mkdirSync(lockedParent, { recursive: true })
      chmodSync(lockedParent, 0o000)
      cleanupTasks.push(() => { try { chmodSync(lockedParent, 0o700) } catch {} })
      const prevDir = process.env.MERCURY_CONFIG_DIR
      process.env.MERCURY_CONFIG_DIR = blockedHome
      let code: string | null = null
      try {
        envUtils.ensurePrivateConfigHome()
      } catch (err) {
        code = (err as NodeJS.ErrnoException | null)?.code ?? 'THREW'
      } finally {
        process.env.MERCURY_CONFIG_DIR = prevDir
        chmodSync(lockedParent, 0o700)
      }
      check('envUtils.ensurePrivateConfigHome unreadable parent throws EACCES', code === 'EACCES', `got ${String(code)}`)
    }
  }
  {
    const errorLogSink = await import('../../src/utils/errorLogSink.js')
    const logMod = await import('../../src/utils/log.js')
    const fsOps = await import('../../src/utils/fsOperations.js')
    errorLogSink.initializeErrorLogSink()
    errorLogSink.resetErrorLogSinkForTest()
    const baseFs = fsOps.getFsImplementation()
    let appendCalls = 0
    fsOps.setFsImplementation({
      ...baseFs,
      statSync: () => {
        throw Object.assign(new Error('EIO stat failed'), { code: 'EIO' })
      },
      appendFileSync: () => {
        appendCalls++
      },
    })
    try {
      logMod.logMCPError('fault-probe-server', new Error('ceiling-check'))
      errorLogSink.resetErrorLogSinkForTest()
    } finally {
      fsOps.setOriginalFsImplementation()
      errorLogSink.resetErrorLogSinkForTest()
    }
    check('errorLogSink non-ENOENT stat failure closes path instead of writing', appendCalls === 0, `appendCalls=${appendCalls}`)
  }
  {
    const fileMod = await import('../../src/utils/file.js')
    const presentFile = join(scratch, 'present.txt')
    writeFileSync(presentFile, 'hello\n')
    const presentMtime = await fileMod.getFileModificationTimeAsync(presentFile)
    check('file.getFileModificationTimeAsync readable file returns positive mtime', presentMtime > 0, `got ${presentMtime}`)
    let missingCode: string | null = null
    try {
      await fileMod.getFileModificationTimeAsync(join(scratch, 'absent.txt'))
    } catch (err) {
      missingCode = (err as NodeJS.ErrnoException | null)?.code ?? 'THREW'
    }
    check('file.getFileModificationTimeAsync absent file throws ENOENT', missingCode === 'ENOENT', `got ${String(missingCode)}`)
    if (!POSIX_MODES) {
      skip('file.getFileModificationTimeAsync unreadable parent throws EACCES', 'needs non-root POSIX')
    } else {
      const noAccessDir = join(scratch, 'no-access-mtime')
      const hiddenFile = join(noAccessDir, 'file.txt')
      mkdirSync(noAccessDir, { recursive: true })
      writeFileSync(hiddenFile, 'secret\n')
      chmodSync(noAccessDir, 0o000)
      cleanupTasks.push(() => { try { chmodSync(noAccessDir, 0o700) } catch {} })
      let accessCode: string | null = null
      try {
        await fileMod.getFileModificationTimeAsync(hiddenFile)
      } catch (err) {
        accessCode = (err as NodeJS.ErrnoException | null)?.code ?? 'THREW'
      } finally {
        chmodSync(noAccessDir, 0o700)
      }
      check('file.getFileModificationTimeAsync unreadable parent throws EACCES', accessCode === 'EACCES', `got ${String(accessCode)}`)
    }
    const symDir = join(scratch, 'sym-clobber')
    mkdirSync(symDir, { recursive: true })
    const targetFile = join(symDir, 'target.txt')
    const linkFile = join(symDir, 'link.txt')
    writeFileSync(targetFile, 'original-target')
    const fsReal = await import('node:fs')
    fsReal.symlinkSync(targetFile, linkFile)
    const childCode = `
      const { mock } = await import('bun:test')
      const realFs = await import('node:fs')
      mock.module('node:fs', () => ({
        ...realFs,
        readlinkSync: () => { throw Object.assign(new Error('EIO readlink'), { code: 'EIO' }) },
      }))
      const fileMod = await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/file.ts'))})
      let code = null
      try {
        fileMod.writeFileAndFlushAtomically(${JSON.stringify(linkFile)}, 'replaced')
      } catch (err) {
        code = err?.code ?? 'THREW'
      }
      const stillLink = realFs.lstatSync(${JSON.stringify(linkFile)}).isSymbolicLink()
      const targetText = realFs.readFileSync(${JSON.stringify(targetFile)}, 'utf8')
      process.stdout.write(JSON.stringify({ code, stillLink, targetText }))
    `
    const sub = Bun.spawnSync([process.execPath, '-e', childCode], {
      env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const symResult = sub.exitCode === 0 ? JSON.parse(sub.stdout.toString('utf8').trim()) as { code: string | null; stillLink: boolean; targetText: string } : null
    check('file.writeFileAndFlushAtomically readlink EIO refuses and keeps symlink intact', symResult !== null && symResult.code === 'EIO' && symResult.stillLink === true && symResult.targetText === 'original-target', JSON.stringify(symResult ?? sub.stderr.toString('utf8').slice(-300)))
  }
} finally {
  for (const fn of cleanupTasks.reverse()) fn()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
