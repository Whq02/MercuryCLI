import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function hermeticGitEnv(scratch: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const config = join(scratch, 'git-config')
  writeFileSync(config, `[core]\n\texcludesFile = ${join(scratch, 'no-ignore-file')}\n`)
  return { ...env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }
}

export function rulesIgnore(rulesFile: string, paths: readonly string[]): boolean[] {
  const scratch = mkdtempSync(join(tmpdir(), 'rules-ignore-'))
  try {
    const env = hermeticGitEnv(scratch)
    const repo = join(scratch, 'rules-only')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', repo], { env })
    copyFileSync(rulesFile, join(repo, '.gitignore'))
    return paths.map(path => spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--no-index', '--', path], { env }).status === 0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
