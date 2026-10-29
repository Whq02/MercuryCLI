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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `project-intel-fixture-${kind}-`)))
  cpSync(src, dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'baseline')
  return dir
}
