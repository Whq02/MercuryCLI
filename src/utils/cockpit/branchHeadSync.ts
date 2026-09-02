// branchHeadSync — a SYNC current-branch read from .git/HEAD (a tiny file), for
// surfaces that need the branch on a first paint / mount effect without waiting
// for an async git probe. Mirrors MercuryFrame's local readBranchSync: detached
// HEAD and worktrees-where-.git-is-a-file don't match the ref pattern and return
// undefined — callers that need those refine via the async probe; the resume
// recap simply omits its branch clause. Pure node:fs — bun-loadable for proofs.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readBranchHeadSync(cwd: string): string | undefined {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m?.[1] || undefined
  } catch {
    return undefined
  }
}
