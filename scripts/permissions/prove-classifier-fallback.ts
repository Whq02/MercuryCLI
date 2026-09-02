#!/usr/bin/env bun
// ============================================================================
//  prove-classifier-fallback — the auto-mode availability-fallback contract.
//
//  Operator repro: the classifier model
//  defaults to the MAIN-LOOP model, so a fable-5[1m] session whose model went
//  "temporarily unavailable" fail-closed EVERY mutating tool — auto mode was
//  hostage to the session model's availability. The fix routes an
//  unavailable-class failure through classifyYoloActionWithFallback's chain
//  (sonnet-5 → opus) before fail-closing.
//
//  yoloClassifier.ts is NOT bun-loadable (bundle-only feature() macro — the
//  classifierFailClosed.ts precedent), so this proof pins the contract
//  STRUCTURALLY: the wrapper exists with the exact retry conditions, the
//  chain is Haiku-free, both call sites route through the wrapper, and the
//  flag is registered + honest.
// ============================================================================
import { readFileSync } from 'node:fs'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const yolo = readFileSync('src/utils/permissions/yoloClassifier.ts', 'utf8')

console.log('— the wrapper + chain —')
t('classifyYoloActionWithFallback exported', yolo.includes('export async function classifyYoloActionWithFallback('))
t('fallback chain declared', /CLASSIFIER_FALLBACK_MODELS = \[\s*'claude-sonnet-5',\s*'claude-opus-5',\s*\] as const/.test(yolo))
t('chain is Haiku-free (the model rule)', !/haiku/i.test(yolo.slice(yolo.indexOf('CLASSIFIER_FALLBACK_MODELS'), yolo.indexOf('CLASSIFIER_FALLBACK_MODELS') + 400)))

console.log('— retry conditions (fail-closed contract intact) —')
const wrapper = yolo.slice(
  yolo.indexOf('export async function classifyYoloActionWithFallback'),
  yolo.indexOf('function getClassifierModel'),
)
t('no retry unless unavailable', wrapper.includes('if (!primary.unavailable || primary.transcriptTooLong || signal.aborted)'))
t('a fallback that is ALSO unavailable keeps falling through', wrapper.includes('if (!next.unavailable) return next'))
t('abort/too-long during fallback returns immediately', wrapper.includes('if (next.transcriptTooLong || signal.aborted) return next'))
t('exhausted chain returns the PRIMARY verdict (original fail-closed message)', /return primary\s*\}\s*$/m.test(wrapper))
// The base-model law lives in classifierRouted.ts (shared with the
// family-aware chain dedupe); yoloClassifier aliases it for the walk.
const routed = readFileSync('src/utils/permissions/classifierRouted.ts', 'utf8')
t('same-model skip ignores the [1m]-style tag', routed.includes("m.replace(/\\[[^\\]]*\\]\\s*$/, '')"))
t('yoloClassifier walks with the shared base-model law', yolo.includes('const baseModel = classifierBaseModel'))

console.log('— parse-failure same-model retry (the AVS friction class) —')
// A malformed classifier SAMPLE (no tool_use / schema-invalid) is sampling
// noise, not a policy verdict — it would otherwise fail-close benign reads with no
// second attempt. Both parse branches are tagged retryable; the wrapper
// re-asks the SAME model once; a second parse failure keeps fail-closed.
t('no_tool_use branch tagged retryable', /retryable: true,\s*\n\s*reason: 'The classifier answered without a tool-use block — blocking for safety\.'/.test(yolo))
t('invalid_schema branch tagged retryable', /retryable: true,\s*\n\s*reason: 'The classifier response did not parse — blocking for safety\.'/.test(yolo))
t('exactly the two parse branches are retryable (unavailable catch is NOT)', (yolo.match(/retryable: true/g) ?? []).length === 2)
t('wrapper gates the retry on retryable + not-aborted', wrapper.includes('if (primary.retryable && !signal.aborted)'))
t('wrapper re-asks the SAME model', /const retry = await classifyYoloAction\([^)]*primary\.model,\s*\)/s.test(wrapper))
t('a second parse failure keeps the fail-closed contract', wrapper.includes('if (retry.retryable) return retry'))
t('a healthy/unavailable retry replaces primary (ladder fallthrough)', wrapper.includes('primary = retry'))
t('parse retry sits BEHIND the flag gate (=0 restores immediate fail-close)', wrapper.indexOf('if (!classifierFallbackEnabled()) return primary') !== -1 && wrapper.indexOf('if (!classifierFallbackEnabled()) return primary') < wrapper.indexOf('primary.retryable'))
t('result type carries retryable', readFileSync('src/types/permissions.ts', 'utf8').includes('retryable?: boolean'))

console.log('— gate honesty —')
t('default-on gate', wrapper.includes('if (!classifierFallbackEnabled()) return primary') && yolo.includes("flagEnv('MERCURY_CLASSIFIER_FALLBACK') === '0'"))
const reg = readFileSync('src/substrate/flagRegistry.ts', 'utf8')
t('flag registered', reg.includes("env: 'MERCURY_CLASSIFIER_FALLBACK'"))

console.log('— call sites route through the wrapper —')
// The per-tool auto ask lives in the owned wrapper band since the Phase 3
// cutover (decision/wrapper.ts default classify port). The facade must carry
// no direct classifier call of its own.
const wrapperBand = readFileSync('src/utils/permissions/decision/wrapper.ts', 'utf8')
const perms = readFileSync('src/utils/permissions/permissions.ts', 'utf8')
t('decision/wrapper.ts (the per-tool auto ask)', wrapperBand.includes('classifyYoloActionWithFallback(') && !/classifyYoloAction\(/.test(wrapperBand))
t('permissions.ts facade carries no direct classifier call', !perms.includes('classifyYoloAction'))
// The OTHER historical call site (agentToolUtils' subagent handback review)
// was dead-folded upstream code — feature('TRANSCRIPT_CLASSIFIER') → false —
// and it was removed wholesale.
// This leg would otherwise demand the dead call site EXIST; the suite never ran this
// prover, so the lie sat green-looking. Pin
// the honest present: no classifier reference at all in agentToolUtils.
const agent = readFileSync('src/tools/AgentTool/agentToolUtils.ts', 'utf8')
t('agentToolUtils.ts carries NO classifier call (handback review removed)', !agent.includes('classifyYoloAction'))

console.log('— the model override plumbs to the API attempt —')
t('classifyYoloAction takes modelOverride', yolo.includes('modelOverride?: string,'))
t('override wins over getClassifierModel()', yolo.includes('const model = modelOverride ?? getClassifierModel()'))

console.log(failures ? '\n❌ CLASSIFIER-FALLBACK RED' : '\n✅ CLASSIFIER-FALLBACK GREEN')
process.exit(failures)
