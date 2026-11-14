import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

const world = gitFixture('git-hook-disclosure-')
const dist = process.env.MERCURY_PROOF_DIST ?? resolve(import.meta.dir, '../../dist/mercury.mjs')
const source = dirname(dirname(dist))
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
  check('the real APPLIED receipt states exactly which hooks are not run', applied.includes('APPLIED') && applied.includes(line), applied)
  check('pre-commit and commit-msg are in fact not run (existing behaviour)', !existsSync(join(world.root, '.git/pre-commit-seen')) && !existsSync(join(world.root, '.git/commit-msg-seen')))
  check('prepare-commit-msg still runs, so the wording does not claim all hooks are skipped', existsSync(join(world.root, '.git/prepare-commit-msg-seen')))
  check('the existing card body declares the same sentence', readFileSync(join(source, 'src/components/permissions/GitPermissionRequest/GitPermissionRequest.tsx'), 'utf8').includes(line))
  check('the permission message names the bypass beside creates local commits', readFileSync(join(source, 'src/tools/GitTool/GitTool.ts'), 'utf8').includes('(creates local commits; never pushes; pre-commit and commit-msg hooks are not run)'))
} finally { await client?.close(); world.dispose() }
console.log(`Git hook disclosure: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
