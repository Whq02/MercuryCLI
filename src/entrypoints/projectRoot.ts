import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export function applyProjectRoot(argv: string[]): boolean {
  const option = argv[2]
  if (option !== '--project-root' && !option?.startsWith('--project-root=')) return false
  const value = option === '--project-root' ? argv[3] : option.slice('--project-root='.length)
  if (!value || value.startsWith('--')) throw new Error('--project-root needs a directory before other arguments')
  const target = realpathSync(resolve(value))
  if (!statSync(target).isDirectory()) throw new Error('--project-root must name a directory')
  process.chdir(target)
  argv.splice(2, option === '--project-root' ? 2 : 1)
  return true
}
