#!/usr/bin/env bun
// Proof: the render pipeline produces a valid, correctly-sized, non-blank PNG.
// Joins scripts/ui/run-all.sh (globs prove-*.ts). Boots the binary, so guard on dist/.
import { existsSync, statSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import sharp from 'sharp'

const REPO = join(import.meta.dir, '..', '..')
let fail = 0
const expect = (label: string, cond: boolean) => { if (!cond) fail++; console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`) }

if (!existsSync(join(REPO, 'dist', 'mercury.mjs'))) {
  console.log('  [SKIP] dist/mercury.mjs missing — run bun run build.ts'); process.exit(0)
}
const out = '/tmp/prove-tui.png'
rmSync(out, { force: true }) // never assert against a stale PNG from a prior run
const res = spawnSync(process.env.HOME + '/.bun/bin/bun',
  ['run', join(REPO, 'scripts/ui/render-tui.ts'), '--scenario', 'resume-2turn', '--cols', '100', '--out', out],
  { encoding: 'utf-8', timeout: 40000 })
expect('render-tui exits 0', res.status === 0)
expect('PNG file written', existsSync(out))
if (existsSync(out)) {
  const meta = await sharp(out).metadata()
  expect('PNG width == 100 cols * 8px (800)', meta.width === 800)
  expect('PNG non-trivial size (> 2KB, not blank)', statSync(out).size > 2048)
}
console.log(fail === 0 ? '\n✅ RENDER-TUI PIPELINE PASS' : `\n❌ ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
