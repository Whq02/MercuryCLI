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
  console.log('\npaths.ts — failed homedir refuses estate creation')
  const r = runSub(`
    const { mock } = await import('bun:test')
    const realOs = await import('node:os')
    mock.module('node:os', () => ({ ...realOs, homedir: () => { throw new Error('homedir unavailable') } }))
    const fs = await import('node:fs')
    const path = await import('node:path')
    const paths = await import(path.join(SRC, 'services/projectLocal/paths.ts'))
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
    'initializeProjectLocalEstate throws and does not create .mercury when homedir fails',
    r.threw === 'homedir unavailable' && r.created === false,
    JSON.stringify(r),
  )
}

{
  console.log('\nghRelease.ts — invalid MERCURY_GH_CMD returns error and never runs plain gh')
  const r = runSub(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const binDir = path.join(WORK, 'bin')
    const marker = path.join(WORK, 'plain-gh-ran')
    fs.mkdirSync(binDir, { recursive: true })
    const fakeGh = path.join(binDir, 'gh')
    fs.writeFileSync(fakeGh, '#!/bin/sh\\necho ran > ' + JSON.stringify(marker) + '\\necho ok\\n')
    fs.chmodSync(fakeGh, 0o755)
    process.env.PATH = binDir + ':' + (process.env.PATH ?? '')
    process.env.MERCURY_GH_CMD = '{bad json'
    const ghMod = await import(path.join(SRC, 'services/privateChannel/ghRelease.ts'))
    out.badJson = await ghMod.gh(['--version'])
    process.env.MERCURY_GH_CMD = '[]'
    out.emptyArray = await ghMod.gh(['--version'])
    out.plainRan = fs.existsSync(marker)
  `)
  const badJson = r.badJson as { state?: string; stderr?: string }
  const emptyArray = r.emptyArray as { state?: string; stderr?: string }
  check(
    'unparsable or empty MERCURY_GH_CMD returns error naming MERCURY_GH_CMD and never runs plain gh',
    badJson?.state === 'error' && (badJson.stderr ?? '').includes('MERCURY_GH_CMD') && emptyArray?.state === 'error' && (emptyArray.stderr ?? '').includes('MERCURY_GH_CMD') && r.plainRan === false,
    JSON.stringify(r),
  )
}

{
  console.log('\ninstallPath.ts — failing zshDotDir probe refuses instead of writing ~/.zshrc')
  const r = runSub(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const installPath = await import(path.join(SRC, 'services/privateChannel/installPath.ts'))
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
    'ensureBinDirOnPath refuses and writes nothing when zshDotDir throws',
    ensure?.state === 'refused' && (ensure.reason ?? '').includes('zsh probe failed') && r.appended === 0,
    JSON.stringify(r),
  )
  check(
    'realPathEntryIo().zshDotDir throws when zsh exits non-zero',
    typeof r.realThrew === 'string' && r.realThrew.length > 0,
    JSON.stringify(r),
  )
}

{
  console.log('\nexecutionProjection.ts — failed service stop settles execution instead of staying stopping')
  const r = runSub(`
    const path = await import('node:path')
    const proj = await import(path.join(SRC, 'services/projectServices/executionProjection.ts'))
    const plane = await import(path.join(SRC, 'services/primitives/executionPlane.ts'))
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
    const layout = await import(path.join(SRC, 'services/privateChannel/installLayout.ts'))

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
      let writeErr = null
      try {
        layout.writeShim(roots)
      } catch (e) {
        writeErr = e.code ?? String(e)
      }
      out.writeShimErr = writeErr

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
  `)
  check(
    'uninstallLayout throws EACCES on unreadable versionsDir and preserves it and its files',
    r.uninstallErr === 'EACCES' && r.vDirKept === true,
    JSON.stringify(r),
  )
  check(
    'pruneSupersededVersions throws EACCES on unreadable versionsDir',
    r.pruneErr === 'EACCES',
    JSON.stringify(r),
  )
  check(
    'writeShim throws EACCES on unreadable foreign shim and leaves it untouched',
    r.writeShimErr === 'EACCES' && r.foreignKept === true,
    JSON.stringify(r),
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

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
