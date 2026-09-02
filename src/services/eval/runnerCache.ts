
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'
import { PY_RUNNER_SOURCE } from './pyRunnerSource.js'
import { JS_RUNNER_SOURCE } from './jsRunnerSource.js'

export function evalCacheDir(): string {
  return join(getMercuryHome(), 'eval')
}

function contentHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 12)
}

function ensureCached(prefix: string, extension: string, source: string): string {
  const dir = evalCacheDir()
  const path = join(dir, `${prefix}-${contentHash(source)}${extension}`)
  if (existsSync(path)) return path
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, source, 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
    }
  }
  return path
}

export function ensurePyRunner(): string {
  return ensureCached('runner', '.py', PY_RUNNER_SOURCE)
}

export function ensureJsRunner(): string {
  return ensureCached('runner', '.mjs', JS_RUNNER_SOURCE)
}
