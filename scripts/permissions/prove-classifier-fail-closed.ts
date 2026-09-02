#!/usr/bin/env bun

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Classifier fail-closed guard (Feature A) — behavior proof')
console.log('============================================================')

const { buildTool, isToolDefaultFn } = await import('../../src/Tool.js')
const fc = await import('../../src/utils/permissions/classifierFailClosed.js')

const defaultProjectorTool: any = buildTool({
  name: 'DefaultProjector',
  async call() { return { data: '' } },
} as any)
const optOutTool: any = buildTool({
  name: 'DeliberateOptOut',
  toAutoClassifierInput: () => '',
  async call() { return { data: '' } },
} as any)
const projectingTool: any = buildTool({
  name: 'RealProjection',
  toAutoClassifierInput: (i: any) => i?.cmd ?? '',
  async call() { return { data: '' } },
} as any)

const lookup = new Map<string, any>([
  [defaultProjectorTool.name, defaultProjectorTool],
  [optOutTool.name, optOutTool],
  [projectingTool.name, projectingTool],
])

const action = (name: string) => ({
  role: 'assistant' as const,
  content: [{ type: 'tool_use', name, input: {} }],
})

section('the mark: only the OMITTED default carries the buildTool marker')
{
  check('default-projector tool IS marked (isToolDefaultFn true)', isToolDefaultFn(defaultProjectorTool.toAutoClassifierInput) === true)
  check('explicit () => "" opt-out is NOT marked', isToolDefaultFn(optOutTool.toAutoClassifierInput) === false)
  check('real-projection override is NOT marked', isToolDefaultFn(projectingTool.toAutoClassifierInput) === false)
  check('the marked default still projects "" (byte-identical projection)', defaultProjectorTool.toAutoClassifierInput({}) === '')
}

section('OFF (no MERCURY_CLASSIFIER_FAIL_CLOSED) — byte-identical: NEVER blocks (silent allow)')
{
  delete process.env.MERCURY_CLASSIFIER_FAIL_CLOSED
  check('guard reports DISABLED', fc.classifierFailClosedEnabled() === false)
  check('OFF: default-projector empty action → verdict null (allowed, as today)', fc.emptyProjectionFailClosedVerdict(action('DefaultProjector'), lookup) === null)
  check('OFF: opt-out tool → verdict null (allowed)', fc.emptyProjectionFailClosedVerdict(action('DeliberateOptOut'), lookup) === null)
}

section('ON (MERCURY_CLASSIFIER_FAIL_CLOSED=1) — the guard FAIL-CLOSES the footgun tool')
{
  process.env.MERCURY_CLASSIFIER_FAIL_CLOSED = '1'
  check('guard reports ENABLED', fc.classifierFailClosedEnabled() === true)

  const v = fc.emptyProjectionFailClosedVerdict(action('DefaultProjector'), lookup)
  check('ON: default-projector empty action → BLOCKED (shouldBlock:true)', v != null && v.shouldBlock === true, JSON.stringify(v))
  check('ON: the block reason names the cause + the opt-out', !!v && /override the security projection/.test(v.reason) && /MERCURY_CLASSIFIER_FAIL_CLOSED/.test(v.reason))

  check('ON: deliberate opt-out tool → still allowed (verdict null)', fc.emptyProjectionFailClosedVerdict(action('DeliberateOptOut'), lookup) === null)

  check('ON: unknown-tool action → null (not caught)', fc.emptyProjectionFailClosedVerdict(action('NoSuchTool'), lookup) === null)
  check('ON: text-only action → null (not caught)', fc.emptyProjectionFailClosedVerdict({ role: 'user', content: [{ type: 'text' }] } as any, lookup) === null)
  check('ON: multi-block action → null (not a single tool_use)', fc.emptyProjectionFailClosedVerdict({ role: 'assistant', content: [{ type: 'tool_use', name: 'DefaultProjector' }, { type: 'tool_use', name: 'DefaultProjector' }] } as any, lookup) === null)

  delete process.env.MERCURY_CLASSIFIER_FAIL_CLOSED
}

section('regression: the INERT bug is gone — the guard keys on a MARKED default')
{
  process.env.MERCURY_CLASSIFIER_FAIL_CLOSED = '1'
  check('shouldFailClosedOnEmptyProjection(default) true (mark is load-bearing)', fc.shouldFailClosedOnEmptyProjection(defaultProjectorTool) === true)
  const unmarkedClone: any = { ...defaultProjectorTool, toAutoClassifierInput: () => '' }
  check('an UNMARKED projector is NOT caught (proves it is the mark, not the name)', fc.shouldFailClosedOnEmptyProjection(unmarkedClone) === false)
  delete process.env.MERCURY_CLASSIFIER_FAIL_CLOSED
}

section('dist: the wired guard ships in dist/mercury.mjs (string literals survive minify)')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to grep-verify the shipped guard')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('the fail-closed block reason ships', present('did not override the security projection'))
    check('the opt-in env flag ships', present('MERCURY_CLASSIFIER_FAIL_CLOSED'))
    check('the buildTool default marker ships', present('__mercuryToolDefault'))
  }
}

section('source: classifyYoloAction wires the verdict into the empty-projection branch')
{
  const yc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'permissions', 'yoloClassifier.ts'), 'utf-8')
  check('yoloClassifier imports the verdict', yc.includes("emptyProjectionFailClosedVerdict") && yc.includes("from './classifierFailClosed.js'"))
  check('the verdict is called in the actionCompact === "" branch', /actionCompact === ''[\s\S]*emptyProjectionFailClosedVerdict\(action, lookup\)/.test(yc))
  check('a non-null verdict short-circuits to the block return', yc.includes('if (failClosed)') && /return \{ \.\.\.failClosed, model: getClassifierModel\(\) \}/.test(yc))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CLASSIFIER FAIL-CLOSED PROOFS PASS')
else console.log(`❌ ${failures} CLASSIFIER FAIL-CLOSED PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
