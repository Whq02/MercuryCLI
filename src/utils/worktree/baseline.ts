import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { logForDebugging } from '../debug.js'

const BASELINE_FILENAME = 'WORKTREE_BASE'

export async function resolveWorktreeAdminDir(worktreePath: string): Promise<string | null> {
  try {
    const content = (await readFile(join(worktreePath, '.git'), 'utf8')).trim()
    if (!content.startsWith('gitdir:')) return null
    return resolve(worktreePath, content.slice('gitdir:'.length).trim())
  } catch {
    return null
  }
}

export async function writeWorktreeBaseline(worktreePath: string, sha: string): Promise<void> {
  const adminDir = await resolveWorktreeAdminDir(worktreePath)
  if (adminDir === null) {
    logForDebugging(`worktree baseline not written: no admin dir for ${worktreePath}`)
    return
  }
  try {
    await writeFile(join(adminDir, BASELINE_FILENAME), sha)
  } catch (error) {
    logForDebugging(`worktree baseline write failed: ${String(error)}`)
  }
}

export async function readWorktreeBaseline(worktreePath: string): Promise<string | null> {
  const adminDir = await resolveWorktreeAdminDir(worktreePath)
  if (adminDir === null) return null
  let content: string
  try {
    content = await readFile(join(adminDir, BASELINE_FILENAME), 'utf8')
  } catch {
    return null
  }
  const trimmed = content.trim()
  return /^[0-9a-fA-F]{7,64}$/.test(trimmed) ? trimmed : null
}
