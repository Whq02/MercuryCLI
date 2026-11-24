#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPlatform } from '../../src/platform/environment/platform.js'
import { getFsImplementation, getPathsForPermissionCheck, setFsImplementation } from '../../src/platform/files/fsOperations.js'
import { bashToolHasPermission } from '../../src/tools/shell/bashPermissions.js'

let failures = 0
const HINT = 'resolveDeepestExistingAncestorSync in src/platform/files/fsOperations.ts must use basename(current) instead of current.slice(parent.length + 1) so names directly under a root keep all their letters'

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${HINT}`}`)
  if (!ok) failures++
}

const realFs = getFsImplementation()
const origConfigDir = process.env.MERCURY_CONFIG_DIR
const standInRoot = realpathSync(mkdtempSync(join(tmpdir(), 'root-standin-')))

function withRootStandIn(mappedRoot: string): void {
  setFsImplementation(
    new Proxy(realFs, {
      get(target, key) {
        if (key === 'realpathSync') {
          return (filePath: string) => (filePath === '/' ? mappedRoot : target.realpathSync(filePath))
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  )
}

try {
  withRootStandIn(standInRoot)

  const longPaths = getPathsForPermissionCheck('/zz-no-such-name')
  check(
    'getPathsForPermissionCheck(/zz-no-such-name) keeps the full name joined onto the resolved root',
    longPaths.includes(join(standInRoot, 'zz-no-such-name')) && !longPaths.includes(standInRoot) && !longPaths.includes(join(standInRoot, 'z-no-such-name')),
    JSON.stringify(longPaths),
  )

  const shortPaths = getPathsForPermissionCheck('/s')
  check(
    'getPathsForPermissionCheck(/s) keeps the single-letter name and never collapses to the bare root',
    shortPaths.includes(join(standInRoot, 's')) && !shortPaths.includes(standInRoot),
    JSON.stringify(shortPaths),
  )

  const nestedPaths = getPathsForPermissionCheck('/s/sub')
  check(
    'getPathsForPermissionCheck(/s/sub) keeps the first segment directly under the root',
    nestedPaths.includes(join(standInRoot, 's', 'sub')) && !nestedPaths.includes(join(standInRoot, 'sub')),
    JSON.stringify(nestedPaths),
  )

  withRootStandIn('C:\\')
  getPlatform.cache.set(undefined, 'windows')
  process.env.MERCURY_CONFIG_DIR = 'C:\\Users\\op\\.mercury'
  const shellContext = { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} } as never

  const delVerdict = await bashToolHasPermission({ command: 'del /f /q out.txt' }, shellContext)
  check(
    'Bash on Windows does not refuse del /f /q out.txt as touching the root or runtime',
    delVerdict.behavior !== 'deny' && (delVerdict.behavior === 'allow' || !delVerdict.message.includes('is refused')),
    `${delVerdict.behavior}: ${delVerdict.behavior === 'allow' ? '' : delVerdict.message}`,
  )

  const rdVerdict = await bashToolHasPermission({ command: 'rd /s /q build' }, shellContext)
  check(
    'Bash on Windows does not refuse rd /s /q build as touching the root or runtime',
    rdVerdict.behavior !== 'deny' && (rdVerdict.behavior === 'allow' || !rdVerdict.message.includes('is refused')),
    `${rdVerdict.behavior}: ${rdVerdict.behavior === 'allow' ? '' : rdVerdict.message}`,
  )

  const rmDriveVerdict = await bashToolHasPermission({ command: 'rm -rf /c' }, shellContext)
  check(
    'Bash on Windows still refuses rm -rf /c (by K-15)',
    rmDriveVerdict.behavior === 'deny' && rmDriveVerdict.message.includes('is refused'),
    `${rmDriveVerdict.behavior}: ${rmDriveVerdict.behavior === 'allow' ? '' : rmDriveVerdict.message}`,
  )

  const rmRootVerdict = await bashToolHasPermission({ command: 'rm -rf /' }, shellContext)
  check(
    'Bash on Windows still refuses rm -rf /',
    rmRootVerdict.behavior === 'deny' && rmRootVerdict.message.includes('is refused'),
    `${rmRootVerdict.behavior}: ${rmRootVerdict.behavior === 'allow' ? '' : rmRootVerdict.message}`,
  )
} finally {
  setFsImplementation(realFs)
  getPlatform.cache.delete(undefined)
  if (origConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = origConfigDir
  rmSync(standInRoot, { recursive: true, force: true })
}

console.log(`name-under-root-keeps-its-letters: ${failures ? `FAIL (${failures})` : 'PASS'}`)
process.exit(failures ? 1 : 0)
