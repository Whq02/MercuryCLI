import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NATIVE_PACKS = new Set(['whisper', 'voice'])

type RefDist = { ref: string; sha: string; tree: string; dist: string; built: boolean; log: string }

function git(root: string, args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`)
  return r.stdout.trim()
}

function refDistRoot(): string {
  return join(tmpdir(), 'mercury-ref-dist')
}

function linkCaches(root: string, tree: string): void {
  if (!existsSync(join(tree, 'node_modules')) && existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'))
  const ignored = git(root, ['status', '--short', '--ignored', '--', 'vendor']).split('\n').filter(l => l.startsWith('!! vendor/')).map(l => l.slice('!! vendor/'.length).replace(/\/$/, ''))
  for (const name of ignored) {
    if (NATIVE_PACKS.has(name) || name.includes('/')) continue
    const target = join(tree, 'vendor', name)
    if (!existsSync(target)) symlinkSync(join(root, 'vendor', name), target)
  }
}

export function buildRefDist(root: string, ref: string, opts: { log?: (line: string) => void } = {}): RefDist {
  const sha = git(root, ['rev-parse', `${ref}^{commit}`])
  const home = join(refDistRoot(), sha.slice(0, 12))
  const tree = join(home, 'tree')
  const dist = join(tree, 'dist', 'mercury.mjs')
  const log = join(home, 'build.log')
  mkdirSync(home, { recursive: true })
  if (existsSync(dist) && existsSync(join(tree, 'dist', 'manifest.json'))) return { ref, sha, tree, dist, built: false, log }
  if (!existsSync(join(tree, '.git'))) {
    opts.log?.(`checking out ${ref} (${sha.slice(0, 12)}) into ${tree}`)
    git(root, ['worktree', 'add', '--detach', '--force', tree, sha])
  }
  linkCaches(root, tree)
  opts.log?.(`building ${sha.slice(0, 12)} with bun run build.ts`)
  const bun = process.env.BUN ?? process.execPath
  const scratch = mkdtempSync(join(home, 'build-'))
  const r = spawnSync(bun, ['run', 'build.ts'], { cwd: tree, encoding: 'utf8', env: { ...process.env, MERCURY_BUILD_OUTDIR: scratch }, maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(log, `${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  if (r.status !== 0 || !existsSync(join(scratch, 'mercury.mjs')) || !existsSync(join(scratch, 'manifest.json'))) throw new Error(`the build of ${ref} (${sha.slice(0, 12)}) failed (exit ${r.status}); its log is at ${log}`)
  const distDir = join(tree, 'dist')
  if (existsSync(distDir)) renameSync(distDir, join(home, `dist-stale-${Date.now()}`))
  renameSync(scratch, distDir)
  return { ref, sha, tree, dist, built: true, log }
}

export function distBuildTree(dist: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dist, '..', 'manifest.json'), 'utf8')) as { buildTree?: unknown }
    return typeof manifest.buildTree === 'string' ? manifest.buildTree : null
  } catch {
    return null
  }
}
