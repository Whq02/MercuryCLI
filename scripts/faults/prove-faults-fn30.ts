#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
const AREA_FIX_HINTS: Record<string, string> = {
  crashReport: 'fix listCrashReports or unnoticedCrashReports in src/platform/logs/crashReport.ts so an unreadable report dir is answered as the check expects',
  editorExtensionPackage: 'fix installedEditorExtensions in src/commands/verbs/editorExtensionPackage.ts so an unreadable extensions dir throws',
  envUtils: 'fix ensurePrivateConfigHome in src/platform/environment/envUtils.ts so an unreadable parent throws',
  errorLogSink: 'fix the error log writer in src/platform/logs/errorLogSink.ts so a failed stat does not stop the line being appended',
  file: 'fix getFileModificationTimeAsync or writeFileAndFlushAtomically in src/platform/files/file.ts',
  fileHistory: 'fix fileHistoryRestore in src/tools/engines/change-transaction/fileHistory.ts so a failed stat refuses the restore with kind restore-failed',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = AREA_FIX_HINTS[label.split(/[.: ]/)[0] ?? '']
  const shown = !cond ? [detail, hint].filter(Boolean).join(' | ') : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
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
    const crashReport = await import('../../src/platform/logs/crashReport.js')
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
    const extPkg = await import('../../src/commands/verbs/editorExtensionPackage.js')
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
    const envUtils = await import('../../src/platform/environment/envUtils.js')
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
    const errorLogSink = await import('../../src/platform/logs/errorLogSink.js')
    const logMod = await import('../../src/platform/logs/errorLog.js')
    const fsOps = await import('../../src/platform/files/fsOperations.js')
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
    check('errorLogSink: a stat that fails does not close the error log; the line is written, as before', appendCalls > 0, `appendCalls=${appendCalls}`)
  }
  {
    const fileMod = await import('../../src/platform/files/file.js')
    const presentFile = join(scratch, 'present.txt')
    writeFileSync(presentFile, 'hello\n')
    const presentMtime = await fileMod.getFileModificationTimeAsync(presentFile)
    check('file.getFileModificationTimeAsync readable file returns positive mtime', presentMtime > 0, `got ${presentMtime}`)
    const absentMtime = await fileMod.getFileModificationTimeAsync(join(scratch, 'absent.txt'))
    check('file.getFileModificationTimeAsync absent file returns 0', absentMtime === 0, `got ${absentMtime}`)
    const symDir = join(scratch, 'sym-clobber')
    mkdirSync(symDir, { recursive: true })
    const targetFile = join(symDir, 'target.txt')
    const linkFile = join(symDir, 'link.txt')
    writeFileSync(targetFile, 'original-target')
    const fsReal = await import('node:fs')
    let symCreated = true
    try {
      fsReal.symlinkSync(targetFile, linkFile)
    } catch (err) {
      if (process.platform === 'win32' && (err as NodeJS.ErrnoException | null)?.code === 'EPERM') {
        symCreated = false
      } else {
        throw err
      }
    }
    if (!symCreated) {
      skip('file.writeFileAndFlushAtomically readlink EIO refuses and keeps symlink intact', 'not read on Windows: no symlink privilege')
    } else {
      const childCode = `
        const { mock } = await import('bun:test')
        const realFs = await import('node:fs')
        mock.module('node:fs', () => ({
          ...realFs,
          readlinkSync: () => { throw Object.assign(new Error('EIO readlink'), { code: 'EIO' }) },
        }))
        const fileMod = await import(${JSON.stringify(join(HERE, '../../src/platform/files/file.ts'))})
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
  }
  {
    const fhDir = join(scratch, 'fh-stat')
    const fhHome = join(fhDir, 'home')
    const fhCwd = join(fhDir, 'cwd')
    mkdirSync(fhHome, { recursive: true })
    mkdirSync(fhCwd, { recursive: true })
    const fhChild = `
      const { mock } = await import('bun:test')
      const { randomUUID } = await import('node:crypto')
      const fsSync = await import('node:fs')
      const realFsPromises = await import('node:fs/promises')
      const origStat = realFsPromises.stat
      const { join } = await import('node:path')
      let failPath = null
      mock.module('node:fs/promises', () => ({
        ...realFsPromises,
        stat: async (p, opts) => {
          if (failPath !== null && String(p) === failPath) {
            throw Object.assign(new Error('EIO stat ' + failPath), { code: 'EIO' })
          }
          return opts === undefined ? origStat(p) : origStat(p, opts)
        },
      }))
      ;(globalThis).MACRO = { VERSION: '1.0.0' }
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(fhHome)}
      delete process.env.MERCURY_HOME
      delete process.env.NODE_ENV
      const { enableConfigs } = await import(${JSON.stringify(join(HERE, '../../src/platform/config/globalConfig.ts'))})
      enableConfigs()
      const bootstrap = await import(${JSON.stringify(join(HERE, '../../src/boot/process-state/processState.ts'))})
      bootstrap.setIsInteractive(true)
      bootstrap.setOriginalCwd(${JSON.stringify(fhCwd)})
      const fh = await import(${JSON.stringify(join(HERE, '../../src/tools/engines/change-transaction/fileHistory.ts'))})
      const target = join(${JSON.stringify(fhCwd)}, 'secret.txt')
      fsSync.writeFileSync(target, 'after\\n', { mode: 0o600 })
      const backupName = 'aaaaaaaaaaaaaaaa@v1'
      const backupDir = join(${JSON.stringify(fhHome)}, 'file-history', String(bootstrap.getSessionId()))
      fsSync.mkdirSync(backupDir, { recursive: true })
      const blob = join(backupDir, backupName)
      fsSync.writeFileSync(blob, 'before\\n', { mode: 0o600 })
      const m1 = randomUUID()
      const state = {
        snapshots: [{ messageId: m1, timestamp: new Date(), trackedFileBackups: { 'secret.txt': { backupFileName: backupName, version: 1, backupTime: new Date(), sourceSize: 7 } } }],
        trackedFiles: new Set(['secret.txt']),
        snapshotSequence: 1,
      }
      failPath = blob
      const blobRes = await fh.fileHistoryRestore(state, m1, { dryRun: true, ownerKey: 'fn30-blob' })
      failPath = target
      const fileRes = await fh.fileHistoryRestore(state, m1, { dryRun: true, ownerKey: 'fn30-file' })
      failPath = null
      const okRes = await fh.fileHistoryRestore(state, m1, { dryRun: true, ownerKey: 'fn30-ok' })
      process.stdout.write(JSON.stringify({ blobRes, fileRes, okRes }))
    `
    const sub = Bun.spawnSync([process.execPath, '-e', fhChild], {
      env: { ...process.env, MERCURY_CONFIG_DIR: fhHome },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const fhOut = sub.exitCode === 0 ? JSON.parse(sub.stdout.toString('utf8').trim()) as {
      blobRes: { ok: boolean; kind?: string; detail?: string }
      fileRes: { ok: boolean; kind?: string; detail?: string }
      okRes: { ok: boolean }
    } : null
    check('fileHistory.fileHistoryRestore refuses when backup blob stat fails', fhOut !== null && fhOut.blobRes.ok === false && fhOut.blobRes.kind === 'restore-failed' && Boolean(fhOut.blobRes.detail?.includes('EIO stat')), JSON.stringify(fhOut?.blobRes ?? sub.stderr.toString('utf8').slice(-300)))
    check('fileHistory.fileHistoryRestore refuses when target file stat fails', fhOut !== null && fhOut.fileRes.ok === false && fhOut.fileRes.kind === 'restore-failed' && Boolean(fhOut.fileRes.detail?.includes('EIO stat')), JSON.stringify(fhOut?.fileRes ?? sub.stderr.toString('utf8').slice(-300)))
    check('fileHistory.fileHistoryRestore succeeds when stats succeed', fhOut !== null && fhOut.okRes.ok === true, JSON.stringify(fhOut?.okRes ?? null))
  }
} finally {
  for (const fn of cleanupTasks.reverse()) fn()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
