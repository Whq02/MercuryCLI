#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-model-defaults.ts
//  PROOF for the model & effort selection fix-set (model.ts / effort.ts):
//
//   [bug/med]  model.ts + effort.ts reference resolveAntModel /
//                   getAntModelOverrideConfig — the imports must be present
//                   (they are DCE'd out of the stamped build, but src/ won't
//                   compile without them).
//   [bug/high] Mercury must default to Opus regardless of
//                   subscriber tier ('everything Opus'). A clean clone on a
//                   non-Max account booting Sonnet is the guarded class. Bare-stamp
//                   stays the base default (Sonnet) — byte-identical parity.
//   [friction] The stale '// sonnetplan by default' comment (sonnetplan
//                   is not a real alias) is replaced with an accurate one.
//
//  model.ts is loadable under `bun run`, so default resolution is
//  exercised LIVE (stamp-on vs fork-off via the globalThis.MACRO sim).
//  are source-grepped (the ant branches are USER_TYPE-gated, so a missing
//  import only throws on the ant path — the import line is the deterministic
//  signal).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-model-defaults.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Let the live default-resolution path read config/auth without a real session.
// These functions only BRANCH on the key/subscription; they make no network call.
process.env.NODE_ENV = 'test'
if (
  !process.env.ANTHROPIC_API_KEY &&
  !process.env.MERCURY_OAUTH_TOKEN &&
  !process.env.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR
) {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-proof-dummy'
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
const src = (...p: string[]) =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Model & effort defaults — proof')
console.log('============================================================')

const modelSrc = src('utils', 'model', 'model.ts')
const effortSrc = src('utils', 'effort.ts')

section('the broken-src ant-symbol imports are present')
// The ant-only call sites (all inside
// `USER_TYPE === 'ant'` branches) folded at source — matching what every dist
// build already shipped. The residual invariant is that the repaired
// imports still RESOLVE (source not broken) and that no runtime USER_TYPE
// read crept back in. Phase-8 orphan cleanup may drop the unused imports;
// re-anchor the import checks again then.
check(
  "model.ts: ant-gated call sites are folded (no runtime USER_TYPE read)",
  !modelSrc.includes("process.env.USER_TYPE"),
)
check(
  "model.ts imports them from './antModels.js'",
  /import\s*\{[^}]*\b(resolveAntModel|getAntModelOverrideConfig)\b[^}]*\}\s*from\s*'\.\/antModels\.js'/s.test(
    modelSrc,
  ),
)
check(
  "effort.ts: ant-gated call sites are folded (no runtime USER_TYPE read)",
  !effortSrc.includes("process.env.USER_TYPE"),
)
check(
  "effort.ts imports them from './model/antModels.js'",
  /import\s*\{[^}]*\b(resolveAntModel|getAntModelOverrideConfig)\b[^}]*\}\s*from\s*'\.\/model\/antModels\.js'/s.test(
    effortSrc,
  ),
)

section('the stamped default is Opus (live); the bare default stays Sonnet')
const model = (await import('../../src/utils/model/model.js')) as typeof import('../../src/utils/model/model.js')

setStamp(true)
const stampedDefault = model.getDefaultMainLoopModelSetting()
const opusBase = model.getDefaultOpusModel()
check(
  'default-ON default is an Opus model (not Sonnet)',
  stampedDefault.includes(opusBase) && !stampedDefault.toLowerCase().includes('sonnet'),
  stampedDefault,
)
check(
  'default-ON default matches getDefaultOpusModel() + the [1m] gate',
  // A natively-1M default Opus (Opus 5) carries no [1m]-merge suffix.
  stampedDefault ===
    opusBase +
      (model.isOpus1mMergeEnabled() && !model.isDefaultOpusNatively1M()
        ? '[1m]'
        : ''),
  stampedDefault,
)

// the bare-stamp Sonnet arm went with the version
// seam — the Opus default is stamp-independent (a mis-stamped build can no
// longer silently downgrade the main-loop model).
setStamp(false)
const bareStampDefault = model.getDefaultMainLoopModelSetting()
check(
  'bare stamp ⇒ SAME Opus default (stamp-independence)',
  bareStampDefault === stampedDefault,
  `${stampedDefault} vs ${bareStampDefault}`,
)
setStamp(false)

section('the haiku→Sonnet plan-mode branch')
check(
  "the haiku→Sonnet plan-mode branch itself is kept",
  /getUserSpecifiedModelSetting\(\) === 'haiku' && permissionMode === 'strategy'/.test(modelSrc),
)

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL MODEL-DEFAULTS PROOFS PASS')
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
}
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
