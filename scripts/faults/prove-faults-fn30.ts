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
} finally {
  for (const fn of cleanupTasks.reverse()) fn()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
