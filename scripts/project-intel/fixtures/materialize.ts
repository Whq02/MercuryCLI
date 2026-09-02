// ============================================================================
//  scripts/project-intel/fixtures/materialize.ts — the fixture materializer
//  the project-intelligence provers stand on. Copies a committed fixture tree
//  (ts-app / py-app, beside this file) into a temp dir OUTSIDE the repo — the
//  ambient-state law: no prover observes repo state through a fixture — and
//  git-inits it with a baseline commit so the working-tree digests, change
//  stats and recent-path legs see a real history. The caller owns teardown.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURES = import.meta.dir

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.email=fixture@project-intel.local',
      '-c',
      'user.name=project-intel-fixture',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString()
}

export function materializeFixture(kind: 'ts' | 'py'): string {
  const src = join(FIXTURES, kind === 'ts' ? 'ts-app' : 'py-app')
  // realpath: macOS tmpdir is a /var→/private/var symlink; the child
  // realpaths its cwd, so an unresolved dir makes every tool input arrive
  // under the OTHER spelling and target normalization dual-keys.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `project-intel-fixture-${kind}-`)))
  cpSync(src, dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'baseline')
  return dir
}
