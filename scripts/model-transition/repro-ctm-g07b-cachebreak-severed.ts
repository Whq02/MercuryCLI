#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-g07b-cachebreak-severed.ts —
//  expect-red driver:
//  the prompt-cache-break DETECTOR is a severed loop — the brief's owner
//  map recorded it "wired into claude/streamCore" but those are IMPORT
//  lines; nothing in src/ CALLS recordPromptState or
//  checkResponseForCacheBreak, and both are DCE'd out of the shipped
//  artifact. The severance shape: a removed sink takes the
//  detector's invocations
//  with it, leaving the module + imports orphaned.
//
//  Consequence for the: UN-10's "cache-write behaviour across
//  switch classes" has NO live substrate on ANY lane (not an extend-to-
//  GPT/GLM gap — a reconnect-first gap). The receipt/preview wiring must reconnect
//  the detector into a Mercury-native receipt before the cache-behaviour
//  baseline can be measured live.
//
//    §A the module is loadable and its API callable (severed, not broken)
//    §B DEFECT: zero call sites in src/ (imports only)
//    §C DEFECT: zero trace in the shipped dist (DCE followed the severance)
//
//  Exit 0 = defect REPRODUCED. Not part of the green gate.
// ============================================================================
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

// §A — loadable + callable (the severance is at the CALLERS, not the module).
const det = await import('../../src/services/api/promptCacheBreakDetection.ts')
check(
  '§A the detector module loads; both phases callable',
  typeof det.recordPromptState === 'function' && typeof det.checkResponseForCacheBreak === 'function',
)

// §B — zero call sites in src/: every non-definition mention is an import.
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

// §C — zero trace in the shipped artifact.
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
