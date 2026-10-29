#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = resolve(import.meta.dir, '..', '..')
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' }).trim()

function planWithGhShim(shimBody: string): { status: number | null; out: string } {
  const bin = mkdtempSync(join(tmpdir(), 'vf-gh-shim-'))
  writeFileSync(join(bin, 'gh'), shimBody)
  chmodSync(join(bin, 'gh'), 0o755)
  const r = spawnSync(process.execPath, ['run', join(ROOT, 'scripts/verify/fast.ts'), '--plan'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

console.log('============================================================')
console.log(' verify:fast — green-baseline sources (local + CI)')
console.log('============================================================')

{
  const a = planWithGhShim(`#!/bin/sh\necho '[{"headSha":"${headSha}"}]'\n`)
  check('A: plan exits 0 with a CI-green HEAD', a.status === 0, `status=${a.status}`)
  check(
    "A: the baseline is HEAD's own tree (nearest green wins — the changed-set is dirt-only)",
    a.out.includes(`base: last full-green tree`) && a.out.includes(headTree.slice(0, 12)),
    a.out.split('\n').find(l => l.includes('base:')) ?? '(no base line)',
  )
}

{
  const b = planWithGhShim('#!/bin/sh\nexit 1\n')
  check('B: gh failure is fail-soft — plan still exits 0', b.status === 0, `status=${b.status}`)
  check('B: a base line still prints (local verdict or loud HEAD fallback)',
    b.out.includes('base: '), b.out.split('\n').find(l => l.includes('base')) ?? '(none)')
}

{
  const c = planWithGhShim(`#!/bin/sh\necho '[{"headSha":"ffffffffffffffffffffffffffffffffffffffff"}]'\n`)
  check('C: an unknown sha is skipped, plan exits 0', c.status === 0, `status=${c.status}`)
  check('C: the unknown sha never becomes the named baseline', !c.out.includes('ffffffffffff'))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
