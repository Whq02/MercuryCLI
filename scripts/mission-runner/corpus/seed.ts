// ============================================================================
//  scripts/mission-runner/corpus/seed.ts — deterministic corpus-repo seeder.
//
//  Seeds every corpus repo under a root (default CORPUS_SEED_ROOT): base tree
//  committed on 'main', one commit per task branch, FIXED identity/dates ⇒
//  stable SHAs on every machine. The stats
//  repo is the CONSUMED fixture — its own seeder owns it.
//
//  CLI: bun scripts/mission-runner/corpus/seed.ts [--root DIR] [--json]
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  APEX_FIXTURE_SHA,
  CORPUS_SEED_ROOT,
  type HelixRepoSpec,
} from './contracts.js'
import { NOTEDECK_REPO } from './repos/notedeck.js'
import { PYLEDGER_REPO } from './repos/pyledger.js'
import { RELAY_REPO } from './repos/relay.js'
import { TEXTKIT_REPO } from './repos/textkit.js'
import { GRIDGAME_REPO } from './repos/gridgame.js'
import { EMBERWEALD_REPO } from './repos/emberweald.js'
import { LANTERNKIT_REPO } from './repos/lanternkit.js'
import { GREYMARSH_REPO } from './repos/greymarsh.js'
import { WAYPOST_REPO } from './repos/waypost.js'

export const INLINE_REPOS: HelixRepoSpec[] = [
  NOTEDECK_REPO,
  PYLEDGER_REPO,
  RELAY_REPO,
  TEXTKIT_REPO,
  GRIDGAME_REPO,
  EMBERWEALD_REPO,
  LANTERNKIT_REPO,
  GREYMARSH_REPO,
  WAYPOST_REPO,
]

const FIXED_ENV = {
  GIT_AUTHOR_NAME: 'helix-corpus',
  GIT_AUTHOR_EMAIL: 'corpus@mercury.local',
  GIT_COMMITTER_NAME: 'helix-corpus',
  GIT_COMMITTER_EMAIL: 'corpus@mercury.local',
  GIT_AUTHOR_DATE: '2026-07-21T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-07-21T00:00:00Z',
  // Never read the operator's git config (the F6 ambient-state law).
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  HOME: '/tmp',
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, ...FIXED_ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function writeTree(dir: string, files: Record<string, string | null>): void {
  for (const path of Object.keys(files).sort()) {
    const content = files[path]
    const target = join(dir, path)
    if (content === null) {
      rmSync(target, { force: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
}

export interface SeededRepo {
  id: string
  dir: string
  /** branch (or 'main') → commit sha. */
  refs: Record<string, string>
}

export function seedInlineRepo(spec: HelixRepoSpec, root: string): SeededRepo {
  const dir = join(root, spec.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeTree(dir, spec.files ?? {})
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'corpus: ' + spec.id + ' base'])
  const refs: Record<string, string> = { main: git(dir, ['rev-parse', 'HEAD']) }
  for (const branch of Object.keys(spec.branches ?? {}).sort()) {
    git(dir, ['checkout', '-q', '-b', branch, 'main'])
    writeTree(dir, (spec.branches ?? {})[branch] ?? {})
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'task-state: ' + branch])
    refs[branch] = git(dir, ['rev-parse', 'HEAD'])
  }
  git(dir, ['checkout', '-q', 'main'])
  return { id: spec.id, dir, refs }
}

/** The consumed fixture: self-heal via ITS seeder, verify the pin. */
export function seedStatsRepo(mercuryRepoRoot: string): SeededRepo {
  const dir = '/tmp/apex-bench-fixture'
  let current = ''
  try {
    current = git(dir, ['rev-parse', 'HEAD'])
  } catch {
    current = ''
  }
  if (current !== APEX_FIXTURE_SHA) {
    execFileSync('bash', [join(mercuryRepoRoot, 'scripts/model-routing/live/seed-bench-fixture.sh')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    current = git(dir, ['rev-parse', 'HEAD'])
  }
  if (current !== APEX_FIXTURE_SHA) {
    throw new Error('stats fixture SHA drifted: ' + current + ' != ' + APEX_FIXTURE_SHA)
  }
  return { id: 'stats', dir, refs: { main: APEX_FIXTURE_SHA } }
}

export function seedAll(root: string, mercuryRepoRoot: string): SeededRepo[] {
  mkdirSync(root, { recursive: true })
  const seeded = [seedStatsRepo(mercuryRepoRoot)]
  for (const spec of INLINE_REPOS) seeded.push(seedInlineRepo(spec, root))
  return seeded
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2)
  const rootAt = args.indexOf('--root')
  const root = rootAt >= 0 ? resolve(args[rootAt + 1]) : CORPUS_SEED_ROOT
  const repoRoot = resolve(new URL('../../..', import.meta.url).pathname)
  const seeded = seedAll(root, repoRoot)
  if (args.includes('--json')) {
    console.log(JSON.stringify(seeded, null, 2))
  } else {
    for (const repo of seeded) {
      for (const [ref, sha] of Object.entries(repo.refs).sort()) {
        console.log(repo.id + ' ' + ref + ' ' + sha)
      }
    }
  }
}
