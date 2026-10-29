#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const CLI = join(import.meta.dir, 'render-tui.ts')
const BUN = process.env.BUN || join(process.env.HOME!, '.bun', 'bin', 'bun')

if (!existsSync(join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs'))) {
  console.log('⚠ canary SKIP — dist/mercury.mjs not built (run bun run build.ts)')
  process.exit(0)
}

const res = spawnSync(BUN, ['run', CLI, '--scenario', 'frame', '--cols', '120', '--out', '/tmp/render-canary-120.png'], {
  encoding: 'utf-8',
  timeout: 90_000,
  env: { ...process.env },
})
const ok = res.status === 0
console.log(ok ? '✅ RENDER CANARY GREEN — the built binary paints the cockpit home @120 (oracle-passed)' : `❌ RENDER CANARY RED — ${res.stderr || res.stdout || `status ${res.status}`}`)
process.exit(ok ? 0 : 1)
