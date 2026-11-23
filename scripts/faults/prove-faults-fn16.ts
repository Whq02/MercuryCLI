#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSub(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn16-')))
  const home = join(scratch, 'home')
  const work = join(scratch, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const SCRATCH = ${JSON.stringify(scratch)}
    const HOME_DIR = ${JSON.stringify(home)}
    const WORK = ${JSON.stringify(work)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_LOCAL_PROBE_TARGETS: 'none', ...extraEnv },
    })
    if (res.status !== 0) throw new Error(`sub failed (${res.status}): ${res.stderr.slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\npaths.ts — a homedir that fails does not stop the estate')
  const r = runSub(`
    const { mock } = await import('bun:test')
    const realOs = await import('node:os')
    mock.module('node:os', () => ({ ...realOs, homedir: () => { throw new Error('homedir unavailable') } }))
    const fs = await import('node:fs')
    const path = await import('node:path')
    const paths = await import(path.join(SRC, 'platform/project-local/paths.ts'))
    const target = path.join(WORK, 'maybe-home')
    fs.mkdirSync(target, { recursive: true })
    let threw = null
    let result = undefined
    try {
      result = paths.initializeProjectLocalEstate(target)
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    out.threw = threw
    out.result = result
    out.created = fs.existsSync(path.join(target, '.mercury'))
  `)
  check(
    'initializeProjectLocalEstate goes on and makes .mercury when the home folder cannot be told, without throwing',
    r.threw === null && (r.result as { created?: boolean } | null)?.created === true && r.created === true,
    JSON.stringify(r),
  )
}

{
  console.log('\nghRelease.ts — a MERCURY_GH_CMD that does not parse is skipped and plain gh runs')
  const r = runSub(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    if (process.platform === 'win32') {
      const { mock } = await import('bun:test')
      const realCp = await import('node:child_process')
      const seen = []
      mock.module('node:child_process', () => ({
        ...realCp,
        execFile: (file, args, _opts, cb) => {
          seen.push({ file, args })
          queueMicrotask(() => cb(null, 'ok\\n', ''))
          return { kill: () => {} }
        },
      }))
      process.env.MERCURY_GH_CMD = '{bad json'
      const ghMod = await import(path.join(SRC, 'platform/update-channel/ghRelease.ts'))
      out.badJson = await ghMod.gh(['--version'])
      process.env.MERCURY_GH_CMD = '[]'
      out.emptyArray = await ghMod.gh(['--version'])
      out.plainRan = seen.length === 2 && seen.every(s => Array.isArray(s.args) && s.args.at(-2) === 'gh' && s.args.at(-1) === '--version')
    } else {
      const binDir = path.join(WORK, 'bin')
      const marker = path.join(WORK, 'plain-gh-ran')
      fs.mkdirSync(binDir, { recursive: true })
      const fakeGh = path.join(binDir, 'gh')
      fs.writeFileSync(fakeGh, '#!/bin/sh\\necho ran > ' + JSON.stringify(marker) + '\\necho ok\\n')
      fs.chmodSync(fakeGh, 0o755)
      process.env.PATH = binDir + ':' + (process.env.PATH ?? '')
      process.env.MERCURY_GH_CMD = '{bad json'
      const ghMod = await import(path.join(SRC, 'platform/update-channel/ghRelease.ts'))
      out.badJson = await ghMod.gh(['--version'])
      process.env.MERCURY_GH_CMD = '[]'
      out.emptyArray = await ghMod.gh(['--version'])
      out.plainRan = fs.existsSync(marker)
    }
  `)
  const badJson = r.badJson as { state?: string; stderr?: string }
  const emptyArray = r.emptyArray as { state?: string; stderr?: string }
  check(
    'an unparsable or empty MERCURY_GH_CMD is skipped: plain gh runs and answers',
    badJson?.state === 'ok' && emptyArray?.state === 'ok' && r.plainRan === true,
    JSON.stringify(r),
  )
}

{
  console.log('\ninstallPath.ts — a zsh that cannot be asked does not stop the PATH line: it goes to the home .zshrc')
  const r = runSub(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const installPath = await import(path.join(SRC, 'platform/update-channel/installPath.ts'))
    const roots = {
      versionsDir: path.join(WORK, 'versions'),
      binDir: path.join(WORK, 'bin'),
      shimPath: path.join(WORK, 'bin', 'mercury'),
      isWindows: false,
    }
    const appended = []
    const io = {
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      home: WORK,
      readFile: () => null,
      appendFile: (p, t) => appended.push({ p, t }),
      writeFile: () => {},
      removeFile: () => {},
      resolveCommand: () => null,
      zshDotDir: () => { throw new Error('zsh probe failed') },
      readUserPath: () => ({ state: 'absent' }),
      writeUserPath: () => {},
    }
    out.ensure = installPath.ensureBinDirOnPath(roots, io)
    out.appended = appended.length

    const fakeBin = path.join(WORK, 'fake-zsh-bin')
    fs.mkdirSync(fakeBin, { recursive: true })
    const fakeZsh = path.join(fakeBin, 'zsh')
    fs.writeFileSync(fakeZsh, '#!/bin/sh\\nexit 2\\n')
    fs.chmodSync(fakeZsh, 0o755)
    process.env.PATH = fakeBin
    const realIo = installPath.realPathEntryIo()
    let realThrew = null
    try {
      realIo.zshDotDir()
    } catch (e) {
      realThrew = e instanceof Error ? e.message : String(e)
    }
    out.realThrew = realThrew
  `)
  const ensure = r.ensure as { state?: string; reason?: string }
  check(
    'ensureBinDirOnPath is not refused when zshDotDir throws: the PATH line is appended once',
    ensure?.state !== 'refused' && r.appended === 1,
    JSON.stringify(r),
  )
  check(
    'realPathEntryIo().zshDotDir does not throw when zsh exits non-zero',
    r.realThrew === null,
    JSON.stringify(r),
  )
}

{
  console.log('\nexecutionProjection.ts — failed service stop settles execution instead of staying stopping')
  const r = runSub(`
    const path = await import('node:path')
    const proj = await import(path.join(SRC, 'tools/engines/project-services/executionProjection.ts'))
    const plane = await import(path.join(SRC, 'engine/execution-plane/executionPlane.ts'))
    const owner = proj.serviceExecutionOwner(WORK)
    const id1 = proj.serviceExecutionId('svc-reject')
    const id2 = proj.serviceExecutionId('svc-err')
    proj.installServiceExecutionDomain({
      stop: async (_cwd, name) => {
        if (name === 'svc-reject') throw new Error('kill refused')
        return { error: 'no permission to stop' }
      },
    })
    plane.registerExecution({ owner, id: id1, kind: 'service', label: 'svc-reject', lifecycle: 'session', cwd: WORK, metadata: { name: 'svc-reject' }, initialState: 'running' })
    plane.registerExecution({ owner, id: id2, kind: 'service', label: 'svc-err', lifecycle: 'session', cwd: WORK, metadata: { name: 'svc-err' }, initialState: 'running' })
    plane.requestStopExecution(owner, id1)
    plane.requestStopExecution(owner, id2)
    await new Promise(resolve => setTimeout(resolve, 20))
    out.rec1 = plane.getExecution(owner, id1)
    out.rec2 = plane.getExecution(owner, id2)
  `)
  const rec1 = r.rec1 as { state?: string; outcome?: { reason?: string } } | null
  const rec2 = r.rec2 as { state?: string; outcome?: { reason?: string } } | null
  check(
    'rejected stop settles execution to indeterminate with the error message',
    rec1?.state === 'indeterminate' && (rec1.outcome?.reason ?? '').includes('kill refused'),
    JSON.stringify(rec1),
  )
  check(
    'error-result stop settles execution to indeterminate with the error message',
    rec2?.state === 'indeterminate' && (rec2.outcome?.reason ?? '').includes('no permission to stop'),
    JSON.stringify(rec2),
  )
}

if (POSIX_MODES) {
  console.log('\ninstallLayout.ts — unreadable versionsDir or shim refuses instead of deleting or overwriting')
  const r = runSub(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const layout = await import(path.join(SRC, 'platform/update-channel/installLayout.ts'))

    const vDir = path.join(WORK, 'unreadable-versions')
    fs.mkdirSync(vDir, { recursive: true })
    const keepFile = path.join(vDir, 'user-note.txt')
    fs.writeFileSync(keepFile, 'keep me')
    const binDir = path.join(WORK, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const roots = { versionsDir: vDir, binDir, shimPath: path.join(binDir, 'mercury'), isWindows: false }

    fs.chmodSync(vDir, 0o300)
    try {
      let uninstallErr = null
      try {
        layout.uninstallLayout(roots)
      } catch (e) {
        uninstallErr = e.code ?? String(e)
      }
      out.uninstallErr = uninstallErr

      let pruneErr = null
      try {
        layout.pruneSupersededVersions(roots)
      } catch (e) {
        pruneErr = e.code ?? String(e)
      }
      out.pruneErr = pruneErr
    } finally {
      fs.chmodSync(vDir, 0o700)
    }
    out.vDirKept = fs.existsSync(vDir) && fs.existsSync(keepFile) && fs.readFileSync(keepFile, 'utf8') === 'keep me'

    const foreignShim = path.join(binDir, 'mercury')
    fs.writeFileSync(foreignShim, '#!/bin/sh\\necho foreign\\n')
    fs.chmodSync(foreignShim, 0o000)
    try {
      out.writeShimOutcome = layout.writeShim(roots)
      let uninstallShimErr = null
      try {
        layout.uninstallLayout({ ...roots, versionsDir: path.join(WORK, 'absent-versions') })
      } catch (e) {
        uninstallShimErr = e.code ?? String(e)
      }
      out.uninstallShimErr = uninstallShimErr
    } finally {
      if (fs.existsSync(foreignShim)) fs.chmodSync(foreignShim, 0o600)
    }
    out.foreignKept = fs.existsSync(foreignShim) && fs.readFileSync(foreignShim, 'utf8') === '#!/bin/sh\\necho foreign\\n'

    const roVersions = path.join(WORK, 'ro-versions')
    fs.mkdirSync(roVersions, { recursive: true })
    fs.chmodSync(roVersions, 0o500)
    try {
      let lockErr = null
      let lockRes = null
      try {
        lockRes = layout.acquireUpdateLock({ ...roots, versionsDir: roVersions })
      } catch (e) {
        lockErr = e.code ?? String(e)
      }
      out.lockErr = lockErr
      out.lockRes = lockRes
    } finally {
      fs.chmodSync(roVersions, 0o700)
    }

    const mixedVersions = path.join(WORK, 'mixed-versions')
    fs.mkdirSync(mixedVersions, { recursive: true })
    fs.writeFileSync(path.join(mixedVersions, 'current.txt'), '1.0.0\\n')
    const versionNamedFile = path.join(mixedVersions, '2.0.0')
    fs.writeFileSync(versionNamedFile, 'not a dir')
    layout.uninstallLayout({ ...roots, versionsDir: mixedVersions, shimPath: path.join(WORK, 'no-shim') })
    out.versionNamedFileKept = fs.existsSync(versionNamedFile) && fs.readFileSync(versionNamedFile, 'utf8') === 'not a dir'
  `)
  check(
    'uninstallLayout throws EACCES on unreadable versionsDir and preserves it and its files',
    r.uninstallErr === 'EACCES' && r.vDirKept === true,
    JSON.stringify(r),
  )
  check(
    'uninstallLayout preserves a non-directory file whose name parses as a version',
    r.versionNamedFileKept === true,
    JSON.stringify(r),
  )
  check(
    'pruneSupersededVersions throws EACCES on unreadable versionsDir',
    r.pruneErr === 'EACCES',
    JSON.stringify(r),
  )
  const writeShimOutcome = r.writeShimOutcome as { state?: string; note?: string } | undefined
  check(
    'writeShim returns refused-foreign on unreadable foreign shim and leaves it untouched',
    writeShimOutcome?.state === 'refused-foreign' && (writeShimOutcome.note ?? '').length > 0 && r.foreignKept === true,
    JSON.stringify({ writeShimOutcome, foreignKept: r.foreignKept }),
  )
  check(
    'uninstallLayout throws EACCES on unreadable shim instead of treating it as absent',
    r.uninstallShimErr === 'EACCES',
    JSON.stringify(r),
  )
  check(
    'acquireUpdateLock throws EACCES on unwritable versionsDir instead of reporting lock held',
    r.lockErr === 'EACCES',
    JSON.stringify(r),
  )
}

{
  console.log('\nserviceManager.ts — strict record read, EPERM alive, unreadable logs, owner stop')
  const r = runSub(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mgr = await import(path.join(SRC, 'tools/engines/project-services/serviceManager.ts'))
    const lifecycle = await import(path.join(SRC, 'engine/run-owner/ownerLifecycle.ts'))
    const { projectOwner } = await import(path.join(SRC, 'engine/execution-plane/owner.ts'))

    const svcDir = mgr.servicesDir(WORK)
    fs.mkdirSync(svcDir, { recursive: true })
    const badPath = path.join(svcDir, 'corrupt-svc.json')
    fs.writeFileSync(badPath, '{not valid json')
    out.startCorrupt = await mgr.startService({
      spec: { name: 'corrupt-svc', command: process.execPath, args: ['-e', ''], cwd: WORK, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session' },
      sessionId: 's1',
    })
    out.corruptBytesKept = fs.readFileSync(badPath, 'utf8') === '{not valid json'
    out.stopCorrupt = await mgr.stopService(WORK, 'corrupt-svc')
    out.readLogsCorrupt = await mgr.readLogs(WORK, 'corrupt-svc', {})

    const epermRecord = {
      schema: 1,
      spec: { name: 'eperm-svc', command: process.execPath, args: [], cwd: WORK, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session' },
      state: 'running',
      pid: 999999,
      startToken: null,
      startedAt: Date.now(),
      stoppedAt: null,
      lastExitCode: null,
      explicitStop: false,
      restartCount: 0,
      readiness: [],
      logFile: path.join(svcDir, 'eperm-svc.log'),
      ownerSessionId: 's1',
      logStartByte: 0,
      updatedAt: Date.now(),
    }
    fs.writeFileSync(path.join(svcDir, 'eperm-svc.json'), JSON.stringify(epermRecord))
    const realKill = process.kill
    process.kill = ((pid, sig) => {
      if (pid === 999999 && sig === 0) {
        const e = new Error('operation not permitted')
        e.code = 'EPERM'
        throw e
      }
      return realKill(pid, sig)
    })
    try {
      out.reconciledEperm = mgr.reconcileRecord(WORK, 'eperm-svc')
    } finally {
      process.kill = realKill
    }

    const logFile = path.join(svcDir, 'log-svc.log')
    fs.writeFileSync(logFile, 'hello from service\\n')
    const logRecord = { ...epermRecord, spec: { ...epermRecord.spec, name: 'log-svc' }, state: 'stopped', pid: null, logFile }
    fs.writeFileSync(path.join(svcDir, 'log-svc.json'), JSON.stringify(logRecord))
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.chmodSync(logFile, 0o000)
      try {
        out.unreadableLogs = await mgr.readLogs(WORK, 'log-svc', {})
      } finally {
        fs.chmodSync(logFile, 0o600)
      }
    }

    const owner = projectOwner(path.join(WORK, 'owned'))
    const ownedDir = path.join(WORK, 'owned')
    fs.mkdirSync(ownedDir, { recursive: true })
    const started = await mgr.startService({
      spec: { name: 'owned-svc', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: ownedDir, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session' },
      sessionId: 's-own',
      owner,
    })
    const ownedPid = 'record' in started ? started.record.pid : null
    const ownedRecPath = path.join(mgr.servicesDir(ownedDir), 'owned-svc.json')
    fs.writeFileSync(ownedRecPath, '{broken')
    await lifecycle.disposeOwner(owner)
    await new Promise(resolve => setTimeout(resolve, 150))
    let stillAlive = false
    if (ownedPid) {
      try { process.kill(ownedPid, 0); stillAlive = true } catch {}
    }
    if (stillAlive && ownedPid) {
      try { process.kill(ownedPid, 'SIGKILL') } catch {}
    }
    out.ownedStoppedAfterCorruptRecord = ownedPid !== null && !stillAlive
  `)
  const startCorrupt = r.startCorrupt as { error?: string }
  const stopCorrupt = r.stopCorrupt as { error?: string }
  const readLogsCorrupt = r.readLogsCorrupt as { error?: string }
  const reconciledEperm = r.reconciledEperm as { state?: string; pid?: number | null } | null
  check(
    'startService refuses over a corrupt record and leaves the file untouched',
    typeof startCorrupt?.error === 'string' && r.corruptBytesKept === true,
    JSON.stringify(r.startCorrupt),
  )
  check(
    'stopService returns the parse error instead of saying no service exists',
    typeof stopCorrupt?.error === 'string' && !stopCorrupt.error.includes('no service'),
    JSON.stringify(r.stopCorrupt),
  )
  check(
    'readLogs returns the parse error instead of saying no service exists',
    typeof readLogsCorrupt?.error === 'string' && !readLogsCorrupt.error.includes('no service'),
    JSON.stringify(r.readLogsCorrupt),
  )
  check(
    'reconcileRecord treats EPERM from process.kill(pid, 0) as alive',
    reconciledEperm?.state === 'running' && reconciledEperm.pid === 999999,
    JSON.stringify(reconciledEperm),
  )
  if (POSIX_MODES) {
    const unreadableLogs = r.unreadableLogs as { error?: string; lines?: string[] }
    check(
      'readLogs returns an error on an unreadable log file instead of empty lines',
      typeof unreadableLogs?.error === 'string' && unreadableLogs.error.length > 0,
      JSON.stringify(unreadableLogs),
    )
  }
  check(
    'disposeOwner ends a live owned child even when its service record is corrupt',
    r.ownedStoppedAfterCorruptRecord === true,
    JSON.stringify(r),
  )
}

if (POSIX_MODES) {
  console.log('\nupdateService.ts — unwritable versionsDir returns lock refusal carrying error without throwing')
  const r = runSub(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const upd = await import(path.join(SRC, 'platform/update-channel/updateService.ts'))
    const vDir = path.join(WORK, 'ro-update-versions')
    const prevDir = path.join(vDir, '1.0.0')
    fs.mkdirSync(path.join(prevDir, 'vendor', 'ripgrep'), { recursive: true })
    fs.writeFileSync(path.join(prevDir, 'manifest.json'), JSON.stringify({ version: '1.0.0', primary: 'mercury.mjs' }))
    fs.writeFileSync(path.join(prevDir, 'mercury.mjs'), 'console.log("1.0.0")\\n')
    fs.writeFileSync(path.join(prevDir, 'mercury'), '#!/bin/sh\\n')
    fs.writeFileSync(path.join(vDir, 'current.txt'), '1.0.1\\n')
    fs.writeFileSync(path.join(vDir, 'previous.txt'), '1.0.0\\n')
    const roots = { versionsDir: vDir, binDir: path.join(WORK, 'bin'), shimPath: path.join(WORK, 'bin', 'mercury'), isWindows: false }
    fs.chmodSync(vDir, 0o500)
    try {
      let threw = null
      let outcome = null
      try {
        outcome = await upd.performRollback(roots, () => {})
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e)
      }
      out.threw = threw
      out.outcome = outcome
    } finally {
      fs.chmodSync(vDir, 0o700)
    }
  `)
  const outcome = r.outcome as { state?: string; reason?: string; remedy?: string } | null
  check(
    'performRollback returns refused carrying EACCES error without throwing when versionsDir is unwritable',
    r.threw === null && outcome?.state === 'refused' && /EACCES|permission denied/i.test(outcome.reason ?? '') && !(outcome.reason ?? '').includes('another update is already running'),
    JSON.stringify(r),
  )
  check(
    'that refusal does not tell the user to wait for an update that is not running',
    outcome?.remedy === 'the active version was left unchanged',
    JSON.stringify(r),
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
