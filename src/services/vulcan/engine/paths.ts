import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { MERCURY_PROJECT_DIR } from '../../../utils/projectConfig.js'
import { projectLocalPath } from '../../projectLocal/paths.js'

export const ENGINE_DIR_SEGMENT = 'engine'
export const ENGINE_RESULT_FILE = 'result.json'
const ENGINE_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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

export function isEngineJobId(jobId: string): boolean {
  return ENGINE_JOB_ID_RE.test(jobId)
}

function runSegment(jobId: string): string {
  if (!isEngineJobId(jobId)) throw new Error('an engine job id must be a name, not a path')
  return jobId
}

export function engineTreePath(projectRoot: string, jobId: string): string {
  return path.join(engineTreesDir(projectRoot), runSegment(jobId))
}

export function engineRunPath(projectRoot: string, jobId: string): string {
  return path.join(engineRunsDir(projectRoot), runSegment(jobId))
}

export function engineRunResultFile(runDir: string): string {
  return path.join(runDir, ENGINE_RESULT_FILE)
}

export function engineRunLogFile(runDir: string, name: string): string {
  return path.join(runDir, `${name}.log`)
}

export function engineRunUserDir(runDir: string): string {
  return path.join(runDir, 'user')
}

export function engineMediaDir(runDir: string, variant?: string): string {
  return variant === undefined ? path.join(runDir, 'media') : path.join(runDir, 'media', variant)
}

export function engineMediaDriverFile(runDir: string, variant: string): string {
  return path.join(engineMediaDir(runDir, variant), 'driver.gd')
}

export function engineMediaConfigFile(runDir: string, variant: string): string {
  return path.join(engineMediaDir(runDir, variant), 'request.json')
}

export function engineMediaBootFile(runDir: string, variant: string): string {
  return path.join(engineMediaDir(runDir, variant), 'boot.json')
}

export function engineMediaUserDir(runDir: string, variant: string): string {
  return path.join(engineMediaDir(runDir, variant), 'user')
}

export function engineContactSheetFile(runDir: string): string {
  return path.join(engineMediaDir(runDir), 'contact-sheet.png')
}

export function engineFramesDirPrefix(projectRoot: string): string {
  return path.join(engineRunsDir(projectRoot), 'frames-')
}

export function engineCheckDir(projectRoot: string, checkId: string): string {
  return path.join(engineChecksDir(projectRoot), checkId)
}

export function engineCheckTreeDir(checkDir: string): string {
  return path.join(checkDir, 'tree')
}

export function engineCheckUserDir(checkDir: string): string {
  return path.join(checkDir, 'user')
}

export function engineCheckProbeRelative(checkId: string): string {
  return path.posix.join(MERCURY_PROJECT_DIR, ENGINE_DIR_SEGMENT, 'checks', checkId, 'shader_check.gd')
}

export function ensureEngineEstate(projectRoot: string): string {
  const dir = engineDir(projectRoot)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path.join(dir, '.gdignore'), '', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return dir
}

export function isEnginePath(projectRoot: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    if (platform === 'win32') s = s.toLowerCase()
    return s
  }
  const spellings = [projectRoot]
  try {
    const real = realpathSync(projectRoot)
    if (real !== projectRoot) spellings.push(real)
  } catch {
    return norm(candidate).startsWith(norm(engineDir(projectRoot)) + '/')
  }
  const c = norm(candidate)
  return spellings.some(root => c.startsWith(norm(engineDir(root)) + '/'))
}
