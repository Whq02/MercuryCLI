import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

const world = gitFixture('git-hook-disclosure-')
const line = 'Repository pre-commit and commit-msg hooks are not run for these commits.'
let client: Awaited<ReturnType<typeof gitClient>> | undefined
let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
try {
  world.put('file.txt', 'before\n')
  world.git(['add', '--', 'file.txt']); world.git(['commit', '--quiet', '-m', 'seed'])
  world.put('file.txt', 'after\n')
  for (const hook of ['pre-commit', 'commit-msg', 'prepare-commit-msg']) {
    const file = join(world.root, '.git/hooks', hook)
    writeFileSync(file, `#!/bin/sh\nprintf seen > .git/${hook}-seen\n`)
    chmodSync(file, 0o755)
  }
  client = await gitClient(world)
  const plan = await client.call('Git', { op: 'plan', groups: [{ files: ['file.txt'], message: 'commit through the plan' }] })
  const id = plan.match(/gp-[a-f0-9]+/)?.[0]
  const applied = await client.call('Git', { op: 'apply', planId: id })
  check('the real APPLIED receipt states exactly which hooks are not run', applied.includes('APPLIED') && applied.includes(line), `${applied} — applyOp in src/tools/git/GitTool.ts must print the hook line exactly as this test spells it`)
  check('pre-commit and commit-msg are in fact not run (existing behaviour)', !existsSync(join(world.root, '.git/pre-commit-seen')) && !existsSync(join(world.root, '.git/commit-msg-seen')), 'applyPlan in src/platform/git-graph/plan.ts commits with --no-verify; a hook ran, so that flag was lost')
  check('prepare-commit-msg still runs, so the wording does not claim all hooks are skipped', existsSync(join(world.root, '.git/prepare-commit-msg-seen')), 'prepare-commit-msg should still run under --no-verify in applyPlan (src/platform/git-graph/plan.ts); if it is now skipped too, widen the hook line in applyOp (src/tools/git/GitTool.ts) to say so')
} finally { await client?.close(); world.dispose() }
console.log(`Git hook disclosure: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
