#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-render-canary.ts — ONE cheap real-binary render in the
//  DEFAULT gate. The full render tier is UI_RENDER=1
//  and had not run end-to-end for days — five proofs sat structurally red
//  (crashed tuple drives, era-stale needles) with the default gate none the
//  wiser: it had ZERO render coverage. This canary boots the built binary
//  once (frame @120, the cockpit home) through the render-tui CLI + oracle,
//  so "the app paints its home" is gate-enforced on every run (~8s).
//  prove-* naming ⇒ always-on by the ui suite's glob.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const CLI = join(import.meta.dir, 'render-tui.ts')
const BUN = process.env.BUN || join(process.env.HOME!, '.bun', 'bin', 'bun')

if (!existsSync(join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs'))) {
  console.log('⚠ canary SKIP — dist/mercury.mjs not built (run bun run build.ts)')
  process.exit(0) // absence of a build is the build suite's failure, not a paint failure
}

const res = spawnSync(BUN, ['run', CLI, '--scenario', 'frame', '--cols', '120', '--out', '/tmp/render-canary-120.png'], {
  encoding: 'utf-8',
  timeout: 90_000,
  env: { ...process.env },
})
const ok = res.status === 0
console.log(ok ? '✅ RENDER CANARY GREEN — the built binary paints the cockpit home @120 (oracle-passed)' : `❌ RENDER CANARY RED — ${res.stderr || res.stdout || `status ${res.status}`}`)
process.exit(ok ? 0 : 1)
