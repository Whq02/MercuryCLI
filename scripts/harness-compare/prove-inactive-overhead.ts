// ============================================================================
//  scripts/harness-compare/prove-inactive-overhead.ts — the §14 inactive floor:
//  Glassbird adds ZERO product-runtime bytes. No src/ module references
//  glassbird machinery, no glassbird env flag joins the runtime registry, no
//  tool/store/scheduler exists — inactive overhead is structurally zero, not
//  merely small. (A §10 product repair lands at its EXISTING owner and never
//  under a glassbird name — this ratchet holds through repairs.)
// ============================================================================
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)

let failures = 0
function ok(name: string, pass: boolean, detail = ''): void {
  console.log((pass ? '  ok  ' : '  FAIL ') + name + (detail && !pass ? ' — ' + detail : ''))
  if (!pass) failures = 1
}

// git grep — no ambient-tool dependency (rg is not guaranteed on gate PATH).
function gitGrep(args: string[]): string {
  try {
    return execFileSync('git', ['grep', ...args], { cwd: repoRoot, encoding: 'utf8' })
  } catch (error) {
    const e = error as { status?: number }
    if (e.status === 1) return '' // no matches
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
