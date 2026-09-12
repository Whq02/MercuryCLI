import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { sameProjectPath } from '../godotProcessCensus.js'
import { engineRunPath, engineTreePath, engineTreesDir } from './paths.js'

export interface EngineRunOwner {
  version: 1
  jobId: string
  ownerPid: number
  projectRoot: string
  treePath: string
  createdAt: string
}

export function writeEngineRunOwner(projectRoot: string, jobId: string): void {
  const root = path.resolve(projectRoot)
  const owner: EngineRunOwner = {
    version: 1,
    jobId,
    ownerPid: process.pid,
    projectRoot: root,
    treePath: engineTreePath(root, jobId),
    createdAt: new Date().toISOString(),
  }
  writeFileSync(path.join(engineRunPath(root, jobId), 'owner.json'), JSON.stringify(owner, null, 2), { flag: 'wx' })
}

export function engineTreeOwnerIsDead(projectRoot: string, treePath: string): boolean {
  try {
    const root = path.resolve(projectRoot)
    const tree = path.resolve(treePath)
    if (!sameProjectPath(path.dirname(tree), engineTreesDir(root))) return false
    const jobId = path.basename(tree)
    if (!sameProjectPath(tree, engineTreePath(root, jobId))) return false
    if (lstatSync(tree).isSymbolicLink()) return false
    const runDir = engineRunPath(root, jobId)
    const file = path.join(runDir, 'owner.json')
    if (lstatSync(runDir).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) return false
    const owner: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false
    const record = owner as Partial<EngineRunOwner>
    if (record.version !== 1 || record.jobId !== jobId || !Number.isSafeInteger(record.ownerPid) || record.ownerPid! <= 0) return false
    if (typeof record.projectRoot !== 'string' || !path.isAbsolute(record.projectRoot) || !sameProjectPath(path.resolve(record.projectRoot), root)) return false
    if (typeof record.treePath !== 'string' || !path.isAbsolute(record.treePath) || !sameProjectPath(path.resolve(record.treePath), tree)) return false
    if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return false
    try {
      process.kill(record.ownerPid!, 0)
      return false
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH'
    }
  } catch {
    return false
  }
}
