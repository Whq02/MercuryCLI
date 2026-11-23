#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_LSP ??= '1'
process.env.MERCURY_LSP_SIDECAR_ENTRY ??= join(import.meta.dir, '..', '..', 'src', 'integrations', 'lsp', 'ts-sidecar', 'entry.ts')

const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
const { probeBuiltinTsServer, builtinImplementationInfo } = await import('../../src/integrations/lsp/builtinServers.ts')
const { probeBuiltinPyright, _resetPyrightProbeCacheForTesting, builtinPyrightServer, MERCURY_PYRIGHT_SERVER_NAME } =
  await import('../../src/integrations/lsp/pyrightLane.ts')
const { resolvePackagedTypescript } = await import('../../src/tools/engines/structure/tsFacility.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}


{
  const p = probeBuiltinTsServer()
  check('ts: project-local rung wins in a typescript workspace', p.typescriptSource === 'project-local', JSON.stringify(p) + ' | fix the resolution order in probeBuiltinTsServer (src/integrations/lsp/builtinServers.ts) so the workspace typescript is tried first')
  check('ts: project-local version named', typeof p.typescriptVersion === 'string' && p.typescriptVersion!.length > 0, 'probeBuiltinTsServer (src/integrations/lsp/builtinServers.ts) must report the version of the typescript it resolved')
}

{
  const empty = mkdtempSync(join(tmpdir(), 'vista-law-ts-'))
  writeFileSync(join(empty, 'package.json'), '{"name":"fixture"}\n')
  const p = runWithCwdOverride(empty, () => probeBuiltinTsServer())
  const packaged = resolvePackagedTypescript()
  if (!packaged) {
    check('ts: packaged compiler present for the fallback rung (build dist first)', false, 'resolvePackagedTypescript (src/tools/engines/structure/tsFacility.ts) found no packaged compiler; run bun run build.ts first, or fix that function')
  } else {
    check('ts: packaged rung engages without workspace typescript', p.typescriptSource === 'packaged', JSON.stringify(p) + ' | probeBuiltinTsServer (src/integrations/lsp/builtinServers.ts) must fall back to the packaged compiler when the workspace has no typescript')
    check('ts: packaged path is the ONE tsFacility resolution', p.typescriptPath === packaged.modulePath, 'probeBuiltinTsServer (src/integrations/lsp/builtinServers.ts) must report the path resolvePackagedTypescript returns (src/tools/engines/structure/tsFacility.ts), not resolve its own; got ' + String(p.typescriptPath))
    check('ts: packaged version named', p.typescriptVersion === packaged.version || typeof p.typescriptVersion === 'string', 'probeBuiltinTsServer (src/integrations/lsp/builtinServers.ts) must name the packaged compiler version')
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
  check('pyright: project-local rung wins over bundled', p.source === 'project-local', JSON.stringify(p) + ' | probeBuiltinPyright (src/integrations/lsp/pyrightLane.ts) must pick node_modules/pyright of the workspace when no pin is set')
  check('pyright: project-local version named', p.version === '9.9.9-fixture', JSON.stringify(p) + ' | probeBuiltinPyright (src/integrations/lsp/pyrightLane.ts) must read the version from the project-local package.json')
  const cfg = runWithCwdOverride(ws, () => {
    _resetPyrightProbeCacheForTesting()
    return builtinPyrightServer()
  })
  const entry = cfg[MERCURY_PYRIGHT_SERVER_NAME]
  check(
    'pyright: project-local spawn = node + entry (JS entry, never exec-the-script)',
    !!entry && entry.command === process.execPath && Array.isArray(entry.args) && entry.args[0]!.endsWith('langserver.index.js'),
    JSON.stringify({ command: entry?.command, args: entry?.args }) + ' | builtinPyrightServer (src/integrations/lsp/pyrightLane.ts) must spawn process.execPath with langserver.index.js as the first argument'
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
  check('pyright: bundled rung engages without a project-local package', p.source === 'bundled', JSON.stringify(p) + ' | probeBuiltinPyright (src/integrations/lsp/pyrightLane.ts) must use the dir in MERCURY_PYRIGHT_VENDOR_DIR when the workspace has no pyright package')
  check('pyright: bundled version named', p.version === '1.1.411-fixture', JSON.stringify(p) + ' | probeBuiltinPyright (src/integrations/lsp/pyrightLane.ts) must read the version from .vendor-manifest.json in the vendor dir')

  const wsWithLocal = mkdtempSync(join(tmpdir(), 'vista-law-pyright-local-'))
  const pkgDir = join(wsWithLocal, 'node_modules', 'pyright')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), '{"name":"pyright","version":"8.8.8-local"}\n')
  writeFileSync(join(pkgDir, 'langserver.index.js'), '// local entry\n')
  _resetPyrightProbeCacheForTesting()
  const pinned = runWithCwdOverride(wsWithLocal, () => probeBuiltinPyright())
  check('pyright: the pin BEATS a project-local package', pinned.source === 'bundled' && pinned.version === '1.1.411-fixture', JSON.stringify(pinned) + ' | probeBuiltinPyright (src/integrations/lsp/pyrightLane.ts) must prefer MERCURY_PYRIGHT_VENDOR_DIR over a project-local pyright')

  process.env.MERCURY_PYRIGHT_VENDOR_DIR = join(vendor, 'no-such-subdir')
  _resetPyrightProbeCacheForTesting()
  const broken = runWithCwdOverride(wsWithLocal, () => probeBuiltinPyright())
  check(
    'pyright: a broken pin names itself (no silent fallback)',
    !broken.available && (broken.reason ?? '').includes('MERCURY_PYRIGHT_VENDOR_DIR'),
    JSON.stringify(broken) + ' | probeBuiltinPyright (src/integrations/lsp/pyrightLane.ts) must return unavailable with a reason naming MERCURY_PYRIGHT_VENDOR_DIR when the pinned dir has no langserver.index.js'
  )

  if (prev === undefined) delete process.env.MERCURY_PYRIGHT_VENDOR_DIR
  else process.env.MERCURY_PYRIGHT_VENDOR_DIR = prev
  _resetPyrightProbeCacheForTesting()
}


{
  const info = builtinImplementationInfo('mercury-ts')
  check('status: mercury-ts implementation row present in this workspace', info !== null && info.source === 'project-local', JSON.stringify(info) + ' | builtinImplementationInfo (src/integrations/lsp/builtinServers.ts) must return the project-local source for mercury-ts here')
  check('status: unknown server yields null (no invented provenance)', builtinImplementationInfo('no-such-server') === null, 'builtinImplementationInfo (src/integrations/lsp/builtinServers.ts) must return null for a name it does not know')
}

if (failures > 0) {
  console.error(`\nresolution law: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nresolution law: green')
