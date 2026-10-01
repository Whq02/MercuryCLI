import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export function applyProjectRoot(argv: string[]): boolean {
  const option = argv[2]
  if (option !== '--project' && !option?.startsWith('--project=')) return false
  const value = option === '--project' ? argv[3] : option.slice('--project='.length)
  if (!value || value.startsWith('--')) throw new Error('--project needs a directory before other arguments')
  const target = realpathSync(resolve(value))
  if (!statSync(target).isDirectory()) throw new Error('--project must name a directory')
  process.chdir(target)
  argv.splice(2, option === '--project' ? 2 : 1)
  return true
}
