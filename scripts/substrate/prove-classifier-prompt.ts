#!/usr/bin/env bun
// ============================================================================
//  prove-classifier-prompt — the auto-mode classifier's prompt assets exist,
//  satisfy every structural contract their consumers assume, ship in the
//  BUILT bundle, and the empty-prompt class is guarded fail-closed.
//
//  ROOT CAUSE PINNED: the stamped build
//  folds feature('TRANSCRIPT_CLASSIFIER') to false, which DCE'd the prompt
//  requires and shipped BASE_PROMPT='' — every classifier call then sent an
//  empty cache_control system block, the API 400'd ("system.1: cache_control
//  cannot be set for empty text blocks"), and the fail-closed catch denied
//  EVERY auto-mode ask (invisible interactively — it just prompted; a hard
//  deny headlessly — the party lane's blocked bash). The classifier had never
//  actually run in the fork. These pins make that class unshippable again.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(import.meta.dir, '..', '..')
const promptsDir = join(root, 'src/utils/permissions/auto-mode-classifier-prompts')

console.log('============================================================')
console.log(' auto-mode classifier prompt assets — structure + bundling')
console.log('============================================================')

section('§1 the prompt files exist and are substantive')
const basePath = join(promptsDir, 'auto_mode_system_prompt.txt')
const extPath = join(promptsDir, 'permissions_external.txt')
check('auto_mode_system_prompt.txt exists', existsSync(basePath))
check('permissions_external.txt exists', existsSync(extPath))
const base = existsSync(basePath) ? readFileSync(basePath, 'utf-8') : ''
const ext = existsSync(extPath) ? readFileSync(extPath, 'utf-8') : ''
check('base prompt is substantive (>1000 chars)', base.length > 1000, `${base.length} chars`)
check('external template is substantive (>1000 chars)', ext.length > 1000, `${ext.length} chars`)

section('§2 base prompt structural contracts (buildYoloSystemPrompt + XML path)')
check(
  'contains the <permissions_template> placeholder exactly once',
  base.split('<permissions_template>').length === 2,
)
const TOOL_USE_LINE = 'Use the classify_result tool to report your classification.'
check(
  'contains the exact classify_result tool line exactly once (the XML path String.replace target)',
  base.split(TOOL_USE_LINE).length === 2,
)
check(
  'names a classification process (the stage-2 suffix tells the model to "review the classification process")',
  /classification process/i.test(base),
)
check(
  'establishes the explicit-confirmation override doctrine (the stage-2 suffix references it)',
  /explicit/i.test(base) && /confirm/i.test(base),
)
check('errs toward blocking when in doubt', /block/i.test(base) && /doubt|unsure|uncertain/i.test(base))

section('§3 external template contracts (tag replacement + auto-mode defaults)')
for (const tag of ['user_allow_rules_to_replace', 'user_deny_rules_to_replace', 'user_environment_to_replace']) {
  const open = `<${tag}>`
  const close = `</${tag}>`
  check(`has one ${open}…${close} section`, ext.split(open).length === 2 && ext.split(close).length === 2)
  const inner = ext.split(open)[1]?.split(close)[0] ?? ''
  const bullets = inner.split('\n').filter(l => l.trim().startsWith('- '))
  check(`  …with parseable '- ' bullet defaults (${tag})`, bullets.length >= 3, `${bullets.length} bullets`)
}
check(
  'deny defaults cover the outward/destructive core (push · sudo · credentials · rm -rf)',
  /git push/.test(ext) && /sudo/.test(ext) && /credential/i.test(ext) && /rm -rf/.test(ext),
)
check(
  'allow defaults cover the read-only + workspace core (git status · searching · tests)',
  /git status/.test(ext) && /rg\)?/.test(ext) && /test/i.test(ext),
)

section('§4 source gates: stamped build must BUNDLE the prompts + fail closed if ever empty')
const src = readFileSync(join(root, 'src/utils/permissions/yoloClassifier.ts'), 'utf-8')
check(
  'BASE_PROMPT require is unconditional',
  /BASE_PROMPT: string =\s*\n?\s*txtRequire\(require\('\.\/auto-mode-classifier-prompts\/auto_mode_system_prompt\.txt'\)\)/.test(src),
)
check(
  'EXTERNAL_PERMISSIONS_TEMPLATE require reachable on the fork',
  /EXTERNAL_PERMISSIONS_TEMPLATE: string =\s*\n?\s*txtRequire\(require\('\.\/auto-mode-classifier-prompts\/permissions_external\.txt'\)\)/.test(src),
)
// Current truth (every feature()/USER_TYPE read folded at source;
// this check's old feature()-gate regex was UNSATISFIABLE from
// START — the D-4 orphan-prover find): the template is an EMPTY constant,
// the file was never extracted into this tree, and the external branch is
// unconditionally taken.
check(
  'ANTHROPIC template is the empty constant (file not in this tree; external branch unconditional)',
  /ANTHROPIC_PERMISSIONS_TEMPLATE: string =\s*\n?\s*''/.test(src) &&
    /function isUsingExternalPermissions\(\): boolean \{\s*\n?\s*return true/.test(src) &&
    !existsSync(join(promptsDir, 'permissions_anthropic.txt')),
)
check(
  'classifyYoloAction guards an empty system prompt FAIL-CLOSED before any API call',
  /if \(!systemPrompt\.trim\(\)\)[\s\S]{0,700}shouldBlock: true[\s\S]{0,300}unavailable: true/.test(src),
)

section('§5 the BUILT bundle ships the prompts (the product truth)')
const distPath = join(root, 'dist/mercury.mjs')
if (!existsSync(distPath)) {
  check('dist/mercury.mjs exists', false, 'run bun run build.ts first')
} else {
  const dist = readFileSync(distPath, 'utf-8')
  check(
    'dist carries the base prompt (classify_result tool line present)',
    dist.includes(TOOL_USE_LINE),
  )
  check(
    'dist carries the external template (allow-rules tag present)',
    dist.includes('<user_allow_rules_to_replace>'),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} CLASSIFIER-PROMPT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL CLASSIFIER-PROMPT PROOFS PASS')
