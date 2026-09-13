import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fixture, option, ROOT } from './viewportFixture.ts'

const proofs: Record<string, string> = {
  clamp: 'scripts/ink-runtime/prove-viewport-clamp.ts',
  console: 'scripts/ui/prove-viewport-follows-console.ts',
  route: 'scripts/ui/prove-viewport-route-repaint.ts',
}

export function runViewportProof(name: string): number {
  const entry = proofs[name]
  if (!entry) throw new Error(`Choose ${Object.keys(proofs).join(', ')}`)
  const scratch = process.argv.includes('--scratch') ? option('--scratch') : (process.env.TMPDIR ?? tmpdir())
  if (!scratch) throw new Error('Pass --scratch <absolute scratch directory>')
  const node = process.argv.includes('--node') ? option('--node') : Bun.which('node')
  if (!node) throw new Error('Node is required')
  const world = fixture(scratch)
  try {
    const output = join(world.root, 'proof.mjs')
    const built = spawnSync(process.execPath, [join(ROOT, 'scripts/search/lib/bundle-for-node.ts'), join(ROOT, entry), output], {
      cwd: ROOT, env: world.env, stdio: 'inherit',
    })
    console.log(`source fixture bundle exit: ${built.status}`)
    if (built.status !== 0) return built.status ?? 1
    const run = spawnSync(node, [output], { cwd: world.cwd, env: world.env, stdio: 'inherit' })
    console.log(`node ${name} proof exit: ${run.status}`)
    return run.status ?? 1
  } finally {
    world.dispose()
  }
}

if (typeof Bun !== 'undefined' && import.meta.main) process.exitCode = runViewportProof(process.argv[2] ?? '')
