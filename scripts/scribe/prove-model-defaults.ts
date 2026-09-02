#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  stampedDefault ===
    opusBase +
      (model.isOpus1mMergeEnabled() && !model.isDefaultOpusNatively1M()
        ? '[1m]'
        : ''),
  stampedDefault,
)

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
