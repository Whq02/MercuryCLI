import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { projectLocalPath } from '../../projectLocal/paths.js'

export const ENGINE_DIR_SEGMENT = 'engine'

export function engineDir(projectRoot: string): string {
  return projectLocalPath(projectRoot, ENGINE_DIR_SEGMENT)
}

export function engineTreesDir(projectRoot: string): string {
  return path.join(engineDir(projectRoot), 'trees')
}

export function engineRunsDir(projectRoot: string): string {
  return path.join(engineDir(projectRoot), 'runs')
}

export function engineCacheDir(projectRoot: string): string {
  return path.join(engineDir(projectRoot), 'cache')
}

export function engineUsersDir(projectRoot: string): string {
  return path.join(engineDir(projectRoot), 'users')
}

export function engineChecksDir(projectRoot: string): string {
  return path.join(engineDir(projectRoot), 'checks')
}

export function engineTreePath(projectRoot: string, jobId: string): string {
  return path.join(engineTreesDir(projectRoot), jobId)
}

export function engineRunPath(projectRoot: string, jobId: string): string {
  return path.join(engineRunsDir(projectRoot), jobId)
}

export function ensureEngineEstate(projectRoot: string): string {
  const dir = engineDir(projectRoot)
  mkdirSync(dir, { recursive: true })
  const ignore = path.join(dir, '.gdignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '')
  return dir
}

export function isEnginePath(projectRoot: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    if (platform === 'win32') s = s.toLowerCase()
    return s
  }
  const prefix = norm(engineDir(projectRoot)) + '/'
  return norm(candidate).startsWith(prefix)
}
