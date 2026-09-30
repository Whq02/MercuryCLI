import { closeSync, existsSync, openSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

let selfScriptMemo: string | null = null

export function resolveScriptPath(script: string | undefined): string {
  if (!script) return ''
  try {
    return realpathSync(script)
  } catch {
    return script
  }
}

export function selfScriptPath(): string {
  if (selfScriptMemo === null) selfScriptMemo = resolveScriptPath(process.argv[1])
  return selfScriptMemo
}

export function selfBuildDir(): string {
  const script = selfScriptPath()
  return script === '' ? '' : dirname(script)
}

export function vendoredNodeBeside(buildDir: string, platform: NodeJS.Platform = process.platform): string | null {
  if (buildDir === '') return null
  const candidate = platform === 'win32' ? join(buildDir, 'vendor', 'node', 'node.exe') : join(buildDir, 'vendor', 'node', 'bin', 'node')
  try {
    return existsSync(candidate) ? realpathSync(candidate) : null
  } catch {
    return null
  }
}

export function nodeForBuild(buildDir: string, fallback: string = process.execPath): string {
  return vendoredNodeBeside(buildDir) ?? fallback
}

export const BUILD_HOLD_FILE = 'manifest.json'

let buildHoldFd: number | null = null

export function holdBuild(buildDir: string = selfBuildDir()): 'held' | 'no-manifest' | 'already-held' {
  if (buildHoldFd !== null) return 'already-held'
  if (buildDir === '') return 'no-manifest'
  const path = join(buildDir, BUILD_HOLD_FILE)
  try {
    buildHoldFd = openSync(path, 'r')
    return 'held'
  } catch {
    return 'no-manifest'
  }
}

export function releaseBuildHold(): void {
  if (buildHoldFd === null) return
  try {
    closeSync(buildHoldFd)
  } catch {
    buildHoldFd = null
  }
  buildHoldFd = null
}

export function buildHoldFdForTesting(): number | null {
  return buildHoldFd
}

export function resetSelfScriptForTesting(): void {
  selfScriptMemo = null
}
