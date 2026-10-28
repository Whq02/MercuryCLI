#!/usr/bin/env bun
// gate-watch: src/utils/permissions/windowsPath.ts src/utils/permissions/filesystem.ts src/tools/GrepTool/GrepTool.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.MERCURY_HOME
const base = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const proofHome = mkdtempSync(join(base, 'grep-dot-path-'))
process.env.MERCURY_CONFIG_DIR = proofHome
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { getPlatform } = await import('../../src/utils/platform.ts')
const { suspiciousWindowsPattern } = await import('../../src/utils/permissions/windowsPath.ts')
const { checkReadPermissionForTool, getResolvedWorkingDirPaths } = await import('../../src/utils/permissions/filesystem.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')

const project = join(proofHome, 'project')
mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(join(project, 'src', 'a.ts'), 'const needle = 1\n')
bootstrap.setOriginalCwd(project)
bootstrap.setCwdState(project)
process.chdir(project)
const cache = (getPlatform as unknown as { cache: Map<unknown, unknown> }).cache
const withPlatform = <T,>(platform: string, body: () => T): T => {
  const had = cache.has(undefined)
  const was = cache.get(undefined)
  cache.set(undefined, platform)
  getResolvedWorkingDirPaths.clearCache()
  try {
    return body()
  } finally {
    if (had) cache.set(undefined, was)
    else cache.delete(undefined)
    getResolvedWorkingDirPaths.clearCache()
  }
}

section('§1 the pattern: a bare dot, a double dot and a dot-led relative path are POSIX paths on every platform; the Windows shapes the rule exists for still refuse')
for (const platform of ['linux', 'macos', 'windows', 'wsl'] as const) {
  withPlatform(platform, () => {
    for (const path of ['.', '..', './x', '../x', './src/a.ts', 'src/.', 'src/..', '.\\x', '..\\x']) {
      check(`${platform}: '${path}' is not a suspicious Windows pattern`, suspiciousWindowsPattern(path) === null, String(suspiciousWindowsPattern(path)))
    }
    for (const [path, expected] of [['file.', 'trailing dot or whitespace'], ['file ', 'trailing dot or whitespace'], ['src/name.', 'trailing dot or whitespace'], ['C:\\dir\\name.', 'trailing dot or whitespace'], ['src/... ', 'trailing dot or whitespace'], ['a/.../b', 'consecutive dots as a path component'], ['CON', 'DOS device name']] as const) {
      check(`${platform}: '${path}' still refuses as ${expected}`, suspiciousWindowsPattern(path) === expected, String(suspiciousWindowsPattern(path)))
    }
  })
}

section("§2 the Grep tool's road: path '.' (the tool's getPath hands the path unexpanded) is allowed on linux and darwin fixtures; a trailing-dot name still asks")
{
  const grepLike = { name: 'Grep', getPath: (input: { path?: string } | undefined) => input?.path || getCwd() }
  const context = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  for (const platform of ['linux', 'macos'] as const) {
    withPlatform(platform, () => {
      const dot = checkReadPermissionForTool(grepLike as never, { pattern: 'needle', path: '.' }, context)
      check(`${platform}: Grep with path '.' is allowed (the starting folder itself)`, dot.behavior === 'allow', JSON.stringify(dot))
      const dotSlash = checkReadPermissionForTool(grepLike as never, { pattern: 'needle', path: './src' }, context)
      check(`${platform}: Grep with path './src' is allowed`, dotSlash.behavior === 'allow', JSON.stringify(dotSlash))
      const parent = checkReadPermissionForTool(grepLike as never, { pattern: 'needle', path: 'src/..' }, context)
      check(`${platform}: Grep with path 'src/..' is allowed (it is the starting folder)`, parent.behavior === 'allow', JSON.stringify(parent))
      const trailing = checkReadPermissionForTool(grepLike as never, { pattern: 'needle', path: 'src/name.' }, context)
      check(`${platform}: Grep with path 'src/name.' still asks with the Windows-pattern reason`, trailing.behavior === 'ask' && JSON.stringify(trailing).includes('suspicious Windows path pattern'), JSON.stringify(trailing))
    })
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
