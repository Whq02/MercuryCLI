#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_LSP ??= '1'
process.env.MERCURY_LSP_SIDECAR_ENTRY ??= join(import.meta.dir, '..', '..', 'src', 'services', 'lsp', 'tsSidecar', 'entry.ts')

const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const { probeBuiltinTsServer, builtinImplementationInfo } = await import('../../src/services/lsp/builtinServers.ts')
const { probeBuiltinPyright, _resetPyrightProbeCacheForTesting, builtinPyrightServer, MERCURY_PYRIGHT_SERVER_NAME } =
  await import('../../src/services/lsp/pyrightLane.ts')
const { resolvePackagedTypescript } = await import('../../src/services/structure/tsFacility.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}


{
  const p = probeBuiltinTsServer()
  check('ts: project-local rung wins in a typescript workspace', p.typescriptSource === 'project-local', JSON.stringify(p))
  check('ts: project-local version named', typeof p.typescriptVersion === 'string' && p.typescriptVersion!.length > 0)
}

{
  const empty = mkdtempSync(join(tmpdir(), 'vista-law-ts-'))
  writeFileSync(join(empty, 'package.json'), '{"name":"fixture"}\n')
  const p = runWithCwdOverride(empty, () => probeBuiltinTsServer())
  const packaged = resolvePackagedTypescript()
  if (!packaged) {
    check('ts: packaged compiler present for the fallback rung (build dist first)', false)
  } else {
    check('ts: packaged rung engages without workspace typescript', p.typescriptSource === 'packaged', JSON.stringify(p))
    check('ts: packaged path is the ONE tsFacility resolution', p.typescriptPath === packaged.modulePath)
    check('ts: packaged version named', p.typescriptVersion === packaged.version || typeof p.typescriptVersion === 'string')
  }
}


{
  const ws = mkdtempSync(join(tmpdir(), 'vista-law-pyright-'))
  const pkgDir = join(ws, 'node_modules', 'pyright')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), '{"name":"pyright","version":"9.9.9-fixture"}\n')
  writeFileSync(join(pkgDir, 'langserver.index.js'), '// fixture langserver entry\n')
  _resetPyrightProbeCacheForTesting()
  const p = runWithCwdOverride(ws, () => probeBuiltinPyright())
  check('pyright: project-local rung wins over bundled', p.source === 'project-local', JSON.stringify(p))
  check('pyright: project-local version named', p.version === '9.9.9-fixture')
  const cfg = runWithCwdOverride(ws, () => {
    _resetPyrightProbeCacheForTesting()
    return builtinPyrightServer()
  })
  const entry = cfg[MERCURY_PYRIGHT_SERVER_NAME]
  check(
    'pyright: project-local spawn = node + entry (JS entry, never exec-the-script)',
    !!entry && entry.command === process.execPath && Array.isArray(entry.args) && entry.args[0]!.endsWith('langserver.index.js'),
    JSON.stringify({ command: entry?.command, args: entry?.args }),
  )
  _resetPyrightProbeCacheForTesting()
}

{
  const ws = mkdtempSync(join(tmpdir(), 'vista-law-pyright-empty-'))
  const vendor = mkdtempSync(join(tmpdir(), 'vista-law-pyright-vendor-'))
  writeFileSync(join(vendor, 'langserver.index.js'), '// fixture vendored entry\n')
  writeFileSync(join(vendor, '.vendor-manifest.json'), '{"version":"1.1.411-fixture"}\n')
  const prev = process.env.MERCURY_PYRIGHT_VENDOR_DIR
  process.env.MERCURY_PYRIGHT_VENDOR_DIR = vendor
  _resetPyrightProbeCacheForTesting()
  const p = runWithCwdOverride(ws, () => probeBuiltinPyright())
  check('pyright: bundled rung engages without a project-local package', p.source === 'bundled', JSON.stringify(p))
  check('pyright: bundled version named', p.version === '1.1.411-fixture')

  const wsWithLocal = mkdtempSync(join(tmpdir(), 'vista-law-pyright-local-'))
  const pkgDir = join(wsWithLocal, 'node_modules', 'pyright')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), '{"name":"pyright","version":"8.8.8-local"}\n')
  writeFileSync(join(pkgDir, 'langserver.index.js'), '// local entry\n')
  _resetPyrightProbeCacheForTesting()
  const pinned = runWithCwdOverride(wsWithLocal, () => probeBuiltinPyright())
  check('pyright: the pin BEATS a project-local package', pinned.source === 'bundled' && pinned.version === '1.1.411-fixture', JSON.stringify(pinned))

  process.env.MERCURY_PYRIGHT_VENDOR_DIR = join(vendor, 'no-such-subdir')
  _resetPyrightProbeCacheForTesting()
  const broken = runWithCwdOverride(wsWithLocal, () => probeBuiltinPyright())
  check(
    'pyright: a broken pin names itself (no silent fallback)',
    !broken.available && (broken.reason ?? '').includes('MERCURY_PYRIGHT_VENDOR_DIR'),
    JSON.stringify(broken),
  )

  if (prev === undefined) delete process.env.MERCURY_PYRIGHT_VENDOR_DIR
  else process.env.MERCURY_PYRIGHT_VENDOR_DIR = prev
  _resetPyrightProbeCacheForTesting()
}


{
  const info = builtinImplementationInfo('mercury-ts')
  check('status: mercury-ts implementation row present in this workspace', info !== null && info.source === 'project-local', JSON.stringify(info))
  check('status: unknown server yields null (no invented provenance)', builtinImplementationInfo('no-such-server') === null)
}

if (failures > 0) {
  console.error(`\nresolution law: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nresolution law: green')
