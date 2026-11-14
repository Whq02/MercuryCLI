import { existsSync, openSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nixInstallRoot } from '../services/privateChannel/installProvenance.js'

let selfScriptMemo: { argv: string; real: string; invoked: string } | null = null

export function resolveScriptPath(script: string | undefined): string {
  if (!script) return ''
  try {
    return realpathSync(script)
  } catch {
    return script
  }
}

function selfScript(): { argv: string; real: string; invoked: string } {
  const argv = process.argv[1] ?? ''
  if (selfScriptMemo === null || selfScriptMemo.argv !== argv) {
    const real = resolveScriptPath(argv)
    selfScriptMemo = { argv, real, invoked: nixInstallRoot(argv) === null ? real : argv }
  }
  return selfScriptMemo
}

export function selfScriptPath(): string {
  return selfScript().real
}

export function invokedScriptPath(): string {
  return selfScript().invoked
}

function selfBuildDir(): string {
  const script = selfScriptPath()
  return script === '' ? '' : dirname(script)
}

export function vendoredNodeBeside(buildDir: string, platform: NodeJS.Platform = process.platform): string | null {
  if (buildDir === '') return null
  const candidate = platform === 'win32' ? join(buildDir, 'vendor', 'node', 'node.exe') : join(buildDir, 'vendor', 'node', 'bin', 'node')
  try {
    return existsSync(candidate) ? nixInstallRoot(join(buildDir, 'mercury.mjs'), platform === 'win32') === null ? realpathSync(candidate) : candidate : null
  } catch {
    return null
  }
}

export function nodeForBuild(buildDir: string, fallback: string = process.execPath): string {
  return vendoredNodeBeside(buildDir) ?? fallback
}

const BUILD_HOLD_FILE = 'manifest.json'

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
