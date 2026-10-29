#!/usr/bin/env bun
import { existsSync, mkdtempSync, statSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const REPO = join(import.meta.dir, '..', '..')
let fail = 0
const expect = (label: string, cond: boolean) => { if (!cond) fail++; console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`) }

if (!existsSync(join(REPO, 'dist', 'mercury.mjs'))) {
  console.log('  [SKIP] dist/mercury.mjs missing — run bun run build.ts'); process.exit(0)
}
const scratch = mkdtempSync(join(tmpdir(), 'prove-render-tui-'))
const out = join(scratch, 'prove-tui.png')
const res = spawnSync(process.env.BUN ?? process.execPath,
  ['run', join(REPO, 'scripts/ui/render-tui.ts'), '--scenario', 'resume-2turn', '--cols', '100', '--out', out, '--grid', join(scratch, 'grid.json')],
  { encoding: 'utf-8', timeout: 40000 })
expect('render-tui exits 0', res.status === 0)
if (res.status !== 0) console.log((res.stderr ?? '').slice(-600))
expect('PNG file written', existsSync(out))
if (existsSync(out)) {
  const meta = await sharp(out).metadata()
  expect('PNG width == 100 cols * 8px (800)', meta.width === 800)
  expect('PNG non-trivial size (> 2KB, not blank)', statSync(out).size > 2048)
}
rmSync(scratch, { recursive: true, force: true })
console.log(fail === 0 ? '\n✅ RENDER-TUI PIPELINE PASS' : `\n❌ ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
