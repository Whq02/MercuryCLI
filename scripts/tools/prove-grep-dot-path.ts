#!/usr/bin/env bun
// gate-watch: src/utils/permissions/windowsPath.ts src/utils/permissions/filesystem.ts src/tools/GrepTool/GrepTool.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInside } from '../lib/platformPath.ts'

delete process.env.NODE_ENV
delete process.env.MERCURY_HOME
const base = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const proofHome = mkdtempSync(join(base, 'grep-dot-path-'))
process.env.MERCURY_CONFIG_DIR = proofHome
const launchCwd = process.cwd()
process.on('exit', () => { process.chdir(launchCwd); rmSync(proofHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
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
const { getCwd, runWithCwdOverride } = await import('../../src/utils/cwd.ts')

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

section("§2 the Grep tool's road on this host: path '.' (the tool's getPath hands the path unexpanded), './src' and 'src/..' are allowed; a trailing-dot name still asks")
const grepLike = { name: 'Grep', getPath: (input: { path?: string } | undefined) => input?.path || getCwd() }
const context = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
const verdict = (path: string) => { getResolvedWorkingDirPaths.clearCache(); return checkReadPermissionForTool(grepLike as never, { pattern: 'needle', path }, context) }
const host = getPlatform()
{
  const dot = verdict('.')
  check(`${host}: Grep with path '.' is allowed (the starting folder itself)`, dot.behavior === 'allow', JSON.stringify(dot))
  const dotSlash = verdict('./src')
  check(`${host}: Grep with path './src' is allowed`, dotSlash.behavior === 'allow', JSON.stringify(dotSlash))
  const parent = verdict('src/..')
  check(`${host}: Grep with path 'src/..' is allowed (it is the starting folder)`, parent.behavior === 'allow', JSON.stringify(parent))
  const trailing = verdict('src/name.')
  check(`${host}: Grep with path 'src/name.' still asks with the Windows-pattern reason`, trailing.behavior === 'ask' && JSON.stringify(trailing).includes('suspicious Windows path pattern'), JSON.stringify(trailing))
}

section("§3 a relative path is read against the session's folder, never the process's: the process sits elsewhere, a worktree crewmate carries an override, a Bash cd moves the logical folder")
{
  const elsewhere = join(proofHome, 'elsewhere')
  mkdirSync(join(elsewhere, 'src'), { recursive: true })
  writeFileSync(join(elsewhere, 'src', 'a.ts'), 'const needle = 2\n')
  process.chdir(proofHome)
  const projectReal = realpathSync(project)
  const underProject = (form: string): boolean => form === project || form === projectReal || isInside(form, project) || isInside(form, projectReal)
  for (const path of ['.', './src', 'src']) {
    const away = verdict(path)
    const forms = getResolvedWorkingDirPaths(path)
    check(`process elsewhere: Grep with path '${path}' is allowed and its real form sits under the starting folder`, away.behavior === 'allow' && forms.slice(1).every(underProject) && forms.length >= 2, `${JSON.stringify(away)} forms ${JSON.stringify(forms)}`)
  }
  process.chdir(project)
  runWithCwdOverride(elsewhere, () => {
    const inWorktree = verdict('./src')
    const forms = getResolvedWorkingDirPaths('./src')
    check("a cwd override (a worktree crewmate): './src' resolves under the override, which is that context's starting folder, and is allowed", inWorktree.behavior === 'allow' && forms.includes(join(elsewhere, 'src')) && !forms.includes(join(project, 'src')), `${JSON.stringify(inWorktree)} forms ${JSON.stringify(forms)}`)
  })
  bootstrap.setCwdState(elsewhere)
  const moved = verdict('./src')
  const movedForms = getResolvedWorkingDirPaths('./src')
  check("after a Bash cd out of the starting folder: './src' is the search's own root under the new folder, so it asks as outside the starting folder (process.cwd() still names the starting folder)", moved.behavior === 'ask' && JSON.stringify(moved).includes('the path is outside the starting folder') && movedForms.includes(join(elsewhere, 'src')) && !movedForms.includes(join(project, 'src')), `${JSON.stringify(moved)} forms ${JSON.stringify(movedForms)}`)
  bootstrap.setCwdState(project)
  const back = checkReadPermissionForTool(grepLike as never, { pattern: 'needle', path: './src' }, context)
  check("cd back: './src' is allowed again without clearing the memo (the memo is keyed by the folder for a relative spelling)", back.behavior === 'allow' && getResolvedWorkingDirPaths('./src').includes(join(project, 'src')), JSON.stringify(back))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
