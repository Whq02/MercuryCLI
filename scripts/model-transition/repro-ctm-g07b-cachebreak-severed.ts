#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const det = await import('../../src/services/api/promptCacheBreakDetection.ts')
check(
  '§A the detector module loads; both phases callable',
  typeof det.recordPromptState === 'function' && typeof det.checkResponseForCacheBreak === 'function',
)

const grep = (needle: string): string[] =>
  execFileSync('git', ['grep', '-n', needle, '--', 'src/'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
for (const fn of ['recordPromptState', 'checkResponseForCacheBreak']) {
  const hits = grep(fn)
  const callSites = hits.filter(
    h => !h.includes('promptCacheBreakDetection.ts') && /\w\s*\(/.test(h.split(':').slice(2).join(':')) && h.includes(`${fn}(`),
  )
  check(`§B REPRODUCED: zero ${fn}() call sites in src/`, callSites.length === 0, callSites.join(' · ') || `${hits.length} mention(s), imports/defs only`)
}

const dist = join(ROOT, 'dist', 'mercury.mjs')
if (existsSync(dist)) {
  const bundle = readFileSync(dist, 'utf8')
  check('§C REPRODUCED: recordPromptState absent from dist', !bundle.includes('recordPromptState'))
  check('§C REPRODUCED: checkResponseForCacheBreak absent from dist', !bundle.includes('checkResponseForCacheBreak'))
} else {
  console.log('  [SKIP] §C dist/mercury.mjs not built in this checkout')
}

console.log(
  failed === 0
    ? '\n REPRODUCED — G07b red recorded (cache-break detector severed on every lane)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
