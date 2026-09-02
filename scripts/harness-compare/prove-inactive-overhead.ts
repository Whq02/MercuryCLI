import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)

let failures = 0
function ok(name: string, pass: boolean, detail = ''): void {
  console.log((pass ? '  ok  ' : '  FAIL ') + name + (detail && !pass ? ' — ' + detail : ''))
  if (!pass) failures = 1
}

function gitGrep(args: string[]): string {
  try {
    return execFileSync('git', ['grep', ...args], { cwd: repoRoot, encoding: 'utf8' })
  } catch (error) {
    const e = error as { status?: number }
    if (e.status === 1) return ''
    throw error
  }
}

{
  const hits = gitGrep(['-il', 'glassbird', '--', 'src/'])
  ok('no src/ module references glassbird', hits.trim() === '', hits.trim().slice(0, 200))
}
{
  const hits = gitGrep(['-i', 'HERMES_GLASSBIRD', '--', 'src/substrate/flagRegistry.ts'])
  ok('no glassbird flag in the runtime registry (overlay seam is scripts-side only)', hits.trim() === '')
}
{
  const hits = gitGrep(['-l', 'glassbird', '--', '*.ts', ':!scripts', ':!docs'])
  ok('glassbird code lives only under scripts/ + docs/', hits.trim() === '', hits.trim().slice(0, 200))
}

if (failures) {
  console.error('prove-inactive-overhead: RED')
  process.exit(1)
}
console.log('prove-inactive-overhead: green (inactive overhead is structurally zero)')
