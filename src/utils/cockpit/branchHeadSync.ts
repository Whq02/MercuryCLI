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
