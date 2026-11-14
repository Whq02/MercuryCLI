#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mock } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneRoadExpected } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = fs.realpathSync(join(import.meta.dir, '..', '..'))
const mode = process.argv[2]
if (mode !== undefined) {
  const repo = process.argv[3] as string
  process.env.MERCURY_CONFIG_DIR = mode.startsWith('inside') ? join(repo, 'node_modules', 'private-home') : mode === 'beside' ? join(repo, 'local-home') : join(dirname(repo), 'outside-home')
  if (mode.endsWith('-files')) process.env.MERCURY_WORKTREE_CLONE = 'files'
  else delete process.env.MERCURY_WORKTREE_CLONE
  if (mode.startsWith('alias')) {
    fs.mkdirSync(join(repo, 'node_modules', 'private-home'), { recursive: true })
    process.env.MERCURY_CONFIG_DIR = join(dirname(repo), `${mode}-home`)
    fs.symlinkSync(join(repo, 'node_modules', 'private-home'), process.env.MERCURY_CONFIG_DIR, 'dir')
  }
  fs.mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(join(process.env.MERCURY_CONFIG_DIR, '.credentials.json'), '{"proof":"keep out"}')
  let observing = false
  let secretCopies = 0
  const calls: Record<string, number> = {}
  const instrument = (entries: Record<string, unknown>, prefix: string): Record<string, unknown> => Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, typeof value !== 'function' ? value : (...args: unknown[]) => {
    if (observing) {
      calls[prefix + name] = (calls[prefix + name] ?? 0) + 1
      if (name === 'copyFile' && String(args[0]).endsWith('/.credentials.json')) secretCopies++
    }
    return (value as (...input: unknown[]) => unknown)(...args)
  }]))
  mock.module('node:fs/promises', () => instrument(promises, 'async.'))
  const state = await import('../../src/bootstrap/state.ts')
  const config = await import('../../src/utils/config/globalConfig.ts')
  const { createAgentWorktree } = await import('../../src/utils/worktree.ts')
  const { mercurySecretPath } = await import('../../src/utils/permissions/protectedPaths.ts')
  process.chdir(repo)
  state.setOriginalCwd(repo); state.setCwdState(repo); state.setIsInteractive(true); config.enableConfigs()
  observing = true
  const copy = (await createAgentWorktree('agent-a123abcd')).worktreePath
  observing = false
  const secret = join(copy, 'node_modules', 'private-home', '.credentials.json')
  let secretKind = 'absent'
  try { secretKind = fs.lstatSync(secret).isSymbolicLink() ? 'link' : 'file' } catch {}
  console.log('RESULT ' + JSON.stringify({ mode, secretKind, refused: mercurySecretPath(secret) !== null, normal: fs.readFileSync(join(copy, 'node_modules', 'z-public', 'file'), 'utf8'), ownFolder: fs.lstatSync(join(copy, 'node_modules')).isDirectory(), secretCopies, calls }))
  process.exit(0)
}
const scratch = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'worktree-dependency-home-')))
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ' — ' + detail : ''}`); if (!ok) failures++ }
try {
  if (!cloneRoadExpected(scratch)) console.log('  [SKIP] this volume or platform cannot clone: dependency links already keep the secret at its own path')
  else for (const scenario of ['inside', 'inside-files', 'alias', 'alias-files', 'beside', 'outside']) {
    const repo = join(scratch, scenario)
    fs.mkdirSync(join(repo, 'node_modules', 'z-public'), { recursive: true })
    fs.writeFileSync(join(repo, 'node_modules', 'z-public', 'file'), 'public')
    fs.writeFileSync(join(repo, '.gitignore'), 'node_modules/\nlocal-home/\n.mercury/\n')
    const env = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' }) }
    git('init', '-q', '-b', 'main'); git('add', '.gitignore'); git('commit', '-qm', 'fixture')
    const child = spawnSync(process.execPath, [import.meta.path, scenario, repo], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 })
    const line = child.stdout.split('\n').find(row => row.startsWith('RESULT '))
    check(`${scenario}: the copy is made`, child.status === 0 && line !== undefined, child.stderr)
    if (line === undefined) continue
    const result = JSON.parse(line.slice(7)) as { secretKind: string; refused: boolean; normal: string; ownFolder: boolean; secretCopies: number; calls: Record<string, number> }
    console.log('  ' + line)
    check(`${scenario}: ordinary dependency files remain the copy's own`, result.ownFolder && result.normal === 'public')
    if (scenario.startsWith('inside') || scenario.startsWith('alias')) {
      check(`${scenario}: the own secret is a link and the floor still recognizes it`, result.secretKind === 'link' && result.refused, line)
      check(`${scenario}: even the reflink probe never copies the own secret`, result.secretCopies === 0, line)
    } else check(`${scenario}: no secret appears in the dependency copy`, result.secretKind === 'absent', line)
  }
} finally { process.chdir(ROOT); fs.rmSync(scratch, { recursive: true, force: true }) }
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
